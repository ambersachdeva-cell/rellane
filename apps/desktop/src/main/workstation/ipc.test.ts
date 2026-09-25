import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../book/schema.js";
import { saveWorkstationProject } from "./projects.js";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installWorkstationIpc,
  WORKSTATION_GRAPH_PREPARE_CHANNEL,
  WORKSTATION_GRAPH_RECONCILE_CHANNEL,
  WORKSTATION_GRAPH_START_CHANNEL,
  WORKSTATION_GRAPH_STOP_CHANNEL
} from "./ipc.js";
import type { NativeAskOutcome } from "./types.js";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
  prepare: vi.fn(async () => ({ token: "reviewed" })), start: vi.fn(),
  stop: vi.fn(), decide: vi.fn(), recover: vi.fn(), awaitTerminal: vi.fn(),
  prepareGraphNode: vi.fn(), startGraphNode: vi.fn(), stopGraphNode: vi.fn(), reconcileGraphHostRuns: vi.fn(async () => 0),
  filesWorkspace: vi.fn(async () => ({ id: "case:case-1", label: "Work files", path: "/data/work-files" })),
  showItemInFolder: vi.fn(), isDirectory: vi.fn(() => true),
  providers: vi.fn(async () => [{ id: "codex", label: "Codex", state: "detected" }]),
  askOnce: vi.fn(), appendTurn: vi.fn(() => "draft-turn"),
  persistParent: vi.fn(), persistChild: vi.fn(), recoverParent: vi.fn(() => null),
  registerParentStop: vi.fn(() => () => {}), snapshotsForOwner: vi.fn(() => []),
  liveSnapshots: vi.fn(() => []), stopAllFromPhone: vi.fn(async () => ({ parents: 0, sessions: 0, failures: 0 })),
  invalidate: vi.fn(), shutdown: vi.fn(async () => {}),
  assertProjectIdle: vi.fn(), invalidateProjectReviews: vi.fn(),
  readPageSource: vi.fn(async (url: string) => ({ status: "read", source: "<html><title>Source</title><article><p>Evidence for the question.</p></article></html>", finalUrl: url, mime: "text/html", bytes: 85, truncated: false }))
}));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, fn: typeof fixture.handlers extends Map<string, infer T> ? T : never) => fixture.handlers.set(name, fn) }, dialog: {}, shell: {showItemInFolder: fixture.showItemInFolder} }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: async () => ({isDirectory: fixture.isDirectory})
}));
vi.mock("./service.js", () => ({
  workspaceFolderName: () => "fixture",
  WorkstationHost: class {
    prepare = fixture.prepare; start = fixture.start; stop = fixture.stop; awaitTerminal = fixture.awaitTerminal;
    prepareGraphNode = fixture.prepareGraphNode; startGraphNode = fixture.startGraphNode;
    stopGraphNode = fixture.stopGraphNode; reconcileGraphHostRuns = fixture.reconcileGraphHostRuns;
    decide = fixture.decide; recover = fixture.recover; filesWorkspace = fixture.filesWorkspace;
    providers = fixture.providers; askOnce = fixture.askOnce;
    registerParentStop = fixture.registerParentStop; snapshotsForOwner = fixture.snapshotsForOwner;
    liveSnapshots = fixture.liveSnapshots; stopAllFromPhone = fixture.stopAllFromPhone;
    invalidate = fixture.invalidate; shutdown = fixture.shutdown;
    assertProjectIdle = fixture.assertProjectIdle; invalidateProjectReviews = fixture.invalidateProjectReviews;
  }
}));
vi.mock("../book/cases.js", async importOriginal => ({
  ...await importOriginal<typeof import("../book/cases.js")>(),
  turnsFor: () => [], appendTurn: fixture.appendTurn
}));
vi.mock("./web-read.js", async importOriginal => ({
  ...await importOriginal<typeof import("./web-read.js")>(), readPageSource: fixture.readPageSource
}));
vi.mock("./compare-run-store.js", () => ({
  saveCompareParent: vi.fn(), saveCompareChild: vi.fn(), recoveredCompareBoard: vi.fn(() => null)
}));
vi.mock("./reviewed-parent-store.js", () => ({
  saveReviewedParent: fixture.persistParent, saveReviewedChild: fixture.persistChild,
  recoverReviewedParent: fixture.recoverParent
}));

