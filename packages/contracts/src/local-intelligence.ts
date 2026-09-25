import { z } from "zod";
import type { ConciergeSnapshot } from "./model-concierge.js";
import type { CaseEnquiryRequest, CaseEnquirySave } from "./enquiry.js";
import type { WorkstationBridge } from "./workstation.js";
import { DesktopErrorSchema } from "./desktop-error.js";
import {
  AutomationAgentSaveInputSchema,
  AutomationArtifactReviewInputSchema,
  AutomationAgentSchema,
  AutomationConnectorEnsureLocalInputSchema,
  AutomationConnectorSchema,
  AutomationPendingHostReviewInputSchema,
  AutomationHostReserveAttemptInputSchema,
  AutomationHostBindOperationInputSchema,
  AutomationHostReconcileTerminalInputSchema,
  AutomationMemoryDocumentSaveInputSchema,
  AutomationMemoryDocumentSchema,
  AutomationReviewBoundWorkflowInputSchema,
  AutomationSourceDocumentSchema,
  AutomationSourceImportInputSchema,
  AutomationRunActionInputSchema,
  AutomationRunSnapshotSchema,
  AutomationDryRunInputSchema,
  AutomationRunStartInputSchema,
  AutomationWorkflowSaveInputSchema,
  AutomationWorkflowPackExportInputSchema,
  AutomationWorkflowPackSchema,
  AutomationWorkflowSchema,
  AutomationWorkspaceSnapshotSchema,
  type AutomationAgent,
  type AutomationAgentSaveInput,
  type AutomationArtifact,
  type AutomationArtifactReviewInput,
  type AutomationConnector,
  type AutomationConnectorEnsureLocalInput,
  type AutomationHostReserveAttemptInput,
  type AutomationHostBindOperationInput,
  type AutomationHostReconcileTerminalInput,
  type AutomationMemoryDocument,
  type AutomationMemoryDocumentSaveInput,
  type AutomationReviewBoundWorkflowInput,
  type AutomationSourceDocument,
  type AutomationRunActionInput,
  type AutomationRunSnapshot,
  type AutomationDryRun,
  type AutomationDryRunInput,
  type AutomationRunStartInput,
  type AutomationWorkflow,
  type AutomationWorkflowSaveInput,
  type AutomationWorkflowPackExportInput,
  type AutomationWorkflowPackFileResult,
  type AutomationWorkspaceSnapshot
} from "./automation.js";
import {
  LicenseAcceptanceIntentSchema,
  ModelInstallCancelRequestSchema,
  ModelInstallStartIntentSchema,
  type LicenseAcceptanceIntent,
  type LicenseAcknowledgement,
  type ModelInstallCancelResult,
  type ModelInstallSnapshot,
  type ModelInstallStatus,
  type ModelLicenseReview
} from "./model-install.js";
export { DesktopErrorSchema, type DesktopError } from "./desktop-error.js";

export const DESKTOP_BRIDGE_VERSION = 4 as const;
export const DAEMON_PROTOCOL_VERSION = 5 as const;

const IdSchema = z.uuid();
const IsoDateSchema = z.iso.datetime({ offset: true });
const SafeTextSchema = z.string().trim().min(1).max(32_000);

export const QualityModeSchema = z.enum(["fast", "balanced", "quality"]);
export type QualityMode = z.infer<typeof QualityModeSchema>;

export const HardwareProfileSchema = z.object({
  platform: z.enum(["darwin", "linux", "win32", "other"]),
  operatingSystem: z.string().min(1).max(256),
  architecture: z.string().min(1).max(64),
  chip: z.string().min(1).max(256),
  gpuName: z.string().min(1).max(512).nullable(),
  dedicatedGpuMemoryBytes: z.number().int().nonnegative().safe().nullable(),
  logicalCores: z.number().int().positive().max(1024),
  memoryBytes: z.number().int().nonnegative().safe(),
  freeDiskBytes: z.number().int().nonnegative().safe(),
  acceleration: z.enum(["metal", "cuda", "hip", "vulkan", "sycl", "cpu", "unknown"]),
  recommendation: QualityModeSchema,
  recommendationReason: z.string().min(1).max(500),
  measuredAt: IsoDateSchema
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

export const RuntimeKindSchema = z.enum([
  "ollama",
  "lm-studio",
  "managed-llama"
]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const CADRANE_LOCAL_BASE_URLS = [
  "http://127.0.0.1:12340",
  "http://127.0.0.1:12341",
  "http://127.0.0.1:12342",
  "http://127.0.0.1:12343",
  "http://127.0.0.1:12344",
  "http://127.0.0.1:12345",
  "http://127.0.0.1:12346",
  "http://127.0.0.1:12347",
  "http://127.0.0.1:12348",
  "http://127.0.0.1:12349"
] as const;
export const CadraneLocalBaseUrlSchema = z.enum(CADRANE_LOCAL_BASE_URLS);
export type CadraneLocalBaseUrl = z.infer<typeof CadraneLocalBaseUrlSchema>;

export const RuntimeModelSchema = z.object({
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(512),
  sizeBytes: z.number().int().nonnegative().safe().nullable(),
  loaded: z.boolean().nullable()
});
export type RuntimeModel = z.infer<typeof RuntimeModelSchema>;

const RuntimeDescriptorFields = {
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
  state: z.enum(["available", "unavailable", "attention"]),
  version: z.string().max(100).nullable(),
  models: z.array(RuntimeModelSchema).max(256),
  detail: z.string().min(1).max(500),
  checkedAt: IsoDateSchema
} as const;

export const RuntimeDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...RuntimeDescriptorFields,
    kind: z.literal("ollama"),
    baseUrl: z.literal("http://127.0.0.1:11434")
  }),
  z.strictObject({
    ...RuntimeDescriptorFields,
    kind: z.literal("lm-studio"),
    baseUrl: z.union([
      z.literal("http://127.0.0.1:1234"),
      CadraneLocalBaseUrlSchema
    ])
  }),
  z.strictObject({
    ...RuntimeDescriptorFields,
    kind: z.literal("managed-llama"),
    baseUrl: z.null()
  })
]);
export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: SafeTextSchema
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const LocalChatRequestSchema = z.object({
  operationId: IdSchema,
  runtimeId: z.string().min(1).max(80),
  modelId: z.string().min(1).max(512),
  messages: z.array(ChatMessageSchema).min(1).max(64),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(32).max(8_192).default(2_048),
  responseProfile: z.enum(["print-enquiry-v1", "local-draft-v1", "bill-excerpts-v1", "graph-node-v1"]).optional()
}).superRefine((value, context) => {
  if (value.responseProfile && value.runtimeId !== "cadrane-local-loopback")
    context.addIssue({ code: "custom", path: ["responseProfile"],
      message: "This response profile requires the bundled local runtime." });
  const totalCharacters = value.messages.reduce(
    (sum, message) => sum + message.content.length,
    0
  );
  if (totalCharacters > 256_000) {
    context.addIssue({
      code: "custom",
      path: ["messages"],
      message: "The combined chat input exceeds the 256,000-character local safety limit."
    });
  }
});
export type LocalChatRequest = z.infer<typeof LocalChatRequestSchema>;

export const LocalChatResultSchema = z.object({
  operationId: IdSchema,
  runtimeId: z.string().min(1).max(80),
  modelId: z.string().min(1).max(512),
  content: z.string().max(2_000_000),
  startedAt: IsoDateSchema,
  finishedAt: IsoDateSchema,
  localOnly: z.literal(true)
});
export type LocalChatResult = z.infer<typeof LocalChatResultSchema>;

/** A bounded request whose sources are selected from this room, never a folder scan. */
export const CaseLocalRequestSchema = z.strictObject({
  id: z.string().min(1).max(64),
  operationId: z.uuid(),
  modelId: z.string().min(1).max(512),
  question: z.string().trim().min(1).max(4_000),
  sourceTurnIds: z.array(z.uuid()).max(20).refine(ids => new Set(ids).size === ids.length, "Select each source once.")
});
export type CaseLocalRequest = z.infer<typeof CaseLocalRequestSchema>;

/** A preview carries text and provenance, never a replayable filesystem path. */
export interface CaseSourcePreview {
  readonly token: string;
  readonly fileName: string;
  readonly format: "txt" | "md" | "docx" | "csv";
  readonly text: string;
  readonly bytes: number;
  readonly fileSha256: string;
  readonly textSha256: string;
  readonly coverage: string;
  readonly expiresAt: number;
}
export const CaseSourceCommitSchema = z.strictObject({
  id: z.string().min(1).max(64), token: z.uuid(),
  startOffset: z.number().int().min(0).max(50_000).optional(),
  endOffset: z.number().int().min(1).max(50_000).optional()
}).refine(value => (value.startOffset === undefined) === (value.endOffset === undefined), "Select a complete text range.");
export type CaseSourceCommit = z.infer<typeof CaseSourceCommitSchema>;

/** Data operations have a finite vocabulary; a model never supplies executable SQL. */
export const CaseDataQuerySchema = z.strictObject({
  id: z.string().min(1).max(64),
  sourceTurnId: z.uuid(),
  operation: z.enum(["count", "total"]),
  valueColumn: z.number().int().min(0).max(31).nullable(),
  groupColumn: z.number().int().min(0).max(31).nullable(),
  unit: z.enum(["number", "INR"]),
  filter: z.strictObject({
    column: z.number().int().min(0).max(31),
    equals: z.string().max(2_000)
  }).nullable()
});
export type CaseDataQuery = z.infer<typeof CaseDataQuerySchema>;
export const CaseDataSaveSchema = z.strictObject({
  query: CaseDataQuerySchema,
  operationId: z.uuid()
});
export type CaseDataSave = z.infer<typeof CaseDataSaveSchema>;
export interface CaseDataReview {
  readonly sourceTurnId: string;
  readonly columns: readonly string[];
  readonly sourceRows: number;
  readonly matchedRows: number;
  readonly blankValues: number;
  readonly total: string | null;
  readonly groups: readonly {
    label: string; count: number; total: string | null;
    rowNumbers: readonly number[];
  }[];
  readonly previewRows: readonly { row: number; cells: readonly string[] }[];
  readonly evidence: string;
}

