import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryWorkStore, type StoredOpaqueRecord } from "./in-memory-work-store.js";
import { AsyncTransactionalPersistenceFilesystemPortForTestOnly, captureWholeMediumAeadProtectedPortCapabilityForTestOnly } from "./async-transactional-persistence-filesystem-port.js";
import { TransactionalPersistenceFilesystemForTestOnly, closeTrustedAppOwnedGenerationRootForTestOnly, openTrustedAppOwnedGenerationRootForTestOnly, type TrustedAppOwnedGenerationRootForTestOnly } from "./transactional-persistence-filesystem.js";
import { type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryTransactionalPersistenceMedium, disposeOpaqueJournalSnapshotForTestOnly, inspectAsyncFilesystemCaptureCleanupForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, type OpaqueJournalSnapshot, type TransactionCommitInput } from "./transactional-persistence.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SPACE = id(1);
const mediumReference = Object.freeze({ spaceId: SPACE, keyId: id(90) });
const mediumProvider: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { const key = new Uint8Array(32).fill(5); try { await callback(key); } finally { key.fill(0); } } };
const roots: Array<{ path: string; root: TrustedAppOwnedGenerationRootForTestOnly }> = [];
afterEach(async () => { for (const item of roots.splice(0)) { await closeTrustedAppOwnedGenerationRootForTestOnly(item.root); await rm(item.path, { recursive: true, force: true }); } });

function snapshot(records: number): OpaqueJournalSnapshot {
  const store = new InMemoryWorkStore();
  try { for (let index = 0; index < records; index += 1) { const entity = id(10 + index); const bytes = new Uint8Array(Buffer.from(`cipher-${index}`)); try { store.putRecord({ ciphertext: bytes, record: { schemaVersion: 1, id: entity, spaceId: SPACE, recordRevision: 1, idempotency: { kind: "entity" }, envelope: { envelopeVersion: 1, spaceId: SPACE, keyId: id(90), entityId: entity, entityKind: "artifact", schemaVersion: 1, contentRevision: 1, kind: "blob", contentSha256: hash(`plain-${index}`), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: id(100 + index), ciphertextSha256: hash(bytes), tag: "AAAAAAAAAAAAAAAAAAAAAA" } } } as StoredOpaqueRecord); } finally { bytes.fill(0); } } return snapshotFromInMemoryWorkStoreForTestOnly(store); }
  finally { store.disposeForTestOnly(); }
}
async function fixture() { const path = await mkdtemp("/private/tmp/switchboard-t2p-a3-"); await chmod(path, 0o700); const root = await openTrustedAppOwnedGenerationRootForTestOnly(path); roots.push({ path, root }); return root; }
function input(commitId: string, generation: number, snapshotSha256: string, value: OpaqueJournalSnapshot): TransactionCommitInput { return { commitId, expectedGeneration: generation, expectedSnapshotSha256: snapshotSha256, operationBindingSha256: hash(`binding-${commitId}`), snapshot: value }; }

