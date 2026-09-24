export interface FleetSession {
  readonly operationId: string;
  readonly providerLabel: string;
  readonly state: "starting" | "running" | "needs-approval" | "stopping" | "done";
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly toolCalls: number;
  readonly declined: number;
  /** Outcome for a finished session. Null while it is still going. */
  readonly outcome: "completed" | "stopped" | "failed" | "interrupted" | null;
}

export interface FleetSummary {
  readonly headline: string;
  readonly working: number;
  readonly waitingOnYou: number;
  readonly finished: number;
  /** Distinct subscriptions with something running now. */
  readonly subscriptionsInUse: readonly string[];
  /** Total approved tool calls across everything shown. */
  readonly toolCalls: number;
  readonly declined: number;
  /** Longest currently-running session, as words. Null when nothing runs. */
  readonly longestRunning: string | null;
  /** Anything the owner should know, each one short. Empty when all is well. */
  readonly attention: readonly string[];
}

/**
 * Human-readable duration in words for active sessions.
 * Omits finer increments when coarser units apply so status stays scannable.
 */
function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return "0 sec";
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds <= 0) {
    return "0 sec";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    const hrLabel = hours === 1 ? "1 hr" : `${hours} hrs`;
    return minutes > 0 ? `${hrLabel} ${minutes} min` : hrLabel;
  }

  if (minutes > 0) {
    return `${minutes} min`;
  }

  return `${seconds} sec`;
}

/**
 * Roll up active and finished subscription sessions into a single calm summary.
 */
export function summariseFleet(sessions: readonly FleetSession[], now: number): FleetSummary {
  let working = 0;
  let waitingOnYou = 0;
  let finished = 0;
  let toolCalls = 0;
  let declined = 0;
  let failedCount = 0;
  let interruptedCount = 0;

  const subscriptionsInUse: string[] = [];
  const seenProviders = new Set<string>();
  let oldestActiveStartedAt: number | null = null;

  for (const session of sessions) {
    toolCalls += Number.isFinite(session.toolCalls) ? session.toolCalls : 0;
    declined += Number.isFinite(session.declined) ? session.declined : 0;

    if (session.outcome === "failed") {
      failedCount += 1;
    } else if (session.outcome === "interrupted") {
      interruptedCount += 1;
    }

    if (session.state === "done") {
      finished += 1;
    } else {
      if (session.state === "needs-approval") {
        waitingOnYou += 1;
      } else {
        working += 1;
      }

      if (!seenProviders.has(session.providerLabel)) {
        seenProviders.add(session.providerLabel);
        subscriptionsInUse.push(session.providerLabel);
      }

      if (oldestActiveStartedAt === null || session.startedAt < oldestActiveStartedAt) {
        oldestActiveStartedAt = session.startedAt;
      }
    }
  }

  const parts: string[] = [];
  if (working > 0) {
    parts.push(`${working} working`);
  }
  if (waitingOnYou > 0) {
    parts.push(waitingOnYou === 1 ? "1 needs you" : `${waitingOnYou} need you`);
  }
  if (finished > 0) {
    parts.push(`${finished} finished`);
  }

  const headline = parts.length === 0 ? "Nothing is running." : `${parts.join(", ")}.`;

  const longestRunning =
    oldestActiveStartedAt === null ? null : formatElapsed(now - oldestActiveStartedAt);

  const attention: string[] = [];
  if (waitingOnYou > 0) {
    attention.push(
      waitingOnYou === 1
        ? "1 session is waiting on you."
        : `${waitingOnYou} sessions are waiting on you.`
    );
  }
  if (failedCount > 0) {
    attention.push(
      failedCount === 1 ? "A session failed." : `${failedCount} sessions failed.`
    );
  }
  if (interruptedCount > 0) {
    attention.push(
      interruptedCount === 1
        ? "A session was interrupted."
        : `${interruptedCount} sessions were interrupted.`
    );
  }
  if (declined > 0) {
    attention.push(
      declined === 1 ? "1 decline occurred." : `${declined} declines occurred.`
    );
  }

  return {
    headline,
    working,
    waitingOnYou,
    finished,
    subscriptionsInUse,
    toolCalls,
    declined,
    longestRunning,
    attention
  };
}
