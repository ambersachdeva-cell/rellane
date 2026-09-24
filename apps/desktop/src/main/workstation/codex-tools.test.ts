/**
 * The dynamic-tool path of the Codex adapter, against a fake app-server.
 *
 * These exercise the production adapter, not a re-implementation of it: the
 * fake process only carries JSON-RPC lines, so every decision under test —
 * registration, validation, approval routing, replay refusal, Stop — is the
 * adapter's own. No vendor binary is launched and no model is called.
 */
import { describe, expect, it } from "vitest";
import {
  createCodexWorker,
  type CodexProcess,
  type CodexProcessStream
} from "./codex.js";
import type { NativeToolCall, NativeToolResult, NativeToolSession } from "./native-tools.js";
import type { NativeEvent } from "./types.js";

class FakeStream implements CodexProcessStream {
  private readonly listeners: ((chunk: Buffer | string) => void)[] = [];
  on(event: string, listener: (chunk: Buffer | string) => void): void {
    if (event === "data") this.listeners.push(listener);
  }
  push(line: string): void {
    for (const listener of [...this.listeners]) listener(`${line}\n`);
  }
}

interface FakeOptions {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly completeImmediately?: boolean;
}

/**
 * The thread/start reply shape the adapter's own profile verifier accepts.
 * It mirrors the fixture already used by `codex.test.ts`; if the verifier
 * changes, both fixtures change together.
 */
function profileReply(params: Record<string, unknown>): Record<string, unknown> {
  return {
    cwd: params["cwd"],
    runtimeWorkspaceRoots: [params["cwd"]],
    activePermissionProfile: { id: params["permissions"], extends: ":workspace" },
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true
    },
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  };
}

class FakeCodex implements CodexProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly sent: Record<string, unknown>[] = [];
  killed = false;
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  private readonly config: FakeOptions;

  constructor(config: FakeOptions = {}) {
    this.config = config;
  }

  readonly stdin = {
    write: (chunk: string): boolean => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null) continue;
        const message = parsed as Record<string, unknown>;
        this.sent.push(message);
        this.answer(message);
      }
      return true;
    },
    end: (): void => undefined
  };

  get threadId(): string {
    return this.config.threadId ?? "thread-fake";
  }

  get turnId(): string {
    return this.config.turnId ?? "turn-fake";
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(listener);
    this.handlers.set(event, existing);
  }

  kill(): boolean {
    this.killed = true;
    this.fire("exit");
    this.fire("close");
    return true;
  }

  send(message: Record<string, unknown>): void {
    this.stdout.push(JSON.stringify(message));
  }

  toolCall(id: number, params: Record<string, unknown>): void {
    this.send({
      id,
      method: "item/tool/call",
      params: {
        threadId: this.threadId,
        turnId: this.turnId,
        namespace: null,
        ...params
      }
    });
  }

  replyFor(id: number): Record<string, unknown> | undefined {
    return this.sent.find((message) => message["id"] === id && !("method" in message));
  }

  complete(status = "completed"): void {
    this.send({
      method: "turn/completed",
      params: { threadId: this.threadId, turn: { id: this.turnId, status } }
    });
  }

  private fire(event: string): void {
    for (const listener of this.handlers.get(event) ?? []) listener();
  }

  private answer(message: Record<string, unknown>): void {
    const id = message["id"];
    const method = message["method"];
    if (typeof method !== "string" || id === undefined) return;
    const params = (message["params"] ?? {}) as Record<string, unknown>;
    if (method === "initialize") {
      this.send({ id, result: { userAgent: "fake-codex" } });
      return;
    }
    if (method === "mcpServerStatus/list") {
      this.send({ id, result: { data: [{ name: "fixture", runtimeStatus: "disabled" }], nextCursor: null } });
      return;
    }
    if (method === "thread/start" || method === "thread/resume") {
      this.send({
        id,
        result: {
          ...profileReply(params),
          thread: { id: this.threadId, sessionId: this.threadId }
        }
      });
      return;
    }
    if (method === "turn/start") {
      this.send({ id, result: { turn: { id: this.turnId, status: "inProgress" } } });
      if (this.config.completeImmediately === true) this.complete();
      return;
    }
    if (method === "turn/interrupt") this.send({ id, result: {} });
  }
}

interface FakeBroker {
  readonly session: NativeToolSession;
  readonly calls: NativeToolCall[];
  disposed: number;
}

