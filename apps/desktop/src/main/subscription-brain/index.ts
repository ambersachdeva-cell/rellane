/**
 * Subscription brain — the docked-CLI facade the rest of the app talks to.
 *
 * The user installs and pays for a CLI themselves. We start it, hand it a
 * prompt, and read what it prints. We never read their credentials, never copy
 * a token anywhere, and never call a vendor endpoint ourselves.
 *
 * Two hard boundaries, both deliberate:
 *
 *   - This brain is for work a person asked for and is waiting on. A docked CLI
 *     takes on the order of ten seconds per call and holds a personal quota, so
 *     it must never sit in an unattended path. Lead ingestion, rule evaluation
 *     and message delivery stay deterministic and never reach this module.
 *
 *   - Failure is always reported. There is no branch here that returns
 *     invented text when nothing ran.
 */

import type { DesktopError } from "@cadrane/contracts";
import { BRAIN_CAPABILITIES } from "./capabilities.js";
import { discoverProvider } from "./cli-discovery.js";
import { runProcess } from "./cli-invoker.js";
import { RuntimeBoundaryError, toDesktopError } from "./errors.js";
import { PROVIDER_DEFINITIONS, providerDefinition } from "./providers.js";
import { BusyError, RequestQueue } from "./request-queue.js";
import type {
  BrainAskInput,
  BrainAskResult,
  BrainInstallation,
  BrainProviderDefinition,
  BrainProviderId,
  BrainRunner,
  CapabilityStatus
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_QUEUE_DEPTH = 4;

export interface DockedBrain {
  readonly installation: BrainInstallation;
  readonly capabilities: readonly CapabilityStatus[];
}

export class SubscriptionBrain implements BrainRunner {
  private docked: BrainInstallation | null = null;
  private definition: BrainProviderDefinition | null = null;
  private queue: RequestQueue | null = null;
  private capabilityCache: readonly CapabilityStatus[] = [];

  /** Every supported CLI that is actually installed and answered its version. */
  async available(): Promise<readonly BrainInstallation[]> {
    const found: BrainInstallation[] = [];
    for (const definition of PROVIDER_DEFINITIONS) {
      const installation = await discoverProvider(definition);
      if (installation !== null) {
        found.push(installation);
      }
    }
    return found;
  }

  get current(): BrainInstallation | null {
    return this.docked;
  }

  /**
   * Docks a provider and probes what it can do.
   *
   * Probing is real work against the real CLI, so this is slow by design — it
   * is the moment the product earns the right to claim a capability.
   */
  async dock(id: BrainProviderId, signal?: AbortSignal): Promise<DockedBrain> {
    const definition = providerDefinition(id);
    const installation = await discoverProvider(definition);
    if (installation === null) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_UNAVAILABLE",
        message:
          `${definition.label} is not installed, or it did not respond. ` +
          `Install it and sign in with your own account, then dock again.`,
        retryable: true
      });
    }

    this.docked = installation;
    this.definition = definition;
    this.queue = new RequestQueue({
      minIntervalMs: definition.minIntervalMs,
      maxDepth: MAX_QUEUE_DEPTH
    });
    this.capabilityCache = await this.probeCapabilities(signal);

    return { installation, capabilities: this.capabilityCache };
  }

  /** Forgets the docked provider. Nothing is deleted and no credential is touched. */
  undock(): void {
    this.docked = null;
    this.definition = null;
    this.queue = null;
    this.capabilityCache = this.capabilityCache.map((capability) => ({
      id: capability.id,
      title: capability.title,
      detail: capability.detail,
      state: "unknown" as const
    }));
  }

  /** Last probed capabilities. Dimmed to "unknown" after undocking, never deleted. */
  capabilities(): readonly CapabilityStatus[] {
    if (this.capabilityCache.length > 0) {
      return this.capabilityCache;
    }
    return BRAIN_CAPABILITIES.map((capability) => ({
      id: capability.id,
      title: capability.title,
      detail: capability.detail,
      state: "unknown" as const
    }));
  }

  async ask(input: BrainAskInput): Promise<BrainAskResult> {
    const definition = this.definition;
    const installation = this.docked;
    const queue = this.queue;
    if (definition === null || installation === null || queue === null) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_UNAVAILABLE",
        message: "No brain is docked. Connect a CLI you already use, then try again.",
        retryable: false
      });
    }

    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "The prompt was empty.",
        retryable: false
      });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: `The prompt is longer than ${MAX_PROMPT_CHARS.toLocaleString()} characters.`,
        retryable: false
      });
    }

    try {
      return await queue.run(async () => {
        const startedAt = Date.now();
        const result = await runProcess({
          executablePath: installation.executablePath,
          args: definition.buildArgs({ prompt, model: input.model }),
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: input.signal
        });

        if (result.code !== 0) {
          throw new RuntimeBoundaryError({
            code: "RUNTIME_UNAVAILABLE",
            message: firstMeaningfulLine(
              result.stderr,
              `${definition.label} exited with code ${String(result.code)}.`
            ),
            retryable: true
          });
        }

        const content = result.stdout.trim();
        if (content.length === 0) {
          throw new RuntimeBoundaryError({
            code: "RUNTIME_RESPONSE_INVALID",
            message: `${definition.label} ran but returned nothing.`,
            retryable: true
          });
        }

        return {
          providerId: definition.id,
          executablePath: installation.executablePath,
          content,
          elapsedMs: Date.now() - startedAt
        };
      });
    } catch (error) {
      if (error instanceof BusyError) {
        throw new RuntimeBoundaryError({
          code: "BUSY",
          message: error.message,
          retryable: true
        });
      }
      throw error;
    }
  }

  private async probeCapabilities(
    signal?: AbortSignal
  ): Promise<readonly CapabilityStatus[]> {
    const statuses: CapabilityStatus[] = [];
    for (const capability of BRAIN_CAPABILITIES) {
      try {
        await capability.probe(this, signal);
        statuses.push({
          id: capability.id,
          title: capability.title,
          detail: capability.detail,
          state: "available"
        });
      } catch (error) {
        statuses.push({
          id: capability.id,
          title: capability.title,
          detail: capability.detail,
          state: "unavailable",
          reason: describe(error)
        });
      }
    }
    return statuses;
  }
}

function describe(error: unknown): string {
  const detail: DesktopError = toDesktopError(error);
  return detail.message;
}

function firstMeaningfulLine(stderr: string, fallback: string): string {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? fallback : line.slice(0, 500);
}

export { RuntimeBoundaryError, toDesktopError } from "./errors.js";
export { ANTIGRAVITY_MODELS, PROVIDER_DEFINITIONS } from "./providers.js";
export type {
  BrainAskInput,
  BrainAskResult,
  BrainInstallation,
  BrainProviderId,
  CapabilityStatus
} from "./types.js";
