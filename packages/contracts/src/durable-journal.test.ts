import { describe, expect, it } from "vitest";
import { DurableEffectSchema, DurableJournalEventSchema, DurableJournalRecordSchema, canTransitionDurableEffect, effectBindsDurableRun, eventBindsDurableRun } from "./durable-journal.js";
import * as publicContracts from "./index.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string) => value.repeat(64).slice(0, 64);
const spaceId = id(1); const taskId = id(2); const runId = id(3);
const task = { schemaVersion: 1, id: taskId, spaceId, recordRevision: 1, idempotency: { kind: "task", idempotencyKeySha256: hash("a") }, envelope: { envelopeVersion: 1, spaceId, keyId: id(4), entityId: taskId, entityKind: "task", schemaVersion: 1, contentRevision: 1, kind: "payload", contentSha256: hash("b"), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: id(5), ciphertextSha256: hash("c"), tag: "AAAAAAAAAAAAAAAAAAAAAA" } } as const;
const run = { ...task, id: runId, idempotency: { kind: "run", taskId, attempt: 1 }, envelope: { ...task.envelope, entityId: runId, entityKind: "run", ciphertextRef: id(6) } } as const;
const event = { schemaVersion: 1, id: id(7), spaceId, runId, runRevision: 1, sequence: 1, kind: "run-recorded", runCiphertextSha256: run.envelope.ciphertextSha256, effectId: null, effectRevision: null, effectState: null, claimSha256: null } as const;
const effect = { schemaVersion: 1, id: id(8), spaceId, runId, runRevision: 1, stepKey: id(9), requestSha256: hash("d"), state: "pending", effectRevision: 1, claimId: null } as const;

describe("durable journal persistence contracts", () => {
  it("admits only encrypted-reference records with exact task/run idempotency bindings", () => {
    expect(DurableJournalRecordSchema.parse(task)).toEqual(task); expect(DurableJournalRecordSchema.parse(run)).toEqual(run);
    expect(DurableJournalRecordSchema.safeParse({ ...task, plaintext: "private work" }).success).toBe(false);
    expect(DurableJournalRecordSchema.safeParse({ ...task, prompt: "private work" }).success).toBe(false);
    expect(DurableJournalRecordSchema.safeParse({ ...task, path: "/private/work" }).success).toBe(false);
    expect(DurableJournalRecordSchema.safeParse({ ...task, secret: "private work" }).success).toBe(false);
    expect(DurableJournalRecordSchema.safeParse({ ...run, envelope: { ...run.envelope, entityId: id(10) } }).success).toBe(false);
    expect(DurableJournalRecordSchema.safeParse({ ...run, idempotency: { kind: "task", idempotencyKeySha256: hash("e") } }).success).toBe(false);
    expect(DurableJournalRecordSchema.parse({ ...task, id: id(13), idempotency: { kind: "entity" }, envelope: { ...task.envelope, entityId: id(13), entityKind: "artifact" } }).idempotency.kind).toBe("entity");
    expect(DurableJournalRecordSchema.safeParse({ ...task, idempotency: { kind: "entity" } }).success).toBe(false);
    for (const entityKind of ["capability-grant", "capability-grant-receipt", "capability-grant-index"] as const) {
      const value = { ...task, id: id(entityKind.length + 20), idempotency: { kind: "entity" as const }, envelope: { ...task.envelope, entityId: id(entityKind.length + 20), entityKind } };
      expect(DurableJournalRecordSchema.safeParse(value).success).toBe(true);
      expect(DurableJournalRecordSchema.safeParse({ ...value, idempotency: task.idempotency }).success).toBe(false);
    }
  });
  it("binds immutable event/effect metadata to the exact run context", () => {
    expect(DurableJournalEventSchema.parse(event)).toEqual(event); expect(DurableEffectSchema.parse(effect)).toEqual(effect);
    expect(eventBindsDurableRun(event, run)).toBe(true); expect(effectBindsDurableRun(effect, run)).toBe(true);
    expect(eventBindsDurableRun({ ...event, runCiphertextSha256: hash("f") }, run)).toBe(false);
    expect(effectBindsDurableRun({ ...effect, spaceId: id(11) }, run)).toBe(false);
    expect(DurableJournalEventSchema.safeParse({ ...event, kind: "effect-created" }).success).toBe(false);
  });
  it("requires capability claims and blocks terminal transitions", () => {
    expect(DurableEffectSchema.safeParse({ ...effect, state: "claimed", claimId: null }).success).toBe(false);
    expect(DurableEffectSchema.parse({ ...effect, state: "claimed", effectRevision: 2, claimId: id(12) }).claimId).toBe(id(12));
    expect(canTransitionDurableEffect("pending", "claimed")).toBe(true); expect(canTransitionDurableEffect("completed", "claimed")).toBe(false);
  });
  it("keeps the journal boundary out of the public contracts barrel", () => {
    expect("DurableJournalRecordSchema" in publicContracts).toBe(false);
    expect("InMemoryJournalImageSchema" in publicContracts).toBe(false);
  });
});
