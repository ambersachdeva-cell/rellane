import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  decodeOwnedTransactionalPersistenceMediumImage,
  disposeTransactionalPersistenceMediumImageForTestOnly,
  encodeTransactionalPersistenceMediumImage,
} from "./transactional-persistence-image-codec.js";
import {
  type WholeMediumAeadFilesystemWireCodecForTestOnly,
  type WholeMediumAeadProtectionMarkerForTestOnly,
} from "./transactional-persistence-whole-medium-aead-codec.js";
import { validateTransactionalPersistenceSuccessorForTestOnly, type TransactionalPersistenceMediumImage } from "./transactional-persistence.js";

/**
 * Private test-only boundary. Its caller must provide an already app-owned,
 * non-attacker-writable root and ancestors. Node lacks openat-style ancestry
 * pinning, so this code validates and pins the root leaf but makes no claim
 * against hostile ancestors, same-UID replacement, power loss, or multiprocess
 * writers which bypass the fixed-generation hardlink CAS protocol.
 */
export class TransactionalPersistenceFilesystemError extends Error {
  readonly code = "TRANSACTIONAL_PERSISTENCE_FILESYSTEM_FAILED" as const;
  constructor() { super("Transactional persistence filesystem operation failed."); this.name = "TransactionalPersistenceFilesystemError"; }
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_GENERATION = 256;
const MAX_GENERATIONS = MAX_GENERATION + 1;
const MAX_STAGES = 8;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const GENERATION_WIDTH = 20;
const STAGE_PREFIX = ".transactional-persistence-stage-";

interface Identity { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly mode: number; readonly nlink: bigint; readonly size: bigint; readonly type: "directory" | "file" | "other"; }
export interface TrustedAppOwnedGenerationRootForTestOnly { readonly path: string; readonly handle: Awaited<ReturnType<typeof open>>; readonly identity: Identity; readonly rootBindingSha256: string; }
export interface PublishedTransactionalPersistenceGeneration { readonly generation: number; readonly imageSha256: string; }
export type TransactionalPersistenceFilesystemProtectionMarkerForTestOnly = Readonly<{ readonly kind: "plaintext-test-only" }> | WholeMediumAeadProtectionMarkerForTestOnly;

/** Opens a caller-supplied root capability under the explicit trust precondition above. */
export async function openTrustedAppOwnedGenerationRootForTestOnly(path: string): Promise<TrustedAppOwnedGenerationRootForTestOnly> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!canonicalAbsolute(path) || await realpath(path) !== path) throw failed();
    const namedBefore = await lstat(path, { bigint: true });
    if (!namedBefore.isDirectory() || namedBefore.isSymbolicLink()) throw failed();
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = identityOf(await handle.stat({ bigint: true })); const named = identityOf(await lstat(path, { bigint: true }));
    if (!isOwnedDirectory(identity) || !sameDirectory(identity, named)) throw failed();
    return Object.freeze({ path, handle, identity, rootBindingSha256: rootBindingSha256For(path, identity) });
  } catch { await handle?.close(); throw failed(); }
}
export async function closeTrustedAppOwnedGenerationRootForTestOnly(root: TrustedAppOwnedGenerationRootForTestOnly): Promise<void> { try { await root.handle.close(); } catch { /* test cleanup */ } }

/** Private immutable publisher/loader. It is intentionally absent from runtime barrels. */
export class TransactionalPersistenceFilesystemForTestOnly {
  private lane: Promise<void> = Promise.resolve();
  readonly protectionMarker: TransactionalPersistenceFilesystemProtectionMarkerForTestOnly;
  private readonly maximumWireBytes: number;
  constructor(private readonly root: TrustedAppOwnedGenerationRootForTestOnly, private readonly wireCodec?: WholeMediumAeadFilesystemWireCodecForTestOnly) {
    this.protectionMarker = wireCodec === undefined ? Object.freeze({ kind: "plaintext-test-only" as const }) : wireCodec.markerForRoot(root.rootBindingSha256);
    this.maximumWireBytes = wireCodec?.maximumWireBytes ?? MAX_IMAGE_BYTES;
  }