/** Saved work is independent of the conversation that produced it. */
export const CaseArtifactSaveSchema = z.strictObject({
  id: z.string().min(1).max(64),
  baseVersionId: z.uuid().nullable(),
  sourceTurnId: z.uuid().nullable(),
  body: z.string().min(1).max(50_000).refine(value => value.trim().length > 0, "Output cannot be blank.")
});
export type CaseArtifactSave = z.infer<typeof CaseArtifactSaveSchema>;
/** One selected region of an existing saved output; impact is calculated in main. */
export const CaseArtifactEditPreviewInputSchema = z.strictObject({
  id: z.string().min(1).max(64),
  baseVersionId: z.uuid(),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  selectionStart: z.number().int().min(0).max(50_000),
  selectionEnd: z.number().int().min(0).max(50_000),
  replacement: z.string().max(50_000)
});
export type CaseArtifactEditPreviewInput = z.infer<typeof CaseArtifactEditPreviewInputSchema>;
export interface CaseArtifactEditReview {
  readonly token: string;
  readonly expiresAt: number;
  readonly caseId: string;
  readonly baseVersionId: string;
  readonly baseSha256: string;
  readonly newBody: string;
  readonly preview: {
    readonly affectedScope: { readonly start: number; readonly end: number };
    readonly userSuppliedScopeLabel: string | null;
    readonly codeUnits: { readonly before: number; readonly after: number; readonly delta: number; readonly totalBefore: number; readonly totalAfter: number };
    readonly lines: { readonly delta: number; readonly totalBefore: number; readonly totalAfter: number; readonly selectedLines: number; readonly replacementLines: number };
    readonly excerpts: { readonly before: string; readonly after: string };
    readonly unchangedPrefix: { readonly length: number; readonly sha256: string };
    readonly unchangedSuffix: { readonly length: number; readonly sha256: string };
    readonly expectedSha256: string;
  };
}
export interface CaseArtifactVersion {
  readonly id: string;
  readonly revision: number;
  readonly sourceTurnId: string | null;
  readonly body: string;
  readonly createdAt: number;
  readonly acceptedAt: number | null;
}

export const CaseArtifactExportSchema = z.strictObject({
  id: z.string().min(1).max(64),
  versionId: z.uuid(),
  format: z.enum(["docx", "md"]).default("md")
});
export type CaseArtifactFormat = "docx" | "md";
export interface CaseArtifactExportResult {
  readonly written: boolean;
  readonly fileName: string | null;
  readonly receiptRecorded: boolean;
}
export interface CaseArtifactExport {
  readonly id: string;
  readonly versionId: string;
  readonly revision: number;
  readonly format: CaseArtifactFormat;
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly state: "pending" | "written" | "failed";
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly acceptedAt: number | null;
}

export const GgufInspectionSchema = z.object({
  importId: IdSchema,
  displayName: z.string().min(1).max(512),
  sizeBytes: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.literal(3),
  tensorCount: z.string().regex(/^[1-9][0-9]*$/),
  metadataCount: z.string().regex(/^[1-9][0-9]*$/),
  status: z.literal("header-verified"),
  warning: z.string().min(1).max(1_000)
});
export type GgufInspection = z.infer<typeof GgufInspectionSchema>;

export const DaemonRequestSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("system.profile"),
    payload: z.object({ dataDir: z.string().min(1).max(4_096) })
  }),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("runtime.discover"),
    payload: z.object({})
  }),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("runtime.chat"),
    payload: LocalChatRequestSchema
  }),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("runtime.cancel"),
    payload: z.object({ operationId: IdSchema })
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.snapshot"),
    payload: z.strictObject({})
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.agent.save"),
    payload: AutomationAgentSaveInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.workflow.save"),
    payload: AutomationWorkflowSaveInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.workflow.save-review-bound"),
    payload: AutomationReviewBoundWorkflowInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.memory.save"),
    payload: AutomationMemoryDocumentSaveInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.source.save"),
    payload: AutomationSourceImportInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.artifact.review"),
    payload: AutomationArtifactReviewInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.connector.ensure-local"),
    payload: AutomationConnectorEnsureLocalInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.pack.export"),
    payload: AutomationWorkflowPackExportInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.pack.import"),
    payload: AutomationWorkflowPackSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.dry-run"),
    payload: AutomationDryRunInputSchema
  }),
  /**
   * A granted folder changed.
   *
   * Sent by the desktop's watcher, which is the only thing that knows: the
   * daemon has no access to the owner's folders and must not acquire one to
   * learn that a file moved.
   */
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.folder-changed"),
    payload: z.strictObject({ root: z.string().min(1).max(4_096) })
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.run.start"),
    payload: AutomationRunStartInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.run.action"),
    payload: AutomationRunActionInputSchema
  }),
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.host-review.describe"),
    payload: AutomationPendingHostReviewInputSchema
  }),
  /**
   * Private main-to-daemon transport for review-bound graph Host attempt reservation.
   *
   * Private main-to-daemon transport only.
   * Do NOT add a renderer-facing IPC route for reserve/bind/reconcile or a caller-supplied completed flag.
   */
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.host-attempt.reserve"),
    payload: AutomationHostReserveAttemptInputSchema
  }),
  /**
   * Private main-to-daemon transport for review-bound graph Host operation binding.
   *
   * Private main-to-daemon transport only.
   * Do NOT add a renderer-facing IPC route for reserve/bind/reconcile or a caller-supplied completed flag.
   */
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.host-attempt.bind"),
    payload: AutomationHostBindOperationInputSchema
  }),
  /**
   * Private main-to-daemon transport for review-bound graph Host terminal reconciliation.
   *
   * Private main-to-daemon transport only.
   * Only main-process WorkstationHost may invoke this after reading proven Book terminal evidence.
   */
  z.strictObject({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("automation.host-attempt.reconcile"),
    payload: AutomationHostReconcileTerminalInputSchema
  }),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.recommend"),
    payload: z.object({
      dataDir: z.string().min(1).max(4_096),
      mode: QualityModeSchema.nullable()
    })
  }),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.inspect"),
    payload: z.object({ selectedPath: z.string().min(1).max(4_096) })
  }),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.install.snapshot"),
    payload: z.object({}).strict()
  }).strict(),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.license.review"),
    payload: ModelInstallStartIntentSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.license.acknowledge"),
    payload: LicenseAcceptanceIntentSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.install.start"),
    payload: ModelInstallStartIntentSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("model.install.cancel"),
    payload: ModelInstallCancelRequestSchema
  }).strict(),
  z.object({
    protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
    requestId: IdSchema,
    type: z.literal("request.cancel"),
    payload: z.object({ targetRequestId: IdSchema })
  })
]);
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;

/** Renderer-safe readiness shape; private session authority is daemon-control only. */
export const DaemonReadyEventSchema = z.object({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  type: z.literal("daemon.ready"),
  pid: z.number().int().positive()
});
export type DaemonReadyEvent = z.infer<typeof DaemonReadyEventSchema>;

export const DaemonResponseSchema = z.object({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  requestId: IdSchema,
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: DesktopErrorSchema.optional()
}).superRefine((value, context) => {
  if (value.ok && value.data === undefined) {
    context.addIssue({
      code: "custom",
      message: "A successful response requires data",
      path: ["data"]
    });
  }
  if (!value.ok && value.error === undefined) {
    context.addIssue({
      code: "custom",
      message: "A failed response requires an error",
      path: ["error"]
    });
  }
});
export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;

export type BrainProviderId = "claude" | "antigravity" | "gemini";

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface BrainInstallation {
  readonly providerId: BrainProviderId;
  readonly label: string;
  readonly executablePath: string;
  readonly version: string;
}

export interface CapabilityStatus {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly state: CapabilityState;
  readonly reason?: string | undefined;
}

export interface BrainStatus {
  readonly installations: readonly BrainInstallation[];
  readonly docked: BrainInstallation | null;
  readonly capabilities: readonly CapabilityStatus[];
  /**
   * The bundled on-device model. Reported alongside the docked CLI because
   * from the user's side both are simply "the engine".
   */
  readonly localRuntime: { readonly available: boolean; readonly problem: string | null };
}

/**
 * The Engine Room — every engine Rellane can think with, and whether it is there.
 *
 * This surface exists because of a specific failure: the app used to say
 * `Engine OFF` in the header with no explanation and no way to act, which is
 * the exact thing DESIGN.md principle 4 forbids — "Ready is clickable to the
 * probe that decided it." Every state below carries the probe that produced it.
 */
// Detected establishes tool presence only; it cannot admit a model request.
export type EngineState = "detected" | "ready" | "not-installed" | "checking" | "problem";

export type EngineTier = "frontier" | "balanced" | "fast" | "on-device";

/** How you are paying to use an engine — the thing that actually decides. */
export type EngineAccess = "subscription" | "on-device" | "api-key";

export interface EngineModel {
  readonly id: string;
  readonly label: string;
  readonly tier: EngineTier;
  /** "Deepest", "Balanced", "Quick", "On this Mac". */
  readonly tierLabel: string;
  /** A sentence a person could choose from. Never a benchmark. */
  readonly note: string;
  /** True when using it costs nothing beyond a plan already being paid for. */
  readonly includedInSubscription: boolean;
}

/**
 * What was actually run to decide an engine's state.
 *
 * The executable path is included deliberately. DESIGN.md §8 forbids handing
 * the renderer a path it could replay *into the owner's files*; this is the
 * location of a CLI the owner installed themselves, and it is the single most
 * useful thing on the row when two versions are fighting.
 */
export interface EngineEvidence {
  readonly checkedAt: string;
  /** "Ran claude --version" */
  readonly method: string;
  /** Exactly what came back, trimmed. Never paraphrased. */
  readonly result: string;
  readonly executablePath: string | null;
}

export interface EngineStatus {
  readonly id: string;
  readonly label: string;
  readonly access: EngineAccess;
  readonly accessLabel: string;
  readonly state: EngineState;
  /** One sentence: what it is, or why it is not. */
  readonly summary: string;
  /** What to do about a red light. Null when there is nothing to do. */
  readonly fixHint: string | null;
  readonly evidence: EngineEvidence | null;
  readonly models: readonly EngineModel[];
}

