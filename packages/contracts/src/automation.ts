import { z } from "zod";

export const AUTOMATION_SCHEMA_VERSION = 1 as const;
/** Opt-in Case-bound graph records coexist with untouched v1 records. */
export const AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION = 2 as const;

const IdSchema = z.uuid();
const IsoDateSchema = z.iso.datetime({ offset: true });
const NameSchema = z.string().trim().min(1).max(120);
const DescriptionSchema = z.string().trim().max(1_000);
const PromptSchema = z.string().trim().min(1).max(32_000);

export const AutomationModelRouteSchema = z.strictObject({
  runtimeId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(512)
});
export type AutomationModelRoute = z.infer<typeof AutomationModelRouteSchema>;

export const AutomationAgentSaveInputSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  description: DescriptionSchema,
  systemPrompt: PromptSchema,
  runtimeId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(512),
  routingMode: z.enum(["fixed", "fallback"]).default("fixed"),
  fallbackRoutes: z.array(AutomationModelRouteSchema).max(3).default([]),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(32).max(8_192)
});
export type AutomationAgentSaveInput = z.infer<
  typeof AutomationAgentSaveInputSchema
>;

export const AutomationAgentSchema = AutomationAgentSaveInputSchema.extend({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  revision: z.number().int().positive().safe(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});
export type AutomationAgent = z.infer<typeof AutomationAgentSchema>;

export const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(1).max(10_080),
    runOnceIfOverdue: z.literal(true)
  }),
  /**
   * Runs when a granted folder changes.
   *
   * The trigger somebody actually wants — *"when a bill lands in Downloads,
   * read it"* — and the one that makes a flow able to feed itself. The runtime
   * carries a loop guard for exactly this reason (D-076); adding this trigger
   * without it would ship the failure and the fix in separate releases.
   *
   * The root must be a folder the owner granted. It is stored as the path
   * because that is what the watcher reports, and a flow whose folder is later
   * revoked simply stops being triggered rather than failing loudly at 3am.
   */
  z.strictObject({
    kind: z.literal("folder"),
    root: z.string().min(1).max(4_096)
  })
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationBudgetSchema = z.strictObject({
  maxDurationMs: z.number().int().min(10_000).max(86_400_000),
  maxNodeExecutions: z.number().int().min(1).max(128),
  maxOutputCharacters: z.number().int().min(1_000).max(2_000_000)
});
export type AutomationBudget = z.infer<typeof AutomationBudgetSchema>;

export const AutomationNodeKindSchema = z.enum([
  "model",
  "memory.search",
  "artifact.write",
  "connector.send"
]);
export type AutomationNodeKind = z.infer<typeof AutomationNodeKindSchema>;

export const AutomationNodeSchema = z.strictObject({
  id: IdSchema,
  title: NameSchema,
  instruction: PromptSchema,
  kind: AutomationNodeKindSchema,
  agentId: IdSchema,
  connectorId: IdSchema.nullable().default(null),
  dependsOn: z.array(IdSchema).max(32)
});
export type AutomationNode = z.infer<typeof AutomationNodeSchema>;

export const AutomationWorkflowSaveInputSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  description: DescriptionSchema,
  enabled: z.boolean(),
  trigger: AutomationTriggerSchema,
  budget: AutomationBudgetSchema,
  nodes: z.array(AutomationNodeSchema).min(1).max(32)
}).superRefine((workflow, context) => {
  const nodes = new Map<string, AutomationNode>();
  workflow.nodes.forEach((node, index) => {
    if (nodes.has(node.id)) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "id"],
        message: "Automation node IDs must be unique."
      });
    }
    nodes.set(node.id, node);
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "dependsOn"],
        message: "Automation dependencies must be unique."
      });
    }
  });

  const incoming = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    incoming.set(node.id, 0);
    dependents.set(node.id, []);
  }
  workflow.nodes.forEach((node, index) => {
    for (const dependencyId of node.dependsOn) {
      if (dependencyId === node.id) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "dependsOn"],
          message: "An automation node cannot depend on itself."
        });
        continue;
      }
      if (!nodes.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "dependsOn"],
          message: "Every automation dependency must reference a workflow node."
        });
        continue;
      }
      incoming.set(node.id, (incoming.get(node.id) ?? 0) + 1);
      dependents.get(dependencyId)?.push(node.id);
    }
  });

  const ready = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const nodeId = ready[index];
    if (nodeId === undefined) continue;
    visited += 1;
    for (const dependentId of dependents.get(nodeId) ?? []) {
      const remaining = (incoming.get(dependentId) ?? 0) - 1;
      incoming.set(dependentId, remaining);
      if (remaining === 0) ready.push(dependentId);
    }
  }
  if (visited !== workflow.nodes.length) {
    context.addIssue({
      code: "custom",
      path: ["nodes"],
      message: "Automation workflows must be acyclic."
    });
  }
  workflow.nodes.forEach((node, index) => {
    if (node.kind === "connector.send" && node.connectorId === null) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "connectorId"],
        message: "Connector steps require a connector."
      });
    }
    if (node.kind !== "connector.send" && node.connectorId !== null) {
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "connectorId"],
        message: "Only connector steps may reference a connector."
      });
    }
  });
});
export type AutomationWorkflowSaveInput = z.infer<
  typeof AutomationWorkflowSaveInputSchema
