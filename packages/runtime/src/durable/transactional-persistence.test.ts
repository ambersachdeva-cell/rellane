import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkStore, type StoredOpaqueRecord } from "./in-memory-work-store.js";
import {
  InMemoryTransactionalPersistenceMedium,
  TransactionalPersistenceError,
  disposeOpaqueJournalSnapshotForTestOnly,
  operationBindingSha256ForDurableRecordForTestOnly,
  restoreInMemoryWorkStoreFromSnapshotForTestOnly,
  snapshotFromInMemoryWorkStoreForTestOnly,
  validateRecoveredTransactionalStateForTestOnly,
  type OpaqueJournalSnapshot
} from "./transactional-persistence.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SPACE = id(1); const TASK = id(2); const RUN = id(3);
function record(kind: "task" | "run", entityId: string, ref: string, ciphertext: Uint8Array): StoredOpaqueRecord {
  return { ciphertext, record: { schemaVersion: 1, id: entityId, spaceId: SPACE, recordRevision: 1,
    idempotency: kind === "task" ? { kind, idempotencyKeySha256: hash("task") } : { kind, taskId: TASK, attempt: 1 },
    envelope: { envelopeVersion: 1, spaceId: SPACE, keyId: id(90), entityId, entityKind: kind, schemaVersion: 1, contentRevision: 1,
      kind: "payload", contentSha256: hash("plain-" + kind), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: ref, ciphertextSha256: hash(ciphertext), tag: "AAAAAAAAAAAAAAAAAAAAAA" }
  } } as StoredOpaqueRecord;
}
function store(withRun = false): InMemoryWorkStore {
  const value = new InMemoryWorkStore(); value.putRecord(record("task", TASK, id(100), new Uint8Array(Buffer.from("task"))));
  if (withRun) value.putRecord(record("run", RUN, id(101), new Uint8Array(Buffer.from("run"))));
  return value;
}
function statefulStore(stage: "pending" | "claimed" | "completed" = "completed"): InMemoryWorkStore {
  const claimIds = [id(60), id(61)]; const eventIds = [id(21), id(22), id(23), id(24), id(25)];
  const value = new InMemoryWorkStore(() => claimIds.shift() ?? id(62), () => eventIds.shift() ?? id(29));
  value.putRecord(record("task", TASK, id(100), new Uint8Array(Buffer.from("task"))));
  const runOne = record("run", RUN, id(101), new Uint8Array(Buffer.from("run"))); value.putRecord(runOne);
  value.appendEvent({ schemaVersion: 1, id: id(20), spaceId: SPACE, runId: RUN, runRevision: 1, sequence: 1, kind: "run-recorded",
    runCiphertextSha256: runOne.record.envelope.ciphertextSha256, effectId: null, effectRevision: null, effectState: null, claimSha256: null });
  const effect = value.putEffect({ schemaVersion: 1, id: id(30), spaceId: SPACE, runId: RUN, runRevision: 1, stepKey: id(31), requestSha256: hash("effect"), state: "pending", effectRevision: 1, claimId: null });
  if (stage === "pending") return value;
  const first = value.claimEffect(SPACE, effect.id, 1); if (first.claimId === null) throw new Error("Missing first claim.");
  if (stage === "claimed") return value;
  value.failEffect(SPACE, effect.id, 2, first.claimId);
  const second = value.claimEffect(SPACE, effect.id, 3); if (second.claimId === null) throw new Error("Missing second claim.");
  value.completeEffect(SPACE, effect.id, 4, second.claimId);
  const runTwoBytes = new Uint8Array(Buffer.from("run-revision-two")); const runTwo = record("run", RUN, id(102), runTwoBytes);
  value.putRecord({ ...runTwo, record: { ...runTwo.record, recordRevision: 2, envelope: { ...runTwo.record.envelope, contentRevision: 2 } } });
  return value;
}
function genericRecord(serial: number, ciphertext: Uint8Array): StoredOpaqueRecord {
  const entityId = id(500 + serial); return { ciphertext, record: { schemaVersion: 1, id: entityId, spaceId: SPACE, recordRevision: 1, idempotency: { kind: "entity" },
    envelope: { envelopeVersion: 1, spaceId: SPACE, keyId: id(90), entityId, entityKind: "artifact", schemaVersion: 1, contentRevision: 1, kind: "blob",
      contentSha256: hash(`plain-${serial}`), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: id(600 + serial), ciphertextSha256: hash(ciphertext), tag: "AAAAAAAAAAAAAAAAAAAAAA" } } } as StoredOpaqueRecord;
}
function input(commitId: string, generation: number, snapshotSha256: string, snapshot: OpaqueJournalSnapshot, operationBindingSha256 = hash("binding")) { return { commitId, expectedGeneration: generation, expectedSnapshotSha256: snapshotSha256, operationBindingSha256, snapshot }; }
function expectFailure(action: () => unknown, code: string) { try { action(); } catch (error) { expect(error).toBeInstanceOf(TransactionalPersistenceError); expect(error).toMatchObject({ code, message: "Transactional persistence operation failed." }); return; } throw new Error("Expected failure"); }

