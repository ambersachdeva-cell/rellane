/**
 * The CLIs we know how to drive.
 *
 * Every flag here was read from the tool's own `--help` and confirmed by
 * running it. Nothing is inferred from documentation or memory.
 */

import type { BrainProviderDefinition, BrainProviderId } from "./types.js";

/**
 * Antigravity model identifiers.
 *
 * `agy models` under-reports: it lists 3.6 and older, but `gemini-3.7-flash-*`
 * resolves and the model confirms itself as "Gemini 3.7 Flash". Treat the
 * listing as stale and these strings as authoritative.
 *
 * The suffix is reasoning effort, not a different model. `low` is the workhorse
 * setting for mechanical extraction; `high` is for work that needs judgement.
 */
export const ANTIGRAVITY_MODELS = Object.freeze({
  flashLow: "gemini-3.7-flash-low",
  flashMedium: "gemini-3.7-flash-medium",
  flashHigh: "gemini-3.7-flash-high",
  proHigh: "gemini-3.1-pro-high"
} as const);

const ANTIGRAVITY: BrainProviderDefinition = {
  id: "antigravity",
  binary: "agy",
  label: "Antigravity",
  versionArgs: ["--version"],
  defaultModel: ANTIGRAVITY_MODELS.flashLow,
  buildArgs: ({ prompt, model }) => [
    "-p",
    prompt,
    "--model",
    model ?? ANTIGRAVITY_MODELS.flashLow
  ],
  minIntervalMs: 1_200,
  typicalLatencyMs: 14_000
};

/**
 * Claude, through the user's own Claude Code CLI.
 *
 * This is the point of the whole module and it is worth being explicit about:
 * somebody paying for Claude Pro should not then pay per token through an API
 * to use the thing they already bought. Their CLI is already signed in as them;
 * we start it and read its output, exactly as they would by hand.
 *
 * Model aliases rather than pinned identifiers. `--model opus` keeps working
 * across a version bump; `claude-opus-5` becomes wrong the day the next one
 * ships, and a status board that confidently names a model that no longer
 * exists is worse than one that names a tier.
 */
export const CLAUDE_MODELS = Object.freeze({
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku"
} as const);

const CLAUDE: BrainProviderDefinition = {
  id: "claude",
  binary: "claude",
  label: "Claude Code",
  versionArgs: ["--version"],
  defaultModel: CLAUDE_MODELS.sonnet,
  // -p is the non-interactive print mode; without it the binary opens a session
  // and waits forever, which inside a packaged app is an invisible hang.
  buildArgs: ({ prompt, model }) => [
    "-p",
    prompt,
    "--model",
    model ?? CLAUDE_MODELS.sonnet
  ],
  minIntervalMs: 1_200,
  // Not yet measured on this machine the way the other two were. Recorded as
  // provisional rather than printed as fact — see the note in README.md.
  typicalLatencyMs: 12_000
};

const GEMINI: BrainProviderDefinition = {
  id: "gemini",
  binary: "gemini",
  label: "Gemini CLI",
  versionArgs: ["--version"],
  defaultModel: "gemini-2.5-flash",
  buildArgs: ({ prompt, model }) =>
    model === undefined ? ["-p", prompt] : ["-p", prompt, "-m", model],
  minIntervalMs: 1_200,
  typicalLatencyMs: 12_000
};

/**
 * Preference order.
 *
 * Claude first because it is the deepest tier available on a subscription the
 * user already holds, then Antigravity, then the plain Gemini CLI. Order is a
 * default, not a policy — the Engine Room lets the owner pin whichever they
 * want per kind of work, and a pinned choice always beats this list.
 */
export const PROVIDER_DEFINITIONS: readonly BrainProviderDefinition[] = Object.freeze([
  CLAUDE,
  ANTIGRAVITY,
  GEMINI
]);

export function providerDefinition(id: BrainProviderId): BrainProviderDefinition {
  const found = PROVIDER_DEFINITIONS.find((definition) => definition.id === id);
  if (found === undefined) {
    throw new Error(`Unknown brain provider: ${id}`);
  }
  return found;
}
