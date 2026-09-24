/**
 * The Bench — two models arguing to a decision, with a stop.
 *
 * Amber's idea, built against its own failure modes rather than around them.
 * The three that would make this a gimmick, and what stops each:
 *
 *   **Sycophancy.** Models agree with what they just read. Roles are assigned
 *   in `roles.ts` and the adversary is shown the claim without the reasoning,
 *   so it has to construct its own account rather than critique the edges of a
 *   case it has been anchored by.
 *
 *   **It never ends.** Two models can loop agreeably forever or diverge
 *   forever, and both spend a subscription on nothing. Every session
 *   terminates: on agreement, on a concession, on a round ceiling, or on a
 *   budget in tokens — whichever comes first, checked before each turn rather
 *   than after.
 *
 *   **Nobody decides.** A transcript is not an outcome. Every session ends with
 *   one of five named outcomes, and when the models cannot settle it the
 *   session says so plainly instead of presenting the longer answer as a
 *   verdict.
 *
 * What it deliberately does *not* do is have a third model pick a winner. A
 * third opinion is not a verdict, and where evidence exists the Backtest
 * settles it — see D-018.
 */

import { randomUUID } from "node:crypto";
import {
  adversaryPrompt,
  proposerPrompt,
  readClaim,
  readVerdict,
  rebuttalPrompt,
  type Seat
} from "./roles.js";
import { roughTokens } from "../agents/context.js";

export type BenchOutcome =
  /** Both reached the same conclusion. The strongest result available. */
  | "agreed"
  /** The proposer accepted the objection and corrected itself. */
  | "corrected"
  /** They still disagree. A person decides, and the transcript is the input. */
  | "unresolved"
  /** Stopped at the round ceiling or the token budget. */
  | "exhausted"
  /** An engine failed. Named rather than dressed up as a disagreement. */
  | "failed";

export interface BenchTurn {
  readonly seat: Seat;
  readonly engineLabel: string;
  readonly text: string;
  readonly verdict: ReturnType<typeof readVerdict>;
  readonly approxTokens: number;
}

export interface BenchSession {
  readonly id: string;
  readonly question: string;
  readonly outcome: BenchOutcome;
  /** The conclusion as it stands at the end. Empty when nothing survived. */
  readonly answer: string;
  readonly turns: readonly BenchTurn[];
  readonly rounds: number;
  readonly approxTokens: number;
  /** Why it stopped, in the owner's words. Always set. */
  readonly stoppedBecause: string;
}

/**
 * What each side has spent.
 *
 * Per seat, not just in total, because the total answers the wrong question. An
 * argument where one side wrote four times as much as the other is not a
 * balanced argument, and the number that shows it is the per-seat one — a
 * combined figure hides exactly the imbalance somebody would want to act on.
 *
 * Tokens rather than rupees, for the reason in D-022: a subscription has no
 * per-token price, so a currency figure here would be invented.
 */
export interface BenchSpend {
  readonly proposerTokens: number;
  readonly adversaryTokens: number;
  readonly totalTokens: number;
  /** How much of the budget is gone, 0–1. */
  readonly fraction: number;
}

/** What each seat has spent so far, from the turns that have happened. */
export function spendOf(
  turns: readonly BenchTurn[],
  limits: BenchLimits = DEFAULT_LIMITS
): BenchSpend {
  const bySeat = (seat: Seat): number =>
    turns.filter((turn) => turn.seat === seat).reduce((sum, turn) => sum + turn.approxTokens, 0);
  const proposerTokens = bySeat("proposer");
  const adversaryTokens = bySeat("adversary");
  const totalTokens = turns.reduce((sum, turn) => sum + turn.approxTokens, 0);
  return {
    proposerTokens,
    adversaryTokens,
    totalTokens,
    // Clamped, because a final turn can carry the total past the budget: the
    // check happens before spending, not during, and a meter reading 104% looks
    // like a bug rather than like a budget doing its job.
    fraction: limits.maxTokens === 0 ? 0 : Math.min(1, totalTokens / limits.maxTokens)
  };
}

export interface BenchLimits {
  /** A full exchange is one round. Two is usually enough to find real fault. */
  readonly maxRounds: number;
  /** Counted across every turn, because the bill is the sum, not the largest. */
  readonly maxTokens: number;
}

export const DEFAULT_LIMITS: BenchLimits = { maxRounds: 3, maxTokens: 60_000 };