function fakeBroker(reply?: { result?: NativeToolResult; hold?: boolean; fail?: string }): FakeBroker {
  const calls: NativeToolCall[] = [];
  let release: (() => void) | null = null;
  const broker: FakeBroker = {
    calls,
    disposed: 0,
    session: {
      definitions: [
        { name: "rellane_list_sources", description: "List reviewed sources.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        { name: "rellane_read_source", description: "Read a reviewed source.", inputSchema: { type: "object", properties: { sourceId: { type: "string" } }, required: ["sourceId"], additionalProperties: false } }
      ],
      execute: async (call: NativeToolCall): Promise<NativeToolResult> => {
        calls.push(call);
        if (reply?.hold === true) await new Promise<void>((resolve) => { release = resolve; });
        if (reply?.fail !== undefined) throw new Error(reply.fail);
        return reply?.result ?? { contentItems: [{ type: "inputText", text: `ok:${call.tool}` }], success: true };
      },
      dispose: (): void => { broker.disposed += 1; }
    }
  };
  Object.defineProperty(broker, "release", { value: () => release?.() });
  return broker;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function permissionsFrom(events: readonly NativeEvent[]): readonly { id: string; title: string; detail: string }[] {
  return events.flatMap((event) => (event.type === "permission" ? [{ id: event.id, title: event.title, detail: event.detail }] : []));
}

function activityFrom(events: readonly NativeEvent[]): readonly string[] {
  return events.flatMap((event) => (event.type === "activity" ? [event.text] : []));
}

describe("Codex adapter: reviewed dynamic tools", () => {
  it("registers the broker's definitions on a fresh thread, and registers nothing without a broker", async () => {
    const withTools = new FakeCodex({ completeImmediately: true });
    const broker = fakeBroker();
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: () => undefined },
      () => withTools
    );
    const result = await worker.run("hello");
    expect(result.finishReason).toBe("completed");

    const start = withTools.sent.find((message) => message["method"] === "thread/start");
    const params = start?.["params"] as Record<string, unknown>;
    const registered = params["dynamicTools"] as Record<string, unknown>[];
    expect(registered.map((tool) => tool["name"])).toEqual(["rellane_list_sources", "rellane_read_source"]);
    for (const tool of registered) {
      expect(tool["type"]).toBe("function");
      expect(tool).not.toHaveProperty("namespace");
      expect(typeof tool["inputSchema"]).toBe("object");
    }

    const plain = new FakeCodex({ completeImmediately: true });
    const ordinary = createCodexWorker({ executable: "codex", cwd: "/tmp/ws", onEvent: () => undefined }, () => plain);
    await ordinary.run("hello");
    const plainStart = plain.sent.find((message) => message["method"] === "thread/start");
    expect((plainStart?.["params"] as Record<string, unknown>)["dynamicTools"]).toBeUndefined();
  });

  it("refuses tools together with a resumed session, before any process is started", async () => {
    const fake = new FakeCodex();
    const broker = fakeBroker();
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", resumeId: "prior-thread", tools: broker.session, onEvent: () => undefined },
      () => fake
    );
    const result = await worker.run("continue");
    expect(result.finishReason).toBe("failed");
    expect(result.detail).toContain("fresh");
    expect(fake.sent).toHaveLength(0);
    expect(broker.calls).toHaveLength(0);
  });

  it("asks before executing, never calls the broker on a decline, and does not fail the turn", async () => {
    const fake = new FakeCodex();
    const broker = fakeBroker();
    const events: NativeEvent[] = [];
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: (event) => events.push(event) },
      () => fake
    );
    const running = worker.run("use the sources");
    await settle();

    fake.toolCall(41, { callId: "call-1", tool: "rellane_list_sources", arguments: {} });
    const asked = permissionsFrom(events);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toBe("Tool: rellane_list_sources");
    expect(asked[0]?.detail).toContain("call-1");
    expect(broker.calls).toHaveLength(0);

    await worker.decide(asked[0]!.id, false);
    expect(fake.replyFor(41)?.["result"]).toEqual({
      contentItems: [{ type: "inputText", text: "You declined this tool call. Nothing was read." }],
      success: false
    });
    expect(broker.calls).toHaveLength(0);

    fake.complete();
    const result = await running;
    // A declined optional tool call is not a declined turn: the answer stands.
    expect(result.finishReason).toBe("completed");
  });

  it("executes exactly the reviewed call once allowed, and refuses a replayed callId", async () => {
    const fake = new FakeCodex();
    const broker = fakeBroker({ result: { contentItems: [{ type: "inputText", text: "page one" }], success: true } });
    const events: NativeEvent[] = [];
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: (event) => events.push(event) },
      () => fake
    );
    const running = worker.run("read it");
    await settle();

    const args = { sourceId: "src-1", offset: 0, maxChars: 900 };
    fake.toolCall(51, { callId: "call-read", tool: "rellane_read_source", arguments: args });
    await worker.decide("51", true);

    expect(broker.calls).toEqual([{ callId: "call-read", tool: "rellane_read_source", arguments: args }]);
    expect(fake.replyFor(51)?.["result"]).toEqual({
      contentItems: [{ type: "inputText", text: "page one" }],
      success: true
    });
    expect(activityFrom(events).some((line) => line.includes("rellane_read_source completed"))).toBe(true);

    fake.toolCall(52, { callId: "call-read", tool: "rellane_read_source", arguments: args });
    expect((fake.replyFor(52)?.["result"] as Record<string, unknown>)["success"]).toBe(false);
    expect(broker.calls).toHaveLength(1);
    expect(permissionsFrom(events)).toHaveLength(1);

    fake.complete();
    await running;
  });

  it("refuses a stale thread, a stale turn, a namespace, an unknown tool and non-object arguments without asking", async () => {
    const fake = new FakeCodex();
    const broker = fakeBroker();
    const events: NativeEvent[] = [];
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: (event) => events.push(event) },
      () => fake
    );
    const running = worker.run("validate");
    await settle();

    fake.send({ id: 61, method: "item/tool/call", params: { threadId: "other-thread", turnId: fake.turnId, callId: "c1", namespace: null, tool: "rellane_list_sources", arguments: {} } });
    fake.send({ id: 62, method: "item/tool/call", params: { threadId: fake.threadId, turnId: "old-turn", callId: "c2", namespace: null, tool: "rellane_list_sources", arguments: {} } });
    fake.toolCall(63, { callId: "c3", tool: "rellane_list_sources", arguments: {}, namespace: "remote" });
    fake.toolCall(64, { callId: "c4", tool: "shell_exec", arguments: {} });
    fake.toolCall(65, { callId: "c5", tool: "rellane_list_sources", arguments: "not-an-object" });
    fake.toolCall(66, { callId: "c6", tool: "rellane_list_sources", arguments: { blob: "x".repeat(70_000) } });

    for (const id of [61, 62, 63, 64, 65, 66]) {
      expect((fake.replyFor(id)?.["result"] as Record<string, unknown>)["success"]).toBe(false);
    }
    expect(permissionsFrom(events)).toHaveLength(0);
    expect(broker.calls).toHaveLength(0);

    fake.complete();
    await running;
  });

  it("answers but does not deliver a tool result that finished after Stop", async () => {
    const fake = new FakeCodex();
    const broker = fakeBroker({ hold: true });
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: () => undefined },
      () => fake
    );
    const running = worker.run("race");
    await settle();

    fake.toolCall(71, { callId: "call-race", tool: "rellane_list_sources", arguments: {} });
    const deciding = worker.decide("71", true);
    await settle();
    await worker.interrupt();
    (broker as unknown as { release: () => void }).release();
    await deciding;

    const answer = fake.replyFor(71)?.["result"] as Record<string, unknown>;
    expect(answer["success"]).toBe(false);
    expect(JSON.stringify(answer["contentItems"])).toContain("discarded");

    fake.complete("interrupted");
    const result = await running;
    expect(result.finishReason).toBe("stopped");
  });

  it("bounds tool output and refuses an item/tool/call when no broker was reviewed", async () => {
    const big = new FakeCodex();
    const broker = fakeBroker({ result: { contentItems: [{ type: "inputText", text: "z".repeat(70_000) }], success: true } });
    const bounded = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: () => undefined },
      () => big
    );
    const runningBig = bounded.run("too much");
    await settle();
    big.toolCall(81, { callId: "call-big", tool: "rellane_list_sources", arguments: {} });
    await bounded.decide("81", true);
    expect((big.replyFor(81)?.["result"] as Record<string, unknown>)["success"]).toBe(false);
    big.complete();
    await runningBig;

    const plain = new FakeCodex();
    const ordinary = createCodexWorker({ executable: "codex", cwd: "/tmp/ws", onEvent: () => undefined }, () => plain);
    const runningPlain = ordinary.run("no tools");
    await settle();
    plain.send({ id: 91, method: "item/tool/call", params: { threadId: plain.threadId, turnId: plain.turnId, callId: "x", namespace: null, tool: "rellane_list_sources", arguments: {} } });
    const refusal = plain.replyFor(91);
    expect(refusal?.["result"]).toBeUndefined();
    expect((refusal?.["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    plain.complete();
    await runningPlain;
  });

  it("answers an outstanding tool approval when the worker is disposed", async () => {
    const fake = new FakeCodex();
    const broker = fakeBroker();
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/tmp/ws", tools: broker.session, onEvent: () => undefined },
      () => fake
    );
    const running = worker.run("dispose");
    await settle();
    fake.toolCall(95, { callId: "call-dispose", tool: "rellane_list_sources", arguments: {} });

    await worker.dispose();
    const answer = fake.replyFor(95)?.["result"] as Record<string, unknown>;
    expect(answer["success"]).toBe(false);
    expect(broker.calls).toHaveLength(0);

    const result = await running;
    expect(result.finishReason).toBe("stopped");
  });
});