export interface EngineRoomStatus {
  readonly engines: readonly EngineStatus[];
  /** A default among verified ready models, not evidence of an active request. */
  readonly active: { readonly engineId: string; readonly modelId: string } | null;
  readonly checkedAt: string;
  /**
   * True when no model is verified ready. Manual work remains available. The
   * on-device engine alone is a working state, and the UI must not nag someone
   * who deliberately runs local-only.
   */
  readonly allUnavailable: boolean;
}

/**
 * An agent's brief — what it is, where it works, and what it may do.
 *
 * The organising decision: **an agent is a declaration, not code.** The same
 * reasoning as the flow document — a brief can be read, diffed, reviewed,
 * version-controlled, generated by a model and, most importantly, *shown to the
 * owner before it runs*. An agent whose operating context lives in a prompt
 * string somewhere is one nobody can audit.
 *
 * This is the surface Amber asked for: "an interface where we tell it what it's
 * working in."
 */

/** Where an agent is allowed to look for what it knows. */
export type ContextSource = "folders" | "timeline" | "book" | "vault" | "glossary";

/**
 * What an agent may do outbound.
 *
 * There is deliberately no "auto". The hard rule is that anything leaving the
 * Mac asks first, and the rule is enforced here by making the alternative
 * unrepresentable rather than by a check somewhere that could be forgotten.
 */
export type OutboundPolicy = "never" | "ask";

export interface AgentBrief {
  readonly id: string;
  readonly name: string;
  /** What it is for, in one sentence, in the owner's words. */
  readonly purpose: string;
  /** Standing instructions. The system prompt, named for what it actually is. */
  readonly instructions: string;
  readonly workspace: {
    /**
     * Granted roots this agent may see. Never all of them by default — an agent
     * that can read every folder you ever granted is one you cannot reason
     * about, and "it only needed Downloads" is not a thing you can verify after
     * the fact.
     */
    readonly folders: readonly string[];
    readonly reads: readonly ContextSource[];
  };
  /** Capability ids. Clamped by the platform ceiling before it is shown. */
  readonly capabilities: readonly string[];
  readonly engine: {
    readonly tier: EngineTier;
    /** Pin one engine, or let the Engine Room pick whatever is ready at that tier. */
    readonly pinnedEngineId: string | null;
  };
  readonly limits: {
    readonly maxSteps: number;
    readonly maxMinutes: number;
  };
  readonly outbound: OutboundPolicy;
}

/**
 * A brief after the platform ceiling has been applied.
 *
 * DESIGN.md principle 2: the UI displays the *post-ceiling* reality. A brief
 * asking for a folder that is no longer granted, or a capability that does not
 * exist, is shown as what it will actually get — with the difference named,
 * because silently dropping a request is how somebody comes to believe an agent
 * can do something it cannot.
 */
export interface ResolvedBrief {
  readonly brief: AgentBrief;
  readonly folders: readonly string[];
  readonly capabilities: readonly string[];
  /** Everything asked for and not granted, each with a reason. */
  readonly withheld: readonly { readonly what: string; readonly why: string }[];
  /** The whole brief as one readable sentence. */
  readonly sentence: string;
  /** True when it cannot usefully run — no folders, or no capabilities. */
  readonly inert: boolean;
}

/**
 * One agent, as the screen shows it.
 *
 * Flattened deliberately: the renderer gets the resolved sentence and the
 * generated prompt, never the raw brief plus a ceiling to apply itself. Two
 * places computing what an agent may do is two places to get it wrong, and the
 * one in the renderer would be the one nobody tested.
 */
/** What a customer owes, derived from the bills rather than stored. */
export interface PartyStanding {
  readonly partyId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly billedPaise: number;
  readonly paidPaise: number;
  /** Negative means they are in credit. */
  readonly owedPaise: number;
  readonly oldestUnpaidOn: number | null;
  readonly openBills: number;
  /** What the owner wrote about them. Prose only — never a figure. */
  readonly note: string | null;
}

export interface OverdueBill {
  readonly invoiceId: string;
  readonly number: string | null;
  readonly partyId: string;
  readonly name: string;
  readonly totalPaise: number;
  readonly dueOn: number;
  readonly daysLate: number;
}

/** The state of the business, as the home screen shows it. */
export interface BookStanding {
  /** Everyone on the books, owing or not — what a form needs to offer. */
  readonly parties: readonly PartyStanding[];
  readonly owing: readonly PartyStanding[];
  readonly overdue: readonly OverdueBill[];
  readonly totalOwedPaise: number;
  readonly counts: { readonly parties: number; readonly invoices: number };
}

/**
 * One word Rellane has learned, and why it believes it.
 *
 * `evidence` is required rather than optional, which is the point: a vocabulary
 * that cannot say where a term came from is indistinguishable from one that
 * invented it, and this list is fed to a model that will repeat it confidently.
 */
/** Whether this build is behind, and what updating would cost. */
/**
 * What an agent is doing, while it is doing it.
 *
 * A spinner for a minute is indistinguishable from a hang, and it hides the one
 * thing worth watching: which file is being read. That is what somebody would
 * interrupt over.
 */
/** A brief read out of a file, rebuilt from fields this build recognises. */
export interface ImportedBrief {
  readonly ok: boolean;
  readonly brief: {
    readonly name: string;
    readonly purpose: string;
    readonly instructions: string;
    readonly reads: readonly ContextSource[];
    readonly capabilities: readonly string[];
    readonly tier: EngineTier;
    readonly prefersEngineId: string | null;
    readonly limits: { readonly maxSteps: number; readonly maxMinutes: number };
    readonly outbound: OutboundPolicy;
  } | null;
  readonly said: string;
}

/** One flow somebody could start from. */
export interface FlowTemplateCard {
  readonly id: string;
  readonly name: string;
  readonly says: string;
  /** Why you would want it. Shown under the name. */
  readonly because: string;
  readonly needsFolder: boolean;
  readonly steps: number;
}

/** One field a bill reader proposed, with the words it read it from. */
export interface Proposed<T> {
  readonly value: T | null;
  readonly from: string | null;
  /** Why this field could not become a value. Null is unresolved, not absent. */
  readonly problem?: string;
}

export const BILL_FIELDS = ["partyName", "number", "issuedOn", "dueOn", "subtotal", "tax", "total"] as const;
export const BILL_TEXT_LIMIT = 8_000;
export const BillExcerptsSchema = z.object({
  scope: z.enum(["one_bill", "multiple_bills", "unclear"]),
  fields: z.object({
    partyName: z.string().min(1).max(400).nullable(),
    number: z.string().min(1).max(400).nullable(),
    issuedOn: z.string().min(1).max(400).nullable(),
    dueOn: z.string().min(1).max(400).nullable(),
    subtotal: z.string().min(1).max(400).nullable(),
    tax: z.string().min(1).max(400).nullable(),
    total: z.string().min(1).max(400).nullable()
  }).strict()
}).strict();
export const LocalShortcutKindSchema = z.enum(["agent-brief", "bill-text", "bill-file", "context-selection"]);
export type LocalShortcutKind = z.infer<typeof LocalShortcutKindSchema>;

/** A bill read out of text. Every field is a proposal, never a fact (D-062). */
export interface BillRead {
  readonly ok: boolean;
  readonly said: string;
  /** Set when subtotal plus tax does not equal the total it read. */
  readonly disagreement: string | null;
  readonly bill: {
    readonly partyName: Proposed<string>;
    readonly number: Proposed<string>;
    readonly issuedOn: Proposed<string>;
    readonly dueOn: Proposed<string>;
    readonly subtotalPaise: Proposed<number>;
    readonly taxPaise: Proposed<number>;
    readonly totalPaise: Proposed<number>;
  } | null;
}

/** A bill read off a photograph, a scan or a PDF. */
export interface DocumentRead {
  readonly ok: boolean;
  /** The extraction method, not an authenticity or accuracy verdict. */
  readonly source: "qr" | "pdf-text" | "ocr" | "none";
  readonly text: string;
  readonly codes: readonly string[];
  readonly said: string;
  /** The proposal, when there was enough to read one. */
  readonly bill?: BillRead;
}

/** What Rellane said back, and where it decided to send you. */
export interface DeskAnswer {
  readonly kind: "book" | "bill" | "bench" | "agent" | "chase" | "ask" | "refused";
  /** The words that decided the route, so a wrong guess can be corrected. */
  readonly because: string;
  readonly said: string;
  /** A surface to open, rather than a paragraph describing one. */
  readonly open: { readonly what: "bill" | "bench" | "agent"; readonly id?: string } | null;
  /**
   * A message written and ready, with nowhere it can go on its own.
   *
   * The owner presses send, in their own WhatsApp. This is the outbound rule
   * implemented by the operating system rather than promised by us — there is no
   * code path from here to anybody.
   */
  readonly draft: {
    readonly to: string;
    readonly text: string;
    readonly whatsapp: string | null;
    readonly pay: string | null;
  } | null;
}

/** What a flow would have done, replayed against real folder history. */
export interface FlowBacktest {
  readonly workflowId: string;
  readonly since: string | null;
  readonly starts: number;
  readonly trips: number;
  readonly worstBurst: number;
  readonly ok: boolean;
  readonly said: string;
}

export interface RunProgress {
  readonly runId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly step: number;
  readonly ofSteps: number;
  readonly stage: "thinking" | "reading" | "answering";
  readonly said: string;
}

/**
 * An engine that can be reached with a key the owner pays per token for.
 *
 * The fallback, and it stays the fallback: D-022's order is your subscription,
 * then this Mac, then a key. Somebody paying for Claude Pro must not then pay
 * per token for what they already bought.
 */
/** What one engine's record looks like across every argument it was in. */
export interface EngineRecord {
  readonly engine: string;
  readonly arguments: number;
  /** Times the other side conceded to this one. */
  readonly wonOver: number;
  readonly gaveWay: number;
  readonly approxTokens: number;
}

/**
 * What this Mac's own arguments say about which engine to trust.
 *
 * Evidence, not a decision: nothing here changes which engine answers. And it
 * says nothing until there is enough — a handful of arguments can make one
 * engine look twice as good as another, which is noise wearing a percentage.
 */
export interface Routing {
  readonly total: number;
  readonly enoughToSay: boolean;
  readonly engines: readonly EngineRecord[];
  readonly said: string;
}

