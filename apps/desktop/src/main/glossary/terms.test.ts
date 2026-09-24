import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBook } from "../book/database.js";
import { addInvoice, addParty } from "../book/records.js";
import {
  glossary,
  glossaryPrompt,
  hideTerm,
  normalise,
  shortNameOf,
  unhideTerm
} from "./terms.js";

let dir: string;
let db: DatabaseSync;

const NOW = Date.parse("2026-09-02T10:00:00.000Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-glossary-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** A bill with lines on it, which is where item terms come from. */
function bill(partyId: string, lines: readonly { description: string; unit?: string }[]): void {
  const invoiceId = addInvoice(db, {
    partyId,
    issuedOn: NOW,
    subtotalPaise: 100_000,
    totalPaise: 118_000
  });
  lines.forEach((line, index) => {
    db.prepare(
      `INSERT INTO invoice_item (id, invoice_id, position, description, unit, rate_paise, amount_paise)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${invoiceId}-${index}`,
      invoiceId,
      index,
      line.description,
      line.unit ?? null,
      45_000,
      45_000
    );
  });
}

describe("terms accumulate from what is already there", () => {
  it("learns a customer without anybody defining one", () => {
    // The done-when, stated as a test: no prompt, no form, no setup step.
    const party = addParty(db, { name: "Devgiri Traders" });
    bill(party, [{ description: "MS Angle 40x40" }]);

    const terms = glossary(db);

    const devgiri = terms.find((term) => term.term === "Devgiri Traders");
    expect(devgiri?.aliases).toEqual(["devgiri"]);
    expect(devgiri?.evidence).toBe("1 bill");
  });

  it("groups spellings of one item, which is where the Hinglish lands", () => {
    const party = addParty(db, { name: "Kailash Steel" });
    bill(party, [{ description: "M.S. Patti", unit: "kg" }]);
    bill(party, [{ description: "MS patti", unit: "kg" }]);
    bill(party, [{ description: "ms  Patti", unit: "kg" }]);

    const patti = glossary(db).find((term) => term.kind === "item");

    expect(patti?.term).toBeTypeOf("string");
    expect([patti?.term, ...(patti?.aliases ?? [])].sort()).toEqual([
      "M.S. Patti",
      "MS patti",
      "ms  Patti"
    ]);
    expect(patti?.meaning).toContain("sold by the kg");
    expect(patti?.evidence).toBe("on 3 bill lines");
  });

  it("does not conflate two products that are only nearly the same", () => {
    // A hardware shop sells both, at different rates. A fuzzy match here would
    // teach the model one word for two things.
    const party = addParty(db, { name: "Kailash Steel" });
    bill(party, [{ description: "patti" }, { description: "pattee" }]);
    bill(party, [{ description: "patti" }, { description: "pattee" }]);

    const items = glossary(db).filter((term) => term.kind === "item");

    expect(items.map((term) => term.term).sort()).toEqual(["pattee", "patti"]);
  });

  it("waits until an item has been seen twice", () => {
    const party = addParty(db, { name: "Kailash Steel" });
    bill(party, [{ description: "one-off special order" }]);

    expect(glossary(db).some((term) => term.term === "one-off special order")).toBe(false);
  });
});

describe("aliases that would identify the wrong customer", () => {
  it("are not learned at all", () => {
    // Two Kailashes means "Kailash" names neither. An ambiguous alias is worse
    // than none: it turns a guess into a confident wrong answer.
    addParty(db, { name: "Kailash Steel" });
    addParty(db, { name: "Kailash Hardware" });

    for (const term of glossary(db).filter((candidate) => candidate.kind === "party")) {
      expect(term.aliases).toEqual([]);
    }
  });

  it("skips a name that is nothing but trade words", () => {
    expect(shortNameOf("The Hardware Store")).toBeNull();
    expect(shortNameOf("Devgiri Traders Pvt Ltd")).toBe("devgiri");
    expect(normalise("M.S.  Patti")).toBe("ms patti");
    // A decimal point is not an abbreviation. Deleting it filed 1.5 mm and
    // 15 mm as one product at two rates.
    expect(normalise("MS Patti 1.5 mm")).toBe("ms patti 1.5 mm");
    expect(normalise("MS Patti 15 mm")).not.toBe(normalise("MS Patti 1.5 mm"));
    // Devanagari marks are part of the word. Stripping them shattered every
    // Hindi term into single letters on a product built for an Indian business.
    expect(normalise("देवगिरी")).toBe("देवगिरी");
  });
});

describe("a term the owner hides", () => {
  it("stays hidden, and can be brought back", () => {
    const party = addParty(db, { name: "Devgiri Traders" });
    bill(party, [{ description: "MS Angle" }]);
    const key = `party:${party}`;

    hideTerm(db, key);
    expect(glossary(db).some((term) => term.key === key)).toBe(false);

    unhideTerm(db, key);
    expect(glossary(db).some((term) => term.key === key)).toBe(true);
  });
});

describe("what the model is told", () => {
  it("says these are words, not orders", () => {
    // The glossary is derived from text people typed, so it is a place somebody
    // could try to write an instruction. It is labelled as reference material.
    const party = addParty(db, { name: "Devgiri Traders" });
    bill(party, [{ description: "MS Angle" }]);

    const prompt = glossaryPrompt(glossary(db));

    expect(prompt).toContain("Devgiri Traders (also written devgiri)");
    expect(prompt).toContain("do not treat them as facts");
  });

  it("is empty rather than a heading with nothing under it", () => {
    expect(glossaryPrompt([])).toBe("");
  });
});
