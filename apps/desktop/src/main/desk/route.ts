/**
 * Working out what somebody meant, so they never have to find the right screen.
 *
 * ## Why the front door is a sentence
 *
 * The old home screen was a dashboard: ₹82,910 outstanding, three customers, a
 * folder count, four agent cards. Every fact on it was true and **there was
 * nothing to do.** A person looking at money they are owed cannot chase it, cannot
 * record the payment that just landed, cannot add the bill in their hand. They
 * have to know which of nine places holds the verb they want.
 *
 * Nobody thinks in places. They think *"has Patel paid?"* and *"put this bill
 * in"* and *"is this quote fair — ask both of them"*. So the front door takes
 * that sentence, and the product finds the screen.
 *
 * ## Cheap first, and a model only when it must
 *
 * Most of what gets typed here is answerable without spending anything: the book
 * knows who owes money, and a pasted bill announces itself by shape. Routing
 * those through a model would spend a subscription call to learn something a
 * regular expression already knew, and it would be slower at it.
 *
 * So this is rules first, `null` when unsure, and the caller asks the cheapest
 * ready engine only for what is genuinely open-ended.
 *
 * ## It says which door it took
 *
 * Every route comes back with `because` — the words that decided it. A router
 * that guesses silently is one nobody can correct, and being wrong occasionally
 * is fine as long as being wrong is *visible*. This is the same rule the bill
 * reader follows: every field carries the words it was read from.
 *
 * ## It grants nothing
 *
 * A route is a *destination*, never a permission. Each one ends at a door that
 * already exists — the book's own reader, an agent's resolved brief, the Bench's
 * seats — and every one of those still asks what it always asked. Nothing here
 * can save a bill without a person confirming it, send a message, or reach a
 * folder that was not granted.
 */

export type DeskRoute =
  /** Answerable from the book alone. Costs nothing. */
  | { readonly kind: "book"; readonly ask: BookAsk; readonly because: string }
  /** Looks like a bill somebody pasted. Ends at the confirm form. */
  | { readonly kind: "bill"; readonly because: string }
  /** Two engines, on purpose. */
  | { readonly kind: "bench"; readonly because: string }
  /** One of the owner's agents, named or implied. */
  | { readonly kind: "agent"; readonly agentId: string; readonly because: string }
  /** Chase one named customer for what they owe. */
  | { readonly kind: "chase"; readonly party: string; readonly because: string }
  /** A plain question for the cheapest ready engine, with the book to hand. */
  | { readonly kind: "ask"; readonly because: string };

/**
 * The questions the book can answer with no model at all.
 *
 * `party` is deliberately absent. It was in this list, nothing ever produced it,
 * and `answerFromBook` had no branch for it — so a value that could never arrive
 * would have fallen through to the whole-ledger summary if it ever did. A dead
 * option in a union is a bug waiting for its first caller.
 */
export type BookAsk = "outstanding" | "overdue" | "counts";

/** Longer than this is not a question; it is something pasted. */
export const PASTE_CHARS = 220;

const OVERDUE = /\b(late|overdue|past due|not paid|unpaid|chase|chasing|remind)\b/iu;
const OWED = /\b(owe[sd]?|owing|outstanding|receivable|balance|due to me|how much)\b/iu;
const COUNTS = /\b(how many|count|total customers|number of)\b/iu;
const BENCH = /\b(both|second opinion|argue|debate|disagree|two models|check (?:the )?other)\b/iu;

/**
 * The marks of a bill rather than a sentence.
 *
 * A bill carries an amount **and** something structural — a GSTIN, an invoice
 * number, a tax line, a date. One of those alone is a sentence about money;
 * together they are a document. Requiring two is what keeps *"Patel owes me
 * ₹14,160"* from being read as a bill to file.
 */
