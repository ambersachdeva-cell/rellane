/** The fixed server profile cannot silently become free-form or run on another adapter. */
import { describe, expect, it } from "vitest";
import { LocalChatRequestSchema, type LocalChatRequest } from "@cadrane/contracts";
import { LmStudioAdapter } from "./lm-studio.js";
import { OllamaAdapter } from "./ollama.js";
import type { JsonRequester } from "./safe-fetch.js";
import { responseProfileOptions, requireCompleteProfile } from "./response-profile.js";

const request: LocalChatRequest = {
  operationId: "f1377aca-214c-4124-8a27-a3a49ca05704", runtimeId: "cadrane-local-loopback", modelId: "qwen",
  messages: [{ role: "user", content: "A fictional enquiry" }],
  temperature: 0.2, maxTokens: 2048, responseProfile: "print-enquiry-v1"
};
describe("named enquiry response profile", () => {
  it("ships seven bill excerpts with bill scope through the actual adapter and refuses truncation or external routing", async () => {
    const bill = LocalChatRequestSchema.parse({ ...request, responseProfile: "bill-excerpts-v1", maxTokens: 1024 });
    const bodies: unknown[] = [];
    const adapter = new LmStudioAdapter(async (_url, options) => {
      bodies.push(options?.body); return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
    }, "synthetic-loopback-test-bearer");
    await adapter.chat(bill, new AbortController().signal);
    expect(bodies[0]).toMatchObject({ max_tokens: 1024, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "bill_excerpts_v1", strict: true, schema: {
        additionalProperties: false, required: ["scope", "fields"], properties: {
          scope: { enum: ["one_bill", "multiple_bills", "unclear"] },
          fields: { additionalProperties: false, required: ["partyName", "number", "issuedOn", "dueOn", "subtotal", "tax", "total"],
            properties: { tax: { anyOf: [{ type: "string", minLength: 1, maxLength: 400 }, { type: "null" }] } } }
        }
      } } } });
    expect(() => requireCompleteProfile(bill, "length")).toThrow("did not finish the bill");
    expect(() => responseProfileOptions(bill, false)).toThrow("only by the bundled");
  });
  it("requests direct prose within the existing draft budget and refuses a truncated answer", async () => {
    const draft = LocalChatRequestSchema.parse({ ...request, responseProfile: "local-draft-v1", maxTokens: 1024 });
    const bodies: unknown[] = [];
    const adapter = new LmStudioAdapter(async (_url, options) => {
      bodies.push(options?.body);
      return { choices: [{ message: { content: "A finished draft." }, finish_reason: "stop" }] };
    }, "synthetic-loopback-test-bearer");
    expect((await adapter.chat(draft, new AbortController().signal)).content).toBe("A finished draft.");
    expect(bodies[0]).toMatchObject({ max_tokens: 1024, chat_template_kwargs: { enable_thinking: false } });
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(() => requireCompleteProfile(draft, "length")).toThrow("did not finish its answer");
    expect(() => responseProfileOptions(draft, false)).toThrow("only by the bundled");
  });
  it("puts the bounded shape inside the wrapper the pinned server actually reads", async () => {
    const bodies: unknown[] = [];
    const requester: JsonRequester = async (_url, options) => {
      bodies.push(options?.body);
      return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
    };
    const adapter = new LmStudioAdapter(requester, "synthetic-loopback-test-bearer");
    const result = await adapter.chat(request, new AbortController().signal);
    expect(result.content).toBe("{}");
    expect(bodies[0]).toMatchObject({
      max_tokens: 2048, stream: false, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { schema: {
        additionalProperties: false, required: ["scope", "fields"],
        properties: { fields: { additionalProperties: false,
          required: ["item", "quantities", "dimensions", "printing", "stock", "finish", "fulfilment", "timing", "destination", "artwork", "invoice", "changes", "other"],
          properties: { artwork: { anyOf: [{ type: "string", minLength: 1, maxLength: 400 }, { type: "null" }] } }
        } }
      } } }
    });
    expect(bodies[0]).not.toHaveProperty("response_format.schema");
    await adapter.chat({ ...request, responseProfile: undefined }, new AbortController().signal);
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("chat_template_kwargs");
  });
  it("refuses missing, truncated and unexpected completion reasons instead of accepting parseable partial output", async () => {
    for (const finish_reason of [undefined, null, "length", "tool_calls", "error"]) {
      const adapter = new LmStudioAdapter(async () => ({
        choices: [{ message: { content: "{}" }, finish_reason }]
      }), "synthetic-loopback-test-bearer");
      await expect(adapter.chat(request, new AbortController().signal)).rejects.toThrow("did not finish");
    }
    expect(() => requireCompleteProfile(request, "stop")).not.toThrow();
  });
  it("refuses other runtimes before making a network request", async () => {
    let calls = 0;
    const requester: JsonRequester = async () => { calls++; return {}; };
    await expect(new LmStudioAdapter(requester).chat(request, new AbortController().signal)).rejects.toThrow("only by the bundled");
    await expect(new OllamaAdapter(requester).chat(request, new AbortController().signal)).rejects.toThrow("bundled");
    expect(calls).toBe(0);
    expect(() => responseProfileOptions({ ...request, runtimeId: "ollama-loopback" }, true)).toThrow("only by the bundled");
  });
  it("ships graph node with exact temperature and maxTokens, disables thinking, and refuses truncation or external routing", async () => {
    const graphNode = LocalChatRequestSchema.parse({
      ...request,
      responseProfile: "graph-node-v1",
      temperature: 0.0,
      maxTokens: 512,
      response_format: { type: "json_object" },
      chat_template_kwargs: { enable_thinking: true }
    });
    const bodies: unknown[] = [];
    const adapter = new LmStudioAdapter(async (_url, options) => {
      bodies.push(options?.body);
      return { choices: [{ message: { content: "Node output." }, finish_reason: "stop" }] };
    }, "synthetic-loopback-test-bearer");
    const result = await adapter.chat(graphNode, new AbortController().signal);
    expect(result.content).toBe("Node output.");
    expect(bodies[0]).toMatchObject({
      temperature: 0.0,
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false }
    });
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(graphNode).not.toHaveProperty("response_format");
    for (const finish_reason of ["length", "tool_calls"]) {
      const failingAdapter = new LmStudioAdapter(async () => ({
        choices: [{ message: { content: "partial" }, finish_reason }]
      }), "synthetic-loopback-test-bearer");
      await expect(failingAdapter.chat(graphNode, new AbortController().signal)).rejects.toThrow("did not finish");
      expect(() => requireCompleteProfile(graphNode, finish_reason)).toThrow("did not finish");
    }
    let calls = 0;
    const requester: JsonRequester = async () => { calls++; return {}; };
    await expect(new LmStudioAdapter(requester).chat(graphNode, new AbortController().signal)).rejects.toThrow("only by the bundled");
    await expect(new OllamaAdapter(requester).chat(graphNode, new AbortController().signal)).rejects.toThrow("bundled");
    expect(calls).toBe(0);
    expect(() => responseProfileOptions(graphNode, false)).toThrow("only by the bundled");
    expect(() => responseProfileOptions({ ...graphNode, runtimeId: "ollama-loopback" }, true)).toThrow("only by the bundled");
  });
  it("rejects unknown named profiles at the wire boundary and never forwards arbitrary server schemas", () => {
    expect(LocalChatRequestSchema.safeParse({ ...request, responseProfile: "anything-goes" }).success).toBe(false);
    expect(LocalChatRequestSchema.safeParse({ ...request, runtimeId: "managed-llama" }).success).toBe(false);
    const parsed = LocalChatRequestSchema.parse({ ...request, response_format: { type: "text" }, chat_template_kwargs: { enable_thinking: true } });
    expect(responseProfileOptions(parsed, true)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(parsed).not.toHaveProperty("response_format");
  });
});
