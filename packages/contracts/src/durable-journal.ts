import { z } from "zod";
import { CanonicalDurableIdSchema, EncryptedBlobRefSchema, EncryptedPayloadRefSchema } from "./useful-work.js";

/** Content-free metadata for a process-local durable-work journal boundary. */
export const DURABLE_JOURNAL_SCHEMA_VERSION = 1 as const;
export const DURABLE_JOURNAL_MAX_ITEMS = 4_096;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveIntegerSchema = z.number().int().positive().safe();
const IdSchema = CanonicalDurableIdSchema;

export const DurableJournalEnvelopeRefSchema = z.union([EncryptedPayloadRefSchema, EncryptedBlobRefSchema]);
export type DurableJournalEnvelopeRef = z.infer<typeof DurableJournalEnvelopeRefSchema>;

/** Each durable record has one explicit, non-sensitive idempotency key. */
export const DurableJournalIdempotencySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), idempotencyKeySha256: HashSchema }),
  z.strictObject({ kind: z.literal("run"), taskId: IdSchema, attempt: PositiveIntegerSchema }),
  z.strictObject({ kind: z.literal("revision"), reviewId: IdSchema, requestSha256: HashSchema }),
  z.strictObject({ kind: z.literal("receipt"), runId: IdSchema }),
  /** Stable entity identity for any other existing useful-work record or blob. */
  z.strictObject({ kind: z.literal("entity") })
]);
export type DurableJournalIdempotency = z.infer<typeof DurableJournalIdempotencySchema>;

/** Metadata for one opaque encrypted envelope; plaintext, paths, and execution inputs are absent. */
export const DurableJournalRecordSchema = z.strictObject({
  schemaVersion: z.literal(DURABLE_JOURNAL_SCHEMA_VERSION),
  id: IdSchema,
  spaceId: IdSchema,
  recordRevision: PositiveIntegerSchema,
  idempotency: DurableJournalIdempotencySchema,
  envelope: DurableJournalEnvelopeRefSchema
}).superRefine((value, ctx) => {
  if (value.envelope.spaceId !== value.spaceId || value.envelope.entityId !== value.id || value.envelope.contentRevision !== value.recordRevision) {
    ctx.addIssue({ code: "custom", path: ["envelope"], message: "Envelope binding does not match its journal record." });
  }
  const expectedKind = value.idempotency.kind === "task" ? "task"
    : value.idempotency.kind === "run" ? "run"
      : value.idempotency.kind === "revision" ? "revision-request" : "receipt";
  const specializedKind = value.envelope.entityKind === "task" || value.envelope.entityKind === "run" || value.envelope.entityKind === "revision-request" || value.envelope.entityKind === "receipt";
  if ((value.idempotency.kind !== "entity" && value.envelope.entityKind !== expectedKind) || (value.idempotency.kind === "entity" && specializedKind)) {
    ctx.addIssue({ code: "custom", path: ["idempotency"], message: "Idempotency key does not match the record kind." });
  }
});
export type DurableJournalRecord = z.infer<typeof DurableJournalRecordSchema>;

export const DurableJournalEventKindSchema = z.enum(["run-recorded", "effect-created", "effect-claimed", "effect-completed", "effect-failed", "effect-cancelled"]);
export type DurableJournalEventKind = z.infer<typeof DurableJournalEventKindSchema>;

