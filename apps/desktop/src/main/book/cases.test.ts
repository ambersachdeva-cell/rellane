import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  allCases,
  appendTurn,
  caseCounts,
  casesAbout,
  closeCase,
  eraseCase,
  link,
  openCase,
  openCases,
  readCase,
  turnsFor,
  verbatimFor
} from "./cases.js";
import { MIGRATIONS } from "./schema.js";

/** A book at the latest schema, in memory. Foreign keys on, as `open.ts` sets them. */
function book(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

let db: DatabaseSync;
beforeEach(() => {
  db = book();
});

describe("a case is work that finishes", () => {
  it("opens with the owner's question, unrewritten, and no verdict", () => {
    const id = openCase(db, {
      title: "Sharma's quote",
      question: "  why is sharma's quote ₹4,000 out?  "
    });

    const row = readCase(db, id);
    expect(row?.question).toBe("why is sharma's quote ₹4,000 out?");
    expect(row?.closedAt).toBeNull();
    expect(row?.verdict).toBeNull();
  });

  it("closes with a verdict, and closing an already-closed case changes nothing", () => {
    const id = openCase(db, { title: "t", question: "q" });

    expect(closeCase(db, id, { closedAs: "settled", verdict: "The tax was applied twice." }))
      .toBe(true);
    // Not an error, and it must not overwrite the verdict that was reached.
    expect(closeCase(db, id, { closedAs: "dropped", verdict: "something else" })).toBe(false);

    const row = readCase(db, id);
    expect(row?.closedAs).toBe("settled");
    expect(row?.verdict).toBe("The tax was applied twice.");
  });

  it("refuses to grow a closed case", () => {
    const id = openCase(db, { title: "t", question: "q" });
    closeCase(db, id, { closedAs: "settled", verdict: "done" });

    expect(() => appendTurn(db, id, { seat: "builder", kind: "verbatim", body: "more" }))
      .toThrow(/closed/iu);
  });

  it("retains cases older than thirty-one days without automatic closure", () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const quietOld = openCase(
      db,
      { title: "quiet old case", question: "awaiting third party response" },
      thirtyOneDaysAgo
    );
    const activeOld = openCase(
      db,
      { title: "active old case", question: "long ongoing dispute" },
      thirtyOneDaysAgo
    );
    appendTurn(
      db,
      activeOld,
      { seat: "builder", kind: "verbatim", body: "still pending verification" },
      thirtyOneDaysAgo + 1000
    );

    // Reading or listing cases leaves waiting work untouched (D-096)
    const open = openCases(db);
    expect(open.map((c) => c.id)).toContain(quietOld);
    expect(open.map((c) => c.id)).toContain(activeOld);

    const quietRow = readCase(db, quietOld);
    expect(quietRow?.closedAt).toBeNull();
    expect(quietRow?.closedAs).toBeNull();
    expect(quietRow?.verdict).toBeNull();

    const activeRow = readCase(db, activeOld);
    expect(activeRow?.closedAt).toBeNull();
    expect(activeRow?.closedAs).toBeNull();
    expect(activeRow?.verdict).toBeNull();
  });

  it("allows appending turns to an old waiting case and explicitly closing it", () => {
    const thirtyFiveDaysAgo = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const id = openCase(
      db,
      { title: "delayed invoice issue", question: "why delayed?" },
      thirtyFiveDaysAgo
    );

    // Old waiting case can still grow turns
    const turnId = appendTurn(db, id, {
      seat: "owner",
      kind: "verbatim",
      body: "supplier confirmed payment cleared"
    });
    expect(turnsFor(db, id).map((t) => t.id)).toContain(turnId);

    // Owner can explicitly close with verdict
    expect(
      closeCase(db, id, { closedAs: "settled", verdict: "Resolved after five weeks." })
    ).toBe(true);

    const row = readCase(db, id);
    expect(row?.closedAt).toBeTypeOf("number");
    expect(row?.closedAs).toBe("settled");
    expect(row?.verdict).toBe("Resolved after five weeks.");

    // Closing remains idempotent and does not overwrite existing verdict
    expect(closeCase(db, id, { closedAs: "dropped", verdict: "overwritten?" })).toBe(false);
    expect(readCase(db, id)?.verdict).toBe("Resolved after five weeks.");

    // Legacy abandoned records remain closed and refuse turns
    const legacyId = openCase(db, { title: "legacy", question: "q" }, thirtyFiveDaysAgo);
    closeCase(
      db,
      legacyId,
      { closedAs: "abandoned", verdict: "Closed under prior sweep" },
      thirtyFiveDaysAgo + 1000
    );
    expect(readCase(db, legacyId)?.closedAs).toBe("abandoned");
    expect(openCases(db).map((c) => c.id)).not.toContain(legacyId);
    expect(() =>
      appendTurn(db, legacyId, { seat: "owner", kind: "verbatim", body: "more" })
    ).toThrow(/closed/iu);
  });
});

