/**
 * Subscription brain — shared types.
 *
 * The brain runs work through a CLI the user installed and pays for themselves.
 * Two rules hold everywhere in this module:
 *
 *   1. We never read, copy, or forward the user's credentials. No token is
 *      extracted from ~/.gemini or anywhere else. The vendor's own binary
 *      authenticates itself, as the user, exactly as it does when they run it
 *      by hand. Rellane only starts the process and reads its output.
 *
 *   2. We never invent output. Every failure surfaces as a typed error with a
 *      real reason. There is no path in this module that returns a plausible
 *      looking string when nothing ran.
 */

export type BrainProviderId = "claude" | "antigravity" | "gemini";

export interface BrainProviderDefinition {
  readonly id: BrainProviderId;
  /** Executable name, looked up on PATH and in the well-known install dirs. */
  readonly binary: string;
  /** Human name for the UI. Never shown as a model name. */
  readonly label: string;
  /** Arguments that make the binary print its version and exit non-interactively. */
  readonly versionArgs: readonly string[];
  /**
   * Builds the full argv (excluding the binary itself) for one prompt.
   *
   * Both supported CLIs take the prompt as an argument rather than on stdin —
   * verified against `agy -p`, which ignores piped stdin. The prompt is
   * therefore briefly visible in the process table, which matters only on a
   * shared machine; we accept it because the alternative is not supported.
   * It is never passed through a shell, so its contents cannot be executed.
   */
  buildArgs(input: {
    readonly prompt: string;
    readonly model?: string | undefined;
  }): readonly string[];
  /** Model used when the caller does not name one. */
  readonly defaultModel: string;
  /** Minimum milliseconds between two calls. Paces us like a person, not a script. */
  readonly minIntervalMs: number;
  /**
   * Measured wall-clock for a small prompt, including process start. Used to set
   * honest expectations in the UI and to keep this brain out of latency-critical
   * paths. Not a guess — see subscription-brain/README.md for how it was taken.
   */
  readonly typicalLatencyMs: number;
}

export interface BrainInstallation {
  readonly providerId: BrainProviderId;
  readonly label: string;
  /** Absolute path to the binary we resolved. */
  readonly executablePath: string;
  /** Whatever the binary printed for its version, trimmed. Empty if it printed nothing. */
  readonly version: string;
}

export interface BrainAskInput {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface BrainAskResult {
  readonly providerId: BrainProviderId;
  readonly executablePath: string;
  readonly content: string;
  readonly elapsedMs: number;
}

/**
 * A thing the product can do once a brain is docked.
 *
 * `probe` must perform real work against the docked provider. A capability is
 * only ever reported as available after its probe has actually succeeded —
 * nothing in this module reports readiness it has not observed.
 */
export interface BrainCapability {
  readonly id: string;
  /** Outcome in the owner's language. Never a model or vendor name. */
  readonly title: string;
  readonly detail: string;
  probe(runner: BrainRunner, signal?: AbortSignal): Promise<void>;
}

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface CapabilityStatus {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly state: CapabilityState;
  /** Why it is unavailable, in plain words. Present only when state is "unavailable". */
  readonly reason?: string | undefined;
}

/** The narrow surface a capability probe is allowed to use. */
export interface BrainRunner {
  ask(input: BrainAskInput): Promise<BrainAskResult>;
}
