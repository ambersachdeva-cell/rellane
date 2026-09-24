/**
 * The environment a native session runs in.
 *
 * One rule, in one place: a workstation session runs on the subscription the
 * owner already pays for, so the pay-per-token fallbacks every one of these CLIs
 * reads from the environment are removed from the child before it starts. A key
 * left in the environment is a silent second billing relationship — the session
 * appears to work, and the charge turns up on a card instead of against a plan.
 *
 * Nothing here reads a value. `delete` on a copy is enough to remove a variable,
 * and copying is what keeps this out of the app's own `process.env`: mutating
 * the parent environment would change what every later child inherits, including
 * ones this module knows nothing about.
 */

/**
 * The keys removed, named rather than pattern-matched.
 *
 * A regular expression over "KEY" or "TOKEN" would also strip variables a
 * project legitimately needs, and would silently change meaning whenever
 * somebody renamed something. These are the documented API-key and auth-token
 * fallbacks for the three vendors whose CLIs this app drives.
 */
export const WORKSTATION_REMOVED_ENV_KEYS: readonly string[] = [
  // OpenAI / Codex
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  // Anthropic / Claude Code
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  // Google / Gemini / Antigravity
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI"
];

/**
 * A child environment for one native session.
 *
 * `profileHome` sets `HOME` for the child only, which is how the three Gemini
 * profiles stay separate accounts without this app ever opening the files that
 * make them separate.
 */
export function nativeChildEnv(profileHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of WORKSTATION_REMOVED_ENV_KEYS) {
    delete env[key];
  }
  if (profileHome !== undefined && profileHome !== "") {
    env["HOME"] = profileHome;
  }
  return env;
}