function setup(trusted = true, withBook = false, actualBook?: DatabaseSync) {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;
  installWorkstationIpc({
    getWindow: () => null, userData: () => "/unused",
    book: () => actualBook ?? (withBook ? ({ exec: () => {} } as unknown as DatabaseSync) : (() => { throw new Error("Not needed in a boundary test"); })()),
    assertTrusted: () => { if (!trusted) throw new Error("Untrusted window"); }
  });
  return (channel: string, input: unknown) => fixture.handlers.get(channel)!(event, input);
}
const valid = { caseId: "case-1", providerId: "codex", modelId: "gpt-5-codex", prompt: "Draft a reply.", sourceTurnIds: ["11111111-1111-4111-8111-111111111111"] };

const reviewedChild = (prompt = "Exact reviewed prompt") => ({
  token: "a".repeat(64), caseId: "case-1", providerId: "codex", providerLabel: "Codex",
  modelId: "gpt-5-codex", prompt, contextPreview: prompt, sourceIds: [], sourceHash: "sha256",
  workspace: { id: "private", label: "Private", path: "/data/work-files" },
  expiresAt: Date.now() + 60_000, resumeSessionId: null, contextSnapshotId: "snapshot-1"
});

beforeEach(() => {
  vi.clearAllMocks(); fixture.handlers.clear(); fixture.isDirectory.mockReturnValue(true);
  fixture.providers.mockResolvedValue([{ id: "codex", label: "Codex", state: "detected" }]);
  fixture.prepare.mockResolvedValue(reviewedChild());
  fixture.start.mockResolvedValue({ caseId: "case-1", providerId: "codex", modelId: "gpt-5-codex", operationId: "operation-1" });
  fixture.awaitTerminal.mockResolvedValue({ caseId: "case-1", providerId: "codex", modelId: "gpt-5-codex",
    operationId: "operation-1", status: "completed", text: "Verified answer", sessionId: "native-session",
    answerTurnId: "answer-turn", detail: "Completed", reportedModelId: "actual-model" });
});

const native = (finishReason: NativeAskOutcome["finishReason"], text: string): NativeAskOutcome => ({
  finishReason, text, sessionId: "native-session", requestedModelId: null, cancellationRequested: false, resultSource: "worker",
  reportedModelId: "actual-model", detail: "Provider said why."
});

