import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openBook } from "./database.js";
import {
  addInvoice,
  addParty,
  addPayment,
  counts,
  outstanding,
  overdue,
  owing,
  totalOwedPaise
} from "./records.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-02T10:00:00.000Z");

let dir: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-records-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("what a party owes", () => {
  it("is worked out from the bills, never stored", () => {
    // The house rule. A stored balance is a number that can disagree with the
    // bills it came from, silently and permanently.
    const devgiri = addParty(db, { name: "Devgiri Traders", phone: "+919876543210" });
    addInvoice(db, { partyId: devgiri, issuedOn: NOW - 10 * DAY, subtotalPaise: 800_000, totalPaise: 936_000 });
    addPayment(db, { partyId: devgiri, receivedOn: NOW - DAY, amountPaise: 500_000 });

    const [standing] = owing(db, NOW);

    expect(standing?.name).toBe("Devgiri Traders");
    expect(standing?.billedPaise).toBe(936_000);
    expect(standing?.paidPaise).toBe(500_000);
    expect(standing?.owedPaise).toBe(436_000);
  });

  it("counts money on account even when it is not allocated to a bill", () => {
    // A customer paying a round sum against three bills is normal here, not an
    // error. Counting only allocated payments would chase somebody who paid.
    const party = addParty(db, { name: "Patel Hardware" });
    addInvoice(db, { partyId: party, issuedOn: NOW, subtotalPaise: 100_000, totalPaise: 100_000 });
    addPayment(db, { partyId: party, receivedOn: NOW, amountPaise: 100_000 });

    expect(owing(db, NOW)).toHaveLength(0);
  });

  it("shows a credit as a negative balance rather than hiding it", () => {
    const party = addParty(db, { name: "Overpayer" });
    addInvoice(db, { partyId: party, issuedOn: NOW, subtotalPaise: 50_000, totalPaise: 50_000 });
    addPayment(db, { partyId: party, receivedOn: NOW, amountPaise: 80_000 });

    const [standing] = outstanding(db, NOW);

    expect(standing?.owedPaise).toBe(-30_000);
    // …but they are not on the chasing list.
    expect(owing(db, NOW)).toHaveLength(0);
  });

  it("puts the largest debt first, because that is the one to act on", () => {
    const small = addParty(db, { name: "Small" });
    const large = addParty(db, { name: "Large" });
    addInvoice(db, { partyId: small, issuedOn: NOW, subtotalPaise: 10_000, totalPaise: 10_000 });
    addInvoice(db, { partyId: large, issuedOn: NOW, subtotalPaise: 900_000, totalPaise: 900_000 });

    expect(owing(db, NOW).map((party) => party.name)).toEqual(["Large", "Small"]);
  });

  it("stays exact on amounts a float would round", () => {
    // Integer paise, all the way through. `0.1 + 0.2` arithmetic in a ledger is
    // how a total ends in 999999.
    const party = addParty(db, { name: "Exact" });
    for (let index = 0; index < 3; index += 1) {
      addInvoice(db, { partyId: party, issuedOn: NOW, subtotalPaise: 3_333, totalPaise: 3_333 });
    }

    expect(totalOwedPaise(db, NOW)).toBe(9_999);
  });
});

describe("a bill read off a photograph", () => {
  it("does not count until somebody confirms it", () => {
    // `confidence` being present means it was extracted. A number nobody has
    // checked must not reach a balance the owner acts on.
    const party = addParty(db, { name: "Scanned" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW,
      subtotalPaise: 500_000,
      totalPaise: 500_000,
      confidence: 0.87
    });

    expect(owing(db, NOW)).toHaveLength(0);
    // It is still in the book — it just is not money yet.
    expect(counts(db).invoices).toBe(1);
  });

  it("counts immediately when a person typed it", () => {
    const party = addParty(db, { name: "Typed" });
    addInvoice(db, { partyId: party, issuedOn: NOW, subtotalPaise: 500_000, totalPaise: 500_000 });

    expect(owing(db, NOW)).toHaveLength(1);
  });
});

