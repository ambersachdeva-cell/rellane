import {
  LocalChatResultSchema,
  RuntimeDescriptorSchema,
  type LocalChatRequest,
  type LocalChatResult,
  type RuntimeDescriptor
} from "@cadrane/contracts";
import { z } from "zod";
import { RuntimeBoundaryError, RuntimeHttpError } from "../errors.js";
import { requestJson, type JsonRequester } from "./safe-fetch.js";
import type { LocalRuntimeAdapter } from "./types.js";
import { responseProfileOptions, requireCompleteProfile } from "./response-profile.js";

const BASE_URL = "http://127.0.0.1:1234";

const ModelsSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(512)
  })).max(256)
});
const ChatResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().max(2_000_000) }),
    finish_reason: z.string().nullable().optional()
  })).min(1).max(100)
});

export class LmStudioAdapter implements LocalRuntimeAdapter {
  readonly id: string;
  readonly kind = "lm-studio" as const;
  private readonly baseUrl: string;

  get identity() {
    return {
      name: this.loopbackBearer === undefined ? "LM Studio" : "Rellane Local",
      baseUrl: this.baseUrl
    };
  }

  constructor(
    private readonly requester: JsonRequester = requestJson,
    private readonly loopbackBearer?: string
  ) {
    this.id = loopbackBearer === undefined
      ? "lm-studio-loopback"
      : "cadrane-local-loopback";
    this.baseUrl = loopbackBearer === undefined
      ? BASE_URL
      : process.env.CADRANE_LOCAL_BASE_URL ?? BASE_URL;
  }

  async probe(): Promise<RuntimeDescriptor> {
    const checkedAt = new Date().toISOString();
    try {
      const raw = await this.requester(`${this.baseUrl}/v1/models`, {
        timeoutMs: 1_500,
        maxResponseBytes: 1_000_000,
        ...(this.loopbackBearer === undefined
          ? {}
          : { loopbackBearer: this.loopbackBearer })
      });
      const models = ModelsSchema.parse(raw).data;
      return RuntimeDescriptorSchema.parse({
        id: this.id,
        kind: this.kind,
        name: this.loopbackBearer === undefined ? "LM Studio" : "Rellane Local",
        state: "available",
        baseUrl: this.baseUrl,
        version: null,
        models: models.map((model) => ({
          id: model.id,
          displayName: model.id,
          sizeBytes: null,
          loaded: null
        })),
        detail: models.length === 0
          ? this.loopbackBearer === undefined
            ? "LM Studio is running. Load a model in LM Studio to start local work."
            : "Rellane's private local engine is starting its model."
          : `${models.length} local model${models.length === 1 ? "" : "s"} available.`,
        checkedAt
      });
    } catch (error) {
      const attention = discoveryStateForError(error, this.loopbackBearer !== undefined) === "attention";
      return RuntimeDescriptorSchema.parse({
        id: this.id,
        kind: this.kind,
        name: this.loopbackBearer === undefined ? "LM Studio" : "Rellane Local",
        state: attention ? "attention" : "unavailable",
        baseUrl: this.baseUrl,
        version: null,
        models: [],
        detail: attention
          ? "A service responded on the private local-model port with an unexpected contract."
          : this.loopbackBearer === undefined
            ? "LM Studio was not detected on 127.0.0.1:1234."
            : "Rellane's private local model is not ready yet.",
        checkedAt
      });
    }
  }

  async chat(request: LocalChatRequest, signal: AbortSignal): Promise<LocalChatResult> {
    const profile = responseProfileOptions(request, this.loopbackBearer !== undefined);
    const startedAt = new Date().toISOString();
    const raw = await this.requester(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal,
      timeoutMs: 120_000,
      maxResponseBytes: 4_000_000,
      ...(this.loopbackBearer === undefined
        ? {}
        : { loopbackBearer: this.loopbackBearer }),
      body: {
        model: request.modelId,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false,
        ...profile
      }
    });
    const parsed = ChatResponseSchema.safeParse(raw);
    const content = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
    if (content === undefined) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_RESPONSE_INVALID",
        message: this.loopbackBearer === undefined
          ? "LM Studio returned an unexpected chat response."
          : "Rellane's private local model returned an unexpected chat response.",
        retryable: false
      }, { cause: parsed.success ? undefined : parsed.error });
    }
    requireCompleteProfile(request, parsed.success ? parsed.data.choices[0]?.finish_reason : undefined);
    return LocalChatResultSchema.parse({
      operationId: request.operationId,
      runtimeId: this.id,
      modelId: request.modelId,
      content,
      startedAt,
      finishedAt: new Date().toISOString(),
      localOnly: true
    });
  }
}

/** The authenticated bundled server can answer 503 while loading its model.
 * This permits another readiness check, never inference or a cached green state.
 * Other HTTP failures and malformed replies still require attention. */
function discoveryStateForError(
  error: unknown,
  bundled: boolean
): "unavailable" | "attention" {
  if (bundled && error instanceof RuntimeHttpError && error.status === 503)
    return "unavailable";
  if (error instanceof RuntimeBoundaryError &&
    (error.detail.code === "RUNTIME_UNAVAILABLE" ||
      error.detail.code === "TIMEOUT" || error.detail.code === "CANCELLED"))
    return "unavailable";
  return "attention";
}
