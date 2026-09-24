/** Historical keyed transport, retained for isolated tests and explicit Forget
 * metadata. No production request caller remains. The owner forbids provider
 * credential custody and API fallback; do not reconnect this legacy transport.
 * The original rationale below is history, superseded by D-109. */
/**
 * Asking an engine with a key the owner pays per token for.
 *
 * ## This is the fallback, and it stays the fallback
 *
 * D-022's order is **your subscription → this Mac → an API key**, and nothing
 * here changes it. Somebody paying for Claude Pro must not then pay per token
 * for what they already bought, so a keyed engine is only ever reached when the
 * first two cannot answer. It is labelled *"Pay per use"* on the shelf for the
 * same reason.
 *
 * That said, D-073 changed how much this matters. Anthropic banned third-party
 * use of subscription OAuth in February 2026; Rellane's own approach — spawning
 * the vendor's CLI as the owner — is on the defensible side of the line drawn,
 * but the line moved toward us. **A product whose only route is a subscription
 * is a product with one policy change between it and nothing.** This path is
 * the answer to that, and it is worth having built before it is needed.
 *
 * ## The key is the owner's and never travels
 *
 * It is read from the secret store on this Mac, put in a header, and dropped.
 * It is never logged, never included in a diagnostics bundle, never sent
 * anywhere but the vendor it belongs to, and never held in a module-level
 * variable that could outlive the request.
 *
 * ## Why the request is hand-written
 *
 * Two vendors, two shapes, about forty lines. An SDK for each would add two
 * dependency trees, their transitive network stacks, and a release cadence
 * nobody here controls — to save writing a `fetch` call whose exact shape is
 * the thing worth being able to read (D-006 made the same trade for SQLite).
 */

import type { SecretStore } from "../security/secrets.js";

/** Long enough for a real answer, short enough that a hung request is not forever. */
export const KEYED_TIMEOUT_MS = 180_000;

/** Which vendors can be reached with a key. */
export type KeyedEngineId = "anthropic-api" | "google-api";

export interface KeyedEngine {
  readonly id: KeyedEngineId;
  readonly label: string;
  /** Where the key is kept in the secret store. */
  readonly secretName: string;
  /** Where to get one, said plainly on the screen that asks for it. */
  readonly keysAt: string;
}

export const KEYED_ENGINES: readonly KeyedEngine[] = [
  {
    id: "anthropic-api",
    label: "Claude (API key)",
    secretName: "anthropic-api-key",
    keysAt: "console.anthropic.com"
  },
  {
    id: "google-api",
    label: "Gemini (API key)",
    secretName: "google-api-key",
    keysAt: "aistudio.google.com"
  }
];

export function keyedEngine(id: string): KeyedEngine | undefined {
  return KEYED_ENGINES.find((engine) => engine.id === id);
}

export class KeyedEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyedEngineError";
  }
}

