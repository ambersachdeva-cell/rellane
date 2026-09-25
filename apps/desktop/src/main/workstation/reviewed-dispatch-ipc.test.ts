/** Compare only dispatches the exact reviewed children through one owner. */
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import type { WorkstationProviderId, WorkstationReview } from "@cadrane/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { installReviewedDispatchRun } from "./dispatch-run-ipc.js";
import type { NativeAskOutcome } from "./types.js";

const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>();
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn((channel, handler) => { handlers.set(channel, handler); }) } }));

const owner = Object.freeze({ window: "owner" });
const stranger = Object.freeze({ window: "stranger" });
const event = Object.assign(new EventEmitter(), { owner }) as unknown as IpcMainInvokeEvent;
const otherEvent = Object.assign(new EventEmitter(), { owner: stranger }) as unknown as IpcMainInvokeEvent;
const caseId = "case-1";

function review(providerId: WorkstationProviderId, modelId: string): WorkstationReview {
  return { token: providerId.padEnd(64, "a"), caseId, providerId, providerLabel: providerId,
    modelId, prompt: "Review the brief", contextPreview: `packet:${providerId}`,
    sourceIds: [], sourceHash: `hash:${providerId}`,
    contextSnapshotId: `snapshot:${providerId}`,
    workspace: { id: "private", label: "Private work", path: "/private/work" },
    expiresAt: Date.now() + 60_000, resumeSessionId: null };
}

function outcome(text: string, modelId: string): NativeAskOutcome & { readonly turnId: string } {
  return { text, sessionId: "native", finishReason: "completed", requestedModelId: modelId,
    cancellationRequested: false, resultSource: "transport", turnId: `turn:${modelId}` };
}

function setup(runLane: (input: { readonly review: WorkstationReview; readonly signal: AbortSignal }) => Promise<NativeAskOutcome & { readonly turnId: string | null }>,
  hooks: { readonly persistParent?: () => Promise<void>; readonly persistChild?: (state: string) => Promise<void> } = {}) {
  const prepareLane = vi.fn(async ({ providerId, modelId }: { readonly providerId: string; readonly modelId: string }) =>
    review(providerId as WorkstationProviderId, modelId));
  const runner = vi.fn(runLane);
  const lifecycle = installReviewedDispatchRun({ assertTrusted: () => undefined,
    ownerFor: (caller) => (caller as unknown as { owner: object }).owner,
    prepareLane, runLane: runner,
    persistParent: hooks.persistParent ?? (async () => undefined),
    persistChild: async (_caseId, receipt) => hooks.persistChild?.(receipt.state),
    recover: async () => null });
  const invoke = (channel: string, input: unknown, caller = event) => handlers.get(channel)!(caller, input);
  return { invoke, prepareLane, runner, lifecycle };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("The reviewed lane did not settle.");
}

