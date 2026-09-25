/**
 * The question a session asks before it touches a file, carried to his phone.
 *
 * He decided the phone may run what he could run. That decision only means
 * anything if the phone can also answer the question the session stops to ask —
 * otherwise a session started from a phone runs until it wants to write
 * something and then waits, silently, for somebody to walk back to the Mac.
 *
 * What it does not do is answer for him. Nothing here allows anything: it
 * announces what is waiting, in the words the session used, and turns a plain
 * yes or no into one decision about one named call. An unanswered question
 * stays unanswered.
 */

export interface WaitingCall {
  readonly operationId: string;
  readonly permissionId: string;
  readonly title: string;
  readonly detail: string;
  /** Oldest first, so "yes" is never ambiguous about which it meant. */
  readonly since: number;
}

export interface LiveRun {
  readonly operationId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly permission: { readonly id: string; readonly title: string; readonly detail: string } | null;
}

/** Every call waiting on an answer, oldest first. */
export function waitingCalls(runs: readonly LiveRun[]): readonly WaitingCall[] {
  const waiting: WaitingCall[] = [];
  for (const run of runs) {
    if (run.status !== "needs-approval" || run.permission === null) {
      continue;
    }
    waiting.push({
      operationId: run.operationId,
      permissionId: run.permission.id,
      title: run.permission.title,
      detail: run.permission.detail,
      since: run.updatedAt
    });
  }
  return waiting.sort((a, b) => a.since - b.since || a.permissionId.localeCompare(b.permissionId));
}

/**
 * What to say about a call that is waiting.
 *
 * The session's own words for what it wants, not a summary of them. A summary
 * is a second description of an action he is about to authorise, and if the two
 * ever disagree he approved the wrong one.
 */
export function describeCall(call: WaitingCall, code?: string): string {
  const detail = call.detail.trim();
  const body = detail.length > 0 && detail !== call.title.trim()
    ? `${call.title.trim()}\n${detail}`
    : call.title.trim();
  return `Your Mac is waiting to do this:\n\n${body}\n\n${code === undefined ? "Reply yes to allow it once, or no to decline." : `Reply yes ${code} to allow it once, or no ${code} to decline. This code expires in five minutes.`}`;
}

export type Decision = "allow" | "deny";

const YES = /^(?:\/)?(?:y|ye|yes|yep|yeah|ok|okay|allow|approve|go|go\s+ahead|do\s+it|sure|fine)\b[\s.!]*$/i;
const NO = /^(?:\/)?(?:n|no|nope|nah|deny|decline|don'?t|do\s+not|refuse|reject|skip)\b[\s.!]*$/i;

/**
 * A plain yes or no, and nothing else.
 *
 * Deliberately anchored to the whole message. "yes, and also rewrite the
 * config" is not an approval of one named call — it is a new request wearing
 * the word yes, and reading it as consent would approve a thing he never saw.
 */
export function readDecision(text: string): Decision | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (YES.test(trimmed)) {
    return "allow";
  }
  if (NO.test(trimmed)) {
    return "deny";
  }
  return null;
}

/**
 * Remembers which calls have already been announced, so a poll that runs every
 * few seconds does not send the same question over and over.
 */
export class AnnouncedCalls {
  private readonly told = new Set<string>();

  /** The calls in this batch that have not been successfully delivered yet. */
  fresh(calls: readonly WaitingCall[]): readonly WaitingCall[] {
    const out: WaitingCall[] = [];
    for (const call of calls) {
      const key = `${call.operationId}:${call.permissionId}`;
      if (this.told.has(key)) {
        continue;
      }
      out.push(call);
    }
    return out;
  }

  /** A send failure must leave the call eligible for the next poll. */
  markDelivered(call: WaitingCall): void {
    this.told.add(`${call.operationId}:${call.permissionId}`);
  }

  /** Expired challenges need a new code even while the action stays waiting. */
  forget(call: WaitingCall): void {
    this.told.delete(`${call.operationId}:${call.permissionId}`);
  }

  /**
   * Forgets calls that are no longer waiting.
   *
   * Without this the set grows for as long as the app runs, and — worse — a
   * provider that reuses a permission id after a decision would find its second
   * question already marked as asked, and he would never be told about it.
   */
  keepOnly(calls: readonly WaitingCall[]): void {
    const live = new Set(calls.map((call) => `${call.operationId}:${call.permissionId}`));
    for (const key of this.told) {
      if (!live.has(key)) {
        this.told.delete(key);
      }
    }
  }
}