>;

export const AutomationReviewBoundWorkflowInputSchema = z.strictObject({
  workflow: AutomationWorkflowSaveInputSchema,
  caseId: IdSchema,
  sourceTurnIds: z.array(IdSchema).min(1).max(128)
}).superRefine((input, context) => {
  if (new Set(input.sourceTurnIds).size !== input.sourceTurnIds.length)
    context.addIssue({ code: "custom", path: ["sourceTurnIds"], message: "Source turns must be unique." });
  if (input.workflow.nodes.some(node => node.kind !== "model"))
    context.addIssue({ code: "custom", path: ["workflow", "nodes"],
      message: "This first review-bound graph version accepts model nodes only." });
  if (input.workflow.nodes.filter(node => node.dependsOn.length === 0).length !== 1)
    context.addIssue({ code: "custom", path: ["workflow", "nodes"],
      message: "This review-bound graph version requires exactly one root model node." });
});
export type AutomationReviewBoundWorkflowInput = z.infer<typeof AutomationReviewBoundWorkflowInputSchema>;

export const AutomationReviewBindingSchema = z.strictObject({
  caseId: IdSchema,
  sourceTurnIds: z.array(IdSchema).min(1).max(128),
  reviewRequired: z.literal(true),
  agentRevisions: z.array(z.strictObject({
    agentId: IdSchema,
    revision: z.number().int().positive().safe()
  })).min(1).max(32)
});
export type AutomationReviewBinding = z.infer<typeof AutomationReviewBindingSchema>;

export const AutomationWorkflowV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  name: NameSchema,
  description: DescriptionSchema,
  enabled: z.boolean(),
  trigger: AutomationTriggerSchema,
  budget: AutomationBudgetSchema,
  nodes: z.array(AutomationNodeSchema).min(1).max(32),
  revision: z.number().int().positive().safe(),
  /**
   * Why this flow switched itself off, or null.
   *
   * Defaulted rather than required so a workflow stored by an earlier build
   * still parses — a strict schema plus a new mandatory field is how a feature
   * release erases somebody's saved work.
   */
  pausedReason: z.string().min(1).max(400).nullable().default(null),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastRunAt: IsoDateSchema.nullable(),
  nextRunAt: IsoDateSchema.nullable()
});
export const AutomationWorkflowV2Schema = AutomationWorkflowV1Schema.extend({
  schemaVersion: z.literal(AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION),
  reviewBinding: AutomationReviewBindingSchema
}).superRefine((workflow, context) => {
  const graph = AutomationWorkflowSaveInputSchema.safeParse({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    enabled: workflow.enabled,
    trigger: workflow.trigger,
    budget: workflow.budget,
    nodes: workflow.nodes
  });
  if (!graph.success)
    context.addIssue({ code: "custom", path: ["nodes"],
      message: "A review-bound graph must have valid, acyclic dependencies." });
  if (workflow.nodes.some(node => node.kind !== "model"))
    context.addIssue({ code: "custom", path: ["nodes"],
      message: "Review-bound graphs in this version accept model nodes only." });
  const expected = new Set(workflow.nodes.map(node => node.agentId));
  const actual = workflow.reviewBinding.agentRevisions.map(item => item.agentId);
  if (actual.length !== expected.size || new Set(actual).size !== actual.length ||
      actual.some(id => !expected.has(id)))
    context.addIssue({ code: "custom", path: ["reviewBinding", "agentRevisions"],
      message: "Pinned agent revisions must cover exactly the workflow agents." });
  if (new Set(workflow.reviewBinding.sourceTurnIds).size !==
      workflow.reviewBinding.sourceTurnIds.length)
    context.addIssue({ code: "custom", path: ["reviewBinding", "sourceTurnIds"],
      message: "Source turns must be unique." });
});
export const AutomationWorkflowSchema = z.discriminatedUnion("schemaVersion", [
  AutomationWorkflowV1Schema,
  AutomationWorkflowV2Schema
]);
export type AutomationWorkflow = z.infer<typeof AutomationWorkflowSchema>;

