import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEPT_MIGRATION_BACKUPS, openBook, SchemaTooNew } from "./database.js";
import { LATEST_VERSION } from "./schema.js";

let base: string;
let file: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-book-test-"));
  file = join(base, "book.sqlite");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const version = (db: DatabaseSync) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("opening the book", () => {
  it("creates a fresh one at the latest schema", async () => {
    const { db, from, to, backup, applied } = await openBook(file);

    expect(from).toBe(0);
    expect(to).toBe(LATEST_VERSION);
    expect(version(db)).toBe(LATEST_VERSION);
    // Nothing to back up: a fresh file has no records, and writing a backup of
    // an empty book would push a real one out of the retention window.
    expect(backup).toBeNull();
    expect(applied.length).toBeGreaterThan(0);
    db.close();
  });

  it("does nothing on a second open", async () => {
    const first = await openBook(file);
    first.db.close();

    const second = await openBook(file);

    expect(second.from).toBe(LATEST_VERSION);
    expect(second.applied).toEqual([]);
    expect(second.backup).toBeNull();
    second.db.close();
  });

  /** P0.1's done-when, as written. */
  it("backs the book up beside itself before migrating it", async () => {
    // A v0 database with something in it: the state a real owner's Mac is in
    // when an update arrives.
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE legacy (id TEXT)");
    old.prepare("INSERT INTO legacy VALUES (?)").run("keep-me");
    old.exec("PRAGMA user_version = 0");
    old.close();

    const { db, from, to, backup } = await openBook(file);

    expect(from).toBe(0);
    expect(to).toBe(LATEST_VERSION);
    expect(backup).not.toBeNull();
    db.close();
  });

  it("keeps the old records readable in the backup it took", async () => {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE legacy (id TEXT)");
    old.prepare("INSERT INTO legacy VALUES (?)").run("keep-me");
    old.exec("PRAGMA user_version = 1");
    old.close();

    // Pretend v1 is behind us so a migration is pending and a backup is taken.
    const { db, backup } = await openBookAtFakeVersion(file);
    db.close();

    expect(backup).not.toBeNull();
    const restored = new DatabaseSync(backup as string);
    const row = restored.prepare("SELECT id FROM legacy").get() as { id: string };
    expect(row.id).toBe("keep-me");
    restored.close();
  });

  it("refuses a book from a newer Rellane rather than damaging it", async () => {
    const future = new DatabaseSync(file);
    future.exec(`PRAGMA user_version = ${LATEST_VERSION + 5}`);
    future.close();

    // Half-populating a column this build does not know about is how a ledger
    // becomes quietly wrong, which is worse than refusing to open.
    await expect(openBook(file)).rejects.toBeInstanceOf(SchemaTooNew);
    await expect(openBook(file)).rejects.toThrow(/newer version of Rellane/u);
  });

  it("keeps only the most recent pre-migration backups", async () => {
    // Each round starts from a genuinely old book rather than resetting the
    // version on a migrated one — rewinding `user_version` over existing tables
    // is a state no Mac is ever in, and testing against it would prove nothing.
    for (let n = 0; n < KEPT_MIGRATION_BACKUPS + 3; n += 1) {
      await rm(file, { force: true });
      await rm(`${file}-wal`, { force: true });
      await rm(`${file}-shm`, { force: true });

      const old = new DatabaseSync(file);
      old.exec("CREATE TABLE legacy (id TEXT)");
      old.prepare("INSERT INTO legacy VALUES (?)").run(`round-${n}`);
      old.exec("PRAGMA user_version = 0");
      old.close();

      const { db } = await openBook(file);
      db.close();
      // Distinct timestamps, since the backup's name carries one.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const backups = (await readdir(base)).filter((name) => name.endsWith(".bak"));
    expect(backups.length).toBe(KEPT_MIGRATION_BACKUPS);
  });
});

describe("the shape the book is opened in", () => {
  it("turns on the settings a ledger needs", async () => {
    const { db } = await openBook(file);

    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    const keys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };

    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    // FULL is 2. NORMAL can lose the most recent transactions on power loss,
    // and this is somebody's money.
    expect(sync.synchronous).toBe(2);
    expect(keys.foreign_keys).toBe(1);
    db.close();
  });

  it("enforces the references between records", async () => {
    const { db } = await openBook(file);

    // A bill pointing at a party that does not exist is not a bill.
    expect(() =>
      db
        .prepare(
          "INSERT INTO invoice (id, party_id, issued_on, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
        )
        .run("i1", "nobody", 0, "confirmed", 0, 0)
    ).toThrow();
    db.close();
  });

  it("refuses a status the book does not have a meaning for", async () => {
    const { db } = await openBook(file);
    db.prepare("INSERT INTO party (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(
      "p1",
      "Sharma Printers",
      0,
      0
    );

    expect(() =>
      db
        .prepare(
          "INSERT INTO invoice (id, party_id, issued_on, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
        )
        .run("i1", "p1", 0, "posted", 0, 0)
    ).toThrow();
    db.close();
  });

  it("can search, which is what FTS5 was checked for", async () => {
    const { db } = await openBook(file);
    db.prepare("INSERT INTO search (kind, ref_id, title, body) VALUES (?,?,?,?)").run(
      "party",
      "p1",
      "Sharma Printers",
      "Gurugram packaging cartons"
    );

    const hit = db.prepare("SELECT ref_id FROM search WHERE search MATCH ?").get("sharma") as
      | { ref_id: string }
      | undefined;

    expect(hit?.ref_id).toBe("p1");
    db.close();
  });

  it("keeps one document per file, so the same photo is never imported twice", async () => {
    const { db } = await openBook(file);
    const insert = db.prepare(
      "INSERT INTO document (id, kind, path, sha256, bytes, captured_at, created_at) VALUES (?,?,?,?,?,?,?)"
    );
    insert.run("d1", "photo", "a.jpg", "abc123", 10, 0, 0);

    expect(() => insert.run("d2", "photo", "copy-of-a.jpg", "abc123", 10, 0, 0)).toThrow();
    db.close();
  });

  it("removes a bill's lines with the bill, and never the other way round", async () => {
    const { db } = await openBook(file);
    db.prepare("INSERT INTO party (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(
      "p1",
      "Sharma Printers",
      0,
      0
    );
    db.prepare(
      "INSERT INTO invoice (id, party_id, issued_on, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run("i1", "p1", 0, "confirmed", 0, 0);
    db.prepare(
      "INSERT INTO invoice_item (id, invoice_id, position, description) VALUES (?,?,?,?)"
    ).run("li1", "i1", 0, "Visiting cards, 1000");

    db.prepare("DELETE FROM invoice WHERE id = ?").run("i1");

    const left = db.prepare("SELECT COUNT(*) AS n FROM invoice_item").get() as { n: number };
    expect(left.n).toBe(0);
    db.close();
  });
});

/**
 * Opens with a database already at v1 and a pending migration ahead of it.
 *
 * There is only one migration today, so the "existing book gets backed up" path
 * cannot be reached through the public API without inventing a second one. This
 * forces it by putting the file at v0 with real content, which is the same code
 * path an owner's Mac takes on the update that introduces v2.
 */
async function openBookAtFakeVersion(file: string) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version = 0");
  db.close();
  return openBook(file);
}
