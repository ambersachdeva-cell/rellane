import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryWorkStore, type StoredOpaqueRecord } from "./in-memory-work-store.js";
import {
  InMemoryTransactionalPersistenceMedium,
  snapshotFromInMemoryWorkStoreForTestOnly,
  type TransactionalPersistenceMediumImage,
} from "./transactional-persistence.js";
import {
  closeTrustedAppOwnedGenerationRootForTestOnly,
  openTrustedAppOwnedGenerationRootForTestOnly,
  TransactionalPersistenceFilesystemError,
  TransactionalPersistenceFilesystemForTestOnly,
  type TrustedAppOwnedGenerationRootForTestOnly,
} from "./transactional-persistence-filesystem.js";
import { type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { createWholeMediumAeadFilesystemWireCodecForTestOnly } from "./transactional-persistence-whole-medium-aead-codec.js";
import { encodeTransactionalPersistenceMediumImage } from "./transactional-persistence-image-codec.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SPACE = id(1); const TASK = id(2);
const mediumReference = Object.freeze({ spaceId: SPACE, keyId: id(90) });
const mediumProvider: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { const key = new Uint8Array(32).fill(9); try { await callback(key); } finally { key.fill(0); } } };
const roots: Array<{ path: string; root: TrustedAppOwnedGenerationRootForTestOnly }> = [];
const generationName = (generation: number) => `generation-${generation.toString().padStart(20, "0")}`;

afterEach(async () => { for (const item of roots.splice(0)) { await closeTrustedAppOwnedGenerationRootForTestOnly(item.root); await rm(item.path, { recursive: true, force: true }); } });

function record(payload = "task", entityId = TASK, ciphertextRef = id(100)): StoredOpaqueRecord {
  const ciphertext = new Uint8Array(Buffer.from(payload));
  return { ciphertext, record: { schemaVersion: 1, id: entityId, spaceId: SPACE, recordRevision: 1, idempotency: { kind: "task", idempotencyKeySha256: hash(`task:${entityId}`) },
    envelope: { envelopeVersion: 1, spaceId: SPACE, keyId: id(90), entityId, entityKind: "task", schemaVersion: 1, contentRevision: 1, kind: "payload", contentSha256: hash(`plain:${payload}`), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef, ciphertextSha256: hash(ciphertext), tag: "AAAAAAAAAAAAAAAAAAAAAA" } } } as StoredOpaqueRecord;
}
function runRecord(): StoredOpaqueRecord { const base = record("run", id(701), id(705)); return { ciphertext: base.ciphertext, record: { ...base.record, idempotency: { kind: "run", taskId: TASK, attempt: 1 }, envelope: { ...base.record.envelope, entityId: id(701), entityKind: "run" } } } as StoredOpaqueRecord; }
function images(payload = "task"): readonly [TransactionalPersistenceMediumImage, TransactionalPersistenceMediumImage] {
  const medium = new InMemoryTransactionalPersistenceMedium(); const initial = medium.exportImageForTestOnly(); const port = medium.openPortForTestOnly(); const before = port.recover();
  const store = new InMemoryWorkStore(); store.putRecord(record(payload));
  port.commit({ commitId: id(200), expectedGeneration: before.generation, expectedSnapshotSha256: before.snapshotSha256, operationBindingSha256: hash("binding"), snapshot: snapshotFromInMemoryWorkStoreForTestOnly(store) });
  return [initial, medium.exportImageForTestOnly()];
}
function branchImages(firstPayload: string, secondPayload: string): readonly [TransactionalPersistenceMediumImage, TransactionalPersistenceMediumImage, TransactionalPersistenceMediumImage] {
  const medium = new InMemoryTransactionalPersistenceMedium(); const initial = medium.exportImageForTestOnly(); const port = medium.openPortForTestOnly(); const before = port.recover();
  const firstStore = new InMemoryWorkStore(); firstStore.putRecord(record(firstPayload));
  port.commit({ commitId: id(210), expectedGeneration: before.generation, expectedSnapshotSha256: before.snapshotSha256, operationBindingSha256: hash(`binding:${firstPayload}`), snapshot: snapshotFromInMemoryWorkStoreForTestOnly(firstStore) });
  const first = medium.exportImageForTestOnly(); const recovered = port.recover(); const secondStore = new InMemoryWorkStore();
  secondStore.putRecord(record(firstPayload)); secondStore.putRecord(record(secondPayload, id(3), id(101)));
  port.commit({ commitId: id(211), expectedGeneration: recovered.generation, expectedSnapshotSha256: recovered.snapshotSha256, operationBindingSha256: hash(`binding:${secondPayload}`), snapshot: snapshotFromInMemoryWorkStoreForTestOnly(secondStore) });
  return [initial, first, medium.exportImageForTestOnly()];
}
function claimedImage(claimId: string): readonly [TransactionalPersistenceMediumImage, TransactionalPersistenceMediumImage] {
  const medium = new InMemoryTransactionalPersistenceMedium(); const zero = medium.exportImageForTestOnly(); const state = medium.openPortForTestOnly().recover(); let event = 706; const store = new InMemoryWorkStore(() => claimId, () => id(event++));
  try {
    store.putRecord(record("claim-proof")); store.putRecord(runRecord()); const effect = store.putEffect({ schemaVersion: 1, id: id(700), spaceId: SPACE, runId: id(701), runRevision: 1, stepKey: id(702), requestSha256: hash("claim-proof"), state: "pending", effectRevision: 1, claimId: null }); store.claimEffect(SPACE, effect.id, 1);
    medium.openPortForTestOnly().commit({ commitId: id(703), expectedGeneration: state.generation, expectedSnapshotSha256: state.snapshotSha256, operationBindingSha256: hash("claim-proof"), snapshot: snapshotFromInMemoryWorkStoreForTestOnly(store) }); return [zero, medium.exportImageForTestOnly()];
  } finally { store.disposeForTestOnly(); }
}
async function fixture(): Promise<{ path: string; root: TrustedAppOwnedGenerationRootForTestOnly; fs: TransactionalPersistenceFilesystemForTestOnly }> {
  const path = await mkdtemp("/private/tmp/switchboard-t2p-private-"); await chmod(path, 0o700);
  const root = await openTrustedAppOwnedGenerationRootForTestOnly(path); roots.push({ path, root });
  return { path, root, fs: new TransactionalPersistenceFilesystemForTestOnly(root) };
}
function expectFailure(action: () => Promise<unknown>): Promise<void> { return expect(action()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError); }
function protectedFilesystem(root: TrustedAppOwnedGenerationRootForTestOnly, provider: WorkspaceKeyProvider = mediumProvider): TransactionalPersistenceFilesystemForTestOnly { return new TransactionalPersistenceFilesystemForTestOnly(root, createWholeMediumAeadFilesystemWireCodecForTestOnly(provider, mediumReference)); }
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}