describe("the room", () => {
  it("keeps turns in the order they were spoken", () => {
    const id = openCase(db, { title: "t", question: "q" });
    appendTurn(db, id, { seat: "builder", kind: "verbatim", body: "first" });
    appendTurn(db, id, { seat: "tester", kind: "verbatim", body: "second" });
    appendTurn(db, id, { seat: "reviewer", kind: "finding", body: "third" });

    expect(turnsFor(db, id).map((turn) => [turn.seq, turn.body])).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"]
    ]);
  });

  it("gives two turns written in the same millisecond different positions", () => {
    // The read-then-write version of this collides and loses a seat's work. Six
    // seats finishing near each other is the normal case in a room.
    const id = openCase(db, { title: "t", question: "q" });
    const at = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) {
      appendTurn(db, id, { seat: `seat${i}`, kind: "verbatim", body: `turn ${i}` }, at);
    }

    const seqs = turnsFor(db, id).map((turn) => turn.seq);
    expect(new Set(seqs).size).toBe(20);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("numbers each case's turns independently", () => {
    const a = openCase(db, { title: "a", question: "q" });
    const b = openCase(db, { title: "b", question: "q" });
    appendTurn(db, a, { seat: "s", kind: "verbatim", body: "a1" });
    appendTurn(db, b, { seat: "s", kind: "verbatim", body: "b1" });

    expect(turnsFor(db, a)[0]?.seq).toBe(1);
    expect(turnsFor(db, b)[0]?.seq).toBe(1);
  });

  it("makes a compacted turn say what it replaced, and refuses one that does not", () => {
    const id = openCase(db, { title: "t", question: "q" });
    const first = appendTurn(db, id, { seat: "s", kind: "verbatim", body: "old" });

    const summary = appendTurn(db, id, {
      seat: "qwen3-4b",
      kind: "compacted",
      body: "They discussed the quote.",
      compactedFrom: [first]
    });
    expect(turnsFor(db, id).find((t) => t.id === summary)?.compactedFrom).toEqual([first]);

    expect(() =>
      appendTurn(db, id, { seat: "qwen3-4b", kind: "compacted", body: "no source" })
    ).toThrow(/which turns it replaced/u);
    // And the reverse: an ordinary turn may not claim to be a summary of others.
    expect(() =>
      appendTurn(db, id, {
        seat: "s",
        kind: "verbatim",
        body: "x",
        compactedFrom: [first]
      })
    ).toThrow(/only a compacted turn may/u);
  });
});

describe("what the compactor is allowed to read", () => {
  it("never hands it a finding or a receipt", () => {
    const id = openCase(db, { title: "t", question: "q" });
    appendTurn(db, id, { seat: "s", kind: "verbatim", body: "chatter" });
    appendTurn(db, id, { seat: "s", kind: "finding", body: "the tax is doubled" });
    appendTurn(db, id, { seat: "s", kind: "receipt", body: "wrote invoice.ts, sha 9f2c" });

    const visible = verbatimFor(db, id, 0);
    expect(visible.map((turn) => turn.body)).toEqual(["chatter"]);
    // The safe design never gives the model the thing it must not lose, rather
    // than giving it and asking for it back.
    expect(visible.some((turn) => turn.kind === "finding" || turn.kind === "receipt")).toBe(false);
  });

  it("holds back the most recent turns, which are the ones still being worked on", () => {
    const id = openCase(db, { title: "t", question: "q" });
    for (const body of ["one", "two", "three", "four"]) {
      appendTurn(db, id, { seat: "s", kind: "verbatim", body });
    }

    expect(verbatimFor(db, id, 2).map((turn) => turn.body)).toEqual(["one", "two"]);
    expect(verbatimFor(db, id, 99)).toEqual([]);
  });
});

describe("a case points at records and never contains them", () => {
  it("finds the cases that touched a record", () => {
    const a = openCase(db, { title: "chase ADM", question: "q" });
    const b = openCase(db, { title: "check the tax", question: "q" });
    link(db, a, "invoice", "inv-1");
    link(db, b, "invoice", "inv-1");
    link(db, b, "party", "party-9");

    expect(casesAbout(db, "invoice", "inv-1").map((row) => row.title).sort())
      .toEqual(["chase ADM", "check the tax"]);
    expect(casesAbout(db, "party", "party-9").map((row) => row.title)).toEqual(["check the tax"]);
  });

  it("linking the same record twice is not an error and does not duplicate", () => {
    const id = openCase(db, { title: "t", question: "q" });
    link(db, id, "invoice", "inv-1");
    link(db, id, "invoice", "inv-1");

    expect(casesAbout(db, "invoice", "inv-1")).toHaveLength(1);
  });

  it("erasing a case takes its turns with it and leaves the record it pointed at", () => {
    const id = openCase(db, { title: "t", question: "q" });
    appendTurn(db, id, { seat: "s", kind: "verbatim", body: "something private" });
    link(db, id, "invoice", "inv-1");

    expect(eraseCase(db, id)).toBe(true);
    expect(readCase(db, id)).toBeNull();
    // Nothing said inside it survives — this is the scope DPDP erasure needed.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM case_turn`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM case_link`).get()).toEqual({ n: 0 });
    expect(eraseCase(db, id)).toBe(false);
  });
});

describe("listing", () => {
  it("puts the most recently active case first, not the most recently opened", () => {
    const older = openCase(db, { title: "older", question: "q" }, 1000);
    const newer = openCase(db, { title: "newer", question: "q" }, 2000);
    appendTurn(db, older, { seat: "s", kind: "verbatim", body: "just spoke" }, 3000);

    expect(openCases(db).map((row) => row.title)).toEqual(["older", "newer"]);
    expect(readCase(db, older)?.turns).toBe(1);
    expect(readCase(db, newer)?.turns).toBe(0);
    expect(newer).not.toBe(older);
  });

  it("separates open from closed, and keeps closed cases as history", () => {
    const open = openCase(db, { title: "open", question: "q" });
    const shut = openCase(db, { title: "shut", question: "q" });
    closeCase(db, shut, { closedAs: "settled", verdict: "v" });

    expect(openCases(db).map((row) => row.title)).toEqual(["open"]);
    expect(allCases(db).map((row) => row.title).sort()).toEqual(["open", "shut"]);
    expect(caseCounts(db)).toEqual({ open: 1, closed: 1 });
  });

  it("counts nothing as nothing on an empty book", () => {
    expect(caseCounts(db)).toEqual({ open: 0, closed: 0 });
    expect(openCases(db)).toEqual([]);
  });
});