export const AutomationRunStateSchema = z.enum([
  "queued",
  "running",
  "paused",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);
export type AutomationRunState = z.infer<typeof AutomationRunStateSchema>;

export const AutomationStepStateSchema = z.enum([
  "pending",
  "running",
  "waiting-approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "skipped"
]);
export type AutomationStepState = z.infer<typeof AutomationStepStateSchema>;

export const AutomationRunAgentSnapshotSchema = z.strictObject({
  agentId: IdSchema,
  agentRevision: z.number().int().positive().safe(),
  name: NameSchema,
  systemPrompt: PromptSchema,
  runtimeId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(512),
  routingMode: z.enum(["fixed", "fallback"]).default("fixed"),
  fallbackRoutes: z.array(AutomationModelRouteSchema).max(3).default([]),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(32).max(8_192)
});
export type AutomationRunAgentSnapshot = z.infer<
  typeof AutomationRunAgentSnapshotSchema
>;

export const AutomationRunStepV1Schema = z.strictObject({
  nodeId: IdSchema,
  title: NameSchema,
  instruction: PromptSchema,
  kind: AutomationNodeKindSchema,
  dependsOn: z.array(IdSchema).max(32),
  connectorId: IdSchema.nullable().default(null),
  agent: AutomationRunAgentSnapshotSchema,
  state: AutomationStepStateSchema,
  attempt: z.number().int().nonnegative().safe(),
  operationId: IdSchema.nullable(),
  resolvedRoute: AutomationModelRouteSchema.nullable().default(null),
  citations: z.array(z.lazy(() => AutomationCitationSchema)).max(128).default([]),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  output: z.string().max(2_000_000).nullable(),
  error: z.string().max(4_000).nullable()
});
export const AutomationHostAttemptIntentSchema = z.strictObject({
  correlation: IdSchema,
  correlationId: IdSchema,
  descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: IsoDateSchema
});
export type AutomationHostAttemptIntent = z.infer<
  typeof AutomationHostAttemptIntentSchema
>;

export const AutomationRunStepV2Schema = AutomationRunStepV1Schema.extend({
  state: z.enum([
    "pending", "awaiting-review", "host-reserved", "running", "waiting-approval", "completed",
    "failed", "cancelled", "interrupted", "skipped"
  ]),
  attemptId: IdSchema.nullable(),
  intent: AutomationHostAttemptIntentSchema.nullable().default(null),
  answerTurnId: IdSchema.nullable().optional()
}).superRefine((step, context) => {
  if (step.state === "awaiting-review" && step.attemptId === null)
    context.addIssue({ code: "custom", path: ["attemptId"],
      message: "An awaiting-review step needs a stable attempt ID." });
  if (step.state === "host-reserved" && (step.attemptId === null || step.intent === null))
    context.addIssue({ code: "custom", path: ["intent"],
      message: "A host-reserved step needs a stable attempt ID and intent." });
});
export const AutomationRunStepSchema = z.union([AutomationRunStepV1Schema, AutomationRunStepV2Schema]);
export type AutomationRunStep = z.infer<typeof AutomationRunStepSchema>;

export const AutomationMemoryDocumentSaveInputSchema = z.strictObject({
  id: IdSchema,
  title: NameSchema,
  content: z.string().trim().min(1).max(200_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(24)
});
export type AutomationMemoryDocumentSaveInput = z.infer<
  typeof AutomationMemoryDocumentSaveInputSchema
>;

export const AutomationMemoryDocumentSchema =
  AutomationMemoryDocumentSaveInputSchema.extend({
    schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
    revision: z.number().int().positive().safe(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema
  });
export type AutomationMemoryDocument = z.infer<
  typeof AutomationMemoryDocumentSchema
>;

export const AutomationSourceImportInputSchema = z.strictObject({
  id: IdSchema,
  title: NameSchema,
  mediaType: z.enum(["text/plain", "text/markdown", "text/csv", "application/json"]),
  content: z.string().min(1).max(4_000_000)
});
export type AutomationSourceImportInput = z.infer<
  typeof AutomationSourceImportInputSchema
>;

export const AutomationSourceDocumentSchema = AutomationSourceImportInputSchema.extend({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: IsoDateSchema
});
export type AutomationSourceDocument = z.infer<
  typeof AutomationSourceDocumentSchema
>;

export const AutomationCitationSchema = z.strictObject({
  sourceId: IdSchema,
  title: NameSchema,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  startOffset: z.number().int().nonnegative().safe(),
  endOffset: z.number().int().positive().safe(),
  excerpt: z.string().min(1).max(12_000)
}).superRefine((citation, context) => {
  if (citation.endOffset <= citation.startOffset) {
    context.addIssue({ code: "custom", path: ["endOffset"], message: "Citation spans must have a positive extent." });
  }
});
export type AutomationCitation = z.infer<typeof AutomationCitationSchema>;

export const AutomationArtifactSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  name: z.string().trim().min(1).max(240),
  mediaType: z.literal("text/markdown"),
  content: z.string().max(2_000_000),
  citations: z.array(AutomationCitationSchema).max(128).default([]),
  revision: z.number().int().positive().safe().default(1),
  reviewState: z.enum(["draft", "accepted", "changes-requested"]).default("draft"),
  reviewNote: z.string().trim().max(4_000).nullable().default(null),
  reviewedAt: IsoDateSchema.nullable().default(null),
  createdAt: IsoDateSchema
});
export type AutomationArtifact = z.infer<typeof AutomationArtifactSchema>;

export const AutomationArtifactReviewInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    artifactId: IdSchema,
    action: z.literal("accept"),
    note: z.string().trim().max(4_000).optional()
  }),
  z.strictObject({
    artifactId: IdSchema,
    action: z.literal("request-changes"),
    note: z.string().trim().min(1).max(4_000)
  }),
  z.strictObject({
    artifactId: IdSchema,
    action: z.literal("revise"),
    content: z.string().trim().min(1).max(2_000_000),
    note: z.string().trim().max(4_000).optional()
  })
]);
export type AutomationArtifactReviewInput = z.infer<
  typeof AutomationArtifactReviewInputSchema