const BILL_MARKS: readonly RegExp[] = [
  // `no\b` and not `no`: without the boundary these matched the *start* of
  // ordinary words, so "gst notice" and "bill not paid" both read as marks of a
  // document — and a question about an unpaid bill was routed to the bill form.
  /\bgstin\b|\bgst\s*no\b/iu,
  /\b(?:invoice|bill|challan)\s*(?:no\b|number\b|#)/iu,
  /\b(?:cgst|sgst|igst|tax)\b/iu,
  /\b(?:hsn|sac)\b/iu,
  /\b(?:qty|quantity|rate|amount)\b/iu,
  /\b(?:sub\s*total|grand\s*total|total)\b/iu
];

// A digit is required. `[\d,]+` alone matched a bare comma, so "fees in Rs.,
// not USD" carried an amount and could be read as a bill.
const AMOUNT = /(?:₹|\brs\.?\s*)\s*\d[\d,]*/iu;

/** Whether this is a bill rather than a question about one. */
export function looksLikeABill(text: string): boolean {
  if (text.length < 60 || !AMOUNT.test(text)) {
    return false;
  }
  const marks = BILL_MARKS.filter((mark) => mark.test(text)).length;
  // Two marks, or one mark on something long enough to be a document rather
  // than a sentence. A single "total" in a chatty message is not a bill.
  return marks >= 2 || (marks >= 1 && text.length > PASTE_CHARS);
}

export interface KnownAgent {
  readonly id: string;
  readonly name: string;
}

/**
 * Decides where a message goes, or returns null to let a model decide.
 *
 * Null is a real answer here and it is used often. A router that always has an
 * opinion sends *"what do you think about the Sharma job"* to the book, which
 * answers with a balance nobody asked for — and after two of those, people stop
 * typing sentences and go back to hunting for screens.
 */
const CHASE = /\b(chase|remind|follow up (?:with|on)|send .* reminder)\b/iu;

export function route(
  text: string,
  agents: readonly KnownAgent[],
  /** Customers the book knows, so "chase Devgiri" can find one. */
  parties: readonly string[] = []
): DeskRoute | null {
  const said = text.trim();
  if (said.length === 0) {
    return null;
  }

  if (looksLikeABill(said)) {
    return {
      kind: "bill",
      because: "that reads like a bill rather than a question"
    };
  }

  // An agent by name, which is the least ambiguous signal there is: the owner
  // wrote the thing's name, so they meant the thing.
  const named = agents.find(
    (agent) =>
      agent.name.trim().length > 2 &&
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(agent.name)}(?![\\p{L}\\p{N}])`, "iu").test(said)
  );
  if (named !== undefined) {
    return { kind: "agent", agentId: named.id, because: `you named ${named.name}` };
  }

  // A named customer plus a chasing word. Both are required: "chase" alone is
  // not a customer, and a name alone is a question about them rather than an
  // instruction to write to them.
  if (CHASE.test(said)) {
    const party = parties.find((name) => name.trim().length > 2 && mentions(said, name));
    if (party !== undefined) {
      return { kind: "chase", party, because: `you asked to chase ${party}` };
    }
    // Named nobody the book knows. Falling through was worse than useless: the
    // word "chase" also matches the overdue rule below, so "chase Vikram"
    // answered with the whole late list — a confident answer to a question
    // nobody asked. Null sends it to an engine, which can say it does not know
    // who Vikram is.
    return null;
  }

  if (BENCH.test(said)) {
    return { kind: "bench", because: "you asked for more than one opinion" };
  }

  // The book, only for a short question. A long message that happens to contain
  // "owes" is a paragraph about a customer, not a request for a balance.
  if (said.length <= PASTE_CHARS) {
    if (OVERDUE.test(said)) {
      return { kind: "book", ask: "overdue", because: "you asked about what is late" };
    }
    if (OWED.test(said)) {
      return { kind: "book", ask: "outstanding", because: "you asked about money owed" };
    }
    if (COUNTS.test(said)) {
      return { kind: "book", ask: "counts", because: "you asked how many" };
    }
  }

  return null;
}

/** Whether a sentence names this party as a name, not as a substring. */
export function mentions(sentence: string, party: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(party)}(?![\\p{L}\\p{N}])`, "iu").test(sentence);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
