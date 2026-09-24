/** Native control decisions must carry exactly one review and die with their process. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createClaudeWorker, buildClaudeArgs, type ClaudeWorkerOptions } from "./claude.js";
import type { ClaudeFileReview } from "./claude-file-tools.js";
import type { NativeEvent } from "./types.js";

const SESSION = "f54f3eb0-a29d-4704-a841-71302d6b7d9a";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function review(): ClaudeFileReview {
  return { title: "Share brief.md?", detail: "/chosen/brief.md\nExact reviewed text.",
    allow: vi.fn(async () => ({ file_path: "/chosen/.frozen/brief.md" })), dispose: vi.fn(async () => {}) };
}
function harness(reviewTool: NonNullable<ClaudeWorkerOptions["reviewTool"]> = async () => review()) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: NodeJS.Signals) => true)
  });
  const sent: Record<string, unknown>[] = [];
  const events: NativeEvent[] = [];
  child.stdin.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n")) sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const spawn = vi.fn(() => child as unknown as ChildProcess);
  const worker = createClaudeWorker({ executable: "/dummy/claude", cwd: "/chosen", modelId: "opus",
    onEvent: event => events.push(event), spawn, reviewTool });
  const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  function ready(tools: unknown = ["Read", "Write"], servers: unknown = []) {
    emit({ type: "control_response", response: { subtype: "success", request_id: sent[0]?.["request_id"] } });
    emit({ type: "system", subtype: "init", tools, mcp_servers: servers, session_id: SESSION, model: "claude-opus-5" });
  }
  const ask = (id: string, tool = "Read") => emit({ type: "control_request", request_id: id,
    request: { subtype: "can_use_tool", tool_name: tool, input: { file_path: "/chosen/brief.md" } } });
  const close = (code: number | null = 0, signal: string | null = null) => child.emit("close", code, signal);
  const finish = (result: unknown = { type: "result", subtype: "success", is_error: false, result: "Done." }) => { emit(result); close(); };
  const decisions = () => sent.filter(item => item["type"] === "control_response");
  return { worker, child, sent, events, spawn, ready, ask, close, finish, emit, decisions };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("Claude native file reviews", () => {
  it("forces Read and Write to ask with no inherited tools, then sends the prompt through initialized stdin", async () => {
    const args = buildClaudeArgs({ modelId: "opus", resumeId: SESSION });
    expect(args).toContain(`--resume=${SESSION}`);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Write");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ permissions: { ask: ["Read", "Write"] } });
    expect(args).toEqual(expect.arrayContaining(["--restricted", "--safe-mode", "--no-chrome", "--permission-prompt-tool", "stdio"]));
    expect(args.join(" ")).not.toMatch(/bypass|skip-permissions|acceptEdits/);
    expect(() => buildClaudeArgs({ resumeId: "--permission-mode=bypassPermissions" })).toThrow(/invalid/);
    expect(() => buildClaudeArgs({ modelId: "--unsafe" })).toThrow(/invalid/);
    const old = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "synthetic-test-only";
    try {
      const h = harness(); const run = h.worker.run("PRIVATE exact request ₹125");
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.["type"]).toBe("control_request");
      h.ready();
      expect(h.sent.filter(item => item["type"] === "user")).toEqual([
        { type: "user", message: { role: "user", content: "PRIVATE exact request ₹125" }, parent_tool_use_id: null, session_id: "" }
      ]);
      const call = h.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(call[1].join(" ")).not.toContain("PRIVATE");
      expect(call[2].env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("synthetic-test-only");
      h.finish(); expect((await run).finishReason).toBe("completed");
    } finally { if (old === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = old; }
  });

  it("keeps a reviewed read copy until process exit and never adds persistent permissions", async () => {
    const item = review(); const h = harness(async () => item); const run = h.worker.run("Read the brief");
    h.ready(); h.ask("read-1"); await flush();
    expect(h.events).toContainEqual({ type: "permission", id: "read-1", title: item.title, detail: item.detail });
    await h.worker.decide("read-1", true);
    expect(h.decisions()).toEqual([{ type: "control_response", response: { subtype: "success", request_id: "read-1",
      response: { behavior: "allow", updatedInput: { file_path: "/chosen/.frozen/brief.md" } } } }]);
    expect(item.dispose).not.toHaveBeenCalled();
    await expect(h.worker.decide("read-1", true)).rejects.toThrow(/no longer waiting/);
    h.finish(); const result = await run;
    expect(result).toMatchObject({ finishReason: "completed", sessionId: SESSION, modelId: "claude-opus-5" });
    expect(item.dispose).toHaveBeenCalledOnce();
  });

  it("declines without preparing an allowed action and refuses unknown or uninitialized tools", async () => {
    const item = review(); const reviewer = vi.fn(async () => item); const h = harness(reviewer);
    const run = h.worker.run("Read then write");
    h.ask("too-early"); h.ready(); h.ask("shell", "Bash"); h.ask("decline"); await flush();
    await h.worker.decide("decline", false);
    expect(reviewer).toHaveBeenCalledOnce(); expect(item.allow).not.toHaveBeenCalled();
    expect(h.decisions().map(value => JSON.stringify(value)).every(value => value.includes('"behavior":"deny"'))).toBe(true);
    expect(h.decisions()).toHaveLength(3);
    h.finish(); await run;
  });

  it("Stop prevents an in-flight Allow from sending after cancellation, and retains process ownership until exit", async () => {
    const approval = deferred<Readonly<Record<string, unknown>>>(); const item = review();
    item.allow = () => approval.promise;
    const h = harness(async () => item); const run = h.worker.run("Work"); h.ready(); h.ask("slow"); await flush();
    const decision = h.worker.decide("slow", true);
    const rejected = expect(decision).rejects.toThrow(/cancelled/);
    const stop = await h.worker.interrupt();
    expect(stop.acknowledged).toBe(false); expect(h.child.kill).toHaveBeenCalledWith("SIGINT");
    approval.resolve({ file_path: "/chosen/.frozen/brief.md" }); await rejected;
    expect(JSON.stringify(h.decisions())).not.toContain('"behavior":"allow"');
    expect(h.events).toContainEqual({ type: "permission-cleared", id: "slow" });
    await expect(h.worker.run("Another request")).rejects.toThrow(/already working/);
    h.close(null, "SIGINT"); expect((await run).finishReason).toBe("stopped");
  });

  it("withdraws only the cancelled review and ignores a late file-preview completion", async () => {
    const pending = deferred<ClaudeFileReview>(); const item = review();
    const h = harness(() => pending.promise); const run = h.worker.run("Work"); h.ready(); h.ask("late"); await flush();
    h.emit({ type: "control_cancel_request", request_id: "late" }); pending.resolve(item); await flush();
    expect(h.events.filter(event => event.type === "permission")).toEqual([]);
    expect(item.dispose).toHaveBeenCalledOnce();
    await expect(h.worker.decide("late", true)).rejects.toThrow(/no longer waiting/);
    h.finish(); await run;
  });

  it("denies a stale changed-file approval and clears its displayed request", async () => {
    const item = review(); item.allow = async () => { throw new Error("The file changed after review"); };
    const h = harness(async () => item); const run = h.worker.run("Work"); h.ready(); h.ask("changed"); await flush();
    await expect(h.worker.decide("changed", true)).rejects.toThrow(/file changed/);
    expect(JSON.stringify(h.decisions())).toContain('"behavior":"deny"');
    expect(h.events).toContainEqual({ type: "permission-cleared", id: "changed" });
    h.finish(); await run;
  });

  it.each([undefined, ["Read"], ["Read", "Write", "Bash"]])("fails closed for unexpected tools: %j", async tools => {
    const h = harness(); const run = h.worker.run("Work"); h.ready(tools === undefined ? null : tools);
    h.finish(); expect((await run).finishReason).toBe("failed"); expect(h.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([undefined, "error_max_turns", "unknown"])("cannot turn an unconfirmed result into success: %j", async subtype => {
    const h = harness(); const run = h.worker.run("Work"); h.ready();
    h.finish({ type: "result", subtype, result: "Some text" }); expect((await run).finishReason).toBe("failed");
  });

  it("keeps split UTF-8 text once, records the real session, and requires a successful terminal result", async () => {
    const h = harness(); const run = h.worker.run("Work"); h.ready();
    const data = Buffer.from(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "₹125 — ready" } } }) + "\n");
    const cut = data.indexOf(Buffer.from("₹")) + 1;
    h.child.stdout.write(data.subarray(0, cut)); h.child.stdout.write(data.subarray(cut));
    h.finish({ type: "result", subtype: "success", result: "₹125 — ready" });
    expect((await run).text).toBe("₹125 — ready");
    expect(h.events.filter(event => event.type === "text")).toEqual([{ type: "text", text: "₹125 — ready" }]);
    const next = h.worker.run("Continue");
    const call = h.spawn.mock.calls[1] as unknown as [string, string[]]; expect(call[1]).toContain(`--resume=${SESSION}`);
    h.close(); expect((await next).finishReason).toBe("failed");
  });

  it("separates assistant messages without changing streamed bytes inside a message", async () => {
    const h = harness(); const run = h.worker.run("Read then write"); h.ready();
    h.emit({ type: "stream_event", event: { type: "message_start" } });
    h.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "First update." } } });
    h.emit({ type: "stream_event", event: { type: "message_start" } });
    h.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Second update." } } });
    h.finish(); const result = await run;
    expect(h.events.filter(event => event.type === "text").map(event => event.text).join("")).toBe("First update.\n\nSecond update.");
    expect(result.reportedModelId).toBe("claude-opus-5");
  });

  it("bounds a whole oversized line, ignores its fake tool, and bounds provider errors", async () => {
    const reviewer = vi.fn(async () => review()); const h = harness(reviewer); const run = h.worker.run("Work"); h.ready();
    h.child.stdout.write(JSON.stringify({ type: "control_request", request_id: "huge", padding: "x".repeat(1_000_000), request: { subtype: "can_use_tool", tool_name: "Write" } }) + "\n");
    h.child.stderr.write("x".repeat(20_000)); h.close(1);
    expect(reviewer).not.toHaveBeenCalled(); const result = await run;
    expect(result.finishReason).toBe("failed"); expect(result.detail?.length).toBe(8000);
  });

  it("escalates a stalled handshake on the same child without calling it completion", async () => {
    vi.useFakeTimers(); const h = harness(); const run = h.worker.run("Work");
    await vi.advanceTimersByTimeAsync(20_000); expect(h.child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1500); expect(h.child.kill).toHaveBeenCalledWith("SIGKILL");
    h.close(null, "SIGKILL"); expect((await run).detail).toContain("within 20 seconds");
  });
});