  async publish(image: unknown): Promise<PublishedTransactionalPersistenceGeneration> {
    let bytes: Uint8Array | undefined; let decoded: TransactionalPersistenceMediumImage | undefined;
    try {
      bytes = encodeTransactionalPersistenceMediumImage(image);
      decoded = decodeOwnedTransactionalPersistenceMediumImage(new Uint8Array(bytes));
      return await this.withQueue(async () => this.publishLocked(decoded!, bytes!));
    } catch { throw failed(); }
    finally { wipe(bytes); disposeTransactionalPersistenceMediumImageForTestOnly(decoded); }
  }

  async loadLatest(): Promise<TransactionalPersistenceMediumImage | undefined> {
    try { return await this.withQueue(async () => {
      const scan = await this.scanLocked();
      if (scan.head === undefined) return undefined;
      wipe(scan.head.bytes); wipe(scan.head.innerBytes);
      return scan.head.image;
    }); } catch { throw failed(); }
  }

  private async publishLocked(image: TransactionalPersistenceMediumImage, bytes: Uint8Array): Promise<PublishedTransactionalPersistenceGeneration> {
    const generation = image.state.generation; const digest = sha256(bytes);
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) throw failed();
    const scan = await this.scanLocked({ generation, bytes });
    let sealed: Uint8Array | undefined;
    try {
      if (generation < scan.count) {
        if (scan.candidateMatches !== true) throw failed();
        return Object.freeze({ generation, imageSha256: digest });
      }
      if (generation !== scan.count || scan.stageCount >= MAX_STAGES || !hasParentLink(image, generation, scan.head?.image)) throw failed();
      if (this.wireCodec === undefined) sealed = new Uint8Array(bytes);
      else sealed = (await this.wireCodec.seal(this.root.rootBindingSha256, generation, scan.head?.envelopeWireSha256, bytes)).bytes;
      return await publishExactGeneration(this.root, generation, sealed, bytes, digest, this.wireCodec, this.maximumWireBytes, scan.head?.envelopeWireSha256);
    } finally { wipe(sealed); if (scan.head !== undefined) { wipe(scan.head.bytes); wipe(scan.head.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(scan.head.image); } }
  }

  /** O(1)-image scan: predecessor buffers are wiped immediately after validation. */
  private async scanLocked(candidate?: { readonly generation: number; readonly bytes: Uint8Array }): Promise<{ readonly count: number; readonly head: LoadedGeneration | undefined; readonly candidateMatches: boolean | undefined; readonly stageCount: number }> {
    await assertRoot(this.root);
    await reconcilePendingLinkedStages(this.root, await boundedRootNames(this.root), this.wireCodec, this.maximumWireBytes);
    const currentNames = await boundedRootNames(this.root);
    const stageCount = currentNames.filter((name) => name.startsWith(STAGE_PREFIX)).length;
    const names = currentNames.filter((name) => !name.startsWith(STAGE_PREFIX));
    if (names.length > MAX_GENERATIONS) throw failed();
    let previous: LoadedGeneration | undefined; let candidateMatches: boolean | undefined;
    try {
      for (let generation = 0; generation < names.length; generation += 1) {
        if (names[generation] !== generationName(generation)) throw failed();
        const current = await readGeneration(this.root, generation, previous?.envelopeWireSha256, this.wireCodec, this.maximumWireBytes);
        if (!hasParentLink(current.image, generation, previous?.image)) { wipe(current.bytes); wipe(current.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(current.image); throw failed(); }
        if (candidate?.generation === generation) candidateMatches = sameBytes(current.innerBytes, candidate.bytes);
        if (previous !== undefined) { wipe(previous.bytes); wipe(previous.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(previous.image); }
        previous = current;
      }
      return Object.freeze({ count: names.length, head: previous, candidateMatches, stageCount });
    } catch { if (previous !== undefined) { wipe(previous.bytes); wipe(previous.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(previous.image); } throw failed(); }
  }

  private async withQueue<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined; const prior = this.lane;
    this.lane = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); }
    finally { release?.(); }
  }
}