describe("reviewed Compare dispatch", () => {
  beforeEach(() => handlers.clear());

  it("reviews every exact choice, then starts serially and waits for terminal outcomes", async () => {
    let finishFirst: ((value: NativeAskOutcome & { readonly turnId: string | null }) => void) | null = null;
    const first = new Promise<NativeAskOutcome & { readonly turnId: string | null }>((resolve) => { finishFirst = resolve; });
    const kit = setup(async ({ review: selected }) => selected.providerId === "claude"
      ? first : outcome("Second answer", selected.modelId!));
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [
        { providerId: "claude", modelId: "sonnet" },
        { providerId: "codex", modelId: "gpt-5-codex" }
      ], sourceTurnIds: [] }) as { token: string; reviews: readonly Omit<WorkstationReview, "token">[] };
    expect(prepared.reviews.map((one) => one.contextPreview)).toEqual(["packet:claude", "packet:codex"]);
    expect(prepared.reviews[0]).not.toHaveProperty("token");
    expect(kit.runner).not.toHaveBeenCalled();
    const started = await kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }) as { runId: string };
    expect(kit.runner).toHaveBeenCalledTimes(1);
    await expect(kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token })).rejects.toThrow(/expired|window/u);
    const working = await kit.invoke(IPC_CHANNELS.workstationDispatchPoll, { runId: started.runId }) as { done: boolean };
    expect(working.done).toBe(false);
    finishFirst!(outcome("First answer", "sonnet"));
    await waitUntil(() => kit.runner.mock.calls.length === 2);
    await waitUntil(asyncDoneFlag(kit.invoke, started.runId));
    const done = await kit.invoke(IPC_CHANNELS.workstationDispatchPoll, { runId: started.runId }) as {
      done: boolean; lanes: readonly { state: string; answerTurnId: string | null }[] };
    expect(done.done).toBe(true);
    expect(done.lanes.map((lane) => [lane.state, lane.answerTurnId])).toEqual([
      ["answered", "turn:sonnet"], ["answered", "turn:gpt-5-codex"]
    ]);
  });

  it("binds the parent token to its window and stops a queued child before dispatch", async () => {
    let finishFirst: ((value: NativeAskOutcome & { readonly turnId: string | null }) => void) | null = null;
    const first = new Promise<NativeAskOutcome & { readonly turnId: string | null }>((resolve) => { finishFirst = resolve; });
    const kit = setup(async () => first);
    await expect(kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId, brief: "x",
      selections: [{ providerId: "claude", modelId: "" }] })).rejects.toThrow();
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [
        { providerId: "claude", modelId: "sonnet" }, { providerId: "codex", modelId: "gpt-5-codex" }
      ] }) as { token: string };
    await expect(kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }, otherEvent))
      .rejects.toThrow(/window/u);
    expect(kit.runner).not.toHaveBeenCalled();
    const second = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [
        { providerId: "claude", modelId: "sonnet" }, { providerId: "codex", modelId: "gpt-5-codex" }
      ] }) as { token: string };
    const started = await kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: second.token }) as { runId: string };
    const stopping = await kit.invoke(IPC_CHANNELS.workstationDispatchStop,
      { runId: started.runId, providerId: "codex" }) as { lanes: readonly { state: string }[] };
    expect(stopping.lanes[1]?.state).toBe("stopped");
    finishFirst!(outcome("First answer", "sonnet"));
    await waitUntil(asyncDoneFlag(kit.invoke, started.runId));
    expect(kit.runner).toHaveBeenCalledTimes(1);
  });

  it("never dispatches after Stop while the starting receipt is being saved", async () => {
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const kit = setup(async ({ review: selected }) => outcome("Unexpected", selected.modelId!), {
      persistChild: async (state) => { if (state === "starting") await blocked; }
    });
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [{ providerId: "claude", modelId: "sonnet" }] }) as { token: string };
    const started = await kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }) as { runId: string };
    await kit.invoke(IPC_CHANNELS.workstationDispatchStop, { runId: started.runId });
    release!();
    await waitUntil(asyncDoneFlag(kit.invoke, started.runId));
    expect(kit.runner).not.toHaveBeenCalled();
    const board = await kit.invoke(IPC_CHANNELS.workstationDispatchPoll, { runId: started.runId }) as { lanes: readonly { state: string }[] };
    expect(board.lanes[0]?.state).toBe("stopped");
  });

  it("invalidates a parent during receipt admission when its owner closes", async () => {
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const kit = setup(async ({ review: selected }) => outcome("Unexpected", selected.modelId!), {
      persistParent: async () => blocked
    });
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [{ providerId: "claude", modelId: "sonnet" }] }) as { token: string };
    const starting = kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token });
    await kit.lifecycle.cancelOwner(owner);
    release!();
    await expect(starting).rejects.toThrow(/closed before dispatch/u);
    expect(kit.runner).not.toHaveBeenCalled();
  });

  it("does not launch a second child after the owner disappears between lanes", async () => {
    let finishFirst: ((value: NativeAskOutcome & { readonly turnId: string | null }) => void) | null = null;
    const first = new Promise<NativeAskOutcome & { readonly turnId: string | null }>((resolve) => { finishFirst = resolve; });
    const kit = setup(async ({ review: selected }) => selected.providerId === "claude"
      ? first : outcome("Unexpected", selected.modelId!));
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [
        { providerId: "claude", modelId: "sonnet" }, { providerId: "codex", modelId: "gpt-5-codex" }
      ] }) as { token: string };
    const started = await kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }) as { runId: string };
    await kit.lifecycle.cancelOwner(owner);
    finishFirst!(outcome("First settled", "sonnet"));
    await waitUntil(asyncDoneFlag(kit.invoke, started.runId));
    expect(kit.runner).toHaveBeenCalledTimes(1);
    const board = await kit.invoke(IPC_CHANNELS.workstationDispatchPoll, { runId: started.runId }) as { lanes: readonly { state: string }[] };
    expect(board.lanes[1]?.state).toBe("stopped");
  });

  it("global Stop cancels a queued child while the first child is active", async () => {
    let finishFirst: ((value: NativeAskOutcome & { readonly turnId: string | null }) => void) | null = null;
    const first = new Promise<NativeAskOutcome & { readonly turnId: string | null }>((resolve) => { finishFirst = resolve; });
    const kit = setup(async ({ review: selected }) => selected.providerId === "claude"
      ? first : outcome("Unexpected", selected.modelId!));
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [
        { providerId: "claude", modelId: "sonnet" }, { providerId: "codex", modelId: "gpt-5-codex" }
      ] }) as { token: string };
    const started = await kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }) as { runId: string };
    expect(await kit.lifecycle.stopActive()).toBe(true);
    finishFirst!(outcome("First settled", "sonnet"));
    await waitUntil(asyncDoneFlag(kit.invoke, started.runId));
    expect(kit.runner).toHaveBeenCalledTimes(1);
  });

  it("global Stop between child receipts prevents the next dispatch", async () => {
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let firstAnswered = false;
    const kit = setup(async ({ review: selected }) => outcome("Answer", selected.modelId!), {
      persistChild: async (state) => {
        if (state === "answered" && !firstAnswered) { firstAnswered = true; await blocked; }
      }
    });
    const prepared = await kit.invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId,
      brief: "Review the brief", selections: [
        { providerId: "claude", modelId: "sonnet" }, { providerId: "codex", modelId: "gpt-5-codex" }
      ] }) as { token: string };
    const started = await kit.invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }) as { runId: string };
    await waitUntil(() => firstAnswered);
    expect(await kit.lifecycle.stopActive()).toBe(true);
    release!();
    await waitUntil(asyncDoneFlag(kit.invoke, started.runId));
    expect(kit.runner).toHaveBeenCalledTimes(1);
  });
});

function asyncDoneFlag(invoke: (channel: string, input: unknown) => Promise<unknown>, runId: string): () => boolean {
  let done = false;
  void (async () => {
    for (let i = 0; i < 100 && !done; i += 1) {
      const board = await invoke(IPC_CHANNELS.workstationDispatchPoll, { runId }) as { done: boolean };
      done = board.done;
      if (!done) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  return () => done;
}
