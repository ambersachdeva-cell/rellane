import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryWorkStore } from "./in-memory-work-store.js";
import {
  EncryptedWorkStore,
  EncryptedWorkStoreError,
  type EncryptedWorkStorePutInput,
  type WorkspaceKeyProvider
} from "./encrypted-work-store.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const IDS = { space: id(1), otherSpace: id(2), key: id(3), otherKey: id(4), task: id(5), run: id(6), entity: id(7), ref: id(100) } as const;
const KEY = new Uint8Array(32).fill(0x51);
const OTHER_KEY = new Uint8Array(32).fill(0x52);

function provider(key = KEY): WorkspaceKeyProvider {
  return { async withUnlockedKey(reference, callback) { expect(Object.keys(reference)).toEqual(["spaceId", "keyId"]); await callback(new Uint8Array(key)); } };
}
function input(overrides: Partial<EncryptedWorkStorePutInput> = {}): EncryptedWorkStorePutInput {
  return { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, entityKind: "artifact", recordRevision: 1,
    idempotency: { kind: "entity" }, kind: "payload", plaintext: new Uint8Array(Buffer.from("sealed content")), ...overrides };
}
function store(keyProvider: WorkspaceKeyProvider = provider(), refs: () => string = (() => IDS.ref)): EncryptedWorkStore {
  return new EncryptedWorkStore(new InMemoryWorkStore(), keyProvider, refs);
}
async function expectFailure(action: () => Promise<unknown>): Promise<void> {
  await expect(action()).rejects.toMatchObject({ name: "EncryptedWorkStoreError", code: "ENCRYPTED_WORK_STORE_FAILED", message: "Encrypted work store operation failed." });
}

