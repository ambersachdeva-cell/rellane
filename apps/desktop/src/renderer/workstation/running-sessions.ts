export type SessionState = "starting" | "running" | "needs-approval" | "stopping" | "done";

export interface SnapshotLike {
  readonly operationId: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly providerLabel: string;
  readonly status: string;
  readonly detail: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly waitingTitle: string | null;
}

export interface SessionRow {
  readonly operationId: string;
  readonly caseId: string;
  readonly title: string;
  readonly provider: string;
  readonly state: SessionState;
  /** One short line: what it is doing, or what it is waiting for. */
  readonly line: string;
  /** "4 min", "12 sec". Never a raw millisecond count. */
  readonly elapsed: string;
  /** True when this one is blocking on the owner. */
  readonly needsYou: boolean;
  readonly canStop: boolean;
}

/**
 * Maps incoming backend session status to a unified interface state.
 * An unrecognised status cannot be safely dropped or hidden from the owner;
 * treating it as running keeps visibility and control intact.
 */
function toSessionState(status: string): SessionState {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "needs-approval":
      return "needs-approval";
    case "stopping":
      return "stopping";
    case "completed":
    case "stopped":
    case "failed":
    case "interrupted":
      return "done";
    default:
      return "running";
  }
}

/**
 * Assigns display priority to each session state.
 * The owner's attention is the scarce resource; sessions blocked on manual
 * decisions take precedence over autonomous progress.
 */
function statePriority(state: SessionState): number {
  switch (state) {
    case "needs-approval":
      return 1;
    case "running":
      return 2;
    case "starting":
      return 3;
    case "stopping":
      return 4;
    case "done":
      return 5;
  }
}

/**
 * Truncates text at the given character threshold, appending a trailing ellipsis.
 * Enforces strict column bounds in the multi-session overview strip.
 */
function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + "…";
}

/**
 * Formats elapsed time into human-friendly duration strings without milliseconds.
 * Clock skew between processes or negative time deltas must never display negative
 * durations to the owner.
 */
function formatElapsed(startedAt: number, now: number): string {
  const diffMs = now - startedAt;
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "just now";
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return `${hours} hr ${remainingMinutes} min`;
}

/**
 * Derives user-facing summary line.
 * Needs-approval sessions show what is blocked; empty status lines fall back
 * to a calm default so rows never render blank.
 */
function formatLine(snapshot: SnapshotLike, state: SessionState): string {
  const source =
    state === "needs-approval" && snapshot.waitingTitle !== null && snapshot.waitingTitle.trim().length > 0
      ? snapshot.waitingTitle
      : snapshot.detail;

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return "Working.";
  }

  return truncateWithEllipsis(trimmed, 80);
}

/**
 * Normalises case title with a calm placeholder for nameless operations.
 */
function formatTitle(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  if (trimmed.length === 0) {
    return "Untitled work";
  }
  return truncateWithEllipsis(trimmed, 40);
}

/**
 * Converts raw snapshots into presentation rows sorted for the multi-session strip.
 * Never mutates input data.
 */
export function sessionRows(snapshots: readonly SnapshotLike[], now: number): readonly SessionRow[] {
  const sorted = snapshots.slice().sort((a, b) => {
    const stateA = toSessionState(a.status);
    const stateB = toSessionState(b.status);
    const priorityDiff = statePriority(stateA) - statePriority(stateB);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const updateDiff = b.updatedAt - a.updatedAt;
    if (updateDiff !== 0) {
      return updateDiff;
    }

    if (a.operationId < b.operationId) return -1;
    if (a.operationId > b.operationId) return 1;
    return 0;
  });

  return sorted.map((snapshot): SessionRow => {
    const state = toSessionState(snapshot.status);
    return {
      operationId: snapshot.operationId,
      caseId: snapshot.caseId,
      title: formatTitle(snapshot.caseTitle),
      provider: snapshot.providerLabel,
      state,
      line: formatLine(snapshot, state),
      elapsed: formatElapsed(snapshot.startedAt, now),
      needsYou: state === "needs-approval",
      canStop: state !== "done"
    };
  });
}

/**
 * Produces a concise, natural English summary of active sessions across states.
 */
export function summariseRunning(rows: readonly SessionRow[]): string {
  if (rows.length === 0) {
    return "Nothing running";
  }

  let runningCount = 0;
  let needsApprovalCount = 0;
  let startingCount = 0;
  let stoppingCount = 0;
  let doneCount = 0;

  for (const row of rows) {
    switch (row.state) {
      case "running":
        runningCount++;
        break;
      case "needs-approval":
        needsApprovalCount++;
        break;
      case "starting":
        startingCount++;
        break;
      case "stopping":
        stoppingCount++;
        break;
      case "done":
        doneCount++;
        break;
    }
  }

  const parts: string[] = [];

  if (runningCount > 0) {
    parts.push(runningCount === 1 ? "1 session working" : `${runningCount} sessions working`);
  }

  if (needsApprovalCount > 0) {
    parts.push(needsApprovalCount === 1 ? "1 needs you" : `${needsApprovalCount} need you`);
  }

  if (startingCount > 0) {
    parts.push(startingCount === 1 ? "1 session starting" : `${startingCount} sessions starting`);
  }

  if (stoppingCount > 0) {
    parts.push(stoppingCount === 1 ? "1 session stopping" : `${stoppingCount} sessions stopping`);
  }

  if (doneCount > 0) {
    parts.push(doneCount === 1 ? "1 session done" : `${doneCount} sessions done`);
  }

  if (parts.length === 0) {
    return "Nothing running";
  }

  return parts.join(", ");
}
