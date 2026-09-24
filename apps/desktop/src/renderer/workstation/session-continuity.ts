/**
 * Decision logic for resuming previous provider sessions.
 *
 * Evaluates past sessions against safety constraints (tool authority,
 * directory boundaries, provider retention limits) and returns calm,
 * plain-English resume options without performing provider CLI operations.
 */

export interface PastSession {
  readonly operationId: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly sessionId: string | null;     // null means it cannot be resumed
  readonly caseId: string;
  readonly caseTitle: string;
  readonly endedAt: number;
  readonly status: "completed" | "stopped" | "failed" | "interrupted";
  readonly hadTools: boolean;
  readonly workspacePath: string;
}

export interface ResumeOption {
  readonly operationId: string;
  readonly label: string;            // "Carry on with Claude, from this afternoon"
  readonly detail: string;           // what it would still remember, in plain words
  readonly available: boolean;
  readonly unavailableBecause: string | null;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESUME_OPTIONS = 5;

/**
 * Formats a plain British English description of when the session ended.
 */
function describeTime(endedAt: number, now: number): string {
  if (endedAt >= now) {
    return "just now";
  }

  const endedDate = new Date(endedAt);
  const nowDate = new Date(now);

  const startOfNow = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();

  const startOfEnded = new Date(
    endedDate.getFullYear(),
    endedDate.getMonth(),
    endedDate.getDate(),
  ).getTime();

  const calendarDaysAgo = Math.round(
    (startOfNow - startOfEnded) / (24 * 60 * 60 * 1000),
  );

  if (calendarDaysAgo === 0) {
    const hours = endedDate.getHours();
    if (hours < 12) {
      return "this morning";
    }
    if (hours < 17) {
      return "this afternoon";
    }
    return "this evening";
  }

  if (calendarDaysAgo === 1) {
    const hours = endedDate.getHours();
    if (hours < 12) {
      return "yesterday morning";
    }
    if (hours < 17) {
      return "yesterday afternoon";
    }
    return "yesterday evening";
  }

  if (calendarDaysAgo < 7) {
    return `${calendarDaysAgo} days ago`;
  }

  if (calendarDaysAgo < 30) {
    const weeks = Math.floor(calendarDaysAgo / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }

  if (calendarDaysAgo < 365) {
    const months = Math.floor(calendarDaysAgo / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }

  const years = Math.floor(calendarDaysAgo / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/**
 * Builds the detail explanation describing what would be retained.
 * Remains honest about provider memory limits and surfaces the 7-day threshold.
 */
function buildDetail(session: PastSession, now: number): string {
  const caseRef =
    session.caseTitle.trim().length > 0
      ? `from “${session.caseTitle.trim()}”`
      : "from that case";

  const isOld = now - session.endedAt > SEVEN_DAYS_MS;

  if (isOld) {
    return `Earlier conversation ${caseRef}. This is older than 7 days, so it may have been forgotten by ${session.providerLabel}.`;
  }

  return `Earlier conversation ${caseRef}, if ${session.providerLabel} still retains it.`;
}

/**
 * Determines whether a session is safe and possible to resume.
 * Refuses tool-bearing sessions and cross-folder sessions.
 */
function getUnavailableReason(
  session: PastSession,
  targetWorkspacePath: string,
  allPast: readonly PastSession[],
): string | null {
  // Tool-bearing sessions must never resume because tool grants persist in native threads.
  const threadHadTools =
    session.hadTools ||
    (session.sessionId !== null &&
      allPast.some(
        (p) => p.sessionId === session.sessionId && p.hadTools,
      ));

  if (threadHadTools) {
    return "That one could use your files, so it starts fresh.";
  }

  // Resuming across different directories would leak another folder's context.
  const threadCrossedFolder =
    session.workspacePath !== targetWorkspacePath ||
    (session.sessionId !== null &&
      allPast.some(
        (p) =>
          p.sessionId === session.sessionId &&
          p.workspacePath !== targetWorkspacePath,
      ));

  if (threadCrossedFolder) {
    return "That was in a different folder, so it cannot be resumed here.";
  }

  // If the provider never assigned a session ID, there is no thread to resume.
  if (session.sessionId === null) {
    return "The provider never gave a session to carry on from.";
  }

  return null;
}

/**
 * Evaluates past sessions and returns up to 5 resume options, most recent first,
 * exclusively for the selected provider.
 */
export function resumeOptions(input: {
  readonly past: readonly PastSession[];
  readonly caseId: string;
  readonly providerId: string;
  readonly workspacePath: string;
  readonly now: number;
}): readonly ResumeOption[] {
  // Only sessions for the chosen provider are eligible for resuming.
  const matchingProvider = input.past.filter(
    (s) => s.providerId === input.providerId,
  );

  // Present most recent sessions first.
  const sorted = [...matchingProvider].sort((a, b) => b.endedAt - a.endedAt);

  // When multiple operations share a sessionId, only offer the most recent turn.
  // Sessions with null sessionId are distinct runs without an ID and are not collapsed.
  const seenSessionIds = new Set<string>();
  const deduplicated: PastSession[] = [];

  for (const session of sorted) {
    if (session.sessionId !== null) {
      if (seenSessionIds.has(session.sessionId)) {
        continue;
      }
      seenSessionIds.add(session.sessionId);
    }
    deduplicated.push(session);
  }

  const options: ResumeOption[] = [];
  const limit = Math.min(deduplicated.length, MAX_RESUME_OPTIONS);

  for (let i = 0; i < limit; i++) {
    const session = deduplicated[i]!;
    const unavailableBecause = getUnavailableReason(
      session,
      input.workspacePath,
      input.past,
    );

    options.push({
      operationId: session.operationId,
      label: `Carry on with ${session.providerLabel}, from ${describeTime(session.endedAt, input.now)}`,
      detail: buildDetail(session, input.now),
      available: unavailableBecause === null,
      unavailableBecause,
    });
  }

  return options;
}
