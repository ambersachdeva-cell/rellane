/**
 * Getting things into and out of the book.
 *
 * The schema has existed and been tested for a long time, and until now
 * **nothing could put a single invoice into it** — no queries, no writes, no
 * channels. That is why the home screen could only show plumbing: engines
 * connected, folders granted. It had no business to describe, because there was
 * no way for any business to get in.
 *
 * ## Balances are derived, never stored
 *
 * A house rule, and this is where it is kept. A stored balance is a number that
 * can disagree with the bills it came from, and the disagreement is silent and
 * permanent. Every figure here is computed from `invoice` and
 * `payment_allocation` at the moment it is asked for, which is cheap at the size
 * a trade like this ever reaches and correct at any size.
 *
 * ## Money is integer paise
 *
 * No floats anywhere near it. `total_paise`, `amount_paise` and every sum are
 * integers, and SQLite's `SUM` over integers stays exact.
 *
 * ## Unallocated money is a real state
 *
 * A customer who pays a round ₹50,000 against three bills has money on account
 * until somebody says which bill it settles. That is normal in this trade, not
 * an error, so `outstanding` counts *all* payments against a party rather than
 * only the allocated ones — otherwise the screen would chase somebody who has
 * already paid.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Deal,
  DealQuotation,
  EnquiryChannel,
  QuotationState,
  Triage
} from "@cadrane/contracts";

// Re-exported so existing importers inside the main process are undisturbed.
export type { Deal, DealLine, DealQuotation, EnquiryChannel, QuotationState, Triage } from "@cadrane/contracts";

/** What a party owes, worked out rather than remembered. */
export interface Standing {
  readonly partyId: string;
  readonly name: string;
  readonly phone: string | null;
  /** Everything billed, in paise. */
  readonly billedPaise: number;
  /** Everything received, allocated or not. */
  readonly paidPaise: number;
  /** Billed minus paid. Negative means they are in credit. */
  readonly owedPaise: number;
  /** Oldest unpaid bill's date, or null when nothing is outstanding. */
  readonly oldestUnpaidOn: number | null;
  /** How many bills are still open. */
  readonly openBills: number;
  /**
   * What the owner has written about them, in their own words.
   *
   * Round-trips through the Vault (D-061): written into their page, read back
   * when it changes. It is prose and only prose — no figure in this book ever
   * comes from a text file.
   */
  readonly note: string | null;
}

/**
 * The shapes written into the book.
 *
 * Every optional field admits `undefined` explicitly: these are built from
 * parsed JSON crossing the IPC boundary, where "the key is absent" and "the key
 * is undefined" are the same thing, and `exactOptionalPropertyTypes` treats them
 * as different. Widening here is honest about where the values come from.
 */
export interface NewParty {
  readonly name: string;
  readonly kind?: "customer" | "supplier" | "both" | undefined;
  readonly phone?: string | null | undefined;
  readonly gstin?: string | null | undefined;
  readonly stateCode?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface NewInvoice {
  readonly partyId: string;
  readonly number?: string | null | undefined;
  readonly issuedOn: number;
  readonly dueOn?: number | null | undefined;
  readonly subtotalPaise: number;
  readonly taxPaise?: number | undefined;
  readonly totalPaise: number;
  /** Null when a person typed it. A number when it was read off a document. */
  readonly confidence?: number | null | undefined;
  readonly notes?: string | null | undefined;
}

export interface NewPayment {
  readonly partyId: string;
  readonly receivedOn: number;
  readonly amountPaise: number;
  readonly method?: "cash" | "upi" | "bank" | "cheque" | "other" | null | undefined;
  readonly reference?: string | null | undefined;
}

function now(): number {
  return Date.now();
}

/** Adds a party. Returns its id. */
export function addParty(db: DatabaseSync, party: NewParty): string {
  const id = randomUUID();
  const at = now();
  db.prepare(
    `INSERT INTO party (id, name, kind, phone, gstin, state_code, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    party.name.trim(),
    party.kind ?? "customer",
    party.phone ?? null,
    party.gstin ?? null,
    // Derived from the GSTIN when it is there: the first two characters are the
    // state code, and that is what decides CGST+SGST against IGST. Storing it
    // separately means the decision does not re-parse a string every time.
    party.stateCode ?? (party.gstin ? party.gstin.slice(0, 2) : null),
    party.notes ?? null,
    at,
    at
  );
  return id;
}

/**
 * A figure on its way into the book, or a refusal.
 *
 * SQLite will take anything a JavaScript number can hold — a fraction, or an
 * integer far past the point where a `number` still counts exactly. Reading one
 * back is where it goes wrong: `node:sqlite` throws `RangeError: Value is too
 * large to be represented as a JavaScript number`, and it throws it from
 * `outstanding()`, which is the function the home screen calls. So one bad
 * write does not corrupt one row — it makes **the whole book unreadable**, on
 * every launch, until somebody goes into the database by hand.
 *
 * Found by fuzzing the write path, which is the only way it could have been
 * found: every caller in the app today goes through `paiseOf`, which already
 * refuses these. This is the door standing open behind that one.
 *
 * It throws rather than clamping, because a bill quietly stored as a different
 * amount than the one presented is the worst outcome available here, and worse
 * than a visible failure. Refusing is also what the parser does with anything it
 * cannot read exactly.
 */
function exactPaise(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${field} must be a whole number of paise that fits exactly: ${String(value)} does not.`
    );
  }
  // Zero has no sign on a ledger. `Object.is(-0, 0)` is false and
  // `JSON.stringify(-0)` is `"0"`, so a signed zero changes identity across a
  // backup and a restore.
  return value === 0 ? 0 : value;
}

