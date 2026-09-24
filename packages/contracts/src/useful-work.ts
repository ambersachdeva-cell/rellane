import { z } from "zod";

const IsoDateSchema = z.iso.datetime({ offset: true });
/** Canonical durable identifiers are lowercase RFC UUIDs, never sentinel values. */
export const CanonicalDurableIdSchema = z.string().regex(
  /^(?!00000000-0000-0000-0000-000000000000$)(?!ffffffff-ffff-ffff-ffff-ffffffffffff$)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);
export type CanonicalDurableId = z.infer<typeof CanonicalDurableIdSchema>;
const IdSchema = CanonicalDurableIdSchema;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveRevisionSchema = z.number().int().positive().safe();
const Base64UrlNonce12Schema = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
const Base64UrlGcmTag16Schema = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);

export const USEFUL_WORK_SCHEMA_VERSION = 1 as const;
export const RECEIPT_V2_VERSION = 2 as const;
export const USEFUL_WORK_MAX_LINKS = 256;

const EntityKindSchema = z.enum([
  "space", "source", "source-snapshot", "source-span", "agent", "agent-version",
  "task", "run", "run-step", "artifact", "review", "revision-request",
  "permission-request", "permission-decision", "citation", "receipt",
  "capability-grant", "capability-grant-receipt", "capability-grant-index"
]);
export type UsefulWorkEntityKind = z.infer<typeof EntityKindSchema>;

const uniqueIds = <T extends { id: string }>(values: readonly T[], ctx: z.RefinementCtx) => {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "IDs must be unique." });
    ids.add(value.id);
  });
};

const uniqueStrings = (values: readonly string[], ctx: z.RefinementCtx) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", message: "Values must be unique." });
};

const validRecordTimes = (value: { createdAt: string; updatedAt: string }, ctx: z.RefinementCtx) => {
  if (Date.parse(value.createdAt) > Date.parse(value.updatedAt)) {
    ctx.addIssue({ code: "custom", path: ["updatedAt"], message: "A stored record cannot update before creation." });
  }
};

/** Public records retain only authenticated encrypted-reference metadata. */
export const EncryptedPayloadRefSchema = z.strictObject({
  envelopeVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION),
  spaceId: IdSchema,
  keyId: IdSchema,
  entityId: IdSchema,
  entityKind: EntityKindSchema,
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION),
  contentRevision: PositiveRevisionSchema,
  kind: z.literal("payload"),
  contentSha256: HashSchema,
  nonce: Base64UrlNonce12Schema,
  ciphertextRef: IdSchema,
  ciphertextSha256: HashSchema,
  tag: Base64UrlGcmTag16Schema
});
export type EncryptedPayloadRef = z.infer<typeof EncryptedPayloadRefSchema>;

export const EncryptedBlobRefSchema = z.strictObject({
  envelopeVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION),
  spaceId: IdSchema,
  keyId: IdSchema,
  entityId: IdSchema,
  entityKind: EntityKindSchema,
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION),
  contentRevision: PositiveRevisionSchema,
  kind: z.literal("blob"),
  contentSha256: HashSchema,
  nonce: Base64UrlNonce12Schema,
  ciphertextRef: IdSchema,
  ciphertextSha256: HashSchema,
  tag: Base64UrlGcmTag16Schema
});
export type EncryptedBlobRef = z.infer<typeof EncryptedBlobRefSchema>;

const payloadFor = (entityKind: UsefulWorkEntityKind) => (
  value: { id: string; spaceId: string; payload: EncryptedPayloadRef }, ctx: z.RefinementCtx
) => {
  if (value.payload.spaceId !== value.spaceId || value.payload.entityId !== value.id || value.payload.entityKind !== entityKind) {
    ctx.addIssue({ code: "custom", path: ["payload"], message: "Payload binding does not match its record." });
  }
};

const blobFor = (entityKind: UsefulWorkEntityKind) => (
  value: { id: string; spaceId: string; blob: EncryptedBlobRef }, ctx: z.RefinementCtx
) => {
  if (value.blob.spaceId !== value.spaceId || value.blob.entityId !== value.id || value.blob.entityKind !== entityKind) {
    ctx.addIssue({ code: "custom", path: ["blob"], message: "Blob binding does not match its record." });
  }
};

