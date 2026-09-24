/**
 * Letting the book settle what the book can settle.
 *
 * Two frontier models arguing produce confident prose on both sides, and the
 * one that wins is the one that argues better. For a question of judgement that
 * is fine. For a question of fact it is dangerous: a wrong answer arrives with
 * two models' worth of authority behind it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBook } from "../book/database.js";
import { addInvoice, addParty } from "../book/records.js";
import { adjudicate, claimsIn } from "./adjudicate.js";

let dir: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-adjudicate-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
  const devgiri = addParty(db, { name: "Devgiri Traders" });
  addInvoice(db, {
    partyId: devgiri,
    issuedOn: Date.parse("2026-08-01"),
    subtotalPaise: 800_000,
    totalPaise: 944_000
  });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const turn = (seat: "proposer" | "adversary", text: string) => ({ seat, text });

describe("a claim the book can settle", () => {
  it("loses to the record, however well it was argued", () => {
    const result = adjudicate(db, [
      turn(
        "proposer",
        "Considering the ageing profile in detail, Devgiri Traders owes ₹12,000 and should be chased first."
      ),
      turn("adversary", "AGREE, that reasoning is sound and I have nothing to add.")
    ]);

    expect(result.checked).toBe(true);
    expect(result.wrong).toEqual(["proposer"]);
    expect(result.said).toContain("₹9,440");
    expect(result.said).toContain("not a matter of who argued better");
  });

  it("confirms a correct figure rather than staying silent", () => {
    // Silence would read as "nothing was checked", which is a different claim.
    const result = adjudicate(db, [turn("proposer", "Devgiri Traders owes ₹9,440.")]);

    expect(result.checked).toBe(true);
    expect(result.wrong).toEqual([]);
    expect(result.said).toContain("All correct");
  });

  it("reads Rs. and ₹ alike, because bills use both", () => {
    const result = adjudicate(db, [turn("proposer", "Devgiri Traders owes Rs. 9440.")]);

    expect(result.claims[0]?.right).toBe(true);
  });
});

describe("an argument with nothing checkable in it", () => {
  it("says the book stayed out of it", () => {
    // The common case, and saying it plainly is what stops somebody reading a
    // silent adjudicator as agreement.
    const result = adjudicate(db, [
      turn("proposer", "This quote is fair given the current steel price."),
      turn("adversary", "I HOLD — the terms are worse than last quarter.")
    ]);

    expect(result.checked).toBe(false);
    expect(result.wrong).toEqual([]);
    expect(result.said).toContain("stayed out of it");
  });

  it("has no opinion on a matter of judgement", () => {
    // An adjudicator with views would be a third model with extra steps, and it
    // would be believed more than the other two because it arrived last.
    const result = adjudicate(db, [turn("proposer", "We should take the contract.")]);

    expect(result.claims).toEqual([]);
    expect(result.said).not.toContain("should");
  });
});

describe("how narrowly it reads", () => {
  it("pairs a name with an amount only inside one sentence", () => {
    // A looser rule would pair a name in one clause with a figure in another
    // and then confidently mark a correct engine wrong — worse than checking
    // nothing at all.
    const parties = [{ name: "Devgiri Traders", owedPaise: 944_000 }];

    expect(claimsIn("Devgiri Traders is late. Verma paid ₹61,360.", parties)).toEqual([]);
    expect(claimsIn("Devgiri Traders owes ₹9,440.", parties)).toHaveLength(1);
  });

  it("skips a sentence carrying more than one figure", () => {
    // This used to take the first of them. Which figure the party *owes* is a
    // guess when there are three, and guessing here means marking a correct
    // engine wrong — the one outcome an adjudicator must never produce.
    const parties = [{ name: "Devgiri Traders", owedPaise: 944_000 }];

    expect(claimsIn("Devgiri Traders: ₹9,440 then ₹2,950 then ₹1,000.", parties)).toEqual([]);
    expect(claimsIn("Devgiri Traders owes ₹9,440.", parties)).toHaveLength(1);
  });

  it("does not read an English word ending in 'rs' as rupees", () => {
    // Without a word boundary, "creditors 2000" and "hours 10" were currency.
    const parties = [{ name: "Devgiri Traders", owedPaise: 944_000 }];

    expect(claimsIn("Devgiri Traders has been a creditor 2000 days.", parties)).toEqual([]);
  });

  it("does not match a short trading name inside an ordinary word", () => {
    // A party called Dev matched "development"; one called Om matched
    // "customer". Short trading names are common.
    const parties = [{ name: "Om", owedPaise: 100 }];

    expect(claimsIn("The customer paid ₹1,000.", parties)).toEqual([]);
    expect(claimsIn("Om paid ₹1.", parties)).toHaveLength(1);
  });

  it("ignores a party the book has never heard of", () => {
    expect(claimsIn("Someone Else owes ₹5,000.", [{ name: "Devgiri Traders", owedPaise: 1 }])).toEqual(
      []
    );
  });
});
