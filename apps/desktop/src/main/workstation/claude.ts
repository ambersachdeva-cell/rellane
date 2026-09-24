/** Keep Claude's native session and every file decision under the reviewed operation. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { nativeChildEnv } from "./env.js";
import { reviewClaudeFileAction, type ClaudeFileReview } from "./claude-file-tools.js";
import type { NativeEvent, NativeWorker, NativeWorkerOptions, NativeWorkerResult } from "./types.js";

export type ClaudeSpawnFn = (command: string, args: readonly string[], options: {
  readonly cwd: string; readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["pipe", "pipe", "pipe"]; readonly shell: false;
}) => ChildProcess;
export interface ClaudeWorkerOptions extends NativeWorkerOptions {
  readonly spawn?: ClaudeSpawnFn;
  readonly reviewTool?: typeof reviewClaudeFileAction;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const MAX_TEXT = 1_000_000;
const MAX_LINE = 1_000_000;
const rec = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const explain = (error: unknown): string => (error instanceof Error ? error.message : "That action could not finish.").slice(0, 2000);

export function buildClaudeArgs(options: { readonly modelId?: string; readonly resumeId?: string }): readonly string[] {
  if (options.modelId !== undefined && !MODEL.test(options.modelId)) throw new Error("That Claude model identifier is invalid.");
  if (options.resumeId !== undefined && !UUID.test(options.resumeId)) throw new Error("That saved Claude session identifier is invalid.");
  return ["--print", "--safe-mode", "--restricted", "--tools", "Read,Write",
    "--settings", JSON.stringify({ permissions: { ask: ["Read", "Write"] } }),
    "--permission-mode", "default", "--permission-prompt-tool", "stdio",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(options.modelId ? ["--model", options.modelId] : []), ...(options.resumeId ? [`--resume=${options.resumeId}`] : [])];
}
interface Pending { readonly id: string; review: ClaudeFileReview | null; state: "reading" | "waiting" | "deciding" | "cancelled"; displayed: boolean; }
interface Control {
  readonly done: Promise<NativeWorkerResult>;
  decide(id: string, allow: boolean): Promise<void>;
  stop(signal: NodeJS.Signals): void;
}

export function createClaudeWorker(options: NativeWorkerOptions | ClaudeWorkerOptions): NativeWorker {
  const spawnChild = (options as ClaudeWorkerOptions).spawn ?? (spawn as unknown as ClaudeSpawnFn);
  const reviewTool = (options as ClaudeWorkerOptions).reviewTool ?? reviewClaudeFileAction;
  let active: Control | null = null;
  let disposed = false;
  let sessionId = options.resumeId ?? null;
  return {
    async run(prompt) {
      if (disposed || active) throw new Error("This Claude worker is closed or already working.");
      if (!prompt.trim() || prompt.length > 128_000) throw new Error("This Claude request is empty or too large.");
      const args = buildClaudeArgs({ ...(options.modelId !== undefined ? { modelId: options.modelId } : {}), ...(sessionId ? { resumeId: sessionId } : {}) });
      const child = spawnChild(options.executable, args, { cwd: options.cwd, env: nativeChildEnv(options.profileHome), stdio: ["pipe", "pipe", "pipe"], shell: false });
      // All listeners, timers and async reviews capture this child, never a future run's process.
      let closed = false;
      let stopping = false;
      let terminalSeen = false;
      let terminalSuccess = false;
      let initialized = false;
      let capabilitiesChecked = false;
      let promptSent = false;
      let modelId: string | undefined;
      let answer = "";
      let finalAnswer: string | null = null;
      let errorText = "";
      let stderr = "";
      let stdout = "";
      let skippingLine = false;
      let lineWarning = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let terminalTimer: ReturnType<typeof setTimeout> | undefined;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const initId = randomUUID();
      const decoder = new StringDecoder("utf8");
      const errorDecoder = new StringDecoder("utf8");
      const pending = new Map<string, Pending>();
      const seen = new Set<string>();
      const retained = new Set<ClaudeFileReview>();
      let resolveDone!: (result: NativeWorkerResult) => void;
      const done = new Promise<NativeWorkerResult>(resolve => { resolveDone = resolve; });
      const emit = (event: NativeEvent) => { if (!closed) options.onEvent(event); };
      const write = (value: unknown): boolean => {
        if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
        try { child.stdin.write(JSON.stringify(value) + "\n"); return true; } catch { return false; }
      };
      const disposeReview = async (review: ClaudeFileReview) => { await review.dispose().catch(() => undefined); };
      const reply = (id: string, decision: Readonly<Record<string, unknown>>) => write({ type: "control_response", response: { subtype: "success", request_id: id, response: decision } });
      const deny = (id: string, message: string) => reply(id, { behavior: "deny", message });
      function clearPermission(item: Pending, notify = true) {
        item.state = "cancelled"; pending.delete(item.id);
        if (item.review) { void disposeReview(item.review); item.review = null; }
        if (notify && item.displayed) emit({ type: "permission-cleared", id: item.id });
      }
      function cancelPending(message: string) {
        for (const item of [...pending.values()]) { deny(item.id, message); clearPermission(item); }
      }
      function terminate(signal: NodeJS.Signals) {
        if (closed) return;
        try { child.kill(signal); } catch { /* Close/error handles the final outcome. */ }
        if (!killTimer) {
          killTimer = setTimeout(() => { if (!closed) try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }, 1500);
          killTimer.unref?.();
        }
      }
      function fail(message: string) {
        if (closed) return;
        if (!errorText) errorText = message.slice(0, 8000);
        cancelPending("The connection could not verify this operation. Nothing further is approved.");
        terminate("SIGTERM");
      }
      const usable = (item: Pending) => !closed && !stopping && !terminalSeen && !errorText && pending.get(item.id) === item && item.state !== "cancelled";
      const control: Control = {
        done,
        stop(signal) {
          if (closed || stopping) return;
          stopping = true;
          cancelPending("This operation was stopped. Do not retry the action.");
          terminate(signal);
        },
        async decide(id, allow) {
          const item = pending.get(id);
          if (!item || !usable(item) || item.state !== "waiting" || !item.review) throw new Error("That Claude file approval is no longer waiting.");
          item.state = "deciding";
          const review = item.review;
          if (!allow) {
            if (!deny(id, "The owner declined this action. Do not retry or seek broader permission.")) { fail("Claude closed its permission channel."); throw new Error("Claude closed its permission channel."); }
            pending.delete(id); item.review = null; item.state = "cancelled";
            await disposeReview(review);
            return;
          }
          try {
            const updatedInput = await review.allow();
            if (!usable(item)) throw new Error("That file approval was cancelled before it could be applied.");
            if (!reply(id, { behavior: "allow", updatedInput })) throw new Error("Claude closed its permission channel.");
            pending.delete(id); item.review = null; item.state = "cancelled";
            // Frozen read copies must remain available until the native tool finishes.
            retained.add(review);
          } catch (error) {
            if (usable(item)) { deny(id, explain(error)); clearPermission(item); }
            await disposeReview(review);
            throw error;
          }
        }
      };
      active = control;

      function requestPermission(id: string, request: Record<string, unknown>) {
        const tool = str(request["tool_name"]);
        if (!initialized || !capabilitiesChecked || !promptSent || stopping || terminalSeen || errorText) { deny(id, "This operation is not ready for file tools."); return; }
        if ((tool !== "Read" && tool !== "Write") || pending.size >= 4) { deny(id, "That tool is unavailable or four reviews are already waiting."); return; }
        const item: Pending = { id, review: null, state: "reading", displayed: false };
        pending.set(id, item);
        void Promise.resolve().then(() => reviewTool(options.cwd, tool, request["input"])).then(async review => {
          if (!usable(item)) { await disposeReview(review); return; }
          item.review = review; item.state = "waiting"; item.displayed = true;
          emit({ type: "permission", id, title: review.title, detail: review.detail });
        }).catch(error => {
          if (!usable(item)) return;
          deny(id, explain(error)); clearPermission(item);
          emit({ type: "activity", text: "A file request was refused: " + explain(error) });
        });
      }
      function append(value: string) {
        const part = value.slice(0, MAX_TEXT - answer.length);
        if (part) { answer += part; emit({ type: "text", text: part }); }
      }
      function line(value: string) {
        if (closed || terminalSeen || errorText) return;
        let data: Record<string, unknown> | null;
        try { data = rec(JSON.parse(value)); } catch { return; }
        if (!data) return;
        const type = str(data["type"]);
        if (type === "control_response") {
          const response = rec(data["response"]);
          if (response?.["request_id"] !== initId) return;
          if (response["subtype"] !== "success") { fail("Claude could not initialize the permission channel."); return; }
          initialized = true;
          if (!promptSent) {
            promptSent = true;
            if (!write({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" })) fail("Claude closed before reading the request.");
          }
          return;
        }
        if (type === "control_request") {
          const id = str(data["request_id"]);
          if (!REQUEST_ID.test(id) || seen.has(id) || seen.size >= 128) { fail("Claude sent an invalid, repeated or excessive control request."); return; }
          seen.add(id);
          const request = rec(data["request"]);
          if (request?.["subtype"] === "can_use_tool") requestPermission(id, request);
          else write({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported control request." } });
          return;
        }
        if (type === "control_cancel_request") {
          const item = pending.get(str(data["request_id"]));
          if (item) clearPermission(item);
          return;
        }
        if (type === "system" && data["subtype"] === "init") {
          const tools = data["tools"], servers = data["mcp_servers"];
          if (!initialized || !Array.isArray(tools) || tools.length !== 2 || !tools.includes("Read") || !tools.includes("Write") || !Array.isArray(servers) || servers.length !== 0) {
            fail("Claude did not confirm the restricted file tools and empty MCP configuration."); return;
          }
          capabilitiesChecked = true;
          if (startupTimer) clearTimeout(startupTimer);
        }
        const reportedSession = str(data["session_id"]);
        if (reportedSession && UUID.test(reportedSession) && reportedSession !== sessionId && active === control) {
          sessionId = reportedSession; emit({ type: "session", sessionId });
        }
        const message = rec(data["message"]);
        const reportedModel = str(data["model"]) || str(message?.["model"]);
        if (reportedModel && MODEL.test(reportedModel)) modelId = reportedModel;
        const stream = type === "stream_event" ? rec(data["event"]) : data;
        const streamType = str(stream?.["type"]);
        if (streamType === "message_start" && answer && !answer.endsWith("\n\n")) append("\n\n");
        if (streamType === "content_block_delta") append(str(rec(stream?.["delta"])?.["text"]));
        else if (type === "text_delta") append(str(data["text"]));
        if (type === "result") {
          terminalSuccess = initialized && capabilitiesChecked && data["subtype"] === "success" && data["is_error"] !== true;
          finalAnswer = str(data["result"]).slice(0, MAX_TEXT);
          if (!terminalSuccess) errorText = "Claude did not complete this request successfully.";
          if (!answer && finalAnswer) append(finalAnswer);
          cancelPending("The operation has finished. No more actions are approved.");
          terminalSeen = true;
          child.stdin?.end();
          terminalTimer = setTimeout(() => { if (!closed) fail("Claude reported a result but did not finish its process."); }, 5000);
          terminalTimer.unref?.();
        }
        if (type === "error") fail(str(data["message"]) || "Claude reported an error.");
      }
      function consume(chunk: string) {
        if (closed) return;
        let from = 0;
        while (from < chunk.length) {
          const end = chunk.indexOf("\n", from);
          const part = chunk.slice(from, end < 0 ? undefined : end);
          if (!skippingLine && stdout.length + part.length <= MAX_LINE) stdout += part;
          else { stdout = ""; skippingLine = true; if (!lineWarning) { lineWarning = true; emit({ type: "activity", text: "An oversized provider message was ignored." }); } }
          if (end < 0) break;
          if (!skippingLine && stdout.trim()) line(stdout.trim());
          stdout = ""; skippingLine = false; from = end + 1;
        }
      }
      child.stdout?.on("data", (chunk: Buffer | string) => consume(typeof chunk === "string" ? chunk : decoder.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (!closed) stderr += (typeof chunk === "string" ? chunk : errorDecoder.write(chunk)).slice(0, 8000 - stderr.length);
      });
      child.stdin?.on("error", () => { if (!closed && !terminalSeen && !stopping) fail("Claude closed its input channel before finishing."); });
      child.on("error", error => fail(explain(error)));
      child.on("close", (code, signal) => {
        if (closed) return;
        consume(decoder.end());
        if (!skippingLine && stdout.trim()) line(stdout.trim());
        cancelPending("The Claude process has ended.");
        closed = true;
        for (const timer of [startupTimer, killTimer, terminalTimer]) if (timer) clearTimeout(timer);
        stderr += errorDecoder.end().slice(0, 8000 - stderr.length);
        const value = finalAnswer ?? answer;
        const completed = code === 0 && !signal && terminalSeen && terminalSuccess && !errorText && value.trim().length > 0;
        const result: NativeWorkerResult = {
          sessionId, text: value, finishReason: stopping ? "stopped" : completed ? "completed" : "failed",
          ...(modelId ? { modelId, reportedModelId: modelId } : {}),
          detail: stopping ? "Stopped. Partial text was kept; no further file actions are approved."
            : completed ? "Claude finished with the file decisions you made for this operation."
            : errorText || stderr.trim() || "Claude finished without a confirmed answer."
        };
        void Promise.allSettled([...retained].map(disposeReview)).finally(() => { if (active === control) active = null; resolveDone(result); });
      });
      emit({ type: "activity", text: "Starting Claude with individual file reviews…" });
      startupTimer = setTimeout(() => fail("Claude did not confirm its restricted connection within 20 seconds."), 20_000);
      startupTimer.unref?.();
      if (!child.stdin || !child.stdout || !child.stderr) fail("Claude did not provide the required process channels.");
      else if (!write({ type: "control_request", request_id: initId, request: { subtype: "initialize", hooks: null, skills: [] } })) fail("Claude could not start its permission channel.");
      return await done;
    },
    async decide(id, allow) { if (!active || disposed) throw new Error("No Claude operation is waiting for a decision."); await active.decide(id, allow); },
    async interrupt() {
      if (!active) return { acknowledged: false, detail: "No active Claude process to stop." };
      active.stop("SIGINT");
      return { acknowledged: false, detail: "Sent SIGINT; completion is confirmed when the process exits." };
    },
    async dispose() {
      disposed = true;
      const current = active;
      if (!current) return;
      current.stop("SIGTERM");
      await Promise.race([current.done, new Promise<void>(resolve => { const timer = setTimeout(resolve, 3000); timer.unref?.(); })]);
    }
  };
}
export type { NativeEvent, NativeWorker, NativeWorkerOptions, NativeWorkerResult };
