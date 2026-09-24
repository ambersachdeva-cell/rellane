import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBook } from "../book/database.js";
import { addParty, setNote } from "../book/records.js";
import { whatItHasSeen } from "./memory.js";

let dir: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-seen-"));
  db = (await openBook(join(dir, "book.sqlite"))).db;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const sighting = { path: "/Users/a/Clients", files: 487, lastSeenAt: "2026-09-02T10:00:00.000Z" };

describe("the folders it has seen", () => {
  it("says how many files, never which ones", () => {
    // Somebody checking what this product knows about them should not have to
    // read their own filenames on a screen a colleague might be behind.
    const seen = whatItHasSeen(db, ["/Users/a/Clients"], [], [sighting]);

    expect(seen.folders[0]).toEqual({
      path: "/Users/a/Clients",
      name: "Clients",
      watching: true,
      files: 487,
      lastSeenAt: "2026-09-02T10:00:00.000Z"
    });
    expect(JSON.stringify(seen)).not.toContain(".pdf");
  });

  it("shows a paused folder as paused rather than hiding it", () => {
    // A folder that disappeared from this list would leave the owner unable to
    // find the switch that turns it back on.
    const seen = whatItHasSeen(db, ["/Users/a/Clients"], ["/Users/a/Clients"], [sighting]);

    expect(seen.folders[0]?.watching).toBe(false);
  });

  it("distinguishes never-captured from captured-nothing", () => {
    const seen = whatItHasSeen(db, ["/Users/a/New"], [], []);

    expect(seen.folders[0]?.files).toBeNull();
    expect(seen.folders[0]?.lastSeenAt).toBeNull();
  });
});

describe("the notes it has seen", () => {
  it("are the owner's own words, and appear here as well as in a prompt", () => {
    const party = addParty(db, { name: "Devgiri Traders" });
    setNote(db, party, "Agreed 45 days from October.");

    const seen = whatItHasSeen(db, [], [], []);

    expect(seen.notes).toEqual([
      { partyName: "Devgiri Traders", note: "Agreed 45 days from October." }
    ]);
  });
});

describe("with nothing seen at all", () => {
  it("says so, which is a real state rather than a blank screen", () => {
    expect(whatItHasSeen(db, [], [], []).empty).toBe(true);
    expect(whatItHasSeen(null, [], [], []).empty).toBe(true);
  });
});