/** Records a bill. Returns its id. */
export function addInvoice(db: DatabaseSync, invoice: NewInvoice): string {
  const id = randomUUID();
  const at = now();
  const subtotalPaise = exactPaise(invoice.subtotalPaise, "subtotalPaise");
  const taxPaise = exactPaise(invoice.taxPaise ?? 0, "taxPaise");
  const totalPaise = exactPaise(invoice.totalPaise, "totalPaise");
  db.prepare(
    `INSERT INTO invoice
       (id, number, party_id, issued_on, due_on, subtotal_paise, tax_paise, total_paise,
        confidence, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    invoice.number ?? null,
    invoice.partyId,
    invoice.issuedOn,
    invoice.dueOn ?? null,
    subtotalPaise,
    taxPaise,
    totalPaise,
    invoice.confidence ?? null,
    // A bill read off a photograph is a draft until somebody confirms it. It
    // must not reach a balance on the strength of an extraction.
    invoice.confidence === null || invoice.confidence === undefined ? "confirmed" : "draft",
    invoice.notes ?? null,
    at,
    at
  );
  return id;
}

/** Records money received. Returns its id. */
export function addPayment(db: DatabaseSync, payment: NewPayment): string {
  const id = randomUUID();
  const at = now();
  const amountPaise = exactPaise(payment.amountPaise, "amountPaise");
  db.prepare(
    `INSERT INTO payment
       (id, party_id, received_on, amount_paise, method, reference, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    payment.partyId,
    payment.receivedOn,
    amountPaise,
    payment.method ?? null,
    payment.reference ?? null,
    at,
    at
  );
  return id;
}

/**
 * Who owes what, most owed first.
 *
 * Only confirmed bills count. A draft read off a photograph and not yet checked
 * is not a debt, and putting it in a total would have the owner chasing money
 * on the strength of an OCR guess.
 */
export function outstanding(db: DatabaseSync, asOf: number = now()): readonly Standing[] {
  const rows = db
    .prepare(
      `SELECT
         p.id                                        AS partyId,
         p.name                                      AS name,
         p.phone                                     AS phone,
         p.notes                                     AS note,
         COALESCE(bills.billed, 0)                   AS billedPaise,
         COALESCE(paid.received, 0)                  AS paidPaise,
         bills.oldest                                AS oldestUnpaidOn,
         COALESCE(bills.n, 0)                        AS openBills
       FROM party p
       LEFT JOIN (
         SELECT party_id,
                SUM(total_paise) AS billed,
                MIN(issued_on)   AS oldest,
                COUNT(*)         AS n
           FROM invoice
          WHERE status = 'confirmed' AND issued_on <= ?
          GROUP BY party_id
       ) bills ON bills.party_id = p.id
       LEFT JOIN (
         SELECT party_id, SUM(amount_paise) AS received
           FROM payment
          WHERE received_on <= ?
          GROUP BY party_id
       ) paid ON paid.party_id = p.id
       WHERE p.archived_at IS NULL
       ORDER BY (COALESCE(bills.billed, 0) - COALESCE(paid.received, 0)) DESC`
    )
    .all(asOf, asOf) as readonly Record<string, unknown>[];

  return rows.map((row) => {
    const billedPaise = Number(row["billedPaise"] ?? 0);
    const paidPaise = Number(row["paidPaise"] ?? 0);
    return {
      partyId: String(row["partyId"]),
      name: String(row["name"]),
      phone: row["phone"] === null ? null : String(row["phone"]),
      billedPaise,
      paidPaise,
      owedPaise: billedPaise - paidPaise,
      // Both are nulled out when nothing is owed, because both claim something
      // about *unpaid* bills and neither query knows which bills those are —
      // payments here need not be allocated to an invoice (D-058). What is
      // knowable exactly is that a settled party has no oldest unpaid bill and
      // no open ones, and saying otherwise contradicts the field's own comment.
      oldestUnpaidOn:
        billedPaise - paidPaise <= 0 || row["oldestUnpaidOn"] === null
          ? null
          : Number(row["oldestUnpaidOn"]),
      openBills: billedPaise - paidPaise <= 0 ? 0 : Number(row["openBills"] ?? 0),
      note: row["note"] === null || row["note"] === undefined ? null : String(row["note"])
    };
  });
}

/** Just the ones who actually owe something, for a screen that shows work. */
export function owing(db: DatabaseSync, asOf: number = now()): readonly Standing[] {
  return outstanding(db, asOf).filter((party) => party.owedPaise > 0);
}

/** Everything owed, across everybody. */
export function totalOwedPaise(db: DatabaseSync, asOf: number = now()): number {
  return owing(db, asOf).reduce((sum, party) => sum + party.owedPaise, 0);
}

/**
 * Bills past their due date and not settled.
 *
 * A bill with no due date is never overdue: inventing a term the paper did not
 * carry would put somebody on a chasing list for a debt they never agreed to
 * pay by then.
 */
export function overdue(db: DatabaseSync, asOf: number = now()): readonly {
  readonly invoiceId: string;
  readonly number: string | null;
  readonly partyId: string;
  readonly name: string;
  readonly totalPaise: number;
  readonly dueOn: number;
  readonly daysLate: number;
}[] {
  const rows = db
    .prepare(
      /**
       * Only for a party who still owes something.
       *
       * This asked nothing about payments at all, so a customer who had settled
       * in full went on appearing as overdue for ever — and the home screen said
       * "2 bills past the date agreed" about money already received. Chasing
       * somebody for a bill they have paid is the single worst thing this
       * product could do to a working relationship.
       *
       * It is a *party*-level test rather than a per-bill one, and deliberately
       * so: a payment in this book is not necessarily allocated to a particular
       * invoice (money on account is a real state), so which bill a payment
       * settled is often genuinely unknown. What can be said exactly is whether
       * the party is square — and if they are, none of their bills is overdue.
       *
       * ## Oldest bill first, which is the fix for the version before this
       *
       * The party-level test above is necessary and was not sufficient. It
       * decided whether the *party* owed anything and then listed **every** bill
       * of theirs that was past its date — so a customer who had settled an old
       * bill in full saw it come back onto the chasing list the moment a second
       * bill went late. Found by fuzzing: bill of ₹100 due in January, paid in
       * full in February, bill of ₹50 due in March. In April the party owes ₹50
       * and the list said ₹150, naming the January bill they had already paid.
       *
       * So money on account is applied to the oldest bill first, and a bill is
       * late only when the payments received by `asOf` do not reach it. That is
       * what `running > paid` says: `running` is everything billed up to and
       * including this bill, so the moment the cumulative total passes what has
       * been paid, this is the bill the money ran out on.
       *
       * Oldest-first is a choice, not a discovery — a payment here is often
       * genuinely unallocated, because money on account is a real state and the
       * book does not pretend to know which bill a transfer was meant for. Of
       * the available guesses it is the conventional one, it is the one a
       * customer would assume, and it is the only one that never re-opens a
       * bill that a later payment already covered.
       *
       * The window runs over every confirmed bill with a date, not only the ones
       * already due, so a payment settles an old bill rather than being held
       * against a bill that is not due yet.
       */
      `SELECT x.invoiceId, x.number, x.partyId, x.name, x.totalPaise, x.dueOn
         FROM (
           SELECT i.id AS invoiceId, i.number AS number, i.party_id AS partyId,
                  p.name AS name, i.total_paise AS totalPaise, i.due_on AS dueOn,
                  SUM(i.total_paise) OVER (
                    PARTITION BY i.party_id
                    ORDER BY i.due_on ASC, i.id ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS running,
                  (
                    SELECT COALESCE(SUM(pay.amount_paise), 0)
                      FROM payment pay
                     WHERE pay.party_id = i.party_id AND pay.received_on <= ?
                  ) AS paid
             FROM invoice i
             JOIN party p ON p.id = i.party_id
            WHERE i.status = 'confirmed'
              AND p.archived_at IS NULL
              AND i.due_on IS NOT NULL
         ) x
        WHERE x.dueOn < ?
          AND x.running > x.paid
        ORDER BY x.dueOn ASC`
    )
    .all(asOf, asOf) as readonly Record<string, unknown>[];

  return rows.map((row) => {
    const dueOn = Number(row["dueOn"]);
    return {
      invoiceId: String(row["invoiceId"]),
      number: row["number"] === null ? null : String(row["number"]),
      partyId: String(row["partyId"]),
      name: String(row["name"]),
      totalPaise: Number(row["totalPaise"]),
      dueOn,
      daysLate: Math.floor((asOf - dueOn) / 86_400_000)
    };
  });
}

/** How many parties and bills the book holds, for an honest empty state. */
export function counts(db: DatabaseSync): { readonly parties: number; readonly invoices: number } {
  const parties = db.prepare("SELECT COUNT(*) AS n FROM party WHERE archived_at IS NULL").get() as {
    n: number;
  };
  const invoices = db.prepare("SELECT COUNT(*) AS n FROM invoice").get() as { n: number };
  return { parties: Number(parties.n), invoices: Number(invoices.n) };
}

/** Every bill for one party, newest first. For the vault's page per customer. */
export function billsFor(
  db: DatabaseSync,
  partyId: string
): readonly { readonly number: string | null; readonly issuedOn: number; readonly totalPaise: number }[] {
  const rows = db
    .prepare(
      `SELECT number, issued_on AS issuedOn, total_paise AS totalPaise
         FROM invoice
        WHERE party_id = ? AND status = 'confirmed'
        ORDER BY issued_on DESC`
    )
    .all(partyId) as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    number: row["number"] === null ? null : String(row["number"]),
    issuedOn: Number(row["issuedOn"]),
    totalPaise: Number(row["totalPaise"])
  }));
}

