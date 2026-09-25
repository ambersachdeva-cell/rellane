/** Pairing-scoped remote commands use the same reviewed WorkstationHost as the desktop. */
import { randomUUID } from "node:crypto";
import type { WorkstationSnapshot } from "@cadrane/contracts";
import type { WorkstationHost } from "./service.js";
import { computeActionRevision, type RemoteDispatchServer, type RemotePendingApproval,
  type RemoteWorkstationState, type RemoteOneRunHandoverScope,
  type RemoteOneRunHandoverReview } from "./remote-dispatch-server.js";

type Host = Pick<WorkstationHost, "prepare" | "start" | "snapshotsForOwner" | "decide" | "stop" | "invalidate" | "handoverActiveRun">;
export interface RemoteHostBridge {
  handoverCandidates(): readonly { readonly principalId: string; readonly caseId: string;
    readonly operationId: string }[];
  prepareOneRunHandover(input: RemoteOneRunHandoverScope): RemoteOneRunHandoverReview;
  approveOneRunHandover(token: string): RemoteOneRunHandoverScope;
}
interface Challenge {
  readonly revision: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly permissionId: string;
  readonly title: string;
  readonly detail: string;
  readonly updatedAt: number;
  readonly expiresAt: number;
}
interface CurrentReview {
  readonly owner: object;
  readonly token: string;
  readonly expiresAt: number;
}

const ACTIVE = new Set<WorkstationSnapshot["status"]>(["starting", "running", "needs-approval", "stopping"]);
const CHALLENGE_MS = 5 * 60_000;