async function settled(invoke: (channel: string, input: unknown) => Promise<unknown>, channel: string, runId: string, done: (view: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let n = 0; n < 30; n++) {
    const view = await invoke(channel, { runId }) as Record<string, unknown>;
    if (done(view)) return view;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Run did not settle.");
}
describe("the real renderer-to-native boundary", () => {
  it("registers the trusted project policy and read-only Solo advice channels", () => {
    setup();
    expect(fixture.handlers.has(IPC_CHANNELS.workstationModelPreferencesRead)).toBe(true);
    expect(fixture.handlers.has(IPC_CHANNELS.workstationModelPreferencesSave)).toBe(true);
    expect(fixture.handlers.has(IPC_CHANNELS.workstationModelPreferencesForget)).toBe(true);
    expect(fixture.handlers.has(IPC_CHANNELS.workstationSoloModelAdvice)).toBe(true);
  });

  it("wires governed Book memory through production IPC and fences active mutation", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const project = saveWorkstationProject(db, { title: "Project", brief: "Brief" });
      const invoke = setup(true, true, db);
      expect(fixture.handlers.has(IPC_CHANNELS.workstationMemoryGoverned)).toBe(true);
      expect(fixture.handlers.has(IPC_CHANNELS.workstationMemoryConflicts)).toBe(true);
      const proposed = await invoke(IPC_CHANNELS.workstationMemoryGoverned, {
        action: "propose", projectId: project.id, kind: "exclusion", text: "Never disclose this exact phrase."
      }) as { epoch: number; items: readonly { id: string; headRevision: number; candidate: { text: string } | null }[] };
      expect(proposed.items[0]?.candidate?.text).toBe("Never disclose this exact phrase.");
      expect(fixture.assertProjectIdle).toHaveBeenCalledWith(project.id);
      expect(fixture.invalidateProjectReviews).toHaveBeenCalledWith(project.id);
      const approved = await invoke(IPC_CHANNELS.workstationMemoryGoverned, {
        action: "review", projectId: project.id, id: proposed.items[0]!.id,
        expectedRevision: proposed.items[0]!.headRevision, decision: "approve"
      }) as { items: readonly { active: { text: string } | null; headRevision: number }[] };
      expect(approved.items[0]?.active?.text).toBe("Never disclose this exact phrase.");
      const read = await invoke(IPC_CHANNELS.workstationMemoryGoverned, { action: "read", projectId: project.id }) as typeof approved;
      expect(read.items[0]?.active?.text).toBe("Never disclose this exact phrase.");
      const conflicts = await invoke(IPC_CHANNELS.workstationMemoryConflicts, {
        action: "read", projectId: project.id
      }) as { authority: { status: string; included?: readonly { id: string }[] } };
      expect(conflicts.authority).toMatchObject({
        status: "ready", included: [{ id: proposed.items[0]!.id }]
      });
      fixture.assertProjectIdle.mockImplementationOnce(() => { throw new Error("Stop this project's workstation session"); });
      await expect(invoke(IPC_CHANNELS.workstationMemoryGoverned, {
        action: "forget", projectId: project.id, id: proposed.items[0]!.id,
        expectedRevision: approved.items[0]!.headRevision
      })).rejects.toThrow(/Stop this project's workstation session/u);
      const forgotten = await invoke(IPC_CHANNELS.workstationMemoryGoverned, {
        action: "forget", projectId: project.id, id: proposed.items[0]!.id,
        expectedRevision: approved.items[0]!.headRevision
      }) as { items: readonly unknown[] };
      expect(forgotten.items).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("routes a reviewed Compare child through host start and its terminal result", async () => {
    const fakeReview = { token: "a".repeat(64), caseId: "case-1",
      providerId: "codex", providerLabel: "Codex", modelId: "gpt-5-codex",
      prompt: "Compare evidence", contextPreview: "exact packet", sourceIds: [],
      sourceHash: "sha256", workspace: { id: "private", label: "Private", path: "/data/work-files" },
      expiresAt: Date.now() + 60_000, resumeSessionId: null, contextSnapshotId: "snapshot-1" };
    fixture.prepare.mockResolvedValueOnce(fakeReview);
    fixture.start.mockResolvedValueOnce({ caseId: "case-1", providerId: "codex",
      modelId: "gpt-5-codex", operationId: "operation-1" });
    fixture.awaitTerminal.mockResolvedValueOnce({ caseId: "case-1", providerId: "codex",
      modelId: "gpt-5-codex", operationId: "operation-1", status: "completed",
      text: "Verified result", sessionId: "native-session", answerTurnId: "answer-turn",
      detail: "Completed", reportedModelId: "actual-model" });
    const invoke = setup(true, true);
    const prepared = await invoke(IPC_CHANNELS.workstationDispatchPrepare, { caseId: "case-1",
      brief: "Compare evidence", selections: [{ providerId: "codex", modelId: "gpt-5-codex" }],
      sourceTurnIds: [] }) as { token: string };
    expect(fixture.askOnce).not.toHaveBeenCalled();
    const started = await invoke(IPC_CHANNELS.workstationDispatchStart, { token: prepared.token }) as { runId: string };
    const board = await settled(invoke, IPC_CHANNELS.workstationDispatchPoll, started.runId, view => view["done"] === true);
    const lane = (board["lanes"] as readonly Record<string, unknown>[])[0]!;
    expect(lane).toMatchObject({ state: "answered", answerTurnId: "answer-turn", chars: 15 });
    expect(fixture.start).toHaveBeenCalledWith({ token: "a".repeat(64) }, expect.any(Object), expect.any(AbortSignal));
    expect(fixture.awaitTerminal).toHaveBeenCalledWith("case-1", "operation-1", expect.any(Object), expect.any(AbortSignal), expect.any(Function));
    expect(fixture.askOnce).not.toHaveBeenCalled();
  });

  it("routes Crew through exact review and treats an empty terminal answer as failure", async () => {
    fixture.awaitTerminal.mockResolvedValueOnce({ caseId: "case-1", providerId: "codex",
      modelId: "gpt-5-codex", operationId: "operation-1", status: "completed",
      text: "   ", sessionId: "native-session", answerTurnId: null, detail: "Completed" });
    const invoke = setup(true, true);
    const prepared = await invoke(IPC_CHANNELS.workstationCrewPrepare, {
      caseId: "case-1", request: "One part", integrationOwner: "a", parts: [
        { id: "a", title: "First", role: "Analyst", work: "First",
          expectedOutput: "One answer", providerId: "codex",
          modelId: "gpt-5-codex", seatLabel: "Codex", dependsOn: [] }
      ]
    }) as { token: string; reviews: readonly { contextPreview: string }[] };
    expect(prepared.reviews[0]?.contextPreview).toBe("Exact reviewed prompt");
    expect(fixture.start).not.toHaveBeenCalled();
    const started = await invoke(IPC_CHANNELS.workstationCrewStart, { token: prepared.token }) as { runId: string };
    const board = await settled(invoke, IPC_CHANNELS.workstationCrewPoll, started.runId, view => view["round"] === "failed");
    const parts = board["parts"] as readonly Record<string, unknown>[];
    expect(parts[0]!["state"]).toBe("failed");
    expect(fixture.start).toHaveBeenCalledWith({ token: "a".repeat(64) }, expect.any(Object), expect.any(AbortSignal));
    expect(fixture.persistParent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "crew" }));
    expect(fixture.askOnce).not.toHaveBeenCalled();
  });

  it("runs Step Agent only after exact review and records a failed native result", async () => {
    fixture.awaitTerminal.mockResolvedValueOnce({ caseId: "case-1", providerId: "codex",
      modelId: "gpt-5-codex", operationId: "operation-1", status: "failed",
      text: "A useful partial thought", sessionId: "native-session", answerTurnId: null,
      detail: "Provider denied", reportedModelId: "actual-model" });
    const invoke = setup(true, true);
    const prepared = await invoke(IPC_CHANNELS.workstationAgentPrepare, {
      caseId: "case-1", goal: "Read the source", providerId: "codex", modelId: "gpt-5-codex",
      sourceTurnIds: []
    }) as { token: string; reviews: readonly { contextPreview: string }[] };
    expect(prepared.reviews).toHaveLength(1);
    expect(fixture.start).not.toHaveBeenCalled();
    const started = await invoke(IPC_CHANNELS.workstationAgentStart, { token: prepared.token }) as { runId: string };
    const view = await settled(invoke, IPC_CHANNELS.workstationAgentPoll, started.runId, result => result["state"] === "failed");
    expect(view["answer"]).toBeUndefined();
    expect(view["steps"]).toEqual([expect.objectContaining({ answer: "A useful partial thought" })]);
    expect(fixture.persistChild).toHaveBeenCalledWith(expect.anything(), "case-1", expect.objectContaining({
      kind: "agent", state: "failed", answerTurnId: null
    }));
    expect(fixture.askOnce).not.toHaveBeenCalled();
  });

  it("runs Research only after an explicit source and review", async () => {
    fixture.awaitTerminal.mockResolvedValueOnce({ caseId: "case-1", providerId: "codex",
      modelId: "gpt-5-codex", operationId: "operation-1", status: "failed",
      text: "Unfinished source notes", sessionId: "native-session", answerTurnId: null,
      detail: "Provider failed", reportedModelId: "actual-model" });
    const invoke = setup(true, true);
    const prepared = await invoke(IPC_CHANNELS.workstationResearchPrepare, {
      caseId: "case-1", question: "What happened?", urls: ["https://example.com/report"],
      depth: "quick", providerId: "codex", modelId: "gpt-5-codex", sourceTurnIds: []
    }) as { token: string; reviews: readonly { contextPreview: string }[] };
    expect(prepared.reviews).toHaveLength(1);
    expect(fixture.start).not.toHaveBeenCalled();
    const started = await invoke(IPC_CHANNELS.workstationResearchStart, { token: prepared.token }) as { runId: string };
    const view = await settled(invoke, IPC_CHANNELS.workstationResearchPoll, started.runId, result => result["state"] === "failed");
    expect(view["answer"]).toBeNull();
    expect(fixture.persistChild).toHaveBeenCalledWith(expect.anything(), "case-1", expect.objectContaining({
      kind: "research", state: "failed", answerTurnId: null
    }));
    expect(fixture.askOnce).not.toHaveBeenCalled();
  });
  it("selects a host-resolved directory in Finder without opening model-supplied paths", async () => {
    const invoke = setup();
    await expect(invoke(IPC_CHANNELS.workstationRevealWorkspace, {caseId: "case-1"})).resolves.toMatchObject({path: "/data/work-files"});
    expect(fixture.filesWorkspace).toHaveBeenCalledWith("case-1", undefined, expect.any(Object));
    expect(fixture.showItemInFolder).toHaveBeenCalledExactlyOnceWith("/data/work-files");
    fixture.showItemInFolder.mockClear(); fixture.filesWorkspace.mockClear();
    for (const input of [{caseId: "case-1", path: "/tmp/program.app"}, {caseId: "case-1", workspaceId: "/tmp"}])
      await expect(invoke(IPC_CHANNELS.workstationRevealWorkspace, input)).rejects.toThrow();
    expect(fixture.filesWorkspace).not.toHaveBeenCalled();
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });
  it("refuses untrusted windows and a folder replaced by a file or symlink", async () => {
    await expect(setup(false)(IPC_CHANNELS.workstationRevealWorkspace, {caseId: "case-1"})).rejects.toThrow("Untrusted");
    expect(fixture.filesWorkspace).not.toHaveBeenCalled();
    fixture.isDirectory.mockReturnValue(false);
    await expect(setup()(IPC_CHANNELS.workstationRevealWorkspace, {caseId: "case-1"})).rejects.toThrow("moved or replaced");
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });
  it("passes a valid request and document owner to the host", async () => {
    const invoke = setup();
    await expect(invoke(IPC_CHANNELS.workstationPrepare, valid)).resolves.toMatchObject({ token: "a".repeat(64) });
    expect(fixture.prepare).toHaveBeenCalledWith(valid, expect.any(Object));
  });
  it("refuses untrusted windows before reading or preparing anything", async () => {
    await expect(setup(false)(IPC_CHANNELS.workstationPrepare, valid)).rejects.toThrow("Untrusted");
    expect(fixture.recover).not.toHaveBeenCalled(); expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("refuses unreviewable paths, providers, models and source lists before the host", async () => {
    const invoke = setup();
    for (const changes of [{ cwd: "/Users/owner" }, { skipPermissions: true }, { providerId: "gemini4" },
      { modelId: "--dangerously-skip" }, { modelId: "opus; touch file" }, { prompt: " " },
      { prompt: "a".repeat(8001) }, { sourceTurnIds: [...valid.sourceTurnIds, ...valid.sourceTurnIds] },
      { sourceTurnIds: ["not-a-source"] }, { workspaceId: "/Users/owner" }]) {
      await expect(invoke(IPC_CHANNELS.workstationPrepare, { ...valid, ...changes })).rejects.toThrow();
    }
    expect(fixture.prepare).not.toHaveBeenCalled();
    const { modelId: _modelId, ...withoutModel } = valid;
    await expect(invoke(IPC_CHANNELS.workstationPrepare, withoutModel)).rejects.toThrow();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("allows start to carry only a one-use host token", async () => {
    const invoke = setup(); const token = "a".repeat(64);
    await invoke(IPC_CHANNELS.workstationStart, { token });
    expect(fixture.start).toHaveBeenCalledWith({ token }, expect.any(Object));
    fixture.start.mockClear();
    for (const input of [{ token: "guess" }, { token, caseId: "case-1" }, { token, always: true }])
      await expect(invoke(IPC_CHANNELS.workstationStart, input)).rejects.toThrow();
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("requires exact operation ids and a boolean for tool decisions", async () => {
    const invoke = setup(); const operationId = "44444444-4444-4444-8444-444444444444";
    await invoke(IPC_CHANNELS.workstationDecide, { operationId, permissionId: "exec-1", allow: false });
    expect(fixture.decide).toHaveBeenCalledWith(operationId, "exec-1", false, expect.any(Object));
    fixture.decide.mockClear();
    await expect(invoke(IPC_CHANNELS.workstationStop, { caseId: "case-1", operationId: "latest" })).rejects.toThrow();
    for (const changes of [{ allow: "yes" }, { always: true }])
      await expect(invoke(IPC_CHANNELS.workstationDecide, { operationId, permissionId: "exec-1", allow: true, ...changes })).rejects.toThrow();
    expect(fixture.decide).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled();
  });

  it("wires graph prepare, start, stop, and reconcile channels with strict schema validation", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const invoke = setup(true, true, db);
      const runId = "11111111-1111-4111-8111-111111111111";
      const nodeId = "22222222-2222-4222-8222-222222222222";
      const attemptId = "33333333-3333-4333-8333-333333333333";
      const token = "b".repeat(64);
      const operationId = "44444444-4444-4444-8444-444444444444";
      fixture.prepareGraphNode.mockResolvedValueOnce({ token, runId, nodeId, attemptId });
      fixture.startGraphNode.mockResolvedValueOnce({ run: { id: runId } });
      fixture.stopGraphNode.mockResolvedValueOnce({ stopped: true });
      fixture.reconcileGraphHostRuns.mockResolvedValueOnce(1);

      await expect(invoke(WORKSTATION_GRAPH_PREPARE_CHANNEL, { runId, nodeId, attemptId })).resolves.toMatchObject({ token });
      expect(fixture.prepareGraphNode).toHaveBeenCalledWith({ runId, nodeId, attemptId }, expect.any(Object));

      await expect(invoke(WORKSTATION_GRAPH_START_CHANNEL, { token })).resolves.toMatchObject({ run: { id: runId } });
      expect(fixture.startGraphNode).toHaveBeenCalledWith({ token }, expect.any(Object));

      await expect(invoke(WORKSTATION_GRAPH_STOP_CHANNEL, { caseId: "case-1", operationId })).resolves.toEqual({ stopped: true });
      expect(fixture.stopGraphNode).toHaveBeenCalledWith("case-1", operationId, expect.any(Object));

      await expect(invoke(WORKSTATION_GRAPH_RECONCILE_CHANNEL, {})).resolves.toBe(1);
      expect(fixture.reconcileGraphHostRuns).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("wires selfCheck, portableWorkspace, and recovery channels on the trusted IPC boundary", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const invoke = setup(true, true, db);

      const facts = await invoke(IPC_CHANNELS.workstationSelfCheck, {}) as { bookOpen: boolean; providersDetected: readonly { id: string }[] };
      expect(facts.bookOpen).toBe(true);
      expect(facts.providersDetected).toEqual([{ id: "codex", label: "Codex" }]);

      const exported = await invoke(IPC_CHANNELS.workstationPortableWorkspace, {
        action: "export",
        input: {
          schemaVersion: 1,
          workspaceId: "ws-ipc-1",
          title: "IPC Operator Pack",
          summary: "Clean portable workspace",
          revision: 1,
          createdAt: "2026-09-25T10:00:00.000Z",
          dependencies: [],
          steps: [],
          editableOutputs: []
        }
      }) as { workspaceId: string; manifestDigestSha256: string };
      expect(exported.workspaceId).toBe("ws-ipc-1");
      expect(exported.manifestDigestSha256).toHaveLength(64);

      const verified = await invoke(IPC_CHANNELS.workstationPortableWorkspace, {
        action: "verify",
        definition: exported
      });
      expect(verified).toEqual({ valid: true });

      const preflight = await invoke(IPC_CHANNELS.workstationRecovery, { action: "preflight" }) as {
        quiescenceCoverageComplete: boolean;
        quiescenceCoverageTrusted: boolean;
      };
      expect(preflight.quiescenceCoverageComplete).toBe(true);
      expect(preflight.quiescenceCoverageTrusted).toBe(true);
    } finally {
      db.close();
    }
  });
});