/**
 * Records what the owner wrote about somebody.
 *
 * The one write in this module that carries no money. It exists so a sentence
 * typed into a markdown file in the Vault — *"agreed 45 days from October"* —
 * survives the next time that file is rewritten, and so it is visible on the
 * screen where the person is actually looked up.
 *
 * Returns whether anything changed, because the vault sync writes only when
 * something did and a no-op sync should say so.
 */
export function setNote(db: DatabaseSync, partyId: string, note: string | null): boolean {
  const trimmed = note === null ? null : note.trim();
  const kept = trimmed === null || trimmed.length === 0 ? null : trimmed;
  const existing = db.prepare(`SELECT notes FROM party WHERE id = ?`).get(partyId) as
    | { notes: string | null }
    | undefined;
  if (existing === undefined || (existing.notes ?? null) === kept) {
    return false;
  }
  db.prepare(`UPDATE party SET notes = ?, updated_at = ? WHERE id = ?`).run(kept, now(), partyId);
  return true;
}

/**
 * What needs you today.
 *
 * ## Why this exists
 *
 * The plan calls this the moment that sells the product: opening the Mac in the
 * morning and being told, in your own words, the four things about to be
 * dropped. *"Sharma was promised a revised quote on Tuesday — that was three
 * days ago. The ADM invoice has been unpaid for 47 days."*
 *
 * None of that lives anywhere until now. It lives in the owner's memory across
 * three chat threads and an inbox, and the only reason it does not get dropped
 * more often is that they keep thinking about it — which is itself the cost.
 * This is the one thing an accounting package structurally cannot do: **a ledger
 * describes the past, and a dropped promise is a fact about the future.**
 *
 * ## It answers, and it never cheers
 *
 * An empty morning returns an empty list. No "you're all caught up!", no tick,
 * no encouragement — a product that congratulates you for nothing happening is
 * a product you stop believing when something has. The screen shows nothing and
 * that is the whole message.
 *
 * ## Six, at most
 *
 * A list of thirty things needing you is a list nobody reads, and reporting
 * everything is the same as reporting nothing. Six is what fits in a glance.
 */

/**
 * `invoice` is retained so old records still render, but `today()` no longer
 * produces one: billing was cut on 12 September and the accounts stay in Tally.
 */
export type TodayKind = "enquiry" | "quotation" | "invoice" | "case";
/** Urgent is what will cost money or trust today; warning is what will soon. */
export type TodaySeverity = "urgent" | "warning";

export interface TodayItem {
  readonly kind: TodayKind;
  /** The record this came from, so the screen can open it. Never a path. */
  readonly id: string;
  /** One sentence, in the owner's nouns. Their customer, their words. */
  readonly line: string;
  readonly severity: TodaySeverity;
  /** How long it has been waiting. What the ordering is done on. */
  readonly days: number;
}

/** The most that fits in a glance. */
export const TODAY_LIMIT = 6;

/** "1 day", "4 days". A string reading "1 days" tells the reader nobody looked. */
function dayWord(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

export function today(db: DatabaseSync, asOf: number = now()): readonly TodayItem[] {
  const items: TodayItem[] = [];

  // Enquiries nobody has priced. First, because this is the only line on the
  // screen where the money has not been earned yet: a bill that is late is money
  // already made, and Tally chases those. An enquiry going cold is a job the shop
  // never gets, and nothing else in the building notices it happening.
  for (const enquiry of openEnquiries(db, asOf)) {
    // An enquiry that arrived this morning is not waiting yet. Putting it here
    // the second it lands would mean the screen is never empty, and a list that
    // is never empty is one nobody can finish — which is the same failure as a
    // bill appearing on the day it falls due.
    if (enquiry.waitingDays < 1) {
      continue;
    }
    const who = enquiry.partyName ?? CHANNEL_NOUN[enquiry.channel];
    items.push({
      kind: "enquiry",
      id: enquiry.enquiryId,
      line: `${who} asked for a price ${dayWord(enquiry.waitingDays)} ago and has not had one.`,
      // Two days, not thirty. A customer who wanted a price on Monday has asked
      // somebody else by Wednesday.
      severity: enquiry.waitingDays >= 2 ? "urgent" : "warning",
      days: enquiry.waitingDays
    });
  }

  // Quotations sent and unanswered. The shop has already done the work of
  // pricing; the only thing left is asking.
  for (const quote of waitingQuotations(db, asOf)) {
    // Same rule as an enquiry: a quote that went out this morning has not been
    // ignored yet, and "0 days with no answer" is not a sentence anybody wrote
    // on purpose.
    if (quote.waitingDays < 1) {
      continue;
    }
    const who = quote.partyName ?? "A customer";
    items.push({
      kind: "quotation",
      id: quote.quotationId,
      line: `${who} has had the quote for ${dayWord(quote.waitingDays)} with no answer.`,
      severity: quote.waitingDays >= 7 ? "urgent" : "warning",
      days: quote.waitingDays
    });
  }

  // Cases nobody has touched. The product exists to stop work being lost, so a
  // case sitting untouched is the failure it is most responsible for. Activity
  // is the newest turn, or the opening if no turns have been appended yet.
  // Untouched cases are surfaced here as reminders, but reading Today never
  // closes or mutates waiting work (D-096).
  const stale = db
    .prepare(
      `SELECT c.id AS id,
              c.title AS title,
              COALESCE((SELECT MAX(t.at) FROM case_turn t WHERE t.case_id = c.id),
                       c.opened_at) AS lastActivityAt
         FROM work_case c
        WHERE c.closed_at IS NULL
          AND COALESCE((SELECT MAX(t.at) FROM case_turn t WHERE t.case_id = c.id),
                       c.opened_at) < ?
        ORDER BY lastActivityAt ASC`
    )
    .all(asOf - STALE_CASE_MS) as readonly Record<string, unknown>[];

  for (const row of stale) {
    const days = Math.floor((asOf - Number(row["lastActivityAt"])) / DAY_MS);
    items.push({
      kind: "case",
      id: String(row["id"]),
      line: `${String(row["title"])} has had no answer for ${dayWord(days)}.`,
      severity: days >= 14 ? "urgent" : "warning",
      days
    });
  }

  // Urgent first, then longest-waiting. The id breaks a tie so the order is the
  // same on two consecutive mornings, which matters more than it sounds: a list
  // that reshuffles itself is one a person stops trusting they have read.
  return items
    .sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "urgent" ? -1 : 1;
      }
      if (a.days !== b.days) {
        return b.days - a.days;
      }
      // Must return 0 for equals: a comparator that answers 1 when asked to
      // compare a thing with itself violates the ordering contract and lets an
      // engine sort the same list two ways.
      if (a.id === b.id) {
        return 0;
      }
      return a.id < b.id ? -1 : 1;
    })
    .slice(0, TODAY_LIMIT);
}