describe("private trusted-root immutable transactional persistence filesystem", () => {
  it("publishes exact contiguous immutable generations and accepts only exact idempotent replay", async () => {
    const { path, fs } = await fixture(); const [zero, one] = images();
    await expect(fs.publish(zero)).resolves.toMatchObject({ generation: 0 });
    await expect(fs.publish(zero)).resolves.toMatchObject({ generation: 0 });
    await expect(fs.publish(one)).resolves.toMatchObject({ generation: 1 });
    await expect(fs.loadLatest()).resolves.toEqual(one);
    expect(await readdir(path)).toEqual([generationName(0), generationName(1)]);
    await expectFailure(() => fs.publish({ ...one, state: { ...one.state, generation: 0 } }));
  });

  it("fails closed on wrong mode, corrupt newest, and a gap without fallback", async () => {
    const first = await fixture(); const [zero, one] = images(); await first.fs.publish(zero); await first.fs.publish(one);
    await chmod(join(first.path, generationName(1)), 0o644);
    await expectFailure(() => first.fs.loadLatest());
    const corrupt = await fixture(); await corrupt.fs.publish(zero); await corrupt.fs.publish(one);
    await writeFile(join(corrupt.path, generationName(1)), new Uint8Array([0xff])); await chmod(join(corrupt.path, generationName(1)), 0o600);
    await expectFailure(() => corrupt.fs.loadLatest());
    const second = await fixture(); await second.fs.publish(zero);
    await rename(join(second.path, generationName(0)), join(second.path, generationName(1)));
    await expectFailure(() => second.fs.loadLatest());
  });

  it("reconciles linked stages, tolerates bounded inert crash residue, and rejects malformed members", async () => {
    const { path, fs } = await fixture(); const [zero, one] = images(); await fs.publish(zero);
    const stage = ".transactional-persistence-stage-00";
    await link(join(path, generationName(0)), join(path, stage));
    await expect(fs.loadLatest()).resolves.toEqual(zero);
    expect(await readdir(path)).toEqual([generationName(0)]);
    const stale = ".transactional-persistence-stage-01";
    const secondStale = ".transactional-persistence-stage-02";
    const zeroBytes = await readFile(join(path, generationName(0)));
    await writeFile(join(path, stale), zeroBytes, { mode: 0o600 }); await chmod(join(path, stale), 0o600);
    await writeFile(join(path, secondStale), zeroBytes, { mode: 0o600 }); await chmod(join(path, secondStale), 0o600);
    await expect(fs.loadLatest()).resolves.toEqual(zero);
    await expect(fs.publish(one)).resolves.toMatchObject({ generation: 1 });
    expect(await readdir(path)).toEqual([stale, secondStale, generationName(0), generationName(1)]);
    await symlink(join(path, generationName(0)), join(path, "unexpected-link"));
    await expectFailure(() => fs.loadLatest());
    const malformed = await fixture();
    await writeFile(join(malformed.path, ".transactional-persistence-stage-not-a-uuid"), zeroBytes, { mode: 0o600 });
    await expectFailure(() => malformed.fs.loadLatest());
  });

  it("uses the hardlink CAS across independent instances for same and divergent attempts", async () => {
    const { root, fs } = await fixture(); const peer = new TransactionalPersistenceFilesystemForTestOnly(root); const [zero, one] = images();
    const same = await Promise.allSettled([fs.publish(zero), peer.publish(zero)]);
    expect(same.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const [, sibling] = images("other");
    const divergent = await Promise.allSettled([fs.publish(one), peer.publish(sibling)]);
    expect(divergent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const latest = await fs.loadLatest();
    expect([one, sibling]).toContainEqual(latest);
    await expectFailure(() => fs.publish(latest?.state.snapshotSha256 === one.state.snapshotSha256 ? sibling : one));
  });

  it("lets both exact contenders succeed when the loser reconciles the winner first", async () => {
    const { root } = await fixture(); const [zero] = images();
    const aAtFirstSync = deferred(); const releaseAFirstSync = deferred(); const aAtSecondSync = deferred(); const releaseASecondSync = deferred();
    const bAtFirstSync = deferred(); const releaseBFirstSync = deferred(); let aSyncs = 0; let bSyncs = 0;
    const aRoot = { ...root, handle: { stat: root.handle.stat.bind(root.handle), sync: async () => {
      aSyncs += 1;
      if (aSyncs === 1) { aAtFirstSync.resolve(); await releaseAFirstSync.promise; }
      if (aSyncs === 2) { aAtSecondSync.resolve(); await releaseASecondSync.promise; }
      await root.handle.sync();
    } } } as unknown as TrustedAppOwnedGenerationRootForTestOnly;
    const bRoot = { ...root, handle: { stat: root.handle.stat.bind(root.handle), sync: async () => {
      bSyncs += 1;
      if (bSyncs === 1) { bAtFirstSync.resolve(); await releaseBFirstSync.promise; }
      await root.handle.sync();
    } } } as unknown as TrustedAppOwnedGenerationRootForTestOnly;
    const aPublish = new TransactionalPersistenceFilesystemForTestOnly(aRoot).publish(zero); await aAtFirstSync.promise;
    const bPublish = new TransactionalPersistenceFilesystemForTestOnly(bRoot).publish(zero); await bAtFirstSync.promise;
    releaseAFirstSync.resolve(); await aAtSecondSync.promise;
    releaseBFirstSync.resolve(); await expect(bPublish).resolves.toMatchObject({ generation: 0 });
    releaseASecondSync.resolve(); await expect(aPublish).resolves.toMatchObject({ generation: 0 });
    await expect(new TransactionalPersistenceFilesystemForTestOnly(root).loadLatest()).resolves.toEqual(zero);
  });

  it("uses fixed exclusive stage slots so concurrent writers cannot exceed the residue bound", async () => {
    const { path, root, fs } = await fixture(); const [zero, one] = images(); await fs.publish(zero); const zeroBytes = await readFile(join(path, generationName(0)));
    for (let slot = 0; slot < 7; slot += 1) {
      const name = `.transactional-persistence-stage-${slot.toString().padStart(2, "0")}`;
      await writeFile(join(path, name), zeroBytes, { mode: 0o600 }); await chmod(join(path, name), 0o600);
    }
    const atReservedSlot = deferred(); const releaseReservedSlot = deferred(); let syncs = 0;
    const reservingRoot = { ...root, handle: { stat: root.handle.stat.bind(root.handle), sync: async () => {
      syncs += 1; if (syncs === 1) { atReservedSlot.resolve(); await releaseReservedSlot.promise; } await root.handle.sync();
    } } } as unknown as TrustedAppOwnedGenerationRootForTestOnly;
    const reserved = new TransactionalPersistenceFilesystemForTestOnly(reservingRoot).publish(one); await atReservedSlot.promise;
    await expectFailure(() => new TransactionalPersistenceFilesystemForTestOnly(root).publish(one));
    expect((await readdir(path)).filter((name) => name.startsWith(".transactional-persistence-stage-"))).toHaveLength(8);
    releaseReservedSlot.resolve(); await expect(reserved).resolves.toMatchObject({ generation: 1 });
    expect((await readdir(path)).filter((name) => name.startsWith(".transactional-persistence-stage-"))).toHaveLength(7);
    await expect(fs.loadLatest()).resolves.toEqual(one);
  });

  it("rejects a self-consistent generation whose receipt prefix belongs to another branch", async () => {
    const { fs } = await fixture(); const [zero, acceptedOne] = branchImages("accepted-one", "accepted-two");
    const [, , foreignTwo] = branchImages("foreign-one", "foreign-two");
    await fs.publish(zero); await fs.publish(acceptedOne);
    await expectFailure(() => fs.publish(foreignTwo));
    await expect(fs.loadLatest()).resolves.toEqual(acceptedOne);
  });

  it("recovers exact committed bytes after directory-sync failure on either side of stage unlink", async () => {
    for (const failAt of [2, 3]) {
      const { root, fs } = await fixture(); const [zero, one] = images(); const [, sibling] = images("conflict"); await fs.publish(zero);
      let syncCalls = 0;
      const failingHandle = {
        stat: root.handle.stat.bind(root.handle),
        sync: async () => { syncCalls += 1; if (syncCalls >= failAt) throw new Error("injected directory sync failure"); await root.handle.sync(); },
      };
      const faultRoot = { ...root, handle: failingHandle } as unknown as TrustedAppOwnedGenerationRootForTestOnly;
      await expectFailure(() => new TransactionalPersistenceFilesystemForTestOnly(faultRoot).publish(one));
      await expect(fs.loadLatest()).resolves.toEqual(one);
      await expect(fs.publish(one)).resolves.toMatchObject({ generation: 1 });
      await expectFailure(() => fs.publish(sibling));
    }
  });

  it("rejects a final with an external hardlink and a symlinked root leaf", async () => {
    const { path, fs } = await fixture(); const [zero] = images(); await fs.publish(zero);
    const aliases = await mkdtemp("/private/tmp/switchboard-t2p-alias-");
    try {
      await link(join(path, generationName(0)), join(aliases, "external-alias"));
      await expectFailure(() => fs.loadLatest());
    } finally { await rm(aliases, { recursive: true, force: true }); }
    await expect(fs.loadLatest()).resolves.toEqual(zero);
    const target = await mkdtemp("/private/tmp/switchboard-t2p-target-"); const leaf = `${target}-link`;
    try {
      await chmod(target, 0o700); await symlink(target, leaf);
      await expect(openTrustedAppOwnedGenerationRootForTestOnly(leaf)).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    } finally { await unlink(leaf).catch(() => undefined); await rm(target, { recursive: true, force: true }); }
  });

  it("bounds root enumeration and requires an explicitly trusted current-user exact-0700 root", async () => {
    const bounded = await fixture(); const [zero] = images(); await bounded.fs.publish(zero);
    await Promise.all(Array.from({ length: 265 }, async (_, index) => writeFile(join(bounded.path, `unexpected-${index.toString().padStart(3, "0")}`), new Uint8Array([1]), { mode: 0o600 })));
    await expectFailure(() => bounded.fs.loadLatest());
    const path = await mkdtemp("/private/tmp/switchboard-t2p-untrusted-");
    try { await chmod(path, 0o755); await expect(openTrustedAppOwnedGenerationRootForTestOnly(path)).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError); }
    finally { await rm(path, { recursive: true, force: true }); }
    const special = await fixture(); await mkdir(join(special.path, generationName(0)), { mode: 0o700 });
    await expectFailure(() => special.fs.loadLatest());
  });

  it("uses root- and predecessor-bound whole-medium AEAD without plaintext fallback", async () => {
    const { path, root } = await fixture(); const [zero, one] = images(); const fs = protectedFilesystem(root);
    await fs.publish(zero); const firstWire = await readFile(join(path, generationName(0)));
    expect(Buffer.from(firstWire).toString("utf8")).not.toContain("snapshotSha256");
    await fs.publish(one); const stage = ".transactional-persistence-stage-00"; await link(join(path, generationName(1)), join(path, stage)); const stageWire = await readFile(join(path, stage)); expect(Buffer.from(stageWire).toString("utf8")).not.toContain("snapshotSha256"); await expect(fs.loadLatest()).resolves.toEqual(one); stageWire.fill(0);
    expect(fs.protectionMarker).toMatchObject({ kind: "whole-medium-aead-v1", algorithm: "aes-256-gcm" }); expect(Object.isFrozen(fs.protectionMarker)).toBe(true);
    await expect(protectedFilesystem(root).loadLatest()).resolves.toEqual(one);
    const plain = await fixture(); await plain.fs.publish(zero);
    await expect(protectedFilesystem(plain.root).loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    const secondWire = await readFile(join(path, generationName(1))); await writeFile(join(path, generationName(0)), secondWire); await chmod(join(path, generationName(0)), 0o600);
    await expect(fs.loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    firstWire.fill(0); secondWire.fill(0);
  });

  it("authenticates protected inert stages and keeps known raw claim IDs out of every wire file", async () => {
    const { path, root } = await fixture(); const claimId = id(777); const [zero, claimed] = claimedImage(claimId); const plaintext = encodeTransactionalPersistenceMediumImage(claimed);
    try {
      expect(Buffer.from(plaintext).toString("utf8").split(claimId).length - 1).toBe(2);
      const fs = protectedFilesystem(root); await fs.publish(zero); await fs.publish(claimed);
      const stage = ".transactional-persistence-stage-03"; await link(join(path, generationName(1)), join(path, stage));
      const inert = ".transactional-persistence-stage-02"; const claimedWire = await readFile(join(path, generationName(1))); await writeFile(join(path, inert), claimedWire, { mode: 0o600 }); await chmod(join(path, inert), 0o600); expect((await lstat(join(path, inert), { bigint: true })).nlink).toBe(1n); const inertBefore = await readFile(join(path, inert));
      await expect(fs.loadLatest()).resolves.toEqual(claimed);
      expect(await readFile(join(path, inert))).toEqual(inertBefore);
      for (const name of await readdir(path)) if (name.startsWith("generation-") || name.startsWith(".transactional-persistence-stage-")) {
        const wire = Buffer.from(await readFile(join(path, name))).toString("utf8"); expect(wire).not.toContain(claimId); expect(wire).not.toContain("claimId"); expect(wire).not.toContain("issuedClaims");
      }
      const rawStage = ".transactional-persistence-stage-04"; await writeFile(join(path, rawStage), plaintext, { mode: 0o600 }); await chmod(join(path, rawStage), 0o600);
      await expect(fs.loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    } finally { plaintext.fill(0); }
  });

  it("fails closed after provider entry when an nlink-one protected stage has canonical-looking changed ciphertext", async () => {
    const { path, root } = await fixture(); const [zero] = images(); let calls = 0;
    const counted: WorkspaceKeyProvider = { async withUnlockedKey(reference, callback) { calls += 1; await mediumProvider.withUnlockedKey(reference, callback); } };
    const fs = protectedFilesystem(root, counted); await fs.publish(zero);
    const original = await readFile(join(path, generationName(0))); const outer = JSON.parse(Buffer.from(original).toString("utf8")) as { ciphertext: string };
    outer.ciphertext = `${outer.ciphertext[0] === "A" ? "B" : "A"}${outer.ciphertext.slice(1)}`;
    const tampered = new TextEncoder().encode(JSON.stringify(outer)); const stage = ".transactional-persistence-stage-00";
    try {
      await writeFile(join(path, stage), tampered, { mode: 0o600 }); await chmod(join(path, stage), 0o600); expect((await lstat(join(path, stage), { bigint: true })).nlink).toBe(1n); const before = await readFile(join(path, stage)); calls = 0;
      await expect(fs.loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
      expect(calls).toBe(1); expect(await readFile(join(path, stage))).toEqual(before);
    } finally { original.fill(0); tampered.fill(0); }
  });

  it("rejects plaintext protected stages before key entry and cross-space images before seal", async () => {
    const empty = await fixture(); const [zero, one] = images(); const raw = encodeTransactionalPersistenceMediumImage(zero); let calls = 0;
    const counted: WorkspaceKeyProvider = { async withUnlockedKey(reference, callback) { calls += 1; await mediumProvider.withUnlockedKey(reference, callback); } };
    try {
      await writeFile(join(empty.path, ".transactional-persistence-stage-00"), raw, { mode: 0o600 }); await chmod(join(empty.path, ".transactional-persistence-stage-00"), 0o600);
      await expect(protectedFilesystem(empty.root, counted).loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError); expect([calls, (await readdir(empty.path)).filter((name) => name.startsWith("generation-")).length]).toEqual([0, 0]);
      const space = await fixture(); const wrongReference = Object.freeze({ spaceId: id(999), keyId: id(90) }); const mismatched = new TransactionalPersistenceFilesystemForTestOnly(space.root, createWholeMediumAeadFilesystemWireCodecForTestOnly(counted, wrongReference));
      await mismatched.publish(zero); const before = calls; await expect(mismatched.publish(one)).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError); expect(calls).toBe(before + 1);
    } finally { raw.fill(0); }
  });

  it("preserves protected replay/CAS semantics and rejects wrong-key, cross-root, and truncated wire", async () => {
    const { path, root } = await fixture(); const [zero, one] = images(); const left = protectedFilesystem(root); const right = protectedFilesystem(root);
    const zeroOutcomes = await Promise.allSettled([left.publish(zero), right.publish(zero)]); expect(zeroOutcomes.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    const exactWire = await readFile(join(path, generationName(0))); await left.publish(zero); expect(await readFile(join(path, generationName(0)))).toEqual(exactWire);
    const oneOutcomes = await Promise.allSettled([left.publish(one), right.publish(one)]); expect(oneOutcomes.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    const wrong: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(32).fill(3)); } }; await expect(protectedFilesystem(root, wrong).loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    const other = await fixture(); const otherFs = protectedFilesystem(other.root); await otherFs.publish(zero); const copied = await readFile(join(path, generationName(0))); await writeFile(join(other.path, generationName(0)), copied); await chmod(join(other.path, generationName(0)), 0o600); await expect(otherFs.loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    const newest = await readFile(join(path, generationName(1))); await writeFile(join(path, generationName(1)), newest.subarray(0, newest.byteLength - 1)); await chmod(join(path, generationName(1)), 0o600); await expect(left.loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError);
    const splice = await fixture(); const spliceFs = protectedFilesystem(splice.root); await spliceFs.publish(zero); await spliceFs.publish(one); const inner = encodeTransactionalPersistenceMediumImage(zero); const alternate = await createWholeMediumAeadFilesystemWireCodecForTestOnly(mediumProvider, mediumReference).seal(splice.root.rootBindingSha256, 0, undefined, inner); try { await writeFile(join(splice.path, generationName(0)), alternate.bytes); await chmod(join(splice.path, generationName(0)), 0o600); await expect(spliceFs.loadLatest()).rejects.toBeInstanceOf(TransactionalPersistenceFilesystemError); } finally { inner.fill(0); alternate.bytes.fill(0); }
    const divergent = await fixture(); const divergentLeft = protectedFilesystem(divergent.root); const divergentRight = protectedFilesystem(divergent.root); const [, sibling] = images("other-protected"); await divergentLeft.publish(zero); const divergentOutcomes = await Promise.allSettled([divergentLeft.publish(one), divergentRight.publish(sibling)]); expect(divergentOutcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    exactWire.fill(0); copied.fill(0); newest.fill(0);
  });

  it("stays private and leaves both durable gates literal false", () => {
    const source = readFileSync(new URL("./transactional-persistence-filesystem.ts", import.meta.url), "utf8");
    const barrel = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const desktopGate = readFileSync(new URL("../../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8");
    const packageGate = readFileSync(new URL("../../../../apps/desktop/scripts/inspect-storage-capability-package.mjs", import.meta.url), "utf8");
    expect(barrel).not.toMatch(/transactional-persistence-filesystem|transactional-persistence-image-codec|transactional-persistence-whole-medium-aead-codec/);
    expect(source).not.toMatch(/electron|\bipc\b|child_process|sidecar|keychain|process\.env|\bfetch\b/i);
    expect(desktopGate).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
    expect(packageGate).toMatch(/durableSpacesEnabled:\s*false/);
  });
});
