import { randomUUID } from "node:crypto";

export interface HermesToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface HermesToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface HermesToolResponse {
  readonly callId: string;
  readonly name: string;
  readonly result: string;
  readonly isError?: boolean;
}

export interface HermesStep {
  readonly stepNumber: number;
  readonly prompt: string;
  readonly thought?: string;
  readonly toolCalls: readonly HermesToolCall[];
  readonly toolResponses: readonly HermesToolResponse[];
  readonly assistantReply: string;
}

export interface HermesLoopOptions {
  readonly maxSteps?: number;
  readonly stepTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStep?: (step: HermesStep) => void;
}

export interface HermesLoopResult {
  readonly completed: boolean;
  readonly finishReason: "completed" | "max_steps_exceeded" | "aborted" | "error";
  readonly finalAnswer: string;
  readonly totalSteps: number;
  readonly steps: readonly HermesStep[];
  readonly errorDetail?: string;
}

export function formatHermesSystemPrompt(tools: readonly HermesToolDefinition[]): string {
  const renderedTools = JSON.stringify(tools, null, 2);
  return [
    "You are a helpful assistant with access to tools. Reason step-by-step in <thought>...</thought> tags before acting.",
    "When you need to execute tools, emit one or more <tool_call> blocks using JSON:",
    "<tool_call>",
    '{"name": "tool_name", "arguments": { ... }}',
    "</tool_call>",
    "",
    "Tool results will be returned in <tool_response> blocks.",
    "",
    "Available tools:",
    "<tools>",
    renderedTools,
    "</tools>",
  ].join("\n");
}

export function parseHermesOutput(raw: string): {
  readonly thought?: string;
  readonly toolCalls: readonly HermesToolCall[];
  readonly reply: string;
} {
  const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/gi;
  const thoughts: string[] = [];
  let thoughtMatch: RegExpExecArray | null;
  while ((thoughtMatch = thoughtRegex.exec(raw)) !== null) {
    if (thoughtMatch[1] !== undefined) {
      const trimmed = thoughtMatch[1].trim();
      if (trimmed.length > 0) {
        thoughts.push(trimmed);
      }
    }
  }

  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  const toolCalls: HermesToolCall[] = [];
  let toolCallMatch: RegExpExecArray | null;
  while ((toolCallMatch = toolCallRegex.exec(raw)) !== null) {
    if (toolCallMatch[1] !== undefined) {
      const blockContent = toolCallMatch[1].trim();
      if (blockContent.length === 0) {
        continue;
      }

      try {
        const parsed = JSON.parse(blockContent) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          toolCalls.push({
            id: `call_${randomUUID()}`,
            name: "invalid_tool_call",
            arguments: {
              error: "Tool call payload must be a JSON object",
              raw: blockContent,
              __isMalformed: true,
            },
          });
          continue;
        }

        const record = parsed as Record<string, unknown>;
        const nameVal = record["name"];
        const name = typeof nameVal === "string" && nameVal.trim().length > 0
          ? nameVal.trim()
          : "invalid_tool_call";

        const idVal = record["id"];
        const id = typeof idVal === "string" && idVal.trim().length > 0
          ? idVal.trim()
          : `call_${randomUUID()}`;

        const argsVal = record["arguments"];
        const args = typeof argsVal === "object" && argsVal !== null && !Array.isArray(argsVal)
          ? (argsVal as Record<string, unknown>)
          : {};

        if (name === "invalid_tool_call") {
          toolCalls.push({
            id,
            name,
            arguments: {
              error: "Missing or invalid tool name",
              raw: blockContent,
              __isMalformed: true,
            },
          });
        } else {
          toolCalls.push({
            id,
            name,
            arguments: args,
          });
        }
      } catch (err) {
        const nameMatch = blockContent.match(/"name"\s*:\s*"([^"]+)"/);
        const name = nameMatch !== null && nameMatch[1] !== undefined && nameMatch[1].trim().length > 0
          ? nameMatch[1].trim()
          : "invalid_tool_call";
        const message = err instanceof Error ? err.message : String(err);
        toolCalls.push({
          id: `call_${randomUUID()}`,
          name,
          arguments: {
            error: `Malformed JSON in tool call: ${message}`,
            raw: blockContent,
            __isMalformed: true,
          },
        });
      }
    }
  }

  const replyWithoutThoughts = raw.replace(/<thought>[\s\S]*?<\/thought>/gi, "");
  const replyCleaned = replyWithoutThoughts.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();

  const thought = thoughts.length > 0 ? thoughts.join("\n\n") : undefined;

  return {
    ...(thought !== undefined ? { thought } : {}),
    toolCalls,
    reply: replyCleaned,
  };
}

export function formatToolResponse(response: HermesToolResponse): string {
  const payload: Record<string, unknown> = {
    callId: response.callId,
    name: response.name,
    result: response.result,
    ...(response.isError !== undefined ? { isError: response.isError } : {}),
  };
  return `<tool_response>\n${JSON.stringify(payload)}\n</tool_response>`;
}

