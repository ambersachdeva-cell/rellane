import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  AgentVersionSchema,
  ArtifactSchema,
  CitationSchema,
  CanonicalDurableIdSchema,
  PermissionDecisionSchema,
  PermissionRequestSchema,
  ReceiptV2Schema,
  ReviewSchema,
  RevisionRequestSchema,
  RunTransitions,
  RunSchema,
  SourceSchema,
  SourceSpanSchema,
  SpaceSchema,
  TaskSchema,
  agentVersionBindsAgent,
  artifactBindsRun,
  canTransitionRun,
  canUsePermissionDecision,
  citationBindsRecords,
  permissionRequestBindsRun,
  receiptBindsRecords,
  revisionRequestBindsReviewAndArtifact,
  runBindsTaskAndVersion,
  taskBindsRelations,
  transitionRun,
  type UsefulWorkEntityKind
} from "./useful-work.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string) => value.repeat(64).slice(0, 64);
const time = "2026-08-02T00:00:00.000Z";
const later = "2026-08-02T00:01:00.000Z";
const spaceId = id(1);
const sourceId = id(2);
const snapshotId = id(3);
const spanId = id(4);
const artifactId = id(5);
const runId = id(6);
const citationId = id(7);
const receiptId = id(8);
const outputId = id(9);
const agentId = id(14);
const agentVersionId = id(15);
const taskId = id(16);
const effectId = id(19);
const effectTargetId = id(20);
const effectTargetSha256 = hash("3");

const payload = <T extends UsefulWorkEntityKind>(space: string, entityId: string, entityKind: T, contentSha256 = hash("a")) => ({
  envelopeVersion: 1, spaceId: space, keyId: id(99), entityId, entityKind, schemaVersion: 1, contentRevision: 1,
  kind: "payload", contentSha256, nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: id(98), ciphertextSha256: hash("b"), tag: "AAAAAAAAAAAAAAAAAAAAAA"
} as const);
const blob = <T extends UsefulWorkEntityKind>(space: string, entityId: string, entityKind: T, contentSha256 = hash("b")) => ({
  ...payload(space, entityId, entityKind, contentSha256), kind: "blob"
} as const);

const source = {
  schemaVersion: 1, id: sourceId, spaceId, state: "available", recordRevision: 1,
  snapshot: { schemaVersion: 1, outcome: "captured", id: snapshotId, spaceId, sourceId, capturedAt: time, blob: blob(spaceId, snapshotId, "source-snapshot", hash("c")) },
  createdAt: time, updatedAt: time, payload: payload(spaceId, sourceId, "source")
} as const;
const span = {
  schemaVersion: 1, id: spanId, spaceId, sourceId, snapshotId, startOffset: 0, endOffset: 8,
  contentSha256: hash("d"), payload: payload(spaceId, spanId, "source-span")
} as const;
const agentVersion = {
  schemaVersion: 1, id: agentVersionId, spaceId, agentId, version: 1, immutable: true,
  contentSha256: hash("e"), createdAt: time, payload: payload(spaceId, agentVersionId, "agent-version")
} as const;
const agent = {
  schemaVersion: 1, id: agentId, spaceId, kind: "built-in", state: "active", recordRevision: 1,
  currentVersionId: agentVersionId, createdAt: time, updatedAt: time, payload: payload(spaceId, agentId, "agent")
} as const;
const task = {
  schemaVersion: 1, id: taskId, spaceId, state: "draft", recordRevision: 1, agentVersionId,
  sourceSnapshotIds: [snapshotId], createdAt: time, updatedAt: time, payload: payload(spaceId, taskId, "task")
} as const;
const run = {
  schemaVersion: 1, id: runId, spaceId, taskId, agentVersionId, state: "interrupted", recordRevision: 1,
  createdAt: time, updatedAt: time, payload: payload(spaceId, runId, "run")
} as const;
const artifact = {
  schemaVersion: 1, id: artifactId, spaceId, runId, state: "ready", recordRevision: 1,
  createdAt: time, updatedAt: time, blob: blob(spaceId, artifactId, "artifact", hash("f")), payload: payload(spaceId, artifactId, "artifact", hash("a"))
} as const;
const citation = {
  schemaVersion: 1, id: citationId, spaceId, artifactId, artifactContentSha256: artifact.blob.contentSha256,
  sourceId, snapshotId, snapshotContentSha256: source.snapshot.blob.contentSha256, sourceSpanId: spanId, sourceSpanSha256: span.contentSha256,
  createdAt: time, payload: payload(spaceId, citationId, "citation")
} as const;
const permissionRequest = {
  schemaVersion: 1, id: id(21), spaceId, runId, effectId, requestKind: "export", requestSha256: hash("1"), targetId: effectTargetId, targetSha256: effectTargetSha256,
  state: "decided", recordRevision: 2, expiresAt: "2026-08-02T01:00:00.000Z", createdAt: time, updatedAt: later,
  payload: payload(spaceId, id(21), "permission-request")
} as const;
const permissionDecision = {
  schemaVersion: 1, id: id(22), spaceId, requestId: permissionRequest.id, effectId, requestSha256: permissionRequest.requestSha256,
  decision: "granted", decidedAt: later, payload: payload(spaceId, id(22), "permission-decision")
} as const;
const receipt = {
  receiptVersion: 2, id: receiptId, spaceId, runId, authorizationRunId: null, effectId, effectTarget: null, receiptKind: "run", execution: "observed", status: "completed",
  output: [{ id: outputId, artifactId, artifactContentSha256: artifact.blob.contentSha256 }], citationIds: [citationId], permissionDecisionIds: [],
  checks: [{ id: id(10), outcome: "passed", evidenceRef: id(13) }],
  observedEvidence: [
    { id: id(11), kind: "output", targetId: outputId, contentSha256: artifact.blob.contentSha256 },
    { id: id(12), kind: "citation", targetId: citationId, contentSha256: null },
    { id: id(13), kind: "check", targetId: id(10), contentSha256: null }
  ],
  errors: [], unobservedActivity: [], createdAt: time, payload: payload(spaceId, receiptId, "receipt")
} as const;