export function installRemoteHostBridge(server: RemoteDispatchServer, host: Host): RemoteHostBridge {
  const owners = new Map<string, object>();
  const currentReviews = new Map<string, CurrentReview>();
  const prepareGenerations = new Map<string, number>();
  const starting = new Map<string, Set<AbortController>>();
  const challenges = new Map<string, Challenge>();
  const readStopOnly = new Set<string>();
  const handoverGrants = new Map<string, { caseId: string; operationId: string }>();
  const ownerFor = (principalId: string): object => {
    let owner = owners.get(principalId);
    if (owner === undefined) { owner = {}; owners.set(principalId, owner); }
    return owner;
  };
  const challengeKey = (principalId: string, operationId: string, permissionId: string): string =>
    JSON.stringify([principalId, operationId, permissionId]);
  const liveFor = (principalId: string): readonly WorkstationSnapshot[] =>
    host.snapshotsForOwner(ownerFor(principalId)).filter((snapshot) => ACTIVE.has(snapshot.status));

  server.onPrepare(async (request, principalId) => {
    if (readStopOnly.has(principalId))
      return { status: "rejected" as const, detail: "This handover pairing may only read and Stop its one run." };
    const owner = ownerFor(principalId);
    const generation = (prepareGenerations.get(principalId) ?? 0) + 1;
    prepareGenerations.set(principalId, generation);
    currentReviews.delete(principalId);
    try {
      const review = await host.prepare({
        caseId: request.caseId, providerId: request.providerId, modelId: request.modelId,
        prompt: request.prompt, sourceTurnIds: request.sourceTurnIds,
        ...(request.enableTools === undefined ? {} : { enableTools: request.enableTools }),
        ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId })
      }, owner, { freshSession: true });
      if (owners.get(principalId) !== owner) {
        host.invalidate(owner);
        return { status: "rejected" as const, detail: "This pairing expired during review. Pair again." };
      }
      if (prepareGenerations.get(principalId) !== generation)
        return { status: "rejected" as const, detail: "A newer review replaced this one. Read the current review." };
      if (review.expiresAt <= Date.now())
        return { status: "rejected" as const, detail: "This review expired. Prepare it again." };
      currentReviews.set(principalId, { owner, token: review.token, expiresAt: review.expiresAt });
      return { status: "accepted" as const, review };
    } catch {
      return { status: "rejected" as const,
        detail: "Review could not be prepared. Check the selected work, sources, connection, and model on your Mac." };
    }
  });

  server.onDispatch(async (request, principalId) => {
    if (readStopOnly.has(principalId))
      return { status: "rejected" as const, detail: "This handover pairing cannot start another run." };
    const owner = ownerFor(principalId);
    const current = currentReviews.get(principalId);
    if (current === undefined || current.owner !== owner || current.token !== request.reviewToken)
      return { status: "rejected" as const, detail: "That review is no longer current. Prepare it again." };
    currentReviews.delete(principalId);
    if (current.expiresAt <= Date.now())
      return { status: "rejected" as const, detail: "That review expired. Prepare it again." };
    const controller = new AbortController();
    let controllers = starting.get(principalId);
    if (controllers === undefined) {
      controllers = new Set();
      starting.set(principalId, controllers);
    }
    controllers.add(controller);
    try {
      const started = await host.start({ token: request.reviewToken }, owner, controller.signal);
      if (owners.get(principalId) !== owner) {
        // Revocation may have run before start registered its operation. Stop
        // the exact late run now; the result remains uncertain even if Stop
        // reports success, because native effects may already have happened.
        try { await host.stop(started.caseId, started.operationId, owner); }
        catch { /* The Mac's session view remains the recovery authority. */ }
        host.invalidate(owner);
        return { status: "uncertain" as const, operationId: started.operationId,
          detail: "This pairing expired during start. Stop was requested; check the session on your Mac." };
      }
      return { status: "accepted" as const, operationId: started.operationId,
        detail: "Session started. Check state for its final outcome." };
    } catch {
      if (owners.get(principalId) !== owner || controller.signal.aborted) host.invalidate(owner);
      return { status: "uncertain" as const,
        detail: "The reviewed start could not be confirmed. Check state on your Mac before trying again." };
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) starting.delete(principalId);
    }
  });

  server.onState((principalId): RemoteWorkstationState => {
    const grant = handoverGrants.get(principalId);
    if (readStopOnly.has(principalId) && !grant)
      return { isRunning: false, pendingApprovals: [], recentLogs: [] };
    const all = host.snapshotsForOwner(ownerFor(principalId)).filter((snapshot) =>
      grant === undefined || (snapshot.caseId === grant.caseId && snapshot.operationId === grant.operationId));
    const live = all.filter((snapshot) => ACTIVE.has(snapshot.status));
    if (grant && live.length === 0) {
      handoverGrants.delete(principalId);
      return { isRunning: false, pendingApprovals: [], recentLogs: [] };
    }
    const now = Date.now();
    const pendingApprovals: RemotePendingApproval[] = [];
    const currentKeys = new Set<string>();
    for (const snapshot of live) {
      const permission = !readStopOnly.has(principalId) && snapshot.status === "needs-approval" ? snapshot.permission : null;
      if (permission === null) continue;
      const key = challengeKey(principalId, snapshot.operationId, permission.id);
      currentKeys.add(key);
      let challenge = challenges.get(key);
      if (challenge === undefined || challenge.expiresAt <= now ||
          challenge.updatedAt !== snapshot.updatedAt || challenge.title !== permission.title ||
          challenge.detail !== permission.detail) {
        challenge = {
          principalId, operationId: snapshot.operationId, permissionId: permission.id,
          title: permission.title, detail: permission.detail, updatedAt: snapshot.updatedAt,
          expiresAt: now + CHALLENGE_MS,
          revision: computeActionRevision({ operationId: snapshot.operationId,
            permissionId: permission.id, title: permission.title, detail: permission.detail,
            hostUpdate: `${snapshot.updatedAt}:${randomUUID()}` })
        };
        challenges.set(key, challenge);
      }
      pendingApprovals.push({ operationId: snapshot.operationId, permissionId: permission.id,
        title: permission.title, detail: permission.detail, revision: challenge.revision,
        expiresAt: challenge.expiresAt });
    }
    for (const [key, challenge] of challenges) {
      if (challenge.principalId === principalId && (!currentKeys.has(key) || challenge.expiresAt <= now))
        challenges.delete(key);
    }
    const latest = live[0] ?? all[0];
    const recentLogs = all.flatMap((snapshot) => snapshot.activity).slice(-10);
    return {
      isRunning: live.length > 0,
      pendingApprovals,
      recentLogs,
      ...(latest === undefined ? {} : {
        operationId: latest.operationId,
        operationStatus: latest.status,
        currentTask: latest.caseId,
        ...(latest.modelId === null ? {} : { activeModel: latest.modelId })
      })
    };
  });

  server.onDecision(async (request, principalId) => {
    if (readStopOnly.has(principalId))
      return { status: "rejected" as const, detail: "A handed-over run cannot approve tools remotely." };
    const key = challengeKey(principalId, request.operationId, request.permissionId);
    const challenge = challenges.get(key);
    if (challenge === undefined || challenge.revision !== request.revision || challenge.expiresAt <= Date.now())
      return { status: "rejected" as const, detail: "That approval has expired or changed. Read current state again." };
    const snapshot = liveFor(principalId).find((item) => item.operationId === request.operationId);
    if (snapshot?.status !== "needs-approval" || snapshot.permission?.id !== request.permissionId ||
        snapshot.permission.title !== challenge.title || snapshot.permission.detail !== challenge.detail ||
        snapshot.updatedAt !== challenge.updatedAt) {
      challenges.delete(key);
      return { status: "rejected" as const, detail: "That action is no longer waiting. Read current state again." };
    }
    challenges.delete(key);
    try {
      await host.decide(request.operationId, request.permissionId, request.allow, ownerFor(principalId));
      return { status: "accepted" as const, operationId: request.operationId,
        detail: "Decision submitted. Check state for the next result." };
    } catch {
      return { status: "uncertain" as const, operationId: request.operationId,
        detail: "The decision result could not be confirmed. Check the action on your Mac." };
    }
  });

  server.onStop(async (request, principalId) => {
    const grant = handoverGrants.get(principalId);
    if (readStopOnly.has(principalId) && (!grant || grant.operationId !== request.operationId))
      return { status: "rejected" as const, detail: "Only the handed-over run may be stopped." };
    const snapshot = liveFor(principalId).find((item) => item.operationId === request.operationId);
    if (snapshot === undefined) return { status: "rejected" as const,
      detail: "That running session is unavailable to this pairing." };
    try {
      await host.stop(snapshot.caseId, request.operationId, ownerFor(principalId));
      if (grant) handoverGrants.delete(principalId);
      return { status: "accepted" as const, operationId: request.operationId,
        detail: "Stop requested. Check state for the final result." };
    } catch {
      return { status: "uncertain" as const, operationId: request.operationId,
        detail: "Stop could not be confirmed. Check the session on your Mac." };
    }
  });

  server.onRevokePrincipal(({ principalId }) => {
    const owner = owners.get(principalId);
    owners.delete(principalId);
    currentReviews.delete(principalId);
    prepareGenerations.delete(principalId);
    for (const controller of starting.get(principalId) ?? []) controller.abort();
    starting.delete(principalId);
    handoverGrants.delete(principalId);
    readStopOnly.delete(principalId);
    for (const [key, challenge] of challenges)
      if (challenge.principalId === principalId) challenges.delete(key);
    if (owner !== undefined) host.invalidate(owner);
  });

  return {
    handoverCandidates: () => {
      const active = new Set(server.pairedPrincipals());
      return [...owners].filter(([principalId]) => active.has(principalId))
        .flatMap(([principalId, owner]) => host.snapshotsForOwner(owner)
          .filter((snapshot) => snapshot.status === "running")
          .map((snapshot) => ({ principalId, caseId: snapshot.caseId,
            operationId: snapshot.operationId })));
    },
    prepareOneRunHandover: (input) => {
      const oldOwner = owners.get(input.oldPrincipalId);
      if (!oldOwner || readStopOnly.has(input.oldPrincipalId) ||
          readStopOnly.has(input.newPrincipalId) ||
          currentReviews.has(input.newPrincipalId) || starting.has(input.oldPrincipalId) ||
          starting.has(input.newPrincipalId) ||
          host.snapshotsForOwner(oldOwner).find((snapshot) => snapshot.caseId === input.caseId &&
            snapshot.operationId === input.operationId && snapshot.status === "running") === undefined)
        throw new Error("Choose one live run and a fresh pairing on this Mac.");
      const newOwner = ownerFor(input.newPrincipalId);
      if (host.snapshotsForOwner(newOwner).length > 0)
        throw new Error("The new pairing already owns workstation work.");
      return server.prepareOneRunHandover(input);
    },
    approveOneRunHandover: (token) => server.commitOneRunHandover(token, (scope) => {
      const oldOwner = owners.get(scope.oldPrincipalId);
      const newOwner = owners.get(scope.newPrincipalId);
      if (!oldOwner || !newOwner || readStopOnly.has(scope.newPrincipalId) ||
          currentReviews.has(scope.newPrincipalId) || starting.has(scope.oldPrincipalId) ||
          starting.has(scope.newPrincipalId))
        throw new Error("The handover pairing changed. Review it again.");
      host.handoverActiveRun(scope.caseId, scope.operationId, oldOwner, newOwner);
      handoverGrants.set(scope.newPrincipalId, { caseId: scope.caseId, operationId: scope.operationId });
      readStopOnly.add(scope.newPrincipalId);
      for (const principalId of [scope.oldPrincipalId, scope.newPrincipalId]) {
        currentReviews.delete(principalId);
        prepareGenerations.set(principalId, (prepareGenerations.get(principalId) ?? 0) + 1);
        for (const [key, challenge] of challenges)
          if (challenge.principalId === principalId) challenges.delete(key);
      }
    })
  };
}