describe("private async filesystem transactional persistence port", () => {
  it("initializes genesis, owns input before await, restarts, exact-replays, and advances without rebasing", async () => {
    const root = await fixture(); const first = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root); const genesis = await first.recover();
    expect(genesis.generation).toBe(0);
    const firstInput = input(id(200), genesis.generation, genesis.snapshotSha256, snapshot(4));
    const pending = first.commit(firstInput); firstInput.snapshot.ciphertextBlobs[0]!.bytes.fill(0);
    const receipt = await pending; expect(receipt.generation).toBe(1);
    const restarted = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root); const one = await restarted.recover();
    expect(one.snapshot.journal.records).toHaveLength(4);
    const replay = await restarted.commit(input(id(200), 0, genesis.snapshotSha256, snapshot(4)));
    expect(replay).toEqual(receipt); expect((await restarted.recover()).generation).toBe(1);
    const second = await restarted.commit(input(id(201), one.generation, one.snapshotSha256, snapshot(6)));
    expect(second.generation).toBe(2);
    expect((await restarted.recover()).snapshot.journal.records).toHaveLength(6);
    await expect(restarted.commit(input(id(200), 0, genesis.snapshotSha256, snapshot(4)))).resolves.toEqual(receipt);
    await expect(restarted.recoverOperationBinding(id(200))).resolves.toEqual({ commitId: id(200), operationBindingSha256: hash(`binding-${id(200)}`) });
    await expect(restarted.commit(input(id(201), 1, one.snapshotSha256, snapshot(4)))).rejects.toMatchObject({ code: "CONFLICT" });
    await first.close(); await restarted.close();
  });

  it("shares one same-root lane and rejects operations after close", async () => {
    const root = await fixture(); const left = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root); const right = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root); const genesis = await left.recover();
    const [first, replay] = await Promise.all([left.commit(input(id(210), genesis.generation, genesis.snapshotSha256, snapshot(3))), right.commit(input(id(210), genesis.generation, genesis.snapshotSha256, snapshot(3)))]);
    expect(first).toEqual(replay); expect((await right.recover()).generation).toBe(1);
    await left.close(); await right.close();
    await expect(left.recover()).rejects.toMatchObject({ code: "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED" });
  });

  it("maps pre-publication, lost-ack, and unavailable reload faults without rebasing", async () => {
    const root = await fixture(); const filesystem = new TransactionalPersistenceFilesystemForTestOnly(root); let publications = 0;
    const pre = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: () => filesystem.loadLatest(), publish: async (image) => { publications += 1; if (publications > 1) throw new Error("pre"); return filesystem.publish(image); } }));
    const genesis = await pre.recover(); await expect(pre.commit(input(id(220), 0, genesis.snapshotSha256, snapshot(2)))).rejects.toMatchObject({ code: "INTERRUPTED" }); expect((await pre.recover()).generation).toBe(0); await pre.close();
    let lostPublications = 0;
    const lost = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: () => filesystem.loadLatest(), publish: async (image) => { lostPublications += 1; const result = await filesystem.publish(image); if (lostPublications > 0) throw new Error("lost"); return result; } }));
    const receipt = await lost.commit(input(id(221), 0, genesis.snapshotSha256, snapshot(2))); expect(receipt.generation).toBe(1); await lost.close();
    let offline = false; const unavailable = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: async () => { if (offline) throw new Error("unavailable"); return filesystem.loadLatest(); }, publish: (image) => filesystem.publish(image) })); offline = true;
    await expect(unavailable.recover()).rejects.toMatchObject({ code: "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED" }); await unavailable.close();
  });

  it("maps reconciliation reload failure, other-winner publication, and releases after a prepublish interruption", async () => {
    const root = await fixture(); const fs = new TransactionalPersistenceFilesystemForTestOnly(root); let publishCalls = 0; let unavailableReload = false;
    const unavailable = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: async () => { if (unavailableReload) throw new Error("reload"); return fs.loadLatest(); }, publish: async (image) => { publishCalls += 1; if (publishCalls === 1) return fs.publish(image); unavailableReload = true; throw new Error("publish"); } })); const genesis = await unavailable.recover();
    const failure = await unavailable.commit(input(id(260), 0, genesis.snapshotSha256, snapshot(2))).catch((error) => error); expect(failure).toMatchObject({ name: "AsyncTransactionalPersistenceFilesystemPortError", code: "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED", message: "Async transactional persistence filesystem port operation failed." }); expect(failure.cause).toBeUndefined(); expect(failure.message).not.toContain(root.path); await unavailable.close();
    let competed = false; const winner = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: () => fs.loadLatest(), publish: async () => { if (!competed) { competed = true; const latest = await fs.loadLatest(); const medium = InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(latest!); const state = medium.openPortForTestOnly().recover(); const image = medium.openPortForTestOnly().commit(input(id(261), state.generation, state.snapshotSha256, snapshot(2))) && medium.exportImageForTestOnly(); try { await fs.publish(image); } finally { medium.disposeForTestOnly(); disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); disposeOpaqueJournalSnapshotForTestOnly(state.snapshot); disposeOpaqueJournalSnapshotForTestOnly(image.state.snapshot); } } throw new Error("other"); } }));
    await expect(winner.commit(input(id(262), 0, genesis.snapshotSha256, snapshot(2)))).rejects.toMatchObject({ code: "CONFLICT" }); expect(await winner.recoverOperationBinding(id(261))).toEqual({ commitId: id(261), operationBindingSha256: hash(`binding-${id(261)}`) }); await winner.close();
    let interrupted = true; const retry = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: () => fs.loadLatest(), publish: async (image) => { if (interrupted) { interrupted = false; throw new Error("once"); } return fs.publish(image); } })); const one = await retry.recover(); await expect(retry.commit(input(id(263), one.generation, one.snapshotSha256, snapshot(3)))).rejects.toMatchObject({ code: "INTERRUPTED" }); await expect(retry.commit(input(id(264), one.generation, one.snapshotSha256, snapshot(3)))).resolves.toMatchObject({ generation: 2 }); await retry.close();
  });

  it("treats exact replay as stable and changed binding or snapshot under its id as conflicts", async () => {
    const root = await fixture(); const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root); const genesis = await port.recover(); const receipt = await port.commit(input(id(270), 0, genesis.snapshotSha256, snapshot(2))); const replay = port.commit(input(id(270), 0, genesis.snapshotSha256, snapshot(2))); await expect(replay).resolves.toEqual(receipt);
    const binding = input(id(270), 0, genesis.snapshotSha256, snapshot(2)); (binding as { operationBindingSha256: string }).operationBindingSha256 = hash("changed"); await expect(port.commit(binding)).rejects.toMatchObject({ code: "CONFLICT" }); const changedSnapshot = port.commit(input(id(270), 0, genesis.snapshotSha256, snapshot(3))); await expect(changedSnapshot).rejects.toMatchObject({ code: "CONFLICT" }); await port.close();
  });

  it("rejects hostile capture before filesystem work and preserves an owned request after mutation", async () => {
    const root = await fixture(); const filesystem = new TransactionalPersistenceFilesystemForTestOnly(root); let loads = 0;
    const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: async () => { loads += 1; return filesystem.loadLatest(); }, publish: (image) => filesystem.publish(image) }));
    const genesis = await port.recover(); loads = 0;
    const valid = input(id(230), 0, genesis.snapshotSha256, snapshot(2));
    await expect(port.commit(new Proxy(valid, {}))).rejects.toMatchObject({ code: "INVALID" });
    const nestedSource = input(id(231), 0, genesis.snapshotSha256, snapshot(2)); const nested = { ...nestedSource, snapshot: { ...nestedSource.snapshot, journal: new Proxy(nestedSource.snapshot.journal, {}) } };
    await expect(port.commit(nested)).rejects.toMatchObject({ code: "INVALID" });
    const accessor = input(id(232), 0, genesis.snapshotSha256, snapshot(2)); Object.defineProperty(accessor, "snapshot", { get: () => accessor.snapshot, enumerable: true });
    await expect(port.commit(accessor)).rejects.toMatchObject({ code: "INVALID" });
    const viewSource = input(id(233), 0, genesis.snapshotSha256, snapshot(2)); const source = viewSource.snapshot.ciphertextBlobs[0]!.bytes; const view = { ...viewSource, snapshot: { ...viewSource.snapshot, ciphertextBlobs: [{ ...viewSource.snapshot.ciphertextBlobs[0]!, bytes: source.subarray(1) }, ...viewSource.snapshot.ciphertextBlobs.slice(1)] } };
    await expect(port.commit(view)).rejects.toMatchObject({ code: "INVALID" });
    const sparse = { ...valid, snapshot: { ...valid.snapshot, refIndex: new Array(1) } }; const extra: unknown[] = []; Object.defineProperty(extra, "extra", { value: 1, enumerable: true }); const extraArray = { ...valid, snapshot: { ...valid.snapshot, refIndex: extra } };
    const shared = { ...valid, snapshot: { ...valid.snapshot, ciphertextBlobs: [{ ...valid.snapshot.ciphertextBlobs[0]!, bytes: new Uint8Array(new SharedArrayBuffer(4)) }, ...valid.snapshot.ciphertextBlobs.slice(1)] } }; const cyclic: Record<string, unknown> = { ...valid }; cyclic.loop = cyclic;
    const oversized = { ...valid, snapshot: { ...valid.snapshot, refIndex: Array.from({ length: 4097 }, () => null) } }; const fields = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x${index}`, index])); const overFields = { ...valid, snapshot: { ...valid.snapshot, journal: fields } };
    for (const hostile of [sparse, extraArray, shared, cyclic, oversized, overFields]) await expect(port.commit(hostile)).rejects.toMatchObject({ code: "INVALID" }); expect(loads).toBe(0);
    const pending = port.commit(valid); (valid as { expectedGeneration: number }).expectedGeneration = 99; valid.snapshot.ciphertextBlobs[0]!.bytes.fill(0); await expect(pending).resolves.toMatchObject({ generation: 1 }); await port.close();
  });

  it("wipes every descriptor-captured ciphertext copy after a later nested rejection", () => {
    const clean = input(id(240), 0, "0".repeat(64), snapshot(1));
    const hostile = { ...clean, snapshot: { schemaVersion: 1, ciphertextBlobs: clean.snapshot.ciphertextBlobs, refIndex: new Proxy([], {}), issuedClaims: clean.snapshot.issuedClaims, journal: clean.snapshot.journal } };
    expect(inspectAsyncFilesystemCaptureCleanupForTestOnly(hostile)).toMatchObject({ accepted: false, capturedCopies: 1, allCapturedCopiesZeroed: true });
  });

  it("bounds descriptor reads without bulk descriptor/key snapshots and preserves hidden-field semantics", async () => {
    const huge = new Array(4097); expect(inspectAsyncFilesystemCaptureCleanupForTestOnly(huge)).toMatchObject({ accepted: false, capturedCopies: 0, descriptorReads: 1 });
    const many = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`field${index}`, index])); const manyResult = inspectAsyncFilesystemCaptureCleanupForTestOnly(many); expect(manyResult.accepted).toBe(false); expect(manyResult.descriptorReads).toBeLessThanOrEqual(65);
    const root = await fixture(); const filesystem = new TransactionalPersistenceFilesystemForTestOnly(root); let loads = 0; const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: async () => { loads += 1; return filesystem.loadLatest(); }, publish: (image) => filesystem.publish(image) })); const genesis = await port.recover(); loads = 0;
    const hiddenRequired = { ...input(id(280), 0, genesis.snapshotSha256, snapshot(1)) }; Object.defineProperty(hiddenRequired, "commitId", { value: id(280), enumerable: false }); await expect(port.commit(hiddenRequired)).rejects.toMatchObject({ code: "INVALID" });
    const hiddenExtra = { ...input(id(281), 0, genesis.snapshotSha256, snapshot(1)) }; Object.defineProperty(hiddenExtra, "hidden", { value: "inert", enumerable: false }); expect(inspectAsyncFilesystemCaptureCleanupForTestOnly(hiddenExtra).accepted).toBe(true);
    const symbolExtra = { ...input(id(282), 0, genesis.snapshotSha256, snapshot(1)), [Symbol("inert")]: true }; expect(inspectAsyncFilesystemCaptureCleanupForTestOnly(symbolExtra).accepted).toBe(true);
    const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, "x", { get: () => 1, enumerable: true }); expect(inspectAsyncFilesystemCaptureCleanupForTestOnly(accessor)).toMatchObject({ accepted: false, descriptorReads: 1 }); expect(loads).toBe(0); await port.close();
  });

  it("shares alias-handle genesis identity, resolves one divergent winner, and never rebases stale work", async () => {
    const root = await fixture(); const alias = await openTrustedAppOwnedGenerationRootForTestOnly(root.path); roots.push({ path: root.path, root: alias });
    const [left, right] = await Promise.all([AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root), AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(alias)]);
    expect(left.concurrencyIdentity).toBe(right.concurrencyIdentity); const genesis = await left.recover(); expect(genesis.generation).toBe(0);
    const outcomes = await Promise.allSettled([left.commit(input(id(250), 0, genesis.snapshotSha256, snapshot(2))), right.commit(input(id(251), 0, genesis.snapshotSha256, snapshot(3)))]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((item) => item.status === "rejected")[0]).toMatchObject({ reason: { code: "CONFLICT" } });
    const one = await left.recover(); expect(one.generation).toBe(1); await expect(right.commit(input(id(252), 0, genesis.snapshotSha256, snapshot(4)))).rejects.toMatchObject({ code: "CONFLICT" }); const afterStale = await left.recover(); expect(afterStale).toMatchObject({ generation: one.generation, snapshotSha256: one.snapshotSha256 }); expect(await left.recoverOperationBinding(id(252)).then((value) => value)).toBeUndefined();
    await left.close(); await right.close();
  });

  it("creates encrypted genesis, exposes its frozen marker, and restarts through the same out-of-band key", async () => {
    const root = await fixture();
    const first = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.openWholeMediumAeadForTestOnly(root, mediumProvider, mediumReference); const protectedCapability = captureWholeMediumAeadProtectedPortCapabilityForTestOnly(first); expect([first.protectionMarker, Object.isFrozen(first.protectionMarker), protectedCapability]).toEqual([expect.objectContaining({ kind: "whole-medium-aead-v1", algorithm: "aes-256-gcm" }), true, expect.objectContaining({ spaceId: SPACE, rootBindingSha256: root.rootBindingSha256 })]);
    const initial = await protectedCapability!.recover(); await protectedCapability!.commit(input(id(290), initial.generation, initial.snapshotSha256, snapshot(2))); await protectedCapability!.close();
    const restarted = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.openWholeMediumAeadForTestOnly(root, mediumProvider, mediumReference); expect((await restarted.recover()).generation).toBe(1); await restarted.close();
  });

  it("rejects protected-marker forgery before an unbranded adapter can do work", async () => {
    const root = await fixture(); const protectedMarker = Object.freeze({ kind: "whole-medium-aead-v1", version: 1, algorithm: "aes-256-gcm", keyReferenceSha256: "a".repeat(64), rootBindingSha256: root.rootBindingSha256 });
    for (const marker of [protectedMarker, { ...protectedMarker, rootBindingSha256: "b".repeat(64) }, new Proxy(protectedMarker, {})]) {
      let calls = 0;
      await expect(AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ protectionMarker: marker, async loadLatest() { calls += 1; return undefined; }, async publish() { calls += 1; return { generation: 0, imageSha256: "a".repeat(64) }; } }))).rejects.toMatchObject({ code: "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED" }); expect(calls).toBe(0);
    }
    let calls = 0; const accessor = { async loadLatest() { calls += 1; return undefined; }, async publish() { calls += 1; return { generation: 0, imageSha256: "a".repeat(64) }; } };
    Object.defineProperty(accessor, "protectionMarker", { enumerable: true, get() { throw new Error("must not read"); } });
    await expect(AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => accessor)).rejects.toMatchObject({ code: "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED" }); expect(calls).toBe(0);
  });

  it("captures only the post-authentication protected capability and never reads a forgery", async () => {
    const root = await fixture(); let read = 0; const getter = { get protectionMarker() { read += 1; throw new Error("must not read"); } };
    for (const candidate of [getter, Object.create(getter), new Proxy(getter, {}), Object.create(null), { concurrencyIdentity: {}, recover() { throw new Error("bad"); } }]) expect(captureWholeMediumAeadProtectedPortCapabilityForTestOnly(candidate)).toBeUndefined();
    expect(read).toBe(0);
    const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.openWholeMediumAeadForTestOnly(root, mediumProvider, mediumReference); const captured = captureWholeMediumAeadProtectedPortCapabilityForTestOnly(port); if (captured === undefined) throw new Error("missing captured capability");
    for (const candidate of [Object.create(port), new Proxy(port, {}), { ...port }, { wrapped: port }]) expect(captureWholeMediumAeadProtectedPortCapabilityForTestOnly(candidate)).toBeUndefined();
    Object.defineProperty(port, "recover", { configurable: true, value: async () => { throw new Error("shadowed public method"); } });
    let attackerCalls = 0; const attacker = async () => { attackerCalls += 1; throw new Error("must not run"); };
    for (const [name, value] of [
      ["filesystem", { loadLatest: attacker, publish: attacker }], ["shared", { lane: Promise.resolve(), references: 0, identity: Object.freeze({}) }], ["laneKey", "attacker"], ["lifecycle", "open"], ["closePromise", Promise.resolve()], ["concurrencyIdentity", Object.freeze({})], ["protectionMarker", Object.freeze({ kind: "plaintext-test-only" })], ["enqueueOperation", attacker], ["enqueueRaw", attacker], ["commitOwned", attacker], ["verifyReceipt", attacker], ["reconcile", attacker],
    ] as const) Object.defineProperty(port, name, { configurable: true, value });
    const zero = await captured.recover(); const receipt = await captured.commit(input(id(293), zero.generation, zero.snapshotSha256, snapshot(1)));
    expect([attackerCalls, receipt.generation, (await captured.recover()).generation, await captured.recoverOperationBinding(id(293))]).toEqual([0, 1, 1, expect.objectContaining({ commitId: id(293) })]); await captured.close();
  });

  it("rejects pre-open static, port, and filesystem replacement before an exact-marker fake can be branded", async () => {
    const root = await fixture(); let attackerCalls = 0;
    const exactMarkerFake = Object.freeze({
      concurrencyIdentity: Object.freeze({}),
      protectionMarker: Object.freeze({ kind: "whole-medium-aead-v1" as const, version: 1 as const, algorithm: "aes-256-gcm" as const, keyReferenceSha256: "a".repeat(64), rootBindingSha256: root.rootBindingSha256 }),
      async commit() { attackerCalls += 1; throw new Error("attacker"); },
      async recover() { attackerCalls += 1; throw new Error("attacker"); },
      async recoverOperationBinding() { attackerCalls += 1; throw new Error("attacker"); },
      async close() { attackerCalls += 1; throw new Error("attacker"); },
    });
    const attacker = () => { attackerCalls += 1; return exactMarkerFake; };
    for (const replacement of [
      () => Object.defineProperty(AsyncTransactionalPersistenceFilesystemPortForTestOnly, "openInternal", { value: attacker }),
      () => Object.defineProperty(AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype, "commit", { value: attacker }),
      () => Object.defineProperty(AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype, "recover", { value: attacker }),
      () => Object.defineProperty(AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype, "recoverOperationBinding", { value: attacker }),
      () => Object.defineProperty(AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype, "close", { value: attacker }),
      () => Object.defineProperty(TransactionalPersistenceFilesystemForTestOnly.prototype, "loadLatest", { value: attacker }),
      () => Object.defineProperty(TransactionalPersistenceFilesystemForTestOnly.prototype, "publish", { value: attacker }),
    ]) expect(replacement).toThrow(TypeError);
    expect(captureWholeMediumAeadProtectedPortCapabilityForTestOnly(exactMarkerFake)).toBeUndefined();
    const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.openWholeMediumAeadForTestOnly(root, mediumProvider, mediumReference);
    const captured = captureWholeMediumAeadProtectedPortCapabilityForTestOnly(port); expect([attackerCalls, captured?.spaceId]).toEqual([0, SPACE]);
    await captured!.close();
  });

  it("contains only bounded module-owned protected publication faults and adopts a lost acknowledgement", async () => {
    const root = await fixture(); const opened = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.openWholeMediumAeadWithPublicationFaultsForTestOnly(root, mediumProvider, mediumReference); const captured = captureWholeMediumAeadProtectedPortCapabilityForTestOnly(opened.port); if (captured === undefined) throw new Error("missing protected capability");
    const zero = await captured.recover(); opened.controller.failBeforePublishForTestOnly(1); await expect(captured.commit(input(id(291), zero.generation, zero.snapshotSha256, snapshot(1)))).rejects.toMatchObject({ code: "INTERRUPTED" });
    const one = await captured.commit(input(id(291), zero.generation, zero.snapshotSha256, snapshot(1))); opened.controller.failAfterRealPublishAcknowledgementForTestOnly(1); await expect(captured.commit(input(id(292), one.generation, one.snapshotSha256, snapshot(2)))).resolves.toMatchObject({ generation: 2 });
    expect(() => opened.controller.failBeforePublishForTestOnly(9)).toThrow(); await captured.close();
  });

  it("finishes an accepted operation before idempotent concurrent close and rejects later calls", async () => {
    const root = await fixture(); const filesystem = new TransactionalPersistenceFilesystemForTestOnly(root); let release: (() => void) = () => undefined; let entered: (() => void) = () => undefined; let held = false; const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
    const port = await AsyncTransactionalPersistenceFilesystemPortForTestOnly.open(root, () => ({ loadLatest: async () => { if (held) { entered(); await new Promise<void>((resolve) => { release = resolve; }); } return filesystem.loadLatest(); }, publish: (image) => filesystem.publish(image) }));
    held = true; const pending = port.recover(); await enteredBarrier; const firstClose = port.close(); const secondClose = port.close(); expect(firstClose).toBe(secondClose); release(); await expect(pending).resolves.toMatchObject({ generation: 0 }); await firstClose; await expect(port.recover()).rejects.toMatchObject({ code: "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED" });
  });
});
