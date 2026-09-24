import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, inspectTarGzArchive, sha256, type RuntimeMemberManifest, type SafeArchiveMember } from "./archive-safety.js";
import { atomicPublishDirectory } from "./atomic-publish.js";
import { LLAMA_B10182_MACOS_ARM64_PIN } from "./llama-b10182-macos-arm64-pin.js";

const EVIDENCE = Object.freeze({
  memberManifest: { name: "member-manifest.json", bytes: 10165, sha256: "69db0370362224296af9886d6526f987125a798c65c5d4dfa91fef446fccff79" },
  sourceReceipt: { name: "source-receipt.json", bytes: 1803, sha256: "86fcb867e97c26df469825ef2f4fdfe33db084ec13ed4250098f9d2c1db6c93d" },
  notice: { name: "NOTICE.md", bytes: 1824, sha256: "617cf53f70354c48e0dac7c269af6efca9632115de5bf72902afb9e222aa157c" }
});
const RECEIPT_NAME = "switchboard-sidecar-assembly-receipt.json";
const TEMP_PREFIX = "switchboard-sidecar-tmp-";
const limits = { expectedPayloadRoot: LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot, maxCompressedBytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, maxExpandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes, maxMemberBytes: 16 * 1024 * 1024, maxMembers: 256, maxTotalFileBytes: 64 * 1024 * 1024 };
const EXPECTED_SOURCE_RECEIPT = Object.freeze({
  receiptVersion: 1, status: "pinned-source-input-not-distributed", runtimeId: "llama.cpp", upstreamRepository: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepository, upstreamRepositoryUrl: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepositoryUrl, tag: LLAMA_B10182_MACOS_ARM64_PIN.tag, sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit, releaseUrl: "https://github.com/ggml-org/llama.cpp/releases/tag/b10182",
  target: Object.freeze({ platform: "darwin", architecture: "arm64", acceleration: Object.freeze(["cpu", "metal"]) }),
  archive: Object.freeze({ filename: LLAMA_B10182_MACOS_ARM64_PIN.archiveFilename, url: LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl, bytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, expandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes, sha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256, observedAt: "2026-07-30" }),
  memberManifest: Object.freeze({ path: "member-manifest.json", members: 62, canonicalSha256: LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256 }),
  requiredPayload: Object.freeze({ server: Object.freeze({ path: LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath, sha256: LLAMA_B10182_MACOS_ARM64_PIN.serverSha256 }), license: Object.freeze({ path: LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath, sha256: LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256 }) }),
  versionProbe: Object.freeze({ arguments: Object.freeze(["--version"]), expectedVersionLine: "version: 10182 (afeebe103)", expectedTargetSuffix: "for Darwin arm64" }),
  distributionGates: Object.freeze(["Switchboard code-signs the complete payload", "The outer macOS app and sidecar pass notarization", "The signed staged runtime passes a loopback health smoke test", "The previous known-good runtime remains available for rollback"])
});

export interface UnsignedSidecarAssemblyOptions { archivePath: string; outputPath: string; memberManifestPath: string; sourceReceiptPath: string; noticePath: string; }
export interface UnsignedSidecarAssemblyReceipt {
  readonly receiptVersion: 1; readonly status: "assembled-inactive-unsigned"; readonly runtimeId: "llama.cpp"; readonly upstreamRepository: string; readonly upstreamRepositoryUrl: string; readonly tag: "b10182"; readonly sourceCommit: string;
  readonly target: { readonly platform: "darwin"; readonly architecture: "arm64"; readonly acceleration: readonly ["cpu", "metal"] };
  readonly archive: { readonly filename: string; readonly url: string; readonly bytes: number; readonly expandedBytes: number; readonly sha256: string };
  readonly sourceReceipt: { readonly name: "source-receipt.json"; readonly bytes: 1803; readonly sha256: string };
  readonly memberManifest: { readonly name: "member-manifest.json"; readonly bytes: 10165; readonly fileSha256: string; readonly canonicalSha256: string; readonly members: 62; readonly types: { readonly directories: 1; readonly files: 43; readonly symlinks: 18 }; readonly modePolicy: "exact-source-manifest" };
  readonly requiredPayload: { readonly server: { readonly path: string; readonly size: 33472; readonly mode: 0o755; readonly sha256: string }; readonly license: { readonly path: string; readonly size: 1078; readonly mode: 0o644; readonly sha256: string } };
  readonly evidence: readonly { readonly name: string; readonly bytes: number; readonly sha256: string; readonly mode: 0o600 }[]; readonly outerMode: 0o700; readonly signingRequired: true; readonly notarizationRequired: true; readonly activationAllowed: false; readonly distributionAllowed: false; readonly executed: false;
}
export interface UnsignedSidecarAssembly { outputPath: string; payloadPath: string; serverPath: string; receipt: UnsignedSidecarAssemblyReceipt; }

