/**
 * Verifies loopback HTTP integration for single-run remote workstation handover.
 * Ensures strict Mac approval, scope confinement to the transferred run,
 * denial of remote permission decisions or new dispatches, and authority
 * revocation for the original principal.
 */
import { describe, expect, it } from "vitest";
import type { WorkstationSnapshot, WorkstationReview } from "@cadrane/contracts";
import {
  createRemoteDispatchServer,
  type RemoteDispatchServer,
  type RemoteOneRunHandoverScope,
  type RemoteWorkstationState,
} from "./remote-dispatch-server.js";
import { installRemoteHostBridge } from "./remote-host-bridge.js";

const syntheticReview: WorkstationReview = {
  token: "a".repeat(64),
  caseId: "case-alpha",
  providerId: "claude",
  providerLabel: "Claude",
  modelId: "claude-3-5-sonnet",
  prompt: "Synthesize findings",
  contextPreview: "Context preview for synthetic test",
  sourceIds: ["turn-1"],
  sourceHash: "hash-turn-1",
  workspace: { id: "ws-1", label: "Main", path: "/workspaces/main" },
  expiresAt: Date.now() + 60_000,
  resumeSessionId: null,
};

describe("remote one-run handover loopback HTTP integration", () => {
  it("transfers a live synthetic run over loopback HTTP with strict Mac approval and scope confinement", async () => {
    const snapshots = new Map<object, WorkstationSnapshot[]>();
    let transferredNewOwner: object | null = null;

    const host: Parameters<typeof installRemoteHostBridge>[1] = {
      prepare: async () => syntheticReview,
      start: async (_input, owner) => {
        const runningSnapshot: WorkstationSnapshot = {
          operationId: "op-synthetic-1",
          caseId: "case-alpha",
          providerId: "claude",
          modelId: "claude-3-5-sonnet",
          sessionId: null,
          status: "running",
          startedAt: Date.now(),
          updatedAt: Date.now(),
          text: "Running synthetic operation",
          activity: ["synthetic-started"],
          permission: null,
          detail: "Synthetic running detail",
        };
        snapshots.set(owner, [runningSnapshot]);
        return runningSnapshot;
      },
      snapshotsForOwner: (owner: object) => snapshots.get(owner) ?? [],
      decide: async (): Promise<never> => {
        throw new Error("Unsupported: permission decisions must be denied before reaching Host");
      },
      stop: async (caseId: string, operationId: string, owner: object) => {
        const current = snapshots.get(owner) ?? [];
        const target = current.find((s) => s.caseId === caseId && s.operationId === operationId);
        if (!target) {
          throw new Error("Active run not found to stop");
        }
        const stoppedSnapshot: WorkstationSnapshot = {
          ...target,
          status: "stopped" as const,
          updatedAt: Date.now(),
        };
        const updated = current.map((s) =>
          s.caseId === caseId && s.operationId === operationId ? stoppedSnapshot : s
        );
        snapshots.set(owner, updated);
        return stoppedSnapshot;
      },
      invalidate: (owner: object) => {
        snapshots.delete(owner);
      },
      handoverActiveRun: (caseId: string, operationId: string, oldOwner: object, newOwner: object) => {
        transferredNewOwner = newOwner;
        const oldList = snapshots.get(oldOwner) ?? [];
        const target = oldList.find((s) => s.caseId === caseId && s.operationId === operationId);
        if (!target) {
          throw new Error("Active run not found on old owner");
        }
        snapshots.set(oldOwner, oldList.filter((s) => s !== target));
        const currentNew = snapshots.get(newOwner) ?? [];
        snapshots.set(newOwner, [...currentNew, target]);
        return target;
      },
    };

    const server: RemoteDispatchServer = createRemoteDispatchServer({
      port: 0,
      host: "127.0.0.1",
      pin: "543210",
    });
    const bridge = installRemoteHostBridge(server, host);

    try {
      const session = await server.start();
      expect(server.port).toBeGreaterThan(0);

      // 1. Pair old principal through HTTP
      const pairOldRes = await fetch(`${session.serverUrl}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: session.serverUrl },
        body: JSON.stringify({ pin: session.pin }),
      });
      expect(pairOldRes.status).toBe(200);
      const pairOldJson = (await pairOldRes.json()) as { readonly token: string };
      const oldToken = pairOldJson.token;
      expect(typeof oldToken).toBe("string");

      // 2. Prepare/Start one synthetic run with old principal
      const prepRes = await fetch(`${session.serverUrl}/api/prepare`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oldToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-prepare-1",
          caseId: "case-alpha",
          providerId: "claude",
          modelId: "claude-3-5-sonnet",
          prompt: "Synthesize findings",
          sourceTurnIds: ["turn-1"],
        }),
      });
      expect(prepRes.status).toBe(200);
      const prepJson = (await prepRes.json()) as { readonly status: string; readonly review?: WorkstationReview };
      expect(prepJson.status).toBe("accepted");
      expect(prepJson.review?.token).toBe(syntheticReview.token);

      const dispatchRes = await fetch(`${session.serverUrl}/api/dispatch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oldToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-dispatch-1",
          reviewToken: syntheticReview.token,
        }),
      });
      expect(dispatchRes.status).toBe(200);
      const dispatchJson = (await dispatchRes.json()) as { readonly status: string; readonly operationId?: string };
      expect(dispatchJson.status).toBe("accepted");
      expect(dispatchJson.operationId).toBe("op-synthetic-1");

      const oldStateRes = await fetch(`${session.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${oldToken}`, Origin: session.serverUrl },
      });
      expect(oldStateRes.status).toBe(200);
      const oldStateJson = (await oldStateRes.json()) as RemoteWorkstationState;
      expect(oldStateJson.isRunning).toBe(true);
      expect(oldStateJson.operationId).toBe("op-synthetic-1");
      expect(oldStateJson.currentTask).toBe("case-alpha");

      // 3. Pair new principal through HTTP
      const pairNewRes = await fetch(`${session.serverUrl}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: session.serverUrl },
        body: JSON.stringify({ pin: session.pin }),
      });
      expect(pairNewRes.status).toBe(200);
      const pairNewJson = (await pairNewRes.json()) as { readonly token: string };
      const newToken = pairNewJson.token;
      expect(typeof newToken).toBe("string");
      expect(newToken).not.toBe(oldToken);

      // 4. PIN alone must not expose or adopt old run
      const newStateBeforeRes = await fetch(`${session.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${newToken}`, Origin: session.serverUrl },
      });
      expect(newStateBeforeRes.status).toBe(200);
      const newStateBeforeJson = (await newStateBeforeRes.json()) as RemoteWorkstationState;
      expect(newStateBeforeJson.isRunning).toBe(false);
      expect(newStateBeforeJson.operationId).toBeUndefined();
      expect(newStateBeforeJson.currentTask).toBeUndefined();
      expect(newStateBeforeJson.pendingApprovals).toEqual([]);

      // 5. Prepare and approve handover through the trusted bridge method (models the Mac IPC)
      const candidates = bridge.handoverCandidates();
      expect(candidates).toEqual([
        {
          principalId: expect.any(String),
          caseId: "case-alpha",
          operationId: "op-synthetic-1",
        },
      ]);
      const oldPrincipalId = candidates[0]!.principalId;
      const allPrincipals = server.pairedPrincipals();
      const newPrincipalId = allPrincipals.find((id) => id !== oldPrincipalId);
      expect(newPrincipalId).toBeDefined();

      const handoverScope: RemoteOneRunHandoverScope = {
        caseId: "case-alpha",
        operationId: "op-synthetic-1",
        oldPrincipalId,
        newPrincipalId: newPrincipalId!,
      };

      const handoverReview = bridge.prepareOneRunHandover(handoverScope);
      expect(handoverReview.token).toMatch(/^[a-f0-9]{64}$/);
      expect(handoverReview.caseId).toBe("case-alpha");
      expect(handoverReview.operationId).toBe("op-synthetic-1");

      const approvedScope = bridge.approveOneRunHandover(handoverReview.token);
      expect(approvedScope).toMatchObject(handoverScope);

      // 6. Review is one-use: repeating approval with the same token rejects
      expect(() => bridge.approveOneRunHandover(handoverReview.token)).toThrow(
        /This Mac handover review expired or was already used/
      );

      // 7. Old bearer is denied after handover
      const oldStateAfterRes = await fetch(`${session.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${oldToken}`, Origin: session.serverUrl },
      });
      expect(oldStateAfterRes.status).toBe(401);

      const oldStopAfterRes = await fetch(`${session.serverUrl}/api/stop`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oldToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-stop-old-denied",
          operationId: "op-synthetic-1",
        }),
      });
      expect(oldStopAfterRes.status).toBe(401);

      // 8. New principal can read only the transferred run and cannot access another Case
      expect(transferredNewOwner).not.toBeNull();
      const otherCaseSnapshot: WorkstationSnapshot = {
        operationId: "op-other-case-2",
        caseId: "case-beta",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        sessionId: null,
        status: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        text: "Other run",
        activity: ["other-activity"],
        permission: null,
        detail: "Other detail",
      };
      snapshots.get(transferredNewOwner!)!.push(otherCaseSnapshot);

      const newStateAfterRes = await fetch(`${session.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${newToken}`, Origin: session.serverUrl },
      });
      expect(newStateAfterRes.status).toBe(200);
      const newStateAfterJson = (await newStateAfterRes.json()) as RemoteWorkstationState;
      expect(newStateAfterJson.isRunning).toBe(true);
      expect(newStateAfterJson.operationId).toBe("op-synthetic-1");
      expect(newStateAfterJson.currentTask).toBe("case-alpha");

      // 9. New principal cannot Prepare, Start, decide, or access/stop another Case
      const newPrepRes = await fetch(`${session.serverUrl}/api/prepare`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-prep-new-denied",
          caseId: "case-alpha",
          providerId: "claude",
          modelId: "claude-3-5-sonnet",
          prompt: "Attempting new work",
          sourceTurnIds: ["turn-1"],
        }),
      });
      expect(newPrepRes.status).toBe(200);
      const newPrepJson = (await newPrepRes.json()) as { readonly status: string; readonly detail?: string };
      expect(newPrepJson.status).toBe("rejected");
      expect(newPrepJson.detail).toContain("This handover pairing may only read and Stop its one run.");

      const newDispatchRes = await fetch(`${session.serverUrl}/api/dispatch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-dispatch-new-denied",
          reviewToken: syntheticReview.token,
        }),
      });
      expect(newDispatchRes.status).toBe(200);
      const newDispatchJson = (await newDispatchRes.json()) as { readonly status: string };
      expect(newDispatchJson.status).toBe("rejected");

      const newDecideRes = await fetch(`${session.serverUrl}/api/decide`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-decide-new-denied",
          operationId: "op-synthetic-1",
          permissionId: "perm-1",
          revision: "rev-1",
          allow: true,
        }),
      });
      expect(newDecideRes.status).toBe(200);
      const newDecideJson = (await newDecideRes.json()) as { readonly status: string; readonly detail?: string };
      expect(newDecideJson.status).toBe("rejected");
      expect(newDecideJson.detail).toContain("A handed-over run cannot approve tools remotely.");

      const newStopOtherRes = await fetch(`${session.serverUrl}/api/stop`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-stop-other-denied",
          operationId: "op-other-case-2",
        }),
      });
      expect(newStopOtherRes.status).toBe(200);
      const newStopOtherJson = (await newStopOtherRes.json()) as { readonly status: string; readonly detail?: string };
      expect(newStopOtherJson.status).toBe("rejected");
      expect(newStopOtherJson.detail).toContain("Only the handed-over run may be stopped.");

      // 10. New principal can exact Stop the transferred run
      const newStopExactRes = await fetch(`${session.serverUrl}/api/stop`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json",
          Origin: session.serverUrl,
        },
        body: JSON.stringify({
          requestId: "req-stop-exact",
          operationId: "op-synthetic-1",
        }),
      });
      expect(newStopExactRes.status).toBe(200);
      const newStopExactJson = (await newStopExactRes.json()) as { readonly status: string; readonly operationId?: string };
      expect(newStopExactJson.status).toBe("accepted");
      expect(newStopExactJson.operationId).toBe("op-synthetic-1");

      const stateAfterStopRes = await fetch(`${session.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${newToken}`, Origin: session.serverUrl },
      });
      expect(stateAfterStopRes.status).toBe(200);
      const stateAfterStopJson = (await stateAfterStopRes.json()) as RemoteWorkstationState;
      expect(stateAfterStopJson.isRunning).toBe(false);

      // 11. Server stop and restart revokes authority
      await server.stop();
      const restartedSession = await server.start();
      const afterRestartRes = await fetch(`${restartedSession.serverUrl}/api/state`, {
        headers: { Authorization: `Bearer ${newToken}`, Origin: restartedSession.serverUrl },
      });
      expect(afterRestartRes.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});