export interface KeyedEngineStatus {
  readonly id: string;
  readonly label: string;
  /** Where to get one, said plainly on the screen that asks. */
  readonly keysAt: string;
  readonly stored: boolean;
}

export interface UpdateCheck {
  readonly current: string;
  readonly latest: string | null;
  readonly behind: boolean;
  readonly url: string;
  readonly costs: readonly string[];
  readonly said: string;
}

export interface LearnedTerm {
  readonly key: string;
  readonly kind: "party" | "item";
  readonly term: string;
  readonly meaning: string;
  readonly aliases: readonly string[];
  readonly evidence: string;
  readonly sightings: number;
}

/** A granted folder, and whether Rellane is currently looking at it. */
export interface SeenFolder {
  readonly path: string;
  readonly name: string;
  /** False when paused. Nothing from a paused folder reaches anything. */
  readonly watching: boolean;
  /** How many files the last capture held. Never which ones. */
  readonly files: number | null;
  readonly lastSeenAt: string | null;
}

/**
 * Cases, as this screen reports them.
 *
 * Open ones are named because the owner named them; closed ones are counted.
 * **What was said inside them never appears here.** A screen about what a product
 * knows should not be the place your own conversations are readable from.
 */
export interface SeenCases {
  readonly open: number;
  readonly closed: number;
  readonly openTitles: readonly string[];
}

/** Everything the owner is owed a view of, on one screen. */
export interface Seen {
  readonly terms: readonly LearnedTerm[];
  readonly folders: readonly SeenFolder[];
  readonly notes: readonly { readonly partyName: string; readonly note: string }[];
  readonly cases: SeenCases;
  readonly empty: boolean;
}

/** What one pass of the Vault did, in both directions. */
export interface VaultSyncResult {
  readonly written: number;
  readonly removed: number;
  readonly folder: string;
  readonly notesFound: number;
  readonly notesSaved: number;
}

export interface AgentCard {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  /** The requested brief for lossless editing; it grants no access by itself. */
  readonly brief: AgentBrief;
  /** The whole brief as one line a person can check. */
  readonly sentence: string;
  readonly tierLabel: string;
  readonly outbound: OutboundPolicy;
  readonly withheld: readonly { readonly what: string; readonly why: string }[];
  readonly inert: boolean;
  /**
   * The folders it was actually granted, in full.
   *
   * Sent so the editor can reopen a brief as it stands. Not a new disclosure:
   * the renderer already receives these exact paths from `workspace.roots()`,
   * and withholding them here would only mean editing an agent silently
   * forgets which folders it had.
   */
  readonly folders: readonly string[];
  readonly capabilities: readonly string[];
  /** False for the three that ship, which cannot be edited or removed. */
  readonly custom: boolean;
  /** Exactly what the model is told, generated from the same brief. */
  readonly systemPrompt: string;
}

/** What a finished agent run looks like to the screen. */
/** One turn of an argument, as the screen shows it. */
export interface BenchTurnResult {
  /** The third seat, "adjudicator", is reserved for decision by evidence. */
  readonly seat: "proposer" | "adversary" | "adjudicator";
  readonly engineLabel: string;
  /** agree · disagree · concede · hold · unclear, as read from what it wrote. */
  readonly verdict: string;
  readonly text: string;
  readonly approxTokens: number;
}

/**
 * One finished argument between two subscriptions.
 *
 * `ok: false` is an ordinary outcome, not an error — "only one engine is ready"
 * is the most likely thing this returns on a fresh install, and it is a screen
 * with a fix on it rather than an exception nobody sees.
 */
export interface BenchResult {
  readonly ok: boolean;
  /** Set only when the argument could not be held. Always says what to do. */
  readonly problem: string | null;
  readonly question: string;
  readonly outcome: "agreed" | "corrected" | "unresolved" | "exhausted" | "failed" | null;
  /** One sentence for the record. */
  readonly summary: string;
  /** The conclusion as it stands at the end. Empty when nothing survived. */
  readonly answer: string;
  readonly rounds: number;
  readonly approxTokens: number;
  /** Why it stopped, in the owner's words. */
  readonly stoppedBecause: string;
  readonly seats: { readonly proposer: string; readonly adversary: string } | null;
  readonly turns: readonly BenchTurnResult[];
  /**
   * What each side spent.
   *
   * Per seat rather than only in total: an argument where one side wrote four
   * times as much as the other is not a balanced argument, and a combined
   * figure hides exactly the imbalance somebody would act on.
   */
  readonly spend: BenchSpend;
  /**
   * What the book says about any figure either side stated.
   *
   * Null when there is no book open. `checked: false` — the common case — means
   * nothing in the argument was a claim the records could settle, which is said
   * plainly so a silent adjudicator is never read as agreement.
   */
  readonly adjudication: Adjudication | null;
}

/** A figure the book could check, and what the book says. */
export interface Claim {
  readonly party: string;
  readonly saidPaise: number;
  readonly actualPaise: number;
  readonly right: boolean;
  /** The words it was read from, so a person can check the checker. */
  readonly from: string;
}

/**
 * Evidence settling what evidence can settle.
 *
 * No engine is involved: it is a query and a regular expression, which is
 * exactly why its verdict is worth more than a third opinion — it cannot be
 * argued with and cannot be flattered.
 */
export interface Adjudication {
  readonly checked: boolean;
  readonly claims: readonly Claim[];
  readonly wrong: readonly ("proposer" | "adversary")[];
  readonly said: string;
}

/** What each seat spent, in tokens — a subscription has no per-token price. */
export interface BenchSpend {
  readonly proposerTokens: number;
  readonly adversaryTokens: number;
  readonly totalTokens: number;
  /** How much of the budget is gone, 0–1. */
  readonly fraction: number;
}

/** One turn landing, pushed while the argument is still running. */
export interface BenchProgress {
  readonly seat: "proposer" | "adversary" | "adjudicator";
  readonly engineLabel: string;
  readonly approxTokens: number;
  readonly spend: BenchSpend;
}

/** What happened when a draft was handed to a channel. */
export interface StageResult {
  readonly staged: boolean;
  /** What happened, in the owner's words. Set on success and on refusal. */
  readonly said: string;
}

/** One tool a connector advertises, as the owner sees it. */
export interface ConnectorToolView {
  readonly serverId: string;
  readonly serverLabel: string;
  readonly name: string;
  /** Written by whoever wrote the connector. Untrusted text. */
  readonly description: string;
  /** Computed in the main process. Sent back verbatim when approving. */
  readonly descriptionHash: string;
  /** The connector's own claim that this only reads. Shown, never believed. */
  readonly claimsReadOnly: boolean;
  readonly approved: boolean;
  /** The connector altered a tool the owner had already approved. */
  readonly changedSinceApproval: boolean;
  /** Set when the description reads like an instruction rather than a description. */
  readonly suspicious: string | null;
}

export interface ConnectorView {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  /** Null until it has been reached. */
  readonly tools: readonly ConnectorToolView[] | null;
  readonly problem: string | null;
}

/** What can be installed, with its licence already checked. */
export interface ConnectorOffer {
  readonly id: string;
  readonly label: string;
  readonly gives: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly licence: "MIT" | "Apache-2.0";
  readonly by: string;
  readonly homepage: string;
  readonly needs: string | null;
}

export interface ConnectorsSnapshot {
  readonly installed: readonly ConnectorView[];
  readonly available: readonly ConnectorOffer[];
  /** Attribution owed, generated from what is installed so it cannot drift. */
  readonly notices: string;
}

export interface AgentRunResult {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly outcome: "answered" | "refused" | "stopped" | "failed";
  /** One sentence for the record. */
  readonly summary: string;
  /** What it produced. Empty unless it answered. */
  readonly answer: string;
  /** Present on every outcome but "answered", and always says what to do. */
  readonly problem: string | null;
  /** Named only when it was not the tier the brief asked for. */
  readonly substituted: string | null;
  readonly ranOnLabel: string | null;
  /**
   * What it looked at to answer, in the owner's words.
   *
   * The product's one promise is a receipt for everything it touched. An agent
   * that quietly read four files and printed only a conclusion breaks that
   * promise more thoroughly than one that refused to run.
   */
  readonly read: readonly string[];
  readonly elapsedMs: number;
  readonly approxTokens: number;
  /** Present for host runs with a durable start; older/development callers may omit it. */
  readonly workroomId?: string | null;
  /** A visible persistence failure, never silently reported as saved work. */
  readonly recordProblem?: string | null;
}

export interface SkillPreviewStep {
  readonly summary: string;
  readonly reason: string;
}

/**
 * Whether this particular folder can actually be put back, measured before the
 * plan sheet claims it can.
 *
 * The sheet used to state "Rellane copies the folder first" as a property of
 * the product. It is not one: it is a property of the volume the folder happens
 * to sit on. An APFS clone into Rellane's own temp directory needs both ends on
 * the same volume, so an external drive, a network share, or a FAT-formatted
 * stick all fail it — and above `FALLBACK_MAX_BYTES` the real copy is refused
 * rather than run. On those folders the old sentence was a promise the executor
 * would then break, printed on the one screen the trust model rests on.
 *
 * `bytes` is on every branch because the reader's next question after "this
 * one gets copied properly" is always "copied how much".
 */
export type UndoOutlook =
  /** Same volume, APFS: copy-on-write, so the snapshot costs no disk. */
  | { readonly kind: "instant"; readonly bytes: number }
  /** No clone available, but small enough that a real copy is honest. */
  | { readonly kind: "copied"; readonly bytes: number }
  /** No undo is possible here. `reason` names the limit, in the owner's words. */
  | { readonly kind: "unavailable"; readonly bytes: number; readonly reason: string };

export interface SkillPreview {
  /** One sentence describing the whole plan, before anything happens. */
  readonly headline: string;
  readonly steps: readonly SkillPreviewStep[];
  /** What was deliberately left alone, and why. Never silently dropped. */
  readonly untouched: readonly { readonly name: string; readonly reason: string }[];
  readonly planId: string;
  /**
   * How long the undo window stays open once this has run, in minutes.
   *
   * The plan sheet used to promise that "everything here can be undone
   * afterwards" — unbounded, and stated before the snapshot that makes undo
   * possible had been taken. Undo is deliberately time-boxed, because holding
   * reversal state forever means holding copies of the owner's files forever,
   * so the sheet has to say the real terms at the moment consent is given
   * rather than let someone discover them after lunch.
   *
   * Carried on the preview so the number has a source: it is derived from
   * UNDO_WINDOW_MS rather than written into a sentence and left to drift.
   */
  readonly undoWindowMinutes: number;
  /**
   * Whether a pre-image is achievable for *this* folder, probed rather than
   * assumed. The window above says how long undo lasts; this says whether there
   * will be an undo at all.
   */
  readonly undo: UndoOutlook;
}

