/**
 * Doing what was asked, through the doors that already exist.
 *
 * The desk is a **front door, not a new authority.** Every route ends somewhere
 * that was already there and still asks whatever it always asked: a bill lands
 * on the confirm form and is stored by nobody until a person says so; an agent
 * runs inside its resolved brief and its granted folders; the Bench seats two
 * engines the main process picked. Nothing here can send a message, reach a
 * folder that was not granted, or write a figure into the book.
 *
 * That property is what makes a conversational front door safe to build. If
 * typing a sentence could do more than pressing the buttons, the sentence would
 * be a way around the buttons — and every promise this product makes is enforced
 * at a button.
 *
 * ## The book answers for free where it can
 *
 * *"Who owes me money"* is a query, not a question for a model. Answering it
 * with a subscription call would be slower, cost something, and risk a
 * hallucinated figure in the one place figures must be exact.
 */

import type { DatabaseSync } from "node:sqlite";
import { counts, outstanding, overdue, totalOwedPaise } from "../book/records.js";
import { rupees } from "../book/money.js";
import { glossary, glossaryPrompt } from "../glossary/terms.js";
import { askEngine } from "../agents/ask.js";
import { readEngineRoom } from "../subscription-brain/engine-room.js";
import { route, type BookAsk, type DeskRoute, type KnownAgent } from "./route.js";
import { chaseMessage, upiLink, whatsappLink } from "../dispatch/upi.js";

export const DESK_TIMEOUT_MS = 90_000;

export interface DeskAnswer {
  /** Which door this went through, so the owner can see and correct it. */
  readonly kind: DeskRoute["kind"] | "refused";
  /** The words that decided the route. Empty when nothing had to be decided. */
  readonly because: string;
  /** What to say back. Always set. */
  readonly said: string;
  /**
   * A thing the screen should now open, rather than a sentence.
   *
   * The bill form and the Bench are surfaces, not paragraphs — routing to them
   * means *show me that*, and returning prose describing them would be a
   * chatbot pretending to be an app.
   */
  readonly open: { readonly what: "bill" | "bench" | "agent"; readonly id?: string } | null;
  /**
   * A message written and ready, with nowhere it can go on its own.
   *
   * The owner presses send, in WhatsApp, on their own phone or Mac. This is the
   * outbound rule (D-035) implemented by the operating system rather than
   * promised by us — there is no code path here that reaches anybody.
   */
  readonly draft: {
    readonly to: string;
    readonly text: string;
    /** Opens WhatsApp with the message already written. Null without a number. */
    readonly whatsapp: string | null;
    /** A UPI link the customer can pay from. Null without the owner's id. */
    readonly pay: string | null;
  } | null;
}

const DAY_MS = 86_400_000;

/** How many customers a spoken answer lists before it stops being an answer. */
const SPOKEN_ROWS = 6;

function daysLate(dueOn: number, at: number): number {
  return Math.max(0, Math.floor((at - dueOn) / DAY_MS));
}

/**
 * The book, in sentences.
 *
 * Written out here rather than handed to a model, because these figures must be
 * exact and a model asked to summarise a ledger will eventually round one.
 */
