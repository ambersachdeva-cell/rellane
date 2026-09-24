/**
 * What stops the crew spending every budget you own in eleven minutes.
 *
 * `RequestQueue` paces one provider. This sits above all of them and answers a
 * different question: **may another seat start at all, right now.**
 *
 * ## Why a ceiling on recorded spend does not work
 *
 * The obvious governor reads what has been spent and refuses once it passes a
 * limit. A reviewer took that apart before it was built, and the hole is fatal:
 *
 * > Vendor CLIs report nothing while they run, and the print timeout is thirty
 * > minutes. Six seats are admitted together because recorded spend is still
 * > under the ceiling; all six then run for half an hour reporting nothing. By
 * > the time the first one exits and writes its spend, every pool is empty.
 *
 * A governor that only reads the past cannot govern the present. So this one
 * does what a scheduler does — **admission control**, on three axes, each of
 * which survives the other two being wrong:
 *
 * 1. **A concurrency ceiling**, overall and per pool. This is the axis that
 *    works even when every estimate is wrong, and it is why it exists.
 * 2. **Reserve at admission, reconcile at exit.** A seat's *estimated* cost is
 *    deducted the moment it starts, not when it finishes. The estimate will be
 *    wrong; being wrong early is survivable, being blind for thirty minutes is
 *    not.
 * 3. **A wall clock.** A seat past its own budget is abandoned by the governor
 *    and its reservation released, because the vendor's print timeout is the
 *    vendor's patience and has nothing to do with ours.
 *
 * ## It only ever subtracts
 *
 * There is no value of any option here that means "allow everything", and a
 * running case cannot raise its own ceiling. That is the same shape as the
 * outbound lock, for the same reason: a limit a caller can lift is a limit that
 * will be lifted by the caller that most needs stopping.
 *
 * ## A refusal says what is still possible
 *
 * `DESIGN.md` §7: the useful part of "no" is what to do next, and what is still
 * true. A refusal here names the pool that is gone and what remains, never a
 * bare `false`.
 */

import { poolOf, type Seat } from "./accounts.js";

export interface GovernorLimits {
  /** Seats that may be in flight at once, across every pool. */
  readonly maxInFlight: number;
  /** Seats in flight against one `(account, family)` pool. */
  readonly maxInFlightPerPool: number;
  /** Estimated units one pool may spend per day. Units are the caller's own. */
  readonly dailyPerPool: number;
  /** Estimated units one case may spend, across every pool it touches. */
  readonly perCase: number;
  /** How long a seat may run before the governor stops counting on it. */
  readonly wallClockMs: number;
}

/** Sensible for one person's three accounts. Deliberately not generous. */
export const DEFAULT_LIMITS: GovernorLimits = Object.freeze({
  maxInFlight: 3,
  maxInFlightPerPool: 1,
  dailyPerPool: 1_000_000,
  perCase: 400_000,
  wallClockMs: 25 * 60 * 1000
});

export interface Admission {
  readonly ok: true;
  /** Hand this back when the seat finishes, with what it really cost. */
  readonly ticket: string;
}

export interface Refusal {
  readonly ok: false;
  /** One sentence, in the product's voice, naming what is still possible. */
  readonly because: string;
  /** Which pool ran out, when that is the reason. Null when it is not. */
  readonly pool: string | null;
}

export type Verdict = Admission | Refusal;

interface Reservation {
  readonly ticket: string;
  readonly pool: string;
  readonly caseId: string;
  readonly estimate: number;
  readonly startedAt: number;
}

export class Governor {
  private readonly limits: GovernorLimits;
  private readonly now: () => number;

  private readonly inFlight = new Map<string, Reservation>();
  /** Spent per pool, per day. Keyed `pool@day` so a new day starts clean. */
  private readonly spentByPoolDay = new Map<string, number>();
  private readonly spentByCase = new Map<string, number>();
  private next = 0;