export interface SkillRunStep {
  readonly summary: string;
  readonly outcome: "done" | "refused" | "failed" | "drafted";
  readonly error?: string | undefined;
  readonly durationMs: number;
}

export interface SkillRunResult {
  readonly receiptId: string;
  /** Counts what happened rather than asserting success. */
  readonly headline: string;
  readonly steps: readonly SkillRunStep[];
  readonly canUndo: boolean;
  readonly undoableUntil: string | null;
  /** The action occurred, but its durable history receipt could not be saved. */
  readonly historyWarning?: string;
  readonly finishedAt?: string;
  readonly where?: string;
}

export interface SkillUndoResult {
  readonly undone: boolean;
  /** Restoration occurred even though its history receipt could not be saved. */
  readonly historyWarning?: string;
}

/** A restore can refer to verified history or an actual result in this session. */
export interface RestoreSubject {
  readonly receiptId: string | null;
  readonly summary: string;
  readonly where: string | null;
  readonly at: string | null;
}

export interface InstalledSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  /** Already clamped to the platform ceiling, in the owner's words. */
  readonly permissions: readonly string[];
  readonly triggers: readonly string[];
}

export interface SkillCatalogue {
  readonly installed: readonly InstalledSkill[];
  /** Named rather than dropped, so a broken skill is visible. */
  readonly rejected: readonly { folder: string; problems: readonly string[] }[];
}

export interface Consent {
  readonly crashReports: boolean;
  readonly usageCounts: boolean;
  /** The only one touching the content of someone's work. Off unless granted. */
  readonly improveFromCorrections: boolean;
  /** Whether the owner has been told what macOS will ask before it asks. */
  readonly foldersExplained: boolean;
}

export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x: number | null;
  readonly y: number | null;
  readonly maximised: boolean;
}

/** A connector the owner installed. */
export interface McpServerSetting {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** One per-tool approval, pinned to the description that was approved (D-039). */
export interface McpApprovalSetting {
  readonly serverId: string;
  readonly toolName: string;
  readonly descriptionHash: string;
}

/** Someone this Mac may contact, and may take instructions from (D-035). */
export interface Contact {
  readonly channel: "telegram" | "whatsapp" | "email";
  readonly address: string;
  readonly label: string;
}

export interface Settings {
  readonly version: number;
  readonly theme: "system" | "light" | "dark";
  readonly overlayHotkey: string;
  readonly pasteHotkey: string;
  readonly grantedRoots: readonly string[];
  /** Granted folders the owner has paused. Read by nothing while paused. */
  readonly pausedRoots: readonly string[];
  /**
   * How the owner signs a reminder, and where a payment should go.
   *
   * Their own UPI id and trading name. Money never passes through Rellane: a
   * customer paying a reminder pays the owner directly.
   */
  readonly trading: { readonly name: string; readonly upiId: string };
  /** Empty means this Mac contacts nobody and obeys nobody. That is the default. */
  readonly contacts: readonly Contact[];
  /** Installed connectors. Empty means no third-party code runs at all. */
  readonly connectors: readonly McpServerSetting[];
  /** Per-tool approvals. A tool absent from here cannot be called (D-039). */
  readonly approvals: readonly McpApprovalSetting[];
  readonly window: WindowState;
  readonly consent: Consent;
}

/** What the ⌥Space overlay handed to the main window. */
export interface HandoffEvent {
  readonly kind: "skill" | "ask" | "search";
  readonly query: string;
  /** Present when the overlay already worked out the plan. */
  readonly preview?: SkillPreview | undefined;
  readonly folder?: string | undefined;
  /** Present when the overlay could not do it, and why. */
  readonly problem?: string | undefined;
}

/** One thing the app did, as the owner would describe it. */
export interface ActivityEntry {
  readonly seq: number;
  readonly at: string;
  /** "skill.run", "skill.undo". */
  readonly kind: string;
  /** Already phrased for a person: "Librarian: 47 changes made." */
  readonly summary: string;
  /** The folder it touched, if any. A name, never a full path. */
  readonly where: string | null;
  /**
   * The receipt this entry belongs to, when it has one.
   *
   * A receipt is a timeline entry with a restore point attached — they are one
   * record, not two systems — so carrying the id here is what lets the timeline
   * offer Restore on a run it is describing rather than only on runs that
   * happen to have occurred since the window was last opened.
   *
   * It is an opaque id and never a path, so the renderer still learns nothing
   * it could replay.
   */
  readonly receiptId: string | null;
  /** True when a later entry in the record reversed this one. */
  readonly undone: boolean;
  /**
   * True only while this run's snapshots are still held and its undo window is
   * open — which is a different question from whether it has a receipt id.
   *
   * The timeline shows runs from every session the record remembers, but undo
   * is time-boxed on purpose, because holding reversal state forever means
   * holding copies of the owner's files forever. So most rows are history and
   * cannot be reversed, and the UI must not offer a button that would fail.
   */
  readonly restorable: boolean;
}

/**
 * A folder that was granted in a past session and cannot be read now.
 *
 * Rellane ships ad-hoc signed, so macOS sees each update as a different app and
 * withdraws its folder permissions. A grant failing to restore is therefore the
 * ordinary case after an update, not an edge one — and a folder that quietly
 * disappears from the rail is indistinguishable from a bug.
 */
export interface LostGrant {
  readonly path: string;
  /** Why, in the owner's words, with the ordinary cause named first. */
  readonly reason: string;
}

/** One recorded state of a granted folder, as the scrubber lists it. */
export interface TimelineCapture {
  readonly at: string;
  /**
   * The reason a person gave, when they named this moment. Null for the
   * automatic captures, which are the great majority.
   */
  readonly checkpoint: string | null;
  readonly files: number;
  /** True when the walk stopped at its row ceiling rather than finishing. */
  readonly truncated: boolean;
}

export type FolderChangeKind = "added" | "removed" | "changed" | "moved";

/** One file's difference between two captures. Paths are relative to the root. */
export interface FolderChange {
  readonly kind: FolderChangeKind;
  readonly path: string;
  /** Where it went. Present only on `moved`. */
  readonly movedTo: string | null;
  readonly bytes: number;
  /** How much the file grew or shrank. Present only on `changed`. */
  readonly bytesDelta: number | null;
}

export interface FolderDiff {
  readonly from: string;
  readonly to: string;
  /** One sentence: "47 files filed, 2 edited." */
  readonly summary: string;
  /**
   * Complete counts, even when `changes` below is capped. The reader is told
   * how many things happened before being shown a subset of them.
   */
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly moved: number;
  };
  /**
   * The changes themselves, capped so a diff of fifty thousand files does not
   * have to cross the process boundary to be summarised.
   */
  readonly changes: readonly FolderChange[];
  /** True when `changes` is a subset of `counts`. */
  readonly capped: boolean;
  /**
   * True when either capture hit its row ceiling, which makes every count a
   * floor rather than a total. Surfaced because a diff that hid this would
   * report a ceiling as a mass deletion.
   */
  readonly partial: boolean;
}

/**
 * The result of hashing a file on demand.
 *
 * Deliberately narrow about what it proves. The record holds sizes and times,
 * never contents, so this can only speak for the file as it is on disk right
 * now — it confirms what two files are, not what one of them used to be.
 */
export interface ContentDigest {
  readonly path: string;
  readonly digest: string | null;
  /** Why there is no digest, when there is none. */
  readonly problem: string | null;
}

export interface ActivityLog {
  readonly entries: readonly ActivityEntry[];
  /**
   * Plain-language integrity verdict — "41 entries, unbroken", or exactly where
   * the chain broke.
   */
  readonly integrity: string;
  /** False when the record shows any sign of having been edited. */
  readonly trustworthy: boolean;
}

/**
 * One thing that needs the owner today.
 *
 * `line` is a whole sentence in their own nouns — their customer, their words —
 * because a screen of fragments is a screen somebody has to assemble in their
 * head before it means anything.
 */
export interface TodayItem {
  /**
   * What the line came from. Enquiries and quotations are the loop the product
   * sells (D-111); `invoice` remains for records that predate the billing cut of
   * 12 September and is no longer produced by `today()`.
   */
  readonly kind: "enquiry" | "quotation" | "invoice" | "case";
  /** The record it came from, so the screen can open it. Never a path. */
  readonly id: string;
  readonly line: string;
  /** Urgent is what costs money or trust today; warning is what will soon. */
  readonly severity: "urgent" | "warning";
  readonly days: number;
}

/* ---- The loop (D-111) ----------------------------------------------------
 * An enquiry arrives, a quotation is drafted against it, it is sent, and it
 * closes. These shapes cross the IPC boundary, so they live here rather than in
 * the main process: the contract is the boundary.
 */

export type EnquiryChannel =
  | "indiamart"
  | "whatsapp"
  | "telegram"
  | "email"
  | "phone"
  | "walk_in";

/** What a local model made of an enquiry. A reading, never a fact. */
export type Triage = "unsorted" | "real" | "junk";

export type QuotationState = "draft" | "sent" | "won" | "lost" | "no_reply";

export interface DealLine {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly unitPricePaise: number;
  /** quantity × unit price. Derived, like every other figure here. */
  readonly linePaise: number;
}

export interface DealQuotation {
  readonly quotationId: string;
  readonly state: QuotationState;
  readonly gstRateBp: number | null;
  readonly draftedAt: number;
  readonly sentAt: number | null;
  readonly closedAt: number | null;
  readonly closedReason: string | null;
  readonly lines: readonly DealLine[];
  /** Before tax. */
  readonly netPaise: number;
  /** After tax, rounded once over the whole tax rather than per line. */
  readonly totalPaise: number;
}

