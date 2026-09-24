/**
 * What you already own, and what is left of it today.
 *
 * ## Why this exists
 *
 * The pitch is *plug in the AI subscriptions you already pay for, and unlock
 * them.* Until now the product expressed that as a row of green lights, which
 * says "connected" and nothing about the thing that actually matters — **how
 * much capacity you have left across every subscription at once.**
 *
 * Nobody else can show this. A reseller cannot: your remaining capacity is its
 * revenue. A vendor cannot: it can only see its own. It is the one screen that
 * proves the claim rather than repeating it.
 *
 * ## It is not the front door
 *
 * A reviewer was right to refuse the first version of this, which called it the
 * hero surface: a quota gauge as the centrepiece says *developer utility for
 * maximising subscription ROI*, not *this runs your business*. It sits one click
 * from Today, it is the screen you show somebody when you explain what Rellane
 * is, and it is where a refusal sends you when a pool runs dry.
 *
 * ## A pool is an account and a family, not an account
 *
 * Claude and Gemini bill against different quotas inside one Antigravity login
 * (D-091), so three accounts are six budgets. Reporting per account would mark a
 * whole login spent while an untouched Opus quota sat beside it.
 *
 * ## Nothing here is printed unless it was measured
 *
 * `DESIGN.md` principle 4, and this module is where it is easiest to break:
 * vendors do not publish remaining quota, so most of what a person would like
 * to see here is genuinely unknown. A pool that has not been observed reports
 * `measured: false` and the screen says *not measured* — never a bar at 100%,
 * which is a claim dressed as a default. What **is** knowable is what this Mac
 * has spent through this app today, and that is what is reported.
 */

import { poolOf, type ModelFamily, type Seat, type SeatAccount } from "./accounts.js";
import type { Governor } from "./governor.js";

export interface PoolLine {
  /** `accountId:family` — the key a spent quota is remembered under. */
  readonly pool: string;
  readonly accountLabel: string;
  readonly family: ModelFamily;
  /** What a person reads: "Gemini · work". */
  readonly label: string;
  /**
   * True when this Mac has actually observed spend against this pool today.
   *
   * False is a real state and is said plainly. A vendor does not tell us what
   * remains, so an unobserved pool is unknown rather than full.
   */
  readonly measured: boolean;
  /** Estimated units spent through this app today. Zero when nothing ran. */
  readonly spentToday: number;
  /** What the governor will still admit today, or null when there is no ceiling. */
  readonly remainingToday: number | null;
  /** True when the provider behind it is not ready — signed out, or not installed. */
  readonly unavailable: boolean;
}

export interface Ledger {
  readonly accounts: number;
  /** Three logins are six budgets. This is the number the pitch turns on. */
  readonly pools: number;
  readonly lines: readonly PoolLine[];
  /** Seats in flight right now, across everything. */
  readonly working: number;
  /**
   * True when every pool is spent — distinct from having none configured.
   * The screen says different things about those and must be able to tell them
   * apart.
   */
  readonly allSpent: boolean;
  /**
   * Always true, and said on the screen: the local model on this Mac answers
   * when every subscription is gone. It is the floor, not the fallback, and it
   * is the reason a spent ledger is an inconvenience rather than an outage.
   */
  readonly localAlwaysAvailable: boolean;
}

/** Families in the order they are offered — cheapest pool first (D-091). */
const FAMILY_ORDER: readonly ModelFamily[] = ["gemini", "claude", "open"];

const FAMILY_WORD: Readonly<Record<ModelFamily, string>> = Object.freeze({
  gemini: "Gemini",
  claude: "Claude",
  open: "GPT-OSS"
});

/**
 * The ledger, assembled from what the governor has actually seen.
 *
 * Takes the governor rather than reading a store, so this module can be tested
 * without one and so there is exactly one place that knows what has been spent.
 *
 * `readySeats` is what the Engine Room found ready. A pool whose provider is not
 * ready is still **listed** — an account the owner added and then signed out of
 * is a fact they need to see, and omitting it would silently shrink the number
 * the whole pitch rests on.
 */
export function ledger(
  accounts: readonly SeatAccount[],
  readySeats: readonly Seat[],
  governor: Pick<Governor, "remainingToday" | "spentToday" | "running">
): Ledger {
  const ready = new Set(readySeats.map((seat) => poolOf(seat)));
  const lines: PoolLine[] = [];

  for (const account of accounts) {
    for (const family of FAMILY_ORDER) {
      const pool = poolOf({ accountId: account.id, family });
      const remaining = governor.remainingToday({ accountId: account.id, family });
      const seat = readySeats.find((candidate) => poolOf(candidate) === pool);
      const spent = governor.spentToday({ accountId: account.id, family });

      lines.push({
        pool,
        accountLabel: account.label,
        family,
        label: `${FAMILY_WORD[family]} · ${account.label}`,
        // Measured means this Mac has actually seen this pool used today, or
        // at minimum that its provider answered. Anything else is unknown,
        // and unknown is printed as unknown.
        measured: seat !== undefined || spent > 0,
        spentToday: spent,
        remainingToday: remaining,
        unavailable: !ready.has(pool)
      });
    }
  }

  return {
    accounts: accounts.length,
    pools: lines.length,
    lines,
    working: governor.running,
    allSpent: lines.length > 0 && lines.every((line) => (line.remainingToday ?? 1) <= 0),
    // Stated rather than computed, because it is a property of what ships: the
    // llama runtime is bundled and hash-pinned, and a test asserts it is copied
    // into the app (`packaging-contract.test.ts`, after it once was not).
    localAlwaysAvailable: true
  };
}

/**
 * One sentence a person can read, in the product's voice.
 *
 * `DESIGN.md` §7: say what is true in the owner's nouns, and never claim more
 * than was verified. Three accounts reads as six budgets because that is the
 * fact worth knowing, and the local model is named because it is what makes an
 * empty ledger survivable.
 */
export function ledgerSentence(view: Ledger): string {
  if (view.accounts === 0) {
    return "No subscriptions docked yet. The local model on this Mac answers in the meantime.";
  }
  const accounts = view.accounts === 1 ? "1 account" : `${view.accounts} accounts`;
  const pools = view.pools === 1 ? "1 budget" : `${view.pools} separate budgets`;
  if (view.allSpent) {
    return `${accounts}, ${pools}, and every one of them is spent for today. The local model on this Mac still answers.`;
  }
  return `${accounts}, ${pools}. Claude and Gemini bill separately inside one login, so they run out separately too.`;
}
