import type {
  LocalChatRequest,
  ModelTarget
} from "@cadrane/contracts";
import type { RuntimeMemberManifest } from "../acquisition/archive-safety.js";

export const MANAGED_LLAMA_RUNTIME_ID = "managed-llama-b10182";

export type ManagedRuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export interface SignedActiveRuntimeReceipt {
  readonly receiptVersion: 1;
  readonly status: "signed-active";
  readonly runtimeId: "llama.cpp";
  readonly tag: "b10182";
  readonly sourceCommit: "afeebe103bd99cda8f5dfaefcabadf890db7fda7";
  readonly target: "darwin-arm64";
  /** Canonical upstream archive manifest before Switchboard code signing. */
  readonly sourceMemberManifestCanonicalSha256: string;
  /** Canonical active manifest after every Mach-O and dylib is signed. */
  readonly memberManifestCanonicalSha256: string;
  /** Active post-sign llama-server member digest. */
  readonly serverSha256: string;
}

export interface ActivatedLlamaRuntime {
  readonly runtimeRoot: string;
  readonly payloadDirectory: string;
  readonly serverPath: string;
  /** Immutable upstream archive manifest whose canonical digest is source-pinned. */
  readonly sourceManifest: RuntimeMemberManifest;
  /** Post-sign active manifest whose bytes are reverified before every launch. */
  readonly manifest: RuntimeMemberManifest;
  readonly receipt: SignedActiveRuntimeReceipt;
}

/**
 * Process-local launch authority. Instances are accepted only when registered
 * by the private activation-provenance module, coupling an activation to the
 * exact verifier that understands its build trust anchor.
 */
export interface ManagedRuntimeAuthority {
  readonly activation: ActivatedLlamaRuntime;
  readonly integrityVerifier: RuntimeIntegrityVerifier;
}

export interface PromotedManagedModel {
  readonly rootDirectory: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly modelPath: string;
  readonly artifactSha256: string;
  readonly downloadBytes: number;
  readonly catalogGeneration: number;
  readonly target: ModelTarget;
}

export interface LlamaServerLaunchInput {
  readonly authority: ManagedRuntimeAuthority;
  readonly runtime: ActivatedLlamaRuntime;
  readonly model: PromotedManagedModel;
}

export interface ManagedRuntimeSnapshot {
  readonly state: ManagedRuntimeState;
  readonly runtimeId: typeof MANAGED_LLAMA_RUNTIME_ID;
  readonly modelId: string | null;
  readonly modelDisplayName: string | null;
  readonly startedAt: string | null;
  readonly detail: string;
}

export interface ManagedRuntimeReadyIdentity {
  readonly authority: ManagedRuntimeAuthority;
  readonly modelId: string;
  readonly artifactSha256: string;
  readonly catalogGeneration: number;
  readonly target: ModelTarget;
}

export interface RuntimeIntegrityVerifier {
  verify(input: LlamaServerLaunchInput, signal: AbortSignal): Promise<void>;
}

export interface ManagedRuntimeOperationLane {
  enqueue<T>(
    operationId: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T>;
  cancel(operationId: string): boolean;
  poison(error: import("../errors.js").RuntimeBoundaryError): void;
  /**
   * Native lifecycle cleanup only. Runs immediately after the current entry
   * and before ordinary queued work.
   */
  enqueuePriorityBarrier<T>(
    operationId: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T>;
}

export type ResolveLlamaServerLaunchInput = (
  signal: AbortSignal
) => Promise<LlamaServerLaunchInput>;

export interface LoopbackPortReservation {
  readonly port: number;
  release(): Promise<void>;
}

export interface LoopbackPortAllocator {
  reserve(signal: AbortSignal): Promise<LoopbackPortReservation>;
}

export interface RuntimeProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RuntimeProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export interface OwnedRuntimeProcess {
  readonly pid: number;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly exit: Promise<RuntimeProcessExit>;
  readonly alive: boolean;
}

export interface RuntimeProcessHost {
  spawn(spec: RuntimeProcessSpec): OwnedRuntimeProcess;
  terminateTree(
    child: OwnedRuntimeProcess,
    gracefulTimeoutMs: number
  ): Promise<void>;
}

export interface LoopbackListenerOwnershipVerifier {
  isOwnedBy(pid: number, port: number, signal: AbortSignal): Promise<boolean>;
}

export type HealthObservation =
  | { readonly state: "unavailable" }
  | { readonly state: "loading" }
  | { readonly state: "ready" };

export interface ManagedRuntimeHttpClient {
  health(port: number, signal: AbortSignal): Promise<HealthObservation>;
  chat(
    port: number,
    request: LocalChatRequest,
    apiKey: string,
    signal: AbortSignal
  ): Promise<string>;
}

export interface ManagedRuntimeSecretSource {
  createApiKey(): string;
}

export interface ManagedRuntimeClock {
  now(): Date;
  monotonicMs(): number;
  delay(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface LlamaServerSupervisorDependencies {
  readonly operationLane: ManagedRuntimeOperationLane;
  readonly portAllocator?: LoopbackPortAllocator;
  readonly processHost?: RuntimeProcessHost;
  readonly listenerOwnership?: LoopbackListenerOwnershipVerifier;
  readonly httpClient?: ManagedRuntimeHttpClient;
  readonly secretSource?: ManagedRuntimeSecretSource;
  readonly clock?: ManagedRuntimeClock;
}