/** Who to name when an enquiry arrived from somebody not yet in the book. */
const CHANNEL_NOUN: Record<EnquiryChannel, string> = {
  indiamart: "Somebody on IndiaMART",
  whatsapp: "Somebody on WhatsApp",
  telegram: "Somebody on Telegram",
  email: "Somebody by email",
  phone: "A caller",
  walk_in: "Somebody who came in"
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A case untouched this long is something the owner needs reminding of. */
const STALE_CASE_MS = 7 * DAY_MS;

/**
 * The loop the product sells (D-111, schema v7).
 *
 * Everything above this line is receivables: who owes money, on what bill, less
 * what they have paid. That was the wedge when the customer was a shop chasing
 * payment. It is not what Rellane sells now — an enquiry arrives, a quotation
 * goes back, and somebody either buys or does not.
 *
 * ## The enquiry is evidence
 *
 * `raw_text` is stored exactly as it arrived and is never rewritten, summarised
 * or "cleaned" on the way in. A model reads it; a model does not get to replace
 * it. Same rule as a photographed bill (D-062): what a model produces is a
 * proposal, and the thing it read from stays available to disagree with.
 *
 * ## A quotation has no total column
 *
 * Derived from its items on read, like every other figure here. A stored total
 * is a number that can disagree with the lines it came from.
 *
 * ## Closing is the point
 *
 * `state` is what makes this a business instrument rather than a drafting toy.
 * A quotation that cannot record won, lost or no reply teaches the shop nothing
 * about what it wins, and the pricing intelligence the product's position
 * depends on can never accumulate.
 */

export interface NewEnquiry {
  readonly channel: EnquiryChannel;
  readonly receivedAt: number;
  /** Exactly what arrived. Stored verbatim. */
  readonly rawText: string;
  readonly partyId?: string | null | undefined;
  /** The channel's own id, so polling the same enquiry twice makes one row. */
  readonly externalRef?: string | null | undefined;
  /** The photograph or PDF it arrived as, when it did. */
  readonly documentId?: string | null | undefined;
}

export interface NewQuotationItem {
  readonly description: string;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly unit?: string | null | undefined;
}

/** An enquiry with nothing priced against it yet. Today's first question. */
export interface OpenEnquiry {
  readonly enquiryId: string;
  readonly channel: EnquiryChannel;
  readonly receivedAt: number;
  readonly rawText: string;
  readonly partyName: string | null;
  readonly triage: Triage;
  /** Whole days since it arrived. */
  readonly waitingDays: number;
}

/** A quotation that went out and has had no answer. Today's second question. */
export interface WaitingQuotation {
  readonly quotationId: string;
  readonly enquiryId: string;
  readonly partyName: string | null;
  readonly sentAt: number;
  readonly totalPaise: number;
  readonly waitingDays: number;
}

/**
 * Records an enquiry. Returns its id.
 *
 * A repeat of the same `externalRef` on the same channel is not an error and
 * does not make a second row — polling is expected to see the same enquiry
 * again, and a duplicate would show the owner the same work twice. The existing
 * id is returned so the caller cannot tell the difference and does not need to.
 */
export function addEnquiry(db: DatabaseSync, enquiry: NewEnquiry): string {
  const at = now();
  // Empty is not a reference.
  //
  // A feed whose id field is sometimes blank would otherwise dedupe every one
  // of its enquiries onto the first: `""` is not null, so the lookup below runs
  // and matches the row already carrying `""`. Two different jobs become one,
  // silently, and the second customer never appears.
  const given = enquiry.externalRef ?? null;
  const externalRef = given === null || given.trim() === "" ? null : given;
  if (externalRef !== null) {
    const seen = db
      .prepare(`SELECT id FROM enquiry WHERE channel = ? AND external_ref = ?`)
      .get(enquiry.channel, externalRef) as Record<string, unknown> | undefined;
    if (seen) {
      return String(seen["id"]);
    }
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO enquiry
       (id, party_id, channel, external_ref, received_at, raw_text, document_id,
        triage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unsorted', ?, ?)`
  ).run(
    id,
    enquiry.partyId ?? null,
    enquiry.channel,
    externalRef,
    enquiry.receivedAt,
    enquiry.rawText,
    enquiry.documentId ?? null,
    at,
    at
  );
  return id;
}

/**
 * Records whether this was work at all. Returns false if it is not there.
 *
 * The owner's judgement, not a model's. It was written expecting the reading
 * step to set it, and the reading step never did: what reaches here is a person
 * pressing "Not a real enquiry", or pressing "Put it back".
 *
 * Nothing is deleted. The customer's words stay exactly where they were, so a
 * mistake is one button to undo and a shop that later wonders what it turned
 * down has an answer.
 */
export function triageEnquiry(db: DatabaseSync, enquiryId: string, triage: Triage): boolean {
  const result = db
    .prepare(`UPDATE enquiry SET triage = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(triage, now(), enquiryId);
  return Number(result.changes) > 0;
}

/**
 * Enquiries with nothing priced against them.
 *
 * Junk is excluded because the owner already said so, through the model's
 * reading they accepted. `unsorted` is included: nothing has looked at it yet,
 * which is not the same as having looked and found nothing.
 */
export function openEnquiries(db: DatabaseSync, asOf: number = now()): readonly OpenEnquiry[] {
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.channel AS channel, e.received_at AS receivedAt,
              e.raw_text AS rawText, e.triage AS triage, p.name AS partyName
         FROM enquiry e
         LEFT JOIN party p ON p.id = e.party_id
        WHERE e.archived_at IS NULL
          AND e.triage != 'junk'
          -- A draft is not a price. The line this produces says the customer
          -- "has not had one", which stays true until something is sent or
          -- closed across the counter. Counting a draft as handled let an
          -- abandoned one vanish from this list and from waitingQuotations at
          -- the same time, which is the work disappearing.
          --
          -- The *latest* quotation, not "any". Asked as "has this enquiry ever
          -- carried a non-draft quotation", a customer who came back was lost:
          -- the job quoted and lost last month hid the enquiry for ever, and a
          -- fresh draft against it is not sent either, so it appeared on
          -- neither list. What is being asked is whether the newest answer to
          -- this enquiry has reached the customer.
          AND COALESCE((
                SELECT q.state FROM quotation q
                 WHERE q.enquiry_id = e.id
                   AND q.archived_at IS NULL
                 ORDER BY q.drafted_at DESC, q.rowid DESC
                 LIMIT 1), 'draft') = 'draft' 
        ORDER BY e.received_at ASC`
    )
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => ({
    enquiryId: String(row["id"]),
    channel: String(row["channel"]) as EnquiryChannel,
    receivedAt: Number(row["receivedAt"]),
    rawText: String(row["rawText"]),
    partyName: row["partyName"] === null ? null : String(row["partyName"]),
    triage: String(row["triage"]) as Triage,
    waitingDays: Math.floor((asOf - Number(row["receivedAt"])) / DAY_MS)
  }));
}

/**
 * Every deal, most recent first — the list behind the rail's second word.
 *
 * `openEnquiries` answers "what has no price" and `waitingQuotations` answers
 * "what has no reply". Both are questions about today. This is the other kind:
 * what has this shop quoted, and how did it go. It is the only place a closed
 * deal can be seen again, which is what makes "say what happened" worth the
 * owner's ten seconds — a record nobody can look at is a chore, not a record.
 *
 * One query with one aggregate, not a read per row. A shop quoting eight jobs a
 * day has hundreds of these inside a year, and a screen that issues a round trip
 * per line gets slower the longer somebody uses the product.
 *
 * Junk is here. It is off Today because it needs nothing done; somebody who
 * wants to check what they dismissed has nowhere else to look, and hiding it in
 * both places would make "nothing is deleted" a technicality.
 */
export interface DealSummary {
  readonly enquiryId: string;
  readonly channel: EnquiryChannel;
  readonly receivedAt: number;
  readonly partyName: string | null;
  readonly triage: Triage;
  /** Enough of what the customer wrote to recognise which job it was. */
  readonly excerpt: string;
  /** Null when nothing has been priced against it yet. */
  readonly state: QuotationState | null;
  readonly totalPaise: number | null;
  readonly closedAt: number | null;
  readonly closedReason: string | null;
}

/**
 * How many rows this screen will draw before it starts leaving some out.
 *
 * A shop quoting eight jobs a day passes two hundred inside a month, which is
 * the exact length of the trial this product is being judged over — so the old
 * ceiling would have started hiding records in the last week and said nothing.
 * Five hundred is roughly a quarter's work for that shop, and five hundred rows
 * of text is nothing to draw.
 *
 * It is still a ceiling, and a list that quietly stops is a list that lies, so
 * `deals` reports whether it hit one and the screen says so.
 */
export const DEALS_SHOWN = 500;

export interface DealsPage {
  readonly deals: readonly DealSummary[];
  /** True when older enquiries exist and are not in the list above. */
  readonly more: boolean;
}

export function deals(db: DatabaseSync, limit = DEALS_SHOWN): DealsPage {
  const rows = db
    .prepare(
      `SELECT e.id AS enquiryId, e.channel AS channel, e.received_at AS receivedAt,
              e.raw_text AS rawText, e.triage AS triage, p.name AS partyName,
              q.state AS state, q.gst_rate_bp AS gstRateBp,
              q.closed_at AS closedAt, q.closed_reason AS closedReason,
              (SELECT COALESCE(SUM(i.quantity * i.unit_price_paise), 0)
                 FROM quotation_item i WHERE i.quotation_id = q.id) AS netPaise,
              (SELECT COUNT(*)
                 FROM quotation_item i WHERE i.quotation_id = q.id) AS lines
         FROM enquiry e
         LEFT JOIN party p ON p.id = e.party_id
         -- The latest quotation, and only one. A deal quoted twice would
         -- otherwise appear twice in a list whose whole job is to be countable.
         LEFT JOIN quotation q
                ON q.id = (SELECT q2.id FROM quotation q2
                            WHERE q2.enquiry_id = e.id AND q2.archived_at IS NULL
                            ORDER BY q2.drafted_at DESC, q2.rowid DESC
                            LIMIT 1)
        WHERE e.archived_at IS NULL
        ORDER BY e.received_at DESC, e.rowid DESC
        -- One more than asked for, which is how the screen knows there is an
        -- older one it is not showing without counting the whole table.
        LIMIT ?`
    )
    .all(limit + 1) as readonly Record<string, unknown>[];

  const shown = rows.slice(0, limit);
  const summaries = shown.map((row) => {
    const state = row["state"] === null ? null : (String(row["state"]) as QuotationState);
    const net = Number(row["netPaise"] ?? 0);
    const rateBp = row["gstRateBp"] === null ? 0 : Number(row["gstRateBp"]);
    return {
      enquiryId: String(row["enquiryId"]),
      channel: String(row["channel"]) as EnquiryChannel,
      receivedAt: Number(row["receivedAt"]),
      partyName: row["partyName"] === null ? null : String(row["partyName"]),
      triage: String(row["triage"]) as Triage,
      excerpt: recogniseBy(String(row["rawText"])),
      state,
      // Null rather than zero when nothing is priced.
      //
      // The comment was right and the condition was not: it asked whether a
      // quotation existed, so a draft opened and not yet priced showed "₹0.00"
      // in the shop's own list of what it had quoted. That is the thing this
      // line exists to prevent — a price the shop never offered — and the
      // walk-in customer whose job was drafted and left is the commonest way
      // to produce it. A quotation with no lines has no total.
      totalPaise:
        state === null || Number(row["lines"]) === 0
          ? null
          : net + Math.round((net * rateBp) / 10_000),
      closedAt: row["closedAt"] === null ? null : Number(row["closedAt"]),
      closedReason: row["closedReason"] === null ? null : String(row["closedReason"])
    };
  });

  return { deals: summaries, more: rows.length > limit };
}

/**
 * Enough of the message to recognise which job it was.
 *
 * Whitespace-collapsed rather than cut at the first newline: a WhatsApp message
 * usually opens with a greeting on its own line, and "hi bhai" describes
 * nothing. Cut on a word boundary so the tail does not end mid-syllable.
 */
export function recogniseBy(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= 90) {
    return flat;
  }
  const cut = flat.slice(0, 90);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

/**
 * Opens a draft quotation against an enquiry. Returns its id.
 *
 * Quoting a junk enquiry puts it back. Somebody who prices work has said it is
 * work, and the alternative is a deal that is marked "not a real enquiry" and
 * simultaneously sitting on Today waiting for the customer's answer — because
 * `waitingQuotations` asks about the quotation and not about the triage. One
 * state, set where the contradiction would otherwise be created.
 */
export function draftQuotation(
  db: DatabaseSync,
  enquiryId: string,
  options: { readonly partyId?: string | null | undefined; readonly gstRateBp?: number | undefined } = {}
): string {
  const enquiry = db
    .prepare(`SELECT party_id AS partyId FROM enquiry WHERE id = ?`)
    .get(enquiryId) as Record<string, unknown> | undefined;
  if (!enquiry) {
    throw new Error(`No enquiry ${enquiryId} to quote against.`);
  }
  const id = randomUUID();
  const at = now();
  // `??` would be wrong here: `null ?? fallback` is the fallback, so a caller
  // passing an explicit null to leave the quotation unassigned would silently
  // get the enquiry's party instead. Absent and null are different answers.
  const partyId =
    options.partyId !== undefined
      ? options.partyId
      : enquiry["partyId"] === null
        ? null
        : String(enquiry["partyId"]);
  db.prepare(
    `INSERT INTO quotation
       (id, enquiry_id, party_id, state, gst_rate_bp, drafted_at, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`
  ).run(
    id,
    enquiryId,
    partyId,
    options.gstRateBp ?? null,
    at,
    at,
    at
  );
  // See the note above. A quotation against an enquiry nobody considers real is
  // a state the screens cannot show honestly, so it is not one the book holds.
  db.prepare(
    `UPDATE enquiry SET triage = 'real', updated_at = ? WHERE id = ? AND triage = 'junk'`
  ).run(at, enquiryId);
  // The enquiry learns the party too, when the caller named one.
  //
  // Two columns hold a party — `enquiry.party_id` and `quotation.party_id` —
  // and the screens read different ones: `openEnquiries` and `deals` ask from
  // the enquiry's side, `waitingQuotations` from the quotation's. A caller that
  // named a party here and nowhere else produced a deal with a customer on one
  // screen and nobody on the others. Keeping them equal where they are set is
  // cheaper than teaching four queries to check both.
  if (partyId !== null) {
    db.prepare(
      `UPDATE enquiry SET party_id = ?, updated_at = ? WHERE id = ? AND party_id IS NULL`
    ).run(partyId, at, enquiryId);
  }
  return id;
}

/** Adds a line. Position is appended, so callers never renumber. Returns its id. */
export function addQuotationItem(
  db: DatabaseSync,
  quotationId: string,
  item: NewQuotationItem
): string {
  const state = quotationStateOf(db, quotationId);
  // A sent quotation is a thing a customer is holding. Editing its lines would
  // silently change what we are on record as having offered.
  if (state !== "draft") {
    throw new Error(`Quotation ${quotationId} is ${state}; only a draft can take new lines.`);
  }
  const next = db
    .prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS position FROM quotation_item WHERE quotation_id = ?`)
    .get(quotationId) as Record<string, unknown>;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO quotation_item
       (id, quotation_id, position, description, quantity, unit, unit_price_paise)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    quotationId,
    Number(next["position"]),
    item.description.trim(),
    // Not paise, so it does not go through `exactPaise` — a message telling the
    // owner their quantity is not a whole number of paise would be nonsense.
    exactCount(item.quantity, "quantity"),
    item.unit ?? null,
    exactPaise(item.unitPricePaise, "unitPricePaise")
  );
  db.prepare(`UPDATE quotation SET updated_at = ? WHERE id = ?`).run(now(), quotationId);
  return id;
}

/**
 * What this shop has charged for work like this before.
 *
 * The single thing a print shop owner spends time on that this product had no
 * answer for. Eight jobs a day, and most of them are jobs the shop has done:
 * the slow part is not typing a rate, it is *remembering* it — or finding the
 * old estimate book, or ringing back and guessing.
 *
 * ## It recalls, it does not propose
 *
 * Every figure here was typed by the owner on a quotation they sent. Nothing is
 * derived, averaged, marked up or suggested, and nothing fills the rate box on
 * its own: what comes back is what was charged, with the quantity and the date
 * and the customer beside it, because the same job at a different quantity is a
 * different price and only the owner knows which one applies.
 *
 * That is why the product's rule survives this. "Rellane never invents a price"
 * is about invention, and a shop's own record of what it charged is the
 * opposite of invented.
 *
 * ## Sent only
 *
 * A draft is a price nobody stood behind. Recalling one would quietly turn an
 * abandoned guess into the shop's going rate.
 */
export interface PastLine {
  readonly description: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly unitPricePaise: number;
  readonly at: number;
  readonly partyName: string | null;
}

export function pastLines(db: DatabaseSync, like: string, limit = 4): readonly PastLine[] {
  const needle = like.trim();
  // Two characters is not a description, and matching on one would return the
  // whole book in date order — which is not recall, it is noise.
  if (needle.length < 3) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT i.description AS description, i.quantity AS quantity, i.unit AS unit,
              i.unit_price_paise AS unitPricePaise,
              COALESCE(q.sent_at, q.drafted_at) AS at, p.name AS partyName
         FROM quotation_item i
         JOIN quotation q ON q.id = i.quotation_id
         LEFT JOIN party p ON p.id = q.party_id
        WHERE q.state != 'draft'
          AND q.archived_at IS NULL
          -- ESCAPE, because a description is a customer's words and they
          -- contain % and _ often enough: "100% cotton", "A4_final". Without it
          -- one of those turns the owner's search into a wildcard that matches
          -- most of the book.
          AND LOWER(i.description) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
        ORDER BY at DESC, i.rowid DESC
        LIMIT ?`
    )
    .all(needle.replace(/[\\%_]/gu, "\\$&"), limit) as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    description: String(row["description"]),
    quantity: Number(row["quantity"]),
    unit: row["unit"] === null ? null : String(row["unit"]),
    unitPricePaise: Number(row["unitPricePaise"]),
    at: Number(row["at"]),
    partyName: row["partyName"] === null ? null : String(row["partyName"])
  }));
}

