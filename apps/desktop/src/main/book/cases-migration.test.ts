/**
 * A book that already has a business in it must reach v4 with all of it intact.
 *
 * Every migration before this one ran on a database somebody could afford to
 * lose, because there was nothing in it yet. v4 is the first to arrive at a book
 * that has been carrying real parties and real invoices for a fortnight, and the
 * only honest way to know it survives that is to build a v3 book with data in
 * it, migrate it, and count what came out.
 *
 * The failure this guards against is not a migration that throws — that one is
 * loud and gets noticed. It is a migration that succeeds and quietly drops a
 * row, which is discovered weeks later by a customer who is owed money the book
 * has forgotten about.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCase, appendTurn, turnsFor } from "./cases.js";
import { openBook } from "./database.js";
import { LATEST_VERSION, MIGRATIONS } from "./schema.js";

let base: string;
let file: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-cases-migration-"));
  file = join(base, "book.sqlite");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A book stopped at v3, with a real party and a real bill already in it. */
function seedV3(path: string): void {
  const db = new DatabaseSync(path);
  for (const migration of MIGRATIONS.filter((one) => one.version <= 3)) {
    db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version = 3");
  db.prepare(
    `INSERT INTO party (id, name, kind, created_at, updated_at)
     VALUES ('p1', 'Sharma Traders', 'customer', 1000, 1000)`
  ).run();
  db.prepare(
    `INSERT INTO invoice
       (id, party_id, issued_on, subtotal_paise, tax_paise, total_paise, status, created_at, updated_at)
     VALUES ('i1', 'p1', 1000, 100000, 18000, 118000, 'confirmed', 1000, 1000)`
  ).run();
  db.close();
}

describe("upgrading a book that already holds a business", () => {
  it("reaches v4 and keeps every record it was carrying", async () => {
    seedV3(file);

    const { db, from, to } = await openBook(file);

    expect(from).toBe(3);
    expect(to).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(4);

    // The point of the test: the business is still there afterwards.
    expect(db.prepare(`SELECT name FROM party WHERE id = 'p1'`).get()).toEqual({
      name: "Sharma Traders"
    });
    expect(db.prepare(`SELECT total_paise FROM invoice WHERE id = 'i1'`).get()).toEqual({
      total_paise: 118000
    });
    db.close();
  });

  it("takes a backup on the way, because a migration never runs without one", async () => {
    seedV3(file);
    const { db, backup } = await openBook(file);

    expect(backup).not.toBeNull();
    db.close();
  });

  it("gives the upgraded book working case tables, not merely a version number", async () => {
    seedV3(file);
    const { db } = await openBook(file);

    // A `user_version` of 4 with no usable tables is the exact shape of failure
    // D-043 is about: written, recorded as done, and not actually reachable.
    const id = openCase(db, { title: "Chase Sharma", question: "Why is this still open?" });
    appendTurn(db, id, { seat: "owner", kind: "verbatim", body: "It was promised on Tuesday." });

    expect(turnsFor(db, id).map((turn) => turn.body)).toEqual(["It was promised on Tuesday."]);
    db.close();
  });

  it("can point a case at an invoice that predates cases entirely", async () => {
    seedV3(file);
    const { db } = await openBook(file);

    const id = openCase(db, { title: "The 47-day bill", question: "Has this been paid?" });
    // The record was written under v1 and the case under v4. A link across that
    // gap is the normal case, not an edge one.
    db.prepare(`INSERT INTO case_link (case_id, kind, ref_id) VALUES (?, 'invoice', 'i1')`).run(id);

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM case_link WHERE ref_id = 'i1'`).get()
    ).toEqual({ n: 1 });
    db.close();
  });
});
