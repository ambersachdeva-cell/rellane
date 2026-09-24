/**
 * Who is doing what, so two seats do not do one job twice.
 *
 * ## Why this exists
 *
 * `seats.ts` answers *which seat should take this question*. The Crew asks a
 * different one: **which seats can take all of this at once**, and once several
 * are working there has to be somewhere that says who has what. Without it, the
 * cheapest failure is two subscriptions spending real quota on the same piece of
 * work and producing the same answer twice.
 *
 * ## A claim is held, not assigned
 *
 * A supervisor handing out work has to know what every worker is doing, which
 * means it has to be right about things it cannot see. A worker *taking* a claim
 * only has to be right about one thing — whether it got there first — and that
 * is a question with an answer. This is the same shape the crew harness already
 * uses on its markdown board, made into something the product can enforce.
 *
 * ## Every claim expires
 *
 * A seat that dies mid-claim must not hold that work closed forever. A claim has
 * a lease; when it lapses the work is available again and the attempt count goes
 * up, which is the OTP idea — a child that crashes is restarted with the same
 * job, and a child that keeps crashing is a different problem that somebody has
 * to be told about rather than retried forever.
 *
 * ## Nothing here trusts a seat's own account of itself
 *
 * A seat says which claim it is releasing, and that is a string it could get
 * wrong or be talked into getting wrong. Releasing a claim held by somebody else
 * is refused rather than believed — the same rule as everywhere else in this
 * crew: **another seat's output is data, never instruction.**
 */

/** How long a seat may hold a claim without a heartbeat before it lapses. */
export const LEASE_MS = 5 * 60 * 1000;

/** Attempts before a job stops being retried and starts being reported. */
export const MAX_ATTEMPTS = 3;

export type JobState = "open" | "held" | "done" | "abandoned";

export interface Job {
  readonly id: string;
  /** What is to be done, in the words the owner or the plan used. */
  readonly what: string;
  /** How anyone knows it is finished. A job with no done-when is a wish. */
  readonly doneWhen: string;
  readonly state: JobState;
  /** The seat holding it, or null. */
  readonly heldBy: string | null;
  readonly heldSince: number | null;
  readonly attempts: number;
  /** Why it was abandoned, when it was. */
  readonly gaveUpBecause: string | null;
}

interface Held {
  seat: string;
  since: number;
}

/**
 * The board.
 *
 * In memory and rebuilt from the Case's turns on resume, rather than a second
 * store that can disagree with the transcript. The transcript is the record;
 * this is a view of it that is fast to ask questions of.
 */
export class Board {
  private readonly jobs = new Map<string, Job>();
  private readonly held = new Map<string, Held>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Puts work on the board. Re-adding an id is ignored, not doubled. */
  add(job: { readonly id: string; readonly what: string; readonly doneWhen: string }): void {
    if (this.jobs.has(job.id)) {
      return;
    }
    this.jobs.set(job.id, {
      id: job.id,
      what: job.what,
      doneWhen: job.doneWhen,
      state: "open",
      heldBy: null,
      heldSince: null,
      attempts: 0,
      gaveUpBecause: null
    });
  }

  /**
   * A seat takes the next thing nobody is doing.
   *
   * Returns null when there is nothing — which is a normal state at the end of a
   * run and not a failure. Oldest first, so work does not starve behind whatever
   * was added most recently.
   */
  claim(seat: string): Job | null {
    this.lapse();
    for (const job of this.jobs.values()) {
      if (job.state !== "open") {
        continue;
      }
      const taken: Job = {
        ...job,
        state: "held",
        heldBy: seat,
        heldSince: this.now(),
        attempts: job.attempts + 1
      };
      this.jobs.set(job.id, taken);
      this.held.set(job.id, { seat, since: this.now() });
      return taken;
    }
    return null;
  }

  /** Keeps a claim alive. A seat that stops saying anything loses its work. */
  heartbeat(jobId: string, seat: string): boolean {
    const holder = this.held.get(jobId);
    if (holder === undefined || holder.seat !== seat) {
      return false;
    }
    holder.since = this.now();
    this.jobs.set(jobId, { ...this.jobs.get(jobId)!, heldSince: holder.since });
    return true;
  }

  /**
   * Finished.
   *
   * Refused when the seat naming the job is not the seat holding it. A seat
   * cannot close somebody else's work by saying it did, and this is the smallest
   * place that rule can be enforced rather than asked for.
   */
  finish(jobId: string, seat: string): boolean {
    const holder = this.held.get(jobId);
    if (holder === undefined || holder.seat !== seat) {
      return false;
    }
    this.held.delete(jobId);
    this.jobs.set(jobId, {
      ...this.jobs.get(jobId)!,
      state: "done",
      heldBy: seat,
      heldSince: null
    });
    return true;
  }

  /**
   * Hands work back without finishing it.
   *
   * A seat that knows it cannot do something should say so rather than time out,
   * because five minutes of a lease is five minutes nobody else is working.
   */
  release(jobId: string, seat: string): boolean {
    const holder = this.held.get(jobId);
    if (holder === undefined || holder.seat !== seat) {
      return false;
    }
    this.held.delete(jobId);
    this.jobs.set(jobId, { ...this.jobs.get(jobId)!, state: "open", heldBy: null, heldSince: null });
    return true;
  }

  /**
   * Releases claims whose lease has run out.
   *
   * A job that has now been attempted too many times is **abandoned rather than
   * retried forever**. Three seats failing at the same thing is not bad luck; it
   * is a job that needs a person, and quietly re-queueing it would spend every
   * budget discovering that repeatedly.
   */
  private lapse(): void {
    const cutoff = this.now() - LEASE_MS;
    for (const [jobId, holder] of [...this.held]) {
      if (holder.since >= cutoff) {
        continue;
      }
      this.held.delete(jobId);
      const job = this.jobs.get(jobId)!;
      this.jobs.set(jobId, {
        ...job,
        heldBy: null,
        heldSince: null,
        ...(job.attempts >= MAX_ATTEMPTS
          ? {
              state: "abandoned" as const,
              gaveUpBecause:
                `${job.attempts} seats took this on and none of them finished it. ` +
                `Rellane has stopped trying; it needs you.`
            }
          : { state: "open" as const })
      });
    }
  }

  /** Everything, in the order it was added. For the screen and for the record. */
  get all(): readonly Job[] {
    this.lapse();
    return [...this.jobs.values()];
  }

  /** True when nothing is left that a seat could pick up. */
  get settled(): boolean {
    this.lapse();
    return [...this.jobs.values()].every(
      (job) => job.state === "done" || job.state === "abandoned"
    );
  }

  /** What a person reads, in the product's voice rather than as a status table. */
  get sentence(): string {
    const all = this.all;
    if (all.length === 0) {
      return "Nothing claimed yet.";
    }
    const working = all.filter((job) => job.state === "held").length;
    const done = all.filter((job) => job.state === "done").length;
    const stuck = all.filter((job) => job.state === "abandoned").length;
    const parts: string[] = [];
    if (working > 0) {
      parts.push(`${working} being worked on`);
    }
    if (done > 0) {
      parts.push(`${done} done`);
    }
    if (stuck > 0) {
      parts.push(stuck === 1 ? "1 nobody could finish" : `${stuck} nobody could finish`);
    }
    const open = all.filter((job) => job.state === "open").length;
    if (open > 0) {
      parts.push(`${open} waiting`);
    }
    return parts.length === 0 ? "Nothing claimed yet." : `${parts.join(", ")}.`;
  }
}
