import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryTransactionalPersistenceMedium, TransactionalPersistenceError, operationBindingSha256ForDurableRecordSetForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly } from "./transactional-persistence.js";
import { InMemoryWorkStore } from "./in-memory-work-store.js";
import { TransactionalEncryptedWorkStore } from "./transactional-encrypted-work-store.js";
import { TransactionalEncryptedWorkSet, TransactionalEncryptedWorkSetError } from "./transactional-encrypted-work-set.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const provider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { await callback(new Uint8Array(32).fill(3)); } };
const write = (value: number, overrides: Record<string, unknown> = {}) => ({ id: id(value), entityKind: "artifact" as const, recordRevision: 1, idempotency: { kind: "entity" as const }, kind: "payload" as const, plaintext: new Uint8Array(Buffer.from(`value-${value}`)), ...overrides });
const input = (operationId = id(50), writes = [write(3), write(4)]) => ({ operationId, spaceId: id(1), keyId: id(2), writes });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function transcriptStore(): InMemoryWorkStore { let event = 91; const store = new InMemoryWorkStore(() => id(90), () => id(event++)); const add = (entityId: string, kind: "task" | "run", bytes: string) => store.putRecord({ ciphertext: new Uint8Array(Buffer.from(bytes)), record: { schemaVersion: 1, id: entityId, spaceId: id(1), recordRevision: 1, idempotency: kind === "task" ? { kind, idempotencyKeySha256: sha("task") } : { kind, taskId: id(10), attempt: 1 }, envelope: { envelopeVersion: 1, spaceId: id(1), keyId: id(2), entityId, entityKind: kind, schemaVersion: 1, contentRevision: 1, kind: "payload", contentSha256: sha(bytes), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: id(kind === "task" ? 92 : 93), ciphertextSha256: sha(bytes), tag: "AAAAAAAAAAAAAAAAAAAAAA" } } } as never); add(id(10), "task", "task"); add(id(11), "run", "run"); store.appendEvent({ schemaVersion: 1, id: id(94), spaceId: id(1), runId: id(11), runRevision: 1, sequence: 1, kind: "run-recorded", runCiphertextSha256: sha("run"), effectId: null, effectRevision: null, effectState: null, claimSha256: null }); const effect = store.putEffect({ schemaVersion: 1, id: id(95), spaceId: id(1), runId: id(11), runRevision: 1, stepKey: id(96), requestSha256: sha("effect"), state: "pending", effectRevision: 1, claimId: null }); store.claimEffect(id(1), effect.id, 1); return store; }
const chain = () => [
  write(10, { entityKind: "task", idempotency: { kind: "task", idempotencyKeySha256: "a".repeat(64) } }),
  write(11, { entityKind: "run", idempotency: { kind: "run", taskId: id(10), attempt: 1 } }),
  write(12, { entityKind: "artifact" }), write(13, { entityKind: "citation" }), write(14, { entityKind: "review" }),
  write(15, { entityKind: "receipt", idempotency: { kind: "receipt", runId: id(11) } })
];

