/**
 * Settling an argument with the book instead of with rhetoric.
 *
 * ## The failure this exists to stop
 *
 * Two frontier models arguing produce confident prose on both sides, and the
 * one that wins is the one that argues better. That is fine for a question of
 * judgement and **actively dangerous** for a question of fact: *"Devgiri owes
 * more than Verma"* is not a matter of opinion, and an argument that resolves it
 * by eloquence has produced a wrong answer with two models' worth of authority
 * behind it.
 *
 * Where the book can settle a claim, the book settles it. Nothing about how
 * well either side wrote enters into it.
 *
 * ## It only speaks where ground truth exists
 *
 * That is the whole discipline. This checks the one class of claim the book can
 * actually decide — **an amount stated against a named party** — and says
 * nothing at all about everything else. A adjudicator that had an opinion on
 * *"is this quote fair"* would be a third model with extra steps, and it would
 * be believed more than the other two because it arrived last and sounded
 * official.
 *
 * So the output has three states, and the middle one is the common one:
 * checked-and-wrong, checked-and-right, and **nothing here was checkable**.
 *
 * ## Why it reads rather than asks
 *
 * No engine is involved. The adjudicator is a SQL query and a regular
 * expression, which is exactly why its verdict is worth more than a third
 * opinion: it cannot be argued with, cannot be flattered, and costs nothing.
 */

import type { DatabaseSync } from "node:sqlite";
import { outstanding } from "../book/records.js";
import { rupees } from "../book/money.js";
import { paiseOf } from "../book/extract.js";

export interface Claim {
  /** The party the claim is about, as the book spells them. */
  readonly party: string;
  /** What the turn said they owe, in paise. */
  readonly saidPaise: number;
  /** What the book says, in paise. */
  readonly actualPaise: number;
  readonly right: boolean;
  /** The words the claim was read from, so a person can check the checker. */
  readonly from: string;
}

export interface Adjudication {
  /** False when nothing in the argument was checkable. The common case. */
  readonly checked: boolean;
  readonly claims: readonly Claim[];
  /** Which seat stated something the book contradicts, if either. */
  readonly wrong: readonly ("proposer" | "adversary")[];
  /** What the evidence says, in the owner's words. Always set. */
  readonly said: string;
}

/**
 * An amount written next to a name, which is the one thing the book can settle.
 *
 * `\brs` and not `rs`: without the boundary, every English word ending in those
 * letters became a currency marker — *"hours 10"*, *"orders 500"*,
 * *"creditors 2000"* — and the adjudicator confidently marked a correct engine
 * wrong on the strength of a word.
 */
const AMOUNT = /(?:₹|\brs\.?\s*)\s*([\d,]+(?:\.\d{1,2})?)/giu;

/**
 * Finds claims of the form "<party> … <amount>" in one turn.
 *
 * Matched by looking for a party the book knows and then an amount within the
 * same sentence. Deliberately narrow: a looser rule would pair a name in one
 * clause with a figure in another and then confidently mark a correct engine
 * wrong, which is worse than checking nothing at all.
 */
/**
 * Whether a sentence names this party, as a name rather than as a substring.
 *
 * `includes` matched a party called *Dev* inside "development" and *Om* inside
 * "customer". A short trading name is common, and an adjudicator that fires on
 * one is worse than one that never fires at all.
 */
function names(sentence: string, party: string): boolean {
  const escaped = party.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(sentence);
}

export function claimsIn(text: string, parties: readonly { name: string; owedPaise: number }[]): readonly Claim[] {
  const found: Claim[] = [];
  // `Rs.` is not the end of a sentence, and on an Indian bill it is everywhere.
  // Splitting on its full stop separated every name from its amount, so
  // "Devgiri Traders owes Rs. 9440." checked as two sentences and matched
  // nothing — the same abbreviation-dot trap the glossary normaliser hit.
  const flattened = text.replace(/\bRs\.\s*/giu, "Rs ");
  // Sentence at a time, because the pairing has to be local to be trustworthy.
  for (const sentence of flattened.split(/(?<=[.!?])\s+|\n+/u)) {
    for (const party of parties) {
      if (!names(sentence, party.name)) {
        continue;
      }
      AMOUNT.lastIndex = 0;
      const first = AMOUNT.exec(sentence);
      if (first === null) {
        continue;
      }
      // A sentence carrying more than one figure is one we cannot read: which
      // of them the party owes is a guess, and guessing here means marking a
      // correct engine wrong. Skipped rather than assumed.
      if (AMOUNT.exec(sentence) !== null) {
        continue;
      }
      const match = first;
      const saidPaise = paiseOf(match[0]);
      if (saidPaise === null) {
        continue;
      }
      found.push({
        party: party.name,
        saidPaise,
        actualPaise: party.owedPaise,
        right: saidPaise === party.owedPaise,
        from: sentence.trim().slice(0, 200)
      });
      // One claim per sentence. A sentence naming two customers and one figure
      // does not say which of them owes it.
      break;
    }
  }
  return found;
}

/**
 * Checks an argument against the book.
 *
 * Never guesses and never has an opinion. When nothing was checkable it says
 * so, which is the honest and common outcome — and saying it plainly is what
 * stops somebody reading a silent adjudicator as agreement.
 */
export function adjudicate(
  db: DatabaseSync,
  turns: readonly { seat: "proposer" | "adversary" | "adjudicator"; text: string }[]
): Adjudication {
  const parties = outstanding(db).map((party) => ({
    name: party.name,
    owedPaise: party.owedPaise
  }));

  const claims: Claim[] = [];
  const wrong = new Set<"proposer" | "adversary">();
  for (const turn of turns) {
    if (turn.seat === "adjudicator") {
      continue;
    }
    for (const claim of claimsIn(turn.text, parties)) {
      claims.push(claim);
      if (!claim.right) {
        wrong.add(turn.seat);
      }
    }
  }

  if (claims.length === 0) {
    return {
      checked: false,
      claims: [],
      wrong: [],
      said: "Nothing in this argument was a figure the book could check, so the book has stayed out of it. That is the usual case for a question of judgement."
    };
  }

  const bad = claims.filter((claim) => !claim.right);
  if (bad.length === 0) {
    return {
      checked: true,
      claims,
      wrong: [],
      said: `Checked ${claims.length} ${claims.length === 1 ? "figure" : "figures"} against the book. All correct.`
    };
  }

  const first = bad[0];
  return {
    checked: true,
    claims,
    wrong: [...wrong],
    said: `The book disagrees. ${first?.party} owes ${rupees(first?.actualPaise ?? 0)}, not ${rupees(
      first?.saidPaise ?? 0
    )}${bad.length > 1 ? `, and ${bad.length - 1} other ${bad.length === 2 ? "figure is" : "figures are"} wrong too` : ""}. This is not a matter of who argued better — the records say otherwise.`
  };
}
