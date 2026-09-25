import { describe, expect, it, vi } from "vitest";
import type { WorkstationSnapshot, WorkstationReview } from "@cadrane/contracts";
import { installRemoteHostBridge } from "./remote-host-bridge.js";
import type { RemoteDecisionHandler, RemoteDispatchHandler, RemotePrepareHandler,
  RemotePrincipalRevocationHandler, RemoteStateHandler, RemoteStopHandler,
  RemoteDispatchServer, RemoteOneRunHandoverScope } from "./remote-dispatch-server.js";

const review: WorkstationReview = {
  token: "a".repeat(64), caseId: "case-a", providerId: "claude", providerLabel: "Claude",
  modelId: "sonnet", prompt: "Exact request", contextPreview: "Exact context",
  sourceIds: ["source-a"], sourceHash: "hash-a", contextSnapshotId: "context-a",
  workspace: { id: "case:case-a", label: "Private", path: "/tmp/private-case-a" },
  expiresAt: Date.now() + 60_000, resumeSessionId: null
};

function harness() {
  let prepare!: RemotePrepareHandler;
  let dispatch!: RemoteDispatchHandler;
  let decide!: RemoteDecisionHandler;
  let stop!: RemoteStopHandler;
  let state!: RemoteStateHandler;
  let revoke!: RemotePrincipalRevocationHandler;
  let handoverReview: (RemoteOneRunHandoverScope & { token: string; expiresAt: number; generation: number }) | null = null;
  const server = {
    onPrepare: (handler: RemotePrepareHandler) => { prepare = handler; },
    onDispatch: (handler: RemoteDispatchHandler) => { dispatch = handler; },
    onDecision: (handler: RemoteDecisionHandler) => { decide = handler; },
    onStop: (handler: RemoteStopHandler) => { stop = handler; },
    onState: (handler: RemoteStateHandler) => { state = handler; },
    onRevokePrincipal: (handler: RemotePrincipalRevocationHandler) => { revoke = handler; },
    pairedPrincipals: () => ["principal-a", "principal-b"],
    prepareOneRunHandover: (input: RemoteOneRunHandoverScope) => {
      handoverReview = { ...input, token: "h".repeat(64), expiresAt: Date.now() + 60_000, generation: 1 };
      return handoverReview;
    },
    commitOneRunHandover: (token: string, transfer: (scope: RemoteOneRunHandoverScope) => void) => {
      if (!handoverReview || token !== handoverReview.token) throw new Error("Used handover review");
      const scope = handoverReview; handoverReview = null;
      transfer(scope);
      void revoke({ principalId: scope.oldPrincipalId, reason: "replaced" });
      return scope;
    }
  } as unknown as RemoteDispatchServer;
  const snapshots = new Map<object, WorkstationSnapshot[]>();
  const host = {
    prepare: vi.fn(async (_input: unknown, _owner: object, _policy: unknown) => review),
    start: vi.fn(async (_input: unknown, _owner: object, _signal?: AbortSignal) =>
      ({ operationId: "operation-a", caseId: "case-a" })),
    snapshotsForOwner: vi.fn((owner: object) => snapshots.get(owner) ?? []),
    decide: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
    invalidate: vi.fn(),
    handoverActiveRun: vi.fn((caseId: string, operationId: string, oldOwner: object, newOwner: object) => {
      const current = snapshots.get(oldOwner) ?? [];
      const selected = current.find((entry) => entry.caseId === caseId && entry.operationId === operationId);
      if (!selected) throw new Error("Wrong handover owner or operation");
      snapshots.set(oldOwner, current.filter((entry) => entry !== selected));
      snapshots.set(newOwner, [selected]);
      return selected;
    })
  };
  const bridge = installRemoteHostBridge(server, host as unknown as Parameters<typeof installRemoteHostBridge>[1]);
  return { handlers: { prepare: () => prepare, dispatch: () => dispatch, decide: () => decide,
    stop: () => stop, state: () => state, revoke: () => revoke }, host, snapshots, bridge };
}

