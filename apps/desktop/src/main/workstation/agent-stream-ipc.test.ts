import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkstationReview } from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installAgentStream,
  installReviewedAgentStream,
  type InstallAgentStreamOptions,
  type InstallReviewedAgentStreamOptions,
  type RawAgentStep,
  type WorkstationAgentPollResult,
  type WorkstationAgentPrepareResult,
  type WorkstationAgentStartResult,
  type WorkstationAgentStopResult
} from "./agent-stream-ipc.js";
import type { NativeAskOutcome } from "./types.js";
import { compileStoredAgentContract, computeAgentRevision } from "./agent-store-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler): void => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string): void => {
      handlers.delete(channel);
    })
  }
}));

function getHandler<TResult>(
  channel: string
): (event: IpcMainInvokeEvent, input: unknown) => Promise<TResult> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Handler not registered for channel: ${channel}`);
  }
  return handler as (event: IpcMainInvokeEvent, input: unknown) => Promise<TResult>;
}

/**
 * The owner registry calls `isDestroyed()` and subscribes to navigation on the
 * sender, so a plain object is not a stand-in for one: it throws before the
 * handler under test is reached. An EventEmitter is the smallest thing that is
 * actually a sender.
 */
function createMockEvent(senderId = 1, frameRoutingId = 1): IpcMainInvokeEvent {
  const sender = Object.assign(new EventEmitter(), { id: senderId, isDestroyed: () => false });
  const senderFrame = { routingId: frameRoutingId, processId: 1 };
  return {
    sender,
    senderFrame
  } as unknown as IpcMainInvokeEvent;
}

function createStep(index: number, thought: string): RawAgentStep {
  return {
    index,
    thought,
    toolName: null,
    toolArgs: "",
    toolResult: "",
    toolFailed: false,
    answer: "",
    startedAt: Date.now(),
    endedAt: Date.now() + 50
  };
}

describe("agent-stream-ipc", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("refuses an untrusted sender before any work is started", async () => {
    const startRun = vi.fn();
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {
        throw new Error("Untrusted sender");
      },
      startRun
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const event = createMockEvent();

    await expect(
      startHandler(event, { caseId: "case-1", goal: "Test untrusted sender" })
    ).rejects.toThrow("Untrusted sender");

    expect(startRun).not.toHaveBeenCalled();
  });

  it("refuses a second start while a run is in progress", async () => {
    let resolveRun: (() => void) | undefined;
    const runPromise = new Promise<{ readonly answer: string }>((resolve) => {
      resolveRun = () => resolve({ answer: "Finished" });
    });

    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: () => runPromise
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const event = createMockEvent();

    const firstStart = await startHandler(event, { caseId: "case-1", goal: "First run" });
    expect(firstStart.runId).toBeDefined();

    await expect(
      startHandler(event, { caseId: "case-1", goal: "Second run" })
    ).rejects.toThrow("An agent run is already in progress");

    if (resolveRun) {
      resolveRun();
    }
  });

  it("accumulates steps across successive polls", async () => {
    let capturedOnStep: ((step: RawAgentStep) => void) | undefined;
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: ({ onStep }) => {
        capturedOnStep = onStep;
        return new Promise(() => {});
      }
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const pollHandler = getHandler<WorkstationAgentPollResult>(
      IPC_CHANNELS.workstationAgentPoll
    );
    const event = createMockEvent();

    const { runId } = await startHandler(event, { caseId: "case-1", goal: "Accumulate steps" });

    expect(capturedOnStep).toBeDefined();
    capturedOnStep!(createStep(0, "First thought"));

    const poll1 = await pollHandler(event, { runId });
    expect(poll1.state).toBe("running");
    expect(poll1.steps).toHaveLength(1);
    if (poll1.steps.length > 0) {
      expect(poll1.steps[0]!.thought).toBe("First thought");
    }

    capturedOnStep!(createStep(1, "Second thought"));

    const poll2 = await pollHandler(event, { runId });
    expect(poll2.steps).toHaveLength(2);
    if (poll2.steps.length > 1) {
      expect(poll2.steps[1]!.thought).toBe("Second thought");
    }
  });

  it("aborts the signal given to startRun when stopped", async () => {
    let capturedSignal: AbortSignal | undefined;
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: ({ signal }) => {
        capturedSignal = signal;
        return new Promise(() => {});
      }
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const stopHandler = getHandler<WorkstationAgentStopResult>(
      IPC_CHANNELS.workstationAgentStop
    );
    const event = createMockEvent();

    const { runId } = await startHandler(event, { caseId: "case-1", goal: "Stop test" });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    const stopResult = await stopHandler(event, { runId });
    expect(stopResult.state).toBe("stopping");
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("reports stopped and does not throw when stopping an unknown run", async () => {
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: () => Promise.resolve({ answer: "Done" })
    };
    installAgentStream(options);

    const stopHandler = getHandler<WorkstationAgentStopResult>(
      IPC_CHANNELS.workstationAgentStop
    );
    const event = createMockEvent();

    const result = await stopHandler(event, { runId: "unknown-run-id" });
    expect(result.state).toBe("stopped");
  });

  it("emits three steps with a delay, observes step count growth on poll, and stops cleanly", async () => {
    let capturedSignal: AbortSignal | undefined;
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: ({ onStep, signal }) => {
        capturedSignal = signal;
        return new Promise<{ readonly answer: string }>((resolve) => {
          const timer1 = setTimeout(() => onStep(createStep(0, "Step 1")), 10);
          const timer2 = setTimeout(() => onStep(createStep(1, "Step 2")), 30);
          const timer3 = setTimeout(() => onStep(createStep(2, "Step 3")), 50);

          signal.addEventListener("abort", () => {
            clearTimeout(timer1);
            clearTimeout(timer2);
            clearTimeout(timer3);
            resolve({ answer: "Aborted" });
          });
        });
      }
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const pollHandler = getHandler<WorkstationAgentPollResult>(
      IPC_CHANNELS.workstationAgentPoll
    );
    const stopHandler = getHandler<WorkstationAgentStopResult>(
      IPC_CHANNELS.workstationAgentStop
    );
    const event = createMockEvent();

    const { runId } = await startHandler(event, { caseId: "case-1", goal: "Three steps test" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const poll1 = await pollHandler(event, { runId });
    expect(poll1.steps.length).toBeGreaterThanOrEqual(1);
    const initialCount = poll1.steps.length;

    await new Promise((resolve) => setTimeout(resolve, 30));
    const poll2 = await pollHandler(event, { runId });
    expect(poll2.steps.length).toBeGreaterThan(initialCount);

    await stopHandler(event, { runId });
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("refuses a poll when the window has navigated away", async () => {
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: () => new Promise(() => {})
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const pollHandler = getHandler<WorkstationAgentPollResult>(
      IPC_CHANNELS.workstationAgentPoll
    );

    const startEvent = createMockEvent(1, 1);
    const { runId } = await startHandler(startEvent, { caseId: "case-1", goal: "Window change test" });

    const navigatedEvent = createMockEvent(1, 2);
    await expect(pollHandler(navigatedEvent, { runId })).rejects.toThrow("This window changed");
  });

  it("validates input against schema limits", async () => {
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: () => Promise.resolve({ answer: "Done" })
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const event = createMockEvent();

    const excessiveGoal = "a".repeat(10_001);
    await expect(
      startHandler(event, { caseId: "case-1", goal: excessiveGoal })
    ).rejects.toThrow();

    const excessiveTurns = Array.from({ length: 51 }, (_, i) => `turn-${i}`);
    await expect(
      startHandler(event, { caseId: "case-1", goal: "Valid goal", sourceTurnIds: excessiveTurns })
    ).rejects.toThrow();
  });

  it("throws a plain error when polling an unknown run", async () => {
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: () => Promise.resolve({ answer: "Done" })
    };
    installAgentStream(options);

    const pollHandler = getHandler<WorkstationAgentPollResult>(
      IPC_CHANNELS.workstationAgentPoll
    );
    const event = createMockEvent();

    await expect(pollHandler(event, { runId: "nonexistent-id" })).rejects.toThrow(
      "This agent run is unknown. Nothing about a run survives a restart."
    );
  });

  it("retains at most three finished runs and drops the oldest", async () => {
    const options: InstallAgentStreamOptions = {
      assertTrusted: () => {},
      startRun: () => Promise.resolve({ answer: "Run completed" })
    };
    installAgentStream(options);

    const startHandler = getHandler<WorkstationAgentStartResult>(
      IPC_CHANNELS.workstationAgentStart
    );
    const pollHandler = getHandler<WorkstationAgentPollResult>(
      IPC_CHANNELS.workstationAgentPoll
    );
    const event = createMockEvent();

    const { runId: run1 } = await startHandler(event, { caseId: "c1", goal: "Run 1" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { runId: run2 } = await startHandler(event, { caseId: "c2", goal: "Run 2" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { runId: run3 } = await startHandler(event, { caseId: "c3", goal: "Run 3" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const { runId: run4 } = await startHandler(event, { caseId: "c4", goal: "Run 4" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(pollHandler(event, { runId: run1 })).rejects.toThrow("This agent run is unknown");

    const poll2 = await pollHandler(event, { runId: run2 });
    expect(poll2.state).toBe("done");

    const poll3 = await pollHandler(event, { runId: run3 });
    expect(poll3.state).toBe("done");

    const poll4 = await pollHandler(event, { runId: run4 });
    expect(poll4.state).toBe("done");
  });

  describe("reviewed agent stream", () => {
    const testOwners = new Map<string, object>();
    const testOwnerFor = (event: IpcMainInvokeEvent): object => {
      const senderId =
        "id" in event.sender && typeof (event.sender as { id: unknown }).id === "number"
          ? (event.sender as { id: number }).id
          : 1;
      const routingId = event.senderFrame?.routingId ?? 0;
      const key = `${senderId}:${routingId}`;
      let owner = testOwners.get(key);
      if (!owner) {
        owner = {};
        testOwners.set(key, owner);
      }
      return owner;
    };

    beforeEach(() => {
      testOwners.clear();
    });

    function createFakeReview(overrides?: Partial<WorkstationReview>): WorkstationReview {
      return {
        caseId: "case-1",
        providerId: "anthropic",
        providerLabel: "Anthropic",
        modelId: "claude-3-5-sonnet",
        contextPreview: "Exact reviewed prompt",
        contextSnapshotId: "snapshot-123",
        sourceHash: "sha256-abc",
        expiresAt: Date.now() + 60_000,
        token: "internal-child-token",
        ...overrides
      } as WorkstationReview;
    }

    function createFakeCompletedOutcome(turnId = "turn-1", text = "Child completed successfully"): NativeAskOutcome & { readonly turnId: string } {
      return {
        sessionId: "session-1",
        text,
        finishReason: "completed",
        requestedModelId: "claude-3-5-sonnet",
        cancellationRequested: false,
        resultSource: "worker",
        turnId
      };
    }

    it("pins a complete saved agent revision and output in the reviewed child and durable parent", async () => {
      const markdown = `# Long procedure\n${"Keep the full instruction. ".repeat(210)}`;
      const revision = computeAgentRevision("my-agent", "user", markdown);
      const contract = compileStoredAgentContract({
        agent: { id: "my-agent", origin: "user", markdown, revision },
        task: "Prepare a precise brief", expectedOutput: "A reviewed brief",
        requestedToolScopes: ["none"], expectedRevision: revision,
        maxPromptLength: 10_000
      });
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockResolvedValue(createFakeCompletedOutcome());
      const persistParent = vi.fn().mockResolvedValue(undefined);
      installReviewedAgentStream({
        assertTrusted: () => {}, ownerFor: testOwnerFor,
        resolveSavedAgent: vi.fn().mockResolvedValue(contract),
        prepareChild, runChild, persistParent,
        persistChild: vi.fn().mockResolvedValue(undefined)
      });
      const event = createMockEvent();
      const request = { caseId: "case-1", providerId: "anthropic", modelId: "claude-3-5-sonnet",
        goal: "Prepare a precise brief", savedAgent: {
          id: "my-agent", origin: "user", expectedRevision: revision,
          expectedOutput: "A reviewed brief", requestedToolScopes: ["none"]
        } };
      const prepared = await getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare)(event, request);
      expect(prepareChild).toHaveBeenCalledWith(expect.objectContaining({ prompt: contract.fullPrompt }));
      expect(JSON.parse(contract.fullPrompt) as { markdown: string }).toMatchObject({ markdown });
      expect(contract.fullPrompt.length).toBeGreaterThan(4000);
      expect(runChild).not.toHaveBeenCalled();
      expect(prepared.reviews[0]).not.toHaveProperty("token");
      await getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart)(event, { token: prepared.token });
      expect(persistParent).toHaveBeenCalledWith(expect.objectContaining({
        agentContract: expect.objectContaining({ agentId: "my-agent", origin: "user",
          revision, contractHash: contract.contractHash, expectedOutput: "A reviewed brief" })
      }));
      await expect(getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare)(event, {
        ...request, savedAgent: { ...request.savedAgent, requestedToolScopes: ["review-each-call"] }
      })).rejects.toThrow(/separate reviewed tool call/u);
    });

    it("prepares review manifest without executing runChild", async () => {
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn();
      const persistParent = vi.fn();
      const persistChild = vi.fn();

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const event = createMockEvent();

      const result = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Review this plan",
        sourceTurnIds: ["turn-a"]
      });

      expect(prepareChild).toHaveBeenCalledWith({
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Review this plan",
        sourceTurnIds: ["turn-a"],
        owner: expect.anything()
      });

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.reviews).toHaveLength(1);
      expect(result.reviews[0]!.providerId).toBe("anthropic");
      expect(result.reviews[0]!.modelId).toBe("claude-3-5-sonnet");
      expect(result.reviews[0]).not.toHaveProperty("token");

      expect(runChild).not.toHaveBeenCalled();
      expect(persistParent).not.toHaveBeenCalled();
      expect(persistChild).not.toHaveBeenCalled();
    });

    it("requires explicit model and rejects implicit models or duplicate sources", async () => {
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const event = createMockEvent();

      await expect(
        prepareHandler(event, {
          caseId: "case-1",
          providerId: "anthropic",
          prompt: "No model provided"
        })
      ).rejects.toThrow();

      await expect(
        prepareHandler(event, {
          caseId: "case-1",
          providerId: "anthropic",
          modelId: "invalid/model/path",
          prompt: "Invalid model format"
        })
      ).rejects.toThrow();

      await expect(
        prepareHandler(event, {
          caseId: "case-1",
          providerId: "anthropic",
          modelId: "claude-3-5-sonnet",
          prompt: "Duplicate sources",
          sourceTurnIds: ["turn-1", "turn-1"]
        })
      ).rejects.toThrow();
    });

    it("authorizes execution only with parent token, records parent before child, and denies replay", async () => {
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockResolvedValue(createFakeCompletedOutcome());
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Reviewed execution"
      });

      const startResult = await startHandler(event, { token });
      expect(startResult.runId).toBeDefined();

      expect(persistParent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "parent",
          runId: startResult.runId,
          caseId: "case-1",
          children: expect.arrayContaining([
            expect.objectContaining({
              providerId: "anthropic",
              modelId: "claude-3-5-sonnet",
              contextSnapshotId: "snapshot-123"
            })
          ])
        })
      );

      await expect(startHandler(event, { token })).rejects.toThrow(
        "That agent review expired or belongs to another window. Review it again."
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(persistChild).toHaveBeenCalledWith("case-1", expect.objectContaining({ state: "starting" }));
      expect(persistChild).toHaveBeenCalledWith("case-1", expect.objectContaining({ state: "answered" }));

      const poll = await pollHandler(event, { runId: startResult.runId });
      expect(poll.state).toBe("done");
      expect(poll.steps).toHaveLength(1);
      expect(poll.answer).toBe("Child completed successfully");
    });

    it("rejects token when window has navigated away", async () => {
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild: vi.fn(),
        persistParent: vi.fn(),
        persistChild: vi.fn()
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);

      const prepareEvent = createMockEvent(1, 1);
      const { token } = await prepareHandler(prepareEvent, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Owner test"
      });

      const navigatedEvent = createMockEvent(1, 2);
      await expect(startHandler(navigatedEvent, { token })).rejects.toThrow(
        "That agent review expired or belongs to another window. Review it again."
      );
    });

    it("stops cleanly and marks queued children stopped upon owner stop", async () => {
      let runSignal: AbortSignal | undefined;
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockImplementation(({ signal }) => {
        runSignal = signal;
        return new Promise(() => {});
      });
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const stopHandler = getHandler<WorkstationAgentStopResult>(IPC_CHANNELS.workstationAgentStop);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Stop test"
      });

      const { runId } = await startHandler(event, { token });
      expect(runSignal).toBeDefined();
      expect(runSignal!.aborted).toBe(false);

      const stopResult = await stopHandler(event, { runId });
      expect(stopResult.state).toBe("stopping");
      expect(runSignal!.aborted).toBe(true);
    });

    it("handles crashes by persisting interrupted state without silent replay", async () => {
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockRejectedValue(new Error("Worker process crashed unexpectedly"));
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Crash test"
      });

      const { runId } = await startHandler(event, { token });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          state: "interrupted",
          line: expect.stringContaining("Worker process crashed unexpectedly")
        })
      );

      const poll = await pollHandler(event, { runId });
      expect(poll.state).toBe("interrupted");
      expect(poll.failure).toContain("Worker process crashed unexpectedly");
    });

    it("stopActive cancels active run without revoking owner or future reviews, and returns false when idle", async () => {
      let runSignal: AbortSignal | undefined;
      const prepareChild = vi.fn().mockImplementation((input) =>
        Promise.resolve(createFakeReview({ prompt: input.prompt }))
      );
      const runChild = vi.fn().mockImplementation(({ signal }) => {
        runSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Host result needs inspection")), { once: true });
        });
      });
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      const stream = installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      expect(await stream.stopActive()).toBe(false);

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "First run"
      });

      const { runId } = await startHandler(event, { token });
      expect(runSignal?.aborted).toBe(false);

      const stopped = await stream.stopActive();
      expect(stopped).toBe(true);
      expect(runSignal?.aborted).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await pollHandler(event, { runId })).state).toBe("interrupted");
      expect(await stream.stopActive()).toBe(false);

      const { token: token2 } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Second run after stopActive"
      });
      const start2 = await startHandler(event, { token: token2 });
      expect(start2.runId).toBeDefined();
    });

    it("global Stop during first child prevents second child launch and receipts queued work stopped", async () => {
      let firstChildSignal: AbortSignal | undefined;
      const prepareChild = vi.fn().mockImplementation((input) =>
        Promise.resolve(createFakeReview({ contextPreview: input.prompt }))
      );
      const runChild = vi.fn().mockImplementation(({ signal }) => {
        firstChildSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("Aborted by coordinator Stop");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      const stream = installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        steps: [
          { prompt: "Step 1", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
          { prompt: "Step 2", providerId: "anthropic", modelId: "claude-3-5-sonnet" }
        ]
      });

      const { runId } = await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(runChild).toHaveBeenCalledTimes(1);
      expect(firstChildSignal?.aborted).toBe(false);

      const stopped = await stream.stopActive();
      expect(stopped).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(runChild).toHaveBeenCalledTimes(1);

      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          index: 0,
          state: "interrupted"
        })
      );

      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          index: 1,
          state: "stopped",
          line: "Stopped before provider dispatch."
        })
      );

      const poll = await pollHandler(event, { runId });
      expect(poll.state).toBe("interrupted");
    });

    it("global Stop between children preserves first child answered receipt and prevents second child launch", async () => {
      const prepareChild = vi.fn().mockImplementation((input) =>
        Promise.resolve(createFakeReview({ contextPreview: input.prompt }))
      );

      let stream: { readonly stopActive: () => Promise<boolean> };
      let runChildCount = 0;
      const runChild = vi.fn().mockImplementation(async () => {
        runChildCount++;
        if (runChildCount === 1) {
          return createFakeCompletedOutcome("turn-first", "First child answer");
        }
        return createFakeCompletedOutcome("turn-second", "Second child answer");
      });

      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockImplementation(async (_caseId, receipt) => {
        if (receipt.index === 0 && receipt.state === "answered") await stream.stopActive();
      });

      stream = installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        steps: [
          { prompt: "Step 1", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
          { prompt: "Step 2", providerId: "anthropic", modelId: "claude-3-5-sonnet" }
        ]
      });

      const { runId } = await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(runChild).toHaveBeenCalledTimes(1);

      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          index: 0,
          state: "answered",
          answerTurnId: "turn-first",
          line: "First child answer"
        })
      );

      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          index: 1,
          state: "stopped",
          line: "Stopped before provider dispatch."
        })
      );

      const poll = await pollHandler(event, { runId });
      expect(poll.state).toBe("stopped");
      expect(poll.answer).toBe("First child answer");
    });

    it("stop during persistParent prevents any child dispatch and receipts all children stopped", async () => {
      let resolvePersistParent: (() => void) | undefined;
      const persistParentPromise = new Promise<void>((resolve) => {
        resolvePersistParent = resolve;
      });

      const prepareChild = vi.fn().mockImplementation((input) =>
        Promise.resolve(createFakeReview({ contextPreview: input.prompt }))
      );
      const runChild = vi.fn();
      const persistParent = vi.fn().mockImplementation(() => persistParentPromise);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      const stream = installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        steps: [
          { prompt: "Step 1", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
          { prompt: "Step 2", providerId: "anthropic", modelId: "claude-3-5-sonnet" }
        ]
      });

      const startPromise = startHandler(event, { token });

      await new Promise((resolve) => setTimeout(resolve, 5));
      const stopped = await stream.stopActive();
      expect(stopped).toBe(true);

      resolvePersistParent!();
      const { runId } = await startPromise;

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(runChild).not.toHaveBeenCalled();
      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          index: 0,
          state: "stopped",
          line: "Stopped before provider dispatch."
        })
      );
      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          index: 1,
          state: "stopped",
          line: "Stopped before provider dispatch."
        })
      );

      const poll = await pollHandler(event, { runId });
      expect(poll.state).toBe("stopped");
    });

    it("preserves partial turn IDs when child execution fails or is interrupted after dispatch", async () => {
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runError = Object.assign(new Error("Worker connection lost midway"), {
        draftTurnId: "partial-turn-999"
      });
      const runChild = vi.fn().mockRejectedValue(runError);
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockResolvedValue(undefined);

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Partial turn test"
      });

      const { runId } = await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(persistChild).toHaveBeenCalledWith(
        "case-1",
        expect.objectContaining({
          state: "interrupted",
          draftTurnId: "partial-turn-999"
        })
      );

      const poll = await pollHandler(event, { runId });
      expect(poll.state).toBe("interrupted");
    });

    it("binds identical attempt UUID and review metadata on starting and terminal receipts", async () => {
      type ChildReceipt = Parameters<InstallReviewedAgentStreamOptions["persistChild"]>[1];
      const capturedReceipts: ChildReceipt[] = [];
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockResolvedValue(createFakeCompletedOutcome());
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockImplementation(async (_caseId: string, receipt: ChildReceipt) => {
        capturedReceipts.push(receipt);
      });

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Attempt identity test"
      });

      await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 15));

      const starting = capturedReceipts.find((r) => r.state === "starting");
      const terminal = capturedReceipts.find((r) => r.state === "answered");

      expect(starting?.attempt).toBeDefined();
      expect(starting?.attempt?.attemptId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(starting?.attempt).toEqual({
        attemptId: starting?.attempt?.attemptId,
        contextSnapshotId: "snapshot-123",
        sourceHash: "sha256-abc",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet"
      });
      expect(terminal?.attempt).toEqual(starting?.attempt);
    });

    it("assigns distinct attempt IDs to distinct children across sequential execution", async () => {
      type ChildReceipt = Parameters<InstallReviewedAgentStreamOptions["persistChild"]>[1];
      const capturedReceipts: ChildReceipt[] = [];
      const prepareChild = vi.fn().mockImplementation((input: { prompt: string }) =>
        Promise.resolve(
          createFakeReview({
            contextSnapshotId: `snapshot-${input.prompt}`,
            sourceHash: `hash-${input.prompt}`
          })
        )
      );
      const runChild = vi.fn().mockResolvedValue(createFakeCompletedOutcome());
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockImplementation(async (_caseId: string, receipt: ChildReceipt) => {
        capturedReceipts.push(receipt);
      });

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        steps: [
          { prompt: "Step 1", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
          { prompt: "Step 2", providerId: "anthropic", modelId: "claude-3-5-sonnet" }
        ]
      });

      await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const child0 = capturedReceipts.find((r) => r.index === 0 && r.state === "starting");
      const child1 = capturedReceipts.find((r) => r.index === 1 && r.state === "starting");

      expect(child0?.attempt?.attemptId).toBeDefined();
      expect(child1?.attempt?.attemptId).toBeDefined();
      expect(child0?.attempt?.attemptId).not.toBe(child1?.attempt?.attemptId);
      expect(child0?.attempt?.contextSnapshotId).toBe("snapshot-Step 1");
      expect(child1?.attempt?.contextSnapshotId).toBe("snapshot-Step 2");
    });

    it("leaves queued unstarted children unbound on Stop", async () => {
      type ChildReceipt = Parameters<InstallReviewedAgentStreamOptions["persistChild"]>[1];
      const capturedReceipts: ChildReceipt[] = [];
      const prepareChild = vi.fn().mockImplementation((input: { prompt: string }) =>
        Promise.resolve(
          createFakeReview({
            contextSnapshotId: `snapshot-${input.prompt}`,
            sourceHash: `hash-${input.prompt}`
          })
        )
      );

      let stream: { readonly stopActive: () => Promise<boolean> };
      const runChild = vi.fn().mockImplementation(async () => {
        await stream.stopActive();
        return createFakeCompletedOutcome("turn-1", "First answer");
      });
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockImplementation(async (_caseId: string, receipt: ChildReceipt) => {
        capturedReceipts.push(receipt);
      });

      stream = installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        steps: [
          { prompt: "Step 1", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
          { prompt: "Step 2", providerId: "anthropic", modelId: "claude-3-5-sonnet" }
        ]
      });

      await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const child0Starting = capturedReceipts.find((r) => r.index === 0 && r.state === "starting");
      const child0Terminal = capturedReceipts.find((r) => r.index === 0 && r.state === "answered");
      const child1Stopped = capturedReceipts.find((r) => r.index === 1 && r.state === "stopped");

      expect(child0Starting?.attempt?.attemptId).toBeDefined();
      expect(child0Terminal?.attempt).toEqual(child0Starting?.attempt);
      expect(child1Stopped?.attempt).toBeUndefined();
    });

    it("preserves actual attempt binding in interrupted receipt when host throws", async () => {
      type ChildReceipt = Parameters<InstallReviewedAgentStreamOptions["persistChild"]>[1];
      const capturedReceipts: ChildReceipt[] = [];
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockRejectedValue(new Error("Host worker blew up"));
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockImplementation(async (_caseId: string, receipt: ChildReceipt) => {
        capturedReceipts.push(receipt);
      });

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Throw test"
      });

      await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 15));

      const starting = capturedReceipts.find((r) => r.state === "starting");
      const interrupted = capturedReceipts.find((r) => r.state === "interrupted");

      expect(starting?.attempt?.attemptId).toBeDefined();
      expect(interrupted?.attempt).toEqual(starting?.attempt);
    });

    it("rejects mismatched terminal binding in host callback and does not claim success", async () => {
      type ChildReceipt = Parameters<InstallReviewedAgentStreamOptions["persistChild"]>[1];
      let startingAttemptId: string | undefined;
      const prepareChild = vi.fn().mockResolvedValue(createFakeReview());
      const runChild = vi.fn().mockResolvedValue(createFakeCompletedOutcome());
      const persistParent = vi.fn().mockResolvedValue(undefined);
      const persistChild = vi.fn().mockImplementation(async (_caseId: string, receipt: ChildReceipt) => {
        if (receipt.state === "starting") {
          startingAttemptId = receipt.attempt?.attemptId;
        }
        if (receipt.state === "answered") {
          if (!receipt.attempt || receipt.attempt.attemptId !== startingAttemptId) {
            throw new Error("Mismatched terminal binding rejected");
          }
          throw new Error("Callback rejected terminal binding");
        }
      });

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const pollHandler = getHandler<WorkstationAgentPollResult>(IPC_CHANNELS.workstationAgentPoll);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Callback rejection test"
      });

      const { runId } = await startHandler(event, { token });
      await new Promise((resolve) => setTimeout(resolve, 15));

      const poll = await pollHandler(event, { runId });
      expect(poll.state).not.toBe("done");
      expect(poll.answer).toBeUndefined();
    });

    it("blocks launch when review metadata is missing", async () => {
      const prepareChild = vi.fn().mockResolvedValue(
        createFakeReview({ contextSnapshotId: "", sourceHash: "" })
      );
      const runChild = vi.fn();
      const persistParent = vi.fn();

      installReviewedAgentStream({
        assertTrusted: () => {},
        ownerFor: testOwnerFor,
        prepareChild,
        runChild,
        persistParent,
        persistChild: vi.fn()
      });

      const prepareHandler = getHandler<WorkstationAgentPrepareResult>(IPC_CHANNELS.workstationAgentPrepare);
      const startHandler = getHandler<WorkstationAgentStartResult>(IPC_CHANNELS.workstationAgentStart);
      const event = createMockEvent();

      const { token } = await prepareHandler(event, {
        caseId: "case-1",
        providerId: "anthropic",
        modelId: "claude-3-5-sonnet",
        prompt: "Missing review metadata"
      });

      await expect(startHandler(event, { token })).rejects.toThrow(
        "An agent step has no saved context or chosen model. Nothing was sent."
      );
      expect(persistParent).not.toHaveBeenCalled();
      expect(runChild).not.toHaveBeenCalled();
    });
  });
});