describe("private transactional persistence simulator", () => {
  it("shares one stable concurrency identity per medium and creates a fresh identity after reconstruction", () => {
    const medium = new InMemoryTransactionalPersistenceMedium();
    expect(medium.openPortForTestOnly().concurrencyIdentity).toBe(medium.openPortForTestOnly().concurrencyIdentity);
    expect(InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(medium.exportImageForTestOnly()).openPortForTestOnly().concurrencyIdentity).not.toBe(medium.openPortForTestOnly().concurrencyIdentity);
  });

  it("validates operation projections, canonical record bindings, and owned recovered state", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const before = port.recover(); const snapshot = snapshotFromInMemoryWorkStoreForTestOnly(store());
    port.commit(input(id(190), 0, before.snapshotSha256, snapshot));
    expect(port.recoverOperationBinding(id(190))).toEqual({ commitId: id(190), operationBindingSha256: hash("binding") }); expect(port.recoverOperationBinding(id(191))).toBeUndefined(); expectFailure(() => port.recoverOperationBinding("bad"), "INVALID");
    const item = snapshot.journal.records[0]; if (item === undefined) throw new Error("fixture"); const binding = operationBindingSha256ForDurableRecordForTestOnly(item);
    const reorderedIdempotency = item.idempotency.kind === "task" ? { idempotencyKeySha256: item.idempotency.idempotencyKeySha256, kind: item.idempotency.kind } : item.idempotency.kind === "run" ? { attempt: item.idempotency.attempt, taskId: item.idempotency.taskId, kind: item.idempotency.kind } : { kind: item.idempotency.kind };
    const reordered = { envelope: { tag: item.envelope.tag, ciphertextSha256: item.envelope.ciphertextSha256, ciphertextRef: item.envelope.ciphertextRef, nonce: item.envelope.nonce, contentSha256: item.envelope.contentSha256, kind: item.envelope.kind, contentRevision: item.envelope.contentRevision, schemaVersion: item.envelope.schemaVersion, entityKind: item.envelope.entityKind, entityId: item.envelope.entityId, keyId: item.envelope.keyId, spaceId: item.envelope.spaceId, envelopeVersion: item.envelope.envelopeVersion }, idempotency: reorderedIdempotency, recordRevision: item.recordRevision, spaceId: item.spaceId, id: item.id, schemaVersion: item.schemaVersion };
    expect(operationBindingSha256ForDurableRecordForTestOnly(reordered)).toBe(binding); expect(operationBindingSha256ForDurableRecordForTestOnly({ ...item, envelope: { ...item.envelope, keyId: id(91) } })).not.toBe(binding);
    const accessor = { ...item }; Object.defineProperty(accessor, "id", { enumerable: true, get: () => item.id });
    for (const invalid of [{ ...item, extra: true }, accessor, new Proxy(item, { getPrototypeOf: () => { throw new Error("hostile"); } }), { ...item, envelope: { ...item.envelope, keyId: "bad" } }]) expectFailure(() => operationBindingSha256ForDurableRecordForTestOnly(invalid), "INVALID");
    const recovered = port.recover(); const callerBytes = new Uint8Array(recovered.snapshot.ciphertextBlobs[0]?.bytes ?? []); const owned = validateRecoveredTransactionalStateForTestOnly(recovered); expect(owned).not.toBe(recovered); expect(owned.snapshot).not.toBe(recovered.snapshot); owned.snapshot.ciphertextBlobs[0]?.bytes.fill(0); expect(recovered.snapshot.ciphertextBlobs[0]?.bytes).toEqual(callerBytes);
    const recoveredAccessor = { ...recovered }; Object.defineProperty(recoveredAccessor, "generation", { enumerable: true, get: () => recovered.generation });
    for (const invalid of [{ ...recovered, snapshotSha256: hash("wrong") }, { ...recovered, extra: true }, recoveredAccessor, new Proxy(recovered, { getPrototypeOf: () => { throw new Error("hostile"); } })]) expectFailure(() => validateRecoveredTransactionalStateForTestOnly(invalid), "INVALID");
    disposeOpaqueJournalSnapshotForTestOnly(owned.snapshot); disposeOpaqueJournalSnapshotForTestOnly(recovered.snapshot);
  });

  it("binds every strict idempotency variant with canonical property ordering", () => {
    const base = record("task", id(300), id(301), new Uint8Array(Buffer.from("variant"))).record;
    const variants: readonly Record<string, unknown>[] = [
      { kind: "task", idempotencyKeySha256: hash("task") }, { kind: "run", taskId: TASK, attempt: 1 }, { kind: "revision", reviewId: id(302), requestSha256: hash("revision") }, { kind: "receipt", runId: RUN }, { kind: "entity" }
    ];
    for (const [index, idempotency] of variants.entries()) {
      const entityId = id(310 + index); const entityKind = idempotency.kind === "entity" ? "artifact" : idempotency.kind === "revision" ? "revision-request" : idempotency.kind; const value = { ...base, id: entityId, idempotency, envelope: { ...base.envelope, entityId, entityKind, ciphertextRef: id(320 + index) } };
      const reversedIdempotency = Object.fromEntries(Object.entries(idempotency).reverse());
      const reversed = { envelope: Object.fromEntries(Object.entries(value.envelope).reverse()), idempotency: reversedIdempotency, recordRevision: value.recordRevision, spaceId: value.spaceId, id: value.id, schemaVersion: value.schemaVersion };
      expect(operationBindingSha256ForDurableRecordForTestOnly(reversed)).toBe(operationBindingSha256ForDurableRecordForTestOnly(value));
      expectFailure(() => operationBindingSha256ForDurableRecordForTestOnly({ ...value, idempotency: { ...idempotency, extra: true } }), "INVALID");
      if (Object.keys(idempotency).length > 1) expectFailure(() => operationBindingSha256ForDurableRecordForTestOnly({ ...value, idempotency: { kind: idempotency.kind } }), "INVALID");
    }
  });

  it("atomically publishes full metadata, history/ref index, ciphertext bytes, events/effects, and issued claims", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
    const first = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed")); const receipt = port.commit(input(id(200), empty.generation, empty.snapshotSha256, first));
    expect(Object.keys(receipt)).toEqual(["commitId", "generation", "snapshotSha256"]); expect(receipt.generation).toBe(1);
    const recovered = port.recover(); expect(recovered.snapshotSha256).toBe(receipt.snapshotSha256);
    const restored = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered.snapshot);
    expect(Buffer.from(restored.readRecord(SPACE, TASK).ciphertext).toString()).toBe("task"); expect(recovered.snapshot.journal.events).toHaveLength(3);
    expect(recovered.snapshot.journal.effects).toMatchObject([{ state: "claimed", effectRevision: 2 }]); expect(recovered.snapshot.issuedClaims[0]?.claimIds).toEqual([id(60)]);
    const second = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("completed")); const advanced = port.commit(input(id(201), recovered.generation, recovered.snapshotSha256, second));
    expect(advanced.generation).toBe(2); const finalStore = restoreInMemoryWorkStoreFromSnapshotForTestOnly(port.recover().snapshot);
    expect(Buffer.from(finalStore.readRecordRevision(SPACE, RUN, 1).ciphertext).toString()).toBe("run");
    expect(Buffer.from(finalStore.readRecordRevision(SPACE, RUN, 2).ciphertext).toString()).toBe("run-revision-two");
    expect(port.recover().snapshot.issuedClaims[0]?.claimIds).toEqual([id(60), id(61)]);
  });

  it("keeps canonical ref-index ordering and snapshot identity stable when record and ref orders oppose", () => {
    const source = new InMemoryWorkStore(); const first = genericRecord(10, new Uint8Array(Buffer.from("first"))); const second = genericRecord(11, new Uint8Array(Buffer.from("second")));
    source.putRecord({ ...first, record: { ...first.record, envelope: { ...first.record.envelope, ciphertextRef: id(900) } } });
    source.putRecord({ ...second, record: { ...second.record, envelope: { ...second.record.envelope, ciphertextRef: id(800) } } });
    const snapshot = snapshotFromInMemoryWorkStoreForTestOnly(source);
    expect(snapshot.journal.records.map((record) => record.id)).toEqual([first.record.id, second.record.id]);
    expect(snapshot.refIndex.map((entry) => entry.id)).toEqual([second.record.id, first.record.id]);
    const roundTrip = snapshotFromInMemoryWorkStoreForTestOnly(restoreInMemoryWorkStoreFromSnapshotForTestOnly(snapshot));
    expect(roundTrip.refIndex).toEqual(snapshot.refIndex);
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
    const receipt = port.commit(input(id(205), 0, empty.snapshotSha256, snapshot));
    expect(port.recover().snapshotSha256).toBe(receipt.snapshotSha256);
    expect(port.commit(input(id(205), 0, empty.snapshotSha256, roundTrip))).toEqual(receipt);
  });

  it("enforces exact commit-id replay, expected-generation/hash CAS, and safe lost-ack retry", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const before = port.recover(); const snapshot = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed"));
    medium.setFaultForTestOnly("after-publish-before-ack"); expectFailure(() => port.commit(input(id(210), before.generation, before.snapshotSha256, snapshot)), "INTERRUPTED");
    const recovered = port.recover(); expect(recovered.generation).toBe(1);
    const restarted = InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(medium.exportImageForTestOnly()).openPortForTestOnly();
    expect(restarted.commit(input(id(210), before.generation, before.snapshotSha256, snapshot))).toEqual({ commitId: id(210), generation: 1, snapshotSha256: recovered.snapshotSha256 });
    expect(restarted.recover().generation).toBe(1);
    expectFailure(() => restarted.commit(input(id(210), before.generation, before.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("completed")))), "CONFLICT");
    expectFailure(() => restarted.commit(input(id(211), before.generation, before.snapshotSha256, snapshot)), "CONFLICT");
  });

  it("rejects no-op commits without consuming their ID, generation, or bounded receipt slot", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
    expectFailure(() => port.commit(input(id(215), empty.generation, empty.snapshotSha256, empty.snapshot)), "CONFLICT"); expect(port.recover()).toEqual(empty);
    const first = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed"));
    expect(port.commit(input(id(215), empty.generation, empty.snapshotSha256, first)).generation).toBe(1);
    const accepted = port.recover(); expectFailure(() => port.commit(input(id(216), accepted.generation, accepted.snapshotSha256, accepted.snapshot)), "CONFLICT");
    expect(port.commit(input(id(216), accepted.generation, accepted.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("completed")))).generation).toBe(2);
  });

  it("permits only monotonic extensions; a valid complete snapshot cannot delete or rewrite an accepted ref", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
    const first = snapshotFromInMemoryWorkStoreForTestOnly(store()); port.commit(input(id(212), empty.generation, empty.snapshotSha256, first));
    const accepted = port.recover();
    const deletion = snapshotFromInMemoryWorkStoreForTestOnly(new InMemoryWorkStore());
    expectFailure(() => port.commit(input(id(213), accepted.generation, accepted.snapshotSha256, deletion)), "CONFLICT");
    const originalBlob = first.ciphertextBlobs[0]; if (originalBlob === undefined) throw new Error("Missing blob.");
    const rewritten = { ...first, ciphertextBlobs: [{ ...originalBlob, bytes: new Uint8Array(Buffer.from("evil")), ciphertextSha256: hash("evil") }] };
    expectFailure(() => port.commit(input(id(214), accepted.generation, accepted.snapshotSha256, rewritten)), "INVALID");
    expect(port.recover()).toEqual(accepted);
  });

  it("preserves event and claim prefixes and immutable effect identity across transcript-backed advances", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
    const claimed = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed")); port.commit(input(id(217), 0, empty.snapshotSha256, claimed)); const before = port.recover();
    const completed = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("completed")); const effect = completed.journal.effects[0]; if (effect === undefined) throw new Error("Missing effect.");
    const rewrittenEffect = { ...completed, journal: { ...completed.journal, effects: [{ ...effect, stepKey: id(32) }] } } as OpaqueJournalSnapshot;
    expectFailure(() => port.commit(input(id(218), before.generation, before.snapshotSha256, rewrittenEffect)), "CONFLICT");
    const firstEvent = completed.journal.events[0]; if (firstEvent === undefined) throw new Error("Missing event.");
    const rewrittenPrefix = { ...completed, journal: { ...completed.journal, events: [{ ...firstEvent, id: id(40) }, ...completed.journal.events.slice(1)] } } as OpaqueJournalSnapshot;
    expectFailure(() => port.commit(input(id(218), before.generation, before.snapshotSha256, rewrittenPrefix)), "CONFLICT");
    expectFailure(() => port.commit(input(id(218), before.generation, before.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("pending")))), "CONFLICT");
    const claims = completed.issuedClaims[0]; if (claims === undefined) throw new Error("Missing claims.");
    const reorderedClaims = { ...completed, issuedClaims: [{ ...claims, claimIds: [...claims.claimIds].reverse() }] } as OpaqueJournalSnapshot;
    expectFailure(() => port.commit(input(id(218), before.generation, before.snapshotSha256, reorderedClaims)), "INVALID");
    expect(port.recover()).toEqual(before);
  });

  it("recovers only exact pre-state or validated full post-state at every deterministic fault point", () => {
    for (const point of ["before-publish", "after-staging-bytes", "after-staging-metadata"] as const) {
      const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
      port.commit(input(id(219), empty.generation, empty.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed")))); const before = port.recover();
      medium.setFaultForTestOnly(point); expectFailure(() => port.commit(input(id(220), before.generation, before.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("completed")))), "INTERRUPTED");
      expect(port.recover()).toEqual(before);
    }
  });

  it("rejects missing, orphaned, swapped, duplicate, corrupted, sparse, shared, accessor, and proxy state without publication", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const before = port.recover(); const base = snapshotFromInMemoryWorkStoreForTestOnly(store());
    const ownIterator = [...base.ciphertextBlobs]; Object.defineProperty(ownIterator, Symbol.iterator, { value: () => { throw new Error("must not iterate"); } });
    const huge: unknown[] = []; huge.length = 4_097;
    const indexAccessor = [...base.ciphertextBlobs]; Object.defineProperty(indexAccessor, "0", { enumerable: true, get: () => base.ciphertextBlobs[0] });
    const eventIterator: unknown[] = []; Object.defineProperty(eventIterator, Symbol.iterator, { value: () => { throw new Error("must not iterate nested events"); } });
    const mutations: unknown[] = [
      { ...base, ciphertextBlobs: [] },
      { ...base, ciphertextBlobs: [...base.ciphertextBlobs, { ciphertextRef: id(301), ciphertextSha256: hash("orphan"), bytes: new Uint8Array(Buffer.from("orphan")) }] },
      { ...base, refIndex: [{ ...base.refIndex[0], ciphertextRef: id(302) }] },
      { ...base, ciphertextBlobs: [{ ...base.ciphertextBlobs[0], bytes: new Uint8Array(Buffer.from("swap")) }] },
      { ...base, ciphertextBlobs: [base.ciphertextBlobs[0], base.ciphertextBlobs[0]] },
      { ...base, ciphertextBlobs: new Array(1) },
      { ...base, ciphertextBlobs: [{ ...base.ciphertextBlobs[0], bytes: new Uint8Array(new SharedArrayBuffer(1)) }] },
      { ...base, ciphertextBlobs: ownIterator }, { ...base, ciphertextBlobs: huge }, { ...base, ciphertextBlobs: indexAccessor },
      { ...base, ciphertextBlobs: new Proxy([...base.ciphertextBlobs], { getPrototypeOf: () => { throw new Error("nested proxy"); } }) },
      { ...base, journal: { ...base.journal, events: eventIterator } },
      { ...base, journal: { ...base.journal, events: new Proxy([], { getPrototypeOf: () => { throw new Error("journal proxy"); } }) } }
    ];
    const accessor = { ...base } as Record<string, unknown>; Object.defineProperty(accessor, "journal", { enumerable: true, get: () => base.journal }); mutations.push(accessor);
    mutations.push(new Proxy(base, { ownKeys: () => { throw new Error("hostile"); } }));
    for (const snapshot of mutations) expectFailure(() => port.commit({ commitId: id(300), expectedGeneration: before.generation, expectedSnapshotSha256: before.snapshotSha256, snapshot } as never), "INVALID");
    const multi = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed")); const left = multi.ciphertextBlobs[0]; const right = multi.ciphertextBlobs[1];
    if (left === undefined || right === undefined) throw new Error("Missing swap fixtures.");
    expectFailure(() => port.commit(input(id(301), 0, before.snapshotSha256, { ...multi, ciphertextBlobs: [{ ...left, ciphertextRef: right.ciphertextRef }, { ...right, ciphertextRef: left.ciphertextRef }, ...multi.ciphertextBlobs.slice(2)] })), "INVALID");
    expect(port.recover()).toEqual(before);
  });

  it("bounds aggregate ciphertext and claims before importing nested journal state and clears rejected owned copies", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const before = port.recover();
    const largeStore = new InMemoryWorkStore(); for (let serial = 0; serial < 3; serial += 1) largeStore.putRecord(genericRecord(serial, new Uint8Array(5_700_000).fill(serial + 1)));
    const oversized = snapshotFromInMemoryWorkStoreForTestOnly(largeStore);
    try { expectFailure(() => port.commit(input(id(320), 0, before.snapshotSha256, oversized)), "INVALID"); }
    finally { for (const blob of oversized.ciphertextBlobs) blob.bytes.fill(0); largeStore.disposeForTestOnly(); }
    const claimed = snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed")); const many = new Array(2_049).fill(id(60));
    expectFailure(() => port.commit(input(id(321), 0, before.snapshotSha256, { ...claimed, issuedClaims: [{ effectId: id(30), claimIds: many }, { effectId: id(32), claimIds: [...many] }] })), "INVALID");
    const base = snapshotFromInMemoryWorkStoreForTestOnly(store()); const callerBytes = Buffer.from(base.ciphertextBlobs[0]?.bytes ?? []); const fill = vi.spyOn(Uint8Array.prototype, "fill");
    try {
      expectFailure(() => port.commit(input(id(322), 0, before.snapshotSha256, { ...base, refIndex: [{ ...base.refIndex[0], ciphertextRef: id(999) }] } as OpaqueJournalSnapshot)), "INVALID");
      expect(Buffer.from(base.ciphertextBlobs[0]?.bytes ?? [])).toEqual(callerBytes); expect(fill.mock.calls.some((call) => call[0] === 0)).toBe(true);
    } finally { fill.mockRestore(); }
    expect(port.recover()).toEqual(before);
  });

  it("restarts from the simulator medium only after validating an immutable complete image", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const before = port.recover();
    port.commit(input(id(400), before.generation, before.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(store(true))));
    const image = medium.exportImageForTestOnly(); const restarted = InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(image).openPortForTestOnly();
    expect(restarted.recover()).toEqual(port.recover());
    expectFailure(() => InMemoryTransactionalPersistenceMedium.fromImageForTestOnly({ ...image, state: { ...image.state, generation: 0 } }).openPortForTestOnly(), "INVALID");
  });

  it("recomputes and validates the complete receipt authority chain on image import", () => {
    const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const empty = port.recover();
    port.commit(input(id(410), 0, empty.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("claimed")))); const olderWholeImage = medium.exportImageForTestOnly(); const first = port.recover();
    port.commit(input(id(411), 1, first.snapshotSha256, snapshotFromInMemoryWorkStoreForTestOnly(statefulStore("completed")))); const image = medium.exportImageForTestOnly();
    const replace = (index: number, change: Record<string, unknown>) => ({ ...image, receipts: image.receipts.map((receipt, receiptIndex) => receiptIndex === index ? { ...receipt, ...change } : receipt) });
    for (const altered of [
      replace(0, { commitId: id(412) }), replace(0, { requestSha256: hash("altered request") }), replace(0, { operationBindingSha256: hash("altered binding") }), replace(0, { snapshotSha256: hash("altered post") }),
      replace(0, { requestedSnapshotSha256: hash("altered requested") }), replace(1, { expectedSnapshotSha256: hash("broken predecessor") }), replace(1, { expectedGeneration: 0 })
    ]) expectFailure(() => InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(altered as typeof image), "INVALID");
    const receiptIterator = [...image.receipts]; Object.defineProperty(receiptIterator, Symbol.iterator, { value: () => { throw new Error("must not iterate receipts"); } });
    const hugeReceipts: unknown[] = []; hugeReceipts.length = 257;
    for (const receipts of [receiptIterator, hugeReceipts, new Proxy([...image.receipts], { getPrototypeOf: () => { throw new Error("receipt proxy"); } })]) {
      expectFailure(() => InMemoryTransactionalPersistenceMedium.fromImageForTestOnly({ ...image, receipts } as typeof image), "INVALID");
    }
    expect(InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(image).openPortForTestOnly().recover().generation).toBe(2);
    // This unkeyed simulator cannot authenticate a complete older self-consistent image.
    expect(InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(olderWholeImage).openPortForTestOnly().recover().generation).toBe(1);
  });
});