>;

export const AutomationCapabilityRequestSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  capability: z.enum(["artifact.write", "connector.send"]),
  connectorId: IdSchema.nullable().default(null),
  reason: z.string().trim().min(1).max(1_000),
  state: z.enum(["pending", "approved", "denied"]),
  createdAt: IsoDateSchema,
  decidedAt: IsoDateSchema.nullable()
});
export type AutomationCapabilityRequest = z.infer<
  typeof AutomationCapabilityRequestSchema
>;

export const AutomationLeaseSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  state: z.enum(["active", "released"]),
  acquiredAt: IsoDateSchema,
  releasedAt: IsoDateSchema.nullable()
});
export type AutomationLease = z.infer<typeof AutomationLeaseSchema>;

export const AutomationConnectorSaveInputSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  kind: z.literal("local-inbox"),
  enabled: z.boolean()
});
export type AutomationConnectorSaveInput = z.infer<
  typeof AutomationConnectorSaveInputSchema
>;

export const AutomationConnectorEnsureLocalInputSchema = z.strictObject({
  name: NameSchema
});
export type AutomationConnectorEnsureLocalInput = z.infer<
  typeof AutomationConnectorEnsureLocalInputSchema
>;

export const AutomationConnectorSchema = AutomationConnectorSaveInputSchema.extend({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  revision: z.number().int().positive().safe(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema
});
export type AutomationConnector = z.infer<typeof AutomationConnectorSchema>;

export const AutomationOutboxEntrySchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/u),
  runId: IdSchema,
  nodeId: IdSchema,
  connectorId: IdSchema,
  payload: z.string().max(2_000_000),
  state: z.enum(["pending", "delivered", "failed"]),
  createdAt: IsoDateSchema,
  deliveredAt: IsoDateSchema.nullable(),
  error: z.string().max(4_000).nullable()
});
export type AutomationOutboxEntry = z.infer<typeof AutomationOutboxEntrySchema>;

export const AutomationConnectorDeliverySchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  connectorId: IdSchema,
  outboxId: IdSchema,
  runId: IdSchema,
  title: NameSchema,
  content: z.string().max(2_000_000),
  receivedAt: IsoDateSchema
});
export type AutomationConnectorDelivery = z.infer<
  typeof AutomationConnectorDeliverySchema
>;

export const AutomationWorkflowPackSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  kind: z.literal("cadrane-workflow-pack"),
  name: NameSchema,
  agents: z.array(AutomationAgentSaveInputSchema).min(1).max(32),
  connectors: z.array(AutomationConnectorSaveInputSchema).max(16),
  workflow: AutomationWorkflowSaveInputSchema
});
export type AutomationWorkflowPack = z.infer<
  typeof AutomationWorkflowPackSchema
>;

export const AutomationWorkflowPackExportInputSchema = z.strictObject({
  workflowId: IdSchema
});
export type AutomationWorkflowPackExportInput = z.infer<
  typeof AutomationWorkflowPackExportInputSchema
>;

export const AutomationWorkflowPackFileResultSchema = z.strictObject({
  completed: z.boolean(),
  fileName: z.string().trim().min(1).max(255).nullable(),
  workflowId: IdSchema.nullable()
});
export type AutomationWorkflowPackFileResult = z.infer<
  typeof AutomationWorkflowPackFileResultSchema
>;

/**
 * What one step of a dry run would do.
 *
 * `asks` is the whole reason a dry run is worth having: a flow's cost is not
 * only time and tokens, it is the number of times it will interrupt you to
 * approve something. Reading that before arming it is the difference between a
 * flow you keep and one you turn off on the second day.
 */
