/**
 * Codex uses its native App Server and a fresh, scoped permission profile.
 * Commands may read/write the selected workspace and read minimal runtime files.
 * Outside access, network and unsupported tools are never silently enabled.
 * The actual profile, roots and approval routing are checked before turn/start.
 * Experimental protocol fields select and verify that profile, and — only when
 * the host hands over a reviewed tool scope — register that scope's dynamic
 * tools on a fresh thread. Those tools carry no authority of their own: each
 * call is described and approved through the same per-request review as a
 * command or a file change, and the broker can reach nothing the reviewer did
 * not already select. Resuming a thread with tools is refused outright, because
 * a native thread keeps its tool definitions and would outlive that review.
 * Unsupported native versions fail closed.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { codexWorkspaceProfileArg, verifyCodexWorkspaceProfile } from "./codex-access.js";
import { codexPolicyArgs } from "./codex-policy.js";
import { nativeChildEnv } from "./env.js";
import type { NativeToolResult } from "./native-tools.js";
import type { ToolCallOutcome } from "./tool-ledger.js";
import type {
  NativeEvent,
  NativeWorker,
  NativeWorkerOptions,
  NativeWorkerResult
} from "./types.js";

export interface CodexProcessStream {
  on(event: string, listener: (chunk: Buffer | string) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface CodexProcess {
  readonly stdin: {
    write(chunk: string): boolean;
    end(): void;
  };
  readonly stdout: CodexProcessStream;
  readonly stderr?: CodexProcessStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readonly killed?: boolean;
  readonly pid?: number | undefined;
}

export interface CodexSpawnParams {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type CodexProcessSpawner = (params: CodexSpawnParams) => CodexProcess;

export const defaultCodexProcessSpawner: CodexProcessSpawner = (params) => {
  const child = spawn(params.executable, [...params.args], {
    cwd: params.cwd,
    env: params.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal),
    on: (event, listener) => {
      child.on(event, listener as (...args: unknown[]) => void);
    },
    get killed() {
      return child.killed;
    },
    get pid() {
      return child.pid;
    }
  };
};

/** One unbroken line of output cannot be allowed to grow without limit. */
const MAX_LINE_CHARS = 1_000_000;
/** Nor can one answer. Past this the transcript is truncated and says so. */
const MAX_ANSWER_CHARS = 1_000_000;
const MAX_STDERR_CHARS = 32 * 1024;
/** How long to wait for a killed process before escalating to SIGKILL. */
const KILL_GRACE_MS = 500;
/**
 * What one tool exchange may weigh, in each direction.
 *
 * Stated here rather than imported so this adapter keeps a type-only
 * relationship with the broker module: a session with no tools must not pull
 * the skill catalogue into its module graph. The broker enforces the same
 * ceiling on its own output; agreeing twice is the point.
 */
const MAX_TOOL_BYTES = 65_536;
/** The session ceiling, mirrored from the broker for the same reason. */
const MAX_TOOL_CALLS = 64;
/** How much of an argument payload is worth showing in a review. */
const MAX_TOOL_ARGUMENT_PREVIEW = 2_000;
/** Answered server-request ids kept, so a repeat cannot be answered twice. */
const MAX_ANSWERED_IDS = 512;

/**
 * Ambient outbound reach, turned off for this thread.
 *
 * `web_search` is a real config key with a real "disabled" value. It is sent as
 * a thread-scoped override so the owner's own `config.toml` is never rewritten.
 * A server that rejects these restrictions cannot start this connection.
 * Permission boundaries are never removed to make an older server accept a request.
 */
const SAFE_THREAD_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  web_search: "disabled"
});

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** A permission request, kept exactly as it was shown to the owner. */
interface PendingApproval {
  readonly requestId: string | number;
  readonly method: string;
  /** For a permissions request: precisely the profile that was described. */
  readonly grant: Record<string, unknown> | null;
  /**
   * For a tool call: the call as it arrived, captured at review time.
   *
   * Held rather than re-read from the message later, so what runs is what was
   * described. The turn it belonged to travels with it: a decision that lands
   * after the turn moved on is answered, not executed.
   */
  readonly toolCall?: {
    readonly callId: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly turnId: string;
  };
}

/** Thrown to unwind out of the handshake when the owner stopped it. */
class StoppedBeforeSend extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "StoppedBeforeSend";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asPathList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * What a permissions request is actually asking for, in one sentence.
 *
 * This is the difference between "the model would like some permissions" and
 * "it wants to write to /Users/you/Documents and reach the network". The first
 * is not something anybody can consent to.
 */