export const SpaceStateSchema = z.enum(["active", "locked", "deleting", "deleted"]);
export type SpaceState = z.infer<typeof SpaceStateSchema>;
export const SpaceSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, keyId: IdSchema,
  state: SpaceStateSchema, recordRevision: PositiveRevisionSchema,
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => {
  validRecordTimes(value, ctx);
  if (value.payload.spaceId !== value.id || value.payload.keyId !== value.keyId || value.payload.entityId !== value.id || value.payload.entityKind !== "space") {
    ctx.addIssue({ code: "custom", path: ["payload"], message: "Payload binding does not match its space." });
  }
});
export type Space = z.infer<typeof SpaceSchema>;

export const SourceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), outcome: z.literal("captured"),
  id: IdSchema, spaceId: IdSchema, sourceId: IdSchema, capturedAt: IsoDateSchema, blob: EncryptedBlobRefSchema
}).superRefine(blobFor("source-snapshot"));
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

export const SkippedSourceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), outcome: z.literal("skipped"),
  id: IdSchema, spaceId: IdSchema, sourceId: IdSchema, observedAt: IsoDateSchema,
  reason: z.enum(["not-readable", "too-large", "unsupported", "permission-denied", "cancelled"])
});
export type SkippedSourceSnapshot = z.infer<typeof SkippedSourceSnapshotSchema>;
export const SourceSnapshotOutcomeSchema = z.discriminatedUnion("outcome", [SourceSnapshotSchema, SkippedSourceSnapshotSchema]);
export type SourceSnapshotOutcome = z.infer<typeof SourceSnapshotOutcomeSchema>;

export const SourceStateSchema = z.enum(["available", "removed"]);
export type SourceState = z.infer<typeof SourceStateSchema>;
export const SourceSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema,
  state: SourceStateSchema, recordRevision: PositiveRevisionSchema, snapshot: SourceSnapshotOutcomeSchema,
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => {
  validRecordTimes(value, ctx);
  payloadFor("source")(value, ctx);
  if (value.snapshot.spaceId !== value.spaceId || value.snapshot.sourceId !== value.id) {
    ctx.addIssue({ code: "custom", path: ["snapshot"], message: "Snapshot does not belong to its source." });
  }
});
export type Source = z.infer<typeof SourceSchema>;

export const SourceSpanSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, sourceId: IdSchema, snapshotId: IdSchema,
  startOffset: z.number().int().nonnegative().safe(), endOffset: z.number().int().nonnegative().safe(), contentSha256: HashSchema,
  payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => {
  payloadFor("source-span")(value, ctx);
  if (value.endOffset <= value.startOffset) ctx.addIssue({ code: "custom", path: ["endOffset"], message: "A span must have a positive extent." });
});
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export const AgentStateSchema = z.enum(["active", "retired"]);
export type AgentState = z.infer<typeof AgentStateSchema>;
export const AgentSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, kind: z.literal("built-in"),
  state: AgentStateSchema, recordRevision: PositiveRevisionSchema, currentVersionId: IdSchema,
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => { validRecordTimes(value, ctx); payloadFor("agent")(value, ctx); });
export type Agent = z.infer<typeof AgentSchema>;

export const AgentVersionSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, agentId: IdSchema,
  version: PositiveRevisionSchema, immutable: z.literal(true), contentSha256: HashSchema,
  createdAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine(payloadFor("agent-version"));
export type AgentVersion = z.infer<typeof AgentVersionSchema>;

export const TaskStateSchema = z.enum(["draft", "ready", "running", "completed", "failed", "cancelled", "interrupted"]);
export type TaskState = z.infer<typeof TaskStateSchema>;
export const TaskSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, state: TaskStateSchema,
  recordRevision: PositiveRevisionSchema, agentVersionId: IdSchema,
  sourceSnapshotIds: z.array(IdSchema).max(USEFUL_WORK_MAX_LINKS).superRefine(uniqueStrings),
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => { validRecordTimes(value, ctx); payloadFor("task")(value, ctx); });
export type Task = z.infer<typeof TaskSchema>;

export const RunStateSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted"]);
export type RunState = z.infer<typeof RunStateSchema>;
export const RunSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, taskId: IdSchema, agentVersionId: IdSchema,
  state: RunStateSchema, recordRevision: PositiveRevisionSchema, createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => { validRecordTimes(value, ctx); payloadFor("run")(value, ctx); });
export type Run = z.infer<typeof RunSchema>;

export const RunStepStateSchema = z.enum(["pending", "running", "completed", "failed", "skipped", "cancelled", "interrupted"]);
export type RunStepState = z.infer<typeof RunStepStateSchema>;
export const RunStepSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, runId: IdSchema,
  sequence: z.number().int().nonnegative().safe(), state: RunStepStateSchema, recordRevision: PositiveRevisionSchema,
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => { validRecordTimes(value, ctx); payloadFor("run-step")(value, ctx); });
export type RunStep = z.infer<typeof RunStepSchema>;

