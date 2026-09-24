/**
 * Antigravity (`agy`), driven headless over stream-json.
 *
 * The protocol here is the one that was actually observed: a stdin line of
 * `{"event":"user","message":{"content":…}}`, then `init` carrying
 * `conversation_id` and the model, `step_update` carrying `text_delta`, and a
 * final `result` with `status` SUCCESS or ERROR. Headless stream-json has no
 * `control_request`/`control_response`, so there is no tool-approval channel to
 * drive and `decide` fails closed rather than pretending otherwise.
 *
 * The honesty rule this file exists to keep: **neither exit code zero nor a
 * quiet stderr proves an answer.** A turn is only `completed` when the provider
 * itself reported SUCCESS *and* there is text to show for it; anything else is
 * reported as what it was, with whatever partial text arrived kept.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { nativeChildEnv } from "./env.js";
import type {
  NativeEvent,
  NativeWorker,
  NativeWorkerOptions,
  NativeWorkerResult
} from "./types.js";

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-high";
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;
/**
 * The CLI's own ceiling and ours, kept the same on purpose.
 *
 * `--print-timeout` is what stops the child from sitting on a subscription
 * indefinitely; the local timer is the backstop for a child that ignores it.
 */
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
const PRINT_TIMEOUT_ARG = "25m";

interface AgyEventPayload {
  readonly event?: string;
  readonly type?: string;
  readonly conversation_id?: string;
  readonly session_id?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly modelId?: string;
  readonly init?: {
    readonly conversation_id?: string;
    readonly model?: string;
  };
  readonly text_delta?: string;
  readonly delta?: string;
  readonly step_type?: string;
  readonly state?: string;
  readonly step_index?: number;
  readonly step_update?: {
    readonly text_delta?: string;
    readonly step_type?: string;
    readonly state?: string;
    readonly step_index?: number;
  };
  readonly status?: string;
  readonly response?: string;
  readonly error?: string;
  readonly detail?: string;
  readonly message?: string | { readonly content?: string };
  readonly denied_actions?: readonly unknown[];
  readonly result?: {
    readonly status?: string;
    readonly response?: string;
    readonly error?: string;
    readonly denied_actions?: readonly unknown[];
  };
}

function extractActionDescription(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (typeof item === "object" && item !== null) {
    const record = item as Record<string, unknown>;
    if (typeof record["tool"] === "string") {
      return record["tool"];
    }
    if (typeof record["action"] === "string") {
      return record["action"];
    }
    if (typeof record["description"] === "string") {
      return record["description"];
    }
    return JSON.stringify(record);
  }
  return String(item);
}