export function describeRequestedPermissions(params: Record<string, unknown>): string {
  const profile = asRecord(params["permissions"]);
  if (profile === null) return "No permission detail was supplied; nothing can be granted from this.";

  const parts: string[] = [];
  const network = asRecord(profile["network"]);
  if (network !== null && network["enabled"] === true) parts.push("network access");

  const fileSystem = asRecord(profile["fileSystem"]);
  if (fileSystem !== null) {
    const read = asPathList(fileSystem["read"]);
    const write = asPathList(fileSystem["write"]);
    if (read.length > 0) parts.push(`read: ${read.join(", ")}`);
    if (write.length > 0) parts.push(`write: ${write.join(", ")}`);
    const entries = fileSystem["entries"];
    if (Array.isArray(entries) && entries.length > 0)
      parts.push(`${entries.length} further filesystem rule${entries.length === 1 ? "" : "s"}`);
  }

  const cwd = asString(params["cwd"]);
  const reason = asString(params["reason"]);
  const asked = parts.length === 0 ? "no additional access" : parts.join("; ");
  return [
    `Asking for ${asked}.`,
    cwd === null ? null : `Working directory: ${cwd}.`,
    reason === null ? null : `It says: ${reason}`,
    "Allowing applies to this turn only."
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

class CodexWorkerImpl implements NativeWorker {
  private readonly options: NativeWorkerOptions;
  private readonly permissionProfileId = `rellane_${randomUUID().replaceAll("-", "")}`;
  private readonly spawner: CodexProcessSpawner;
  private process: CodexProcess | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private accumulatedText = "";
  private answerTruncated = false;
  private activeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private activeSessionId: string | null = null;
  private actualModelId: string | undefined;
  private lineBuffer = "";
  private skippingOversizedLine = false;
  private stderrBuffer = "";
  private turnDeferred: {
    resolve: (result: NativeWorkerResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  /**
   * A completion that arrived before anybody was waiting for it.
   *
   * `turn/completed` is a notification on the same stream as the `turn/start`
   * response, so a fast turn can finish inside the same chunk. Holding it here
   * is what stops `run` from waiting forever on a turn that is already over.
   */
  private earlyResult: NativeWorkerResult | null = null;
  private hadDeniedApproval = false;
  private interrupted = false;
  private stopRequested = false;
  private running = false;
  private exited = false;
  private disposed = false;
  /** Tool call ids already seen this session. A replay is never a second run. */
  private readonly seenToolCallIds = new Set<string>();
  /** Server request ids already answered, so a repeat cannot be answered twice. */
  private readonly answeredRequestIds = new Set<string>();
  private toolCallCount = 0;

  constructor(options: NativeWorkerOptions, spawner: CodexProcessSpawner = defaultCodexProcessSpawner) {
    this.options = options;
    this.spawner = spawner;
    this.actualModelId = options.modelId;
  }

  public async run(prompt: string): Promise<NativeWorkerResult> {
    if (this.disposed) return this.result("failed", "Worker is disposed");
    if (this.running) return this.result("failed", "Worker is already running an active turn");
    // Refused here, before a process exists: a native thread keeps the tool
    // definitions it was started with, so resuming one would attach this
    // reviewed source scope to definitions nobody reviewed for it.
    if (this.options.tools !== undefined && this.options.resumeId !== undefined)
      return this.result(
        "failed",
        "Reviewed tools need a fresh native session. This work already has a saved session to continue, so nothing was sent. Start new work to use tools."
      );

    this.running = true;
    this.accumulatedText = "";
    this.answerTruncated = false;
    this.hadDeniedApproval = false;
    this.interrupted = false;
    this.stopRequested = false;
    this.earlyResult = null;
    this.seenToolCallIds.clear();
    this.answeredRequestIds.clear();
    this.toolCallCount = 0;

    try {
      await this.startProcess();

      await this.sendRequest("initialize", {
        clientInfo: { name: "cadrane", title: "Cadrane Workstation", version: "0.1.0" },
        // Required for named permission profiles, and for the reviewed dynamic
        // tools registered on a fresh thread when — and only when — the host
        // supplied a scope somebody opted into at review.
        capabilities: { experimentalApi: true }
      });
      this.assertNotStopped();
      this.sendNotification("initialized", {});
      this.assertNotStopped();

      await this.openThread();
      this.assertNotStopped();

      await this.verifyConnectorIsolation();
      this.assertNotStopped();

      await this.startTurn(prompt);

      // Claim a completion that landed while the response was still in flight.
      const early = this.earlyResult;
      if (early !== null) {
        this.earlyResult = null;
        return early;
      }
      if (this.exited) return this.processEndedResult();

      return await new Promise<NativeWorkerResult>((resolve, reject) => {
        this.turnDeferred = { resolve, reject };
      });
    } catch (err: unknown) {
      if (err instanceof StoppedBeforeSend) return this.result("stopped", err.message);
      const message = err instanceof Error ? err.message : String(err);
      return this.result(this.stopRequested ? "stopped" : "failed", message);
    } finally {
      this.running = false;
      this.turnDeferred = null;
    }
  }

  public async decide(permissionId: string, allow: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(permissionId);
    if (!pending) {
      throw new Error(`No pending approval found for permission ID: ${permissionId}`);
    }
    this.pendingApprovals.delete(permissionId);

    if (pending.method === "item/tool/call") {
      await this.settleToolCall(pending, allow);
      return;
    }

    // Only a real refusal ends the turn as denied. A declined tool call is not
    // one: the model is told "no" in the tool's own answer and can finish
    // without it, and calling that a denied turn would report a completed
    // answer as a failure.
    if (!allow) this.hadDeniedApproval = true;

    let result: Record<string, unknown>;
    if (
      pending.method === "item/commandExecution/requestApproval" ||
      pending.method === "item/fileChange/requestApproval"
    ) {
      // "accept", never "acceptForSession": consent here is for this request.
      result = { decision: allow ? "accept" : "decline" };
    } else if (pending.method === "item/permissions/requestApproval") {
      // Exactly the profile that was described in the review, and only for this
      // turn. Echoing whatever the server asked for without having said what it
      // was would be a grant nobody read.
      result = {
        permissions: allow && pending.grant !== null ? pending.grant : {},
        scope: "turn"
      };
    } else {
      result = { decision: "decline" };
    }

    this.sendMessage({ id: pending.requestId, result });
  }

  public async interrupt(): Promise<{ acknowledged: boolean; detail: string }> {
    if (this.disposed) {
      return { acknowledged: false, detail: "Worker is disposed" };
    }

    // Recorded first, and before any check for an active turn. A stop pressed
    // while the handshake is still running used to be answered "no active turn"
    // and then the turn went out anyway.
    this.stopRequested = true;
    this.interrupted = true;

    if (!this.activeThreadId || !this.activeTurnId) {
      return {
        acknowledged: true,
        detail: "Stopped before the request was sent. Nothing was asked of the provider."
      };
    }

    try {
      await this.sendRequest("turn/interrupt", {
        threadId: this.activeThreadId,
        turnId: this.activeTurnId
      });
      return { acknowledged: true, detail: "Turn interrupt acknowledged" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { acknowledged: false, detail: `Interrupt failed: ${message}` };
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;

    // Answer the outstanding approvals *before* marking the worker disposed:
    // declining is a message that still has to go out, and a disposal that
    // simply dropped the connection would leave the server waiting on a
    // question nobody answered.
    for (const pending of this.pendingApprovals.values()) {
      try {
        // A tool call is answered in the tool's own shape. Sending a decision
        // object would be a reply the server cannot read, which is the same as
        // not answering at all.
        this.write(
          pending.method === "item/tool/call"
            ? {
                id: pending.requestId,
                result: {
                  contentItems: [
                    { type: "inputText", text: "This session ended before the tool ran. Nothing was read." }
                  ],
                  success: false
                }
              }
            : { id: pending.requestId, result: { decision: "decline" } }
        );
      } catch {
        // Stream already closed; a dropped connection reads as a decline too.
      }
    }
    this.pendingApprovals.clear();

    this.disposed = true;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("Worker disposed"));
    }
    this.pendingRequests.clear();

    this.settleTurn(this.result("stopped", "Worker disposed"));

    const proc = this.process;
    if (proc === null) return;
    this.process = null;

    try {
      proc.stdin.end();
    } catch {
      // Already closed.
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already gone.
    }

    // Gated on the process having actually exited, not on a signal having been
    // sent: `killed` only says SIGTERM was delivered, and a child that ignores
    // it would otherwise be left running with the folder open.
    const escalate = setTimeout(() => {
      if (this.exited) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    escalate.unref?.();
  }

  // ---------------------------------------------------------------- internals

  private assertNotStopped(): void {
    if (this.stopRequested)
      throw new StoppedBeforeSend("Stopped before the request was sent. Nothing was asked of the provider.");
  }

  private result(
    finishReason: NativeWorkerResult["finishReason"],
    detail: string
  ): NativeWorkerResult {
    return {
      sessionId: this.activeSessionId ?? this.options.resumeId ?? null,
      text: this.accumulatedText,
      finishReason,
      ...(this.actualModelId ? { modelId: this.actualModelId, reportedModelId: this.actualModelId } : {}),
      detail
    };
  }

  private processEndedResult(): NativeWorkerResult {
    const said = this.stderrBuffer.trim();
    // A closed stream is not a finished turn. Only `turn/completed` says that.
    return this.result(
      this.stopRequested ? "stopped" : "failed",
      said === "" ? "The Codex app-server exited before the turn finished." : said
    );
  }

  /** Starts or resumes the thread, and records the model the server chose. */
  private async openThread(): Promise<void> {
    const resumeId = this.options.resumeId;
    const base: Record<string, unknown> = {
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: this.permissionProfileId
    };
    if (this.options.modelId) base["model"] = this.options.modelId;

    const method = resumeId ? "thread/resume" : "thread/start";
    if (resumeId) {
      base["threadId"] = resumeId;
    } else {
      base["serviceName"] = "cadrane";
      const tools = this.options.tools;
      if (tools !== undefined) {
        // Function definitions only. No namespace is declared, and none is
        // accepted on the way back: a namespaced call is a call from somewhere
        // this adapter did not register.
        base["dynamicTools"] = tools.definitions.map((definition) => ({
          type: "function",
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema
        }));
      }
    }

    const response = await this.sendThreadRequest(method, base);
    verifyCodexWorkspaceProfile(response, this.permissionProfileId, this.options.cwd);
    const thread = asRecord(response["thread"]);
    const threadId = thread === null ? null : asString(thread["id"]);
    if (threadId === null) throw new Error("Codex did not return a thread id.");

    this.activeThreadId = threadId;
    this.activeSessionId = (thread === null ? null : asString(thread["sessionId"])) ?? threadId;
    // The response's own `model` is what the thread will actually use; the
    // thread record's copy is nullable and is the last persisted value.
    const model = asString(response["model"]) ?? (thread === null ? null : asString(thread["model"]));
    if (model !== null) this.actualModelId = model;

    this.options.onEvent({ type: "session", sessionId: this.activeSessionId });
  }

  /** Check the actual native thread, including configuration layers unknown to us. */
  private async verifyConnectorIsolation(): Promise<void> {
    const response = asRecord(await this.sendRequest("mcpServerStatus/list", {
      threadId: this.activeThreadId, limit: 200
    }));
    const servers = response?.["data"];
    if (!Array.isArray(servers) || response?.["nextCursor"] != null || servers.some(server =>
      asRecord(server)?.["runtimeStatus"] !== "disabled")) {
      throw new Error("Codex could not confirm that inherited connectors are disabled. Nothing was sent. Check your Codex connector configuration before trying again.");
    }
  }

  /** Unsupported sandbox or network restrictions fail closed; there is no relaxed retry. */
  private async sendThreadRequest(method: string, base: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record = asRecord(await this.sendRequest<unknown>(method, { ...base, config: { ...SAFE_THREAD_CONFIG } }));
    if (record === null) throw new Error(`Codex returned an unreadable ${method} response.`);
    return record;
  }

  private async startTurn(prompt: string): Promise<void> {
    const params: Record<string, unknown> = {
      threadId: this.activeThreadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      // Never send legacy sandboxPolicy: it would replace the restricted-read profile.
      permissions: this.permissionProfileId
    };
    if (this.options.modelId) params["model"] = this.options.modelId;

    const response = asRecord(await this.sendRequest<unknown>("turn/start", params));
    const turn = response === null ? null : asRecord(response["turn"]);
    const turnId = turn === null ? null : asString(turn["id"]);
    if (turnId !== null) this.activeTurnId = turnId;
  }

  private async startProcess(): Promise<void> {
    if (this.process) return;

    const proc = this.spawner({
      executable: this.options.executable,
      args: [...(this.spawner === defaultCodexProcessSpawner ? await codexPolicyArgs(this.options.cwd) : ["app-server"]), "-c", codexWorkspaceProfileArg(this.permissionProfileId)],
      cwd: this.options.cwd,
      env: nativeChildEnv(this.options.profileHome)
    });

    this.process = proc;
    this.exited = false;

    proc.stdout.on("data", (chunk: Buffer | string) => {
      this.consumeStdout(chunk.toString());
    });

    proc.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > MAX_STDERR_CHARS) {
        this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_CHARS);
      }
    });

    proc.on("error", (err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.options.onEvent({ type: "activity", text: `Codex process error: ${errorMsg}` });
      this.settleTurn(this.result("failed", `Process error: ${errorMsg}`));
    });

    proc.on("exit", () => {
      this.exited = true;
    });

    proc.on("close", () => {
      this.exited = true;
      if (this.lineBuffer.trim().length > 0 && !this.skippingOversizedLine) {
        const tail = this.lineBuffer.trim();
        this.lineBuffer = "";
        this.handleLine(tail);
      }
      this.lineBuffer = "";
      this.skippingOversizedLine = false;
      // Nothing can be answered down a closed stream, so nothing is left
      // waiting to be: a later decision finds no pending approval and says so,
      // rather than writing into a dead pipe.
      this.pendingApprovals.clear();
      // Only `turn/completed` produces a completed turn. A stream that simply
      // ended is an interrupted one, whatever the exit code says.
      this.settleTurn(this.processEndedResult());
    });
  }

  /**
   * Splits output into lines without letting a line grow without bound.
   *
   * A server writing megabytes with no newline — a corrupted stream, or output
   * that is not JSON-RPC at all — would otherwise be buffered in full before
   * anybody discovered it was unparseable.
   */
  private consumeStdout(chunk: string): void {
    let rest = chunk;
    while (rest.length > 0) {
      const newlineIdx = rest.indexOf("\n");
      if (newlineIdx === -1) {
        if (this.skippingOversizedLine) return;
        this.lineBuffer += rest;
        if (this.lineBuffer.length > MAX_LINE_CHARS) {
          this.lineBuffer = "";
          this.skippingOversizedLine = true;
          this.options.onEvent({
            type: "activity",
            text: "Discarded an oversized line of provider output."
          });
        }
        return;
      }

      const line = this.lineBuffer + rest.slice(0, newlineIdx);
      rest = rest.slice(newlineIdx + 1);
      this.lineBuffer = "";
      if (this.skippingOversizedLine) {
        // Resynchronise at the next newline rather than parsing a fragment.
        this.skippingOversizedLine = false;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.length > 0) this.handleLine(trimmed);
    }
  }

  private settleTurn(result: NativeWorkerResult): void {
    const deferred = this.turnDeferred;
    if (deferred !== null) {
      this.turnDeferred = null;
      deferred.resolve(result);
      return;
    }
    // Nobody is waiting yet. Keep the first outcome only: a later "the process
    // exited" must not overwrite the completion that preceded it.
    if (this.earlyResult === null && this.running) this.earlyResult = result;
  }

  /** Writes to a live process. Used by disposal, which is past the guard. */
  private write(message: Record<string, unknown>): void {
    if (!this.process) throw new Error("Codex process is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendMessage(message: Record<string, unknown>): void {
    if (this.disposed) throw new Error("Codex worker has been disposed");
    this.write(message);
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject
      });
      try {
        this.sendMessage({ method, id, params });
      } catch (err: unknown) {
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.sendMessage({ method, params });
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onEvent({
        type: "activity",
        text: `Unrecognized CLI output: ${line.slice(0, 100)}`
      });
      return;
    }

    const message = asRecord(parsed);
    if (message === null) return;
    this.handleMessage(message);
  }

  private handleMessage(message: Record<string, unknown>): void {
    if ("id" in message && !("method" in message) && ("result" in message || "error" in message)) {
      const id = message["id"] as string | number;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        const error = asRecord(message["error"]);
        if (error !== null) {
          pending.reject(new Error(asString(error["message"]) ?? "JSON-RPC request error"));
        } else {
          pending.resolve(message["result"]);
        }
      }
      return;
    }

    const method = message["method"];
    if (typeof method !== "string") return;

    if ("id" in message) {
      this.handleServerRequest(
        message["id"] as string | number,
        method,
        asRecord(message["params"]) ?? {}
      );
      return;
    }

    this.handleNotification(method, asRecord(message["params"]) ?? {});
  }

  /**
   * Answers a server request exactly once.
   *
   * The id is recorded before the write, so a server that asks the same
   * question twice gets one answer rather than two — a second reply to a
   * settled request is a protocol error wearing the shape of an approval.
   */
  private answerServerRequest(id: string | number, payload: Record<string, unknown>): void {
    const key = String(id);
    this.answeredRequestIds.add(key);
    while (this.answeredRequestIds.size > MAX_ANSWERED_IDS) {
      const oldest = this.answeredRequestIds.values().next();
      if (oldest.done) break;
      this.answeredRequestIds.delete(oldest.value);
    }
    if (this.disposed || !this.process) return;
    try {
      this.write({ id, ...payload });
    } catch {
      // Stream gone. The server sees a dropped connection, which is a refusal.
    }
  }

  private refuseToolCall(id: string | number, why: string): void {
    this.options.onEvent({ type: "activity", text: `Refused a tool call: ${why}` });
    this.answerServerRequest(id, {
      result: { contentItems: [{ type: "inputText", text: why }], success: false }
    });
  }

  /**
   * The durable half of a decided tool call.
   *
   * Emitted beside the activity line rather than instead of it: one is for the
   * person watching the session now, the other is for whoever reads the case
   * back later. A refusal and a decline are recorded exactly as loudly as a
   * call that ran, because a record that only kept the successes would be
   * worth nothing as evidence.
   */
  private recordToolCall(
    tool: string,
    callId: string,
    outcome: ToolCallOutcome,
    argumentSummary: string,
    resultBytes: number,
    detail: string
  ): void {
    this.options.onEvent({
      type: "tool",
      callId,
      tool,
      outcome,
      argumentSummary,
      resultBytes,
      detail
    });
  }

  /**
   * A decided tool call.
   *
   * Every path answers the request. A tool whose result arrives after Stop is
   * answered without its result rather than left hanging: withholding the work
   * is the point, and leaving the provider waiting on a question nobody will
   * ever answer is a separate bug that used to look like the same thing.
   */
  private async settleToolCall(pending: PendingApproval, allow: boolean): Promise<void> {
    const call = pending.toolCall;
    const tools = this.options.tools;
    if (call === undefined || tools === undefined) {
      this.refuseToolCall(pending.requestId, "This session has no reviewed tool scope.");
      return;
    }
    const summary = JSON.stringify(call.arguments).slice(0, MAX_TOOL_ARGUMENT_PREVIEW);
    if (!allow) {
      this.options.onEvent({ type: "activity", text: `Tool declined: ${call.tool}` });
      this.recordToolCall(call.tool, call.callId, "declined", summary, 0, "You declined this call.");
      this.answerServerRequest(pending.requestId, {
        result: {
          contentItems: [{ type: "inputText", text: "You declined this tool call. Nothing was read." }],
          success: false
        }
      });
      return;
    }
    if (this.stoppedOrGone()) {
      this.recordToolCall(call.tool, call.callId, "withheld", summary, 0, "Stopped before it ran.");
      this.refuseToolCall(pending.requestId, "Stopped before this tool call ran. Nothing was read.");
      return;
    }
    if (call.turnId !== this.activeTurnId) {
      this.recordToolCall(call.tool, call.callId, "refused", summary, 0, "That turn was no longer active.");
      this.refuseToolCall(pending.requestId, "That turn is no longer active. Nothing was read.");
      return;
    }

    let outcome: NativeToolResult;
    try {
      outcome = await tools.execute({
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.options.onEvent({ type: "activity", text: `Tool ${call.tool} could not finish.` });
      this.recordToolCall(call.tool, call.callId, "failed", summary, 0, message.slice(0, 400));
      this.refuseToolCall(pending.requestId, `This tool could not finish: ${message.slice(0, 400)}`);
      return;
    }

    if (this.stoppedOrGone()) {
      this.recordToolCall(call.tool, call.callId, "withheld", summary, 0, "Stopped while it was running; its result was discarded.");
      this.refuseToolCall(pending.requestId, "Stopped while this tool was running. Its result was discarded.");
      return;
    }

    let bytes = 0;
    for (const item of outcome.contentItems) bytes += Buffer.byteLength(item.text, "utf8");
    if (bytes > MAX_TOOL_BYTES) {
      this.recordToolCall(call.tool, call.callId, "refused", summary, 0, `Returned more than ${MAX_TOOL_BYTES} bytes.`);
      this.refuseToolCall(
        pending.requestId,
        `That tool returned more than ${MAX_TOOL_BYTES} bytes, so nothing was delivered. Ask for a smaller page.`
      );
      return;
    }

    this.options.onEvent({
      type: "activity",
      text: `Tool ${call.tool} ${outcome.success ? "completed" : "failed"}.`
    });
    // A tool that answered "no" still ran: the model asked, the host executed,
    // and bytes came back. "failed" here is reserved for a broker that threw.
    this.recordToolCall(call.tool, call.callId, "ran", summary, bytes, outcome.success ? "" : "The tool reported a problem.");
    this.answerServerRequest(pending.requestId, {
      result: { contentItems: outcome.contentItems, success: outcome.success }
    });
  }

  private stoppedOrGone(): boolean {
    return this.disposed || this.stopRequested || this.interrupted;
  }

  /**
   * Everything that must be true before a person is asked about a tool call.
   *
   * None of these checks is about what the tool does — the broker owns that.
   * They are about whether this call belongs to the conversation the reviewer
   * is looking at. A call from another thread, another turn, a namespace this
   * adapter never declared, or a call id already used is not a question worth
   * putting in front of anybody.
   */
  private handleToolCallRequest(id: string | number, params: Record<string, unknown>): void {
    if (this.stoppedOrGone()) {
      this.refuseToolCall(id, "This session is stopping. Nothing was read.");
      return;
    }
    const tools = this.options.tools;
    if (tools === undefined) {
      this.refuseToolCall(id, "This session has no reviewed tool scope.");
      return;
    }
    if (asString(params["threadId"]) !== this.activeThreadId) {
      this.refuseToolCall(id, "That call names a different native thread.");
      return;
    }
    const turnId = asString(params["turnId"]);
    if (turnId === null || turnId !== this.activeTurnId) {
      this.refuseToolCall(id, "That call names a turn that is not the active one.");
      return;
    }
    const namespace = params["namespace"];
    if (namespace !== null && namespace !== undefined) {
      this.refuseToolCall(id, "Namespaced tools are not registered by this session.");
      return;
    }
    const callId = asString(params["callId"]);
    if (callId === null) {
      this.refuseToolCall(id, "That call has no usable call id.");
      return;
    }
    if (this.seenToolCallIds.has(callId)) {
      this.refuseToolCall(id, `Call ${callId} was already handled. A replayed call is never run twice.`);
      return;
    }
    if (this.toolCallCount >= MAX_TOOL_CALLS) {
      this.refuseToolCall(id, `This session has reached its limit of ${MAX_TOOL_CALLS} tool calls.`);
      return;
    }
    const tool = asString(params["tool"]);
    if (tool === null || !tools.definitions.some((definition) => definition.name === tool)) {
      this.refuseToolCall(id, `This session did not register a tool called "${tool ?? ""}".`);
      return;
    }
    const args = asRecord(params["arguments"]);
    if (args === null) {
      this.refuseToolCall(id, "Tool arguments must be a JSON object.");
      return;
    }
    const shown = JSON.stringify(args);
    if (Buffer.byteLength(shown, "utf8") > MAX_TOOL_BYTES) {
      this.refuseToolCall(id, `Those tool arguments are larger than ${MAX_TOOL_BYTES} bytes.`);
      return;
    }

    this.seenToolCallIds.add(callId);
    this.toolCallCount += 1;
    // Frozen so that what is described below is what runs later: the review and
    // the execution read the same object, and nothing between them can edit it.
    const captured = Object.freeze({ ...args });
    this.pendingApprovals.set(String(id), {
      requestId: id,
      method: "item/tool/call",
      grant: null,
      toolCall: { callId, tool, arguments: captured, turnId }
    });

    this.options.onEvent({
      type: "permission",
      id: String(id),
      title: `Tool: ${tool}`,
      detail: [
        `Tool: ${tool}`,
        `Arguments: ${shown.slice(0, MAX_TOOL_ARGUMENT_PREVIEW)}${shown.length > MAX_TOOL_ARGUMENT_PREVIEW ? "…" : ""}`,
        `Call id: ${callId}`,
        "This tool can only reach the sources you already selected and the skills bundled with this app.",
        "Allowing applies to this one call."
      ].join("\n")
    });
  }

  private handleServerRequest(id: string | number, method: string, params: Record<string, unknown>): void {
    const permissionId = String(id);

    // Asked twice, answered once. An id still waiting is the same question; an
    // id already answered must not be answered again.
    if (this.pendingApprovals.has(permissionId) || this.answeredRequestIds.has(permissionId)) return;

    // Intercepted only when a reviewed scope exists. Without one this falls
    // through to the refusal below, exactly as it did before tools existed.
    if (method === "item/tool/call" && this.options.tools !== undefined) {
      this.handleToolCallRequest(id, params);
      return;
    }

    if (method === "item/commandExecution/requestApproval") {
      this.pendingApprovals.set(permissionId, { requestId: id, method, grant: null });

      const command = asString(params["command"]);
      const cwd = asString(params["cwd"]);
      const reason = asString(params["reason"]);
      const network = asRecord(params["networkApprovalContext"]);
      const host = network === null ? null : asString(network["host"]);
      const protocol = network === null ? null : asString(network["protocol"]);

      // The title is what it wants to do; the detail is where, and why it says.
      const title =
        host !== null
          ? `Reach ${host}${protocol === null ? "" : ` over ${protocol}`}`
          : command !== null
            ? `Run: ${command}`
            : "Run a command";
      const detail = [
        command === null ? null : `Command: ${command}`,
        cwd === null ? null : `Working directory: ${cwd}`,
        host === null ? null : `Network host: ${host}${protocol === null ? "" : ` (${protocol})`}`,
        reason === null ? null : `It says: ${reason}`,
        "Allowing applies to this request only."
      ]
        .filter((part): part is string => part !== null)
        .join("\n");

      this.options.onEvent({ type: "permission", id: permissionId, title, detail });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      this.pendingApprovals.set(permissionId, { requestId: id, method, grant: null });

      const reason = asString(params["reason"]);
      const grantRoot = asString(params["grantRoot"]);
      const detail = [
        grantRoot === null
          ? "Editing files in the session's folder."
          : `Asking to write under: ${grantRoot}`,
        reason === null ? null : `It says: ${reason}`,
        "Allowing applies to this request only."
      ]
        .filter((part): part is string => part !== null)
        .join("\n");

      this.options.onEvent({
        type: "permission",
        id: permissionId,
        title: grantRoot === null ? "Change files" : `Write outside the folder: ${grantRoot}`,
        detail
      });
      return;
    }

    if (method === "item/permissions/requestApproval") {
      // The profile is captured now, described now, and granted later exactly as
      // captured — so what is granted is what was read.
      const grant = asRecord(params["permissions"]);
      this.pendingApprovals.set(permissionId, { requestId: id, method, grant });

      this.options.onEvent({
        type: "permission",
        id: permissionId,
        title: summarisePermissionTitle(params),
        detail: describeRequestedPermissions(params)
      });
      return;
    }

    // Everything else fails closed, including `account/chatgptAuthTokens/refresh`
    // and an `item/tool/call` in a session that reviewed no tools: an approval
    // this adapter cannot describe is one the owner cannot give, and a request
    // to refresh a sign-in is not ours to answer at all.
    this.options.onEvent({
      type: "activity",
      text: `Refused an unsupported provider request: ${method}`
    });
    this.answerServerRequest(id, {
      error: { code: -32601, message: `Unsupported server request method: ${method}` }
    });
  }

  private appendText(delta: string): void {
    if (delta.length === 0) return;
    const room = MAX_ANSWER_CHARS - this.accumulatedText.length;
    if (room <= 0) {
      if (!this.answerTruncated) {
        this.answerTruncated = true;
        this.options.onEvent({
          type: "activity",
          text: "The answer reached its length limit; the rest was dropped."
        });
      }
      return;
    }
    const kept = delta.length > room ? delta.slice(0, room) : delta;
    this.accumulatedText += kept;
    this.options.onEvent({ type: "text", text: kept });
    if (kept.length < delta.length && !this.answerTruncated) {
      this.answerTruncated = true;
      this.options.onEvent({
        type: "activity",
        text: "The answer reached its length limit; the rest was dropped."
      });
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/started": {
        const thread = asRecord(params["thread"]);
        const threadId = thread === null ? null : asString(thread["id"]);
        if (threadId !== null) {
          this.activeThreadId = threadId;
          const sessionId = (thread === null ? null : asString(thread["sessionId"])) ?? threadId;
          this.activeSessionId = sessionId;
          this.options.onEvent({ type: "session", sessionId });
        }
        break;
      }

      case "turn/started": {
        const turn = asRecord(params["turn"]);
        const turnId = turn === null ? null : asString(turn["id"]);
        if (turnId !== null) this.activeTurnId = turnId;
        break;
      }

      case "item/agentMessage/delta": {
        const delta = params["delta"];
        if (typeof delta === "string") this.appendText(delta);
        break;
      }

      case "item/started": {
        const item = asRecord(params["item"]);
        const type = item === null ? null : asString(item["type"]);
        if (item === null || type === null) break;
        const activityText = describeItem(type, item);
        if (activityText !== null) this.options.onEvent({ type: "activity", text: activityText });
        break;
      }

      case "item/completed": {
        const item = asRecord(params["item"]);
        const type = item === null ? null : asString(item["type"]);
        if (item === null || type === null) break;
        if (type === "commandExecution" || type === "fileChange") {
          const status = asString(item["status"]) ?? "completed";
          this.options.onEvent({
            type: "activity",
            text: `${type === "fileChange" ? "File change" : "Command execution"} ${status}`
          });
        } else if (type === "exitedReviewMode") {
          this.options.onEvent({ type: "activity", text: "Exited review mode" });
        }
        break;
      }

      case "turn/diff/updated": {
        this.options.onEvent({ type: "activity", text: "Workspace diff updated" });
        break;
      }

      case "turn/plan/updated": {
        const explanation = asString(params["explanation"]);
        this.options.onEvent({
          type: "activity",
          text: explanation === null ? "Plan updated" : `Plan: ${explanation}`
        });
        break;
      }

      case "model/rerouted": {
        const toModel = asString(params["toModel"]);
        if (toModel !== null) {
          this.actualModelId = toModel;
          this.options.onEvent({ type: "activity", text: `Model rerouted to ${toModel}` });
        }
        break;
      }

      case "model/safetyBuffering/updated": {
        const model = asString(params["model"]);
        if (model !== null) this.actualModelId = model;
        break;
      }

      case "serverRequest/resolved": {
        if ("requestId" in params) this.pendingApprovals.delete(String(params["requestId"]));
        break;
      }

      case "error": {
        const errObj = asRecord(params["error"]);
        const msg = (errObj === null ? null : asString(errObj["message"])) ?? "Turn error";
        this.options.onEvent({ type: "activity", text: `Error: ${msg}` });
        break;
      }

      case "turn/completed": {
        const turn = asRecord(params["turn"]);
        const status = (turn === null ? null : asString(turn["status"])) ?? "completed";
        const errObj = turn === null ? null : asRecord(turn["error"]);

        let finishReason: NativeWorkerResult["finishReason"] = "completed";
        let detail = "Turn completed.";

        if (this.interrupted || status === "interrupted") {
          finishReason = "stopped";
          detail = "Turn interrupted.";
        } else if (this.hadDeniedApproval) {
          finishReason = "denied";
          detail = "A requested approval was declined, so the turn stopped there.";
        } else if (status === "failed") {
          finishReason = "failed";
          detail = (errObj === null ? null : asString(errObj["message"])) ?? "Turn execution failed.";
        }

        this.settleTurn(this.result(finishReason, detail));
        break;
      }
    }
  }
}

function summarisePermissionTitle(params: Record<string, unknown>): string {
  const profile = asRecord(params["permissions"]);
  if (profile === null) return "Permission request";
  const network = asRecord(profile["network"]);
  const fileSystem = asRecord(profile["fileSystem"]);
  const wantsNetwork = network !== null && network["enabled"] === true;
  const wantsFiles =
    fileSystem !== null &&
    (asPathList(fileSystem["read"]).length > 0 || asPathList(fileSystem["write"]).length > 0);
  if (wantsNetwork && wantsFiles) return "Reach the network and files outside the folder";
  if (wantsNetwork) return "Reach the network";
  if (wantsFiles) return "Reach files outside the folder";
  return "Permission request";
}

function describeItem(type: string, item: Record<string, unknown>): string | null {
  switch (type) {
    case "commandExecution":
      return `Running: ${asString(item["command"]) ?? "command"}`;
    case "fileChange":
      return "Editing workspace files";
    case "mcpToolCall":
      // Named in full: an MCP server the owner configured for their own CLI is
      // reachable from this session, and it should be visible when it is used.
      return `Connector tool call: ${asString(item["server"]) ?? "mcp"}/${asString(item["tool"]) ?? "tool"}`;
    case "dynamicToolCall":
      return `Dynamic tool: ${asString(item["tool"]) ?? "tool"}`;
    case "webSearch":
      return `Web search: ${asString(item["query"]) ?? ""}`;
    case "reasoning":
      return "Reasoning…";
    case "enteredReviewMode":
      return `Entering review: ${asString(item["review"]) ?? "changes"}`;
    case "contextCompaction":
      return "Compacting conversation history…";
    default:
      return null;
  }
}

export function createCodexWorker(
  options: NativeWorkerOptions,
  spawner: CodexProcessSpawner = defaultCodexProcessSpawner
): NativeWorker {
  return new CodexWorkerImpl(options, spawner);
}

export type { NativeEvent, NativeWorker, NativeWorkerOptions, NativeWorkerResult };
