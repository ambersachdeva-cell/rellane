/** A reviewed native subscription session keeps work and its evidence together. */
import { z } from "zod";
import type { WorkstationSurfaceBridge } from "./workstation-surface.js";
import type { WorkstationContextSuggestion, WorkstationContextSuggestionInput } from "./workstation-context.js";
import type { WorkstationProject, WorkstationProjectLink, WorkstationProjectSaveInput, WorkstationProjectAssignInput, WorkstationProjectCaptureInput } from "./workstation-projects.js";
import type { WorkstationSavedRoutine, WorkstationRoutineSaveInput } from "./workstation-routines.js";
import type { WorkstationImageAsset, WorkstationImagePreview, WorkstationImageExport } from "./workstation-images.js";
import type { CreativeHandoffBridge } from "./workstation-creative.js";
import type { WorkstationCitationBridge } from "./workstation-citations.js";

export type WorkstationProviderId = "codex" | "claude" | "gemini1" | "gemini2" | "gemini3";
export interface WorkstationProvider {
  readonly id: WorkstationProviderId;
  readonly label: string;
  readonly family: "codex" | "claude" | "gemini";
  readonly state: "detected" | "unavailable" | "blocked";
  readonly detail: string;
  readonly models: readonly { readonly id: string; readonly label: string }[];
  readonly canResume: boolean;
  readonly canApproveTools: boolean;
}
export interface WorkstationWorkspace { readonly id: string; readonly label: string; readonly path: string; }
export interface WorkstationPrepareInput {
  readonly caseId: string; readonly providerId: WorkstationProviderId; readonly modelId?: string;
  readonly prompt: string; readonly sourceTurnIds: readonly string[]; readonly workspaceId?: string;
  /** Opt in to reviewed native tools. Absent and false are the same thing. */
  readonly enableTools?: boolean;
}
/**
 * What turning tools on actually widens, said before the token is spent.
 *
 * `sources` and `totalSourceChars` exist because the packet hash stops being
 * the ceiling once tools are on: the same selected sources become readable in
 * full, page by page, which is more than the excerpt the reviewer just read.
 * A review that did not say so would be a review of the wrong thing.
 */
export interface WorkstationReviewToolSource { readonly label: string; readonly chars: number; }
export interface WorkstationReviewTools {
  readonly enabled: boolean;
  readonly toolNames: readonly string[];
  readonly skillIds: readonly string[];
  readonly sources: readonly WorkstationReviewToolSource[];
  readonly totalSourceChars: number;
  readonly reachNote: string;
  readonly freshSessionNote: string;
}
export interface WorkstationReview {
  readonly token: string; readonly caseId: string; readonly providerId: WorkstationProviderId;
  readonly providerLabel: string; readonly modelId: string | null; readonly prompt: string;
  readonly contextPreview: string; readonly sourceIds: readonly string[]; readonly sourceHash: string;
  readonly workspace: WorkstationWorkspace; readonly expiresAt: number; readonly resumeSessionId: string | null;
  readonly tools?: WorkstationReviewTools;
}
export interface WorkstationPermission {
  readonly id: string; readonly title: string; readonly detail: string;
}
export type WorkstationStatus = "starting" | "running" | "needs-approval" | "stopping" | "completed" | "stopped" | "failed" | "interrupted";
export interface WorkstationSnapshot {
  /** Native model identity when the connector explicitly observed it; never inferred from an alias. */
  readonly reportedModelId?: string;
  readonly operationId: string; readonly caseId: string; readonly providerId: WorkstationProviderId;
  readonly modelId: string | null; readonly sessionId: string | null; readonly status: WorkstationStatus;
  readonly startedAt: number; readonly updatedAt: number; readonly text: string;
  readonly activity: readonly string[]; readonly permission: WorkstationPermission | null; readonly detail: string;
}
export interface HermesSkillProvenance {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly license: "MIT";
  readonly version: string;
  readonly sha256: string;
  readonly url: string;
}
export interface WorkstationRoutine {
  readonly id: string; readonly title: string; readonly description: string; readonly prompt: string;
  readonly icon: "write" | "research" | "build" | "review" | "data";
  readonly sourceHint: string; readonly outputLabel: string;
  readonly upstream?: HermesSkillProvenance;
}
export interface WorkstationBridge
  extends CreativeHandoffBridge,
    WorkstationCitationBridge,
    WorkstationSurfaceBridge {
  suggestContext(input: WorkstationContextSuggestionInput): Promise<WorkstationContextSuggestion>;
  images(input: { readonly caseId: string }): Promise<readonly WorkstationImageAsset[]>;
  importImage(input: { readonly caseId: string }): Promise<WorkstationImageAsset | null>;
  previewImage(input: { readonly caseId: string; readonly id: string; readonly size: "thumbnail" | "detail" }): Promise<WorkstationImagePreview>;
  exportImage(input: { readonly caseId: string; readonly id: string }): Promise<WorkstationImageExport>;
  renameWork(input: { readonly caseId: string; readonly title: string; readonly expectedTitle: string }): Promise<void>;
  continuity(): Promise<{ readonly projects: readonly WorkstationProject[]; readonly links: readonly WorkstationProjectLink[]; readonly routines: readonly WorkstationSavedRoutine[] }>;
  saveProject(input: WorkstationProjectSaveInput): Promise<WorkstationProject>;
  assignProject(input: WorkstationProjectAssignInput): Promise<void>;
  captureProjectBrief(input: WorkstationProjectCaptureInput): Promise<{ readonly sourceTurnId: string; readonly project: WorkstationProject }>;
  saveRoutine(input: WorkstationRoutineSaveInput): Promise<WorkstationSavedRoutine>;
  routineVersions(input: { readonly id: string }): Promise<readonly WorkstationSavedRoutine[]>;
  providers(): Promise<readonly WorkstationProvider[]>;
  chooseWorkspace(): Promise<WorkstationWorkspace | null>;
  revealWorkspace(input: { readonly caseId: string; readonly workspaceId?: string }): Promise<WorkstationWorkspace>;
  routines(): Promise<readonly WorkstationRoutine[]>;
  prepare(input: WorkstationPrepareInput): Promise<WorkstationReview>;
  start(input: { readonly token: string }): Promise<WorkstationSnapshot>;
  state(input: { readonly caseId: string }): Promise<WorkstationSnapshot | null>;
  /** Every session working right now, across every case. Never a past one. */
  running(): Promise<readonly WorkstationSnapshot[]>;
  stop(input: { readonly caseId: string; readonly operationId: string }): Promise<WorkstationSnapshot>;
  decide(input: { readonly operationId: string; readonly permissionId: string; readonly allow: boolean }): Promise<WorkstationSnapshot>;
}