describe("private transactional encrypted work set", () => {
  it("publishes an ordered all-absent batch atomically and replays it exactly", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 100; const store = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++));
    const records = await store.putAtomic(input()); expect(records.map((record) => record.id)).toEqual([id(3), id(4)]); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
    expect((await store.putAtomic(input())).map((record) => record.envelope.ciphertextRef)).toEqual(records.map((record) => record.envelope.ciphertextRef)); expect(refs).toBe(102);
  });
  it("accepts private capability journal kinds only with generic entity idempotency", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let ref = 130; const store = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(ref++));
    const kinds = ["capability-grant", "capability-grant-receipt", "capability-grant-index"] as const;
    await expect(store.putAtomic(input(id(130), kinds.map((entityKind, offset) => write(30 + offset, { entityKind, idempotency: { kind: "entity" } }))))).resolves.toHaveLength(3);
    await expect(store.putAtomic(input(id(131), [write(40, { entityKind: "capability-grant", idempotency: { kind: "task", idempotencyKeySha256: "a".repeat(64) } })]))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
  });
  it("rejects mixed, duplicate, malformed, and changed-operation batches before publication", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 120; const store = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++)); await store.putAtomic(input());
    for (const bad of [input(id(51), [write(3), write(5)]), input(id(52), [write(3), write(3)]), { ...input(id(53)), writes: [] }, input(id(50), [write(3), write(5)])]) await expect(store.putAtomic(bad as never)).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    expect(medium.openPortForTestOnly().recover().generation).toBe(1);
  });

  it("accepts ascending revisions of one entity and rejects descending revisions before provider", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 125; const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++));
    await expect(set.putAtomic(input(id(54), [write(6), write(6, { recordRevision: 2, plaintext: new Uint8Array(Buffer.from("revision-two")) })]))).resolves.toHaveLength(2); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
    const other = new InMemoryTransactionalPersistenceMedium(); let calls = 0; const counting: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { calls += 1; await callback(new Uint8Array(32)); } };
    await expect(new TransactionalEncryptedWorkSet(other.openPortForTestOnly(), counting).putAtomic(input(id(55), [write(7, { recordRevision: 2 }), write(7)]))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(calls).toBe(0);
  });

  it("publishes an ordered task-to-receipt set in one generation and replays after an unrelated D commit", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 200; const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++));
    const records = await set.putAtomic(input(id(60), chain())); expect(records.map((record) => record.id)).toEqual([id(10), id(11), id(12), id(13), id(14), id(15)]); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
    const recovered = InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(medium.exportImageForTestOnly()); const reader = new TransactionalEncryptedWorkStore(recovered.openPortForTestOnly(), provider, () => id(refs++));
    for (const value of [10, 11, 12, 13, 14, 15]) expect(Buffer.from(await reader.read({ spaceId: id(1), keyId: id(2), id: id(value), recordRevision: 1 })).toString()).toBe(`value-${value}`);
    await reader.put({ operationId: id(61), spaceId: id(1), keyId: id(2), id: id(16), entityKind: "artifact", recordRevision: 1, idempotency: { kind: "entity" }, kind: "payload", plaintext: new Uint8Array(Buffer.from("later")) });
    const replay = new TransactionalEncryptedWorkSet(recovered.openPortForTestOnly(), provider, () => id(refs++)); expect((await replay.putAtomic(input(id(60), chain()))).map((record) => record.id)).toEqual(records.map((record) => record.id)); expect(refs).toBe(207);
  });

  it("retries every fault point with one complete staged batch and no partial state", async () => {
    for (const point of ["before-publish", "after-staging-bytes", "after-staging-metadata", "after-publish-before-ack"] as const) {
      const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 250; medium.setFaultForTestOnly(point);
      await new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++)).putAtomic(input(id(70)));
      const recovered = medium.openPortForTestOnly().recover(); expect(recovered.generation).toBe(1); expect(recovered.snapshot.journal.records).toHaveLength(2); expect(refs).toBe(252);
    }
  });

  it("leaves exact pre-state on provider, ordering, and ref-collision staging failures", async () => {
    const failingMedium = new InMemoryTransactionalPersistenceMedium(); let calls = 0; const failing: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { calls += 1; if (calls === 2) throw new Error("provider"); await callback(new Uint8Array(32).fill(3)); } };
    await expect(new TransactionalEncryptedWorkSet(failingMedium.openPortForTestOnly(), failing, () => id(280)).putAtomic(input(id(80)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(failingMedium.openPortForTestOnly().recover().generation).toBe(0);
    const collisionMedium = new InMemoryTransactionalPersistenceMedium(); await expect(new TransactionalEncryptedWorkSet(collisionMedium.openPortForTestOnly(), provider, () => id(281)).putAtomic(input(id(81)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(collisionMedium.openPortForTestOnly().recover().generation).toBe(0);
    const badOrder = new InMemoryTransactionalPersistenceMedium(); await expect(new TransactionalEncryptedWorkSet(badOrder.openPortForTestOnly(), provider, () => id(282)).putAtomic(input(id(82), [chain()[1]!, chain()[0]!]))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(badOrder.openPortForTestOnly().recover().generation).toBe(0);
  });

  it("rejects replay reorder, subset, changed context, wrong operation, and reused absent IDs without provider entry", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let calls = 0; let refs = 290; const counting: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { calls += 1; await callback(new Uint8Array(32).fill(3)); } }; const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), counting, () => id(refs++));
    await set.putAtomic(input(id(90))); const before = calls;
    for (const bad of [input(id(90), [write(4), write(3)]), input(id(90), [write(3)]), input(id(90), [write(3), write(4), write(5)]), input(id(90), [write(3, { plaintext: new Uint8Array(Buffer.from("changed")) }), write(4)]), input(id(91)), input(id(90), [write(5), write(6)])]) await expect(set.putAtomic(bad as never)).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    expect(calls).toBe(before); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
  });

  it("rejects hostile bounded parser inputs before provider, refs, or commit", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let calls = 0; let refs = 300; const counting: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { calls += 1; await callback(new Uint8Array(32)); } }; const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), counting, () => id(refs++));
    const accessor = input(id(100)); Object.defineProperty(accessor, "writes", { enumerable: true, get: () => [write(3)] }); const sparse: unknown[] = []; sparse.length = 1;
    const custom = [write(3)]; Object.defineProperty(custom, Symbol.iterator, { value: () => { throw new Error("iterator"); } });
    const nested = write(3); Object.defineProperty(nested, "id", { enumerable: true, get: () => id(3) });
    const oversized = write(3, { plaintext: new Uint8Array(8 * 1024 * 1024 + 1) }); const aggregate = [write(3, { plaintext: new Uint8Array(4_500_000) }), write(4, { plaintext: new Uint8Array(4_500_000) })];
    for (const bad of [accessor, { ...input(id(101)), writes: sparse }, { ...input(id(102)), writes: custom }, { ...input(id(103)), writes: [nested] }, { ...input(id(104)), writes: new Array(17).fill(write(3)) }, input(id(105), [oversized]), input(id(106), aggregate), input(id(107), [write(3, { plaintext: new Uint8Array(new SharedArrayBuffer(1)) })])]) await expect(set.putAtomic(bad as never)).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    expect(calls).toBe(0); expect(refs).toBe(300); expect(medium.openPortForTestOnly().recover().generation).toBe(0);
  });

  it("binds ordered sets and rejects hostile arrays with fixed persistence failures", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 350; const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++)); const records = await set.putAtomic(input(id(110)));
    expect(operationBindingSha256ForDurableRecordSetForTestOnly(records)).not.toBe(operationBindingSha256ForDurableRecordSetForTestOnly([...records].reverse()));
    const sparse: unknown[] = []; sparse.length = 1; const accessor: unknown[] = [records[0]!]; Object.defineProperty(accessor, "0", { enumerable: true, get: () => records[0] });
    for (const bad of [[], new Array(17).fill(records[0]), sparse, accessor, new Proxy([records[0]!], { getPrototypeOf: () => { throw new Error("hostile"); } })]) {
      try { operationBindingSha256ForDurableRecordSetForTestOnly(bad); throw new Error("expected"); } catch (error) { expect(error).toBeInstanceOf(TransactionalPersistenceError); }
    }
    const returned = records[0]!; (returned.envelope as { keyId: string }).keyId = id(999); const replay = await set.putAtomic(input(id(110))); expect(replay[0]?.envelope.keyId).toBe(id(2));
  });

  it("fails closed for malformed commit receipts and hostile binding projections", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly();
    const malformed = { concurrencyIdentity: port.concurrencyIdentity, recover: port.recover.bind(port), recoverOperationBinding: port.recoverOperationBinding.bind(port), commit: () => ({ commitId: id(120), generation: 1 }) };
    await expect(new TransactionalEncryptedWorkSet(malformed as never, provider, () => id(370)).putAtomic(input(id(120)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    expect(port.recover().generation).toBe(0);
  });

  it("fails closed for malformed authority, wrong keys, hostile bindings, and stale CAS", async () => {
    const fakeReceipt = (value: unknown) => { const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); return { medium, wrapped: { concurrencyIdentity: port.concurrencyIdentity, recover: port.recover.bind(port), recoverOperationBinding: port.recoverOperationBinding.bind(port), commit: () => value } }; };
    for (const receipt of [{}, { commitId: id(130), generation: 1, snapshotSha256: "a".repeat(64), extra: true }, { commitId: id(131), generation: 1, snapshotSha256: "a".repeat(64) }, { commitId: id(130), generation: 2, snapshotSha256: "a".repeat(64) }, { commitId: id(130), generation: 1, snapshotSha256: "bad" }]) {
      const { medium, wrapped } = fakeReceipt(receipt); await expect(new TransactionalEncryptedWorkSet(wrapped as never, provider, () => id(380)).putAtomic(input(id(130)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(medium.openPortForTestOnly().recover().generation).toBe(0);
    }
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const forgedRecovery = { concurrencyIdentity: port.concurrencyIdentity, commit: port.commit.bind(port), recoverOperationBinding: port.recoverOperationBinding.bind(port), recover: () => ({ ...port.recover(), snapshotSha256: "b".repeat(64) }) };
    await expect(new TransactionalEncryptedWorkSet(forgedRecovery as never, provider).putAtomic(input(id(140)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    let refs = 390; const valid = new TransactionalEncryptedWorkSet(port, provider, () => id(refs++)); await valid.putAtomic(input(id(141)));
    const wrongKey: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { await callback(new Uint8Array(32).fill(9)); } }; await expect(new TransactionalEncryptedWorkSet(port, wrongKey).putAtomic(input(id(141)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    for (const binding of [{ commitId: id(141), operationBindingSha256: "0".repeat(64) }, { commitId: id(141), operationBindingSha256: "0".repeat(64), extra: true }, new Proxy({ commitId: id(141), operationBindingSha256: "0".repeat(64) }, { getPrototypeOf: () => { throw new Error("hostile"); } })]) { const wrapped = { concurrencyIdentity: port.concurrencyIdentity, recover: port.recover.bind(port), commit: port.commit.bind(port), recoverOperationBinding: () => binding }; await expect(new TransactionalEncryptedWorkSet(wrapped as never, provider).putAtomic(input(id(141)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); }
    const stale = { concurrencyIdentity: port.concurrencyIdentity, recover: port.recover.bind(port), recoverOperationBinding: port.recoverOperationBinding.bind(port), commit: () => { throw new TransactionalPersistenceError("CONFLICT"); } }; const before = port.recover().generation; await expect(new TransactionalEncryptedWorkSet(stale as never, provider, () => id(refs++)).putAtomic(input(id(142), [write(20), write(21)]))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(port.recover().generation).toBe(before);
  });

  it("serializes queued E batches, preserves captured plaintext, and releases provider failures", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const gate = deferred<void>(); const begun = deferred<void>(); let calls = 0; let active = 0; let max = 0;
    const delayed: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { active += 1; max = Math.max(max, active); const call = ++calls; await callback(new Uint8Array(32).fill(3)); if (call === 1) { begun.resolve(); await gate.promise; } active -= 1; } };
    let refs = 400; const first = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), delayed, () => id(refs++)); const second = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), delayed, () => id(refs++));
    const firstRun = first.putAtomic(input(id(150))); await begun.promise; const queued = input(id(151), [write(30), write(31)]); const secondRun = second.putAtomic(queued); queued.writes[0]?.plaintext.fill(0); queued.writes[1]?.plaintext.fill(0); await Promise.resolve(); expect(calls).toBe(1); gate.resolve(); await Promise.all([firstRun, secondRun]); expect(max).toBe(1); expect(medium.openPortForTestOnly().recover().generation).toBe(2);
    const reader = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed); expect(Buffer.from(await reader.read({ spaceId: id(1), keyId: id(2), id: id(30), recordRevision: 1 })).toString()).toBe("value-30");
    const failedMedium = new InMemoryTransactionalPersistenceMedium(); let reject = true; let releaseRefs = 430; const flaky: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { if (reject) { reject = false; throw new Error("reject"); } await callback(new Uint8Array(32).fill(3)); } }; const failure = new TransactionalEncryptedWorkSet(failedMedium.openPortForTestOnly(), flaky, () => id(releaseRefs++)); const released = new TransactionalEncryptedWorkSet(failedMedium.openPortForTestOnly(), flaky, () => id(releaseRefs++));
    await expect(failure.putAtomic(input(id(152)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); await expect(released.putAtomic(input(id(153)))).resolves.toHaveLength(2);
  });

  it("shares the same whole-operation queue with D", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const gate = deferred<void>(); const begun = deferred<void>(); let calls = 0; let active = 0; let max = 0; let refs = 440;
    const delayed: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { active += 1; max = Math.max(max, active); const call = ++calls; await callback(new Uint8Array(32).fill(3)); if (call === 1) { begun.resolve(); await gate.promise; } active -= 1; } };
    const d = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(refs++)); const e = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), delayed, () => id(refs++)); const dRun = d.put({ operationId: id(160), spaceId: id(1), keyId: id(2), id: id(40), entityKind: "artifact", recordRevision: 1, idempotency: { kind: "entity" }, kind: "payload", plaintext: new Uint8Array(Buffer.from("d")) }); await begun.promise; const eRun = e.putAtomic(input(id(161), [write(41), write(42)])); await Promise.resolve(); expect(calls).toBe(1); gate.resolve(); await Promise.all([dRun, eRun]); expect(max).toBe(1); expect(medium.openPortForTestOnly().recover().generation).toBe(2);
  });

  it("rejects remaining hostile nested and typed inputs plus corrupt recovery before provider", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); let calls = 0; const counting: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { calls += 1; await callback(new Uint8Array(32)); } }; const set = new TransactionalEncryptedWorkSet(port, counting, () => id(500));
    class Subclass extends Uint8Array {} const extra = { ...write(3), extra: true }; const missing = { id: id(3), entityKind: "artifact", recordRevision: 1, idempotency: { kind: "entity" }, kind: "payload" }; const proxiedWrite = new Proxy(write(3), { getPrototypeOf: () => { throw new Error("hostile"); } });
    for (const bad of [{ ...input(id(170)), writes: new Proxy([write(3)], { getPrototypeOf: () => { throw new Error("hostile"); } }) }, input(id(171), [proxiedWrite]), input(id(172), [extra]), input(id(173), [missing as never]), input(id(174), [write(3, { plaintext: new Proxy(new Uint8Array(1), {}) as never })]), input(id(175), [write(3, { plaintext: new Subclass(1) })])]) await expect(set.putAtomic(bad as never)).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    const corrupt = { concurrencyIdentity: port.concurrencyIdentity, commit: port.commit.bind(port), recoverOperationBinding: port.recoverOperationBinding.bind(port), recover: () => ({ ...port.recover(), snapshot: { ...port.recover().snapshot, ciphertextBlobs: [{ ...port.recover().snapshot.ciphertextBlobs[0], bytes: new Uint8Array([1]) }] } }) };
    await expect(new TransactionalEncryptedWorkSet(corrupt as never, counting).putAtomic(input(id(177)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(calls).toBe(0); expect(port.recover().generation).toBe(0);
  });

  it("preserves a nonempty recovered event/effect/claim transcript inertly across an E commit", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover(); const snapshot = snapshotFromInMemoryWorkStoreForTestOnly(transcriptStore()); port.commit({ commitId: id(180), expectedGeneration: empty.generation, expectedSnapshotSha256: empty.snapshotSha256, operationBindingSha256: sha("seed"), snapshot });
    const before = port.recover().snapshot; const transcript = JSON.stringify({ events: before.journal.events, effects: before.journal.effects, claims: before.issuedClaims }); let refs = 510; await new TransactionalEncryptedWorkSet(port, provider, () => id(refs++)).putAtomic(input(id(181), [write(50), write(51)])); const after = port.recover().snapshot;
    expect(JSON.stringify({ events: after.journal.events, effects: after.journal.effects, claims: after.issuedClaims })).toBe(transcript); expect(after.journal.records.length).toBe(before.journal.records.length + 2);
  });

  it("rejects a fabricated locally-invalid postcommit recovery after a plausible receipt", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); let recovered = 0; let refs = 520; const wrapped = { concurrencyIdentity: port.concurrencyIdentity, recoverOperationBinding: port.recoverOperationBinding.bind(port), commit: port.commit.bind(port), recover: () => { const state = port.recover(); recovered += 1; return recovered === 1 ? state : { ...state, snapshotSha256: "f".repeat(64) }; } };
    await expect(new TransactionalEncryptedWorkSet(wrapped as never, provider, () => id(refs++)).putAtomic(input(id(190)))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError); expect(port.recover().generation).toBe(1);
  });

  it("captures transparent proxy descriptor values without consulting ordinary get traps", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 600;
    const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), provider, () => id(refs++));
    const trapped = <T extends object>(value: T): T => new Proxy(value, { get() { throw new Error("ordinary get must not run"); } });
    const outer = trapped(input(id(191), [write(60)]));
    await expect(set.putAtomic(outer)).resolves.toHaveLength(1);
    const nested = input(id(192), [trapped(write(61))]);
    await expect(set.putAtomic(nested)).resolves.toHaveLength(1);
    const idempotency = trapped({ kind: "entity" as const });
    const idempotent = input(id(193), [write(62, { idempotency })]);
    await expect(set.putAtomic(idempotent)).resolves.toHaveLength(1);
    expect(medium.openPortForTestOnly().recover().generation).toBe(3);
  });

  it("captures binding and commit receipt descriptors without ordinary property reads", async () => {
    const trapped = <T extends object>(value: T): T => new Proxy(value, {
      get() { throw new Error("ordinary get must not run"); }
    });

    const receiptMedium = new InMemoryTransactionalPersistenceMedium();
    const receiptPort = receiptMedium.openPortForTestOnly();
    const receiptWrapped = {
      concurrencyIdentity: receiptPort.concurrencyIdentity,
      recover: receiptPort.recover.bind(receiptPort),
      recoverOperationBinding: receiptPort.recoverOperationBinding.bind(receiptPort),
      commit: (request: Parameters<typeof receiptPort.commit>[0]) => trapped(receiptPort.commit(request))
    };
    await expect(new TransactionalEncryptedWorkSet(receiptWrapped, provider, () => id(610)).putAtomic(
      input(id(194), [write(63)])
    )).resolves.toHaveLength(1);
    expect(receiptMedium.openPortForTestOnly().recover().generation).toBe(1);

    const bindingPort = receiptMedium.openPortForTestOnly();
    const bindingWrapped = {
      concurrencyIdentity: bindingPort.concurrencyIdentity,
      recover: bindingPort.recover.bind(bindingPort),
      commit: bindingPort.commit.bind(bindingPort),
      recoverOperationBinding: (commitId: string) => {
        const binding = bindingPort.recoverOperationBinding(commitId);
        return binding === undefined ? undefined : trapped(binding);
      }
    };
    await expect(new TransactionalEncryptedWorkSet(bindingWrapped, provider).putAtomic(
      input(id(194), [write(63)])
    )).resolves.toHaveLength(1);
    expect(receiptMedium.openPortForTestOnly().recover().generation).toBe(1);
  });

  it("preserves a __proto__ own field so strict idempotency parsing rejects it before work", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium();
    let providerCalls = 0; let refs = 620;
    const counting: WorkspaceKeyProvider = {
      async withUnlockedKey(_ref, callback) {
        providerCalls += 1;
        await callback(new Uint8Array(32).fill(3));
      }
    };
    const idempotency = { kind: "entity" } as Record<string, unknown>;
    Object.defineProperty(idempotency, "__proto__", {
      value: { polluted: true }, enumerable: true, writable: true, configurable: true
    });
    const set = new TransactionalEncryptedWorkSet(medium.openPortForTestOnly(), counting, () => id(refs++));
    await expect(set.putAtomic(input(id(195), [write(64, { idempotency })]))).rejects.toBeInstanceOf(TransactionalEncryptedWorkSetError);
    expect(providerCalls).toBe(0); expect(refs).toBe(620);
    expect(medium.openPortForTestOnly().recover().generation).toBe(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