describe("private encrypted work-store facade", () => {
  it("round trips payloads, blobs, empty bytes, and returns only owned plaintext", async () => {
    let serial = 100;
    const facade = store(provider(), () => id(serial++));
    const payload = input(); const blob = input({ id: id(8), entityKind: "artifact", kind: "blob", plaintext: new Uint8Array(Buffer.from("blob")) });
    const empty = input({ id: id(9), entityKind: "source-snapshot", kind: "blob", plaintext: new Uint8Array() });
    const payloadRecord = await facade.put(payload); const blobRecord = await facade.put(blob); await facade.put(empty);
    payload.plaintext[0] = 0; blob.plaintext[0] = 0;
    const first = await facade.read({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 });
    first[0] = 0;
    expect(Buffer.from(await facade.read({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 })).toString()).toBe("sealed content");
    expect(Buffer.from(await facade.read({ spaceId: IDS.space, keyId: IDS.key, id: blobRecord.id, recordRevision: 1 })).toString()).toBe("blob");
    expect((await facade.read({ spaceId: IDS.space, keyId: IDS.key, id: empty.id, recordRevision: 1 })).byteLength).toBe(0);
    expect(payloadRecord.envelope.kind).toBe("payload"); expect(blobRecord.envelope.kind).toBe("blob");
  });

  it("round trips private capability journal entity kinds only with entity idempotency", async () => {
    let ref = 120; const facade = store(provider(), () => id(ref++));
    const kinds = ["capability-grant", "capability-grant-receipt", "capability-grant-index"] as const;
    for (let offset = 0; offset < kinds.length; offset += 1) {
      const entityKind = kinds[offset]!;
      const record = await facade.put(input({ id: id(30 + offset), entityKind, idempotency: { kind: "entity" } }));
      expect(Buffer.from(await facade.read({ spaceId: IDS.space, keyId: IDS.key, id: record.id, recordRevision: 1 })).toString()).toBe("sealed content");
      await expectFailure(() => facade.put(input({ id: id(40 + offset), entityKind, idempotency: { kind: "task", idempotencyKeySha256: "a".repeat(64) } })));
    }
  });

  it("makes exact current and historical retries idempotent without minting a ref, and rejects conflicts", async () => {
    const journal = new InMemoryWorkStore(); let generated = 100;
    const facade = new EncryptedWorkStore(journal, provider(), () => id(generated++));
    const first = input({ id: IDS.entity, recordRevision: 1 }); const written = await facade.put(first);
    expect((await facade.put(input({ id: IDS.entity, recordRevision: 1 }))).envelope.ciphertextRef).toBe(written.envelope.ciphertextRef);
    expect(generated).toBe(101);
    const second = await facade.put(input({ id: IDS.entity, recordRevision: 2, plaintext: new Uint8Array(Buffer.from("revision two")) }));
    expect((await facade.put(input({ id: IDS.entity, recordRevision: 1 }))).envelope.ciphertextRef).toBe(written.envelope.ciphertextRef);
    expect(generated).toBe(102);
    await expectFailure(() => facade.put(input({ id: IDS.entity, recordRevision: 1, plaintext: new Uint8Array(Buffer.from("conflict")) })));
    await expectFailure(() => facade.put(input({ id: IDS.entity, recordRevision: 2, kind: "blob" })));
    expect(second.envelope.ciphertextRef).toBe(id(101));
  });

  it("serializes same-entity concurrent puts across facades, but permits independent entity IDs and releases failures", async () => {
    const exactJournal = new InMemoryWorkStore(); const exactGate = deferred<void>(); const exactStarted = deferred<void>(); let exactCalls = 0;
    const exactProvider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { const call = ++exactCalls; await callback(new Uint8Array(KEY)); if (call === 1) { exactStarted.resolve(); await exactGate.promise; } } };
    const firstFacade = new EncryptedWorkStore(exactJournal, exactProvider, () => id(100));
    const secondFacade = new EncryptedWorkStore(exactJournal, exactProvider, () => id(101));
    const first = firstFacade.put(input()); await exactStarted.promise;
    const exactRetry = secondFacade.put(input()); await Promise.resolve(); expect(exactCalls).toBe(1);
    exactGate.resolve(); const [written, retried] = await Promise.all([first, exactRetry]);
    expect(retried.envelope.ciphertextRef).toBe(written.envelope.ciphertextRef); expect(exactCalls).toBe(2);

    const conflictJournal = new InMemoryWorkStore(); const conflictGate = deferred<void>(); const conflictStarted = deferred<void>(); let conflictCalls = 0;
    const conflictProvider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { const call = ++conflictCalls; await callback(new Uint8Array(KEY)); if (call === 1) { conflictStarted.resolve(); await conflictGate.promise; } } };
    const conflictFirst = new EncryptedWorkStore(conflictJournal, conflictProvider, () => id(110)).put(input()); await conflictStarted.promise;
    const conflictRetry = new EncryptedWorkStore(conflictJournal, conflictProvider, () => id(111)).put(input({ plaintext: new Uint8Array(Buffer.from("conflict")) }));
    conflictGate.resolve(); await conflictFirst; await expectFailure(() => conflictRetry);
    expect(conflictJournal.exportImageForTestOnly().metadata.records).toHaveLength(1); expect(conflictCalls).toBe(1);

    const independentJournal = new InMemoryWorkStore(); const independentGate = deferred<void>(); const independentStarted = deferred<void>(); let independentCalls = 0;
    const independentProvider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { const call = ++independentCalls; await callback(new Uint8Array(KEY)); if (call === 1) { independentStarted.resolve(); await independentGate.promise; } } };
    const blocked = new EncryptedWorkStore(independentJournal, independentProvider, () => id(120)).put(input()); await independentStarted.promise;
    const independent = await new EncryptedWorkStore(independentJournal, independentProvider, () => id(121)).put(input({ id: id(12) }));
    expect(independent.id).toBe(id(12)); expect(independentCalls).toBe(2); independentGate.resolve(); await blocked;

    const failingJournal = new InMemoryWorkStore(); const failureGate = deferred<void>(); const failureStarted = deferred<void>(); let failureCalls = 0;
    const failingProvider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { const call = ++failureCalls; await callback(new Uint8Array(KEY)); if (call === 1) { failureStarted.resolve(); await failureGate.promise; throw new Error("first provider failure"); } } };
    const failed = new EncryptedWorkStore(failingJournal, failingProvider, () => id(130)).put(input()); await failureStarted.promise;
    const released = new EncryptedWorkStore(failingJournal, failingProvider, () => id(131)).put(input()); failureGate.resolve();
    await expectFailure(() => failed); expect((await released).id).toBe(IDS.entity); expect(failureCalls).toBe(2);
  });

  it("binds key, space, entity, kind, revision, and ciphertext to the stored AAD", async () => {
    const journal = new InMemoryWorkStore(); let n = 100; const facade = new EncryptedWorkStore(journal, provider(), () => id(n++));
    const written = await facade.put(input());
    for (const changed of [
      { spaceId: IDS.otherSpace, keyId: IDS.key, id: IDS.entity, recordRevision: 1 },
      { spaceId: IDS.space, keyId: IDS.otherKey, id: IDS.entity, recordRevision: 1 },
      { spaceId: IDS.space, keyId: IDS.key, id: id(8), recordRevision: 1 },
      { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 2 }
    ]) await expectFailure(() => facade.read(changed));
    const image = journal.exportImageForTestOnly();
    const altered = { ...image, envelopes: image.envelopes.map((entry) => entry.record.id === written.id ? {
      record: { ...entry.record, envelope: { ...entry.record.envelope, keyId: IDS.otherKey } }, ciphertext: new Uint8Array(entry.ciphertext)
    } : entry), metadata: { ...image.metadata, records: image.metadata.records.map((record) => record.id === written.id ? {
      ...record, envelope: { ...record.envelope, keyId: IDS.otherKey }
    } : record) } };
    const isolated = InMemoryWorkStore.fromImageForTestOnly(altered);
    const substituted = new EncryptedWorkStore(isolated, provider(), () => id(120));
    await expectFailure(() => substituted.read({ spaceId: IDS.space, keyId: IDS.otherKey, id: IDS.entity, recordRevision: 1 }));
    const wrongProvider = new EncryptedWorkStore(journal, provider(OTHER_KEY), () => id(121));
    await expectFailure(() => wrongProvider.read({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 }));
  });

  it("rejects ciphertext and historical-revision substitution even when an isolated journal image remains structurally valid", async () => {
    const journal = new InMemoryWorkStore(); let n = 100; const facade = new EncryptedWorkStore(journal, provider(), () => id(n++));
    const first = await facade.put(input());
    const second = await facade.put(input({ recordRevision: 2, plaintext: new Uint8Array(Buffer.from("revision two")) }));
    const image = journal.exportImageForTestOnly(); const original = image.envelopes.find((entry) => entry.record.recordRevision === 1);
    const revised = image.envelopes.find((entry) => entry.record.recordRevision === 2);
    if (original === undefined || revised === undefined) throw new Error("Missing image records.");
    const replace = (record: typeof revised.record) => ({ ...record, envelope: { ...record.envelope,
      nonce: original.record.envelope.nonce, tag: original.record.envelope.tag,
      ciphertextSha256: original.record.envelope.ciphertextSha256, contentSha256: original.record.envelope.contentSha256 } });
    const tampered = { ...image,
      envelopes: image.envelopes.map((entry) => entry.record.recordRevision === 2 ? { record: replace(entry.record), ciphertext: new Uint8Array(original.ciphertext) } : entry),
      metadata: { ...image.metadata, records: image.metadata.records.map((record) => record.recordRevision === 2 ? replace(record) : record) }
    };
    const isolated = InMemoryWorkStore.fromImageForTestOnly(tampered);
    await expectFailure(() => new EncryptedWorkStore(isolated, provider(), () => id(110)).read({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 2 }));
    expect(first.envelope.ciphertextRef).not.toBe(second.envelope.ciphertextRef);
  });

  it("rejects each independently reconstructed AES-AAD or envelope dimension from a structurally valid isolated image", async () => {
    const journal = new InMemoryWorkStore(); let n = 100; const facade = new EncryptedWorkStore(journal, provider(), () => id(n++));
    await facade.put(input());
    await facade.put(input({ id: id(10), plaintext: new Uint8Array(Buffer.from("alternate")) }));
    const base = journal.exportImageForTestOnly(); const target = base.envelopes.find((entry) => entry.record.id === IDS.entity && entry.record.recordRevision === 1);
    const alternate = base.envelopes.find((entry) => entry.record.id === id(10));
    if (target === undefined || alternate === undefined) throw new Error("Missing isolated image entries.");
    const targetEntry = target; const alternateEntry = alternate;
    const transformed = (change: (record: typeof targetEntry.record) => typeof targetEntry.record, ciphertext = targetEntry.ciphertext) => ({
      ...base,
      envelopes: base.envelopes.map((entry) => entry === targetEntry ? { record: change(entry.record), ciphertext: new Uint8Array(ciphertext) } : entry),
      metadata: { ...base.metadata, records: base.metadata.records.map((record) => record.id === targetEntry.record.id && record.recordRevision === 1 ? change(record) : record) }
    });
    const cases: readonly { readonly name: string; readonly image: ReturnType<typeof transformed>; readonly request: { spaceId: string; keyId: string; id: string; recordRevision: number }; }[] = [
      { name: "space", image: transformed((record) => ({ ...record, spaceId: IDS.otherSpace, envelope: { ...record.envelope, spaceId: IDS.otherSpace } })), request: { spaceId: IDS.otherSpace, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } },
      { name: "key", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, keyId: IDS.otherKey } })), request: { spaceId: IDS.space, keyId: IDS.otherKey, id: IDS.entity, recordRevision: 1 } },
      { name: "entity", image: transformed((record) => ({ ...record, id: id(11), envelope: { ...record.envelope, entityId: id(11) } })), request: { spaceId: IDS.space, keyId: IDS.key, id: id(11), recordRevision: 1 } },
      { name: "entity kind", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, entityKind: "review" } })), request: { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } },
      { name: "payload/blob domain", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, kind: "blob" } })), request: { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } },
      { name: "content hash", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, contentSha256: hash("different") } })), request: { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } },
      { name: "nonce", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, nonce: alternateEntry.record.envelope.nonce } })), request: { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } },
      { name: "tag", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, tag: alternateEntry.record.envelope.tag } })), request: { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } },
      { name: "ciphertext", image: transformed((record) => ({ ...record, envelope: { ...record.envelope, ciphertextSha256: hashBytes(alternateEntry.ciphertext) } }), alternateEntry.ciphertext), request: { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 } }
    ];
    for (const testCase of cases) {
      let isolated: InMemoryWorkStore;
      try { isolated = InMemoryWorkStore.fromImageForTestOnly(testCase.image); }
      catch (_error) { throw new Error(`Invalid isolated image for ${testCase.name}.`); }
      await expectFailure(() => new EncryptedWorkStore(isolated, provider(), () => id(120)).read(testCase.request));
    }
    // A standalone ciphertext digest change cannot enter a validated journal
    // image: the keyless store rejects it before the decrypt facade is reached.
    expect(() => InMemoryWorkStore.fromImageForTestOnly(transformed((record) => ({ ...record, envelope: { ...record.envelope, ciphertextSha256: hash("different digest") } })))).toThrow();
    // Revision values must stay contiguous for a valid image. Swapping the two
    // historical labels retains a valid history but changes the authenticated revision.
    const historyJournal = new InMemoryWorkStore(); let historyRef = 130; const historyFacade = new EncryptedWorkStore(historyJournal, provider(), () => id(historyRef++));
    await historyFacade.put(input()); await historyFacade.put(input({ recordRevision: 2, plaintext: new Uint8Array(Buffer.from("revision two")) }));
    const history = historyJournal.exportImageForTestOnly();
    const revisions = history.envelopes.filter((entry) => entry.record.id === IDS.entity).sort((left, right) => left.record.recordRevision - right.record.recordRevision);
    const first = revisions[0]; const second = revisions[1]; if (first === undefined || second === undefined) throw new Error("Missing revision history.");
    const relabel = (entry: typeof first, revision: number) => ({ ...entry.record, recordRevision: revision, envelope: { ...entry.record.envelope, contentRevision: revision } });
    const revisionImage = { ...history,
      envelopes: [...history.envelopes.filter((entry) => entry !== first && entry !== second), { record: relabel(second, 1), ciphertext: new Uint8Array(second.ciphertext) }, { record: relabel(first, 2), ciphertext: new Uint8Array(first.ciphertext) }],
      metadata: { ...history.metadata, records: [...history.metadata.records.filter((record) => record.id !== IDS.entity), relabel(second, 1), relabel(first, 2)] }
    };
    const revisionIsolated = InMemoryWorkStore.fromImageForTestOnly(revisionImage);
    await expectFailure(() => new EncryptedWorkStore(revisionIsolated, provider(), () => id(121)).read({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 }));
  });

  it("treats ciphertextRef as a unique opaque token, not AES AAD or an inline-store locator", async () => {
    const journal = new InMemoryWorkStore(); const facade = new EncryptedWorkStore(journal, provider(), () => id(100)); const written = await facade.put(input());
    const base = journal.exportImageForTestOnly(); const replacementRef = id(101);
    const changed = (record: typeof written) => ({ ...record, envelope: { ...record.envelope, ciphertextRef: replacementRef } });
    const image = { ...base,
      envelopes: base.envelopes.map((entry) => ({ record: changed(entry.record), ciphertext: new Uint8Array(entry.ciphertext) })),
      metadata: { ...base.metadata, records: base.metadata.records.map(changed) }
    };
    // This Map seam carries bytes inline by revision; it never resolves the token.
    // A future transactional ref-to-bytes authority is explicitly out of scope.
    const isolated = InMemoryWorkStore.fromImageForTestOnly(image);
    const substituted = new EncryptedWorkStore(isolated, provider(), () => replacementRef);
    expect(Buffer.from(await substituted.read({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 })).toString()).toBe("sealed content");
    await expectFailure(() => substituted.put(input({ id: id(12) })));
  });

  it("keeps journal relation/effect semantics and all rejected writes atomic", async () => {
    const journal = new InMemoryWorkStore(); let n = 100; const facade = new EncryptedWorkStore(journal, provider(), () => id(n++));
    const task = await facade.put(input({ id: IDS.task, entityKind: "task", idempotency: { kind: "task", idempotencyKeySha256: hash("task") } }));
    const run = await facade.put(input({ id: IDS.run, entityKind: "run", idempotency: { kind: "run", taskId: IDS.task, attempt: 1 } }));
    expect(journal.appendEvent({ schemaVersion: 1, id: id(20), spaceId: IDS.space, runId: IDS.run, runRevision: 1, sequence: 1, kind: "run-recorded", runCiphertextSha256: run.envelope.ciphertextSha256, effectId: null, effectRevision: null, effectState: null, claimSha256: null }).kind).toBe("run-recorded");
    const effect = journal.putEffect({ schemaVersion: 1, id: id(21), spaceId: IDS.space, runId: IDS.run, runRevision: 1, stepKey: id(22), requestSha256: hash("effect"), state: "pending", effectRevision: 1, claimId: null });
    const claim = journal.claimEffect(IDS.space, effect.id, 1); if (claim.claimId === null) throw new Error("Missing claim.");
    expect(journal.completeEffect(IDS.space, effect.id, 2, claim.claimId).state).toBe("completed");
    expect(task.id).toBe(IDS.task);
    const noTask = store();
    await expectFailure(() => noTask.put(input({ id: IDS.run, entityKind: "run", idempotency: { kind: "run", taskId: IDS.task, attempt: 1 } })));
    const failingJournal = new InMemoryWorkStore(); const failing = new EncryptedWorkStore(failingJournal, provider(), () => "not-a-ref");
    await expectFailure(() => failing.put(input()));
    expect(failingJournal.exportImageForTestOnly().metadata.records).toHaveLength(0);
    const collisionJournal = new InMemoryWorkStore(); const collision = new EncryptedWorkStore(collisionJournal, provider(), () => id(130));
    await collision.put(input()); await expectFailure(() => collision.put(input({ id: id(8) })));
    expect(collisionJournal.exportImageForTestOnly().metadata.records).toHaveLength(1);
    const throwingGenerator = new EncryptedWorkStore(new InMemoryWorkStore(), provider(), () => { throw new Error("generator detail"); });
    await expectFailure(() => throwingGenerator.put(input()));
  });

  it("contains provider failures and hostile byte/object inputs behind one fixed error", async () => {
    const providers: WorkspaceKeyProvider[] = [
      { async withUnlockedKey() { throw new Error("provider detail"); } },
      { async withUnlockedKey() { /* never calls */ } },
      { async withUnlockedKey(_ref, callback) { await callback(new Uint8Array(KEY)); await callback(new Uint8Array(KEY)); } },
      { async withUnlockedKey(_ref, callback) { await callback(new Uint8Array(31)); } },
      { async withUnlockedKey(_ref, callback) { await callback(new Uint8Array(new SharedArrayBuffer(32))); } },
      { async withUnlockedKey(_ref, callback) { const spoofed = new Uint8Array(KEY); Object.defineProperty(spoofed, "byteLength", { value: 32 }); await callback(spoofed); } }
    ];
    for (const candidate of providers) {
      const journal = new InMemoryWorkStore(); await expectFailure(() => new EncryptedWorkStore(journal, candidate, () => id(100)).put(input()));
      expect(journal.exportImageForTestOnly().metadata.records).toHaveLength(0);
    }
    const shared = new Uint8Array(new SharedArrayBuffer(2)); const spoof = new Uint8Array([1]); Object.defineProperty(spoof, "byteLength", { value: 2 });
    const accessor = {} as EncryptedWorkStorePutInput; Object.defineProperty(accessor, "spaceId", { enumerable: true, get: () => IDS.space });
    const proxy = new Proxy({} as EncryptedWorkStorePutInput, { ownKeys: () => { throw new Error("hostile"); } });
    await expectFailure(() => store().put(input({ plaintext: shared })));
    await expectFailure(() => store().put(input({ plaintext: spoof })));
    await expectFailure(() => store().put(accessor));
    await expectFailure(() => store().put(proxy));
    await expectFailure(() => store().put(input({ plaintext: new Uint8Array(8 * 1024 * 1024 + 1) })));
    const readAccessor = { spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 }; Object.defineProperty(readAccessor, "id", { enumerable: true, get: () => IDS.entity });
    const readProxy = new Proxy({ spaceId: IDS.space, keyId: IDS.key, id: IDS.entity, recordRevision: 1 }, { ownKeys: () => { throw new Error("hostile read"); } });
    await expectFailure(() => store().read(readAccessor));
    await expectFailure(() => store().read(readProxy));
    expect(KEY.every((byte) => byte === 0x51)).toBe(true);
  });

  it("does not commit staged work for swallowed double callbacks or non-void providers, and rejects late callbacks without a second write", async () => {
    const swallowedKey = new Uint8Array(KEY); const swallowedJournal = new InMemoryWorkStore();
    const swallowed: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) {
      await callback(swallowedKey); try { await callback(swallowedKey); } catch { /* hostile provider suppresses it */ }
    } };
    await expectFailure(() => new EncryptedWorkStore(swallowedJournal, swallowed, () => id(100)).put(input()));
    expect(swallowedKey).toEqual(KEY); expect(swallowedJournal.exportImageForTestOnly().metadata.records).toHaveLength(0);

    const nonVoidKey = new Uint8Array(KEY); const nonVoidJournal = new InMemoryWorkStore();
    const nonVoid: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { await callback(nonVoidKey); return "not-void" as never; } };
    await expectFailure(() => new EncryptedWorkStore(nonVoidJournal, nonVoid, () => id(100)).put(input()));
    expect(nonVoidKey).toEqual(KEY); expect(nonVoidJournal.exportImageForTestOnly().metadata.records).toHaveLength(0);

    const lateKey = new Uint8Array(KEY); const lateJournal = new InMemoryWorkStore(); let late: ((key: Uint8Array) => void) | undefined;
    const lateProvider: WorkspaceKeyProvider = { async withUnlockedKey(_ref, callback) { late = callback; await callback(lateKey); } };
    await new EncryptedWorkStore(lateJournal, lateProvider, () => id(100)).put(input());
    if (late === undefined) throw new Error("Missing late callback.");
    expect(() => late!(new Uint8Array(KEY))).toThrow(EncryptedWorkStoreError);
    expect(lateKey).toEqual(KEY); expect(lateJournal.exportImageForTestOnly().metadata.records).toHaveLength(1);
  });
});

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hashBytes(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve: (value) => resolve?.(value) };
}
