/**
 * Working out what somebody meant.
 *
 * The failure to guard against is not "it routed wrong" — it will sometimes,
 * and it says which door it took so that is correctable. The failure is
 * **confident routing of something ambiguous**, because after two of those a
 * person stops typing sentences and goes back to hunting for screens.
 */

import { describe, expect, it } from "vitest";
import { looksLikeABill, route } from "./route.js";

const agents = [
  { id: "filing-clerk", name: "Filing clerk" },
  { id: "chase-payments", name: "Chase payments" }
];

const BILL = `TAX INVOICE
Verma Steel Co.  GSTIN: 27AAAPL1234C1ZV
Invoice No: A-114   Date: 02/09/2026
Bill To: Devgiri Traders
HSN 7308  MS Angle 40x40   Qty 120   Rate 78.50   Amount 9,420.00
CGST 9%  848.00
SGST 9%  848.00
Total  Rs. 11,116.00/-`;

describe("things the book can answer for nothing", () => {
  it("recognises the two questions this business starts every day with", () => {
    expect(route("who owes me money", agents)).toMatchObject({ kind: "book", ask: "outstanding" });
    expect(route("who is late", agents)).toMatchObject({ kind: "book", ask: "overdue" });
    expect(route("how much is outstanding", agents)).toMatchObject({ kind: "book" });
  });

  it("says which words decided it, so a wrong guess can be corrected", () => {
    expect(route("anyone overdue?", agents)?.because).toContain("late");
  });
});

describe("something pasted", () => {
  it("is recognised as a bill by its shape, not by a keyword", () => {
    expect(looksLikeABill(BILL)).toBe(true);
    expect(route(BILL, agents)).toMatchObject({ kind: "bill" });
  });

  it("does not mistake a sentence about money for a document", () => {
    // The failure that would matter: typing "Patel owes me ₹14,160" and being
    // shown a bill form to confirm.
    expect(looksLikeABill("Patel owes me ₹14,160 and has not paid")).toBe(false);
    expect(route("Patel owes me ₹14,160 and has not paid", agents)).toMatchObject({
      kind: "book"
    });
  });

  it("needs more than one mark of a bill", () => {
    // A chatty message with the word "total" in it is not an invoice.
    expect(looksLikeABill("the total came to ₹5,000 in the end, which is fine")).toBe(false);
  });
});

describe("an agent the owner named", () => {
  it("wins, because they wrote its name", () => {
    expect(route("run Filing clerk on downloads", agents)).toMatchObject({
      kind: "agent",
      agentId: "filing-clerk"
    });
  });

  it("is not matched inside another word", () => {
    expect(route("the drafts are fine", [{ id: "d", name: "Draft" }])).not.toMatchObject({
      kind: "agent"
    });
  });
});

describe("two opinions", () => {
  it("is asked for in the words people actually use", () => {
    expect(route("ask both about this quote", agents)).toMatchObject({ kind: "bench" });
    expect(route("give me a second opinion", agents)).toMatchObject({ kind: "bench" });
  });
});

describe("words that only look like a document", () => {
  it("does not read a question about an unpaid bill as a bill", () => {
    // "bill not paid" matched the invoice-number mark, because `no` had no word
    // boundary — so asking why something was unpaid opened the bill form.
    expect(looksLikeABill("Why is this bill not paid? Amount is ₹5,000 and it is overdue")).toBe(
      false
    );
    expect(looksLikeABill("gst notice came for ₹5,000, what do I do about the total")).toBe(false);
  });

  it("does not treat a bare comma as an amount", () => {
    expect(looksLikeABill("fees in Rs., not USD — invoice no and gstin both missing here")).toBe(
      false
    );
  });
});

describe("chasing somebody the book does not know", () => {
  it("asks an engine rather than answering a different question", () => {
    // "chase" also matches the overdue rule, so this used to answer with the
    // whole late list — a confident answer to a question nobody asked.
    expect(route("chase Vikram about the delivery", agents, ["Devgiri Traders"])).toBeNull();
  });

  it("still chases somebody it does know", () => {
    expect(route("chase Devgiri Traders", agents, ["Devgiri Traders"])).toMatchObject({
      kind: "chase",
      party: "Devgiri Traders"
    });
  });
});

describe("what it refuses to guess", () => {
  it("returns null rather than sending an open question to the book", () => {
    // "What do you think about the Sharma job" answered with a balance nobody
    // asked for is how people learn not to type sentences.
    expect(route("what do you think about the Sharma job", agents)).toBeNull();
    expect(route("", agents)).toBeNull();
    expect(route("hello", agents)).toBeNull();
  });

  it("does not read a long paragraph as a balance question", () => {
    const paragraph = `${"Sharma rang about the delivery and said the second lot was short. ".repeat(4)}He owes us for the first one.`;

    expect(route(paragraph, agents)).toBeNull();
  });
});
