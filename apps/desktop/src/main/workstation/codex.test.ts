import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import {
  createCodexWorker,
  type CodexProcess,
  type CodexProcessSpawner,
  type CodexSpawnParams
} from "./codex.js";
import type { NativeEvent, NativeWorkerOptions } from "./types.js";

class MockCodexProcess extends EventEmitter implements CodexProcess {
  public writtenMessages: Record<string, unknown>[] = [];
  public rawWritten: string[] = [];
  public killed = false;
  public pid = 99999;
  public connectorStatus = "disabled";
  public stdout = new EventEmitter();
  public stderr = new EventEmitter();

  public stdin = {
    write: (chunk: string): boolean => {
      this.rawWritten.push(chunk);
      this.parseAndHandleInput(chunk);
      return true;
    },
    end: (): void => {
      // Stream ended
    }
  };

  private buffer = "";
  public onRequest?: (req: Record<string, unknown>) => void;

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit("close", 0);
    return true;
  }

  public emitJson(msg: Record<string, unknown>): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify(msg) + "\n"));
  }

  public emitRaw(raw: string): void {
    this.stdout.emit("data", Buffer.from(raw + "\n"));
  }

  private parseAndHandleInput(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          this.writtenMessages.push(parsed);
          if (parsed.method === "mcpServerStatus/list") {
            this.emitJson({ id: parsed.id, result: { data: [{ name: "fixture", runtimeStatus: this.connectorStatus }], nextCursor: null } });
            continue;
          }
          this.onRequest?.(parsed);
        } catch {
          // Ignore parse errors in mock incoming line
        }
      }
    }
  }
}

function nativeProfileResponse(req: Record<string, unknown>): Record<string, unknown> {
  const params = req.params as Record<string, unknown>;
  return {
    cwd: params.cwd,
    runtimeWorkspaceRoots: [params.cwd],
    activePermissionProfile: { id: params.permissions, extends: ":workspace" },
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    approvalPolicy: "on-request", approvalsReviewer: "user"
  };
}

function setupMockLifecycle(
  mockProc: MockCodexProcess,
  config?: {
    threadId?: string;
    turnId?: string;
    autoComplete?: boolean;
    deltas?: string[];
    modelId?: string;
    threadProof?: Record<string, unknown>;
  }
): void {
  const threadId = config?.threadId ?? "thr_test_alpha";
  const turnId = config?.turnId ?? "turn_test_1";

  mockProc.onRequest = (req) => {
    const id = req.id as string | number | undefined;
    const method = req.method as string | undefined;

    if (method === "initialize" && id !== undefined) {
      mockProc.emitJson({
        id,
        result: { userAgent: "codex-cli-test", platformFamily: "darwin" }
      });
    } else if (method === "thread/start" && id !== undefined) {
      mockProc.emitJson({
        id,
        result: {
          ...nativeProfileResponse(req),
          ...config?.threadProof,
          thread: {
            id: threadId,
            sessionId: threadId,
            modelProvider: "openai"
          },
          // Top level, as `ThreadStartResponse` declares it. `Thread.model` is
          // the last persisted value and is nullable; this is what will run.
          ...(config?.modelId ? { model: config.modelId } : {})
        }
      });
    } else if (method === "thread/resume" && id !== undefined) {
      const requestedId = (req.params as Record<string, unknown>)?.threadId as string;
      mockProc.emitJson({
        id,
        result: {
          ...nativeProfileResponse(req),
          ...config?.threadProof,
          thread: {
            id: requestedId ?? threadId,
            sessionId: requestedId ?? threadId,
            modelProvider: "openai"
          },
          ...(config?.modelId ? { model: config.modelId } : {})
        }
      });
    } else if (method === "turn/start" && id !== undefined) {
      mockProc.emitJson({
        id,
        result: {
          turn: {
            id: turnId,
            status: "inProgress",
            ...(config?.modelId ? { model: config.modelId } : {})
          }
        }
      });

      if (config?.autoComplete) {
        if (config.deltas) {
          for (const delta of config.deltas) {
            mockProc.emitJson({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: "item_agent_1",
                delta
              }
            });
          }
        }
        mockProc.emitJson({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed",
              ...(config.modelId ? { model: config.modelId } : {})
            }
          }
        });
      }
    }
  };
}

