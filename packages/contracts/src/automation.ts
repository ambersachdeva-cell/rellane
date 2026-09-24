import { z } from "zod";

export const AUTOMATION_SCHEMA_VERSION = 1 as const;

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

export const AutomationWorkflowSchema = z.strictObject({
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

export const AutomationRunStepSchema = z.strictObject({
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

export const AutomationRunSnapshotSchema = z.strictObject({
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
  steps: z.array(AutomationRunStepSchema).min(1).max(32),
  receipts: z.array(AutomationReceiptSchema).max(32)
});
export type AutomationRunSnapshot = z.infer<
  typeof AutomationRunSnapshotSchema
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