describe("useful-work persistence contracts", () => {
  it("accepts only canonical durable UUID identifiers", () => {
    expect(CanonicalDurableIdSchema.safeParse(spaceId).success).toBe(true);
    expect(CanonicalDurableIdSchema.safeParse("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA").success).toBe(false);
    expect(CanonicalDurableIdSchema.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(false);
    expect(CanonicalDurableIdSchema.safeParse("ffffffff-ffff-ffff-ffff-ffffffffffff").success).toBe(false);
    expect(CanonicalDurableIdSchema.safeParse("11111111111141118111111111111111").success).toBe(false);
  });

  it("accepts canonical encrypted references and rejects plaintext-like keys, padded encodings, overlong links, and key swaps", () => {
    expect(SourceSchema.parse(source)).toEqual(source);
    expect(SourceSchema.safeParse({ ...source, path: "/Users/private/report.docx" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...source, content: "private document" }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...source, metadata: { prompt: "ignore rules" } }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...source, payload: { ...source.payload, nonce: "AAAAAAAAAAAAAA==" } }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...source, payload: { ...source.payload, tag: "AAAAAAAAAAAAAAAAAAAAAE" } }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task, sourceSnapshotIds: Array.from({ length: 257 }, (_, index) => id(index + 100)) }).success).toBe(false);
    const space = { schemaVersion: 1, id: spaceId, keyId: id(99), state: "active", recordRevision: 1, createdAt: time, updatedAt: time, payload: payload(spaceId, spaceId, "space") };
    expect(SpaceSchema.parse(space)).toEqual(space);
    expect(SpaceSchema.safeParse({ ...space, keyId: id(77) }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...source, createdAt: later, updatedAt: time }).success).toBe(false);
    expect(PermissionRequestSchema.safeParse({ ...permissionRequest, expiresAt: time }).success).toBe(false);
  });

  it("keeps artifact payload and blob hashes distinct while enforcing local binding and unique links", () => {
    expect(ArtifactSchema.parse(artifact).blob.contentSha256).not.toBe(artifact.payload.contentSha256);
    expect(TaskSchema.safeParse({ ...task, sourceSnapshotIds: [snapshotId, snapshotId] }).success).toBe(false);
    expect(SourceSpanSchema.safeParse({ ...span, endOffset: 0 }).success).toBe(false);
    expect(SourceSchema.safeParse({ ...source, payload: { ...source.payload, entityId: id(88) } }).success).toBe(false);
  });

  it("parses lifecycle inputs and outputs, advances time/revision, and rejects stale, malformed, and terminal mutation", () => {
    const transitioned = transitionRun(run, "queued", later);
    expect(transitioned.state).toBe("queued");
    expect(transitioned.recordRevision).toBe(2);
    expect(Object.isFrozen(transitioned)).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(Object.isFrozen(RunTransitions)).toBe(true);
    expect(Object.isFrozen(RunTransitions.completed!)).toBe(true);
    expect(() => (RunTransitions as unknown as Record<string, string[]>).completed!.push("running")).toThrow();
    expect(() => transitionRun({ ...run, state: "completed" }, "running", later)).toThrow();
    expect(() => transitionRun({ ...run, recordRevision: 0 }, "queued", later)).toThrow();
    expect(() => transitionRun(run, "queued", time)).toThrow();
    expect(() => transitionRun({ ...run, state: "completed" }, "running", later)).toThrow();
  });

  it("matches permission use exactly and treats a supplied consumed set as non-authoritative replay defense", () => {
    expect(canUsePermissionDecision(permissionRequest, permissionDecision, "2026-08-02T00:02:00.000Z", new Set())).toBe(true);
    expect(canUsePermissionDecision(permissionRequest, { ...permissionDecision, requestSha256: hash("2") }, later, new Set())).toBe(false);
    expect(canUsePermissionDecision(permissionRequest, { ...permissionDecision, effectId: id(22) }, later, new Set())).toBe(false);
    expect(canUsePermissionDecision(permissionRequest, { ...permissionDecision, spaceId: id(23) }, later, new Set())).toBe(false);
    expect(canUsePermissionDecision(permissionRequest, { ...permissionDecision, decidedAt: "2026-08-02T02:00:00.000Z" }, "2026-08-02T02:00:00.000Z", new Set())).toBe(false);
    expect(canUsePermissionDecision(permissionRequest, permissionDecision, "2026-08-02T02:00:00.000Z", new Set())).toBe(false);
    expect(canUsePermissionDecision(permissionRequest, permissionDecision, later, new Set([permissionRequest.id]))).toBe(false);
    expect(canUsePermissionDecision(permissionRequest, { ...permissionDecision, id: id(23), payload: payload(spaceId, id(23), "permission-decision") }, later, new Set([permissionRequest.id]))).toBe(false);
  });

  it("binds citations and all durable ID relations to same-space records", () => {
    expect(citationBindsRecords(citation, source, span, artifact)).toBe(true);
    expect(citationBindsRecords({ ...citation, artifactContentSha256: hash("0") }, source, span, artifact)).toBe(false);
    expect(agentVersionBindsAgent(agent, agentVersion)).toBe(true);
    expect(taskBindsRelations(task, agentVersion, [source.snapshot])).toBe(true);
    expect(runBindsTaskAndVersion(run, task, agentVersion)).toBe(true);
    expect(artifactBindsRun(artifact, run)).toBe(true);
    expect(permissionRequestBindsRun(permissionRequest, run)).toBe(true);
    expect(runBindsTaskAndVersion({ ...run, taskId: id(25) }, task, agentVersion)).toBe(false);
    const review = { schemaVersion: 1, id: id(26), spaceId, artifactId, state: "open", recordRevision: 1, createdAt: time, updatedAt: time, payload: payload(spaceId, id(26), "review") };
    const revision = { schemaVersion: 1, id: id(27), spaceId, reviewId: review.id, artifactId, state: "open", recordRevision: 1, createdAt: time, updatedAt: time, payload: payload(spaceId, id(27), "revision-request") };
    expect(ReviewSchema.parse(review)).toEqual(review);
    expect(RevisionRequestSchema.parse(revision)).toEqual(revision);
    expect(revisionRequestBindsReviewAndArtifact(revision, review, artifact)).toBe(true);
    expect(revisionRequestBindsReviewAndArtifact({ ...revision, artifactId: id(28) }, review, artifact)).toBe(false);
  });

  it("requires completed runs to carry observed output and citation evidence, and resolves every check reference", () => {
    expect(ReceiptV2Schema.parse(receipt)).toEqual(receipt);
    expect(ReceiptV2Schema.safeParse({ ...receipt, execution: "not-claimed" }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...receipt, observedEvidence: [receipt.observedEvidence[0]] }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...receipt, checks: [{ ...receipt.checks[0], evidenceRef: id(11) }] }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...receipt, checks: [{ ...receipt.checks[0], outcome: "not-run", evidenceRef: id(44) }] }).success).toBe(false);
    const notRunReceipt = {
      ...receipt, status: "cancelled", execution: "not-claimed", output: [], citationIds: [], observedEvidence: [], errors: [{ id: id(51), code: "operation-cancelled" }],
      checks: [{ id: id(10), outcome: "not-run", evidenceRef: id(44) }], unobservedActivity: [{ id: id(44), kind: "check", targetId: id(10), reason: "not-observed" }]
    } as const;
    expect(ReceiptV2Schema.parse(notRunReceipt)).toEqual(notRunReceipt);
    expect(ReceiptV2Schema.safeParse({ ...receipt, checks: notRunReceipt.checks, unobservedActivity: notRunReceipt.unobservedActivity }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...notRunReceipt, unobservedActivity: [{ ...notRunReceipt.unobservedActivity[0], targetId: id(52) }] }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...notRunReceipt, unobservedActivity: [{ ...notRunReceipt.unobservedActivity[0], kind: "network-egress" }] }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...notRunReceipt, observedEvidence: [{ id: id(44), kind: "check", targetId: id(10), contentSha256: null }] }).success).toBe(false);
  });

  it("requires kind-specific completed export/deletion evidence and bounded meaningful non-completion evidence", () => {
    const exportReceipt = {
      ...receipt, id: id(30), runId: null, authorizationRunId: runId, effectTarget: { id: effectTargetId, contentSha256: effectTargetSha256 }, receiptKind: "export", execution: "observed", output: receipt.output, citationIds: [], permissionDecisionIds: [permissionDecision.id], checks: [], createdAt: "2026-08-02T00:02:00.000Z",
      observedEvidence: [
        { id: id(31), kind: "output", targetId: outputId, contentSha256: artifact.blob.contentSha256 },
        { id: id(32), kind: "permission", targetId: permissionDecision.id, contentSha256: null },
        { id: id(33), kind: "effect", targetId: effectId, contentSha256: null }
      ],
      payload: payload(spaceId, id(30), "receipt")
    } as const;
    expect(ReceiptV2Schema.parse(exportReceipt)).toEqual(exportReceipt);
    expect(ReceiptV2Schema.safeParse({ ...exportReceipt, observedEvidence: exportReceipt.observedEvidence.slice(0, 2) }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...exportReceipt, observedEvidence: exportReceipt.observedEvidence.slice(1) }).success).toBe(false);
    const deletionReceipt = { ...exportReceipt, id: id(34), receiptKind: "deletion", output: [], observedEvidence: [exportReceipt.observedEvidence[1], exportReceipt.observedEvidence[2]], payload: payload(spaceId, id(34), "receipt") } as const;
    expect(ReceiptV2Schema.parse(deletionReceipt)).toEqual(deletionReceipt);
    expect(ReceiptV2Schema.safeParse({ ...deletionReceipt, citationIds: [citationId] }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...receipt, status: "cancelled", execution: "not-claimed", output: [], citationIds: [], checks: [], observedEvidence: [], errors: [], unobservedActivity: [{ id: id(35), kind: "external-effect", targetId: effectId, reason: "not-applicable" }] }).success).toBe(false);
    expect(ReceiptV2Schema.safeParse({ ...receipt, status: "cancelled", output: [], citationIds: [], checks: [], observedEvidence: [], errors: [{ id: id(36), code: "operation-cancelled" }], unobservedActivity: [] }).success).toBe(false);
  });

  it("binds receipt records without treating the pure check as atomic decision consumption", () => {
    expect(receiptBindsRecords(receipt, { artifacts: [artifact], citations: [citation], decisions: [], requests: [], runs: [run] })).toBe(true);
    expect(ReceiptV2Schema.safeParse({ ...receipt, permissionDecisionIds: [permissionDecision.id] }).success).toBe(false);
    expect(receiptBindsRecords({ ...receipt, spaceId: id(40) }, { artifacts: [artifact], citations: [citation], decisions: [], requests: [], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(receipt, { artifacts: [{ ...artifact, runId: id(48) }], citations: [citation], decisions: [], requests: [], runs: [run] })).toBe(false);
    expect(receiptBindsRecords({ ...receipt, output: [{ ...receipt.output[0], artifactId: id(41) }] }, { artifacts: [artifact], citations: [citation], decisions: [], requests: [], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(receipt, { artifacts: [artifact], citations: [{ ...citation, spaceId: id(42) }], decisions: [], requests: [], runs: [run] })).toBe(false);
    const exportReceipt = {
      ...receipt, id: id(43), runId: null, authorizationRunId: runId, effectTarget: { id: effectTargetId, contentSha256: effectTargetSha256 }, receiptKind: "export", execution: "observed", citationIds: [], permissionDecisionIds: [permissionDecision.id], checks: [], createdAt: "2026-08-02T00:02:00.000Z",
      observedEvidence: [
        { id: id(44), kind: "output", targetId: outputId, contentSha256: artifact.blob.contentSha256 },
        { id: id(45), kind: "permission", targetId: permissionDecision.id, contentSha256: null },
        { id: id(46), kind: "effect", targetId: effectId, contentSha256: null }
      ],
      payload: payload(spaceId, id(43), "receipt")
    } as const;
    expect(receiptBindsRecords(exportReceipt, { artifacts: [artifact], citations: [], decisions: [permissionDecision], requests: [permissionRequest], runs: [run] })).toBe(true);
    expect(receiptBindsRecords(exportReceipt, { artifacts: [{ ...artifact, runId: id(60) }], citations: [], decisions: [permissionDecision], requests: [permissionRequest], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(exportReceipt, { artifacts: [artifact], citations: [], decisions: [permissionDecision], requests: [{ ...permissionRequest, targetSha256: hash("4") }], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(exportReceipt, { artifacts: [artifact], citations: [], decisions: [permissionDecision], requests: [{ ...permissionRequest, runId: id(47) }], runs: [run] })).toBe(false);
    expect(receiptBindsRecords({ ...exportReceipt, authorizationRunId: id(47) }, { artifacts: [artifact], citations: [], decisions: [permissionDecision], requests: [permissionRequest], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(exportReceipt, { artifacts: [artifact], citations: [], decisions: [permissionDecision], requests: [{ ...permissionRequest, requestKind: "delete" }], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(exportReceipt, { artifacts: [artifact], citations: [], decisions: [permissionDecision], requests: [permissionRequest], runs: [{ ...run, id: id(48), payload: payload(spaceId, id(48), "run") }] })).toBe(false);
    const runPermissionRequest = { ...permissionRequest, id: id(53), requestKind: "read-source", payload: payload(spaceId, id(53), "permission-request") } as const;
    const runPermissionDecision = { ...permissionDecision, id: id(54), requestId: runPermissionRequest.id, requestSha256: runPermissionRequest.requestSha256, payload: payload(spaceId, id(54), "permission-decision") } as const;
    const runPermissionReceipt = {
      ...receipt, id: id(55), permissionDecisionIds: [runPermissionDecision.id], createdAt: "2026-08-02T00:02:00.000Z",
      observedEvidence: [...receipt.observedEvidence, { id: id(56), kind: "permission", targetId: runPermissionDecision.id, contentSha256: null }],
      payload: payload(spaceId, id(55), "receipt")
    } as const;
    expect(ReceiptV2Schema.parse(runPermissionReceipt)).toEqual(runPermissionReceipt);
    expect(receiptBindsRecords(runPermissionReceipt, { artifacts: [artifact], citations: [citation], decisions: [runPermissionDecision], requests: [runPermissionRequest], runs: [run] })).toBe(true);
    expect(receiptBindsRecords(runPermissionReceipt, { artifacts: [artifact], citations: [citation], decisions: [runPermissionDecision], requests: [{ ...runPermissionRequest, runId: id(57) }], runs: [run] })).toBe(false);
    expect(receiptBindsRecords(runPermissionReceipt, { artifacts: [artifact], citations: [citation], decisions: [runPermissionDecision], requests: [{ ...runPermissionRequest, requestKind: "export" }], runs: [run] })).toBe(false);
  });
});
