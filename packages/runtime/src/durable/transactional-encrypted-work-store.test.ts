import { describe, expect, it } from "vitest";
import { EncryptedWorkStoreError, type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryTransactionalPersistenceMedium, TransactionalPersistenceError } from "./transactional-persistence.js";
import { TransactionalEncryptedWorkStore, TransactionalEncryptedWorkStoreError } from "./transactional-encrypted-work-store.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const key = new Uint8Array(32).fill(7);
const provider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { await callback(new Uint8Array(key)); } };
const put = (operationId = id(50), overrides: Record<string, unknown> = {}) => ({ operationId, spaceId: id(1), keyId: id(2), id: id(3), entityKind: "artifact" as const, recordRevision: 1, idempotency: { kind: "entity" as const }, kind: "payload" as const, plaintext: new Uint8Array(Buffer.from("one")), ...overrides });
const expectFailure = async (call: () => Promise<unknown>) => expect(call()).rejects.toBeInstanceOf(TransactionalEncryptedWorkStoreError);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

describe("private transactional encrypted work store", () => {
  it("puts, reads, and restarts from the recovered transactional image", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const first = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(99));
    const record = await first.put(put()); expect(record.envelope.ciphertextRef).toBe(id(99));
    expect(Buffer.from(await first.read({ spaceId: id(1), keyId: id(2), id: id(3), recordRevision: 1 })).toString()).toBe("one");
    const restarted = new TransactionalEncryptedWorkStore(InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(medium.exportImageForTestOnly()).openPortForTestOnly(), provider, () => id(100));
    expect(Buffer.from(await restarted.read({ spaceId: id(1), keyId: id(2), id: id(3), recordRevision: 1 })).toString()).toBe("one");
  });

  it("accepts private capability journal kinds only as generic entities", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let ref = 120; const store = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(ref++));
    const kinds = ["capability-grant", "capability-grant-receipt", "capability-grant-index"] as const;
    for (let offset = 0; offset < kinds.length; offset += 1) {
      const entityKind = kinds[offset]!;
      await expect(store.put(put(id(60 + offset), { id: id(70 + offset), entityKind, idempotency: { kind: "entity" } }))).resolves.toMatchObject({ envelope: { entityKind } });
      await expectFailure(() => store.put(put(id(80 + offset), { id: id(90 + offset), entityKind, idempotency: { kind: "receipt", runId: id(1) } })));
    }
  });

  it("retries one interrupted pre-publish request without repeating encryption", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 99; const store = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(refs++));
    medium.setFaultForTestOnly("before-publish"); await expect(store.put(put(id(51)))).resolves.toMatchObject({ id: id(3) });
    expect(refs).toBe(100); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
  });

  it("retries every pre-publish interruption with one staged envelope", async () => {
    for (const point of ["before-publish", "after-staging-bytes", "after-staging-metadata"] as const) {
      const medium = new InMemoryTransactionalPersistenceMedium(); let calls = 0; let refs = 70;
      const counting: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { calls += 1; await callback(new Uint8Array(key)); } };
      medium.setFaultForTestOnly(point); await new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), counting, () => id(refs++)).put(put(id(70)));
      expect(calls).toBe(2); expect(refs).toBe(71); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
    }
  });

  it("adopts a post-publish lost acknowledgement without generating a second envelope", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 80;
    medium.setFaultForTestOnly("after-publish-before-ack"); const first = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(refs++));
    const record = await first.put(put(id(71))); const persisted = medium.openPortForTestOnly().recover().snapshot.ciphertextBlobs[0];
    expect(record.envelope.ciphertextRef).toBe(id(80)); expect(refs).toBe(81); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
    const restarted = new TransactionalEncryptedWorkStore(InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(medium.exportImageForTestOnly()).openPortForTestOnly(), provider, () => id(refs++));
    const adopted = await restarted.put(put(id(71))); expect(adopted.envelope).toEqual(record.envelope); expect(refs).toBe(81); expect(persisted?.bytes.byteLength).toBeGreaterThan(0);
  });

  it("uses operationId as exact adoption authority and snapshots queued input", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const left = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(110));
    const right = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(111));
    const request = put(id(60)); const accepted = await left.put(request); request.plaintext[0] = 0;
    expect((await right.put(put(id(60)))).envelope.ciphertextRef).toBe(accepted.envelope.ciphertextRef);
    await expectFailure(() => right.put(put(id(60), { id: id(4) })));
  });

  it("rejects a different operation from adopting an already committed exact record", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const store = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(115));
    await store.put(put(id(62))); await expectFailure(() => store.put(put(id(63)))); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
  });

  it("rejects hostile persisted operation-binding projections on exact replay", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const original = new TransactionalEncryptedWorkStore(port, provider, () => id(116));
    await original.put(put(id(64)));
    for (const projection of [
      { commitId: id(64), operationBindingSha256: "0".repeat(64) },
      { commitId: id(64), operationBindingSha256: "0".repeat(64), extra: true },
      Object.defineProperty({ commitId: id(64), operationBindingSha256: "0".repeat(64) }, "operationBindingSha256", { enumerable: true, get: () => "0".repeat(64) }),
      new Proxy({ commitId: id(64), operationBindingSha256: "0".repeat(64) }, { getPrototypeOf: () => { throw new Error("hostile"); } })
    ]) {
      const wrapped = { concurrencyIdentity: port.concurrencyIdentity, commit: port.commit.bind(port), recover: port.recover.bind(port), recoverOperationBinding: () => projection };
      await expectFailure(() => new TransactionalEncryptedWorkStore(wrapped as never, provider).put(put(id(64))));
    }
    expect(port.recover().generation).toBe(1);
  });

  it("does not publish or enter the provider boundary for malformed owned input", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let calls = 0;
    const counting: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { calls += 1; await callback(new Uint8Array(key)); } };
    const store = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), counting, () => id(120));
    await expectFailure(() => store.put({ ...put(id(61)), plaintext: new Uint8Array(new SharedArrayBuffer(1)) }));
    expect(calls).toBe(0); expect(medium.openPortForTestOnly().recover().generation).toBe(0);
  });

  it("globally serializes different records", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const gate = deferred<void>(); const begun = deferred<void>(); let calls = 0;
    const delayed: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { calls += 1; await callback(new Uint8Array(key)); if (calls === 1) { begun.resolve(); await gate.promise; } } };
    const left = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(130)); const right = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(131));
    const one = left.put(put(id(80))); await begun.promise; const two = right.put(put(id(81), { id: id(8) })); await Promise.resolve(); expect(calls).toBe(1); gate.resolve(); await Promise.all([one, two]);
    expect(medium.openPortForTestOnly().recover().generation).toBe(2);
  });

  it("does not rebase a CAS conflict", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); let refs = 140;
    const port = medium.openPortForTestOnly(); const conflicting = { concurrencyIdentity: port.concurrencyIdentity, recover: () => port.recover(), commit: () => { throw new TransactionalPersistenceError("CONFLICT"); } };
    await expectFailure(() => new TransactionalEncryptedWorkStore(conflicting as never, provider, () => id(refs++)).put(put(id(90))));
    expect(refs).toBe(141); expect(port.recover().generation).toBe(0);
  });

  it("serializes concurrent exact and conflicting same-record writes", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const gate = deferred<void>(); const started = deferred<void>(); let calls = 0;
    const delayed: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { const call = ++calls; await callback(new Uint8Array(key)); if (call === 1) { started.resolve(); await gate.promise; } } };
    const one = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(150)); const two = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(151));
    const first = one.put(put(id(100))); await started.promise; const exact = two.put(put(id(100))); const conflict = two.put(put(id(102), { plaintext: new Uint8Array(Buffer.from("two")) })); const conflictObserved = expectFailure(() => conflict); gate.resolve();
    await Promise.all([first, exact, conflictObserved]); expect(medium.openPortForTestOnly().recover().generation).toBe(1);
  });

  it("rejects operationId reuse for a different absent record after reconstruction", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); await new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), provider, () => id(160)).put(put(id(110)));
    const restarted = new TransactionalEncryptedWorkStore(InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(medium.exportImageForTestOnly()).openPortForTestOnly(), provider, () => id(161));
    await expectFailure(() => restarted.put(put(id(110), { id: id(9) }))); expect(restarted["port"].recover().generation).toBe(1);
  });

  it("rejects corrupted recovery and hostile input before entering the provider", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const real = medium.openPortForTestOnly(); let calls = 0;
    const counting: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { calls += 1; await callback(new Uint8Array(key)); } };
    const corrupt = { concurrencyIdentity: real.concurrencyIdentity, commit: real.commit.bind(real), recover: () => ({ ...real.recover(), snapshot: {} }) };
    await expectFailure(() => new TransactionalEncryptedWorkStore(corrupt as never, counting).put(put(id(120)))); expect(calls).toBe(0);
    const store = new TransactionalEncryptedWorkStore(real, counting); const accessor = put(id(121)); Object.defineProperty(accessor, "id", { enumerable: true, get: () => id(3) });
    for (const bad of [accessor, new Proxy(put(id(122)), { getPrototypeOf: () => { throw new Error("hostile"); } }), { ...put(id(123)), plaintext: new Uint8Array(new SharedArrayBuffer(1)) }, { ...put(id(124)), plaintext: new Uint8Array(8 * 1024 * 1024 + 1) }]) await expectFailure(() => store.put(bad));
    expect(calls).toBe(0); expect(real.recover().generation).toBe(0);
  });

  it("fails closed for malformed receipt, fabricated recovered state, wrong keys, and ciphertext corruption", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const real = medium.openPortForTestOnly();
    const malformed = { concurrencyIdentity: real.concurrencyIdentity, recover: real.recover.bind(real), commit: () => ({ commitId: id(130), generation: 1 }) };
    await expectFailure(() => new TransactionalEncryptedWorkStore(malformed as never, provider, () => id(170)).put(put(id(130))));
    await new TransactionalEncryptedWorkStore(real, provider, () => id(171)).put(put(id(131)));
    await expectFailure(() => new TransactionalEncryptedWorkStore(real, { async withUnlockedKey(_r, cb) { await cb(new Uint8Array(32).fill(9)); } }).read({ spaceId: id(1), keyId: id(2), id: id(3), recordRevision: 1 }));
    const image = medium.exportImageForTestOnly(); const blob = image.state.snapshot.ciphertextBlobs[0]; if (blob === undefined) throw new Error("fixture");
    const fabricated = { concurrencyIdentity: {}, commit: real.commit.bind(real), recover: () => ({ ...real.recover(), snapshot: { ...real.recover().snapshot, ciphertextBlobs: [{ ...blob, bytes: new Uint8Array(blob.bytes.map((byte, index) => index === 0 ? byte ^ 1 : byte)) }] } }) };
    await expectFailure(() => new TransactionalEncryptedWorkStore(fabricated as never, provider).read({ spaceId: id(1), keyId: id(2), id: id(3), recordRevision: 1 }));
  });

  it("uses owned queued plaintext and releases a rejected provider queue entry", async () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const gate = deferred<void>(); const started = deferred<void>(); let calls = 0;
    const delayed: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { const call = ++calls; await callback(new Uint8Array(key)); if (call === 1) { started.resolve(); await gate.promise; } } };
    const first = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(180)); const second = new TransactionalEncryptedWorkStore(medium.openPortForTestOnly(), delayed, () => id(181));
    const blocking = first.put(put(id(140))); await started.promise; const queued = put(id(141), { id: id(10), plaintext: new Uint8Array(Buffer.from("before")) }); const later = second.put(queued); queued.plaintext.fill(0); gate.resolve(); await blocking; await later;
    expect(Buffer.from(await second.read({ spaceId: id(1), keyId: id(2), id: id(10), recordRevision: 1 })).toString()).toBe("before");
    const failedMedium = new InMemoryTransactionalPersistenceMedium(); let rejected = false; const flaky: WorkspaceKeyProvider = { async withUnlockedKey(_r, callback) { if (!rejected) { rejected = true; throw new Error("reject"); } await callback(new Uint8Array(key)); } };
    const fail = new TransactionalEncryptedWorkStore(failedMedium.openPortForTestOnly(), flaky, () => id(190)); const release = new TransactionalEncryptedWorkStore(failedMedium.openPortForTestOnly(), flaky, () => id(191));
    await expectFailure(() => fail.put(put(id(150)))); await expect(release.put(put(id(151)))).resolves.toMatchObject({ id: id(3) });
  });
});
