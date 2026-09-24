import {
  LocalChatResultSchema,
  RuntimeDescriptorSchema,
  type LocalChatRequest,
  type LocalChatResult,
  type RuntimeDescriptor
} from "@cadrane/contracts";
import { z } from "zod";
import { RuntimeBoundaryError } from "../errors.js";
import { requestJson, type JsonRequester } from "./safe-fetch.js";
import type { LocalRuntimeAdapter } from "./types.js";

const BASE_URL = "http://127.0.0.1:11434";

const VersionSchema = z.object({ version: z.string().min(1).max(100) });
const TagsSchema = z.object({
  models: z.array(z.object({
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe().optional()
  })).max(256)
});
const RunningSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1).max(512) })).max(256)
});
const ChatResponseSchema = z.object({
  message: z.object({ content: z.string().max(2_000_000) })
});

export class OllamaAdapter implements LocalRuntimeAdapter {
  readonly id = "ollama-loopback";
  readonly kind = "ollama" as const;
  readonly identity = { name: "Ollama", baseUrl: BASE_URL };

  constructor(private readonly requester: JsonRequester = requestJson) {}

  async probe(): Promise<RuntimeDescriptor> {
    const checkedAt = new Date().toISOString();
    try {
      const [versionValue, tagsValue] = await Promise.all([
        this.requester(`${BASE_URL}/api/version`, { timeoutMs: 1_500, maxResponseBytes: 32_000 }),
        this.requester(`${BASE_URL}/api/tags`, { timeoutMs: 1_500, maxResponseBytes: 1_000_000 })
      ]);
      const version = VersionSchema.parse(versionValue);
      const tags = TagsSchema.parse(tagsValue);

      let loaded = new Set<string>();
      try {
        const runningValue = await this.requester(`${BASE_URL}/api/ps`, {
          timeoutMs: 1_500,
          maxResponseBytes: 1_000_000
        });
        loaded = new Set(RunningSchema.parse(runningValue).models.map((model) => model.name));
      } catch {
        loaded = new Set();
      }

      return RuntimeDescriptorSchema.parse({
        id: this.id,
        kind: this.kind,
        name: "Ollama",
        state: "available",
        baseUrl: BASE_URL,
        version: version.version,
        models: tags.models.map((model) => ({
          id: model.name,
          displayName: model.name,
          sizeBytes: model.size ?? null,
          loaded: loaded.has(model.name)
        })),
        detail: tags.models.length === 0
          ? "Ollama is running. Install a model in Ollama to start local work."
          : `${tags.models.length} local model${tags.models.length === 1 ? "" : "s"} available.`,
        checkedAt
      });
    } catch (error) {
      const attention = !(error instanceof RuntimeBoundaryError) ||
        error.detail.code === "RUNTIME_RESPONSE_INVALID";
      return RuntimeDescriptorSchema.parse({
        id: this.id,
        kind: this.kind,
        name: "Ollama",
        state: attention ? "attention" : "unavailable",
        baseUrl: BASE_URL,
        version: null,
        models: [],
        detail: attention
          ? "A service responded on port 11434, but it did not match the supported Ollama contract."
          : "Ollama was not detected on 127.0.0.1:11434.",
        checkedAt
      });
    }
  }

  async chat(request: LocalChatRequest, signal: AbortSignal): Promise<LocalChatResult> {
    if (request.responseProfile)
      throw new RuntimeBoundaryError({ code: "BAD_REQUEST",
        message: "This response profile requires the bundled local model.", retryable: false });
    const startedAt = new Date().toISOString();
    const raw = await this.requester(`${BASE_URL}/api/chat`, {
      method: "POST",
      signal,
      timeoutMs: 120_000,
      maxResponseBytes: 4_000_000,
      body: {
        model: request.modelId,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens
        }
      }
    });
    const parsed = ChatResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_RESPONSE_INVALID",
        message: "Ollama returned an unexpected chat response.",
        retryable: false
      }, { cause: parsed.error });
    }
    return LocalChatResultSchema.parse({
      operationId: request.operationId,
      runtimeId: this.id,
      modelId: request.modelId,
      content: parsed.data.message.content,
      startedAt,
      finishedAt: new Date().toISOString(),
      localOnly: true
    });
  }
}
