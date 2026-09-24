import { describe, expect, it } from "vitest";
import {
  formatHermesSystemPrompt,
  formatToolResponse,
  parseHermesOutput,
  runHermesLoop,
  type HermesToolCall,
  type HermesToolDefinition,
  type HermesToolResponse,
} from "./hermes-agent-loop.js";

describe("formatHermesSystemPrompt", () => {
  it("includes tool definitions and Hermes XML instructions in prompt", () => {
    const tools: readonly HermesToolDefinition[] = [
      {
        name: "search_contacts",
        description: "Search customer contacts by name or email.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ];

    const prompt = formatHermesSystemPrompt(tools);
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("</tools>");
    expect(prompt).toContain("<tool_call>");
    expect(prompt).toContain("<thought>");
    expect(prompt).toContain("search_contacts");
    expect(prompt).toContain("Search customer contacts by name or email.");
  });
});

describe("parseHermesOutput", () => {
  it("extracts single tool call, thought block, and strips them from reply", () => {
    const raw = [
      "<thought>I need to check the inventory status first.</thought>",
      "I am checking the stock level now.",
      "<tool_call>",
      '{"name": "check_stock", "arguments": {"sku": "SKU-990"}}',
      "</tool_call>",
    ].join("\n");

    const parsed = parseHermesOutput(raw);
    expect(parsed.thought).toBe("I need to check the inventory status first.");
    expect(parsed.reply).toBe("I am checking the stock level now.");
    expect(parsed.toolCalls.length).toBe(1);

    if (parsed.toolCalls.length > 0) {
      const call = parsed.toolCalls[0]!;
      expect(call.name).toBe("check_stock");
      expect(call.arguments).toEqual({ sku: "SKU-990" });
      expect(typeof call.id).toBe("string");
    }
  });

  it("extracts multiple tool calls", () => {
    const raw = [
      "<thought>Looking up two data sources.</thought>",
      "<tool_call>",
      '{"name": "lookup_user", "arguments": {"id": 101}}',
      "</tool_call>",
      "<tool_call>",
      '{"name": "lookup_balance", "arguments": {"accountId": "ACC-42"}}',
      "</tool_call>",
    ].join("\n");

    const parsed = parseHermesOutput(raw);
    expect(parsed.toolCalls.length).toBe(2);

    if (parsed.toolCalls.length === 2) {
      expect(parsed.toolCalls[0]!.name).toBe("lookup_user");
      expect(parsed.toolCalls[1]!.name).toBe("lookup_balance");
    }
  });

  it("handles malformed JSON in tool call without throwing", () => {
    const raw = [
      "<thought>Trying to invoke a tool with truncated output.</thought>",
      "<tool_call>",
      '{"name": "calc", "arguments": { unclosed json',
      "</tool_call>",
    ].join("\n");

    expect(() => {
      const parsed = parseHermesOutput(raw);
      expect(parsed.toolCalls.length).toBe(1);
    }).not.toThrow();
  });

  it("omits thought field completely when not present", () => {
    const raw = "The balance has been verified.";
    const parsed = parseHermesOutput(raw);
    expect("thought" in parsed).toBe(false);
    expect(parsed.thought).toBeUndefined();
    expect(parsed.reply).toBe("The balance has been verified.");
    expect(parsed.toolCalls.length).toBe(0);
  });
});

describe("formatToolResponse", () => {
  it("formats response payload within tool_response tags", () => {
    const response: HermesToolResponse = {
      callId: "call_12345",
      name: "fetch_ledger",
      result: "ledger_verified",
    };

    const formatted = formatToolResponse(response);
    expect(formatted).toContain("<tool_response>");
    expect(formatted).toContain("</tool_response>");
    expect(formatted).toContain("call_12345");
    expect(formatted).toContain("fetch_ledger");
    expect(formatted).toContain("ledger_verified");
  });
});

describe("runHermesLoop", () => {
  it("completes in a single turn when no tool calls are emitted", async () => {
    const executeModel = async (): Promise<string> =>
      "<thought>No tools needed.</thought>Here is the answer to your question.";

    const executeTool = async (call: HermesToolCall): Promise<HermesToolResponse> => ({
      callId: call.id,
      name: call.name,
      result: "unused",
    });

    const result = await runHermesLoop("Help me write an email", [], executeModel, executeTool);

    expect(result.completed).toBe(true);
    expect(result.finishReason).toBe("completed");
    expect(result.finalAnswer).toBe("Here is the answer to your question.");
    expect(result.totalSteps).toBe(1);
    expect(result.steps.length).toBe(1);

    if (result.steps.length > 0) {
      const step = result.steps[0]!;
      expect(step.thought).toBe("No tools needed.");
      expect(step.toolCalls.length).toBe(0);
      expect(step.toolResponses.length).toBe(0);
    }
  });

  it("recursively chains tool responses across a 3-step loop", async () => {
    let turn = 0;
    const promptsReceived: string[] = [];

    const executeModel = async (prompt: string): Promise<string> => {
      promptsReceived.push(prompt);
      turn++;
      if (turn === 1) {
        return [
          "<thought>First, lookup the customer id.</thought>",
          "<tool_call>",
          '{"name": "lookup_customer", "arguments": {"email": "alex@example.com"}}',
          "</tool_call>",
        ].join("\n");
      }
      if (turn === 2) {
        return [
          "<thought>Next, fetch active subscriptions for this customer.</thought>",
          "<tool_call>",
          '{"name": "fetch_subscriptions", "arguments": {"customerId": "CUST-1"}}',
          "</tool_call>",
        ].join("\n");
      }
      return [
        "<thought>All details retrieved.</thought>",
        "The customer holds an active annual subscription.",
      ].join("\n");
    };

    const executeTool = async (call: HermesToolCall): Promise<HermesToolResponse> => {
      if (call.name === "lookup_customer") {
        return {
          callId: call.id,
          name: call.name,
          result: JSON.stringify({ customerId: "CUST-1" }),
        };
      }
      return {
        callId: call.id,
        name: call.name,
        result: JSON.stringify({ plan: "annual", status: "active" }),
      };
    };

    const result = await runHermesLoop(
      "Check Alex subscription",
      [],
      executeModel,
      executeTool,
      { maxSteps: 5 }
    );

    expect(result.completed).toBe(true);
    expect(result.finishReason).toBe("completed");
    expect(result.totalSteps).toBe(3);
    expect(result.finalAnswer).toBe("The customer holds an active annual subscription.");
    expect(result.steps.length).toBe(3);

    if (result.steps.length === 3) {
      const step1 = result.steps[0]!;
      const step2 = result.steps[1]!;
      const step3 = result.steps[2]!;

      expect(step1.toolCalls.length).toBe(1);
      expect(step1.toolResponses.length).toBe(1);
      expect(step2.toolCalls.length).toBe(1);
      expect(step2.toolResponses.length).toBe(1);
      expect(step3.toolCalls.length).toBe(0);
    }

    if (promptsReceived.length === 3) {
      expect(promptsReceived[1]!).toContain("lookup_customer");
      expect(promptsReceived[1]!).toContain("CUST-1");
      expect(promptsReceived[2]!).toContain("fetch_subscriptions");
      expect(promptsReceived[2]!).toContain("annual");
    }
  });

  it("handles malformed JSON in tool call by returning an error response without crashing", async () => {
    let turn = 0;
    const executeModel = async (): Promise<string> => {
      turn++;
      if (turn === 1) {
        return [
          "<thought>Emitting broken JSON.</thought>",
          "<tool_call>",
          '{"name": "query_db", "arguments": { broken syntax',
          "</tool_call>",
        ].join("\n");
      }
      return "Recovered and completed.";
    };

    const executeTool = async (call: HermesToolCall): Promise<HermesToolResponse> => ({
      callId: call.id,
      name: call.name,
      result: "ok",
    });

    const result = await runHermesLoop("Test broken tool call", [], executeModel, executeTool, {
      maxSteps: 3,
    });

    expect(result.completed).toBe(true);
    expect(result.totalSteps).toBe(2);
    if (result.steps.length > 0) {
      const step1 = result.steps[0]!;
      expect(step1.toolResponses.length).toBe(1);
      if (step1.toolResponses.length > 0) {
        expect(step1.toolResponses[0]!.isError).toBe(true);
      }
    }
  });

  it("respects maxSteps budget and terminates with max_steps_exceeded", async () => {
    const executeModel = async (): Promise<string> => [
      "<thought>Still iterating.</thought>",
      "<tool_call>",
      '{"name": "ping", "arguments": {}}',
      "</tool_call>",
    ].join("\n");

    const executeTool = async (call: HermesToolCall): Promise<HermesToolResponse> => ({
      callId: call.id,
      name: call.name,
      result: "pong",
    });

    const result = await runHermesLoop("Infinite ping", [], executeModel, executeTool, {
      maxSteps: 2,
    });

    expect(result.completed).toBe(false);
    expect(result.finishReason).toBe("max_steps_exceeded");
    expect(result.totalSteps).toBe(2);
    expect(result.steps.length).toBe(2);
  });

  it("halts immediately when signal is triggered", async () => {
    const controller = new AbortController();
    controller.abort();

    const executeModel = async (): Promise<string> => "Should not be called";
    const executeTool = async (call: HermesToolCall): Promise<HermesToolResponse> => ({
      callId: call.id,
      name: call.name,
      result: "unused",
    });

    const result = await runHermesLoop("Aborted goal", [], executeModel, executeTool, {
      signal: controller.signal,
    });

    expect(result.completed).toBe(false);
    expect(result.finishReason).toBe("aborted");
    expect(result.totalSteps).toBe(0);
  });
});