interface AskInput {
  readonly engineId: KeyedEngineId;
  readonly modelId: string;
  readonly system: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

/**
 * Reads whatever the vendor sent back, without believing its shape.
 *
 * Both APIs nest the text differently and both can return a 200 carrying an
 * error. Anything that is not recognisably an answer is reported as one that
 * could not be read — never as an empty answer, which would put silence on the
 * record as though the model had considered the question and said nothing.
 */
function textOf(engineId: KeyedEngineId, body: unknown): string | null {
  const root = body as Record<string, unknown> | null;
  if (root === null || typeof root !== "object") {
    return null;
  }
  if (engineId === "anthropic-api") {
    const content = root["content"];
    if (!Array.isArray(content)) {
      return null;
    }
    const text = content
      .map((part) => (part as Record<string, unknown>)?.["text"])
      .filter((part): part is string => typeof part === "string")
      .join("");
    return text.trim().length === 0 ? null : text;
  }
  const candidates = root["candidates"];
  if (!Array.isArray(candidates)) {
    return null;
  }
  const parts = (candidates[0] as Record<string, unknown>)?.["content"] as
    | Record<string, unknown>
    | undefined;
  const list = parts?.["parts"];
  if (!Array.isArray(list)) {
    return null;
  }
  const text = list
    .map((part) => (part as Record<string, unknown>)?.["text"])
    .filter((part): part is string => typeof part === "string")
    .join("");
  return text.trim().length === 0 ? null : text;
}

/**
 * Asks a vendor directly, with the owner's own key.
 *
 * Never throws anything but `KeyedEngineError`, and its message is always
 * something a person can act on: a missing key says where to put one, a refused
 * key says the vendor refused it, and a network failure says so rather than
 * blaming the model.
 */
export async function askWithKey(
  input: AskInput,
  secrets: SecretStore,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const engine = keyedEngine(input.engineId);
  if (engine === undefined) {
    throw new KeyedEngineError(`${input.engineId} is not an engine Rellane can key.`);
  }

  const stored = await secrets.get(engine.secretName).catch(() => null);
  // Trimmed before it is used, not only before it is checked. A key pasted with
  // a trailing newline passed the emptiness test and then went into a header
  // verbatim, where `fetch` throws ERR_INVALID_CHAR — which this function would
  // have reported as a network failure, sending somebody to check their wifi.
  const key = stored?.trim() ?? "";
  if (key.length === 0) {
    throw new KeyedEngineError(
      `No API key is stored for ${engine.label}. Add one in Engines, or use a subscription instead — Rellane prefers the subscription you already pay for.`
    );
  }

  const anthropic = input.engineId === "anthropic-api";
  const url = anthropic
    ? "https://api.anthropic.com/v1/messages"
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.modelId)}:generateContent`;

  const headers: Record<string, string> = anthropic
    ? {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": key
      }
    : { "content-type": "application/json", "x-goog-api-key": key };

  // Gemini rejects an empty text part outright — `400 InvalidArgument: string
  // value cannot be empty` — so an absent system prompt has to mean the field
  // is absent, not present and blank.
  const system = input.system.trim();
  const body = anthropic
    ? {
        model: input.modelId,
        max_tokens: 4_096,
        ...(system.length === 0 ? {} : { system }),
        messages: [{ role: "user", content: input.prompt }]
      }
    : {
        ...(system.length === 0 ? {} : { systemInstruction: { parts: [{ text: system }] } }),
        contents: [{ role: "user", parts: [{ text: input.prompt }] }]
      };

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(KEYED_TIMEOUT_MS)])
    });
  } catch (error) {
    // The network, not the model. Blaming the model here would send somebody to
    // change a setting that was never the problem.
    throw new KeyedEngineError(
      input.signal.aborted
        ? "That was stopped before it finished."
        : `${engine.label} could not be reached. That is usually the network rather than anything about your key. (${
            error instanceof Error ? error.message : "no reason given"
          })`
    );
  }

  if (!response.ok) {
    // Cancelled rather than left dangling. An unread body keeps its socket out
    // of the pool, and a run of rate-limit responses would leak one each.
    await response.body?.cancel().catch(() => undefined);
    // The status, and nothing from the body: a vendor error body can echo the
    // request, and this one carried the owner's prompt.
    throw new KeyedEngineError(
      response.status === 401 || response.status === 403
        ? `${engine.label} refused that key. Check it at ${engine.keysAt}.`
        : response.status === 429
          ? `${engine.label} is rate-limiting this key. Wait a moment and try again.`
          : `${engine.label} answered with ${response.status}.`
    );
  }

  // Reading the body can fail on its own — the connection drops mid-download,
  // or the owner pressed Stop. Swallowing that into `null` reported it as
  // "replied with something that was not an answer", which blames the model for
  // something that never reached us.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new KeyedEngineError(
      input.signal.aborted
        ? "That was stopped before it finished."
        : `${engine.label} answered, but the reply did not arrive in one piece. That is usually the network. (${
            error instanceof Error ? error.message : "no reason given"
          })`
    );
  }

  const text = textOf(input.engineId, payload);
  if (text === null) {
    throw new KeyedEngineError(`${engine.label} replied with something that was not an answer.`);
  }
  return text;
}