export const AutomationDryStepSchema = z.strictObject({
  nodeId: IdSchema,
  title: NameSchema,
  kind: AutomationNodeKindSchema,
  /** Position in the order the real run would take them, from 1. */
  order: z.number().int().positive(),
  /** Which agent would answer, and on what. */
  agentName: NameSchema,
  runtimeId: z.string().min(1).max(120),
  modelId: z.string().min(1).max(200),
  /** The approval this step would stop and ask for, or null. */
  asks: z.enum(["artifact.write", "connector.send"]).nullable(),
  /** What it would do, in the owner's words. */
  said: z.string().min(1).max(400)
});
export type AutomationDryStep = z.infer<typeof AutomationDryStepSchema>;

/**
 * A flow walked through without running it.
 *
 * Spends nothing, writes nothing, sends nothing. It exists because arming a
 * flow is the one action in this product whose consequences are not visible at
 * the moment you take it — everything else happens while you watch.
 */
export const AutomationDryRunSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  workflowId: IdSchema,
  workflowName: NameSchema,
  /** False when the flow could not be walked at all; `problem` says why. */
  ok: z.boolean(),
  steps: z.array(AutomationDryStepSchema).max(32),
  /** Steps that would stop for an approval. Counted so it can be said plainly. */
  approvals: z.number().int().nonnegative(),
  /** Every model call this would make, if none of them failed. */
  modelCalls: z.number().int().nonnegative(),
  /** What would go wrong before it started, or null. */
  problem: z.string().min(1).max(400).nullable(),
  /** Said in full, for the sheet a person reads before arming. */
  summary: z.string().min(1).max(600)
});
export type AutomationDryRun = z.infer<typeof AutomationDryRunSchema>;

export const AutomationDryRunInputSchema = z.strictObject({
  workflowId: IdSchema
});
export type AutomationDryRunInput = z.infer<typeof AutomationDryRunInputSchema>;

export const AutomationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  runId: IdSchema,
  revision: z.number().int().positive().safe(),
  outcome: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  createdAt: IsoDateSchema,
  workflowId: IdSchema,
  workflowRevision: z.number().int().positive().safe(),
  completedNodeIds: z.array(IdSchema).max(32),
  failedNodeIds: z.array(IdSchema).max(32),
  configuredTokenCap: z.number().int().nonnegative().safe(),
  elapsedMs: z.number().int().nonnegative().safe()
});
export type AutomationReceipt = z.infer<typeof AutomationReceiptSchema>;

export const AutomationRunSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  id: IdSchema,
  workflowId: IdSchema,
  workflowRevision: z.number().int().positive().safe(),
  workflowName: NameSchema,
  state: AutomationRunStateSchema,
  triggerKind: z.enum(["manual", "interval", "folder"]),
  budget: AutomationBudgetSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  deadlineAt: IsoDateSchema,
  activeNodeId: IdSchema.nullable(),
  error: z.string().max(4_000).nullable(),
  steps: z.array(AutomationRunStepV1Schema).min(1).max(32),
  receipts: z.array(AutomationReceiptSchema).max(32)
});
export const AutomationRunSnapshotV2Schema = AutomationRunSnapshotV1Schema.extend({
  schemaVersion: z.literal(AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION),
  reviewBinding: AutomationReviewBindingSchema,
  workflowSnapshot: AutomationWorkflowV2Schema.optional(),
  steps: z.array(AutomationRunStepV2Schema).min(1).max(32)
}).superRefine((run, context) => {
  if (run.steps.some(step => step.kind !== "model"))
    context.addIssue({ code: "custom", path: ["steps"],
      message: "Review-bound runs in this version accept model nodes only." });
  const pinned = new Map(run.reviewBinding.agentRevisions.map(item =>
    [item.agentId, item.revision]));
  const agentIds = new Set(run.steps.map(step => step.agent.agentId));
  if (new Set(run.reviewBinding.sourceTurnIds).size !==
      run.reviewBinding.sourceTurnIds.length ||
      pinned.size !== run.reviewBinding.agentRevisions.length ||
      pinned.size !== agentIds.size ||
      run.steps.some(step => pinned.get(step.agent.agentId) !== step.agent.agentRevision))
    context.addIssue({ code: "custom", path: ["reviewBinding"],
      message: "Review-bound run sources and agent revisions must match the pinned graph." });
  if (run.state === "waiting") {
    const waiting = run.steps.filter(step =>
      step.state === "awaiting-review" || step.state === "host-reserved"
    );
    if (waiting.length !== 1 || waiting[0]?.nodeId !== run.activeNodeId ||
        (waiting[0]?.attempt ?? 0) < 1 ||
        (waiting[0]?.state === "awaiting-review" && waiting[0]?.operationId !== null) ||
        waiting[0]?.finishedAt !== null)
      context.addIssue({ code: "custom", path: ["activeNodeId"],
        message: "A waiting review-bound run needs one exact awaiting-review node." });
  }
});
export const AutomationRunSnapshotSchema = z.discriminatedUnion("schemaVersion", [
  AutomationRunSnapshotV1Schema,
  AutomationRunSnapshotV2Schema
]);
export type AutomationRunSnapshot = z.infer<
  typeof AutomationRunSnapshotSchema
