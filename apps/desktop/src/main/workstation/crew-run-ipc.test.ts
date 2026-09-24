import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  createCrewRunCoordinator,
  installCrewRun,
  type InstallCrewRunOptions
} from "./crew-run-ipc.js";

const mockIpcHandlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
      mockIpcHandlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      mockIpcHandlers.delete(channel);
    }
  }
}));

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: () => () => "owner-token"
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 15));

describe("crew-run coordinator and IPC", () => {
  it("waits for dependency A before calling B, while C runs concurrently beside A", async () => {
    const askCalls: string[] = [];
    const aDeferred = createDeferred<{ readonly text: string }>();
    const bDeferred = createDeferred<{ readonly text: string }>();
    const cDeferred = createDeferred<{ readonly text: string }>();

    const coordinator = createCrewRunCoordinator({
      assertTrusted: () => {},
      ask: async ({ seatId }) => {
        askCalls.push(seatId);
        if (seatId === "claude") {
          return aDeferred.promise;
        }
        if (seatId === "gemini") {
          return bDeferred.promise;
        }
        if (seatId === "codex") {
          return cDeferred.promise;
        }
        throw new Error(`Unexpected seat: ${seatId}`);
      },
      record: async () => "turn-id-1"
    });

    const { runId } = await coordinator.start({
      caseId: "case-1",
      request: "Three parts division",
      parts: [
        {
          id: "part-a",
          title: "Part A",
          prompt: "Prompt A",
          seatId: "claude",
          seatLabel: "Claude",
          dependsOn: []
        },
        {
          id: "part-b",
          title: "Part B",
          prompt: "Prompt B",
          seatId: "gemini",
          seatLabel: "Gemini",
          dependsOn: ["part-a"]
        },
        {
          id: "part-c",
          title: "Part C",
          prompt: "Prompt C",
          seatId: "codex",
          seatLabel: "Codex",
          dependsOn: []
        }
      ]
    });

    expect(askCalls).toContain("claude");
    expect(askCalls).toContain("codex");
    expect(askCalls).not.toContain("gemini");

    const poll1 = coordinator.poll({ runId });
    expect(poll1.parts.find(p => p.id === "part-b")?.state).toBe("waiting");

    aDeferred.resolve({ text: "Answer A" });
    await flushMicrotasks();

    expect(askCalls).toContain("gemini");

    bDeferred.resolve({ text: "Answer B" });
    cDeferred.resolve({ text: "Answer C" });
    await flushMicrotasks();

    const poll2 = coordinator.poll({ runId });
    expect(poll2.round).toBe("done");
    expect(poll2.parts.every(p => p.state === "done")).toBe(true);
  });

  it("stopping B by id leaves A and C alone to complete", async () => {
    const aDeferred = createDeferred<{ readonly text: string }>();
    const cDeferred = createDeferred<{ readonly text: string }>();

    const coordinator = createCrewRunCoordinator({
      assertTrusted: () => {},
      ask: async ({ seatId }) => {
        if (seatId === "claude") {
          return aDeferred.promise;
        }
        if (seatId === "codex") {
          return cDeferred.promise;
        }
        throw new Error(`Unexpected seat: ${seatId}`);
      },
      record: async () => "turn-id-2"
    });

    const { runId } = await coordinator.start({
      caseId: "case-1",
      request: "Three parts",
      parts: [
        {
          id: "part-a",
          title: "Part A",
          prompt: "Prompt A",
          seatId: "claude",
          seatLabel: "Claude",
          dependsOn: []
        },
        {
          id: "part-b",
          title: "Part B",
          prompt: "Prompt B",
          seatId: "gemini",
          seatLabel: "Gemini",
          dependsOn: ["part-a"]
        },
        {
          id: "part-c",
          title: "Part C",
          prompt: "Prompt C",
          seatId: "codex",
          seatLabel: "Codex",
          dependsOn: []
        }
      ]
    });

    const stopped = coordinator.stop({ runId, partId: "part-b" });
    expect(stopped.parts.find(p => p.id === "part-b")?.state).toBe("stopped");
    expect(stopped.parts.find(p => p.id === "part-a")?.state).toBe("working");
    expect(stopped.parts.find(p => p.id === "part-c")?.state).toBe("working");

    aDeferred.resolve({ text: "Answer A" });
    cDeferred.resolve({ text: "Answer C" });
    await flushMicrotasks();

    const finalView = coordinator.poll({ runId });
    expect(finalView.parts.find(p => p.id === "part-a")?.state).toBe("done");
    expect(finalView.parts.find(p => p.id === "part-c")?.state).toBe("done");
    expect(finalView.parts.find(p => p.id === "part-b")?.state).toBe("stopped");
    expect(finalView.round).toBe("done");
  });

  it("fails rejected part while independent parts continue and finish", async () => {
    const aDeferred = createDeferred<{ readonly text: string }>();
    const cDeferred = createDeferred<{ readonly text: string }>();

    const coordinator = createCrewRunCoordinator({
      assertTrusted: () => {},
      ask: async ({ seatId }) => {
        if (seatId === "claude") {
          return aDeferred.promise;
        }
        if (seatId === "codex") {
          return cDeferred.promise;
        }
        throw new Error(`Unexpected seat: ${seatId}`);
      },
      record: async () => "turn-id-3"
    });

    const { runId } = await coordinator.start({
      caseId: "case-1",
      request: "Three parts",
      parts: [
        {
          id: "part-a",
          title: "Part A",
          prompt: "Prompt A",
          seatId: "claude",
          seatLabel: "Claude",
          dependsOn: []
        },
        {
          id: "part-b",
          title: "Part B",
          prompt: "Prompt B",
          seatId: "gemini",
          seatLabel: "Gemini",
          dependsOn: ["part-a"]
        },
        {
          id: "part-c",
          title: "Part C",
          prompt: "Prompt C",
          seatId: "codex",
          seatLabel: "Codex",
          dependsOn: []
        }
      ]
    });

    aDeferred.reject(new Error("Connection dropped"));
    await flushMicrotasks();

    const midPoll = coordinator.poll({ runId });
    expect(midPoll.parts.find(p => p.id === "part-a")?.state).toBe("failed");
    expect(midPoll.parts.find(p => p.id === "part-b")?.state).toBe("failed");
    expect(midPoll.parts.find(p => p.id === "part-c")?.state).toBe("working");

    cDeferred.resolve({ text: "Answer C" });
    await flushMicrotasks();

    const finalPoll = coordinator.poll({ runId });
    expect(finalPoll.parts.find(p => p.id === "part-c")?.state).toBe("done");
    expect(finalPoll.round).toBe("done");
  });

  it("refuses circular dependencies with a plain sentence", async () => {
    const coordinator = createCrewRunCoordinator({
      assertTrusted: () => {},
      ask: async () => ({ text: "" }),
      record: async () => "turn-id"
    });

    await expect(
      coordinator.start({
        caseId: "case-1",
        request: "Cycle",
        parts: [
          {
            id: "part-a",
            title: "Part A",
            prompt: "Prompt A",
            seatId: "claude",
            seatLabel: "Claude",
            dependsOn: ["part-b"]
          },
          {
            id: "part-b",
            title: "Part B",
            prompt: "Prompt B",
            seatId: "gemini",
            seatLabel: "Gemini",
            dependsOn: ["part-a"]
          }
        ]
      })
    ).rejects.toThrow("Parts cannot depend on each other in a circle.");
  });

  it("refuses starting a second run while one is in progress", async () => {
    const aDeferred = createDeferred<{ readonly text: string }>();
    const coordinator = createCrewRunCoordinator({
      assertTrusted: () => {},
      ask: () => aDeferred.promise,
      record: async () => "turn-id"
    });

    await coordinator.start({
      caseId: "case-1",
      request: "First run",
      parts: [
        {
          id: "part-a",
          title: "Part A",
          prompt: "Prompt A",
          seatId: "claude",
          seatLabel: "Claude",
          dependsOn: []
        }
      ]
    });

    await expect(
      coordinator.start({
        caseId: "case-1",
        request: "Second run",
        parts: [
          {
            id: "part-b",
            title: "Part B",
            prompt: "Prompt B",
            seatId: "gemini",
            seatLabel: "Gemini",
            dependsOn: []
          }
        ]
      })
    ).rejects.toThrow("A crew run is already in progress. Wait for it to finish or stop it first.");
  });

  it("enters reading-each-other round and records refined outputs", async () => {
    const askCalls: { readonly seatId: string; readonly prompt: string }[] = [];
    const coordinator = createCrewRunCoordinator({
      assertTrusted: () => {},
      ask: async ({ seatId, prompt }) => {
        askCalls.push({ seatId, prompt });
        return { text: `Answer from ${seatId}` };
      },
      record: async () => "turn-refine"
    });

    const { runId } = await coordinator.start({
      caseId: "case-1",
      request: "Refine test",
      parts: [
        {
          id: "part-a",
          title: "Part A",
          prompt: "Prompt A",
          seatId: "claude",
          seatLabel: "Claude",
          dependsOn: [],
          refinePrompt: "Refine A"
        },
        {
          id: "part-b",
          title: "Part B",
          prompt: "Prompt B",
          seatId: "gemini",
          seatLabel: "Gemini",
          dependsOn: [],
          refinePrompt: "Refine B"
        }
      ]
    });

    await flushMicrotasks();

    const view = coordinator.poll({ runId });
    expect(view.round).toBe("done");
    expect(view.parts.find(p => p.id === "part-a")?.refinedFrom).toEqual(["part-b"]);
    expect(view.parts.find(p => p.id === "part-b")?.refinedFrom).toEqual(["part-a"]);
    expect(askCalls.length).toBe(4);
  });

  it("installs IPC handlers correctly and connects trusted calls", async () => {
    let trustedCheckCalls = 0;
    const options: InstallCrewRunOptions = {
      assertTrusted: () => {
        trustedCheckCalls += 1;
      },
      ask: async () => ({ text: "IPC answer" }),
      record: async () => "turn-ipc-1"
    };

    installCrewRun(options);

    const startHandler = mockIpcHandlers.get(IPC_CHANNELS.workstationCrewStart);
    expect(startHandler).toBeDefined();

    const fakeEvent = {
      sender: {},
      senderFrame: {}
    } as unknown as IpcMainInvokeEvent;

    const startResult = (await startHandler!(fakeEvent, {
      caseId: "case-ipc",
      request: "Request across IPC",
      parts: [
        {
          id: "part-1",
          title: "Part 1",
          prompt: "Prompt 1",
          seatId: "claude",
          seatLabel: "Claude",
          dependsOn: []
        }
      ]
    })) as { readonly runId: string };

    expect(startResult.runId).toBeDefined();
    expect(trustedCheckCalls).toBeGreaterThan(0);
  });
});