export interface Deal {
  readonly enquiryId: string;
  readonly channel: EnquiryChannel;
  readonly receivedAt: number;
  /** Exactly what arrived. The room shows this and never an edited version. */
  readonly rawText: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  /**
   * As the owner typed it, never normalised on the way in.
   *
   * Null far more often than not: an enquiry usually arrives before anybody has
   * asked for a number. The room shows what it has and asks for nothing.
   */
  readonly partyPhone: string | null;
  readonly triage: Triage;
  /** Null until something has been drafted against the enquiry. */
  readonly quotation: DealQuotation | null;
}


/** One line this shop has charged for before, with what makes it judgeable. */
export interface PastLine {
  readonly description: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly unitPricePaise: number;
  /** When the quotation carrying it went out. */
  readonly at: number;
  readonly partyName: string | null;
}

/** One deal, as a list row. Never the whole message and never its lines. */
export interface DealSummary {
  readonly enquiryId: string;
  readonly channel: EnquiryChannel;
  readonly receivedAt: number;
  readonly partyName: string | null;
  readonly triage: Triage;
  /** Enough of what the customer wrote to recognise which job it was. */
  readonly excerpt: string;
  /** Null when nothing has been priced against it yet. */
  readonly state: QuotationState | null;
  /**
   * Null rather than zero when nothing is priced. "₹0" states a price the shop
   * never offered, and a deal with no quotation is a different fact from a
   * quotation with no lines.
   */
  readonly totalPaise: number | null;
  readonly closedAt: number | null;
  readonly closedReason: string | null;
}

/** One case, as a list row. Counts and dates; never the transcript. */
export interface CaseSummary {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly openedAt: number;
  /** Null while it is open. There is no separate status field to disagree with it. */
  readonly closedAt: number | null;
  readonly closedAs: "settled" | "abandoned" | "dropped" | null;
  readonly verdict: string | null;
  readonly turns: number;
  readonly lastActivityAt: number;
}

/**
 * One turn in the room.
 *
 * `kind` is what stops a summary impersonating something that was actually
 * said. A `compacted` turn names the turns it stands in for, so a reader can
 * always ask what it replaced; `finding` and `receipt` turns are never given to
 * a compactor at all.
 */
export interface CaseTurnView {
  readonly id: string;
  readonly seq: number;
  /** A seat label, or `owner`. Never an account and never a credential. */
  readonly seat: string;
  readonly kind: "verbatim" | "finding" | "receipt" | "compacted";
  readonly body: string;
  readonly at: number;
  readonly compactedFrom: readonly string[] | null;
}

export interface CaseRoom {
  readonly case: CaseSummary | null;
  readonly turns: readonly CaseTurnView[];
  readonly artifacts: readonly CaseArtifactVersion[];
  readonly exports: readonly CaseArtifactExport[];
}

/** Read-only provenance projection; no artifact body is returned. */
export interface CaseArtifactLineageEntry {
  readonly id: string;
  readonly versionId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly previousVersionId: string | null;
  readonly sourceTurnId: string | null;
  readonly sourceSeat: string | null;
  readonly sourceKind: "verbatim" | "finding" | "receipt" | "compacted" | null;
  readonly source: { readonly id: string; readonly seat: string; readonly kind: "verbatim" | "finding" | "receipt" | "compacted" } | null;
  readonly acceptedAt: number | null;
  readonly status: "verified" | "unverified";
  readonly reason: string | null;
}