  constructor(limits: Partial<GovernorLimits> = {}, now: () => number = () => Date.now()) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
  }

  /**
   * May this seat start?
   *
   * `estimate` is what the caller thinks it will cost. It will be wrong. The
   * concurrency ceilings are what make being wrong survivable.
   */
  admit(seat: Seat, caseId: string, estimate: number): Verdict {
    this.expire();
    const pool = poolOf(seat);

    if (this.inFlight.size >= this.limits.maxInFlight) {
      return {
        ok: false,
        because: `${this.limits.maxInFlight} seats are already working. This one starts when one of them finishes.`,
        pool: null
      };
    }

    const inPool = [...this.inFlight.values()].filter((one) => one.pool === pool).length;
    if (inPool >= this.limits.maxInFlightPerPool) {
      return {
        ok: false,
        because: `${seat.label} is already working on this subscription. Another account can take this instead.`,
        pool
      };
    }

    const day = this.dayKey(pool);
    const spentToday = this.spentByPoolDay.get(day) ?? 0;
    if (spentToday + estimate > this.limits.dailyPerPool) {
      return {
        ok: false,
        because: `${seat.label} has used today's budget on this subscription. Your other accounts are untouched, and the local model on this Mac always answers.`,
        pool
      };
    }

    const spentOnCase = this.spentByCase.get(caseId) ?? 0;
    if (spentOnCase + estimate > this.limits.perCase) {
      return {
        ok: false,
        because: `This case has spent what it was given. Raise its budget yourself, or close it — Rellane will not raise it for you.`,
        pool: null
      };
    }

    // Reserved now, not when it finishes. This is the whole point: a seat that
    // reports nothing for half an hour is still counted against the budget for
    // that half hour.
    this.next += 1;
    const ticket = `t${this.next}`;
    this.inFlight.set(ticket, {
      ticket,
      pool,
      caseId,
      estimate,
      startedAt: this.now()
    });
    this.spentByPoolDay.set(day, spentToday + estimate);
    this.spentByCase.set(caseId, spentOnCase + estimate);
    return { ok: true, ticket };
  }

  /**
   * A seat finished. `actual` replaces the estimate that was reserved.
   *
   * Reconciling downward matters as much as upward: an over-cautious estimate
   * that is never given back is a budget that shrinks all day for no reason.
   */
  finished(ticket: string, actual: number): void {
    const held = this.inFlight.get(ticket);
    if (held === undefined) {
      // Already expired by the wall clock, or never issued. Its reservation was
      // released then; adding the real cost now would charge for it twice.
      return;
    }
    this.inFlight.delete(ticket);
    const correction = actual - held.estimate;
    const day = this.dayKey(held.pool);
    this.spentByPoolDay.set(day, Math.max(0, (this.spentByPoolDay.get(day) ?? 0) + correction));
    this.spentByCase.set(
      held.caseId,
      Math.max(0, (this.spentByCase.get(held.caseId) ?? 0) + correction)
    );
  }

  /** What is running now, for the screen that says so. */
  get running(): number {
    this.expire();
    return this.inFlight.size;
  }

  /** Estimated units left in a pool today. Never negative. */
  remainingToday(seat: Pick<Seat, "accountId" | "family">): number {
    this.expire();
    const day = this.dayKey(poolOf(seat));
    return Math.max(0, this.limits.dailyPerPool - (this.spentByPoolDay.get(day) ?? 0));
  }

  /**
   * Estimated units this pool has spent today, reservations included.
   *
   * Reported rather than derived by a caller, because the ceiling lives here
   * and a second place computing `ceiling - remaining` is a second number that
   * can drift. Same reason the book derives every balance in one place.
   */
  spentToday(seat: Pick<Seat, "accountId" | "family">): number {
    this.expire();
    return this.spentByPoolDay.get(this.dayKey(poolOf(seat))) ?? 0;
  }

  /** The per-pool daily ceiling, so a screen can show a proportion honestly. */
  get dailyCeiling(): number {
    return this.limits.dailyPerPool;
  }

  /** Everything currently in flight, oldest first. For the stop button. */
  get tickets(): readonly string[] {
    this.expire();
    return [...this.inFlight.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((one) => one.ticket);
  }

  /**
   * Stops counting on seats that have outrun their wall clock.
   *
   * Their reservation is released so a hung seat cannot hold a pool closed
   * forever — but what it already spent stays spent, because it did spend it.
   */
  private expire(): void {
    const cutoff = this.now() - this.limits.wallClockMs;
    for (const [ticket, held] of this.inFlight) {
      if (held.startedAt < cutoff) {
        this.inFlight.delete(ticket);
      }
    }
  }

  private dayKey(pool: string): string {
    // Local day, because a person's "today" is the one on their own wall.
    const at = new Date(this.now());
    return `${pool}@${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
  }
}
