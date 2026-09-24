/** Agents have no approved outbound dispatch path. Only the bundled runtime is reachable. */
import { randomUUID } from "node:crypto";
import {
  CadraneLocalBaseUrlSchema, LocalChatRequestSchema, LocalChatResultSchema,
  RuntimeDescriptorSchema, type AgentBrief, type EngineRoomStatus
} from "@cadrane/contracts";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import type { RunDeps } from "./run.js";

const RUNTIME = "cadrane-local-loopback";
const MAX_CONTEXT = 12_000;

export async function prepareLocalAgent(
  brief: AgentBrief,
  runtime: LocalWorkroomDeps,
  signal: AbortSignal,
  responseProfile: "local-draft-v1" | "bill-excerpts-v1" | "print-enquiry-v1" = "local-draft-v1"
): Promise<{ room: EngineRoomStatus; ask: RunDeps["ask"] }> {
  if (brief.engine.pinnedEngineId !== null && brief.engine.pinnedEngineId !== "local")
    throw new Error("This agent is pinned to an external engine. Agent runs need an outbound review before using a subscription; nothing was sent. Choose this Mac in a new brief.");
  signal.throwIfAborted();
  const descriptors = await runtime.discover();
  signal.throwIfAborted();
  const candidate = descriptors.find(value => value.id === RUNTIME);
  const parsed = RuntimeDescriptorSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind !== "lm-studio" ||
      !CadraneLocalBaseUrlSchema.safeParse(parsed.data.baseUrl).success ||
      parsed.data.state !== "available" || parsed.data.models.length === 0)
    throw new Error("The bundled model is not ready. Check Models and try again. No subscription was contacted.");
  const descriptor = parsed.data;
  const models = descriptor.models.map(model => ({
    id: model.id, label: model.displayName, tier: "on-device" as const,
    tierLabel: "On this Mac", note: "The verified bundled model.", includedInSubscription: true
  }));
  const room: EngineRoomStatus = {
    engines: [{ id: "local", label: "This Mac", access: "on-device", accessLabel: "This Mac",
      state: "ready", summary: descriptor.detail, fixHint: null, evidence: null, models }],
    active: { engineId: "local", modelId: models[0]!.id },
    checkedAt: descriptor.checkedAt, allUnavailable: false
  };
  return {
    room,
    ask: async input => {
      input.signal.throwIfAborted();
      if (input.engineId !== "local" || !models.some(model => model.id === input.modelId))
        throw new Error("This agent may ask only the discovered bundled model. Nothing was sent.");
      if (input.system.length + input.prompt.length > MAX_CONTEXT)
        throw new Error("This agent has more context than the local request can hold. Use a smaller folder or a narrower request.");
      const operationId = randomUUID();
      const request = LocalChatRequestSchema.parse({
        operationId, runtimeId: RUNTIME, modelId: input.modelId,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }],
        temperature: 0.2, maxTokens: 1_024, responseProfile
      });
      // The daemon owns the shared inference lane. Cancellation targets only
      // this call, and a late response is discarded even if cancellation fails.
      const onStop = () => { void runtime.cancel(operationId).catch(() => undefined); };
      input.signal.addEventListener("abort", onStop, { once: true });
      try {
        input.signal.throwIfAborted();
        const answer = LocalChatResultSchema.parse(await runtime.chat(request));
        input.signal.throwIfAborted();
        if (answer.operationId !== operationId || answer.runtimeId !== RUNTIME ||
            answer.modelId !== input.modelId || answer.localOnly !== true)
          throw new Error("The local response did not match this agent request. No answer was accepted.");
        const content = answer.content.trim();
        if (!content || content.length > 16_000)
          throw new Error("The local model returned no usable answer. Ask for a shorter result.");
        return content;
      } finally {
        input.signal.removeEventListener("abort", onStop);
      }
    }
  };
}