describe("remote host bridge", () => {
  it("prepares explicit choices, then starts only the shown token for the same principal", async () => {
    const kit = harness();
    const prepared = await kit.handlers.prepare()({ requestId: "p1", caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: ["source-a"] }, "principal-a");
    expect(prepared).toMatchObject({ status: "accepted", review });
    expect(kit.host.start).not.toHaveBeenCalled();
    const owner = kit.host.prepare.mock.calls[0]![1];
    expect(kit.host.prepare).toHaveBeenCalledWith({ caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: ["source-a"] }, owner, { freshSession: true });

    const started = await kit.handlers.dispatch()({ requestId: "d1", reviewToken: review.token }, "principal-a");
    expect(started).toMatchObject({ status: "accepted", operationId: "operation-a" });
    expect(kit.host.start).toHaveBeenCalledWith({ token: review.token }, owner, expect.any(AbortSignal));
  });

  it("returns the full host packet without starting a provider before Start", async () => {
    const kit = harness();
    const packet: WorkstationReview = {
      ...review,
      token: "b".repeat(64),
      contextPreview: "Exact selected source text\nApproved constraint: do not spend money",
      sourceHash: "sha256-of-exact-packet",
      sourceIds: ["source-a", "source-b"],
      projectId: "project-a",
      memoryEpoch: 4,
      contextSnapshotId: "snapshot-a",
      tools: {
        enabled: true, toolNames: ["read_source"], skillIds: ["skill-a"],
        sources: [{ label: "Source A", chars: 99 }], totalSourceChars: 99,
        reachNote: "Only selected sources", freshSessionNote: "New session"
      }
    };
    kit.host.prepare.mockResolvedValueOnce(packet);
    const result = await kit.handlers.prepare()({ requestId: "full", caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: ["source-a", "source-b"],
      enableTools: true, workspaceId: "case:case-a" }, "principal-a");
    expect(result).toEqual({ status: "accepted", review: packet });
    expect(kit.host.prepare).toHaveBeenCalledWith({ caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: ["source-a", "source-b"],
      enableTools: true, workspaceId: "case:case-a" }, expect.any(Object), { freshSession: true });
    expect(kit.host.start).not.toHaveBeenCalled();
  });

  it("refuses an older review, a foreign owner, and reuse before calling the host", async () => {
    const kit = harness();
    const first = { ...review, token: "1".repeat(64) };
    const second = { ...review, token: "2".repeat(64) };
    kit.host.prepare.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const request = { requestId: "p1", caseId: "case-a", providerId: "claude" as const,
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: [] };
    await kit.handlers.prepare()(request, "principal-a");
    await kit.handlers.prepare()({ ...request, requestId: "p2" }, "principal-a");
    expect(await kit.handlers.dispatch()({ requestId: "old", reviewToken: first.token }, "principal-a"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.dispatch()({ requestId: "foreign", reviewToken: second.token }, "principal-b"))
      .toMatchObject({ status: "rejected" });
    expect(kit.host.start).not.toHaveBeenCalled();
    expect(await kit.handlers.dispatch()({ requestId: "current", reviewToken: second.token }, "principal-a"))
      .toMatchObject({ status: "accepted" });
    expect(await kit.handlers.dispatch()({ requestId: "replay", reviewToken: second.token }, "principal-a"))
      .toMatchObject({ status: "rejected" });
    expect(kit.host.start).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired review without calling the host", async () => {
    const kit = harness();
    kit.host.prepare.mockResolvedValueOnce({ ...review, expiresAt: Date.now() - 1 });
    const prepared = await kit.handlers.prepare()({ requestId: "expired", caseId: "case-a",
      providerId: "claude", modelId: "sonnet", prompt: "Exact request", sourceTurnIds: [] }, "principal-a");
    expect(prepared).toMatchObject({ status: "rejected" });
    expect(await kit.handlers.dispatch()({ requestId: "start-expired", reviewToken: review.token }, "principal-a"))
      .toMatchObject({ status: "rejected" });
    expect(kit.host.start).not.toHaveBeenCalled();
  });

  it("does not restore an older review when its preparation finishes last", async () => {
    const kit = harness();
    let finishFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { finishFirst = resolve; });
    const first = { ...review, token: "3".repeat(64) };
    const second = { ...review, token: "4".repeat(64) };
    kit.host.prepare.mockImplementationOnce(async () => { await firstReady; return first; })
      .mockResolvedValueOnce(second);
    const request = { requestId: "first", caseId: "case-a", providerId: "claude" as const,
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: ["source-a"] };
    const pendingFirst = kit.handlers.prepare()(request, "principal-a");
    const preparedSecond = await kit.handlers.prepare()({ ...request, requestId: "second" }, "principal-a");
    expect(preparedSecond).toMatchObject({ status: "accepted", review: second });
    finishFirst();
    expect(await pendingFirst).toMatchObject({ status: "rejected" });
    expect(await kit.handlers.dispatch()({ requestId: "stale", reviewToken: first.token }, "principal-a"))
      .toMatchObject({ status: "rejected" });
    expect(kit.host.start).not.toHaveBeenCalled();
    expect(await kit.handlers.dispatch()({ requestId: "current", reviewToken: second.token }, "principal-a"))
      .toMatchObject({ status: "accepted" });
  });

  it("binds a shown approval to one principal, action and revision; Stop names the exact operation", async () => {
    const kit = harness();
    await kit.handlers.prepare()({ requestId: "p1", caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: [] }, "principal-a");
    const owner = kit.host.prepare.mock.calls[0]![1];
    const snapshot: WorkstationSnapshot = {
      operationId: "operation-a", caseId: "case-a", providerId: "claude", modelId: "sonnet",
      sessionId: null, status: "needs-approval", startedAt: 1, updatedAt: 2,
      text: "", activity: [], permission: { id: "permission-a", title: "Write file", detail: "Write notes.txt" }, detail: ""
    };
    kit.snapshots.set(owner, [snapshot]);
    const state = await kit.handlers.state()( "principal-a");
    expect(state.pendingApprovals).toHaveLength(1);
    const revision = state.pendingApprovals[0]!.revision;
    expect((await kit.handlers.state()( "principal-b")).pendingApprovals).toEqual([]);
    expect(await kit.handlers.decide()({ requestId: "bad", operationId: "operation-a",
      permissionId: "permission-a", revision, allow: true }, "principal-b")).toMatchObject({ status: "rejected" });
    expect(await kit.handlers.decide()({ requestId: "stale", operationId: "operation-a",
      permissionId: "permission-a", revision: "wrong", allow: true }, "principal-a")).toMatchObject({ status: "rejected" });
    expect(kit.host.decide).not.toHaveBeenCalled();
    expect(await kit.handlers.decide()({ requestId: "yes", operationId: "operation-a",
      permissionId: "permission-a", revision, allow: true }, "principal-a")).toMatchObject({ status: "accepted" });
    expect(kit.host.decide).toHaveBeenCalledWith("operation-a", "permission-a", true, owner);
    expect(await kit.handlers.decide()({ requestId: "again", operationId: "operation-a",
      permissionId: "permission-a", revision, allow: true }, "principal-a")).toMatchObject({ status: "rejected" });

    expect(await kit.handlers.stop()({ requestId: "other", operationId: "operation-a" }, "principal-b"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.stop()({ requestId: "stop", operationId: "operation-a" }, "principal-a"))
      .toMatchObject({ status: "accepted", operationId: "operation-a" });
    expect(kit.host.stop).toHaveBeenCalledWith("case-a", "operation-a", owner);
    await kit.handlers.revoke()({ principalId: "principal-a", reason: "expired" });
    expect(kit.host.invalidate).toHaveBeenCalledWith(owner);
  });

  it("invalidates an in-flight start if pairing expires before admission returns", async () => {
    const kit = harness();
    await kit.handlers.prepare()({ requestId: "p1", caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: [] }, "principal-a");
    const owner = kit.host.prepare.mock.calls[0]![1];
    let release!: () => void;
    kit.host.start.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { operationId: "late-operation", caseId: "case-a" };
    });
    const pending = kit.handlers.dispatch()({ requestId: "d1", reviewToken: review.token }, "principal-a");
    await vi.waitFor(() => expect(kit.host.start).toHaveBeenCalledOnce());
    const signal = kit.host.start.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await kit.handlers.revoke()({ principalId: "principal-a", reason: "expired" });
    expect(signal.aborted).toBe(true);
    release();
    expect(await pending).toMatchObject({ status: "uncertain", operationId: "late-operation" });
    expect(kit.host.stop).toHaveBeenCalledWith("case-a", "late-operation", owner);
    expect(kit.host.invalidate).toHaveBeenCalledWith(owner);
    expect(kit.host.invalidate).toHaveBeenCalledTimes(2);
  });

  it("reports the active session when an older completed receipt sorts first", async () => {
    const kit = harness();
    await kit.handlers.prepare()({ requestId: "p1", caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: [] }, "principal-a");
    const owner = kit.host.prepare.mock.calls[0]![1];
    const base: WorkstationSnapshot = { operationId: "old", caseId: "case-old", providerId: "claude",
      modelId: "sonnet", sessionId: null, status: "completed", startedAt: 1,
      updatedAt: 10, text: "", activity: [], permission: null, detail: "" };
    kit.snapshots.set(owner, [base, { ...base, operationId: "live", caseId: "case-live",
      status: "running", updatedAt: 9 }]);
    expect(kit.handlers.state()( "principal-a")).toMatchObject({ isRunning: true,
      operationId: "live", currentTask: "case-live", operationStatus: "running" });
  });

  it("hands over exactly one Mac-approved run with read and Stop authority only", async () => {
    const kit = harness();
    await kit.handlers.prepare()({ requestId: "review", caseId: "case-a", providerId: "claude",
      modelId: "sonnet", prompt: "Exact request", sourceTurnIds: [] }, "principal-a");
    const oldOwner = kit.host.prepare.mock.calls[0]![1];
    const base: WorkstationSnapshot = { operationId: "operation-a", caseId: "case-a",
      providerId: "claude", modelId: "sonnet", sessionId: null, status: "running",
      startedAt: 1, updatedAt: 2, text: "Partial", activity: [], permission: null, detail: "" };
    kit.snapshots.set(oldOwner, [{ ...base, status: "needs-approval",
      permission: { id: "old-permission", title: "Write", detail: "Before transfer" } }]);
    const staleRevision = (await kit.handlers.state()( "principal-a")).pendingApprovals[0]!.revision;
    kit.snapshots.set(oldOwner, [base, { ...base, operationId: "other-operation", caseId: "case-b" }]);
    expect(kit.bridge.handoverCandidates()).toContainEqual({ principalId: "principal-a",
      caseId: "case-a", operationId: "operation-a" });
    const scope = { caseId: "case-a", operationId: "operation-a",
      oldPrincipalId: "principal-a", newPrincipalId: "principal-b" };
    expect(() => kit.bridge.prepareOneRunHandover({ ...scope, operationId: "foreign" }))
      .toThrow(/live run/u);
    const shown = kit.bridge.prepareOneRunHandover(scope);
    expect(kit.host.handoverActiveRun).not.toHaveBeenCalled();
    expect(kit.bridge.approveOneRunHandover(shown.token)).toMatchObject(scope);
    expect(kit.host.handoverActiveRun).toHaveBeenCalledWith("case-a", "operation-a",
      oldOwner, expect.any(Object));
    expect(kit.host.invalidate).toHaveBeenCalledWith(oldOwner);
    expect(() => kit.bridge.approveOneRunHandover(shown.token)).toThrow(/Used handover/u);
    expect(kit.handlers.state()( "principal-b")).toMatchObject({ isRunning: true,
      operationId: "operation-a", pendingApprovals: [] });
    expect(kit.handlers.state()( "principal-a")).toMatchObject({ isRunning: false });
    expect(await kit.handlers.decide()({ requestId: "old-decision", operationId: "operation-a",
      permissionId: "old-permission", revision: staleRevision, allow: true }, "principal-a"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.prepare()({ requestId: "new", caseId: "case-b", providerId: "claude",
      modelId: "sonnet", prompt: "New request", sourceTurnIds: [] }, "principal-b"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.dispatch()({ requestId: "start", reviewToken: review.token }, "principal-b"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.decide()({ requestId: "decision", operationId: "operation-a",
      permissionId: "tool", revision: "stale", allow: true }, "principal-b"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.stop()({ requestId: "second", operationId: "other-operation" }, "principal-b"))
      .toMatchObject({ status: "rejected" });
    expect(await kit.handlers.stop()({ requestId: "exact", operationId: "operation-a" }, "principal-b"))
      .toMatchObject({ status: "accepted" });
    expect(kit.handlers.state()( "principal-b")).toMatchObject({ isRunning: false });
    const newOwner = kit.host.handoverActiveRun.mock.calls[0]![3];
    await kit.handlers.revoke()({ principalId: "principal-b", reason: "shutdown" });
    expect(kit.host.invalidate).toHaveBeenCalledWith(newOwner);
  });
});
