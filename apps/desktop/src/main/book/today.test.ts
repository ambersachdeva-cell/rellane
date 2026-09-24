/**
 * The front door's query, tested against its specification.
 *
 * These tests were written by the crew's Tester seat against the stated
 * done-when, without having seen the implementation — which is the point of
 * that seat. A test written from the spec cannot be bent into agreeing with the
 * code's mistakes, and it is how the last round of money defects surfaced.
 *
 * They are kept close to what came back, edited only where a fact about this
 * repository was wrong rather than where a judgement differed.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { appendTurn, closeCase, openCase } from "./cases.js";
import {
  addEnquiry,
  addParty,
  addQuotationItem,
  closeQuotation,
  draftQuotation,
  sendQuotation,
  today,
  triageEnquiry
} from "./records.js";
import { MIGRATIONS } from "./schema.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-05T10:00:00.000Z");

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
});

describe("an honest empty morning", () => {
  it("returns an empty list rather than congratulating anybody", () => {
    expect(today(db, NOW)).toEqual([]);

    // An enquiry that arrived this morning is not waiting yet, and a case
    // touched yesterday is not lost. Neither belongs on the screen.
    const party = addParty(db, { name: "Clean Slate" });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW, rawText: "rate?", partyId: party });
    openCase(db, { title: "Active case", question: "In progress?" }, NOW - DAY);

    // A product that cheers when nothing happened is one you stop believing
    // when something has.
    expect(today(db, NOW)).toEqual([]);
  });
});

describe("which enquiries and quotes count", () => {
  // Rewritten 12 September. These asserted that Today surfaces overdue bills.
  // Billing left the product that day — Tally keeps the accounts — and D-111
  // made the front door the loop instead: what has no price, and what has no
  // answer. The boundaries being checked are the same ones; the nouns changed.

  it("ignores an enquiry that is already quoted, and one marked junk", () => {
    const waiting = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 3 * DAY, rawText: "500 cards" });

    // Sent, not merely drafted: a draft is not a price the customer has had.
    const quoted = addEnquiry(db, { channel: "indiamart", receivedAt: NOW - 4 * DAY, rawText: "banners" });
    const sent = draftQuotation(db, quoted);
    addQuotationItem(db, sent, { description: "Banners", quantity: 2, unitPricePaise: 450_000 });
    sendQuotation(db, sent, NOW - 3 * DAY);
    // Closed as well, so this enquiry contributes no line at all and the test
    // measures what it says it measures. A sent-and-open quote is a waiting
    // quotation, which is a different row with its own test below.
    closeQuotation(db, sent, "won", "Confirmed by phone", NOW - 2 * DAY);

    const junk = addEnquiry(db, { channel: "indiamart", receivedAt: NOW - 5 * DAY, rawText: "SEO services?" });
    triageEnquiry(db, junk, "junk");

    const items = today(db, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(waiting);
    expect(items[0]?.kind).toBe("enquiry");
  });

  it("waits on a sent quote, not a draft, and stops the moment it closes", () => {
    const enquiry = addEnquiry(db, { channel: "phone", receivedAt: NOW - 9 * DAY, rawText: "flyers" });
    const quote = draftQuotation(db, enquiry);
    addQuotationItem(db, quote, { description: "Flyers", quantity: 1000, unitPricePaise: 180 });

    // A draft is the shop's own unfinished work, so no quotation line appears —
    // but the enquiry is still unanswered and stays on the screen. Anything else
    // would hide the work while nobody was looking at it.
    const drafting = today(db, NOW);
    expect(drafting).toHaveLength(1);
    expect(drafting[0]?.kind).toBe("enquiry");

    sendQuotation(db, quote, NOW - 8 * DAY);
    const items = today(db, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(quote);
    expect(items[0]?.kind).toBe("quotation");

    closeQuotation(db, quote, "won", "Confirmed on the phone", NOW);
    expect(today(db, NOW)).toHaveLength(0);
  });

  it("derives on read, so closing a quote now clears the item now", () => {
    const enquiry = addEnquiry(db, { channel: "email", receivedAt: NOW - 12 * DAY, rawText: "letterheads" });
    const quote = draftQuotation(db, enquiry);
    addQuotationItem(db, quote, { description: "Letterheads", quantity: 500, unitPricePaise: 400 });
    sendQuotation(db, quote, NOW - 11 * DAY);

    expect(today(db, NOW)).toHaveLength(1);
    closeQuotation(db, quote, "lost", null, NOW);
    expect(today(db, NOW)).toHaveLength(0);
  });
});

describe("which cases count", () => {
  it("reports one untouched past seven days, and leaves the rest alone", () => {
    openCase(db, { title: "Fresh inquiry", question: "Quotes?" }, NOW - 6 * DAY);
    const stale = openCase(db, { title: "Sharma quote", question: "Revised pricing?" }, NOW - 8 * DAY);

    // Old, but spoken in two days ago. That is live work, not a dropped thread.
    const active = openCase(db, { title: "Turbine order", question: "Parts arrived?" }, NOW - 15 * DAY);
    appendTurn(db, active, { seat: "owner", kind: "verbatim", body: "Checked stock today." }, NOW - 2 * DAY);

    const closed = openCase(db, { title: "Old dispute", question: "Resolved?" }, NOW - 20 * DAY);
    closeCase(db, closed, { closedAs: "settled", verdict: "Done" }, NOW - DAY);

    const items = today(db, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(stale);
    expect(items[0]?.kind).toBe("case");
  });
});

describe("the words a person reads", () => {
  it("is singular-aware, and names the party in their own words", () => {
    const party = addParty(db, { name: "ADM" });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - DAY, rawText: "rate?", partyId: party });

    const [one] = today(db, NOW);
    expect(one?.line).toContain("1 day");
    // "1 days" tells the reader nobody looked.
    expect(one?.line).not.toContain("1 days");
    expect(one?.line).toContain("ADM");
    // One day is not late for an enquiry; two is.
    expect(one?.severity).toBe("warning");

    const staleCase = openCase(db, { title: "Vendor inquiry", question: "Reply needed?" }, NOW - 8 * DAY);
    const item = today(db, NOW).find((entry) => entry.id === staleCase);
    expect(item?.line).toContain("Vendor inquiry");
    expect(item?.line).toContain("8 days");
  });

  it("names the channel when the sender is not in the book yet", () => {
    // Most enquiries arrive from somebody who is nobody here yet. "Somebody on
    // IndiaMART" is a real answer; a blank where a name should be is not.
    addEnquiry(db, { channel: "indiamart", receivedAt: NOW - 3 * DAY, rawText: "1000 flyers" });
    expect(today(db, NOW)[0]?.line).toContain("IndiaMART");
  });
});

describe("what fits in a glance", () => {
  it("caps at six, urgent first, longest-waiting first", () => {
    const party = addParty(db, { name: "High Volume" });
    // Five urgent (two days or older) and two that are not.
    const e10 = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 10 * DAY, rawText: "a", partyId: party });
    const e8 = addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 8 * DAY, rawText: "b", partyId: party });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 6 * DAY, rawText: "c", partyId: party });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 4 * DAY, rawText: "d", partyId: party });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 2 * DAY, rawText: "e", partyId: party });
    addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - DAY, rawText: "f", partyId: party });
    addEnquiry(db, { channel: "phone", receivedAt: NOW - DAY, rawText: "g", partyId: party });

    const items = today(db, NOW);
    expect(items).toHaveLength(6);
    expect(items.slice(0, 5).every((item) => item.severity === "urgent")).toBe(true);
    expect(items[5]?.severity).toBe("warning");

    const ids = items.map((item) => item.id);
    expect(ids).toContain(e10);
    expect(ids).toContain(e8);
  });

  it("gives the same order on two consecutive reads", () => {
    // A list that reshuffles itself is one a person stops trusting they have
    // already read.
    const party = addParty(db, { name: "Same Twice" });
    for (let i = 0; i < 4; i += 1) {
      addEnquiry(db, { channel: "whatsapp", receivedAt: NOW - 5 * DAY, rawText: `q${i}`, partyId: party });
    }
    expect(today(db, NOW).map((i) => i.id)).toEqual(today(db, NOW).map((i) => i.id));
  });
});