>;

export const AutomationHostReserveAttemptResultSchema = z
  .strictObject({
    run: AutomationRunSnapshotV2Schema,
    intent: AutomationHostAttemptIntentSchema,
    correlation: IdSchema
  })
  .superRefine((result, context) => {
    if (result.correlation !== result.intent.correlation) {
      context.addIssue({
        code: "custom",
        path: ["correlation"],
        message: "Reservation result correlation must match intent correlation."
      });
    }

    if (
      result.run.state === "completed" ||
      result.run.state === "failed" ||
      result.run.state === "cancelled"
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "state"],
        message: "Reserved run state must not be closed or cancelled."
      });
    }

    if (result.run.activeNodeId === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "activeNodeId"],
        message: "A reserved review-bound run needs an active node ID."
      });
      return;
    }

    const targetStep = result.run.steps.find(
      (step) => step.nodeId === result.run.activeNodeId
    );
    if (targetStep === undefined) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Reservation target step not found."
      });
      return;
    }

    if (targetStep.state !== "host-reserved") {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Reservation target step state must be host-reserved."
      });
    }

    if (targetStep.attemptId === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Reservation target step must have an attempt ID."
      });
    }

    if (targetStep.operationId !== null) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Reservation target step must not have an operation ID."
      });
    }

    if (targetStep.intent === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Reservation target step must have an intent."
      });
    } else {
      if (targetStep.intent.correlation !== result.correlation) {
        context.addIssue({
          code: "custom",
          path: ["run", "steps"],
          message: "Reservation target step correlation mismatch."
        });
      }
      if (targetStep.intent.descriptorSha256 !== result.intent.descriptorSha256) {
        context.addIssue({
          code: "custom",
          path: ["run", "steps"],
          message: "Reservation target step descriptor SHA256 mismatch."
        });
      }
    }
  });
export type AutomationHostReserveAttemptResult = z.infer<
  typeof AutomationHostReserveAttemptResultSchema
>;

export const AutomationHostBindOperationResultSchema = z
  .strictObject({
    run: AutomationRunSnapshotV2Schema
  })
  .superRefine((result, context) => {
    if (
      result.run.state === "completed" ||
      result.run.state === "failed" ||
      result.run.state === "cancelled"
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "state"],
        message: "Bound run state must not be closed or cancelled."
      });
    }

    if (result.run.activeNodeId === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "activeNodeId"],
        message: "A bound review-bound run must have an active node ID."
      });
      return;
    }

    const targetStep = result.run.steps.find(
      (step) => step.nodeId === result.run.activeNodeId
    );
    if (targetStep === undefined) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Operation binding target step not found."
      });
      return;
    }

    if (targetStep.state !== "host-reserved") {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Operation binding target step state must be host-reserved."
      });
    }

    if (targetStep.attemptId === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Operation binding target step must have an attempt ID."
      });
    }

    if (targetStep.operationId === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Operation binding target step must have an operation ID."
      });
    }

    if (targetStep.intent === null) {
      context.addIssue({
        code: "custom",
        path: ["run", "steps"],
        message: "Operation binding target step must have an intent."
      });
    }
  });
export type AutomationHostBindOperationResult = z.infer<
  typeof AutomationHostBindOperationResultSchema
>;

export const AutomationWorkspaceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  agents: z.array(AutomationAgentSchema).max(128),
  workflows: z.array(AutomationWorkflowSchema).max(128),
  runs: z.array(AutomationRunSnapshotSchema).max(200),
  memory: z.array(AutomationMemoryDocumentSchema).max(500).default([]),
  sources: z.array(AutomationSourceDocumentSchema).max(500).default([]),
  artifacts: z.array(AutomationArtifactSchema).max(500).default([]),
  capabilityRequests: z.array(AutomationCapabilityRequestSchema).max(500).default([]),
  leases: z.array(AutomationLeaseSchema).max(500).default([]),
  connectors: z.array(AutomationConnectorSchema).max(128).default([]),
  outbox: z.array(AutomationOutboxEntrySchema).max(500).default([]),
  deliveries: z.array(AutomationConnectorDeliverySchema).max(500).default([])
});
export type AutomationWorkspaceSnapshot = z.infer<
  typeof AutomationWorkspaceSnapshotSchema
>;