export async function assemblePinnedLlamaB10182MacosArm64Sidecar(options: UnsignedSidecarAssemblyOptions): Promise<UnsignedSidecarAssembly> {
  const archivePath = await canonicalExistingPath(options.archivePath);
  const outputPath = canonicalAbsentOutput(options.outputPath);
  const parent = dirname(outputPath);
  const ownedParent = await openOwnedParent(parent);
  try {
  await assertAbsent(outputPath);
  const evidencePaths = [options.memberManifestPath, options.sourceReceiptPath, options.noticePath];
  const evidence = await Promise.all(evidencePaths.map((path, index) => readPinnedEvidence(path, Object.values(EVIDENCE)[index]!)));
  const archive = await readStablePinnedFile(archivePath, LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256);
  const inspection = inspectTarGzArchive(archive, LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256, limits);
  if (inspection.expandedBytes !== LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes || inspection.manifestCanonicalSha256 !== LLAMA_B10182_MACOS_ARM64_PIN.memberManifestCanonicalSha256) throw new Error("The retained archive manifest does not match the pinned source receipt.");
  const manifest = JSON.parse(evidence[0]!.toString("utf8")) as RuntimeMemberManifest;
  if (canonicalJson(manifest) !== canonicalJson(inspection.manifest)) throw new Error("The checked-in member manifest does not match the retained archive.");
  let source: unknown;
  try { source = JSON.parse(evidence[1]!.toString("utf8")); } catch { throw new Error("The checked-in source receipt is invalid."); }
  if (canonicalJson(source) !== canonicalJson(EXPECTED_SOURCE_RECEIPT)) throw new Error("The checked-in source receipt does not match the pinned source.");
  assertExactPinnedManifest(manifest);
  const ownedTemporary = await createOwnedTemporary(ownedParent);
  const temporary = ownedTemporary.path;
  try {
    await revalidateOwnedDirectory(ownedParent, false);
    await revalidateOwnedDirectory(ownedTemporary, true);
    for (const member of inspection.extractionEntries.filter((m) => m.type === "directory").sort((a, b) => a.path.split("/").length - b.path.split("/").length || comparePath(a.path, b.path))) await createDirectory(destination(temporary, member.path), member.mode);
    for (const member of inspection.extractionEntries.filter((m) => m.type === "file").sort((a, b) => comparePath(a.path, b.path))) await writeMember(destination(temporary, member.path), member);
    for (const member of inspection.extractionEntries.filter((m) => m.type === "symlink").sort((a, b) => comparePath(a.path, b.path))) await symlink(member.linkTarget!, destination(temporary, member.path));
    for (const [index, spec] of Object.values(EVIDENCE).entries()) await writeBytes(join(temporary, spec.name), evidence[index]!, 0o600);
    const receipt = deepFreeze<UnsignedSidecarAssemblyReceipt>({
      receiptVersion: 1, status: "assembled-inactive-unsigned", runtimeId: "llama.cpp", upstreamRepository: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepository, upstreamRepositoryUrl: LLAMA_B10182_MACOS_ARM64_PIN.upstreamRepositoryUrl, tag: "b10182", sourceCommit: LLAMA_B10182_MACOS_ARM64_PIN.sourceCommit,
      target: { platform: "darwin", architecture: "arm64", acceleration: ["cpu", "metal"] }, archive: { filename: LLAMA_B10182_MACOS_ARM64_PIN.archiveFilename, url: LLAMA_B10182_MACOS_ARM64_PIN.archiveUrl, bytes: LLAMA_B10182_MACOS_ARM64_PIN.archiveBytes, expandedBytes: LLAMA_B10182_MACOS_ARM64_PIN.expandedArchiveBytes, sha256: LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 },
      sourceReceipt: { name: "source-receipt.json", bytes: 1803, sha256: EVIDENCE.sourceReceipt.sha256 }, memberManifest: { name: "member-manifest.json", bytes: 10165, fileSha256: EVIDENCE.memberManifest.sha256, canonicalSha256: inspection.manifestCanonicalSha256, members: 62, types: { directories: 1, files: 43, symlinks: 18 }, modePolicy: "exact-source-manifest" },
      requiredPayload: { server: { path: LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath, size: 33472, mode: 0o755, sha256: LLAMA_B10182_MACOS_ARM64_PIN.serverSha256 }, license: { path: LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath, size: 1078, mode: 0o644, sha256: LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256 } }, evidence: Object.values(EVIDENCE).map((item) => ({ ...item, mode: 0o600 })), outerMode: 0o700, signingRequired: true, notarizationRequired: true, activationAllowed: false, distributionAllowed: false, executed: false
    });
    await writeBytes(join(temporary, RECEIPT_NAME), Buffer.from(`${canonicalJson(receipt)}\n`), 0o600);
    await revalidateOwnedDirectory(ownedTemporary, true);
    await verifyTree(temporary, inspection.manifest, evidence, receipt);
    await revalidateOwnedDirectory(ownedParent, false);
    await revalidateOwnedDirectory(ownedTemporary, true);
    const temporaryIdentity = ownedTemporary.identity;
    atomicPublishDirectory(parent, basename(temporary), basename(outputPath));
    const published = await lstat(outputPath);
    const publishedIdentity = identityOf(published);
    if (!published.isDirectory() || published.isSymbolicLink() || publishedIdentity.dev !== temporaryIdentity.dev || publishedIdentity.ino !== temporaryIdentity.ino || publishedIdentity.uid !== process.getuid?.() || publishedIdentity.mode !== 0o700) throw new Error("Published assembly identity verification failed.");
    return Object.freeze({ outputPath, payloadPath: join(outputPath, inspection.manifest.payloadRoot), serverPath: join(outputPath, LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath), receipt });
  } catch (error) { await cleanupOwnedTemporary(ownedParent, ownedTemporary); throw error; }
  finally { await ownedTemporary.handle.close(); }
  } finally { await ownedParent.handle.close(); }
}

