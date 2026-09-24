import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkStore, InMemoryWorkStoreError, type StoredOpaqueRecord } from "./in-memory-work-store.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hashText = (value: string) => hash(value);
const spaceId = id(1); const otherSpaceId = id(2); const taskId = id(3); const runId = id(4);

function record(kind: "task" | "run" | "receipt" = "task", entityId = kind === "task" ? taskId : kind === "run" ? runId : id(5), ciphertext = Buffer.from(`cipher-${kind}`)): StoredOpaqueRecord {
  const idempotency = kind === "task" ? { kind, idempotencyKeySha256: hashText("task-key") } as const
    : kind === "run" ? { kind, taskId, attempt: 1 } as const : { kind, runId } as const;
  return { ciphertext: new Uint8Array(ciphertext), record: {
    schemaVersion: 1, id: entityId, spaceId, recordRevision: 1, idempotency,
    envelope: { envelopeVersion: 1, spaceId, keyId: id(90), entityId, entityKind: kind === "receipt" ? "receipt" : kind,
      schemaVersion: 1, contentRevision: 1, kind: "payload", contentSha256: hashText("plaintext-binding"), nonce: "AAAAAAAAAAAAAAAA",
      ciphertextRef: id(100 + Number(entityId.slice(-1))), ciphertextSha256: hash(ciphertext), tag: "AAAAAAAAAAAAAAAAAAAAAA" }
  } } as StoredOpaqueRecord;
}
function runEvent(sequence: number, effectId: string | null = null) {
  const stored = record("run");
  return { schemaVersion: 1, id: id(20 + sequence), spaceId, runId, runRevision: 1, sequence,
    kind: effectId === null ? "run-recorded" : "effect-created", runCiphertextSha256: stored.record.envelope.ciphertextSha256, effectId,
    effectRevision: null, effectState: null, claimSha256: null } as const;
}
function pendingEffect(effectId = id(30)) { return { schemaVersion: 1, id: effectId, spaceId, runId, runRevision: 1, stepKey: id(31), requestSha256: hashText("request"), state: "pending", effectRevision: 1, claimId: null } as const; }
function expectStoreFailure(action: () => unknown) { expect(action).toThrow(InMemoryWorkStoreError); try { action(); } catch (error) { expect(error).toMatchObject({ message: "Durable work store operation failed." }); } }
function expectFixedFailureOnce(action: () => unknown) { let caught: unknown; try { action(); } catch (error) { caught = error; } expect(caught).toBeInstanceOf(InMemoryWorkStoreError); expect(caught).toMatchObject({ message: "Durable work store operation failed." }); }
function readyStore() { const store = new InMemoryWorkStore(); store.putRecord(record("task")); store.putRecord(record("run")); return store; }
function readyStoreWithGenerators(claimIdGenerator: () => string, eventIdGenerator: () => string) { const store = new InMemoryWorkStore(claimIdGenerator, eventIdGenerator); store.putRecord(record("task")); store.putRecord(record("run")); return store; }

