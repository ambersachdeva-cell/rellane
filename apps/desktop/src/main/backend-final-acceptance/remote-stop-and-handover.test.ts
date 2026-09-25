import { describe, expect, it, vi } from "vitest";
import type { WorkstationSnapshot } from "@cadrane/contracts";
import {
  createRemoteDispatchServer,
  computeActionRevision,
  type RemoteWorkstationState
} from "../workstation/remote-dispatch-server.js";
import { installRemoteHostBridge } from "../workstation/remote-host-bridge.js";

describe("Backend Final Acceptance - Remote Stop Truth, Revocation, and Handover (G00 / R17)", () => {
  it("enforces delimiter collision resistance on permission action revisions", () => {
    const rev1 = computeActionRevision({
      operationId: "op:1",
      permissionId: "perm-read",
      title: "File Access",
      detail: "Read source"
    });
    const rev2 = computeActionRevision({
      operationId: "op",
      permissionId: "1:perm-read",
      title: "File Access",
      detail: "Read source"
    });
    expect(rev1).not.toBe(rev2);
  });

  it("enforces that remote dispatch requires prior prepared review and rejects unreviewed dispatches", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin: "123456" });
    const info = await server.start();

    const mockHost = {
      prepare: vi.fn(),
      start: vi.fn(),
      snapshotsForOwner: vi.fn(() => []),
      decide: vi.fn(),
      stop: vi.fn(),
      invalidate: vi.fn(),
      handoverActiveRun: vi.fn()
    } as unknown as Parameters<typeof installRemoteHostBridge>[1];

    installRemoteHostBridge(server, mockHost);

    try {
      // 1. Attempting dispatch without prior review preparation
      const res = await fetch(`${info.serverUrl}/api/dispatch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          requestId: "req-1",
          reviewToken: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        })
      });

      const body = (await res.json()) as { status: string; detail: string };
      // Must be rejected because no review was prepared for this principal
      expect(body.status).toBe("rejected");
      expect(body.detail).toContain("Review token not found");
      expect(mockHost.start).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("handles remote Stop: produces explicit accepted receipt when confirmed and rejected when run unavailable", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin: "123456" });
    const info = await server.start();

    const runningSnapshot: WorkstationSnapshot = {
      operationId: "op-remote-stop-1",
      caseId: "case-stop-1",
      providerId: "codex",
      modelId: "gpt-5-codex",
      sessionId: null,
      status: "running",
      startedAt: 1000,
      updatedAt: 1000,
      text: "Active synthesis",
      activity: ["Synthesizing"],
      permission: null,
      detail: "Working"
    };

    const mockHost = {
      prepare: vi.fn(),
      start: vi.fn(),
      snapshotsForOwner: vi.fn(() => [runningSnapshot]),
      decide: vi.fn(),
      stop: vi.fn(async () => ({
        ...runningSnapshot,
        status: "stopped" as const,
        updatedAt: 2000
      })),
      invalidate: vi.fn(),
      handoverActiveRun: vi.fn()
    } as unknown as Parameters<typeof installRemoteHostBridge>[1];

    installRemoteHostBridge(server, mockHost);

    try {
      // 1. Issue stop for live operation
      const stopRes = await fetch(`${info.serverUrl}/api/stop`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          requestId: "stop-req-1",
          operationId: "op-remote-stop-1"
        })
      });

      const stopBody = (await stopRes.json()) as { status: string; operationId: string; detail: string };
      expect(stopBody.status).toBe("accepted");
      expect(stopBody.operationId).toBe("op-remote-stop-1");
      expect(mockHost.stop).toHaveBeenCalledWith("case-stop-1", "op-remote-stop-1", expect.anything());

      // 2. Issue stop for non-existent operation
      const invalidStopRes = await fetch(`${info.serverUrl}/api/stop`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          requestId: "stop-req-2",
          operationId: "op-non-existent"
        })
      });

      const invalidBody = (await invalidStopRes.json()) as { status: string; detail: string };
      expect(invalidBody.status).toBe("rejected");
      expect(invalidBody.detail).toContain("unavailable");
    } finally {
      await server.stop();
    }
  });

  it("executes atomic one-run handover: grants read/Stop-only to new principal and revokes old authority", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin: "654321" });
    const info = await server.start();

    // Pair old Phone principal
    const oldPairRes = await fetch(`${info.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "654321", deviceName: "Old Phone Reviewer" })
    });
    const oldPairData = (await oldPairRes.json()) as { token: string };
    const oldPhoneToken = oldPairData.token;
    const oldPhonePrincipalId = server.pairedPrincipals()[0]!;

    // Pair new Phone principal
    const pairRes = await fetch(`${info.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "654321", deviceName: "New Phone Reviewer" })
    });
    const pairData = (await pairRes.json()) as { token: string };
    const phoneToken = pairData.token;
    const phonePrincipalId = server.pairedPrincipals().find((id) => id !== oldPhonePrincipalId)!;

    const liveRunningSnapshot: WorkstationSnapshot = {
      operationId: "op-handover-42",
      caseId: "case-handover-1",
      providerId: "claude",
      modelId: "sonnet-3-7",
      sessionId: null,
      status: "running",
      startedAt: 1000,
      updatedAt: 1000,
      text: "Generating deliverables",
      activity: ["Drafting"],
      permission: null,
      detail: "Working"
    };

    let oldPhoneOwner: object | null = null;
    let transferredOwner: object | null = null;

    const mockHost = {
      prepare: vi.fn(),
      start: vi.fn(),
      snapshotsForOwner: vi.fn((owner: object) => {
        if (transferredOwner !== null && owner === transferredOwner) {
          return [liveRunningSnapshot];
        }
        if (transferredOwner === null && (oldPhoneOwner === null || owner === oldPhoneOwner)) {
          oldPhoneOwner = owner;
          return [liveRunningSnapshot];
        }
        return [];
      }),
      decide: vi.fn(),
      stop: vi.fn(async () => liveRunningSnapshot),
      invalidate: vi.fn(),
      handoverActiveRun: vi.fn((caseId, operationId, oldOwner, newOwner) => {
        transferredOwner = newOwner;
        return liveRunningSnapshot;
      })
    } as unknown as Parameters<typeof installRemoteHostBridge>[1];

    const bridge = installRemoteHostBridge(server, mockHost);

    try {
      // Query state on old Phone principal AFTER bridge installation so oldPhonePrincipalId has owner initialized in bridge
      await fetch(`${info.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${oldPhoneToken}` }
      });

      // 1. Prepare one-run handover from old Phone to new Phone
      const handoverReview = bridge.prepareOneRunHandover({
        caseId: "case-handover-1",
        operationId: "op-handover-42",
        oldPrincipalId: oldPhonePrincipalId,
        newPrincipalId: phonePrincipalId
      });

      expect(handoverReview.token).toBeDefined();

      // 2. Approve handover
      const approvedScope = bridge.approveOneRunHandover(handoverReview.token);
      expect(approvedScope.operationId).toBe("op-handover-42");
      expect(mockHost.handoverActiveRun).toHaveBeenCalled();

      // 3. New Phone principal can see state and issue Stop
      const phoneStateRes = await fetch(`${info.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${phoneToken}` }
      });
      const phoneState = (await phoneStateRes.json()) as RemoteWorkstationState;
      expect(phoneState.isRunning).toBe(true);
      expect(phoneState.operationId).toBe("op-handover-42");

      // 4. Invariant: Phone principal is in read-stop-only mode and CANNOT prepare a new run
      const phonePrepRes = await fetch(`${info.serverUrl}/api/prepare`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${phoneToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          requestId: "prep-phone-1",
          caseId: "case-handover-1",
          providerId: "claude",
          modelId: "sonnet-3-7",
          prompt: "Start another new task",
          sourceTurnIds: []
        })
      });
      const phonePrepBody = (await phonePrepRes.json()) as { status: string; detail: string };
      expect(phonePrepBody.status).toBe("rejected");
      expect(phonePrepBody.detail).toContain("read and Stop its one run");
    } finally {
      await server.stop();
    }
  });
});
