/** The local model can propose relevant saved files, but cannot select, send or invent one. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CadraneLocalBaseUrlSchema, LocalChatResultSchema, RuntimeDescriptorSchema,
  WorkstationContextSuggestionInputSchema, type WorkstationContextSuggestion,
  type WorkstationContextSuggestionInput } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { readCase, turnsFor } from "../book/cases.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { CONTEXT_SUGGESTION_SYSTEM, prepareContextSuggestion, parseContextSuggestion } from "./context-suggestion.js";

const RUNTIME = "cadrane-local-loopback";

export async function suggestLocalContext(db: DatabaseSync, raw: WorkstationContextSuggestionInput,
  runtime: LocalWorkroomDeps, signal: AbortSignal, assertCurrent: () => void): Promise<WorkstationContextSuggestion> {
  const input = WorkstationContextSuggestionInputSchema.parse(raw);
  const check = () => { signal.throwIfAborted(); assertCurrent(); };
  const sources = () => {
    check();
    const room = readCase(db, input.caseId);
    if (!room || room.closedAt !== null) throw new Error("Open this work before asking for context suggestions.");
    const turns = turnsFor(db, input.caseId);
    return input.sourceTurnIds.map(id => {
      const turn = turns.find(value => value.id === id && value.kind === "verbatim" && value.seat.startsWith(CASE_SOURCE_SEAT_PREFIX));
      if (!turn) throw new Error("A saved file is no longer available in this work. Review the files again.");
      return { id: turn.id, label: turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length), text: turn.body };
    });
  };
  const packet = prepareContextSuggestion(input.question, sources());
  const startedAt = Date.now();
  const discovered = await runtime.discover();
  check();
  const parsed = RuntimeDescriptorSchema.safeParse(discovered.find(value => value.id === RUNTIME));
  if (!parsed.success || parsed.data.kind !== "lm-studio" || parsed.data.state !== "available" ||
      !CadraneLocalBaseUrlSchema.safeParse(parsed.data.baseUrl).success || !parsed.data.models[0])
    throw new Error("The local model is not ready. Check it in Your AI connections, or choose the files yourself. No subscription was contacted.");
  const modelId = parsed.data.models[0].id;
  const operationId = randomUUID();
  let dispatched = false;
  const cancel = () => { void runtime.cancel(operationId).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    check();
    if (prepareContextSuggestion(input.question, sources()).sha256 !== packet.sha256)
      throw new Error("The saved files changed. Ask for a fresh context suggestion.");
    dispatched = true;
    const answer = LocalChatResultSchema.parse(await runtime.chat({
      operationId, runtimeId: RUNTIME, modelId,
      messages: [{ role: "system", content: CONTEXT_SUGGESTION_SYSTEM }, { role: "user", content: packet.prompt }],
      temperature: 0, maxTokens: 256, responseProfile: "local-draft-v1"
    }));
    check();
    if (answer.operationId !== operationId || answer.runtimeId !== RUNTIME || answer.modelId !== modelId || !answer.localOnly)
      throw new Error("The local response did not match this request. Your selection is unchanged.");
    if (prepareContextSuggestion(input.question, sources()).sha256 !== packet.sha256)
      throw new Error("The saved files changed during the suggestion. Your selection is unchanged.");
    let selected: readonly string[];
    try { selected = parseContextSuggestion(answer.content, packet); }
    catch (cause) { throw new Error("The local model did not return a usable file selection. Choose the files yourself, or try a clearer question. Your selection is unchanged.", { cause }); }
    return {
      sourceTurnIds: selected, consideredIds: [...input.sourceTurnIds],
      omittedIds: packet.omittedIds, excerptedIds: packet.candidates.filter(value => value.excerpted).map(value => value.id),
      modelId, durationMs: Date.now() - startedAt, sourceHash: packet.sha256
    };
  } catch (error) {
    if (dispatched) await runtime.cancel(operationId).catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", cancel); }
}