async function canonicalExistingPath(path: string): Promise<string> { if (!isCanonical(path) || await realpath(dirname(path)) !== dirname(path)) throw new Error("Assembly input paths must be canonical absolute paths."); return path; }
function canonicalAbsentOutput(path: string): string { const leaf = basename(path); if (!isCanonical(path) || leaf.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(leaf)) throw new Error("Assembly output must be a canonical absent path with an ASCII basename."); return path; }
function isCanonical(path: string): boolean { return path.length > 1 && !path.includes("\0") && isAbsolute(path) && resolve(path) === path; }
function comparePath(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested); Object.freeze(value); } return value; }
async function assertAbsent(path: string): Promise<void> { try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } throw new Error("Assembly output already exists."); }
async function readPinnedEvidence(path: string, spec: { bytes: number; sha256: string }): Promise<Buffer> { const canonical = await canonicalExistingPath(path); return readStablePinnedFile(canonical, spec.bytes, spec.sha256); }
interface FileIdentity { dev: number; ino: number; uid: number; size: number; mtimeMs: number; ctimeMs: number; mode: number; }
interface OwnedDirectory { path: string; handle: Awaited<ReturnType<typeof open>>; identity: FileIdentity; }
function identityOf(status: Awaited<ReturnType<typeof lstat>>): FileIdentity { return { dev: Number(status.dev), ino: Number(status.ino), uid: Number(status.uid), size: Number(status.size), mtimeMs: Number(status.mtimeMs), ctimeMs: Number(status.ctimeMs), mode: Number(status.mode) & 0o7777 }; }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode; }
function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode; }
async function openOwnedParent(path: string): Promise<OwnedDirectory> { if (await realpath(path) !== path) throw new Error("Assembly output parent is not canonical."); const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { const fd = identityOf(await handle.stat()); const current = await lstat(path); if (!current.isDirectory() || current.isSymbolicLink() || fd.uid !== process.getuid?.() || (fd.mode & 0o022) !== 0 || !sameIdentity(fd, identityOf(current))) throw new Error("Assembly output parent is not an owned private canonical directory."); return { path, handle, identity: fd }; } catch (error) { await handle.close(); throw error; } }
async function revalidateOwnedDirectory(directory: OwnedDirectory, exact0700: boolean): Promise<void> { const fd = identityOf(await directory.handle.stat()); const current = await lstat(directory.path); if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectoryIdentity(fd, directory.identity) || !sameDirectoryIdentity(fd, identityOf(current)) || fd.uid !== process.getuid?.() || (exact0700 ? fd.mode !== 0o700 : (fd.mode & 0o022) !== 0)) throw new Error("Assembly directory identity changed."); }
async function createOwnedTemporary(parent: OwnedDirectory): Promise<OwnedDirectory> { await revalidateOwnedDirectory(parent, false); const path = await mkdtemp(join(parent.path, TEMP_PREFIX)); let handle: Awaited<ReturnType<typeof open>> | undefined; try { if (dirname(path) !== parent.path || !basename(path).startsWith(TEMP_PREFIX)) throw new Error("Assembly temporary path is invalid."); handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await handle.chmod(0o700); const identity = identityOf(await handle.stat()); const current = await lstat(path); if (!current.isDirectory() || current.isSymbolicLink() || identity.uid !== process.getuid?.() || identity.mode !== 0o700 || !sameIdentity(identity, identityOf(current))) throw new Error("Assembly temporary directory identity changed."); return { path, handle, identity }; } catch (error) { await handle?.close(); throw error; } }
async function readStablePinnedFile(path: string, expectedBytes: number, expectedSha256: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const beforeStatus = await handle.stat();
    const before = identityOf(beforeStatus);
    if (!beforeStatus.isFile() || beforeStatus.isSymbolicLink() || before.size !== expectedBytes) throw new Error("Pinned assembly input is not the expected regular file.");
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error("Pinned assembly input changed or does not match its digest.");
      offset += result.bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, expectedBytes)).bytesRead !== 0) throw new Error("Pinned assembly input changed or does not match its digest.");
    const after = identityOf(await handle.stat());
    const current = identityOf(await lstat(path));
    if (!sameIdentity(before, after) || !sameIdentity(before, current) || sha256(bytes) !== expectedSha256) throw new Error("Pinned assembly input changed or does not match its digest.");
    return bytes;
  } finally { await handle.close(); }
}
function assertExactPinnedManifest(manifest: RuntimeMemberManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.archiveSha256 !== LLAMA_B10182_MACOS_ARM64_PIN.archiveSha256 || manifest.payloadRoot !== LLAMA_B10182_MACOS_ARM64_PIN.payloadRoot || manifest.members.length !== 62) throw new Error("The checked-in member manifest is not the exact pinned manifest.");
  const directories = manifest.members.filter((member) => member.type === "directory");
  const files = manifest.members.filter((member) => member.type === "file");
  const links = manifest.members.filter((member) => member.type === "symlink");
  if (directories.length !== 1 || files.length !== 43 || links.length !== 18 || manifest.members.filter((member) => member.mode === 0o644).length !== 1 || manifest.members.filter((member) => member.mode === 0o755).length !== 61 || manifest.members.some((member) => member.mode !== 0o644 && member.mode !== 0o755)) throw new Error("The checked-in member manifest has an invalid mode or type distribution.");
  const server = files.find((member) => member.path === LLAMA_B10182_MACOS_ARM64_PIN.serverRelativePath);
  const license = files.find((member) => member.path === LLAMA_B10182_MACOS_ARM64_PIN.licenseRelativePath);
  if (server?.size !== 33472 || server.mode !== 0o755 || server.sha256 !== LLAMA_B10182_MACOS_ARM64_PIN.serverSha256 || license?.size !== 1078 || license.mode !== 0o644 || license.sha256 !== LLAMA_B10182_MACOS_ARM64_PIN.licenseSha256 || files.some((member) => member.sha256 === undefined || member.linkTarget !== undefined) || directories.some((member) => member.size !== 0 || member.sha256 !== undefined || member.linkTarget !== undefined) || links.some((member) => member.size !== 0 || member.sha256 !== undefined || member.linkTarget === undefined)) throw new Error("The checked-in member manifest is semantically invalid.");
}
function destination(root: string, memberPath: string): string { const result = resolve(root, memberPath); if (!result.startsWith(`${root}/`)) throw new Error("Assembly member escaped its temporary root."); return result; }
async function createDirectory(path: string, mode: number): Promise<void> { await mkdir(path, { mode }); const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.chmod(mode); const status = await handle.stat(); if (!status.isDirectory() || status.uid !== process.getuid?.() || (Number(status.mode) & 0o7777) !== mode) throw new Error("Assembled directory mode verification failed."); await handle.sync(); } finally { await handle.close(); } }
async function writeMember(path: string, member: SafeArchiveMember & { data?: Buffer }): Promise<void> { if (member.data === undefined) throw new Error("Archive file data is missing."); await writeBytes(path, member.data, member.mode); }
async function writeBytes(path: string, bytes: Buffer, mode: number): Promise<void> { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode); try { await handle.writeFile(bytes); await handle.chmod(mode); const status = await handle.stat(); if (!status.isFile() || status.uid !== process.getuid?.() || status.size !== bytes.byteLength || (Number(status.mode) & 0o7777) !== mode) throw new Error("Assembled file mode verification failed."); await handle.sync(); } finally { await handle.close(); } }
async function verifyTree(root: string, manifest: RuntimeMemberManifest, evidence: readonly Buffer[], receipt: UnsignedSidecarAssemblyReceipt): Promise<void> { const expected = new Set([...manifest.members.map((m) => m.path), ...Object.values(EVIDENCE).map((s) => s.name), RECEIPT_NAME]); const actual = await listTree(root); if (actual.size !== expected.size || [...actual].some((p) => !expected.has(p))) throw new Error("Assembled sidecar has an unexpected member set."); for (const member of manifest.members) { const path = destination(root, member.path); const status = await lstat(path); if (member.type === "directory") { if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (Number(status.mode) & 0o7777) !== member.mode) throw new Error("Assembled directory verification failed."); } else if (member.type === "file") { if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (Number(status.mode) & 0o7777) !== member.mode || status.size !== member.size || member.sha256 === undefined) throw new Error("Assembled file verification failed."); await readStablePinnedFile(path, member.size, member.sha256); } else if (!status.isSymbolicLink() || status.uid !== process.getuid?.() || await readlink(path) !== member.linkTarget) throw new Error("Assembled link verification failed."); } for (const [index, spec] of Object.values(EVIDENCE).entries()) { const path = join(root, spec.name); const status = await lstat(path); if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.getuid?.() || (Number(status.mode) & 0o7777) !== 0o600 || !Buffer.from(evidence[index]!).equals(await readStablePinnedFile(path, spec.bytes, spec.sha256))) throw new Error("Assembled evidence verification failed."); } const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`); if (!receiptBytes.equals(await readStablePinnedFile(join(root, RECEIPT_NAME), receiptBytes.byteLength, sha256(receiptBytes)))) throw new Error("Assembly receipt verification failed."); }
async function listTree(root: string, current = root, found = new Set<string>()): Promise<Set<string>> { for (const name of await readdir(current)) { const path = join(current, name); const status = await lstat(path); const rel = relative(root, path); found.add(rel); if (status.isDirectory() && !status.isSymbolicLink()) await listTree(root, path, found); else if (!status.isFile() && !status.isSymbolicLink()) throw new Error("Assembled sidecar has a forbidden special member."); } return found; }
async function cleanupOwnedTemporary(parent: OwnedDirectory, temporary: OwnedDirectory): Promise<void> { try { if (dirname(temporary.path) !== parent.path || !basename(temporary.path).startsWith(TEMP_PREFIX)) return; await revalidateOwnedDirectory(parent, false); await revalidateOwnedDirectory(temporary, true); await rm(temporary.path, { recursive: true, force: true }); } catch { /* Preserve the original failure and never remove an unverified replacement. */ } }