describe("private in-memory durable work store", () => {
  it("owns opaque ciphertext and metadata at both write and read boundaries", () => {
    const store = new InMemoryWorkStore(); const input = record("task"); const ciphertext = input.ciphertext;
    const written = store.putRecord(input); ciphertext[0] = 0; (input.record.envelope as { ciphertextSha256: string }).ciphertextSha256 = hashText("mutated");
    const first = store.readRecord(spaceId, taskId); first.ciphertext[0] = 0; (first.record.envelope as { ciphertextRef: string }).ciphertextRef = id(99);
    const second = store.readRecord(spaceId, taskId);
    expect(Buffer.from(written.ciphertext)).toEqual(Buffer.from("cipher-task"));
    expect(Buffer.from(second.ciphertext)).toEqual(Buffer.from("cipher-task"));
    expect(second.record.envelope.ciphertextRef).not.toBe(id(99));
  });

  it("enforces exact idempotency and rejects cross-space/context and digest substitutions", () => {
    const store = readyStore(); const same = record("run");
    expect(store.putRecord(same).record.id).toBe(runId);
    expectStoreFailure(() => store.putRecord({ ...record("run"), ciphertext: Buffer.from("other") }));
    expectStoreFailure(() => store.putRecord({ ...record("run", id(40)), record: { ...record("run", id(40)).record, idempotency: { kind: "run", taskId, attempt: 1 }, envelope: { ...record("run", id(40)).record.envelope, entityId: id(40) } } }));
    expectStoreFailure(() => store.readRecord(otherSpaceId, runId));
    expectStoreFailure(() => store.appendEvent({ ...runEvent(1), spaceId: otherSpaceId }));
    expectStoreFailure(() => store.appendEvent({ ...runEvent(1), runCiphertextSha256: hashText("wrong") }));
  });

  it("requires immutable contiguous events and exact effect idempotency", () => {
    const store = readyStore(); const event = runEvent(1); const effect = pendingEffect();
    expect(store.appendEvent(event)).toEqual(event); expect(store.appendEvent(event)).toEqual(event);
    expectStoreFailure(() => store.appendEvent({ ...event, id: id(22) }));
    expectStoreFailure(() => store.appendEvent({ ...runEvent(2), id: event.id }));
    expect(store.putEffect(effect)).toEqual(effect); expect(store.putEffect(effect)).toEqual(effect);
    expectStoreFailure(() => store.putEffect({ ...effect, id: id(32), effectRevision: 2 }));
    expectStoreFailure(() => store.appendEvent({ ...runEvent(2, effect.id), spaceId: otherSpaceId, kind: "effect-created" }));
    expectStoreFailure(() => store.appendEvent({ ...runEvent(2, effect.id), kind: "effect-created" }));
    const claimed = store.claimEffect(spaceId, effect.id, 1); expect(store.putEffect({ ...effect, id: id(32) })).toEqual(claimed);
    expectStoreFailure(() => store.appendEvent({ ...runEvent(3, effect.id), kind: "effect-claimed" }));
    expectStoreFailure(() => store.appendEvent({ ...runEvent(4, effect.id), kind: "effect-completed" }));
  });

  it("advances a record head by exactly one revision while retaining historical run bindings", () => {
    const store = readyStore(); const first = record("run"); const nextCiphertext = Buffer.from("cipher-run-revision-2");
    const revisionTwo = { record: { ...first.record, recordRevision: 2, envelope: { ...first.record.envelope, contentRevision: 2, ciphertextRef: id(50), ciphertextSha256: hash(nextCiphertext) } }, ciphertext: new Uint8Array(nextCiphertext) } as StoredOpaqueRecord;
    expect(store.putRecord(revisionTwo).record.recordRevision).toBe(2);
    expect(store.readRecord(spaceId, runId).record.recordRevision).toBe(2);
    expect(store.putRecord(first).record.recordRevision).toBe(1);
    expectStoreFailure(() => store.putRecord({ ...first, ciphertext: Buffer.from("different-historical") }));
    expectStoreFailure(() => store.appendEvent(runEvent(1)));
    expectStoreFailure(() => new InMemoryWorkStore().putRecord({ ...record("task"), record: { ...record("task").record, recordRevision: 2, envelope: { ...record("task").record.envelope, contentRevision: 2 } } }));
    expectStoreFailure(() => store.putRecord({ ...revisionTwo, record: { ...revisionTwo.record, envelope: { ...revisionTwo.record.envelope, entityKind: "artifact" } } }));
    expectStoreFailure(() => store.putRecord({ ...revisionTwo, record: { ...revisionTwo.record, recordRevision: 4, envelope: { ...revisionTwo.record.envelope, contentRevision: 4, ciphertextRef: id(51) } } }));
  });

  it("reads exact current and historical revisions with defensive copies and fixed hostile-input errors", () => {
    const store = readyStore(); const first = record("run"); const cipher = Buffer.from("cipher-run-revision-2");
    const second = { record: { ...first.record, recordRevision: 2, envelope: { ...first.record.envelope, contentRevision: 2, ciphertextRef: id(50), ciphertextSha256: hash(cipher) } }, ciphertext: new Uint8Array(cipher) } as StoredOpaqueRecord;
    store.putRecord(second);
    const historical = store.readRecordRevision(spaceId, runId, 1); const current = store.readRecordRevision(spaceId, runId, 2);
    historical.ciphertext[0] = 0; (historical.record.envelope as { ciphertextRef: string }).ciphertextRef = id(99);
    expect(Buffer.from(store.readRecordRevision(spaceId, runId, 1).ciphertext)).toEqual(Buffer.from("cipher-run"));
    expect(current.record.recordRevision).toBe(2); expect(store.readRecord(spaceId, runId).record.recordRevision).toBe(2);
    const hostile = new Proxy({} as object, { get: () => { throw new Error("hostile revision read"); } }) as unknown as string;
    expectFixedFailureOnce(() => store.readRecordRevision(hostile, runId, 1));
    expectFixedFailureOnce(() => store.readRecordRevision(spaceId, hostile, 1));
    expectFixedFailureOnce(() => store.readRecordRevision(spaceId, runId, 0));
    expectFixedFailureOnce(() => store.readRecordRevision(spaceId, runId, Number.MAX_SAFE_INTEGER + 1));
  });

  it("does not advance a live run while its revision retains nonterminal effect authority", () => {
    const store = readyStore(); store.putEffect(pendingEffect()); const cipher = Buffer.from("cipher-run-revision-2");
    const next = { record: { ...record("run").record, recordRevision: 2, envelope: { ...record("run").record.envelope, contentRevision: 2, ciphertextRef: id(52), ciphertextSha256: hash(cipher) } }, ciphertext: new Uint8Array(cipher) } as StoredOpaqueRecord;
    expectStoreFailure(() => store.putRecord(next));
  });

  it("keeps effect, key, claim, and event state atomic when generated event IDs fail", () => {
    const throwing = () => { throw new Error("attacker event generator detail"); };
    const putStore = readyStoreWithGenerators(() => id(90), throwing); const beforePut = putStore.exportImageForTestOnly();
    expectFixedFailureOnce(() => putStore.putEffect(pendingEffect())); expect(putStore.exportImageForTestOnly()).toEqual(beforePut);

    const claimEventIds = [id(80)]; const claimStore = readyStoreWithGenerators(() => id(90), () => claimEventIds.shift() ?? throwing()); claimStore.putEffect(pendingEffect()); const beforeClaim = claimStore.exportImageForTestOnly();
    expectFixedFailureOnce(() => claimStore.claimEffect(spaceId, id(30), 1)); expect(claimStore.exportImageForTestOnly()).toEqual(beforeClaim);

    const settleEventIds = [id(81), id(82)]; const settleStore = readyStoreWithGenerators(() => id(91), () => settleEventIds.shift() ?? throwing()); const settleEffect = settleStore.putEffect(pendingEffect()); const settleClaimed = settleStore.claimEffect(spaceId, settleEffect.id, 1); if (settleClaimed.claimId === null) throw new Error("Missing claim."); const beforeSettle = settleStore.exportImageForTestOnly();
    expectFixedFailureOnce(() => settleStore.completeEffect(spaceId, settleEffect.id, 2, settleClaimed.claimId!)); expect(settleStore.exportImageForTestOnly()).toEqual(beforeSettle);

    const failEventIds = [id(85), id(86)]; const failStore = readyStoreWithGenerators(() => id(94), () => failEventIds.shift() ?? throwing()); const failEffect = failStore.putEffect({ ...pendingEffect(id(42)), stepKey: id(43) }); const failClaimed = failStore.claimEffect(spaceId, failEffect.id, 1); if (failClaimed.claimId === null) throw new Error("Missing claim."); const beforeFail = failStore.exportImageForTestOnly();
    expectFixedFailureOnce(() => failStore.failEffect(spaceId, failEffect.id, 2, failClaimed.claimId!)); expect(failStore.exportImageForTestOnly()).toEqual(beforeFail);

    const cancelEventIds = [id(83)]; const cancelStore = readyStoreWithGenerators(() => id(92), () => cancelEventIds.shift() ?? throwing()); const cancelEffect = cancelStore.putEffect({ ...pendingEffect(id(38)), stepKey: id(39) }); const beforeCancel = cancelStore.exportImageForTestOnly();
    expectFixedFailureOnce(() => cancelStore.cancelEffect(spaceId, cancelEffect.id, 1, null)); expect(cancelStore.exportImageForTestOnly()).toEqual(beforeCancel);

    const collisionStore = readyStoreWithGenerators(() => id(93), () => id(84)); const collisionEffect = collisionStore.putEffect({ ...pendingEffect(id(40)), stepKey: id(41) }); const beforeCollision = collisionStore.exportImageForTestOnly();
    expectFixedFailureOnce(() => collisionStore.claimEffect(spaceId, collisionEffect.id, 1)); expect(collisionStore.exportImageForTestOnly()).toEqual(beforeCollision);
  });

  it("requires a same-space generic review before accepting specialized revision idempotency", () => {
    const store = new InMemoryWorkStore(); const reviewId = id(70); const revisionId = id(72);
    const genericReview = { ...record("task", reviewId), record: { ...record("task", reviewId).record, id: reviewId, idempotency: { kind: "entity" }, envelope: { ...record("task", reviewId).record.envelope, entityId: reviewId, entityKind: "review", ciphertextRef: id(71) } } } as unknown as StoredOpaqueRecord;
    const revision = { ...record("task", revisionId), record: { ...record("task", revisionId).record, id: revisionId, idempotency: { kind: "revision", reviewId, requestSha256: hashText("revision-request") }, envelope: { ...record("task", revisionId).record.envelope, entityId: revisionId, entityKind: "revision-request", ciphertextRef: id(73) } } } as unknown as StoredOpaqueRecord;
    expectStoreFailure(() => store.putRecord(revision)); store.putRecord(genericReview); expect(store.putRecord(revision).record.id).toBe(revisionId);
  });

  it("requires lifecycle authority to bind the current run head and rejects historical nonterminal imports", () => {
    const store = readyStore(); const effect = store.putEffect(pendingEffect()); store.cancelEffect(spaceId, effect.id, 1, null);
    const nextCiphertext = Buffer.from("cipher-run-revision-2");
    const revisionTwo = { record: { ...record("run").record, recordRevision: 2, envelope: { ...record("run").record.envelope, contentRevision: 2, ciphertextRef: id(55), ciphertextSha256: hash(nextCiphertext) } }, ciphertext: new Uint8Array(nextCiphertext) } as StoredOpaqueRecord;
    store.putRecord(revisionTwo);
    expectStoreFailure(() => store.claimEffect(spaceId, effect.id, 2));
    expectStoreFailure(() => store.completeEffect(spaceId, effect.id, 2, id(90)));
    expectStoreFailure(() => store.failEffect(spaceId, effect.id, 2, id(90)));
    expectStoreFailure(() => store.cancelEffect(spaceId, effect.id, 2, null));

    const source = readyStore(); source.putEffect(pendingEffect()); const image = source.exportImageForTestOnly();
    const historicalImage = { ...image, metadata: { ...image.metadata, records: [...image.metadata.records, revisionTwo.record] }, envelopes: [...image.envelopes, revisionTwo] };
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(historicalImage));
  });

  it("uses revisioned claim capabilities, invalidates cancellation leases, and never replays completion", () => {
    const store = readyStore(); const effect = store.putEffect(pendingEffect());
    const claimed = store.claimEffect(spaceId, effect.id, 1); const claim = claimed.claimId; if (claim === null) throw new Error("Missing generated claim."); expect(claimed.effectRevision).toBe(2);
    expectStoreFailure(() => store.completeEffect(spaceId, effect.id, 1, claim));
    const failed = store.failEffect(spaceId, effect.id, 2, claim); expect(failed.effectRevision).toBe(3);
    const reclaimed = store.claimEffect(spaceId, effect.id, 3); const replacementClaim = reclaimed.claimId; if (replacementClaim === null) throw new Error("Missing replacement claim."); expect(replacementClaim).not.toBe(claim);
    const cancelled = store.cancelEffect(spaceId, effect.id, 4, replacementClaim); expect(cancelled.claimId).toBeNull();
    expectStoreFailure(() => store.completeEffect(spaceId, effect.id, 5, replacementClaim));
    expectStoreFailure(() => store.claimEffect(spaceId, effect.id, 5));
    const terminal = store.putEffect({ ...pendingEffect(id(36)), stepKey: id(37) }); const terminalClaimed = store.claimEffect(spaceId, terminal.id, 1); const terminalClaim = terminalClaimed.claimId; if (terminalClaim === null) throw new Error("Missing terminal claim.");
    const completed = store.completeEffect(spaceId, terminal.id, 2, terminalClaim); expect(completed.state).toBe("completed");
    expectStoreFailure(() => store.completeEffect(spaceId, terminal.id, 3, terminalClaim));
    expectStoreFailure(() => store.claimEffect(spaceId, terminal.id, 3));
  });

  it("round-trips only a clearly test-only in-memory image and rejects partial or mutated images", () => {
    const store = readyStore(); store.putEffect(pendingEffect()); store.appendEvent(runEvent(2));
    const image = store.exportImageForTestOnly(); const restored = InMemoryWorkStore.fromImageForTestOnly(image);
    expect(Buffer.from(restored.readRecord(spaceId, runId).ciphertext)).toEqual(Buffer.from("cipher-run")); restored.restoreImageForTestOnly(image);
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly({ ...image, envelopes: image.envelopes.slice(1) }));
    const changed = image.envelopes.map((entry) => ({ ...entry, ciphertext: new Uint8Array(entry.ciphertext) })); const first = changed[0]; if (first === undefined) throw new Error("Missing test envelope."); first.ciphertext[0] = (first.ciphertext[0] ?? 0) ^ 1;
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly({ ...image, envelopes: changed }));
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly({ ...image, ignored: true } as unknown as typeof image));
    const live = readyStore(); expectStoreFailure(() => live.restoreImageForTestOnly({ ...image, envelopes: image.envelopes.slice(1) })); expect(live.readRecord(spaceId, runId).record.recordRevision).toBe(1);
  });

  it("preserves issued claim tombstones through the private test image", () => {
    const firstClaim = id(60); const secondClaim = id(61); const freshClaim = id(62); const sourceIds = [firstClaim, secondClaim, firstClaim, freshClaim];
    const store = new InMemoryWorkStore(() => sourceIds.shift() ?? freshClaim); store.putRecord(record("task")); store.putRecord(record("run")); const effect = store.putEffect(pendingEffect());
    const first = store.claimEffect(spaceId, effect.id, 1); if (first.claimId === null) throw new Error("Missing claim."); store.failEffect(spaceId, effect.id, 2, first.claimId);
    const second = store.claimEffect(spaceId, effect.id, 3); if (second.claimId === null) throw new Error("Missing claim."); store.failEffect(spaceId, effect.id, 4, second.claimId);
    const image = store.exportImageForTestOnly(); const omitted = { ...image, issuedClaims: image.issuedClaims.map((entry) => entry.effectId === effect.id ? { ...entry, claimIds: [secondClaim] } : entry) };
    store.restoreImageForTestOnly(omitted);
    expect(store.claimEffect(spaceId, effect.id, 5).claimId).toBe(freshClaim);
  });

  it("rejects missing, fabricated, and gapped effect transcripts during image import", () => {
    const store = readyStore(); const effect = store.putEffect(pendingEffect()); const claimed = store.claimEffect(spaceId, effect.id, 1); if (claimed.claimId === null) throw new Error("Missing claim."); store.failEffect(spaceId, effect.id, 2, claimed.claimId);
    const image = store.exportImageForTestOnly(); const missing = { ...image, metadata: { ...image.metadata, events: image.metadata.events.filter((event) => event.kind !== "effect-failed") } };
    const failedEvent = image.metadata.events.find((event) => event.kind === "effect-failed"); if (failedEvent === undefined) throw new Error("Missing failed event.");
    const fabricated = { ...image, metadata: { ...image.metadata, events: image.metadata.events.map((event) => event.id === failedEvent.id ? { ...event, kind: "effect-completed", effectState: "completed" } : event) } } as unknown as typeof image;
    const gapped = { ...image, metadata: { ...image.metadata, events: image.metadata.events.map((event) => event.id === failedEvent.id ? { ...event, sequence: event.sequence + 1 } : event) } };
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(missing));
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(fabricated));
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(gapped));
  });

  it("decodes only bounded plain dense data arrays without invoking hostile iterators or index accessors", () => {
    const source = readyStore(); source.putEffect(pendingEffect()); const image = source.exportImageForTestOnly();
    const iterator = [...image.envelopes]; Object.defineProperty(iterator, Symbol.iterator, { value: () => { throw new Error("must not iterate"); } });
    const accessor = [...image.envelopes]; Object.defineProperty(accessor, "0", { enumerable: true, get: () => image.envelopes[0] });
    const huge: unknown[] = []; huge.length = 4_097;
    const recordIterator = [...image.metadata.records]; Object.defineProperty(recordIterator, Symbol.iterator, { value: () => { throw new Error("must not map"); } });
    const claim = image.issuedClaims[0]; if (claim === undefined) throw new Error("Missing claim image."); const hugeClaims: unknown[] = []; hugeClaims.length = 4_097;
    for (const hostile of [
      { ...image, envelopes: iterator }, { ...image, envelopes: accessor }, { ...image, envelopes: huge },
      { ...image, envelopes: new Proxy([...image.envelopes], { getPrototypeOf: () => { throw new Error("nested proxy"); } }) },
      { ...image, metadata: { ...image.metadata, records: recordIterator } }, { ...image, issuedClaims: [{ ...claim, claimIds: hugeClaims }] }
    ]) expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(hostile as typeof image));
  });

  it("wipes partial temporary imports while preserving caller-owned image bytes", () => {
    const image = readyStore().exportImageForTestOnly(); const callerBytes = image.envelopes.map((entry) => Buffer.from(entry.ciphertext));
    const second = image.envelopes[1]; if (second === undefined) throw new Error("Missing second envelope.");
    const invalid = { ...image, envelopes: [image.envelopes[0], { ...second, ciphertext: new Uint8Array(Buffer.from("invalid")) }] };
    const fill = vi.spyOn(Uint8Array.prototype, "fill");
    try {
      expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(invalid as typeof image));
      expect(fill.mock.calls.filter((call) => call[0] === 0).length).toBeGreaterThanOrEqual(3);
      image.envelopes.forEach((entry, index) => expect(Buffer.from(entry.ciphertext)).toEqual(callerBytes[index]));
    } finally { fill.mockRestore(); }
  });

  it("rejects SharedArrayBuffer-backed and metadata-spoofed ciphertext views", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(Buffer.byteLength("cipher-task"))); shared.set(Buffer.from("cipher-task"));
    const spoof = new Uint8Array(Buffer.from("cipher-task")); Object.defineProperty(spoof, "byteLength", { value: 1 });
    expectStoreFailure(() => new InMemoryWorkStore().putRecord({ ...record("task"), ciphertext: shared }));
    expectStoreFailure(() => new InMemoryWorkStore().putRecord({ ...record("task"), ciphertext: spoof }));
    expectStoreFailure(() => new InMemoryWorkStore().putRecord({ ...record("task"), ignored: true } as unknown as StoredOpaqueRecord));
    const accessor = {} as StoredOpaqueRecord; Object.defineProperty(accessor, "record", { enumerable: true, get: () => record("task").record }); Object.defineProperty(accessor, "ciphertext", { enumerable: true, value: Buffer.from("cipher-task") });
    expectStoreFailure(() => new InMemoryWorkStore().putRecord(accessor));
    expectStoreFailure(() => new InMemoryWorkStore().putRecord(Object.assign(Object.create({ inherited: true }), record("task")) as StoredOpaqueRecord));
    const throwingProxy = new Proxy({} as StoredOpaqueRecord, { ownKeys: () => { throw new Error("trap"); } });
    expectStoreFailure(() => new InMemoryWorkStore().putRecord(throwingProxy));
    const imageProxy = new Proxy({} as ReturnType<InMemoryWorkStore["exportImageForTestOnly"]>, { getPrototypeOf: () => { throw new Error("trap"); } });
    expectStoreFailure(() => InMemoryWorkStore.fromImageForTestOnly(imageProxy));
    const effectProxy = new Proxy({} as ReturnType<typeof pendingEffect>, { get: () => { throw new Error("effect attacker detail"); } });
    expectFixedFailureOnce(() => readyStore().putEffect(effectProxy));
    const hostileId = new Proxy({} as object, { get: () => { throw new Error("identifier attacker detail"); } }) as unknown as string;
    const publicStore = readyStore(); const publicEffect = publicStore.putEffect(pendingEffect());
    expectFixedFailureOnce(() => publicStore.readRecord(spaceId, hostileId));
    expectFixedFailureOnce(() => publicStore.claimEffect(spaceId, hostileId, 1));
    expectFixedFailureOnce(() => publicStore.completeEffect(spaceId, publicEffect.id, 2, hostileId));
    expectFixedFailureOnce(() => publicStore.failEffect(spaceId, publicEffect.id, 2, hostileId));
    expectFixedFailureOnce(() => publicStore.cancelEffect(spaceId, publicEffect.id, 1, hostileId));
  });
});
