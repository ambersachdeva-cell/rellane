import path from "node:path";

export interface RunningSession {
  readonly operationId: string;
  readonly caseId: string;
  readonly providerId: string;
  readonly workspacePath: string;
  readonly owner: object;
  readonly startedAt: number;
}

export interface StartRequest {
  readonly caseId: string;
  readonly providerId: string;
  readonly workspacePath: string;
  readonly owner: object;
}

export type PoolDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly conflictWith: string | null };

export const MAX_CONCURRENT_SESSIONS = 4;

function workspacesOverlap(first: string, second: string): boolean {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function formatProvider(providerId: string): string {
  if (providerId.length === 0) {
    return "active";
  }
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

export function admit(
  running: readonly RunningSession[],
  request: StartRequest,
  now: number
): PoolDecision {
  void now;

  // A parent and child folder share files as surely as two identical roots.
  if (request.workspacePath.trim().length > 0) {
    const folderConflict = running.find((session) => workspacesOverlap(session.workspacePath, request.workspacePath));
    if (folderConflict !== undefined) {
      return {
        allowed: false,
        reason: `Stop the ${formatProvider(folderConflict.providerId)} session in ${folderConflict.workspacePath} first, or choose another folder.`,
        conflictWith: folderConflict.operationId,
      };
    }
  }

  // A single conversation cannot safely receive interleaved responses from parallel runs.
  if (request.caseId.trim().length > 0) {
    const caseConflict = running.find((session) => session.caseId === request.caseId);
    if (caseConflict !== undefined) {
      return {
        allowed: false,
        reason: "Stop the running session for this case first, or choose another case.",
        conflictWith: null,
      };
    }
  }

  // Running concurrent sessions on one account risks silent provider-side rate limits.
  if (request.providerId.trim().length > 0) {
    const providerConflict = running.find((session) => session.providerId === request.providerId);
    if (providerConflict !== undefined) {
      return {
        allowed: false,
        reason: `Stop the running ${formatProvider(providerConflict.providerId)} session first, or choose another provider.`,
        conflictWith: null,
      };
    }
  }

  // Caps resource consumption on the Mac host.
  if (running.length >= MAX_CONCURRENT_SESSIONS) {
    return {
      allowed: false,
      reason: `Stop a running session first, as at most ${MAX_CONCURRENT_SESSIONS} sessions may run at the same time.`,
      conflictWith: null,
    };
  }

  // Sessions require meaningful target parameters before dispatch.
  if (request.workspacePath.trim().length === 0) {
    return {
      allowed: false,
      reason: "Choose a workspace folder first, as a session cannot start without one.",
      conflictWith: null,
    };
  }
  if (request.caseId.trim().length === 0) {
    return {
      allowed: false,
      reason: "Choose a case first, as a session cannot start without one.",
      conflictWith: null,
    };
  }
  if (request.providerId.trim().length === 0) {
    return {
      allowed: false,
      reason: "Choose a provider first, as a session cannot start without one.",
      conflictWith: null,
    };
  }

  return { allowed: true };
}

export function sessionsFor(
  running: readonly RunningSession[],
  caseId: string
): readonly RunningSession[] {
  return running
    .filter((session) => session.caseId === caseId)
    .sort((a, b) => {
      if (a.startedAt !== b.startedAt) {
        return a.startedAt - b.startedAt;
      }
      if (a.operationId < b.operationId) {
        return -1;
      }
      if (a.operationId > b.operationId) {
        return 1;
      }
      return 0;
    });
}
