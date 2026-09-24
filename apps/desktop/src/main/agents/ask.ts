/**
 * Actually asking the engine an agent was assigned.
 *
 * Separated from `run.ts` so the runner can be tested without launching a
 * process — the budget, the refusals and the reporting are the interesting
 * behaviour there, and none of them should need a CLI to exercise. This file is
 * the thin, boring half that starts something.
 *
 * The system prompt is prepended to the message rather than passed through a
 * dedicated flag. Every CLI here spells that differently and one of them does
 * not offer it at all, so a shared, obvious concatenation beats three
 * per-provider special cases that would each be wrong in a different way. The
 * boundary between the two is marked so a model can see where its instructions
 * end and the owner's question begins.
 */

import type { BrainProviderId } from "../subscription-brain/types.js";
import { discoverProvider } from "../subscription-brain/cli-discovery.js";
import { providerDefinition, PROVIDER_DEFINITIONS } from "../subscription-brain/providers.js";
import { runProcess } from "../subscription-brain/cli-invoker.js";
import type { SecretStore } from "../security/secrets.js";

/** Long enough for a real answer, short enough that a hung CLI is not forever. */
const ASK_TIMEOUT_MS = 180_000;

/**
 * The most we will hand a CLI in one go.
 *
 * Both supported CLIs take the prompt as an argument, and an argument list has
 * an operating-system limit that produces a confusing failure rather than a
 * clear one. Refusing at a number we chose gives a sentence somebody can act on.
 */
export const MAX_ASK_CHARS = 100_000;

export class EngineUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailable";
  }
}

function isCliProvider(engineId: string): engineId is BrainProviderId {
  return PROVIDER_DEFINITIONS.some((definition) => definition.id === engineId);
}

/**
 * Runs one prompt through the engine the selector chose.
 *
 * Discovers the binary each time rather than caching it. A cached path survives
 * an uninstall and a version bump, and the failure that produces — "no such
 * file" from a path we were confident about — is exactly the confident
 * wrongness the Engine Room exists to avoid.
 */
export async function askEngine(input: {
  readonly engineId: string;
  readonly modelId: string;
  readonly system: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  /** Legacy caller compatibility. Never read; keyed dispatch is not supported. */
  readonly secrets?: SecretStore;
  /**
   * Which account to run as — the `HOME` the CLI reads its credentials from.
   *
   * Absent is the ambient environment, which is the single-account case and
   * still the default. Present is how one person's several subscriptions become
   * several seats: the same binary, started signed in as somebody else, with
   * Rellane never touching the token in between (D-091).
   */
  readonly home?: string | undefined;
}): Promise<string> {
  if (!isCliProvider(input.engineId)) {
    // The on-device engine speaks HTTP on a loopback port, not argv. It is a
    // real gap and it is named rather than papered over with a wrong call.
    throw new EngineUnavailable(
      input.engineId === "local"
        ? "Use a local workroom to run this Mac's model. This legacy CLI path cannot run it."
        : `${input.engineId} is not an engine that can be asked directly.`
    );
  }

  const definition = providerDefinition(input.engineId);
  const installation = await discoverProvider(definition);
  if (installation === null) {
    throw new EngineUnavailable(
      `${definition.label} did not answer when Rellane looked for it. It may have been moved or uninstalled since the Engine Room last checked.`
    );
  }

  const message = [input.system, "--- The owner's request begins here ---", input.prompt].join(
    "\n\n"
  );
  if (message.length > MAX_ASK_CHARS) {
    throw new EngineUnavailable(
      `That request is ${message.length.toLocaleString()} characters, which is more than Rellane will hand a CLI at once. Narrow what the agent is looking at.`
    );
  }

  const result = await runProcess({
    executablePath: installation.executablePath,
    args: definition.buildArgs({ prompt: message, model: input.modelId }),
    timeoutMs: ASK_TIMEOUT_MS,
    signal: input.signal,
    ...(input.home === undefined ? {} : { home: input.home })
  });

  if (result.code !== 0) {
    // The CLI's own words, first meaningful line. Ours would be a guess about
    // somebody else's failure.
    const said = result.stderr.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    throw new EngineUnavailable(said ?? `${definition.label} exited with code ${result.code}.`);
  }

  const answer = result.stdout.trim();
  if (answer.length === 0) {
    // Silence is not an answer. Reporting it as one would put an empty result
    // on the record as though the agent had considered the question.
    throw new EngineUnavailable(`${definition.label} ran but returned nothing.`);
  }
  return answer;
}