export const AutomationRunStartInputSchema = z.strictObject({
  workflowId: IdSchema
});
export type AutomationRunStartInput = z.infer<
  typeof AutomationRunStartInputSchema
>;

export const AutomationRunActionInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ runId: IdSchema, action: z.literal("pause") }),
  z.strictObject({ runId: IdSchema, action: z.literal("resume") }),
  z.strictObject({ runId: IdSchema, action: z.literal("cancel") }),
  z.strictObject({
    runId: IdSchema,
    action: z.literal("retry"),
    nodeId: IdSchema.optional()
  }),
  z.strictObject({
    runId: IdSchema,
    action: z.literal("approve-tool"),
    requestId: IdSchema
  }),
  z.strictObject({
    runId: IdSchema,
    action: z.literal("deny-tool"),
    requestId: IdSchema
  })
]);
export type AutomationRunActionInput = z.infer<
  typeof AutomationRunActionInputSchema
>;


/**
 * How many folder-triggered starts inside `LOOP_WINDOW_MS` count as a loop.
 *
 * Four rather than two: somebody genuinely dropping three files into Downloads
 * inside a minute is ordinary work, and a guard that fired on that would be a
 * feature nobody could leave switched on.
 *
 * These live in contracts rather than in the runtime because **the backtest and
 * the guard must not be able to disagree.** A backtest that says "this would
 * have been fine" using a different threshold from the one that later switches
 * the flow off is worse than no backtest: it is a promise the product then
 * breaks.
 */
export const LOOP_RUNS = 4;
export const LOOP_WINDOW_MS = 120_000;

/**
 * Whether a start at `at` is the one that trips the guard.
 *
 * Pure, and takes the previous start times rather than a workspace, so the
 * runtime can call it with real runs and the backtest can call it with folder
 * captures from a month ago.
 */
export function tripsLoopGuard(previousStartsMs: readonly number[], atMs: number): boolean {
  const since = atMs - LOOP_WINDOW_MS;
  return previousStartsMs.filter((start) => start >= since).length >= LOOP_RUNS;
}

export const MAX_REVIEW_CONTEXT_CHARACTERS = 8_000;

export const AutomationHostReviewDependencyOutputSchema = z.strictObject({
  nodeId: IdSchema,
  title: NameSchema,
  output: z.string().max(2_000_000),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u)
});
export type AutomationHostReviewDependencyOutput = z.infer<
  typeof AutomationHostReviewDependencyOutputSchema
>;

export const AutomationGraphProvenanceSchema = z.strictObject({
  workflowId: IdSchema,
  workflowRevision: z.number().int().positive().safe(),
  workflowName: NameSchema,
  runId: IdSchema,
  runCreatedAt: IsoDateSchema,
  triggerKind: z.enum(["manual", "interval", "folder"]),
  nodeId: IdSchema,
  nodeTitle: NameSchema,
  dependsOn: z.array(IdSchema).max(32),
  attempt: z.number().int().positive().safe(),
  attemptId: IdSchema
});
export type AutomationGraphProvenance = z.infer<
  typeof AutomationGraphProvenanceSchema
>;

export const AutomationHostReviewContextPolicySchema = z.strictObject({
  sourceTurnIds: z.array(IdSchema).min(1).max(128),
  includeSystemPrompt: z.literal(true),
  includeInstruction: z.literal(true),
  includeDependencyOutputs: z.literal(true),
  allowGlobalMemory: z.literal(false),
  allowApprovedExamples: z.literal(false)
});
export type AutomationHostReviewContextPolicy = z.infer<
  typeof AutomationHostReviewContextPolicySchema
>;