describe("a customer who has paid", () => {
  it("is not chased for a bill that is already settled", () => {
    // The worst thing this product could do to a working relationship. The
    // query asked nothing about payments, so a settled customer appeared as
    // overdue for ever and the home screen said so.
    const party = addParty(db, { name: "Paid Up" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 60 * DAY,
      dueOn: NOW - 30 * DAY,
      subtotalPaise: 100_000,
      totalPaise: 100_000
    });
    addPayment(db, { partyId: party, receivedOn: NOW - 20 * DAY, amountPaise: 100_000 });

    expect(overdue(db, NOW).filter((bill) => bill.name === "Paid Up")).toEqual([]);
  });

  it("is still chased while any of it is outstanding", () => {
    const party = addParty(db, { name: "Part Paid" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 60 * DAY,
      dueOn: NOW - 30 * DAY,
      subtotalPaise: 100_000,
      totalPaise: 100_000
    });
    addPayment(db, { partyId: party, receivedOn: NOW - 20 * DAY, amountPaise: 40_000 });

    expect(overdue(db, NOW).filter((bill) => bill.name === "Part Paid")).toHaveLength(1);
  });
});

describe("a new bill does not resurrect an old paid one", () => {
  it("keeps a settled bill settled when a fresh one is raised", () => {
    // The subtle version of the same failure. They paid the old bill in full;
    // a new invoice that is not yet due pushes total billed above total paid,
    // the party looks in debt, and the only *late* bill on their record is one
    // they already settled.
    const party = addParty(db, { name: "Pays On Time" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 90 * DAY,
      dueOn: NOW - 60 * DAY,
      subtotalPaise: 100_000,
      totalPaise: 100_000
    });
    addPayment(db, { partyId: party, receivedOn: NOW - 70 * DAY, amountPaise: 100_000 });
    // Raised today, due next month. Entirely ordinary.
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW,
      dueOn: NOW + 30 * DAY,
      subtotalPaise: 50_000,
      totalPaise: 50_000
    });

    expect(overdue(db, NOW).filter((bill) => bill.name === "Pays On Time")).toEqual([]);
  });
});

describe("a party who owes nothing", () => {
  it("has no open bills and no oldest unpaid date", () => {
    // Both fields claim something about *unpaid* bills, and the contract says
    // so. Reporting a lifetime invoice count for a settled customer contradicts
    // the field's own comment.
    const party = addParty(db, { name: "All Square" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 30 * DAY,
      subtotalPaise: 70_000,
      totalPaise: 70_000
    });
    addPayment(db, { partyId: party, receivedOn: NOW, amountPaise: 70_000 });

    const standing = outstanding(db, NOW).find((row) => row.name === "All Square");

    expect(standing?.owedPaise).toBe(0);
    expect(standing?.openBills).toBe(0);
    expect(standing?.oldestUnpaidOn).toBeNull();
  });
});

describe("what is late", () => {
  it("lists overdue bills oldest first, with how late they are", () => {
    const party = addParty(db, { name: "Late payer" });
    addInvoice(db, {
      partyId: party,
      number: "A-114",
      issuedOn: NOW - 40 * DAY,
      dueOn: NOW - 10 * DAY,
      subtotalPaise: 200_000,
      totalPaise: 200_000
    });

    const [late] = overdue(db, NOW);

    expect(late?.number).toBe("A-114");
    expect(late?.daysLate).toBe(10);
  });

  it("never invents a due date the paper did not carry", () => {
    // A bill with no agreed term is not late. Inventing one puts somebody on a
    // chasing list for a promise they never made.
    const party = addParty(db, { name: "No terms" });
    addInvoice(db, { partyId: party, issuedOn: NOW - 400 * DAY, subtotalPaise: 1, totalPaise: 1 });

    expect(overdue(db, NOW)).toHaveLength(0);
  });
});

describe("a party", () => {
  it("takes its state code from the GSTIN, which is what decides the tax split", () => {
    // The first two characters are the state code, and that is what decides
    // CGST+SGST against IGST.
    const party = addParty(db, { name: "Haryana Co", gstin: "06AABCU9603R1ZM" });
    const row = db.prepare("SELECT state_code AS s FROM party WHERE id = ?").get(party) as {
      s: string;
    };

    expect(row.s).toBe("06");
  });

  it("reports an honest empty book", () => {
    expect(counts(db)).toEqual({ parties: 0, invoices: 0 });
    expect(owing(db, NOW)).toEqual([]);
    expect(totalOwedPaise(db, NOW)).toBe(0);
  });
});