export const ArtifactStateSchema = z.enum(["draft", "ready", "superseded", "deleted"]);
export type ArtifactState = z.infer<typeof ArtifactStateSchema>;
export const ArtifactSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, runId: IdSchema,
  state: ArtifactStateSchema, recordRevision: PositiveRevisionSchema, createdAt: IsoDateSchema, updatedAt: IsoDateSchema,
  blob: EncryptedBlobRefSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => {
  validRecordTimes(value, ctx);
  blobFor("artifact")({ id: value.id, spaceId: value.spaceId, blob: value.blob }, ctx);
  payloadFor("artifact")(value, ctx);
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ReviewStateSchema = z.enum(["open", "accepted", "changes-requested", "dismissed"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;
export const ReviewSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, artifactId: IdSchema,
  state: ReviewStateSchema, recordRevision: PositiveRevisionSchema, createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => { validRecordTimes(value, ctx); payloadFor("review")(value, ctx); });
export type Review = z.infer<typeof ReviewSchema>;

export const RevisionRequestStateSchema = z.enum(["open", "addressed", "cancelled"]);
export type RevisionRequestState = z.infer<typeof RevisionRequestStateSchema>;
export const RevisionRequestSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, reviewId: IdSchema, artifactId: IdSchema,
  state: RevisionRequestStateSchema, recordRevision: PositiveRevisionSchema,
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => { validRecordTimes(value, ctx); payloadFor("revision-request")(value, ctx); });
export type RevisionRequest = z.infer<typeof RevisionRequestSchema>;

export const PermissionRequestStateSchema = z.enum(["pending", "decided", "expired", "cancelled"]);
export type PermissionRequestState = z.infer<typeof PermissionRequestStateSchema>;
export const PermissionRequestSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, runId: IdSchema, effectId: IdSchema,
  requestKind: z.enum(["read-source", "write-artifact", "export", "delete"]), requestSha256: HashSchema, targetId: IdSchema, targetSha256: HashSchema,
  state: PermissionRequestStateSchema, recordRevision: PositiveRevisionSchema, expiresAt: IsoDateSchema,
  createdAt: IsoDateSchema, updatedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => {
  validRecordTimes(value, ctx);
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "A permission request must expire after creation." });
  payloadFor("permission-request")(value, ctx);
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionDecisionSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, requestId: IdSchema, effectId: IdSchema,
  requestSha256: HashSchema, decision: z.enum(["granted", "denied"]), decidedAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine(payloadFor("permission-decision"));
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const CitationSchema = z.strictObject({
  schemaVersion: z.literal(USEFUL_WORK_SCHEMA_VERSION), id: IdSchema, spaceId: IdSchema, artifactId: IdSchema, artifactContentSha256: HashSchema,
  sourceId: IdSchema, snapshotId: IdSchema, snapshotContentSha256: HashSchema, sourceSpanId: IdSchema, sourceSpanSha256: HashSchema,
  createdAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine(payloadFor("citation"));
export type Citation = z.infer<typeof CitationSchema>;

const ReceiptCheckSchema = z.strictObject({ id: IdSchema, outcome: z.enum(["passed", "failed", "not-run"]), evidenceRef: IdSchema });
const ReceiptOutputSchema = z.strictObject({ id: IdSchema, artifactId: IdSchema, artifactContentSha256: HashSchema });
const ReceiptErrorEvidenceSchema = z.strictObject({
  id: IdSchema, code: z.enum(["operation-failed", "operation-cancelled", "operation-interrupted", "recovery-required"])
});
const UnobservedActivitySchema = z.strictObject({
  id: IdSchema, kind: z.enum(["model-execution", "filesystem-effect", "network-egress", "external-effect", "check"]), targetId: IdSchema,
  reason: z.enum(["not-attempted", "not-observed", "interrupted-before-observation", "not-applicable"])
});
const ObservedEvidenceSchema = z.strictObject({
  id: IdSchema, kind: z.enum(["input", "output", "permission", "citation", "check", "effect"]),
  targetId: IdSchema, contentSha256: HashSchema.nullable()
});
const EffectTargetSchema = z.strictObject({ id: IdSchema, contentSha256: HashSchema });

const hasObserved = (value: { observedEvidence: readonly z.infer<typeof ObservedEvidenceSchema>[] }, kind: string, targetId: string, contentSha256?: string | null) =>
  value.observedEvidence.some((evidence) => evidence.kind === kind && evidence.targetId === targetId &&
    (contentSha256 === undefined || evidence.contentSha256 === contentSha256));

export const ReceiptV2Schema = z.strictObject({
  receiptVersion: z.literal(RECEIPT_V2_VERSION), id: IdSchema, spaceId: IdSchema, runId: IdSchema.nullable(), authorizationRunId: IdSchema.nullable(), effectId: IdSchema, effectTarget: EffectTargetSchema.nullable(),
  receiptKind: z.enum(["run", "export", "deletion"]), execution: z.enum(["observed", "not-claimed"]),
  status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  output: z.array(ReceiptOutputSchema).max(USEFUL_WORK_MAX_LINKS).superRefine((values, ctx) => {
    uniqueIds(values, ctx); uniqueStrings(values.map((value) => value.artifactId), ctx);
  }),
  citationIds: z.array(IdSchema).max(USEFUL_WORK_MAX_LINKS).superRefine(uniqueStrings),
  permissionDecisionIds: z.array(IdSchema).max(USEFUL_WORK_MAX_LINKS).superRefine(uniqueStrings),
  checks: z.array(ReceiptCheckSchema).max(USEFUL_WORK_MAX_LINKS).superRefine(uniqueIds),
  observedEvidence: z.array(ObservedEvidenceSchema).max(USEFUL_WORK_MAX_LINKS).superRefine(uniqueIds),
  errors: z.array(ReceiptErrorEvidenceSchema).max(32).superRefine(uniqueIds),
  unobservedActivity: z.array(UnobservedActivitySchema).max(32).superRefine(uniqueIds),
  createdAt: IsoDateSchema, payload: EncryptedPayloadRefSchema
}).superRefine((value, ctx) => {
  payloadFor("receipt")(value, ctx);
  const observedIds = new Set(value.observedEvidence.map((evidence) => evidence.id));
  const unobservedIds = new Set(value.unobservedActivity.map((activity) => activity.id));
  if (value.observedEvidence.some((evidence) => unobservedIds.has(evidence.id))) {
    ctx.addIssue({ code: "custom", message: "Observed and unobserved evidence IDs must be disjoint." });
  }
  for (const check of value.checks) {
    if (check.outcome === "passed" || check.outcome === "failed") {
      const evidence = value.observedEvidence.find((item) => item.id === check.evidenceRef);
      if (evidence === undefined || evidence.kind !== "check" || evidence.targetId !== check.id) {
        ctx.addIssue({ code: "custom", path: ["checks"], message: "Observed checks require their own observed check evidence." });
      }
    }
    if (check.outcome === "not-run") {
      const activity = value.unobservedActivity.find((item) => item.id === check.evidenceRef);
      if (activity === undefined || activity.kind !== "check" || activity.targetId !== check.id) {
        ctx.addIssue({ code: "custom", path: ["checks"], message: "Not-run checks require their own unobserved check evidence." });
      }
    }
  }
  if (value.receiptKind === "run" && (value.runId === null || value.authorizationRunId !== null || value.effectTarget !== null)) ctx.addIssue({ code: "custom", path: ["runId"], message: "Run receipts require a run ID and no effect authorization target." });
  if (value.receiptKind !== "run" && value.runId !== null) {
    ctx.addIssue({ code: "custom", message: "Export and deletion receipts cannot claim a run." });
  }
  if (value.receiptKind !== "run" && (value.authorizationRunId === null || value.effectTarget === null)) {
    ctx.addIssue({ code: "custom", message: "Export and deletion receipts require an authorization run and opaque effect target." });
  }
  if (value.execution === "not-claimed" && value.status === "completed") {
    ctx.addIssue({ code: "custom", message: "Unclaimed execution cannot be completed." });
  }
  if (value.execution === "observed" && value.observedEvidence.length === 0) {
    ctx.addIssue({ code: "custom", message: "Observed execution requires observed evidence." });
  }
  if (value.status === "completed") {
    if (value.execution !== "observed" || value.observedEvidence.length === 0 || value.errors.length > 0 || value.checks.some((check) => check.outcome === "failed" || check.outcome === "not-run")) {
      ctx.addIssue({ code: "custom", message: "Completed receipts require observed evidence and no failures." });
    }
    if (value.receiptKind === "run") {
      if (value.output.length === 0 || value.citationIds.length === 0 ||
        value.output.some((output) => !hasObserved(value, "output", output.id, output.artifactContentSha256)) ||
        value.citationIds.some((citationId) => !hasObserved(value, "citation", citationId, null))) {
        ctx.addIssue({ code: "custom", message: "Completed runs require observed output and citation evidence." });
      }
    }
    if (value.output.some((output) => !hasObserved(value, "output", output.id, output.artifactContentSha256)) ||
      value.permissionDecisionIds.some((decisionId) => !hasObserved(value, "permission", decisionId, null))) {
      ctx.addIssue({ code: "custom", message: "Completed receipts require observed output and permission evidence." });
    }
    if (value.receiptKind === "export") {
      if (value.output.length === 0 || value.permissionDecisionIds.length === 0 ||
        value.permissionDecisionIds.some((decisionId) => !hasObserved(value, "permission", decisionId, null)) ||
        !hasObserved(value, "effect", value.effectId, null)) {
        ctx.addIssue({ code: "custom", message: "Completed exports require output, permission, and effect evidence." });
      }
    }
    if (value.receiptKind === "deletion") {
      if (value.output.length !== 0 || value.citationIds.length !== 0 || value.permissionDecisionIds.length === 0 ||
        value.permissionDecisionIds.some((decisionId) => !hasObserved(value, "permission", decisionId, null)) ||
        !hasObserved(value, "effect", value.effectId, null)) {
        ctx.addIssue({ code: "custom", message: "Completed deletions require only observed permission and effect evidence." });
      }
    }
  } else {
    const expectedErrors = {
      failed: ["operation-failed", "recovery-required"],
      cancelled: ["operation-cancelled"],
      interrupted: ["operation-interrupted", "recovery-required"]
    } as const;
    const hasStatusError = value.errors.some((error) => (expectedErrors[value.status as keyof typeof expectedErrors] ?? []).includes(error.code as never));
    const hasMeaningfulUnobserved = value.unobservedActivity.some((activity) => activity.reason !== "not-applicable");
    if (!hasStatusError && !hasMeaningfulUnobserved) {
      ctx.addIssue({ code: "custom", message: "Non-completed receipts require status-appropriate error or meaningful unobserved evidence." });
    }
  }
});
export type ReceiptV2 = z.infer<typeof ReceiptV2Schema>;

type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;
const stateMap = <S extends string>(value: TransitionMap<S>): TransitionMap<S> => {
  for (const transitions of Object.values(value)) Object.freeze(transitions);
  return Object.freeze(value);
};
export const SpaceTransitions = stateMap<SpaceState>({ active: ["locked", "deleting"], locked: ["active", "deleting"], deleting: ["deleted"], deleted: [] });
export const SourceTransitions = stateMap<SourceState>({ available: ["removed"], removed: [] });
export const AgentTransitions = stateMap<AgentState>({ active: ["retired"], retired: [] });
export const TaskTransitions = stateMap<TaskState>({ draft: ["ready", "cancelled"], ready: ["running", "cancelled"], running: ["completed", "failed", "cancelled", "interrupted"], interrupted: ["ready", "failed", "cancelled"], completed: [], failed: [], cancelled: [] });
export const RunTransitions = stateMap<RunState>({ queued: ["running", "cancelled"], running: ["completed", "failed", "cancelled", "interrupted"], interrupted: ["queued", "failed", "cancelled"], completed: [], failed: [], cancelled: [] });
export const RunStepTransitions = stateMap<RunStepState>({ pending: ["running", "skipped", "cancelled"], running: ["completed", "failed", "cancelled", "interrupted"], interrupted: ["pending", "failed", "cancelled"], completed: [], failed: [], skipped: [], cancelled: [] });
export const ArtifactTransitions = stateMap<ArtifactState>({ draft: ["ready", "deleted"], ready: ["superseded", "deleted"], superseded: ["deleted"], deleted: [] });
export const ReviewTransitions = stateMap<ReviewState>({ open: ["accepted", "changes-requested", "dismissed"], accepted: [], "changes-requested": [], dismissed: [] });
export const RevisionRequestTransitions = stateMap<RevisionRequestState>({ open: ["addressed", "cancelled"], addressed: [], cancelled: [] });
export const PermissionRequestTransitions = stateMap<PermissionRequestState>({ pending: ["decided", "expired", "cancelled"], decided: [], expired: [], cancelled: [] });

type StatefulRecord<S extends string> = { state: S; recordRevision: number; createdAt: string; updatedAt: string };
type Parser<T> = { parse(input: unknown): T };
const transition = <S extends string, T extends StatefulRecord<S>>(
  schema: Parser<T>, entity: unknown, nextState: S, transitions: TransitionMap<S>, updatedAt: unknown
): Readonly<T> => {
  const current = schema.parse(entity);
  const nextUpdatedAt = IsoDateSchema.parse(updatedAt);
  const nextTime = Date.parse(nextUpdatedAt);
  if (nextTime <= Date.parse(current.updatedAt) || nextTime < Date.parse(current.createdAt)) {
    throw new Error("The lifecycle update time must advance the record.");
  }
  if (!transitions[current.state].includes(nextState)) throw new Error("The requested lifecycle transition is not allowed.");
  return Object.freeze(schema.parse({ ...current, state: nextState, updatedAt: nextUpdatedAt, recordRevision: current.recordRevision + 1 }));
};

const canTransition = <S extends string>(map: TransitionMap<S>, from: S, to: S) => map[from].includes(to);
export const canTransitionSpace = (from: SpaceState, to: SpaceState) => canTransition(SpaceTransitions, from, to);
export const canTransitionSource = (from: SourceState, to: SourceState) => canTransition(SourceTransitions, from, to);
export const canTransitionAgent = (from: AgentState, to: AgentState) => canTransition(AgentTransitions, from, to);
export const canTransitionTask = (from: TaskState, to: TaskState) => canTransition(TaskTransitions, from, to);
export const canTransitionRun = (from: RunState, to: RunState) => canTransition(RunTransitions, from, to);
export const canTransitionRunStep = (from: RunStepState, to: RunStepState) => canTransition(RunStepTransitions, from, to);
export const canTransitionArtifact = (from: ArtifactState, to: ArtifactState) => canTransition(ArtifactTransitions, from, to);
export const canTransitionReview = (from: ReviewState, to: ReviewState) => canTransition(ReviewTransitions, from, to);
export const canTransitionRevisionRequest = (from: RevisionRequestState, to: RevisionRequestState) => canTransition(RevisionRequestTransitions, from, to);
export const canTransitionPermissionRequest = (from: PermissionRequestState, to: PermissionRequestState) => canTransition(PermissionRequestTransitions, from, to);

export const transitionSpace = (value: unknown, state: SpaceState, updatedAt: unknown) => transition(SpaceSchema, value, state, SpaceTransitions, updatedAt);
export const transitionSource = (value: unknown, state: SourceState, updatedAt: unknown) => transition(SourceSchema, value, state, SourceTransitions, updatedAt);
export const transitionAgent = (value: unknown, state: AgentState, updatedAt: unknown) => transition(AgentSchema, value, state, AgentTransitions, updatedAt);
export const transitionTask = (value: unknown, state: TaskState, updatedAt: unknown) => transition(TaskSchema, value, state, TaskTransitions, updatedAt);
export const transitionRun = (value: unknown, state: RunState, updatedAt: unknown) => transition(RunSchema, value, state, RunTransitions, updatedAt);
export const transitionRunStep = (value: unknown, state: RunStepState, updatedAt: unknown) => transition(RunStepSchema, value, state, RunStepTransitions, updatedAt);
export const transitionArtifact = (value: unknown, state: ArtifactState, updatedAt: unknown) => transition(ArtifactSchema, value, state, ArtifactTransitions, updatedAt);
export const transitionReview = (value: unknown, state: ReviewState, updatedAt: unknown) => transition(ReviewSchema, value, state, ReviewTransitions, updatedAt);
export const transitionRevisionRequest = (value: unknown, state: RevisionRequestState, updatedAt: unknown) => transition(RevisionRequestSchema, value, state, RevisionRequestTransitions, updatedAt);
export const transitionPermissionRequest = (value: unknown, state: PermissionRequestState, updatedAt: unknown) => transition(PermissionRequestSchema, value, state, PermissionRequestTransitions, updatedAt);

/** This checks an in-memory consumed request-ID set only; future durable transactions must atomically enforce single use. */
export const canUsePermissionDecision = (requestInput: unknown, decisionInput: unknown, usedAt: unknown, consumedRequestIds: ReadonlySet<string>) => {
  const request = PermissionRequestSchema.safeParse(requestInput);
  const decision = PermissionDecisionSchema.safeParse(decisionInput);
  const useTime = IsoDateSchema.safeParse(usedAt);
  if (!request.success || !decision.success || !useTime.success) return false;
  const requestValue = request.data;
  const decisionValue = decision.data;
  const decisionTime = Date.parse(decisionValue.decidedAt);
  const useTimeMs = Date.parse(useTime.data);
  return requestValue.state === "decided" && decisionValue.decision === "granted" &&
    requestValue.spaceId === decisionValue.spaceId && requestValue.id === decisionValue.requestId &&
    requestValue.requestSha256 === decisionValue.requestSha256 && requestValue.effectId === decisionValue.effectId &&
    decisionTime >= Date.parse(requestValue.createdAt) && decisionTime <= Date.parse(requestValue.expiresAt) &&
    useTimeMs >= decisionTime && useTimeMs <= Date.parse(requestValue.expiresAt) && !consumedRequestIds.has(requestValue.id);
};

export const agentVersionBindsAgent = (agentInput: unknown, versionInput: unknown) => {
  const agent = AgentSchema.safeParse(agentInput); const version = AgentVersionSchema.safeParse(versionInput);
  return agent.success && version.success && agent.data.spaceId === version.data.spaceId && agent.data.id === version.data.agentId && agent.data.currentVersionId === version.data.id;
};
export const taskBindsRelations = (taskInput: unknown, versionInput: unknown, snapshotInputs: readonly unknown[]) => {
  const task = TaskSchema.safeParse(taskInput); const version = AgentVersionSchema.safeParse(versionInput);
  const snapshots = snapshotInputs.map((snapshot) => SourceSnapshotOutcomeSchema.safeParse(snapshot));
  return task.success && version.success && snapshots.every((snapshot) => snapshot.success) &&
    task.data.spaceId === version.data.spaceId && task.data.agentVersionId === version.data.id &&
    task.data.sourceSnapshotIds.length === snapshots.length && task.data.sourceSnapshotIds.every((id) => snapshots.some((snapshot) => snapshot.success && snapshot.data.id === id && snapshot.data.spaceId === task.data.spaceId));
};
export const runBindsTaskAndVersion = (runInput: unknown, taskInput: unknown, versionInput: unknown) => {
  const run = RunSchema.safeParse(runInput); const task = TaskSchema.safeParse(taskInput); const version = AgentVersionSchema.safeParse(versionInput);
  return run.success && task.success && version.success && run.data.spaceId === task.data.spaceId && run.data.spaceId === version.data.spaceId && run.data.taskId === task.data.id && run.data.agentVersionId === task.data.agentVersionId && run.data.agentVersionId === version.data.id;
};
export const artifactBindsRun = (artifactInput: unknown, runInput: unknown) => {
  const artifact = ArtifactSchema.safeParse(artifactInput); const run = RunSchema.safeParse(runInput);
  return artifact.success && run.success && artifact.data.spaceId === run.data.spaceId && artifact.data.runId === run.data.id;
};
export const reviewBindsArtifact = (reviewInput: unknown, artifactInput: unknown) => {
  const review = ReviewSchema.safeParse(reviewInput); const artifact = ArtifactSchema.safeParse(artifactInput);
  return review.success && artifact.success && review.data.spaceId === artifact.data.spaceId && review.data.artifactId === artifact.data.id;
};
export const revisionRequestBindsReviewAndArtifact = (requestInput: unknown, reviewInput: unknown, artifactInput: unknown) => {
  const request = RevisionRequestSchema.safeParse(requestInput); const review = ReviewSchema.safeParse(reviewInput); const artifact = ArtifactSchema.safeParse(artifactInput);
  return request.success && review.success && artifact.success && request.data.spaceId === review.data.spaceId && request.data.spaceId === artifact.data.spaceId && request.data.reviewId === review.data.id && request.data.artifactId === artifact.data.id && review.data.artifactId === artifact.data.id;
};
export const permissionRequestBindsRun = (requestInput: unknown, runInput: unknown) => {
  const request = PermissionRequestSchema.safeParse(requestInput); const run = RunSchema.safeParse(runInput);
  return request.success && run.success && request.data.spaceId === run.data.spaceId && request.data.runId === run.data.id;
};

export const citationBindsRecords = (citationInput: unknown, sourceInput: unknown, spanInput: unknown, artifactInput: unknown) => {
  const citation = CitationSchema.safeParse(citationInput); const source = SourceSchema.safeParse(sourceInput);
  const span = SourceSpanSchema.safeParse(spanInput); const artifact = ArtifactSchema.safeParse(artifactInput);
  return citation.success && source.success && span.success && artifact.success && source.data.snapshot.outcome === "captured" &&
    citation.data.spaceId === source.data.spaceId && citation.data.spaceId === span.data.spaceId && citation.data.spaceId === artifact.data.spaceId &&
    citation.data.sourceId === source.data.id && citation.data.snapshotId === source.data.snapshot.id && citation.data.snapshotContentSha256 === source.data.snapshot.blob.contentSha256 &&
    citation.data.sourceSpanId === span.data.id && citation.data.sourceSpanSha256 === span.data.contentSha256 && span.data.sourceId === source.data.id && span.data.snapshotId === source.data.snapshot.id &&
    citation.data.artifactId === artifact.data.id && citation.data.artifactContentSha256 === artifact.data.blob.contentSha256;
};

const ReceiptBindingInputsSchema = z.strictObject({
  artifacts: z.array(z.unknown()).max(USEFUL_WORK_MAX_LINKS),
  citations: z.array(z.unknown()).max(USEFUL_WORK_MAX_LINKS),
  decisions: z.array(z.unknown()).max(USEFUL_WORK_MAX_LINKS),
  requests: z.array(z.unknown()).max(USEFUL_WORK_MAX_LINKS),
  runs: z.array(z.unknown()).max(USEFUL_WORK_MAX_LINKS)
});

/** Pure record binding only; future durable transactions must atomically consume the approved request. */
export const receiptBindsRecords = (receiptInput: unknown, bindingInputs: unknown) => {
  const receipt = ReceiptV2Schema.safeParse(receiptInput);
  const inputs = ReceiptBindingInputsSchema.safeParse(bindingInputs);
  if (!receipt.success || !inputs.success) return false;
  const artifacts = inputs.data.artifacts.map((artifact) => ArtifactSchema.safeParse(artifact));
  const citations = inputs.data.citations.map((citation) => CitationSchema.safeParse(citation));
  const decisions = inputs.data.decisions.map((decision) => PermissionDecisionSchema.safeParse(decision));
  const requests = inputs.data.requests.map((request) => PermissionRequestSchema.safeParse(request));
  const runs = inputs.data.runs.map((run) => RunSchema.safeParse(run));
  if (!artifacts.every((item) => item.success) || !citations.every((item) => item.success) || !decisions.every((item) => item.success) || !requests.every((item) => item.success) || !runs.every((item) => item.success)) return false;
  const value = receipt.data;
  const artifactById = new Map(artifacts.map((item) => [item.data.id, item.data]));
  const citationById = new Map(citations.map((item) => [item.data.id, item.data]));
  const decisionById = new Map(decisions.map((item) => [item.data.id, item.data]));
  const requestById = new Map(requests.map((item) => [item.data.id, item.data]));
  const runById = new Map(runs.map((item) => [item.data.id, item.data]));
  const originRunId = value.receiptKind === "run" ? value.runId : value.authorizationRunId;
  const originRun = originRunId === null ? undefined : runById.get(originRunId);
  return originRun !== undefined && originRun.spaceId === value.spaceId && value.output.every((output) => {
    const artifact = artifactById.get(output.artifactId);
    return artifact !== undefined && artifact.spaceId === value.spaceId && artifact.blob.contentSha256 === output.artifactContentSha256 &&
      artifact.runId === originRunId;
  }) && value.citationIds.every((citationId) => {
    const citation = citationById.get(citationId);
    return citation !== undefined && citation.spaceId === value.spaceId && value.output.some((output) => output.artifactId === citation.artifactId && output.artifactContentSha256 === citation.artifactContentSha256);
  }) && value.permissionDecisionIds.every((decisionId) => {
    const decision = decisionById.get(decisionId);
    const request = decision === undefined ? undefined : requestById.get(decision.requestId);
    const exactDecision = decision !== undefined && request !== undefined && decision.spaceId === value.spaceId && decision.decision === "granted" &&
      decision.requestId === request.id && decision.requestSha256 === request.requestSha256 && decision.effectId === request.effectId && request.spaceId === value.spaceId &&
      canUsePermissionDecision(request, decision, value.createdAt, new Set());
    if (!exactDecision || request === undefined) return false;
    if (value.receiptKind === "run") {
      return value.runId !== null && request.runId === value.runId && (request.requestKind === "read-source" || request.requestKind === "write-artifact");
    }
    const requestKind = value.receiptKind === "export" ? "export" : "delete";
    return value.effectTarget !== null && request.runId === value.authorizationRunId && request.effectId === value.effectId &&
      request.targetId === value.effectTarget.id && request.targetSha256 === value.effectTarget.contentSha256 && request.requestKind === requestKind;
  });
};