interface LoadedGeneration { readonly generation: number; readonly imageSha256: string; readonly envelopeWireSha256: string; readonly bytes: Uint8Array; readonly innerBytes: Uint8Array; readonly image: TransactionalPersistenceMediumImage; }

async function publishExactGeneration(root: TrustedAppOwnedGenerationRootForTestOnly, generation: number, bytes: Uint8Array, innerBytes: Uint8Array, digest: string, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number, predecessorEnvelopeSha256: string | undefined): Promise<PublishedTransactionalPersistenceGeneration> {
  await assertRoot(root);
  const finalPath = join(root.path, generationName(generation)); let stagePath: string | undefined;
  let stage: Identity | undefined; let linked = false;
  try {
    const staged = await writeStageInAvailableSlot(root, bytes); stagePath = staged.path; stage = staged.identity;
    await root.handle.sync();
    try { await link(stagePath, finalPath); linked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readExistingGenerationAfterContention(root, generation, predecessorEnvelopeSha256, codec, maximumWireBytes);
      try { if (!sameBytes(existing.innerBytes, innerBytes)) throw failed(); }
      finally { wipe(existing.bytes); wipe(existing.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(existing.image); }
      await cleanupVerifiedStage(root, stagePath, stage, bytes, 1n, maximumWireBytes);
      return Object.freeze({ generation, imageSha256: digest });
    }
    await reconcileLinkedStage(root, stagePath, finalPath, stage, bytes, generation, predecessorEnvelopeSha256, codec, maximumWireBytes);
    return Object.freeze({ generation, imageSha256: digest });
  } catch {
    // Once link may have succeeded, reconcile the final exact bytes instead of
    // deleting a possibly committed generation. Pre-link cleanup is verified.
    if (linked && stage !== undefined && stagePath !== undefined) {
      try { await reconcileLinkedStage(root, stagePath, finalPath, stage, bytes, generation, predecessorEnvelopeSha256, codec, maximumWireBytes); return Object.freeze({ generation, imageSha256: digest }); } catch { /* commit status remains fail-closed */ }
    }
    if (!linked && stage !== undefined && stagePath !== undefined) await cleanupVerifiedStage(root, stagePath, stage, bytes, 1n, maximumWireBytes);
    throw failed();
  }
}

async function writeStageInAvailableSlot(root: TrustedAppOwnedGenerationRootForTestOnly, bytes: Uint8Array): Promise<{ readonly path: string; readonly identity: Identity }> {
  for (let slot = 0; slot < MAX_STAGES; slot += 1) {
    const path = join(root.path, stageName(slot)); const identity = await tryWriteStage(root, path, bytes);
    if (identity !== undefined) return Object.freeze({ path, identity });
  }
  throw failed();
}

async function tryWriteStage(root: TrustedAppOwnedGenerationRootForTestOnly, path: string, bytes: Uint8Array): Promise<Identity | undefined> {
  if (dirname(path) !== root.path || !isStageName(basename(path))) throw failed();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw error; }
    await writeLoop(handle, bytes); await handle.chmod(FILE_MODE); await handle.datasync(); await handle.sync();
    const fd = identityOf(await handle.stat({ bigint: true })); const named = identityOf(await lstat(path, { bigint: true }));
    if (!isOwnedFile(fd, 1n) || !sameFile(fd, named) || fd.size !== BigInt(bytes.byteLength)) throw failed();
    return fd;
  } catch { throw failed(); }
  finally { await handle?.close(); }
}