describe("a settled bill stays settled once a later bill goes late", () => {
  it("names only the bill the money ran out on", () => {
    // Found by fuzzing the record layer. The party-level test was right that
    // this customer owes something, and then the query listed *every* bill of
    // theirs past its date — including one paid in full months earlier. They
    // owed ₹50 and the chasing list said ₹150.
    const party = addParty(db, { name: "Two Bills" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 120 * DAY,
      dueOn: NOW - 90 * DAY,
      subtotalPaise: 100_000,
      totalPaise: 100_000
    });
    addPayment(db, { partyId: party, receivedOn: NOW - 80 * DAY, amountPaise: 100_000 });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 40 * DAY,
      dueOn: NOW - 10 * DAY,
      subtotalPaise: 50_000,
      totalPaise: 50_000
    });

    const late = overdue(db, NOW).filter((bill) => bill.name === "Two Bills");
    expect(late).toHaveLength(1);
    expect(late[0]?.totalPaise).toBe(50_000);
    // And the list agrees with what the party actually owes.
    expect(late.reduce((sum, bill) => sum + bill.totalPaise, 0)).toBe(
      outstanding(db, NOW).find((row) => row.name === "Two Bills")?.owedPaise
    );
  });

  it("applies money on account to the oldest bill first", () => {
    // Two bills, both late, one payment covering the first exactly. Oldest
    // first is a choice — a payment here is often genuinely unallocated — and
    // it is the only one that never re-opens a bill a later payment covered.
    const party = addParty(db, { name: "Oldest First" });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 90 * DAY,
      dueOn: NOW - 60 * DAY,
      subtotalPaise: 30_000,
      totalPaise: 30_000
    });
    addInvoice(db, {
      partyId: party,
      issuedOn: NOW - 60 * DAY,
      dueOn: NOW - 30 * DAY,
      subtotalPaise: 70_000,
      totalPaise: 70_000
    });
    addPayment(db, { partyId: party, receivedOn: NOW - 50 * DAY, amountPaise: 30_000 });

    const late = overdue(db, NOW).filter((bill) => bill.name === "Oldest First");
    expect(late).toHaveLength(1);
    expect(late[0]?.totalPaise).toBe(70_000);
  });
});

describe("money that cannot be exact is refused at the door", () => {
  // SQLite stores whatever it is given. Reading it back is where it goes wrong:
  // node:sqlite throws RangeError from outstanding(), which is what the home
  // screen calls — so one bad write makes the whole book unreadable on every
  // launch, not one bad row.
  const party = () => addParty(db, { name: "Edge" });

  it("refuses a bill larger than a number can hold exactly", () => {
    expect(() =>
      addInvoice(db, {
        partyId: party(),
        issuedOn: NOW,
        subtotalPaise: Number.MAX_SAFE_INTEGER + 100,
        totalPaise: Number.MAX_SAFE_INTEGER + 100
      })
    ).toThrow(/fits exactly/u);
  });

  it("refuses a fraction of a paisa", () => {
    expect(() =>
      addInvoice(db, { partyId: party(), issuedOn: NOW, subtotalPaise: 100.5, totalPaise: 100.5 })
    ).toThrow(/fits exactly/u);
  });

  it("refuses a payment that is not a whole number of paise", () => {
    expect(() =>
      addPayment(db, { partyId: party(), receivedOn: NOW, amountPaise: 50.25 })
    ).toThrow(/fits exactly/u);
  });

  it("refuses a figure below the safe range", () => {
    expect(() =>
      addPayment(db, { partyId: party(), receivedOn: NOW, amountPaise: Number.MIN_SAFE_INTEGER - 100 })
    ).toThrow(/fits exactly/u);
  });

  it("leaves the book readable after a refusal", () => {
    // The point of refusing on write: the read path still works afterwards.
    const id = party();
    addInvoice(db, { partyId: id, issuedOn: NOW, subtotalPaise: 1_000, totalPaise: 1_000 });
    try {
      addInvoice(db, { partyId: id, issuedOn: NOW, subtotalPaise: 1e16, totalPaise: 1e16 });
    } catch {
      // expected
    }
    expect(() => outstanding(db, NOW)).not.toThrow();
    expect(outstanding(db, NOW).find((row) => row.name === "Edge")?.billedPaise).toBe(1_000);
  });

  it("still takes every figure a real bill could carry", () => {
    const id = party();
    // ₹99 crore, in paise.
    expect(() =>
      addInvoice(db, { partyId: id, issuedOn: NOW, subtotalPaise: 99_000_000_000, totalPaise: 99_000_000_000 })
    ).not.toThrow();
  });
});