/**
 * Takes a line off a draft.
 *
 * The reason this exists: pricing is the step of the loop most likely to be got
 * wrong, and until now it could only be got wrong once. A rate typed as ₹450
 * instead of ₹45 was on the quotation for good — there was no verb in this file
 * that removed a line, so the shop's only way out was to abandon the enquiry.
 * A product that asks somebody to type a price and cannot let them retype it is
 * not finished.
 *
 * Remove and add again, rather than an edit. Two verbs would need two sets of
 * rules about what may change and when; this one composes, and it keeps the
 * only interesting rule in one place.
 *
 * Draft only, for the reason `addQuotationItem` already gives: a sent quotation
 * is a thing a customer is holding, and quietly changing what we are on record
 * as having offered is worse than any mistake it would fix.
 *
 * Positions are left with a gap. `addQuotationItem` appends past the maximum,
 * so nothing renumbers and no line silently changes place under the owner.
 */
export function removeQuotationItem(db: DatabaseSync, quotationId: string, itemId: string): boolean {
  const state = quotationStateOf(db, quotationId);
  if (state !== "draft") {
    throw new Error(`Quotation ${quotationId} is ${state}; only a draft can lose lines.`);
  }
  const result = db
    .prepare(`DELETE FROM quotation_item WHERE id = ? AND quotation_id = ?`)
    .run(itemId, quotationId);
  // Both, so a line cannot be removed from one quotation by naming another.
  const removed = Number(result.changes) > 0;
  if (removed) {
    db.prepare(`UPDATE quotation SET updated_at = ? WHERE id = ?`).run(now(), quotationId);
  }
  return removed;
}

