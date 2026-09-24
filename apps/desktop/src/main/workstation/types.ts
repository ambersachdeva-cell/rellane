/** The main process owns native workers, permissions and their durable session identity. */
import type { WorkstationProvider, WorkstationProviderId, WorkstationSnapshot } from "@cadrane/contracts";
import type { NativeToolSession } from "./native-tools.js";
import type { ToolCallOutcome } from "./tool-ledger.js";
/**
 * `tools` is the reviewed tool scope, and it is optional on purpose: absent is
 * the ordinary case and the only thing every existing caller produces. An
 * adapter that does not understand it simply never registers anything, and the
 * host refuses to build one unless a person opted in at review.
 */
export interface NativeWorkerOptions {
  readonly executable: string; readonly cwd: string; readonly modelId?: string;
  readonly profileHome?: string; readonly resumeId?: string;
  readonly tools?: NativeToolSession;
  readonly onEvent: (event: NativeEvent) => void;
}
export type NativeEvent =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "activity"; readonly text: string }
  | { readonly type: "permission"; readonly id: string; readonly title: string; readonly detail: string }
  | { readonly type: "permission-cleared"; readonly id: string }
  /**
   * One reviewed tool call, after it was decided.
   *
   * Structured rather than another `activity` line because this is the half of
   * the record that outlives the window: an activity list is for watching, and
   * this is for reading back months later. Only an adapter that was handed a
   * tool scope ever emits it.
   */
  | {
      readonly type: "tool";
      readonly callId: string;
      readonly tool: string;
      readonly outcome: ToolCallOutcome;
      readonly argumentSummary: string;
      readonly resultBytes: number;
      readonly detail: string;
    };
export interface NativeWorkerResult {
  readonly sessionId: string | null; readonly text: string;
  readonly finishReason: "completed" | "denied" | "stopped" | "failed";
  readonly modelId?: string; readonly reportedModelId?: string; readonly detail?: string;
}
export interface NativeWorker {
  run(prompt: string): Promise<NativeWorkerResult>;
  interrupt(): Promise<{ acknowledged: boolean; detail: string }>;
  decide(permissionId: string, allow: boolean): Promise<void>;
  dispose(): Promise<void>;
}
export interface NativeProviderLaunch {
  readonly provider: WorkstationProvider;
  readonly executable: string | null;
  readonly profileHome?: string;
}
export interface ContextSource { readonly id: string; readonly label: string; readonly text: string; }
export interface WorkstationContext {
  readonly packet: string; readonly preview: string; readonly sourceIds: readonly string[];
  readonly sha256: string; readonly omitted: readonly string[];
}
export interface WorkstationSessionReceipt {
  readonly version: 1; readonly event: "start" | "checkpoint" | "finish" | "interrupted";
  readonly snapshot: WorkstationSnapshot; readonly workspacePath: string;
}
export interface ExtractedArtifact {
  readonly title: string; readonly body: string; readonly language: string | null;
  readonly kind: "document" | "code" | "table";
}
export type ProviderId = WorkstationProviderId;

/**
 * How the host reaches one provider's adapter.
 *
 * Added by C1 for the host wiring only; no worker module's exports change. The
 * host resolves this once per reviewed start, so the provider a person approved
 * is the provider that runs — there is no late lookup that could drift.
 */
export type NativeWorkerFactory = (
  providerId: WorkstationProviderId,
  options: NativeWorkerOptions
) => NativeWorker;
