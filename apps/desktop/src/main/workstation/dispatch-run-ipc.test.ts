import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installDispatchRun,
  type DispatchBoard
} from "./dispatch-run-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    })
  }
}));

const fakeEvent = {
  sender: {},
  senderFrame: {}
} as unknown as IpcMainInvokeEvent;

function getHandler(channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Handler not registered for channel: ${channel}`);
  }
  return handler;
}

describe("dispatch-run-ipc", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("starts three lanes (resolving, rejecting, hanging), polls them, and stops the hanging lane by name", async () => {
    const providers = vi.fn().mockResolvedValue([
      { id: "bot-fast", label: "Fast Bot", usable: true },
      { id: "bot-fail", label: "Failing Bot", usable: true },
      { id: "bot-hang", label: "Hanging Bot", usable: true }
    ]);

    let hangSignal: AbortSignal | undefined;

    const askProvider = vi.fn().mockImplementation(async (input: {
      readonly providerId: string;
      readonly caseId: string;
      readonly brief: string;
      readonly sourceTurnIds: readonly string[];
      readonly signal: AbortSignal;
    }) => {
      if (input.providerId === "bot-fast") {
        return { text: "Here is the concise answer from the fast bot.", turnId: "turn-fast" };
      }
      if (input.providerId === "bot-fail") {
        throw new Error("Bot process terminated unexpectedly.");
      }
      if (input.providerId === "bot-hang") {
        hangSignal = input.signal;
        return new Promise<{ readonly text: string; readonly turnId: string }>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            reject(new Error("Aborted"));
          });
        });
      }
      throw new Error(`Unexpected provider: ${input.providerId}`);
    });

    let currentTime = 1_000;
    const now = () => currentTime;
    const assertTrusted = vi.fn();

    installDispatchRun({
      assertTrusted,
      askProvider,
      providers,
      now
    });

    const start = getHandler(IPC_CHANNELS.workstationDispatchStart);
    const poll = getHandler(IPC_CHANNELS.workstationDispatchPoll);
    const stop = getHandler(IPC_CHANNELS.workstationDispatchStop);

    const startResponse = (await start(fakeEvent, {
      caseId: "case-42",
      brief: "Analyze the commercial lease clauses.",
      providerIds: ["bot-fast", "bot-fail", "bot-hang"]
    })) as { readonly runId: string };

    expect(startResponse.runId).toBeDefined();
    const runId = startResponse.runId;

    // Wait for the fast provider to resolve and the failing provider to reject.
    await new Promise((resolve) => setTimeout(resolve, 20));
    currentTime += 12_000;

    const board1 = (await poll(fakeEvent, { runId })) as DispatchBoard;

    expect(assertTrusted).toHaveBeenCalledWith(fakeEvent);
    expect(board1.runId).toBe(runId);
    expect(board1.caseId).toBe("case-42");
    expect(board1.brief).toBe("Analyze the commercial lease clauses.");
    expect(board1.done).toBe(false);
    expect(board1.working).toBe(1);
    expect(board1.answered).toBe(1);

    expect(board1.lanes).toHaveLength(3);
    const fastLane = board1.lanes.find((l) => l.providerId === "bot-fast");
    const failLane = board1.lanes.find((l) => l.providerId === "bot-fail");
    const hangLane = board1.lanes.find((l) => l.providerId === "bot-hang");

    expect(fastLane).toBeDefined();
    expect(fastLane!.state).toBe("answered");
    expect(fastLane!.answerTurnId).toBe("turn-fast");
    expect(fastLane!.chars).toBeGreaterThan(0);
    expect(fastLane!.canStop).toBe(false);

    expect(failLane).toBeDefined();
    expect(failLane!.state).toBe("failed");
    expect(failLane!.line).toBe("Bot process terminated unexpectedly.");
    expect(failLane!.canStop).toBe(false);

    expect(hangLane).toBeDefined();
    expect(hangLane!.state).toBe("working");
    expect(hangLane!.canStop).toBe(true);
    expect(hangLane!.elapsed).toBe("12 sec");

    expect(board1.headline).toBe("One bot working, one answered, one failed.");

    currentTime += 5_000;
    const board2 = (await stop(fakeEvent, { runId, providerId: "bot-hang" })) as DispatchBoard;

    expect(board2.done).toBe(true);
    expect(board2.working).toBe(0);
    expect(board2.answered).toBe(1);

    const stoppedHangLane = board2.lanes.find((l) => l.providerId === "bot-hang");
    const unchangedFastLane = board2.lanes.find((l) => l.providerId === "bot-fast");
    const unchangedFailLane = board2.lanes.find((l) => l.providerId === "bot-fail");

    expect(stoppedHangLane!.state).toBe("stopped");
    expect(stoppedHangLane!.canStop).toBe(false);
    expect(stoppedHangLane!.line).toBe("Stopped.");

    expect(unchangedFastLane!.state).toBe("answered");
    expect(unchangedFailLane!.state).toBe("failed");

    expect(hangSignal?.aborted).toBe(true);
    expect(board2.headline).toBe("One bot answered, one failed, one stopped.");
  });

  it("handles an unavailable provider without starting it or dropping it", async () => {
    const providers = vi.fn().mockResolvedValue([
      { id: "bot-usable", label: "Usable Bot", usable: true },
      { id: "bot-broken", label: "Broken Bot", usable: false }
    ]);

    const askProvider = vi.fn().mockResolvedValue({
      text: "Report complete.",
      turnId: "turn-report"
    });

    installDispatchRun({
      assertTrusted: vi.fn(),
      askProvider,
      providers,
      now: () => 5_000
    });

    const start = getHandler(IPC_CHANNELS.workstationDispatchStart);
    const poll = getHandler(IPC_CHANNELS.workstationDispatchPoll);

    const startResponse = (await start(fakeEvent, {
      caseId: "case-99",
      brief: "Review audit findings.",
      providerIds: ["bot-usable", "bot-broken"]
    })) as { readonly runId: string };

    await new Promise((resolve) => setTimeout(resolve, 20));

    const board = (await poll(fakeEvent, { runId: startResponse.runId })) as DispatchBoard;

    expect(askProvider).toHaveBeenCalledTimes(1);
    expect(askProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "bot-usable" })
    );

    const brokenLane = board.lanes.find((l) => l.providerId === "bot-broken");
    expect(brokenLane).toBeDefined();
    expect(brokenLane!.state).toBe("unavailable");
    expect(brokenLane!.line).toBe("Not available right now.");
    expect(brokenLane!.canStop).toBe(false);
    expect(brokenLane!.chars).toBe(0);

    const usableLane = board.lanes.find((l) => l.providerId === "bot-usable");
    expect(usableLane!.state).toBe("answered");

    expect(board.headline).toBe("One bot answered, one unavailable.");
    expect(board.done).toBe(true);
  });

  it("stops all working lanes when providerId is omitted in stop request", async () => {
    const providers = vi.fn().mockResolvedValue([
      { id: "bot-1", label: "Bot One", usable: true },
      { id: "bot-2", label: "Bot Two", usable: true }
    ]);

    const askProvider = vi.fn().mockImplementation(
      () => new Promise<{ readonly text: string; readonly turnId: string }>(() => {})
    );

    installDispatchRun({
      assertTrusted: vi.fn(),
      askProvider,
      providers,
      now: () => 10_000
    });

    const start = getHandler(IPC_CHANNELS.workstationDispatchStart);
    const stop = getHandler(IPC_CHANNELS.workstationDispatchStop);

    const startResponse = (await start(fakeEvent, {
      caseId: "case-100",
      brief: "Draft quarterly goals.",
      providerIds: ["bot-1", "bot-2"]
    })) as { readonly runId: string };

    const stoppedBoard = (await stop(fakeEvent, { runId: startResponse.runId })) as DispatchBoard;

    expect(stoppedBoard.working).toBe(0);
    expect(stoppedBoard.done).toBe(true);
    expect(stoppedBoard.lanes.every((l) => l.state === "stopped")).toBe(true);
    expect(stoppedBoard.headline).toBe("Two bots stopped.");
  });

  it("rejects input with too many providers or oversized brief", async () => {
    installDispatchRun({
      assertTrusted: vi.fn(),
      askProvider: vi.fn(),
      providers: vi.fn().mockResolvedValue([])
    });

    const start = getHandler(IPC_CHANNELS.workstationDispatchStart);

    await expect(
      start(fakeEvent, {
        caseId: "case-1",
        brief: "Valid brief",
        providerIds: ["1", "2", "3", "4", "5", "6"]
      })
    ).rejects.toThrow();

    await expect(
      start(fakeEvent, {
        caseId: "case-1",
        brief: "x".repeat(10_001),
        providerIds: ["1"]
      })
    ).rejects.toThrow();
  });
});