async function executeWithTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new Error("Operation was aborted.");
  }

  let timer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Step execution timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal !== undefined) {
        abortListener = () => {
          reject(new Error("Operation was aborted."));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    return await Promise.race([action(), timeoutPromise, abortPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (signal !== undefined && abortListener !== null) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function runHermesLoop(
  userGoal: string,
  tools: readonly HermesToolDefinition[],
  executeModel: (prompt: string) => Promise<string>,
  executeTool: (call: HermesToolCall) => Promise<HermesToolResponse>,
  options?: HermesLoopOptions
): Promise<HermesLoopResult> {
  const maxSteps = options?.maxSteps ?? 10;
  const stepTimeoutMs = options?.stepTimeoutMs ?? 30_000;
  const signal = options?.signal;
  const onStep = options?.onStep;

  if (signal?.aborted) {
    return {
      completed: false,
      finishReason: "aborted",
      finalAnswer: "",
      totalSteps: 0,
      steps: [],
      errorDetail: "Operation was aborted.",
    };
  }

  const steps: HermesStep[] = [];
  const systemPrompt = formatHermesSystemPrompt(tools);
  let currentPrompt = userGoal.trim().length > 0
    ? `${systemPrompt}\n\nUser: ${userGoal}`
    : systemPrompt;
  let finalAnswer = "";

  while (steps.length < maxSteps) {
    if (signal?.aborted) {
      return {
        completed: false,
        finishReason: "aborted",
        finalAnswer,
        totalSteps: steps.length,
        steps,
        errorDetail: "Operation was aborted.",
      };
    }

    const stepNumber = steps.length + 1;
    let modelReply = "";

    try {
      modelReply = await executeWithTimeout(
        () => executeModel(currentPrompt),
        stepTimeoutMs,
        signal
      );
    } catch (err) {
      if (signal?.aborted) {
        return {
          completed: false,
          finishReason: "aborted",
          finalAnswer,
          totalSteps: steps.length,
          steps,
          errorDetail: "Operation was aborted.",
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        completed: false,
        finishReason: "error",
        finalAnswer,
        totalSteps: steps.length,
        steps,
        errorDetail: message,
      };
    }

    if (signal?.aborted) {
      return {
        completed: false,
        finishReason: "aborted",
        finalAnswer,
        totalSteps: steps.length,
        steps,
        errorDetail: "Operation was aborted.",
      };
    }

    const parsed = parseHermesOutput(modelReply);
    if (parsed.reply.length > 0) {
      finalAnswer = parsed.reply;
    } else if (modelReply.length > 0 && parsed.toolCalls.length === 0) {
      finalAnswer = modelReply;
    }

    if (parsed.toolCalls.length === 0) {
      const step: HermesStep = {
        stepNumber,
        prompt: currentPrompt,
        ...(parsed.thought !== undefined ? { thought: parsed.thought } : {}),
        toolCalls: [],
        toolResponses: [],
        assistantReply: modelReply,
      };
      steps.push(step);
      if (onStep !== undefined) {
        onStep(step);
      }

      return {
        completed: true,
        finishReason: "completed",
        finalAnswer: finalAnswer.length > 0 ? finalAnswer : (parsed.thought ?? ""),
        totalSteps: steps.length,
        steps,
      };
    }

    const toolResponses: HermesToolResponse[] = [];
    for (const call of parsed.toolCalls) {
      if (signal?.aborted) {
        break;
      }

      if (call.name === "invalid_tool_call" || call.arguments["__isMalformed"] === true) {
        const errorDetail = typeof call.arguments["error"] === "string"
          ? call.arguments["error"]
          : "Invalid tool call arguments";
        toolResponses.push({
          callId: call.id,
          name: call.name,
          result: `Error: ${errorDetail}`,
          isError: true,
        });
        continue;
      }

      try {
        const response = await executeWithTimeout(
          () => executeTool(call),
          stepTimeoutMs,
          signal
        );
        toolResponses.push(response);
      } catch (toolErr) {
        if (signal?.aborted) {
          break;
        }
        const message = toolErr instanceof Error ? toolErr.message : String(toolErr);
        toolResponses.push({
          callId: call.id,
          name: call.name,
          result: `Error executing tool: ${message}`,
          isError: true,
        });
      }
    }

    if (signal?.aborted) {
      return {
        completed: false,
        finishReason: "aborted",
        finalAnswer,
        totalSteps: steps.length,
        steps,
        errorDetail: "Operation was aborted.",
      };
    }

    const step: HermesStep = {
      stepNumber,
      prompt: currentPrompt,
      ...(parsed.thought !== undefined ? { thought: parsed.thought } : {}),
      toolCalls: parsed.toolCalls,
      toolResponses,
      assistantReply: modelReply,
    };
    steps.push(step);
    if (onStep !== undefined) {
      onStep(step);
    }

    if (steps.length >= maxSteps) {
      return {
        completed: false,
        finishReason: "max_steps_exceeded",
        finalAnswer,
        totalSteps: steps.length,
        steps,
        errorDetail: "Maximum step limit reached.",
      };
    }

    const formattedResponses = toolResponses.map(formatToolResponse).join("\n");
    currentPrompt = `${currentPrompt}\n${modelReply}\n${formattedResponses}`;
  }

  return {
    completed: false,
    finishReason: "max_steps_exceeded",
    finalAnswer,
    totalSteps: steps.length,
    steps,
    errorDetail: "Maximum step limit reached.",
  };
}