export interface DesktopBridge {
  localShortcuts: {
    begin(input: { kind: LocalShortcutKind }): Promise<{ handle: string }>;
    stop(input: { handle: string }): Promise<{ stopped: boolean }>;
  };
  readonly version: typeof DESKTOP_BRIDGE_VERSION;
  system: {
    profile(): Promise<HardwareProfile>;
  };
  runtimes: {
    discover(): Promise<RuntimeDescriptor[]>;
  };
  automations: {
    snapshot(): Promise<AutomationWorkspaceSnapshot>;
    saveAgent(input: AutomationAgentSaveInput): Promise<AutomationAgent>;
    saveWorkflow(
      input: AutomationWorkflowSaveInput
    ): Promise<AutomationWorkflow>;
    saveReviewBoundWorkflow(
      input: AutomationReviewBoundWorkflowInput
    ): Promise<AutomationWorkflow>;
    saveMemory(
      input: AutomationMemoryDocumentSaveInput
    ): Promise<AutomationMemoryDocument>;
    importSources(): Promise<AutomationSourceDocument[]>;
    reviewArtifact(
      input: AutomationArtifactReviewInput
    ): Promise<AutomationArtifact>;
    ensureLocalConnector(
      input: AutomationConnectorEnsureLocalInput
    ): Promise<AutomationConnector>;
    exportPack(
      input: AutomationWorkflowPackExportInput
    ): Promise<AutomationWorkflowPackFileResult>;
    importPack(): Promise<AutomationWorkflowPackFileResult>;
    /**
     * Walks a flow without running it: no model call, no file, no message.
     *
     * Arming a flow is the one action here whose consequences are not visible
     * at the moment you take it, so this is the plan sheet that action gets.
     */
    /**
     * Replays a flow against its trigger folder's own history.
     *
     * Answers the one question nobody can answer about their own Downloads:
     * how often does it actually change, and would this have run away. It uses
     * the same loop rule the runtime does, so a backtest and the guard that
     * later pauses a flow cannot disagree.
     */
    /** Flows somebody can start from, without opening the canvas. */
    templates(): Promise<readonly FlowTemplateCard[]>;
    /**
     * Makes a flow from a template.
     *
     * It arrives switched off, always: a gallery click must not be able to
     * start something touching real work on a Mac the template has never seen.
     */
    fromTemplate(input: { templateId: string }): Promise<AutomationWorkflow>;
    backtest(input: { workflowId: string }): Promise<FlowBacktest>;
    dryRun(input: AutomationDryRunInput): Promise<AutomationDryRun>;
    start(input: AutomationRunStartInput): Promise<AutomationRunSnapshot>;
    action(input: AutomationRunActionInput): Promise<AutomationRunSnapshot>;
  };
  models: {
    recommend(mode: QualityMode | null): Promise<ConciergeSnapshot>;
    pickAndInspectGguf(): Promise<GgufInspection | null>;
    installations(): Promise<ModelInstallSnapshot>;
    licenseReview(modelId: string): Promise<ModelLicenseReview>;
    acknowledgeLicense(
      intent: LicenseAcceptanceIntent
    ): Promise<LicenseAcknowledgement>;
    install(modelId: string): Promise<ModelInstallStatus>;
    cancelInstall(operationId: string): Promise<ModelInstallCancelResult>;
  };
  diagnostics: {
    /** Redacted plain text the user reads before deciding to share it. */
    bundle(): Promise<string>;
  };
  settings: {
    read(): Promise<Settings>;
    /** Applies immediately. There is no Save button by design. */
    write(next: Settings): Promise<Settings>;
  };
  workspace: {
    /** Folders a skill is allowed to touch. Empty until the user grants one. */
    roots(): Promise<readonly string[]>;
    /** Opens a folder picker and adds the choice. Returns the new root list. */
    grant(): Promise<readonly string[]>;
    revoke(input: { path: string }): Promise<readonly string[]>;
    /** Folders granted in a past session that cannot be read now. */
    lost(): Promise<readonly LostGrant[]>;
  };
  /** One-way events from the main process. Returns an unsubscribe function. */
  events: {
    onHandoff(listener: (event: HandoffEvent) => void): () => void;
    /** What a running agent is doing, pushed as it happens. */
    onAgentProgress(listener: (event: RunProgress) => void): () => void;
    /**
     * A Bench turn landing, while the argument is still running.
     *
     * A figure printed at the end is a receipt, not a meter — by then the money
     * is spent, which is the opposite of knowing the price.
     */
    onBenchProgress(listener: (event: BenchProgress) => void): () => void;
  };
  activity: {
    /**
     * What the app has actually done, newest first, with the record's own
     * integrity verdict attached.
     *
     * The verdict travels with the entries rather than being fetched
     * separately, because a list of past actions is worth precisely as much as
     * the guarantee that it has not been edited. Showing one without the other
     * invites a reader to trust a list we cannot vouch for.
     */
    read(input?: { limit?: number }): Promise<ActivityLog>;
  };
  /**
   * The folder's own history, beside the record of what Rellane did to it.
   *
   * Separate from `activity` because they answer different questions. The
   * ledger says what Rellane did; the timeline says what the folder looked
   * like, including the changes a person made themselves. A receipt is where
   * the two meet.
   */
  agents: {
    /** Every agent, resolved against what this Mac will actually allow. */
    list(): Promise<readonly AgentCard[]>;
    /**
     * Runs one agent and returns what happened.
     *
     * Never rejects for an ordinary failure — a refusal, a timeout and an
     * engine error all come back as a result with a problem attached, because
     * a rejected promise becomes a toast with no history and this product's
     * whole argument is that there is always a record.
     */
    run(input: { agentId: string; question: string; sourceToken?: string }): Promise<AgentRunResult>;
    /** Preview an explicitly picked text file within this agent's active grants. */
    previewSource(input: { agentId: string }): Promise<CaseSourcePreview | null>;
    discardSource(input: { agentId: string; token?: string }): Promise<boolean>;
    /**
     * Saves an agent the owner wrote, and returns the whole roster resolved.
     *
     * The resolved cards come back rather than the stored shape, so what is on
     * screen after saving is what will actually run — clamps applied, withheld
     * folders named. A save that echoed the input would show a brief the runtime
     * would not honour.
     */
    save(input: {
      id: string;
      name: string;
      purpose: string;
      instructions?: string;
      folders?: readonly string[];
      capabilities?: readonly string[];
      tier?: string;
      maxSteps?: number;
      maxMinutes?: number;
      outbound?: string;
    }): Promise<readonly AgentCard[]>;
    /**
     * Turns a sentence into a brief for the editor — never saves it.
     *
     * The model proposes a shape; every value is clamped by the same code a
     * hand-written brief goes through, and folders it names that were not
     * granted are dropped. Nothing reaches the roster until a person saves.
     */
    draftHistory(): Promise<{ count: number; unfinished: number; oldestAt: number | null;
      newestAt: number | null; reviewSha256: string }>;
    forgetDraftHistory(input: { reviewSha256: string; confirmed: true }): Promise<{ removed: number }>;
    draft(input: { handle: string; sentence: string }): Promise<{
      ok: boolean;
      draft: {
        id: string;
        name: string;
        purpose: string;
        instructions?: string;
        folders?: readonly string[];
        capabilities?: readonly string[];
        tier?: string;
        maxSteps?: number;
        maxMinutes?: number;
        outbound?: string;
      } | null;
      said: string;
    }>;
    /** Removes one, and returns what is left. Shipped agents cannot be removed. */
    /**
     * Stops a run in flight.
     *
     * Aborts that run's own controller — the same path the brief's clock takes
     * — so it lands on the record as stopped rather than as a failure, keeping
     * whatever it had already done.
     */
    stop(input: { agentId: string }): Promise<{ stopped: boolean }>;
    /**
     * Writes one brief to a file.
     *
     * The file says what the agent is *for* and never what it may *touch*: no
     * folder paths, no keys, no permissions. Importing one is therefore never a
     * security decision, which is what makes it safe to accept a brief from a
     * stranger and read it afterwards.
     */
    exportOne(input: { agentId: string }): Promise<{ written: boolean; fileName: string | null }>;
    /** Reads a brief somebody sent, for you to look at. Saves nothing. */
    importOne(): Promise<ImportedBrief>;
    remove(input: { id: string }): Promise<readonly AgentCard[]>;
  };
  /**
   * Cases — work that finishes, and the room it happened in.
   *
   * A Case opens with a question and closes with a verdict. It **points at**
   * records rather than containing them, so erasing one never erases an invoice
   * it was about.
   */
  today: {
    /**
     * What needs the owner today: overdue bills, and work nobody has answered.
     *
     * Six at most, urgent first. An empty list is the honest answer to a quiet
     * morning and is what a quiet morning returns — there is no cheerful state.
     */
    read(): Promise<{
      items: readonly TodayItem[];
      /**
       * Whether nobody has ever put anything in this book.
       *
       * The first-run greeting's whole condition, and deliberately wider than
       * "no enquiries yet": a shop carrying parties, bills or cases from before
       * the loop existed is not a stranger, and would otherwise be offered the
       * tour the moment its last open case closed. An empty Today is an ordinary
       * Thursday for somebody who has closed everything.
       */
      freshBook: boolean;
    }>;
  };
  /**
   * One enquiry's life (D-111).
   *
   * Every verb answers with the whole deal rather than a flag. A room that shows
   * a customer's own words beside a price cannot afford the two halves to come
   * from different reads, and re-reading is cheaper than a wrong number.
   *
   * `send` marks a quotation ready to go. It contacts nobody: the outbound lock
   * is the only thing that may, and it always asks (D-033, D-035).
   */
  /**
   * Mark's Telegram token.
   *
   * `status` never returns the token, only whether one is set: a renderer that
   * can read a credential is a renderer that can leak one.
   */
  telegram: {
    status(): Promise<{ saved: boolean; encryptionAvailable: boolean }>;
    save(input: { token: string }): Promise<{ saved: boolean; said: string }>;
    forget(): Promise<{ saved: boolean; said: string }>;
  };
  /**
   * The business number on WhatsApp.
   *
   * `status` never returns the token, not even masked. The screen needs to know
   * whether it is on and what is missing; there is no question it can ask that a
   * credential is the answer to.
   */
  whatsapp: {
    status(): Promise<{
      configured: boolean;
      encryptionAvailable: boolean;
      /** False means send-only, which is a complete state rather than a fault. */
      canReceive: boolean;
      phoneNumberId: string | null;
    }>;
    save(input: {
      token: string;
      phoneNumberId: string;
      businessAccountId?: string;
      /** Absent means send-only. Both of these, or neither. */
      mailboxUrl?: string;
      collectSecret?: string;
    }): Promise<{ saved: boolean; said: string }>;
    forget(): Promise<{ saved: boolean; said: string }>;
    /** One message to one customer, sent at the moment it is approved. */
    send(input: { to: string; body: string }): Promise<{ sent: boolean; said: string }>;
  };
  /** Step one: recording that somebody asked for a price. */
  enquiries: {
    add(input: {
      channel: Deal["channel"];
      rawText: string;
      partyName: string | null;
      /** Optional, and stored exactly as typed. Never normalised on the way in. */
      partyPhone: string | null;
    }): Promise<{ enquiryId: string; deal: Deal | null }>;
  };
  deals: {
    read(input: { enquiryId: string }): Promise<{ deal: Deal | null }>;
    /**
     * What the customer appears to be asking for, proposed on this Mac.
     *
     * Nothing is saved and nothing is priced. Each line carries the exact words
     * it was read from so the owner checks the message, not the confidence.
     */
    readEnquiry(input: { enquiryId: string }): Promise<{
      ok: boolean;
      lines: readonly {
        description: { value: string | null; from: string | null; problem?: string };
        quantity: { value: number | null; from: string | null; problem?: string };
      }[];
      said: string;
    }>;
    draft(input: { enquiryId: string }): Promise<{ deal: Deal | null }>;
    /**
     * The quotation as the customer would read it. Composed, never sent.
     *
     * Null when there is nothing they could act on — no quotation, or one with
     * no lines. An empty quotation is a mistake, not a short message.
     */
    message(input: { enquiryId: string }): Promise<{ text: string | null }>;
    /** Adds one line. The price is the owner's; nothing upstream proposes one. */
    addLine(input: {
      quotationId: string;
      description: string;
      quantity: number;
      unitPricePaise: number;
      unit: string | null;
    }): Promise<{ deal: Deal | null }>;
    /**
     * Takes one line back off a draft.
     *
     * Remove and add again, rather than an edit: pricing is the step most
     * likely to be got wrong and until this existed it could only be got wrong
     * once. Refuses once the quotation has been sent — quietly changing what
     * the shop is on record as having offered is worse than the mistake.
     */
    removeLine(input: { quotationId: string; itemId: string }): Promise<{ deal: Deal | null }>;
    /**
     * What this shop charged for work like this before.
     *
     * Recall, not a proposal. Every figure was typed by the owner on a
     * quotation they sent, and it arrives with the quantity, the date and the
     * customer beside it — because the same job at a different quantity is a
     * different price and only the owner knows which one applies. Nothing fills
     * the rate box on its own.
     */
    pastLines(input: { like: string }): Promise<{ lines: readonly PastLine[] }>;
    send(input: { quotationId: string }): Promise<{ sent: boolean; deal: Deal | null }>;
    close(input: {
      quotationId: string;
      state: "won" | "lost" | "no_reply";
      reason: string | null;
    }): Promise<{ closed: boolean; deal: Deal | null }>;
    /**
     * Says whether this was work at all.
     *
     * `junk` takes it off Today; `real` puts it back. Neither deletes anything —
     * the customer's words stay in the book, because a shop that marked
     * something junk by mistake has to be able to undo it, and one that wonders
     * later what it turned down should have an answer.
     *
     * There is no way back to `unsorted`. That state means nobody has looked,
     * and somebody who has just pressed a button has.
     */
    triage(input: { enquiryId: string; triage: "real" | "junk" }): Promise<{ deal: Deal | null }>;
    /**
     * Every deal, newest first — the list behind the rail's second word.
     *
     * Includes what was closed and what was dismissed. Today answers "what
     * needs me"; this answers "what did we quote and how did it go", which is
     * the only thing that makes recording an outcome worth the ten seconds.
     */
    list(): Promise<{
      deals: readonly DealSummary[];
      /**
       * True when older enquiries exist and are not in the list.
       *
       * The screen says so rather than stopping silently: a shop quoting eight
       * jobs a day passes the ceiling inside a month, and a list of a business's
       * own records that quietly leaves some out is worse than a short one.
       */
      more: boolean;
    }>;
    /**
     * Opens WhatsApp with the quotation typed in, addressed to the customer.
     *
     * It does not send it and cannot: `wa.me` is a link, the last tap belongs
     * to a person, and the outbound lock refuses any number that is not on the
     * owner's own list (D-033, D-035). `said` explains either outcome.
     */
    handoff(input: { enquiryId: string }): Promise<{
      opened: boolean;
      said: string;
      /**
       * Whether adding this one customer to the list would let it through.
       *
       * Decided here rather than inferred from `said`: a screen matching the
       * refusal's wording would offer "add them" after a quotation-has-no-lines
       * refusal, and would stop offering it at all the day somebody reworded a
       * sentence.
       */
      canAdd: boolean;
    }>;
    /**
     * Adds this one customer to the outbound allowlist.
     *
     * The owner typed the number at intake; this is them saying, once and
     * deliberately, that Rellane may open a chat addressed to it. One
     * recipient, one channel, reversible in Settings — the list still has no
     * allow-everything value and nothing widens it automatically.
     */
    allowCustomer(input: { enquiryId: string }): Promise<{ added: boolean; said: string }>;
    /**
     * Says who an enquiry is from, after it arrived.
     *
     * Intake leaves both fields optional because an enquiry almost always
     * arrives before anybody has asked for a number. This is where the number
     * learned on the phone call afterwards gets written down. An empty phone
     * clears it: the owner is looking at the field, so blank means they do not
     * have it rather than "leave what is there".
     */
    setCustomer(input: {
      enquiryId: string;
      name: string;
      phone: string | null;
    }): Promise<{ deal: Deal | null; said: string }>;
  };
  cases: {
    artifactLineage(input: { caseId: string }): Promise<readonly CaseArtifactLineageEntry[]>;
    previewArtifactEdit(input: CaseArtifactEditPreviewInput): Promise<CaseArtifactEditReview>;
    applyArtifactEdit(input: { token: string }): Promise<CaseRoom>;
    /**
     * Every case, most recently active first.
     *
     * Waiting is not abandonment (D-096): listing is a pure read and never
     * mutates or auto-closes waiting work. Retains `closedAsAbandoned` (always 0)
     * for bridge compatibility with clients expecting the field on the wire.
     */
    list(): Promise<{ cases: readonly CaseSummary[]; closedAsAbandoned: number }>;
    open(input: { title: string; question: string }): Promise<CaseRoom>;
    /** The room, in order. This is what reopening a case replays. */
    read(input: { id: string }): Promise<CaseRoom>;
    say(input: { id: string; body: string }): Promise<CaseRoom>;
    previewSource(input: { id: string }): Promise<CaseSourcePreview | null>;
    addSource(input: CaseSourceCommit): Promise<CaseRoom>;
    discardSource(input: { id: string; token?: string }): Promise<{ discarded: boolean }>;
    reviewData(input: CaseDataQuery): Promise<CaseDataReview>;
    saveDataReview(input: CaseDataSave): Promise<{ room: CaseRoom; sourceTurnId: string }>;
    addDataSample(input: { id: string }): Promise<CaseRoom>;
    saveArtifact(input: CaseArtifactSave): Promise<CaseRoom>;
    acceptArtifact(input: { id: string; versionId: string }): Promise<CaseRoom>;
    exportArtifact(input: { id: string; versionId: string; format?: CaseArtifactFormat }): Promise<CaseArtifactExportResult>;
    exportTurn(input: { id: string; turnId: string }): Promise<{ written: boolean; fileName: string | null }>;
    localState(input: { id: string }): Promise<{ operationId: string; stopping: boolean } | null>;
    askLocal(input: CaseLocalRequest): Promise<CaseRoom>;
    prepareEnquiry(input: CaseEnquiryRequest): Promise<CaseRoom>;
    saveEnquiryReview(input: CaseEnquirySave): Promise<{ room: CaseRoom; sourceTurnId: string }>;
    stopLocal(input: { id: string; operationId: string }): Promise<{ stopped: boolean }>;
    close(input: { id: string; verdict: string }): Promise<{
      closed: boolean;
      case: CaseSummary | null;
    }>;
    /** Erases the case and everything said in it. What it pointed at survives. */
    erase(input: { id: string }): Promise<{ erased: boolean }>;
  };
  book: {
    /**
     * What the business currently looks like.
     *
     * Every figure is worked out from the bills when asked. Nothing is a stored
     * total, so nothing can quietly disagree with the records it came from.
     */
    standing(): Promise<BookStanding>;
    /**
     * Reads a bill out of pasted text and returns a **proposal**.
     *
     * Stores nothing. Every figure comes back with the words it was read from,
     * so a person can check it against the paste before the ordinary
     * `addInvoice` stores anything — a misread number costs a correction, never
     * a wrong figure in the ledger.
     */
    read(input: { handle: string; text: string }): Promise<BillRead>;
    /**
     * Reads a bill from a photograph, a scan or a PDF the owner picks.
     *
     * Read on this Mac with macOS's own frameworks — nothing is uploaded. An
     * digital PDF uses its text layer; a photograph or scan uses OCR.
     * Barcode detection does not verify the source or its figures.
     * What comes back is a proposal to check, never a record.
     */
    readFile(input: { handle: string }): Promise<DocumentRead>;
    addParty(input: {
      name: string;
      kind?: "customer" | "supplier" | "both";
      phone?: string | null;
      gstin?: string | null;
      notes?: string | null;
    }): Promise<{ id: string }>;
    addInvoice(input: {
      partyId: string;
      number?: string | null;
      issuedOn: number;
      dueOn?: number | null;
      subtotalPaise: number;
      taxPaise?: number;
      totalPaise: number;
      notes?: string | null;
    }): Promise<{ id: string }>;
    addPayment(input: {
      partyId: string;
      receivedOn: number;
      amountPaise: number;
      method?: "cash" | "upi" | "bank" | "cheque" | "other" | null;
      reference?: string | null;
    }): Promise<{ id: string }>;
  };
  vault: {
    /**
     * Reads the owner's notes back in, then writes the whole book out.
     *
     * Both directions in one call, in that order, so a sentence typed into a
     * markdown file is in the book before the file carrying it is rewritten.
     * Prose only ever travels inwards: an amount edited in a text file has no
     * path by which it could reach a balance.
     */
    sync(): Promise<VaultSyncResult>;
    /** Shows the folder in Finder, creating it first so it is never empty. */
    reveal(): Promise<{ folder: string }>;
  };
  engineKeys: {
    /**
     * Which engines have a key stored — never the key itself.
     *
     * A status channel that could return a key would be a way to read one out
     * of the app, which is the opposite of what a key store is for.
     */
    status(): Promise<readonly KeyedEngineStatus[]>;
    save(input: { engineId: string; key: string }): Promise<{ stored: boolean }>;
    forget(input: { engineId: string }): Promise<{ stored: boolean }>;
  };
  updates: {
    /**
     * Whether a newer build exists, and what moving to it would cost.
     *
     * Asks only when called, which is only when somebody presses the button.
     * There is no timer and no launch ping, and Rellane never downloads or
     * installs anything — a product that can replace its own binary can replace
     * it with anything.
     */
    check(): Promise<UpdateCheck>;
    /** Opens the releases page in the owner's browser. */
    open(): Promise<{ url: string }>;
    /**
     * Opens one link the owner is looking at.
     *
     * A WhatsApp chat with a reminder already typed, or a UPI request. Three
     * schemes only. This is where "nothing leaves without you" is implemented
     * by the operating system rather than promised.
     */
    openLink(input: { url: string }): Promise<{ opened: boolean }>;
  };
  memory: {
    /**
     * What Rellane has seen: learned words with their evidence, folder counts,
     * and the owner's own notes.
     *
     * This screen and the switch below existed before any learning did. A
     * product that learns first and explains later has already taken something
     * it cannot give back.
     */
    read(): Promise<Seen>;
    /** Hides a learned term, or brings it back. A hidden term stays hidden. */
    hide(input: { key: string; hidden: boolean }): Promise<{ key: string; hidden: boolean }>;
    /**
     * The per-folder off switch.
     *
     * Not a revoke — the grant and the history stay. What stops is looking:
     * a paused folder is subtracted at the one place that decides what anything
     * may touch, so it is unreachable by context and by tool alike.
     */
    pause(input: { path: string; paused: boolean }): Promise<{ paused: readonly string[] }>;
  };
  connectors: {
    /**
     * Every installed connector, its tools, and what may still be installed.
     *
     * Starting a connector is a side effect of reading this, but only of one the
     * owner installed — and each tool still needs its own approval before an
     * agent can call it (D-039).
     */
    read(): Promise<ConnectorsSnapshot>;
  };
  dispatch: {
    /**
     * Hands an agent's draft to a channel the owner has approved.
     *
     * Stages rather than sends: both handoff channels open the owner's own app
     * with the message in it, and a person presses send (D-033, D-034). Refusals
     * come back as a result with a reason, never as a rejection, because the
     * likely one — "they are not on your list" — is a sentence to read beside
     * the draft, not an error.
     */
    stage(input: {
      agentId: string;
      channel: "telegram" | "whatsapp" | "email";
      address: string;
      text: string;
    }): Promise<StageResult>;
  };
  desk: {
    /**
     * The one place you can say anything.
     *
     * Nobody thinks in screens. They think *"has Patel paid"* and *"put this
     * bill in"* — so this takes the sentence and finds the screen. What comes
     * back is words, or the name of a surface to open; it performs nothing, and
     * every surface it names still asks what it always asked.
     */
    say(input: { text: string }): Promise<DeskAnswer>;
  };
  bench: {
    /**
     * Puts one question to two different subscriptions and returns the argument.
     *
     * Takes the question and nothing else. Which engines sit in which seat, and
     * what the round and token ceilings are, are decided in the main process —
     * so this cannot be used to aim two subscriptions somewhere expensive.
     *
     * Never rejects for an ordinary failure: "only one engine is ready" is a
     * result with a reason, because the answer to it is a screen a person acts
     * on rather than an exception nobody sees.
     */
    run(input: { question: string }): Promise<BenchResult>;
    /**
     * What this Mac's own arguments say about which engine to trust.
     *
     * Evidence earned from real work rather than a benchmark somebody else ran
     * on somebody else's tasks. It reports; it does not route.
     */
    routing(): Promise<Routing>;
  };
  engines: {
    /**
     * Every engine, whether it is there, and the probe that decided so.
     *
     * Read on demand rather than pushed: the answer is only interesting when
     * somebody is looking at it, and running three version checks on a timer
     * would spawn processes all day to keep a light green.
     */
    room(): Promise<EngineRoomStatus>;
  };
  timeline: {
    /** Every recorded state of a granted folder, newest first. */
    captures(input: { folder: string }): Promise<readonly TimelineCapture[]>;
    /** What changed between two captures. */
    diff(input: { folder: string; from: string; to: string }): Promise<FolderDiff>;
    /** Records this moment under a name a person chose. */
    checkpoint(input: { folder: string; reason: string }): Promise<TimelineCapture>;
    /** Hashes one file as it is on disk now. */
    hash(input: { folder: string; path: string }): Promise<ContentDigest>;
  };
  skills: {
    /** Everything installed, and everything that failed to load. */
    catalogue(): Promise<SkillCatalogue>;
    /** Decides what would happen. Touches nothing. */
    preview(input: { skill: string; path: string }): Promise<SkillPreview>;
    /** Runs a previewed plan. */
    run(input: { planId: string }): Promise<SkillRunResult>;
    /** Puts everything back, while the undo window is open. */
    undo(input: { receiptId: string }): Promise<SkillUndoResult>;
  };
  /**
   * The workstation — a native subscription session, reviewed before it runs.
   *
   * Distinct from `subscription` above, which asks a docked CLI one prompt and
   * gets a string back. This drives a real session with its own identity, its
   * own folder and its own permission prompts, and every field the renderer can
   * set passes through `prepare` first: what comes back is the exact packet, the
   * hash of it, the provider and the folder, plus a single-use token. Nothing
   * here can send without one, and the host consumes it before launching.
   */
  workstation: WorkstationBridge;
  subscription?: {
    /** Every supported CLI that is installed and answered its version. */
    status(): Promise<BrainStatus>;
    /** Docks a CLI and probes, for real, what it can do. Slow by design. */
    dock(input: { providerId: BrainProviderId }): Promise<BrainStatus>;
    /** Forgets the docked CLI. No credential is touched. */
    undock(): Promise<BrainStatus>;
    /** Runs one prompt through the docked CLI. Throws when none is docked. */
    ask(input: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      modelId?: string;
    }): Promise<{ content: string }>;
  };
}