/**
 * A countable thing on its way into the book, or a refusal.
 *
 * Same reasoning as `exactPaise` and the same failure if it is skipped: SQLite
 * accepts a fraction happily and `node:sqlite` throws on the way back out, from
 * whichever read the screen happens to call. The schema's `quantity > 0` check
 * catches zero and negatives; this catches the ones SQL cannot see.
 */
function exactCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a whole number above zero: ${String(value)} is not.`);
  }
  return value;
}

function quotationStateOf(db: DatabaseSync, quotationId: string): QuotationState {
  const row = db
    .prepare(`SELECT state FROM quotation WHERE id = ?`)
    .get(quotationId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`No quotation ${quotationId}.`);
  }
  return String(row["state"]) as QuotationState;
}

/**
 * What a quotation comes to, worked out from its lines.
 *
 * GST is applied at the rate recorded on the quotation, in basis points, so 18%
 * is 1800 and never a float. The rounding is explicit and happens once, on the
 * whole tax, rather than per line where it would drift.
 */
export function quotationTotalPaise(db: DatabaseSync, quotationId: string): number {
  // An aggregate with no GROUP BY always returns one row, so a quotation id
  // that does not exist would come back as a confident zero. A total of nothing
  // and a total of a thing that is not there are different answers, and only one
  // of them is safe to print beside a customer's name (DESIGN.md principle 5).
  quotationStateOf(db, quotationId);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity * unit_price_paise), 0) AS netPaise,
              (SELECT gst_rate_bp FROM quotation WHERE id = ?) AS gstRateBp
         FROM quotation_item WHERE quotation_id = ?`
    )
    .get(quotationId, quotationId) as Record<string, unknown>;
  const net = Number(row["netPaise"]);
  const rateBp = row["gstRateBp"] === null ? 0 : Number(row["gstRateBp"]);
  return net + Math.round((net * rateBp) / 10_000);
}