describe("Codex Native Worker Adapter", () => {
  it("handles successful stream with exact delta forwarding and proper protocol sequence", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_stream_100",
      turnId: "turn_stream_100",
      autoComplete: true,
      deltas: ["The ", "quick ", "brown ", "fox."],
      modelId: "gpt-5.6-terra"
    });

    const events: NativeEvent[] = [];
    const spawner: CodexProcessSpawner = () => mockProc;

    const worker = createCodexWorker(
      {
        executable: "/Applications/ChatGPT.app/Contents/Resources/codex",
        cwd: "/workspace/test-project",
        onEvent: (event) => events.push(event)
      },
      spawner
    );

    const result = await worker.run("Write a summary");

    expect(result.finishReason).toBe("completed");
    expect(result.sessionId).toBe("thr_stream_100");
    expect(result.text).toBe("The quick brown fox.");
    expect(result.modelId).toBe("gpt-5.6-terra");

    // Verify text events are exact deltas, not duplicated full completion text
    const textEvents = events.filter((e): e is { type: "text"; text: string } => e.type === "text");
    expect(textEvents.map((e) => e.text)).toEqual(["The ", "quick ", "brown ", "fox."]);

    // Verify session event was emitted
    const sessionEvents = events.filter((e): e is { type: "session"; sessionId: string } => e.type === "session");
    expect(sessionEvents).toEqual([{ type: "session", sessionId: "thr_stream_100" }]);

    // Verify sent JSON-RPC messages follow exact protocol sequence
    const methods = mockProc.writtenMessages.map((m) => m.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "mcpServerStatus/list", "turn/start"]);

    const init = mockProc.writtenMessages.find(message => message.method === "initialize")?.params as Record<string, unknown>;
    expect(init.capabilities).toEqual({ experimentalApi: true });
    const threadParams = mockProc.writtenMessages.find(message => message.method === "thread/start")?.params as Record<string, unknown>;
    expect(threadParams.permissions).toMatch(/^rellane_[a-f0-9]{32}$/u);
    expect(threadParams).not.toHaveProperty("sandbox");
    expect(threadParams.approvalPolicy).toBe("on-request");
    const params = mockProc.writtenMessages.find(message => message.method === "turn/start")?.params as Record<string, unknown>;
    expect(params.permissions).toBe(threadParams.permissions);
    expect(params).not.toHaveProperty("sandboxPolicy");
    expect(result.reportedModelId).toBe("gpt-5.6-terra");
  });

  it("sends no prompt when the native profile is missing, changed or wider than reviewed", async () => {
    for (const threadProof of [
      { activePermissionProfile: null },
      { activePermissionProfile: { id: ":workspace", extends: null } },
      { runtimeWorkspaceRoots: ["/workspace/test-project", "/unrelated"] },
      { approvalsReviewer: "auto_review" },
      { sandbox: { type: "dangerFullAccess" } }
    ]) {
      const proc = new MockCodexProcess();
      setupMockLifecycle(proc, { autoComplete: true, threadProof });
      const worker = createCodexWorker({ executable: "codex", cwd: "/workspace/test-project", onEvent: () => {} }, () => proc);
      const result = await worker.run("This request must stay local if limits cannot be confirmed");
      expect(result.finishReason).toBe("failed");
      expect(result.detail).toContain("Nothing was sent");
      expect(proc.writtenMessages.some(message => message.method === "turn/start")).toBe(false);
      expect(proc.writtenMessages.filter(message => message.method === "thread/start")).toHaveLength(1);
      await worker.dispose();
    }
  });

  it("claims a turn that completed before the turn/start response was read", async () => {
    // The mock answers turn/start and then emits the whole turn synchronously,
    // which is what a fast turn really does: the completion is in the buffer
    // before the awaiting caller has resumed. Recording it when it arrives is
    // what stops `run` waiting forever for something that already happened.
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_race_1",
      turnId: "turn_race_1",
      autoComplete: true,
      deltas: ["Instant."]
    });

    const worker = createCodexWorker(
      { executable: "codex", cwd: "/workspace", onEvent: () => {} },
      () => mockProc
    );

    const result = await worker.run("Answer immediately");
    expect(result.finishReason).toBe("completed");
    expect(result.text).toBe("Instant.");
  });

  it("does not send the request when it was stopped during the handshake", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, { threadId: "thr_stop_1", turnId: "turn_stop_1" });

    const worker = createCodexWorker(
      { executable: "codex", cwd: "/workspace", onEvent: () => {} },
      () => mockProc
    );

    // Stop before any thread or turn id exists. This used to answer "no active
    // turn to interrupt" and let the request go out anyway.
    const runPromise = worker.run("Do not send this");
    const interrupted = await worker.interrupt();
    expect(interrupted.acknowledged).toBe(true);

    const result = await runPromise;
    expect(result.finishReason).toBe("stopped");
    expect(mockProc.writtenMessages.some((m) => m.method === "turn/start")).toBe(false);
  });

  it("says what a permission request is asking for, and grants exactly that", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, { threadId: "thr_perm_1", turnId: "turn_perm_1" });

    const events: NativeEvent[] = [];
    const worker = createCodexWorker(
      { executable: "codex", cwd: "/workspace", onEvent: (event) => events.push(event) },
      () => mockProc
    );

    const runPromise = worker.run("Fetch something");
    await new Promise((r) => setTimeout(r, 10));

    const requested = {
      network: { enabled: true },
      fileSystem: { read: ["/Users/amber/Documents"], write: ["/Users/amber/Desktop"] }
    };
    mockProc.emitJson({
      id: 77,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thr_perm_1",
        turnId: "turn_perm_1",
        itemId: "item_perm_1",
        environmentId: null,
        startedAtMs: 1,
        cwd: "/workspace",
        reason: "I need to download the schema",
        permissions: requested
      }
    });

    const perm = events.find(
      (e): e is { type: "permission"; id: string; title: string; detail: string } =>
        e.type === "permission"
    );
    // "Some permissions" is not something anybody can consent to.
    expect(perm?.detail).toContain("network access");
    expect(perm?.detail).toContain("/Users/amber/Documents");
    expect(perm?.detail).toContain("/Users/amber/Desktop");
    expect(perm?.detail).toContain("this turn only");
    expect(perm?.title).toContain("network");

    await worker.decide("77", true);
    const response = mockProc.writtenMessages.find((m) => m.id === 77 && !("method" in m));
    // Exactly the profile that was described, and for this turn only.
    expect(response).toEqual({ id: 77, result: { permissions: requested, scope: "turn" } });

    mockProc.emitJson({
      method: "turn/completed",
      params: { threadId: "thr_perm_1", turn: { id: "turn_perm_1", status: "completed" } }
    });
    await runPromise;
  });

  it("refuses a provider request it cannot describe, including a credential refresh", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, { threadId: "thr_closed_1", turnId: "turn_closed_1" });

    const worker = createCodexWorker(
      { executable: "codex", cwd: "/workspace", onEvent: () => {} },
      () => mockProc
    );

    const runPromise = worker.run("Anything");
    await new Promise((r) => setTimeout(r, 10));

    mockProc.emitJson({
      id: 91,
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" }
    });

    const answer = mockProc.writtenMessages.find((m) => m.id === 91 && !("method" in m));
    // Credentials are the vendor's business. An unknown request is refused
    // rather than answered with a guess.
    expect(answer?.["error"]).toBeDefined();
    expect(answer?.["result"]).toBeUndefined();

    mockProc.emitJson({
      method: "turn/completed",
      params: { threadId: "thr_closed_1", turn: { id: "turn_closed_1", status: "completed" } }
    });
    await runPromise;
  });

  it("binds command execution approval to the request id and reports denied if rejected", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_approval_200",
      turnId: "turn_approval_200"
    });

    const events: NativeEvent[] = [];
    const worker = createCodexWorker(
      {
        executable: "codex",
        cwd: "/workspace/app",
        onEvent: (event) => events.push(event)
      },
      () => mockProc
    );

    const runPromise = worker.run("Run migrations");

    // Wait for turn/start to be acknowledged
    await new Promise((r) => setTimeout(r, 10));

    // Server sends command approval request with specific ID
    mockProc.emitJson({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_approval_200",
        turnId: "turn_approval_200",
        itemId: "item_cmd_1",
        command: "npm run migrate",
        reason: "Apply schema migrations"
      }
    });

    const permEvent = events.find((e): e is { type: "permission"; id: string; title: string; detail: string } => e.type === "permission");
    expect(permEvent).toBeDefined();
    expect(permEvent?.id).toBe("42");
    // The real command, not only the model's sentence about why it wants it.
    expect(permEvent?.title).toBe("Run: npm run migrate");
    expect(permEvent?.detail).toContain("Command: npm run migrate");
    expect(permEvent?.detail).toContain("Apply schema migrations");
    expect(permEvent?.detail).toContain("this request only");

    // Host decides to approve the permission
    await worker.decide("42", true);

    // Verify worker sent response bound to exact request ID
    const approvalResponse = mockProc.writtenMessages.find((m) => m.id === 42 && !("method" in m));
    expect(approvalResponse).toEqual({
      id: 42,
      result: { decision: "accept" }
    });

    // Now test a fileChange request that the host declines
    mockProc.emitJson({
      id: 43,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thr_approval_200",
        turnId: "turn_approval_200",
        itemId: "item_file_1",
        reason: "Modify config"
      }
    });

    await worker.decide("43", false);

    const fileApprovalResponse = mockProc.writtenMessages.find((m) => m.id === 43 && !("method" in m));
    expect(fileApprovalResponse).toEqual({
      id: 43,
      result: { decision: "decline" }
    });

    // Server completes the turn
    mockProc.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thr_approval_200",
        turn: { id: "turn_approval_200", status: "completed" }
      }
    });

    const result = await runPromise;
    expect(result.finishReason).toBe("denied");
    expect(result.detail).toContain("declined");
  });

  it("acknowledges turn interruption and resolves with finishReason stopped", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_interrupt_300",
      turnId: "turn_interrupt_300"
    });

    // Intercept turn/interrupt request
    const originalOnRequest = mockProc.onRequest;
    mockProc.onRequest = (req) => {
      originalOnRequest?.(req);
      if (req.method === "turn/interrupt") {
        mockProc.emitJson({
          id: req.id,
          result: {}
        });
      }
    };

    const worker = createCodexWorker(
      {
        executable: "codex",
        cwd: "/workspace/project",
        onEvent: () => {}
      },
      () => mockProc
    );

    const runPromise = worker.run("Long task");
    await new Promise((r) => setTimeout(r, 10));

    const interruptResult = await worker.interrupt();
    expect(interruptResult.acknowledged).toBe(true);
    expect(interruptResult.detail).toBe("Turn interrupt acknowledged");

    // Verify interrupt was sent with active thread and turn IDs
    const interruptMsg = mockProc.writtenMessages.find((m) => m.method === "turn/interrupt");
    expect(interruptMsg?.params).toEqual({
      threadId: "thr_interrupt_300",
      turnId: "turn_interrupt_300"
    });

    // Server emits turn/completed with status interrupted
    mockProc.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thr_interrupt_300",
        turn: { id: "turn_interrupt_300", status: "interrupted" }
      }
    });

    const result = await runPromise;
    expect(result.finishReason).toBe("stopped");
    expect(result.detail).toContain("interrupted");
  });

  it("handles malformed non-JSON lines gracefully and captures terminal turn error", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_err_400",
      turnId: "turn_err_400"
    });

    const events: NativeEvent[] = [];
    const worker = createCodexWorker(
      {
        executable: "codex",
        cwd: "/workspace",
        onEvent: (event) => events.push(event)
      },
      () => mockProc
    );

    const runPromise = worker.run("Run dangerous task");
    await new Promise((r) => setTimeout(r, 10));

    // Emit unparseable garbage output
    mockProc.emitRaw("INFO: Initializing Codex sub-system...");
    mockProc.emitRaw("DEBUG [2026-09-14] buffer allocated");

    // Verify unparseable lines generated activity event without throwing
    const activityEvents = events.filter((e): e is { type: "activity"; text: string } => e.type === "activity");
    expect(activityEvents.some((e) => e.text.includes("Unrecognized CLI output"))).toBe(true);

    // Server emits error notification followed by turn failure
    mockProc.emitJson({
      method: "error",
      params: {
        error: { message: "Organization credit quota exceeded" }
      }
    });

    mockProc.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thr_err_400",
        turn: {
          id: "turn_err_400",
          status: "failed",
          error: { message: "Organization credit quota exceeded" }
        }
      }
    });

    const result = await runPromise;
    expect(result.finishReason).toBe("failed");
    expect(result.detail).toBe("Organization credit quota exceeded");
  });

  it("resumes an existing thread using the exact resumeId without calling thread/start", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      autoComplete: true,
      deltas: ["Resumed context."]
    });

    const sessionEvents: string[] = [];
    const worker = createCodexWorker(
      {
        executable: "codex",
        cwd: "/workspace/existing",
        resumeId: "thr_persisted_session_789",
        onEvent: (event) => {
          if (event.type === "session") {
            sessionEvents.push(event.sessionId);
          }
        }
      },
      () => mockProc
    );

    const result = await worker.run("Continue previous discussion");

    expect(result.finishReason).toBe("completed");
    expect(result.sessionId).toBe("thr_persisted_session_789");
    expect(result.text).toBe("Resumed context.");
    expect(sessionEvents).toEqual(["thr_persisted_session_789"]);

    // Verify thread/resume was called with the exact resumeId and thread/start was NOT called
    const resumeMsg = mockProc.writtenMessages.find((m) => m.method === "thread/resume");
    expect(resumeMsg).toBeDefined();
    expect((resumeMsg?.params as Record<string, unknown>).threadId).toBe("thr_persisted_session_789");

    const startMsg = mockProc.writtenMessages.find((m) => m.method === "thread/start");
    expect(startMsg).toBeUndefined();
  });

  it("dynamically updates actual model when server reroutes or supplies actual model", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_model_500",
      turnId: "turn_model_500"
    });

    const worker = createCodexWorker(
      {
        executable: "codex",
        cwd: "/workspace",
        modelId: "gpt-5.6-terra",
        onEvent: () => {}
      },
      () => mockProc
    );

    const runPromise = worker.run("Complex reasoning task");
    await new Promise((r) => setTimeout(r, 10));

    // Server notifies that model was rerouted to a high-effort variant
    mockProc.emitJson({
      method: "model/rerouted",
      params: {
        fromModel: "gpt-5.6-terra",
        toModel: "gpt-5.6-terra-high-reasoning",
        reason: "Capacity shift"
      }
    });

    mockProc.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thr_model_500",
        turn: { id: "turn_model_500", status: "completed" }
      }
    });

    const result = await runPromise;
    expect(result.modelId).toBe("gpt-5.6-terra-high-reasoning");
  });

  it("cleans up process safely on dispose and fails pending approvals closed", async () => {
    const mockProc = new MockCodexProcess();
    setupMockLifecycle(mockProc, {
      threadId: "thr_dispose_600",
      turnId: "turn_dispose_600"
    });

    const worker = createCodexWorker(
      {
        executable: "codex",
        cwd: "/workspace",
        onEvent: () => {}
      },
      () => mockProc
    );

    const runPromise = worker.run("Unfinished task");
    await new Promise((r) => setTimeout(r, 10));

    // Approval request arrives
    mockProc.emitJson({
      id: 888,
      method: "item/commandExecution/requestApproval",
      params: { command: "dangerous_action" }
    });

    // Dispose while turn is in-flight
    await worker.dispose();

    // Process killed with SIGTERM
    expect(mockProc.killed).toBe(true);

    // Pending approval answered with decline
    const declineMsg = mockProc.writtenMessages.find((m) => m.id === 888);
    expect(declineMsg).toEqual({ id: 888, result: { decision: "decline" } });

    const result = await runPromise;
    expect(result.finishReason).toBe("stopped");
  });
});


it("refuses to send the prompt when the native thread still has an active connector", async () => {
  const process = new MockCodexProcess();
  process.connectorStatus = "connected";
  setupMockLifecycle(process, { autoComplete: true });
  const worker = createCodexWorker({ executable: "/fixture/codex", cwd: "/fixture/work", onEvent: () => {} }, () => process);
  const result = await worker.run("Private reviewed prompt");
  expect(result.finishReason).toBe("failed");
  expect(result.detail).toContain("Nothing was sent");
  expect(process.writtenMessages.some(message => message.method === "turn/start")).toBe(false);
  expect(process.rawWritten.join("")).not.toContain("Private reviewed prompt");
  await worker.dispose();
});