export function createGeminiWorker(options: NativeWorkerOptions): NativeWorker {
  let activeProcess: ChildProcess | null = null;
  let activeSessionId: string | null = options.resumeId ?? null;
  let activeModelId: string = options.modelId ?? DEFAULT_GEMINI_MODEL;
  let isDisposed = false;
  let isInterrupted = false;
  let isRunning = false;

  const run = async (prompt: string): Promise<NativeWorkerResult> => {
    if (isDisposed) {
      return {
        sessionId: activeSessionId,
        text: "",
        finishReason: "failed",
        modelId: activeModelId,
        detail: "Worker has been disposed."
      };
    }
    if (isRunning) {
      return {
        sessionId: activeSessionId,
        text: "",
        finishReason: "failed",
        modelId: activeModelId,
        detail: "Worker is already running another turn."
      };
    }

    isRunning = true;
    isInterrupted = false;

    return await new Promise<NativeWorkerResult>((resolve) => {
      const args: string[] = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        activeModelId,
        "--sandbox",
        "--mode",
        "plan",
        "--print-timeout",
        PRINT_TIMEOUT_ARG
      ];

      if (activeSessionId) {
        args.push("--conversation", activeSessionId);
      }

      // Child-scoped HOME for the profile, and the pay-per-token API key
      // fallbacks removed. The app's own environment is never modified.
      const childEnv: NodeJS.ProcessEnv = nativeChildEnv(options.profileHome);

      let child: ChildProcess;
      try {
        child = spawn(options.executable, args, {
          cwd: options.cwd,
          env: childEnv,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (spawnError) {
        isRunning = false;
        const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
        resolve({
          sessionId: activeSessionId,
          text: "",
          finishReason: "failed",
          modelId: activeModelId,
          detail: `Failed to spawn executable: ${message}`
        });
        return;
      }

      activeProcess = child;

      let stdoutBuffer = "";
      let accumulatedText = "";
      let stderrBuffer = "";
      let capturedBytes = 0;
      let outputLimitExceeded = false;
      let settled = false;

      const deniedActions: string[] = [];
      let resultStatus: "SUCCESS" | "ERROR" | null = null;
      let resultDetail: string | null = null;

      const finish = (result: NativeWorkerResult) => {
        if (settled) {
          return;
        }
        settled = true;
        isRunning = false;
        clearTimeout(timer);
        if (activeProcess === child) {
          activeProcess = null;
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 1000).unref?.();
        }
        finish({
          sessionId: activeSessionId,
          text: accumulatedText,
          finishReason: "failed",
          modelId: activeModelId,
          detail: `Execution timed out after ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s`
        });
      }, DEFAULT_TIMEOUT_MS);

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let payload: AgyEventPayload;
        try {
          payload = JSON.parse(trimmed) as AgyEventPayload;
        } catch {
          options.onEvent({
            type: "activity",
            text: `Malformed stream line: ${trimmed.slice(0, 100)}`
          });
          return;
        }

        // 1. Session initialization event
        const isInitEvent =
          payload.event === "init" ||
          payload.type === "init" ||
          payload.conversation_id !== undefined ||
          payload.init !== undefined;

        if (isInitEvent) {
          const sessId =
            payload.conversation_id ??
            payload.init?.conversation_id ??
            payload.sessionId ??
            payload.session_id;
          if (sessId && typeof sessId === "string") {
            activeSessionId = sessId;
            options.onEvent({ type: "session", sessionId: sessId });
          }

          const model = payload.model ?? payload.init?.model ?? payload.modelId;
          if (model && typeof model === "string") {
            activeModelId = model;
          }

          options.onEvent({
            type: "activity",
            text: `Connected to ${activeModelId}.`
          });
        }

        // 2. Step update and text delta event
        const isStepUpdate =
          payload.event === "step_update" ||
          payload.type === "step_update" ||
          payload.step_update !== undefined ||
          payload.text_delta !== undefined;

        if (isStepUpdate) {
          const delta =
            payload.text_delta ??
            payload.step_update?.text_delta ??
            payload.delta;

          if (typeof delta === "string" && delta.length > 0) {
            accumulatedText += delta;
            options.onEvent({ type: "text", text: delta });
          }

          const stepType = payload.step_type ?? payload.step_update?.step_type;
          const stepState = payload.state ?? payload.step_update?.state;

          if (stepType || stepState) {
            options.onEvent({
              type: "activity",
              text: stepType === "user_input" ? "Reading your request and selected context…" : stepType === "model_output" ? "Preparing the response…" : "Working on your request…"
            });
          }
        }

        if (!isStepUpdate && typeof payload.text_delta === "string" && payload.text_delta.length > 0) {
          accumulatedText += payload.text_delta;
          options.onEvent({ type: "text", text: payload.text_delta });
        }

        // 3. Result event
        const isResultEvent =
          payload.event === "result" ||
          payload.type === "result" ||
          payload.result !== undefined ||
          payload.status !== undefined;

        if (isResultEvent) {
          const status = payload.status ?? payload.result?.status;
          if (status === "SUCCESS" || status === "ERROR") {
            resultStatus = status;
          }

          const response = payload.response ?? payload.result?.response;
          if (typeof response === "string" && response.length > 0) {
            if (accumulatedText.length === 0) {
              // Nothing streamed: the final response *is* the answer.
              accumulatedText = response;
              options.onEvent({ type: "text", text: response });
            } else if (response !== accumulatedText) {
              // Deltas already carried an answer and the final text disagrees.
              // Appending would duplicate it and re-emitting would show it
              // twice, so the streamed text stands and the difference is said
              // out loud rather than resolved silently.
              options.onEvent({
                type: "activity",
                text: "The provider's final text differs from what it streamed; the streamed answer was kept."
              });
            }
          }

          const denied = payload.denied_actions ?? payload.result?.denied_actions;
          if (Array.isArray(denied) && denied.length > 0) {
            for (const item of denied) {
              deniedActions.push(extractActionDescription(item));
            }
            options.onEvent({
              type: "activity",
              text: `Tool actions denied: ${deniedActions.join(", ")}`
            });
          }

          const err =
            payload.error ??
            payload.result?.error ??
            payload.detail ??
            (typeof payload.message === "string" ? payload.message : undefined);
          if (typeof err === "string" && err.length > 0) {
            resultDetail = err;
          }
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (capturedBytes >= MAX_CAPTURED_BYTES) {
          outputLimitExceeded = true;
          if (!child.killed) {
            child.kill("SIGTERM");
          }
          return;
        }

        const remaining = MAX_CAPTURED_BYTES - capturedBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        capturedBytes += slice.length;
        if (slice.length < chunk.length) {
          outputLimitExceeded = true;
        }

        stdoutBuffer += slice.toString("utf8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrBuffer += text;
      });

      child.on("error", (error: Error) => {
        finish({
          sessionId: activeSessionId,
          text: accumulatedText,
          finishReason: "failed",
          modelId: activeModelId,
          detail: `Child process error: ${error.message}`
        });
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim().length > 0) {
          processLine(stdoutBuffer);
          stdoutBuffer = "";
        }

        if (isInterrupted) {
          finish({
            sessionId: activeSessionId,
            text: accumulatedText,
            finishReason: "stopped",
            modelId: activeModelId,
            detail: "Process was stopped by user request."
          });
          return;
        }

        if (outputLimitExceeded) {
          finish({
            sessionId: activeSessionId,
            text: accumulatedText,
            finishReason: "failed",
            modelId: activeModelId,
            detail: "Process terminated: output byte limit exceeded."
          });
          return;
        }

        if (deniedActions.length > 0) {
          // Whatever it actually wrote, and nothing invented. Manufacturing a
          // sentence about the denial here would put words into the room as if
          // the provider had written them.
          finish({
            sessionId: activeSessionId,
            text: accumulatedText,
            finishReason: "denied",
            modelId: activeModelId,
            detail: `The sandbox refused: ${deniedActions.join(", ")}. ${
              accumulatedText.trim().length > 0
                ? "The text above is what it managed without them."
                : "It wrote nothing."
            }`
          });
          return;
        }

        if (code !== 0 || resultStatus === "ERROR") {
          const detail =
            resultDetail ??
            (stderrBuffer.trim().length > 0
              ? stderrBuffer.trim()
              : `Process exited with code ${code ?? "null"}`);
          finish({
            sessionId: activeSessionId,
            text: accumulatedText,
            finishReason: "failed",
            modelId: activeModelId,
            detail
          });
          return;
        }

        if (accumulatedText.trim().length === 0) {
          finish({
            sessionId: activeSessionId,
            text: "",
            finishReason: "failed",
            modelId: activeModelId,
            detail: "The provider reported success and wrote nothing. There is no answer to save."
          });
          return;
        }

        if (resultStatus !== "SUCCESS") {
          // Exiting zero is not the provider saying it finished. A stream that
          // stopped early leaves real text behind, and it is kept — but calling
          // it a completed answer would be a guess dressed as a result.
          finish({
            sessionId: activeSessionId,
            text: accumulatedText,
            finishReason: "failed",
            modelId: activeModelId,
            detail:
              resultDetail ??
              "The session ended before the provider reported a result. The text above is what had arrived."
          });
          return;
        }

        finish({
          sessionId: activeSessionId,
          text: accumulatedText,
          finishReason: "completed",
          modelId: activeModelId,
          detail: resultDetail ?? "Turn completed successfully."
        });
      });

      const stdinPayload = JSON.stringify({
        event: "user",
        message: { content: prompt }
      }) + "\n";

      child.stdin?.on("error", () => {
        // Process may terminate before reading stdin
      });
      child.stdin?.end(stdinPayload, "utf8");
    });
  };

  const interrupt = async (): Promise<{ acknowledged: boolean; detail: string }> => {
    if (!activeProcess || activeProcess.exitCode !== null) {
      return { acknowledged: false, detail: "No active child process is running." };
    }
    isInterrupted = true;
    activeProcess.kill("SIGTERM");
    setTimeout(() => {
      // `exitCode === null` means it has not exited. `killed` only means a
      // signal was delivered, which a child is free to ignore.
      if (activeProcess && activeProcess.exitCode === null) {
        activeProcess.kill("SIGKILL");
      }
    }, 1000).unref?.();
    return {
      acknowledged: false,
      detail: "Sent SIGTERM. Headless stream-json has no interrupt acknowledgement to wait for."
    };
  };

  const decide = async (permissionId: string, _allow: boolean): Promise<void> => {
    // Gemini headless stream-json does not support control_request/control_response.
    // Unsupported protocol permissions fail closed with a useful reason.
    throw new Error(
      `Gemini headless does not support interactive tool approvals. Permission ${permissionId} failed closed.`
    );
  };

  const dispose = async (): Promise<void> => {
    isDisposed = true;
    if (activeProcess && activeProcess.exitCode === null) {
      const child = activeProcess;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 500).unref?.();
    }
    activeProcess = null;
    isRunning = false;
  };

  return {
    run,
    interrupt,
    decide,
    dispose
  };
}
