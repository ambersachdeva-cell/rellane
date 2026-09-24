import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installAgentStream,
  type InstallAgentStreamOptions,
  type RawAgentStep,
  type WorkstationAgentPollResult,
  type WorkstationAgentStartResult,
  type WorkstationAgentStopResult
} from "./agent-stream-ipc.js";

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
});