export interface BenchSeats {
  readonly proposer: { readonly label: string; ask(prompt: string): Promise<string> };
  readonly adversary: { readonly label: string; ask(prompt: string): Promise<string> };
}

/**
 * Runs one argument to a conclusion or to its budget.
 *
 * Never throws. An engine failing mid-debate is an outcome with a transcript
 * attached, not an exception — the turns that already happened cost real money
 * and must not be thrown away with the error.
 */
export async function runBench(
  question: string,
  seats: BenchSeats,
  limits: BenchLimits = DEFAULT_LIMITS,
  /**
   * Called as each turn lands, so the meter moves while the argument runs.
   *
   * The done-when is *"the price of an argument is known before it finishes"* —
   * a figure printed at the end is a receipt, not a meter, and by then the
   * money is spent. Never awaited and never allowed to throw: an argument that
   * failed because something was watching it would be the worst trade.
   */
  onTurn?: (turn: BenchTurn, spend: BenchSpend) => void
): Promise<BenchSession> {
  const id = randomUUID();
  const turns: BenchTurn[] = [];
  let spent = 0;

  const record = (seat: Seat, engineLabel: string, text: string): BenchTurn => {
    const turn: BenchTurn = {
      seat,
      engineLabel,
      text,
      verdict: readVerdict(text),
      approxTokens: roughTokens(text)
    };
    spent += turn.approxTokens;
    turns.push(turn);
    try {
      onTurn?.(turn, spendOf(turns, limits));
    } catch {
      // An observer that throws is an observer's problem.
    }
    return turn;
  };

  const done = (
    outcome: BenchOutcome,
    answer: string,
    stoppedBecause: string,
    rounds: number
  ): BenchSession => ({
    id,
    question,
    outcome,
    answer,
    turns,
    rounds,
    approxTokens: spent,
    stoppedBecause
  });

  let claim = "";
  let answer = "";

  for (let round = 1; round <= limits.maxRounds; round += 1) {
    // Checked before the turn, not after. Discovering the budget is blown once
    // the tokens are already spent is a report, not a limit.
    if (spent >= limits.maxTokens) {
      return done(
        "exhausted",
        answer,
        `Stopped at the ${limits.maxTokens.toLocaleString()}-token budget after ${round - 1} rounds.`,
        round - 1
      );
    }

    try {
      if (round === 1) {
        const opening = await seats.proposer.ask(proposerPrompt(question));
        record("proposer", seats.proposer.label, opening);
        claim = readClaim(opening);
        answer = opening;
      }

      const objection = await seats.adversary.ask(adversaryPrompt(question, claim));
      const critique = record("adversary", seats.adversary.label, objection);

      if (critique.verdict === "agree") {
        return done(
          "agreed",
          answer,
          `${seats.adversary.label} reached the same conclusion independently.`,
          round
        );
      }

      const rebuttal = await seats.proposer.ask(rebuttalPrompt(claim, objection));
      const reply = record("proposer", seats.proposer.label, rebuttal);

      if (reply.verdict === "concede") {
        // The cheapest correct outcome there is: the objection held and the
        // answer changed because of it.
        return done(
          "corrected",
          rebuttal,
          `${seats.proposer.label} accepted the objection and corrected its answer.`,
          round
        );
      }

      // Held. The claim may have moved, so the next round attacks what is
      // actually being asserted now rather than what was asserted first.
      claim = readClaim(rebuttal);
      answer = rebuttal;
    } catch (error) {
      return done(
        "failed",
        answer,
        `An engine stopped answering: ${
          error instanceof Error ? error.message : "no reason given"
        }`,
        round
      );
    }
  }

  return done(
    "unresolved",
    answer,
    `They still disagree after ${limits.maxRounds} rounds. The transcript is what you decide from.`,
    limits.maxRounds
  );
}

/** One sentence for the record. */
export function describeBench(session: BenchSession): string {
  switch (session.outcome) {
    case "agreed":
      return `Both agreed after ${session.rounds === 1 ? "one round" : `${session.rounds} rounds`}.`;
    case "corrected":
      return "The first answer was wrong and was corrected.";
    case "unresolved":
      return "They did not agree. You decide.";
    case "exhausted":
      return session.stoppedBecause;
    case "failed":
      return session.stoppedBecause;
  }
}