/**
 * Marks a draft as sent. Returns false if it was not a draft.
 *
 * An empty quotation is refused rather than sent. Sending one is a trap with no
 * way out: a sent quotation will not take new lines, so the shop would be on
 * record as having offered a customer nothing, for nothing, permanently.
 */
export function sendQuotation(db: DatabaseSync, quotationId: string, at: number = now()): boolean {
  // Existence and state first. Counting the lines of a quotation that is not
  // there returns zero, and of one that has already been closed tells the
  // caller "it has no lines" — a different problem with a different fix, and a
  // contradiction of this function's own answer of `false` for a quotation it
  // could not send. An unpriced draft closed as lost is exactly that case.
  const found = db
    .prepare(`SELECT state FROM quotation WHERE id = ?`)
    .get(quotationId) as Record<string, unknown> | undefined;
  if (found === undefined || String(found["state"]) !== "draft") {
    return false;
  }
  const lines = db
    .prepare(`SELECT COUNT(*) AS lines FROM quotation_item WHERE quotation_id = ?`)
    .get(quotationId) as Record<string, unknown>;
  if (Number(lines["lines"]) === 0) {
    throw new Error(`Quotation ${quotationId} has no lines; there is nothing to send.`);
  }
  const result = db
    .prepare(
      `UPDATE quotation SET state = 'sent', sent_at = ?, updated_at = ?
        WHERE id = ? AND state = 'draft'`
    )
    .run(at, now(), quotationId);
  return Number(result.changes) > 0;
}

/**
 * Closes a quotation. The sixth step of D-111, and the reason any of this exists.
 *
 * `reason` is the owner's words for why it went that way — the most valuable
 * sentence in the book and the one a model must never write. It is optional
 * because a close that is recorded without a reason is still worth more than one
 * that was never recorded at all.
 *
 * A draft closes too, and it must. A walk-in customer who agrees a price across
 * the counter was won without anything ever being sent, and an enquiry the shop
 * decides not to chase is abandoned at draft. Refusing those left the quotation
 * in a state with no exit: `openEnquiries` hides the enquiry because something
 * is quoted against it, and `waitingQuotations` never shows it because it was
 * never sent. The work disappears, which is the one failure this product exists
 * to prevent.
 */
export function closeQuotation(
  db: DatabaseSync,
  quotationId: string,
  state: "won" | "lost" | "no_reply",
  reason: string | null = null,
  at: number = now()
): boolean {
  const result = db
    .prepare(
      `UPDATE quotation SET state = ?, closed_at = ?, closed_reason = ?, updated_at = ?
        WHERE id = ? AND state IN ('draft', 'sent')`
    )
    .run(state, at, reason, now(), quotationId);
  return Number(result.changes) > 0;
}

/** Quotations sent and still unanswered, longest wait first. */
export function waitingQuotations(
  db: DatabaseSync,
  asOf: number = now()
): readonly WaitingQuotation[] {
  // Totals are aggregated in the same query rather than by calling
  // `quotationTotalPaise` per row: that was a separate round trip for every
  // quotation on the screen, and the screen is the hot path.
  const rows = db
    .prepare(
      `SELECT q.id AS id, q.enquiry_id AS enquiryId, q.sent_at AS sentAt,
              q.gst_rate_bp AS gstRateBp, p.name AS partyName,
              COALESCE(SUM(i.quantity * i.unit_price_paise), 0) AS netPaise
         FROM quotation q
         LEFT JOIN party p ON p.id = q.party_id
         LEFT JOIN quotation_item i ON i.quotation_id = q.id
        WHERE q.state = 'sent' AND q.archived_at IS NULL
        GROUP BY q.id
        ORDER BY q.sent_at ASC`
    )
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => {
    const net = Number(row["netPaise"]);
    const rateBp = row["gstRateBp"] === null ? 0 : Number(row["gstRateBp"]);
    return {
      quotationId: String(row["id"]),
      enquiryId: String(row["enquiryId"]),
      partyName: row["partyName"] === null ? null : String(row["partyName"]),
      sentAt: Number(row["sentAt"]),
      totalPaise: net + Math.round((net * rateBp) / 10_000),
      waitingDays: Math.floor((asOf - Number(row["sentAt"])) / DAY_MS)
    };
  });
}

/**
 * One deal, whole, for the room that shows it.
 *
 * The Deal room needs the enquiry, the quotation and its lines together, and it
 * needs them in one read: three round trips would let the panes disagree with
 * each other, which on a screen showing a customer's own words beside a price is
 * the kind of disagreement nobody notices until it has been sent.
 *
 * Ordered by `position` rather than by insertion, because the order the owner
 * put the lines in is the order the customer will read them in.
 */
/** Reads one deal, or null when the enquiry is not there. */
export function readDeal(db: DatabaseSync, enquiryId: string): Deal | null {
  const head = db
    .prepare(
      `SELECT e.id AS id, e.channel AS channel, e.received_at AS receivedAt,
              e.raw_text AS rawText, e.triage AS triage,
              e.party_id AS partyId, p.name AS partyName, p.phone AS partyPhone
         FROM enquiry e
         LEFT JOIN party p ON p.id = e.party_id
        WHERE e.id = ?`
    )
    .get(enquiryId) as Record<string, unknown> | undefined;
  if (!head) {
    return null;
  }

  // The newest unarchived quotation. There is normally one; a re-quote after a
  // loss is the case where there is more than one, and the latest is the one the
  // customer is holding.
  const quote = db
    .prepare(
      `SELECT id, state, gst_rate_bp AS gstRateBp, drafted_at AS draftedAt,
              sent_at AS sentAt, closed_at AS closedAt, closed_reason AS closedReason
         FROM quotation
        WHERE enquiry_id = ? AND archived_at IS NULL
        -- rowid breaks the tie. Two quotations drafted inside the same
        -- millisecond — a re-quote written straight after a loss, or any test
        -- that does not sleep — have equal drafted_at, and SQLite is then free
        -- to return either. That is the room showing a customer the superseded
        -- price, and it surfaced as one flaky run in three.
        ORDER BY drafted_at DESC, rowid DESC
        LIMIT 1`
    )
    .get(enquiryId) as Record<string, unknown> | undefined;

  let quotation: DealQuotation | null = null;
  if (quote) {
    const rows = db
      .prepare(
        `SELECT id, position, description, quantity, unit, unit_price_paise AS unitPricePaise
           FROM quotation_item
          WHERE quotation_id = ?
          ORDER BY position ASC`
      )
      .all(String(quote["id"])) as readonly Record<string, unknown>[];

    const lines = rows.map((row) => {
      const quantity = Number(row["quantity"]);
      const unitPricePaise = Number(row["unitPricePaise"]);
      return {
        id: String(row["id"]),
        position: Number(row["position"]),
        description: String(row["description"]),
        quantity,
        unit: row["unit"] === null ? null : String(row["unit"]),
        unitPricePaise,
        linePaise: quantity * unitPricePaise
      };
    });

    const netPaise = lines.reduce((sum, line) => sum + line.linePaise, 0);
    const rateBp = quote["gstRateBp"] === null ? 0 : Number(quote["gstRateBp"]);
    quotation = {
      quotationId: String(quote["id"]),
      state: String(quote["state"]) as QuotationState,
      gstRateBp: quote["gstRateBp"] === null ? null : Number(quote["gstRateBp"]),
      draftedAt: Number(quote["draftedAt"]),
      sentAt: quote["sentAt"] === null ? null : Number(quote["sentAt"]),
      closedAt: quote["closedAt"] === null ? null : Number(quote["closedAt"]),
      closedReason: quote["closedReason"] === null ? null : String(quote["closedReason"]),
      lines,
      netPaise,
      totalPaise: netPaise + Math.round((netPaise * rateBp) / 10_000)
    };
  }

  return {
    enquiryId: String(head["id"]),
    channel: String(head["channel"]) as EnquiryChannel,
    receivedAt: Number(head["receivedAt"]),
    rawText: String(head["rawText"]),
    partyId: head["partyId"] === null ? null : String(head["partyId"]),
    partyName: head["partyName"] === null ? null : String(head["partyName"]),
    partyPhone: head["partyPhone"] === null ? null : String(head["partyPhone"]),
    triage: String(head["triage"]) as Triage,
    quotation
  };
}