/** Immutable ordered metadata for exactly one run; it never carries a prompt, body, or effect result. */
export const DurableJournalEventSchema = z.strictObject({
  schemaVersion: z.literal(DURABLE_JOURNAL_SCHEMA_VERSION),
  id: IdSchema,
  spaceId: IdSchema,
  runId: IdSchema,
  runRevision: PositiveIntegerSchema,
  sequence: PositiveIntegerSchema,
  kind: DurableJournalEventKindSchema,
  runCiphertextSha256: HashSchema,
  effectId: IdSchema.nullable(),
  effectRevision: PositiveIntegerSchema.nullable(),
  effectState: z.enum(["pending", "claimed", "completed", "failed", "cancelled"]).nullable(),
  claimSha256: HashSchema.nullable()
}).superRefine((value, ctx) => {
  const needsEffect = value.kind.startsWith("effect-");
  if (needsEffect !== (value.effectId !== null)) ctx.addIssue({ code: "custom", path: ["effectId"], message: "Effect event binding does not match its kind." });
  if (!needsEffect && (value.effectRevision !== null || value.effectState !== null || value.claimSha256 !== null)) ctx.addIssue({ code: "custom", path: ["effectRevision"], message: "Run events cannot carry effect metadata." });
  if (needsEffect && (value.effectRevision === null || value.effectState === null)) ctx.addIssue({ code: "custom", path: ["effectRevision"], message: "Effect events require resulting state metadata." });
  const expectedState = value.kind === "effect-created" ? "pending" : value.kind === "effect-claimed" ? "claimed" : value.kind === "effect-completed" ? "completed" : value.kind === "effect-failed" ? "failed" : value.kind === "effect-cancelled" ? "cancelled" : null;
  if (expectedState !== null && value.effectState !== expectedState) ctx.addIssue({ code: "custom", path: ["effectState"], message: "Effect event state does not match its kind." });
  if (value.kind === "effect-created" && (value.effectRevision !== 1 || value.claimSha256 !== null)) ctx.addIssue({ code: "custom", path: ["claimSha256"], message: "Effect creation must begin pending without a claim." });
  if ((value.kind === "effect-claimed" || value.kind === "effect-completed" || value.kind === "effect-failed") && value.claimSha256 === null) ctx.addIssue({ code: "custom", path: ["claimSha256"], message: "This effect event requires a claim digest." });
});
export type DurableJournalEvent = z.infer<typeof DurableJournalEventSchema>;

export const DurableEffectStateSchema = z.enum(["pending", "claimed", "completed", "failed", "cancelled"]);
export type DurableEffectState = z.infer<typeof DurableEffectStateSchema>;

/** Claim IDs are capability tokens. Lease freshness is revision-based, never time-based. */
export const DurableEffectSchema = z.strictObject({
  schemaVersion: z.literal(DURABLE_JOURNAL_SCHEMA_VERSION),
  id: IdSchema,
  spaceId: IdSchema,
  runId: IdSchema,
  runRevision: PositiveIntegerSchema,
  stepKey: IdSchema,
  requestSha256: HashSchema,
  state: DurableEffectStateSchema,
  effectRevision: PositiveIntegerSchema,
  claimId: IdSchema.nullable()
}).superRefine((value, ctx) => {
  const claimRequired = value.state === "claimed" || value.state === "completed" || value.state === "failed";
  if (claimRequired && value.claimId === null) ctx.addIssue({ code: "custom", path: ["claimId"], message: "This effect state requires a claim token." });
  if (value.state === "pending" && value.claimId !== null) ctx.addIssue({ code: "custom", path: ["claimId"], message: "A pending effect cannot have a claim token." });
  if (value.state === "cancelled" && value.claimId !== null) ctx.addIssue({ code: "custom", path: ["claimId"], message: "A cancelled effect cannot retain a claim token." });
});
export type DurableEffect = z.infer<typeof DurableEffectSchema>;

const EffectTransitions: Readonly<Record<DurableEffectState, readonly DurableEffectState[]>> = Object.freeze({
  pending: Object.freeze<DurableEffectState[]>(["claimed", "cancelled"]), claimed: Object.freeze<DurableEffectState[]>(["completed", "failed", "cancelled"]),
  completed: Object.freeze<DurableEffectState[]>([]), failed: Object.freeze<DurableEffectState[]>(["claimed", "cancelled"]), cancelled: Object.freeze<DurableEffectState[]>([])
});
export const DurableEffectTransitions = EffectTransitions;
export function canTransitionDurableEffect(from: DurableEffectState, to: DurableEffectState): boolean { return EffectTransitions[from].includes(to); }
export function eventBindsDurableRun(event: DurableJournalEvent, run: DurableJournalRecord): boolean {
  return run.idempotency.kind === "run" && event.spaceId === run.spaceId && event.runId === run.id && event.runRevision === run.recordRevision && event.runCiphertextSha256 === run.envelope.ciphertextSha256;
}
export function effectBindsDurableRun(effect: DurableEffect, run: DurableJournalRecord): boolean {
  return run.idempotency.kind === "run" && effect.spaceId === run.spaceId && effect.runId === run.id && effect.runRevision === run.recordRevision;
}