/**
 * What the renderer is allowed to say, and nothing more.
 *
 * Every field below is either an id the main process minted itself or a bounded
 * string a person typed. There is deliberately no path, no executable, no
 * argument list and no approval flag: a workspace is named by an opaque id the
 * host handed out after a Finder picker, and consent is a single-use token the
 * host consumed before launching anything. A renderer that wanted to widen what
 * a native tool may touch has nowhere here to say so.
 */
export const WORKSTATION_PROVIDER_IDS = [
  "codex",
  "claude",
  "gemini1",
  "gemini2",
  "gemini3"
] as const;
export const WorkstationProviderIdSchema = z.enum(WORKSTATION_PROVIDER_IDS);

/** The prompt a person typed. Long enough for a brief, short enough to read. */
export const WORKSTATION_PROMPT_LIMIT = 8_000;

/** How many room turns one request may carry. Selection, never a folder sweep. */
export const WORKSTATION_SOURCE_LIMIT = 20;

/**
 * A model name reaches a command line, so it is an identifier rather than text.
 * The host still refuses any id the provider did not itself advertise; this
 * stops the shell-shaped ones before they get that far.
 */
const WorkstationModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "That is not a model identifier.");

const WorkstationCaseIdSchema = z.string().trim().min(1).max(64);

export const WorkstationPrepareInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema,
  providerId: WorkstationProviderIdSchema,
  modelId: WorkstationModelIdSchema.optional(),
  prompt: z.string().trim().min(1).max(WORKSTATION_PROMPT_LIMIT),
  sourceTurnIds: z
    .array(z.uuid())
    .max(WORKSTATION_SOURCE_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length, "Select each source once."),
  /** An opaque id from `chooseWorkspace`. Absent means this case's own folder. */
  workspaceId: z.uuid().optional(),
  /**
   * A request to be shown the tool scope at review. It grants nothing on its
   * own: the host still refuses any provider but Codex, still requires the
   * reviewed source snapshot, and still asks before every single call.
   */
  enableTools: z.boolean().optional()
});

/**
 * The reviewed send token: 32 random bytes, hex.
 *
 * Shaped here so a malformed one is refused before it can be looked up, and so
 * the wire shape cannot quietly become something guessable.
 */
export const WorkstationTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "That is not a workstation review token.");

export const WorkstationStartInputSchema = z.strictObject({
  token: WorkstationTokenSchema
});

export const WorkstationStateInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema
});

/** Finder receives a host-resolved folder, never a path supplied by a model. */
export const WorkstationRevealWorkspaceInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema,
  workspaceId: z.uuid().optional()
});

export const WorkstationStopInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema,
  operationId: z.uuid()
});

/**
 * One permission decision, bound to the operation that asked.
 *
 * `allow` is a decision about a request the native tool made and the host
 * recorded — not a standing grant, and not a flag that widens anything. The
 * host refuses a permission id it is not currently waiting on.
 */
export const WorkstationDecideInputSchema = z.strictObject({
  operationId: z.uuid(),
  permissionId: z.string().trim().min(1).max(200),
  allow: z.boolean()
});