/**
 * The deal a quotation belongs to.
 *
 * `sendQuotation` and `closeQuotation` are addressed by quotation, but the room
 * that called them is showing a deal, and it needs the whole thing back rather
 * than a boolean — otherwise the customer's words and the price beside them come
 * from two different reads and can disagree.
 */
export function readDealForQuotation(db: DatabaseSync, quotationId: string): Deal | null {
  const row = db
    .prepare(`SELECT enquiry_id AS enquiryId FROM quotation WHERE id = ?`)
    .get(quotationId) as Record<string, unknown> | undefined;
  return row ? readDeal(db, String(row["enquiryId"])) : null;
}

/**
 * The party with this name, or a new one.
 *
 * Enquiry intake needs a party without making the owner manage a customer list
 * first: they type "Sharma Printers" because that is who wrote to them, and the
 * book should not answer with a duplicate on the second enquiry. Matching is on
 * the trimmed name, case-insensitively, because "sharma printers" and "Sharma
 * Printers" are one customer and nobody typing quickly thinks otherwise.
 *
 * Archived parties are matched too. Somebody archived is still the same person
 * when they write again, and a second row would split their history in half.
 */
export function findOrAddParty(db: DatabaseSync, name: string, phone: string | null = null): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("A party needs a name.");
  }
  const wanted = phone === null || phone.trim() === "" ? null : phone.trim();
  const found = db
    .prepare(`SELECT id, phone FROM party WHERE LOWER(name) = LOWER(?) ORDER BY created_at ASC LIMIT 1`)
    .get(trimmed) as Record<string, unknown> | undefined;
  if (!found) {
    return addParty(db, { name: trimmed, phone: wanted });
  }

  const id = String(found["id"]);
  // Filled in, never overwritten. A customer whose number is already on file
  // and who this time wrote in from a different phone would otherwise have the
  // number the shop has always used replaced by a one-off — silently, on a
  // screen that was about an enquiry and said nothing about contacts.
  if (wanted !== null && found["phone"] === null) {
    db.prepare(`UPDATE party SET phone = ?, updated_at = ? WHERE id = ?`).run(wanted, now(), id);
  }
  return id;
}


/**
 * Says who an enquiry is from, after the fact.
 *
 * Almost every enquiry arrives before anybody has asked for a number — that is
 * why intake makes both fields optional, and it left a hole big enough to make
 * the whole handoff useless: the number is learned on the phone call *after*
 * the message arrives, and there was no way to write it down. The one feature
 * that carries a quotation back to the customer could only be used on the
 * enquiries least likely to need it.
 *
 * Unlike `findOrAddParty`, this overwrites. That function fills a blank and
 * never replaces, because it runs during intake where nobody asked to be
 * editing contacts. Here the owner is looking at a field and typing into it,
 * which is the whole difference: an explicit edit is not a silent one.
 *
 * The party is matched by name, so naming an existing customer attaches the
 * enquiry to the record the shop already has rather than making a second one.
 */
export function setDealCustomer(
  db: DatabaseSync,
  enquiryId: string,
  who: { readonly name: string; readonly phone: string | null }
): boolean {
  const name = who.name.trim();
  if (name === "") {
    throw new Error("A customer needs a name.");
  }
  const present = db
    .prepare(`SELECT EXISTS (SELECT 1 FROM enquiry WHERE id = ? AND archived_at IS NULL) AS present`)
    .get(enquiryId) as Record<string, unknown>;
  if (Number(present["present"]) === 0) {
    return false;
  }

  const at = now();
  const partyId = findOrAddParty(db, name, who.phone);
  const phone = who.phone === null || who.phone.trim() === "" ? null : who.phone.trim();
  // Written even when `findOrAddParty` declined to, and cleared when the owner
  // empties the field: they are looking at it, so an empty box means "I do not
  // have this" rather than "leave whatever is there".
  db.prepare(`UPDATE party SET phone = ?, updated_at = ? WHERE id = ?`).run(phone, at, partyId);
  db.prepare(`UPDATE enquiry SET party_id = ?, updated_at = ? WHERE id = ?`).run(partyId, at, enquiryId);
  // And the quotation, which carries its own copy.
  //
  // `waitingQuotations` joins the party through `quotation.party_id` — it is
  // answering a question about quotations, so it starts from them — and this
  // screen is where a customer usually gets named, *after* the quotation was
  // drafted. Without this line, Today went on saying "Somebody has had the
  // quote for 9 days" about a customer the owner had just named.
  db.prepare(
    `UPDATE quotation SET party_id = ?, updated_at = ?
      WHERE enquiry_id = ? AND archived_at IS NULL`
  ).run(partyId, at, enquiryId);
  return true;
}

/**
 * Whether anybody has ever put anything in this book.
 *
 * The question the first-run greeting actually needs, and not the same question
 * as the one above. A shop that used Rellane before the loop existed has
 * parties, bills and cases and no enquiries at all — so asking only about
 * enquiries offers the tour to somebody who has been here for weeks, the moment
 * their last open case closes. That is the app appearing to have forgotten them,
 * which is the exact failure `hasEverRecordedAnEnquiry` was written to avoid.
 *
 * Every table a person's own work lands in, and nothing the app writes by
 * itself: a settings row or a diagnostics line is not somebody having used this.
 * `party` is included even though intake creates parties, because a book with a
 * customer in it and no enquiry is still a book somebody has worked in.
 *
 * Deliberately about the book and not about today. `counts()` reports invoices,
 * which was the right question while Rellane was receivables and has been the
 * wrong one since billing was cut on 12 September; and "is Today empty" is an
 * ordinary Thursday for a shop that has closed everything.
 */
export function bookIsUntouched(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM enquiry)
            + EXISTS (SELECT 1 FROM quotation)
            + EXISTS (SELECT 1 FROM party)
            + EXISTS (SELECT 1 FROM invoice)
            + EXISTS (SELECT 1 FROM work_case) AS present`
    )
    .get() as Record<string, unknown>;
  return Number(row["present"]) === 0;
}