export function answerFromBook(
  db: DatabaseSync,
  ask: BookAsk,
  at: number = Date.now()
): string {
  if (ask === "counts") {
    const seen = counts(db);
    return `${seen.parties} ${seen.parties === 1 ? "customer" : "customers"} and ${seen.invoices} ${
      seen.invoices === 1 ? "bill" : "bills"
    } in the book.`;
  }

  if (ask === "overdue") {
    const late = overdue(db, at);
    if (late.length === 0) {
      return "Nothing is past its date. Everything outstanding is still within terms.";
    }
    const lines = late
      .slice(0, SPOKEN_ROWS)
      .map(
        (bill) =>
          `${bill.name} — ${rupees(bill.totalPaise)}, ${daysLate(bill.dueOn, at)} days late${
            bill.number === null ? "" : ` (${bill.number})`
          }`
      );
    const rest = late.length - lines.length;
    return [
      `${late.length} ${late.length === 1 ? "bill is" : "bills are"} past the date agreed.`,
      ...lines,
      rest > 0 ? `…and ${rest} more.` : null
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  const owing = outstanding(db).filter((party) => party.owedPaise > 0);
  if (owing.length === 0) {
    return "Nobody owes you anything. The book is clear.";
  }
  const lines = owing
    .slice(0, SPOKEN_ROWS)
    .map(
      (party) =>
        `${party.name} — ${rupees(party.owedPaise)} across ${party.openBills} ${
          party.openBills === 1 ? "bill" : "bills"
        }`
    );
  const rest = owing.length - lines.length;
  return [
    `${rupees(totalOwedPaise(db))} outstanding across ${owing.length} ${
      owing.length === 1 ? "customer" : "customers"
    }.`,
    ...lines,
    rest > 0 ? `…and ${rest} more.` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * What a model is told when nothing cheaper could answer.
 *
 * The book and the glossary go in, because the questions people ask here are
 * about *their* business and a model without those answers about businesses in
 * general. The house rule that a document is data and never an instruction
 * applies for the same reason it applies to an agent.
 */
export function deskPrompt(db: DatabaseSync | null): string {
  const lines = [
    "You are Rellane, on the owner's own Mac. They run a hardware-trading business in India.",
    "Answer in plain sentences. No headings, no bullet lists unless they asked for a list.",
    "Amounts are rupees. Say a figure only if it is in the records below — never estimate one.",
    "If you do not know, say so and say what would tell you. Never invent a customer or a bill."
  ];
  if (db !== null) {
    lines.push("", "Their book, as it stands:", answerFromBook(db, "outstanding"));
    const terms = glossaryPrompt(glossary(db));
    if (terms.length > 0) {
      lines.push("", terms);
    }
  }
  return lines.join("\n");
}

export interface DeskDeps {
  readonly book: DatabaseSync | null;
  readonly agents: readonly KnownAgent[];
  /** How the owner signs a reminder, and where a payment should go. */
  readonly trading?: { readonly name: string; readonly upiId: string };
  readonly ask?: typeof askEngine;
  readonly room?: () => Promise<Awaited<ReturnType<typeof readEngineRoom>>>;
  readonly now?: () => number;
}

/**
 * Answers one thing somebody typed.
 *
 * Never throws. A desk that can throw is a desk that loses what somebody wrote,
 * and the whole point of a single front door is that it always answers — even
 * if the answer is that it could not.
 */
export async function say(text: string, deps: DeskDeps): Promise<DeskAnswer> {
  const said = text.trim();
  if (said.length === 0) {
    return { kind: "refused", because: "", said: "Say what you would like.", open: null, draft: null };
  }

  const parties = deps.book === null ? [] : outstanding(deps.book).map((party) => party.name);
  const decided = route(said, deps.agents, parties);

  // Not `&& deps.book !== null`. That fell through to a *paid engine call* when
  // the book was closed, which is both expensive and wrong — and it made the
  // refusal inside `chase` unreachable.
  if (decided?.kind === "chase") {
    return chase(decided.party, deps, deps.now?.() ?? Date.now());
  }

  if (decided?.kind === "bill") {
    return {
      kind: "bill",
      because: decided.because,
      said: "That looks like a bill. Here is what it says — check every figure against the paper before saving, because nothing is stored until you do.",
      open: { what: "bill" },
      draft: null
    };
  }

  if (decided?.kind === "bench") {
    return {
      kind: "bench",
      because: decided.because,
      said: "Putting it to both. They will argue it out, and where your book can settle a figure, the book settles it.",
      open: { what: "bench" },
      draft: null
    };
  }

  if (decided?.kind === "agent") {
    return {
      kind: "agent",
      because: decided.because,
      said: `Running it. You will see each step as it goes, and you can stop it.`,
      open: { what: "agent", id: decided.agentId },
      draft: null
    };
  }

  if (decided?.kind === "book") {
    if (deps.book === null) {
      return {
        kind: "refused",
        because: decided.because,
        said: "The book is not open yet, so there is nothing to read.",
        open: null,
        draft: null
      };
    }
    return {
      kind: "book",
      because: decided.because,
      // Straight from the records. No engine was asked and nothing was spent.
      said: answerFromBook(deps.book, decided.ask, deps.now?.() ?? Date.now()),
      open: null,
      draft: null
    };
  }

  // Nothing cheaper could answer it, so this is the one that spends a call.
  //
  // Reading the room is inside the try as well. It was outside, so a failure
  // there threw straight out of a function whose whole contract is that it never
  // does — losing what somebody had typed.
  let engine: { engineId: string; modelId: string } | null;
  try {
    engine = cheapest(await (deps.room ?? readEngineRoom)());
  } catch {
    return {
      kind: "refused",
      because: "",
      said: "Rellane could not work out which engine to ask. Open Engines and see what it says there.",
      open: null,
      draft: null
    };
  }
  if (engine === null) {
    return {
      kind: "refused",
      because: "",
      said: "No engine is connected, so there is nobody to ask. Open Engines and sign in to one, or add an API key.",
      open: null,
      draft: null
    };
  }

  try {
    const answer = await (deps.ask ?? askEngine)({
      engineId: engine.engineId,
      modelId: engine.modelId,
      system: deskPrompt(deps.book),
      prompt: said,
      signal: AbortSignal.timeout(DESK_TIMEOUT_MS)
    });
    return { kind: "ask", because: "", said: answer.trim(), open: null, draft: null };
  } catch (error) {
    return {
      kind: "refused",
      because: "",
      said: error instanceof Error ? error.message : "That could not be answered.",
      open: null,
      draft: null
    };
  }
}

/**
 * Writes a reminder to one customer, and goes no further.
 *
 * The message, a link that opens WhatsApp with it already typed, and a UPI link
 * the customer can pay from. All three are *strings*: the owner presses send, in
 * their own WhatsApp, on their own account. There is no code path from here to
 * anybody's phone, which is the outbound rule (D-035) implemented by the
 * operating system rather than promised by us.
 *
 * The payment link is the part that matters. A reminder ends with a gap — the
 * customer opening a bank app, typing an id, typing an amount, getting both
 * right — and every step in that gap is a day. One tap closes it.
 */
function chase(party: string, deps: DeskDeps, at: number): DeskAnswer {
  const db = deps.book;
  if (db === null) {
    return {
      kind: "refused",
      because: "",
      said: "The book is not open, so there is nothing to chase for.",
      open: null,
      draft: null
    };
  }

  const standing = outstanding(db).find((row) => row.name === party);
  if (standing === undefined || standing.owedPaise <= 0) {
    return {
      kind: "chase",
      because: `you asked to chase ${party}`,
      // Refused with the reason, which is the useful answer: the worst thing
      // this product could do is help somebody chase a customer who has paid.
      said: `${party} does not owe you anything. There is nothing to chase.`,
      open: null,
      draft: null
    };
  }

  const late = overdue(db, at).filter((bill) => bill.name === party);
  const oldest = late[0];
  const trading = deps.trading ?? { name: "", upiId: "" };

  const pay = upiLink({
    payeeId: trading.upiId,
    payeeName: trading.name,
    amountPaise: standing.owedPaise,
    note: oldest?.number == null ? "Outstanding" : `Bill ${oldest.number}`
  });

  const text = chaseMessage({
    party,
    amountPaise: standing.owedPaise,
    daysLate: oldest === undefined ? 0 : Math.max(0, Math.floor((at - oldest.dueOn) / DAY_MS)),
    billNumber: oldest?.number ?? null,
    from: trading.name.length === 0 ? "" : trading.name,
    ...(pay.ok ? { payLink: pay.uri } : {})
  });

  const whatsapp = standing.phone === null ? null : whatsappLink(standing.phone, text);

  return {
    kind: "chase",
    because: `you asked to chase ${party}`,
    said: [
      `Here is a reminder for ${party}. Read it before you send it — Rellane cannot send anything itself.`,
      pay.ok
        ? null
        : "There is no payment link, because your own UPI id is not set. Add it in Settings and the reminder will carry one.",
      standing.phone === null
        ? "There is no phone number for them, so you will have to open the chat yourself."
        : null
    ]
      .filter((line): line is string => line !== null)
      .join(" "),
    open: null,
    draft: { to: party, text, whatsapp, pay: pay.ok ? pay.uri : null }
  };
}

/** The cheapest engine that is actually ready. Same rule the bill reader uses. */
function cheapest(
  room: Awaited<ReturnType<typeof readEngineRoom>>
): { engineId: string; modelId: string } | null {
  for (const tier of ["fast", "balanced", "frontier"] as const) {
    for (const engine of room.engines) {
      if (engine.state !== "ready") {
        continue;
      }
      const model = engine.models.find((candidate) => candidate.tier === tier);
      if (model !== undefined) {
        return { engineId: engine.id, modelId: model.id };
      }
    }
  }
  return null;
}