export const AutomationHostReviewDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION),
  runId: IdSchema,
  nodeId: IdSchema,
  attemptId: IdSchema,
  workflowId: IdSchema,
  workflowRevision: z.number().int().positive().safe(),
  workflowSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  agentId: IdSchema,
  agentRevision: z.number().int().positive().safe(),
  agentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  caseId: IdSchema,
  sourceTurnIds: z.array(IdSchema).min(1).max(128),
  contextPolicy: AutomationHostReviewContextPolicySchema,
  instruction: PromptSchema,
  systemPrompt: PromptSchema,
  context: z.string().max(MAX_REVIEW_CONTEXT_CHARACTERS),
  dependencyOutputs: z.array(AutomationHostReviewDependencyOutputSchema).max(32),
  runtimeId: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(512),
  routingMode: z.enum(["fixed", "fallback"]),
  fallbackRoutes: z.array(AutomationModelRouteSchema).max(3),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(32).max(8_192),
  provenance: AutomationGraphProvenanceSchema
}).superRefine((descriptor, context) => {
  if (
    descriptor.runId !== descriptor.provenance.runId ||
    descriptor.nodeId !== descriptor.provenance.nodeId ||
    descriptor.attemptId !== descriptor.provenance.attemptId ||
    descriptor.workflowId !== descriptor.provenance.workflowId ||
    descriptor.workflowRevision !== descriptor.provenance.workflowRevision
  ) {
    context.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "Top-level descriptor identity must match provenance."
    });
  }

  if (new Set(descriptor.sourceTurnIds).size !== descriptor.sourceTurnIds.length) {
    context.addIssue({
      code: "custom",
      path: ["sourceTurnIds"],
      message: "Source turn IDs must be unique."
    });
  }

  if (new Set(descriptor.contextPolicy.sourceTurnIds).size !== descriptor.contextPolicy.sourceTurnIds.length) {
    context.addIssue({
      code: "custom",
      path: ["contextPolicy", "sourceTurnIds"],
      message: "Context policy source turn IDs must be unique."
    });
  }

  if (
    descriptor.sourceTurnIds.length !== descriptor.contextPolicy.sourceTurnIds.length ||
    descriptor.sourceTurnIds.some((id, index) => id !== descriptor.contextPolicy.sourceTurnIds[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["contextPolicy", "sourceTurnIds"],
      message: "Context policy source turn IDs must match descriptor source turn IDs."
    });
  }

  if (
    descriptor.dependencyOutputs.length !== descriptor.provenance.dependsOn.length ||
    descriptor.dependencyOutputs.some((dep, index) => dep.nodeId !== descriptor.provenance.dependsOn[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["dependencyOutputs"],
      message: "Dependency outputs must match provenance dependency IDs and order."
    });
  }

  const expectedContext = descriptor.dependencyOutputs
    .map((dep) => `### ${dep.title}\n${dep.output}`)
    .join("\n\n");
  if (descriptor.context !== expectedContext) {
    context.addIssue({
      code: "custom",
      path: ["context"],
      message: "Descriptor context must exactly match joined dependency outputs."
    });
  }

  const totalCharacters =
    descriptor.systemPrompt.length + descriptor.instruction.length + descriptor.context.length;
  if (totalCharacters > MAX_REVIEW_CONTEXT_CHARACTERS) {
    context.addIssue({
      code: "custom",
      path: ["context"],
      message: `Total systemPrompt, instruction, and context characters cannot exceed ${MAX_REVIEW_CONTEXT_CHARACTERS}.`
    });
  }
});
export type AutomationHostReviewDescriptor = z.infer<
  typeof AutomationHostReviewDescriptorSchema
>;

export const AutomationPendingHostReviewInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  attemptId: IdSchema
});
export type AutomationPendingHostReviewInput = z.infer<
  typeof AutomationPendingHostReviewInputSchema
>;

export const AutomationHostReserveAttemptInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  attemptId: IdSchema,
  descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/u)
});
export type AutomationHostReserveAttemptInput = z.infer<
  typeof AutomationHostReserveAttemptInputSchema
>;

export const AutomationHostBindOperationInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  attemptId: IdSchema,
  operationId: IdSchema,
  correlation: IdSchema.optional(),
  correlationId: IdSchema.optional()
});
export type AutomationHostBindOperationInput = z.infer<
  typeof AutomationHostBindOperationInputSchema
>;

export const AutomationHostTerminalStatusSchema = z.enum([
  "completed",
  "failed",
  "stopped",
  "interrupted"
]);
export type AutomationHostTerminalStatus = z.infer<
  typeof AutomationHostTerminalStatusSchema
>;

export const AutomationHostTerminalEvidenceSchema = z.strictObject({
  status: AutomationHostTerminalStatusSchema,
  answerTurnId: IdSchema.nullable(),
  output: z.string().max(2_000_000).nullable(),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable()
});
export type AutomationHostTerminalEvidence = z.infer<
  typeof AutomationHostTerminalEvidenceSchema
>;

export const AutomationHostReconcileTerminalInputSchema = z.strictObject({
  runId: IdSchema.optional(),
  nodeId: IdSchema.optional(),
  attemptId: IdSchema.optional(),
  correlation: IdSchema,
  operationId: IdSchema,
  evidence: AutomationHostTerminalEvidenceSchema.optional(),
  terminalEvidence: AutomationHostTerminalEvidenceSchema.optional()
}).superRefine((input, context) => {
  if (input.evidence === undefined && input.terminalEvidence === undefined) {
    context.addIssue({
      code: "custom",
      path: ["terminalEvidence"],
      message: "Terminal evidence is required."
    });
  }
});
export type AutomationHostReconcileTerminalInput = z.infer<
  typeof AutomationHostReconcileTerminalInputSchema
>;

export const AutomationHostReconcileTerminalResultSchema = z.strictObject({
  run: AutomationRunSnapshotV2Schema
});
export type AutomationHostReconcileTerminalResult = z.infer<
  typeof AutomationHostReconcileTerminalResultSchema
>;