async function reconcileLinkedStage(root: TrustedAppOwnedGenerationRootForTestOnly, stagePath: string, finalPath: string, stage: Identity, bytes: Uint8Array, generation: number, predecessorEnvelopeSha256: string | undefined, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<void> {
  try {
    const final = await readGeneration(root, generation, predecessorEnvelopeSha256, codec, maximumWireBytes, 2n);
    try {
      const currentStage = identityOf(await lstat(stagePath, { bigint: true })); const currentFinal = identityOf(await lstat(finalPath, { bigint: true }));
      if (!sameFileIgnoringLinks(currentStage, stage) || !sameInode(currentStage, currentFinal) || !isOwnedFile(currentStage, 2n) || !isOwnedFile(currentFinal, 2n) || !sameBytes(final.bytes, bytes)) throw failed();
      await root.handle.sync();
      await unlink(stagePath);
      await root.handle.sync();
      const finalAfter = identityOf(await lstat(finalPath, { bigint: true }));
      if (!isOwnedFile(finalAfter, 1n) || !sameInode(finalAfter, stage)) throw failed();
    } finally { wipe(final.bytes); wipe(final.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(final.image); }
  } catch { await adoptAlreadyReconciledFinal(root, stagePath, finalPath, stage, bytes, generation, predecessorEnvelopeSha256, codec, maximumWireBytes); }
}

async function adoptAlreadyReconciledFinal(root: TrustedAppOwnedGenerationRootForTestOnly, stagePath: string, finalPath: string, stage: Identity, bytes: Uint8Array, generation: number, predecessorEnvelopeSha256: string | undefined, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<void> {
  try { await lstat(stagePath); throw failed(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failed(); }
  const final = await readGeneration(root, generation, predecessorEnvelopeSha256, codec, maximumWireBytes, 1n);
  try {
    const before = identityOf(await lstat(finalPath, { bigint: true }));
    if (!sameFileIgnoringLinks(before, stage) || !isOwnedFile(before, 1n) || !sameBytes(final.bytes, bytes)) throw failed();
    await root.handle.sync();
    const after = identityOf(await lstat(finalPath, { bigint: true }));
    if (!sameFile(before, after)) throw failed();
  } finally { wipe(final.bytes); wipe(final.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(final.image); }
}

async function cleanupVerifiedStage(root: TrustedAppOwnedGenerationRootForTestOnly, path: string, expected: Identity, bytes: Uint8Array, links: bigint, maximumWireBytes: number): Promise<void> {
  try {
    const current = identityOf(await lstat(path, { bigint: true }));
    if (!sameFile(current, expected) || !isOwnedFile(current, links)) return;
    const actual = await readStableOwnedFile(path, maximumWireBytes, links);
    try { if (!sameBytes(actual, bytes)) return; } finally { wipe(actual); }
    await unlink(path); await root.handle.sync();
  } catch { /* leave an unverified stage for fail-closed recovery */ }
}

async function readGeneration(root: TrustedAppOwnedGenerationRootForTestOnly, generation: number, predecessorEnvelopeSha256: string | undefined, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number, links = 1n): Promise<LoadedGeneration> {
  const path = join(root.path, generationName(generation)); let bytes: Uint8Array | undefined; let innerBytes: Uint8Array | undefined; let image: TransactionalPersistenceMediumImage | undefined;
  try {
    bytes = await readStableOwnedFile(path, maximumWireBytes, links);
    let envelopeWireSha256: string;
    if (codec === undefined) {
      image = decodeOwnedTransactionalPersistenceMediumImage(new Uint8Array(bytes));
      innerBytes = encodeTransactionalPersistenceMediumImage(image);
      if (!sameBytes(innerBytes, bytes) || image.state.generation !== generation) throw failed();
      envelopeWireSha256 = sha256(bytes);
    } else {
      const opened = await codec.open(root.rootBindingSha256, generation, predecessorEnvelopeSha256, bytes);
      image = opened.image; innerBytes = opened.innerBytes; envelopeWireSha256 = opened.envelopeWireSha256;
    }
    const result = Object.freeze({ generation, imageSha256: sha256(innerBytes), envelopeWireSha256, bytes, innerBytes, image }); bytes = undefined; innerBytes = undefined; image = undefined; return result;
  } catch { throw failed(); }
  finally { wipe(bytes); wipe(innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(image); }
}

/** Reconciles each exact two-link hardlink transition and bounds inert residues. */
async function reconcilePendingLinkedStages(root: TrustedAppOwnedGenerationRootForTestOnly, names: readonly string[], codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<void> {
  const stages = names.filter((name) => name.startsWith(STAGE_PREFIX));
  if (stages.length === 0) return;
  if (stages.length > MAX_STAGES || stages.some((name) => !isStageName(name))) throw failed();
  for (const stage of stages.sort()) await reconcilePendingLinkedStage(root, stage, codec, maximumWireBytes);
}

async function reconcilePendingLinkedStage(root: TrustedAppOwnedGenerationRootForTestOnly, stageName: string, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<void> {
  const stagePath = join(root.path, stageName);
  let stageBytes: Uint8Array | undefined; let final: LoadedGeneration | undefined;
  try {
    const stageIdentity = identityOf(await lstat(stagePath, { bigint: true }));
    if (isOwnedFile(stageIdentity, 1n)) {
      if (stageIdentity.size > BigInt(maximumWireBytes)) throw failed();
      if (codec !== undefined) await authenticateInertProtectedStage(root, stagePath, codec, maximumWireBytes);
      return; // inert stale pre-link stage; loader never deletes it.
    }
    if (!isOwnedFile(stageIdentity, 2n)) throw failed();
    stageBytes = await readStableOwnedFile(stagePath, maximumWireBytes, 2n);
    let generation: number;
    if (codec === undefined) {
      const stageImage = decodeOwnedTransactionalPersistenceMediumImage(new Uint8Array(stageBytes));
      try { generation = stageImage.state.generation; }
      finally { disposeTransactionalPersistenceMediumImageForTestOnly(stageImage); }
    } else generation = codec.inspectGeneration(root.rootBindingSha256, stageBytes);
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) throw failed();
    const finalPath = join(root.path, generationName(generation));
    const finalIdentity = identityOf(await lstat(finalPath, { bigint: true }));
    if (!sameInode(stageIdentity, finalIdentity) || !isOwnedFile(stageIdentity, 2n) || !isOwnedFile(finalIdentity, 2n)) throw failed();
    final = await readGeneration(root, generation, await predecessorEnvelopeForGeneration(root, generation, codec, maximumWireBytes), codec, maximumWireBytes, 2n);
    if (!sameBytes(stageBytes, final.bytes)) throw failed();
    await root.handle.sync(); await unlink(stagePath); await root.handle.sync();
    const finalAfter = identityOf(await lstat(finalPath, { bigint: true }));
    if (!isOwnedFile(finalAfter, 1n) || !sameInode(finalAfter, stageIdentity)) throw failed();
  } catch { throw failed(); }
  finally { wipe(stageBytes); if (final !== undefined) { wipe(final.bytes); wipe(final.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(final.image); } }
}

/** A loser may observe the winner's intentional two-link interval. */
async function readExistingGenerationAfterContention(root: TrustedAppOwnedGenerationRootForTestOnly, generation: number, predecessorEnvelopeSha256: string | undefined, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<LoadedGeneration> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await reconcilePendingLinkedStages(root, await boundedRootNames(root), codec, maximumWireBytes);
      return await readGeneration(root, generation, predecessorEnvelopeSha256, codec, maximumWireBytes);
    } catch { if (attempt === 1) throw failed(); }
  }
  throw failed();
}

async function predecessorEnvelopeForGeneration(root: TrustedAppOwnedGenerationRootForTestOnly, generation: number, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<string | undefined> {
  const predecessor = await predecessorForGeneration(root, generation, codec, maximumWireBytes);
  try { return predecessor?.envelopeWireSha256; }
  finally { if (predecessor !== undefined) { wipe(predecessor.bytes); wipe(predecessor.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(predecessor.image); } }
}

async function predecessorForGeneration(root: TrustedAppOwnedGenerationRootForTestOnly, generation: number, codec: WholeMediumAeadFilesystemWireCodecForTestOnly | undefined, maximumWireBytes: number): Promise<LoadedGeneration | undefined> {
  let predecessor: LoadedGeneration | undefined;
  try {
    for (let index = 0; index < generation; index += 1) {
      const current = await readGeneration(root, index, predecessor?.envelopeWireSha256, codec, maximumWireBytes);
      if (predecessor !== undefined) { wipe(predecessor.bytes); wipe(predecessor.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(predecessor.image); }
      predecessor = current;
    }
    const result = predecessor; predecessor = undefined; return result;
  } finally { if (predecessor !== undefined) { wipe(predecessor.bytes); wipe(predecessor.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(predecessor.image); } }
}

async function authenticateInertProtectedStage(root: TrustedAppOwnedGenerationRootForTestOnly, path: string, codec: WholeMediumAeadFilesystemWireCodecForTestOnly, maximumWireBytes: number): Promise<void> {
  let wire: Uint8Array | undefined; let predecessor: LoadedGeneration | undefined; let opened: Awaited<ReturnType<WholeMediumAeadFilesystemWireCodecForTestOnly["open"]>> | undefined;
  try {
    wire = await readStableOwnedFile(path, maximumWireBytes, 1n);
    const generation = codec.inspectGeneration(root.rootBindingSha256, wire);
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) throw failed();
    predecessor = await predecessorForGeneration(root, generation, codec, maximumWireBytes);
    opened = await codec.open(root.rootBindingSha256, generation, predecessor?.envelopeWireSha256, wire);
    if (!hasParentLink(opened.image, generation, predecessor?.image)) throw failed();
  } catch { throw failed(); }
  finally {
    wipe(wire); if (opened !== undefined) { wipe(opened.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(opened.image); }
    if (predecessor !== undefined) { wipe(predecessor.bytes); wipe(predecessor.innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(predecessor.image); }
  }
}

async function readStableOwnedFile(path: string, maximum: number, links: bigint): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined; let bytes: Uint8Array | undefined;
  try {
    const namedBefore = await lstat(path, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) throw failed();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = identityOf(await handle.stat({ bigint: true }));
    if (!isOwnedFile(before, links) || before.size < 1n || before.size > BigInt(maximum)) throw failed();
    bytes = new Uint8Array(Number(before.size)); let offset = 0;
    while (offset < bytes.byteLength) { const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset); if (read.bytesRead <= 0) throw failed(); offset += read.bytesRead; }
    const probe = new Uint8Array(1); try { if ((await handle.read(probe, 0, 1, bytes.byteLength)).bytesRead !== 0) throw failed(); } finally { wipe(probe); }
    const after = identityOf(await handle.stat({ bigint: true })); const named = identityOf(await lstat(path, { bigint: true }));
    if (!sameFile(before, after) || !sameFile(before, named)) throw failed();
    const result = bytes; bytes = undefined; return result;
  } catch { throw failed(); }
  finally { await handle?.close(); wipe(bytes); }
}

async function writeLoop(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> { let offset = 0; while (offset < bytes.byteLength) { const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset); if (result.bytesWritten <= 0) throw failed(); offset += result.bytesWritten; } }
function hasParentLink(image: TransactionalPersistenceMediumImage, generation: number, parent: TransactionalPersistenceMediumImage | undefined): boolean {
  if (image.state.generation !== generation) return false;
  if (generation === 0) return image.receipts.length === 0 && parent === undefined;
  try { if (parent === undefined || image.receipts.length !== generation) return false; validateTransactionalPersistenceSuccessorForTestOnly(parent, image); return true; } catch { return false; }
}
async function assertRoot(root: TrustedAppOwnedGenerationRootForTestOnly): Promise<void> { if (!canonicalAbsolute(root.path) || dirname(root.path) === root.path || await realpath(root.path) !== root.path) throw failed(); const fd = identityOf(await root.handle.stat({ bigint: true })); const named = identityOf(await lstat(root.path, { bigint: true })); if (!isOwnedDirectory(fd) || !sameDirectory(fd, root.identity) || !sameDirectory(fd, named) || root.rootBindingSha256 !== rootBindingSha256For(root.path, fd)) throw failed(); }
async function boundedRootNames(root: TrustedAppOwnedGenerationRootForTestOnly): Promise<string[]> {
  const directory = await opendir(root.path); const names: string[] = [];
  try { for await (const entry of directory) { if (names.length >= MAX_GENERATIONS + MAX_STAGES) throw failed(); names.push(entry.name); } }
  finally { await directory.close().catch(() => undefined); }
  return names.sort();
}
function generationName(generation: number): string { if (!Number.isSafeInteger(generation) || generation < 0 || generation > MAX_GENERATION) throw failed(); return `generation-${generation.toString().padStart(GENERATION_WIDTH, "0")}`; }
function stageName(slot: number): string { if (!Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_STAGES) throw failed(); return `${STAGE_PREFIX}${slot.toString().padStart(2, "0")}`; }
function isStageName(value: string): boolean { return /^\.transactional-persistence-stage-0[0-7]$/u.test(value); }
function canonicalAbsolute(path: string): boolean { return typeof path === "string" && path.length > 1 && !path.includes("\0") && isAbsolute(path) && resolve(path) === path && basename(path) !== "." && basename(path) !== ".."; }
function rootBindingSha256For(path: string, identity: Identity): string { return createHash("sha256").update(JSON.stringify({ domain: "switchboard/private/transactional-medium/root-binding/v1", dev: identity.dev.toString(), ino: identity.ino.toString(), path, uid: identity.uid.toString() }), "utf8").digest("hex"); }
function identityOf(status: Awaited<ReturnType<typeof lstat>>): Identity { return Object.freeze({ dev: BigInt(status.dev), ino: BigInt(status.ino), uid: BigInt(status.uid), mode: Number(status.mode) & 0o7777, nlink: BigInt(status.nlink), size: BigInt(status.size), type: status.isDirectory() ? "directory" : status.isFile() ? "file" : "other" }); }
function sameInode(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameDirectory(left: Identity, right: Identity): boolean { return left.type === "directory" && right.type === "directory" && sameInode(left, right) && left.uid === right.uid && left.mode === right.mode; }
function sameFile(left: Identity, right: Identity): boolean { return left.type === "file" && right.type === "file" && sameInode(left, right) && left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size; }
function sameFileIgnoringLinks(left: Identity, right: Identity): boolean { return left.type === "file" && right.type === "file" && sameInode(left, right) && left.uid === right.uid && left.mode === right.mode && left.size === right.size; }
function isOwnedDirectory(value: Identity): boolean { return value.type === "directory" && value.uid === BigInt(process.getuid?.() ?? -1) && value.mode === DIRECTORY_MODE; }
function isOwnedFile(value: Identity, links: bigint): boolean { return value.type === "file" && value.uid === BigInt(process.getuid?.() ?? -1) && value.mode === FILE_MODE && value.nlink === links; }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; let different = 0; for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!; return different === 0; }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function wipe(value: Uint8Array | undefined): void { try { value?.fill(0); } catch { /* owned temporary cleanup */ } }
function failed(): TransactionalPersistenceFilesystemError { return new TransactionalPersistenceFilesystemError(); }
