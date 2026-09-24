import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentBrief, ContextSource } from "@cadrane/contracts";
import { openBook } from "../book/database.js";
import { addInvoice, addParty, setNote } from "../book/records.js";
import { gatherFor } from "./service.js";
import { newBrief } from "./brief.js";

let dir: string;
let folder: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-gather-"));
  folder = join(dir, "Clients");
  await writeFile(join(dir, "note.txt"), "x");
  db = (await openBook(join(dir, "book.sqlite"))).db;
  const party = addParty(db, { name: "Devgiri Traders" });
  addInvoice(db, {
    partyId: party,
    issuedOn: Date.parse("2026-08-01"),
    subtotalPaise: 800_000,
    totalPaise: 944_000
  });
  setNote(db, party, "Agreed 45 days from October.");
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const briefThatReads = (reads: readonly ContextSource[]): AgentBrief =>
  newBrief({ id: "a", name: "A", purpose: "p", folders: [dir], reads });

const labels = async (reads: readonly ContextSource[], granted: readonly string[] = [dir]) =>
  (await gatherFor(briefThatReads(reads), granted, db)).map((item) => item.label);

describe("an agent is given what its brief declares", () => {
  it("and nothing it did not", async () => {
    // The screen says "may draw on its folders, your records and the names it
    // has learned". Until this dispatched, that sentence decided nothing: an
    // agent declaring only the glossary still got a folder listing, and one
    // declaring the glossary got no glossary.
    expect(await labels(["glossary"])).toEqual(["words this business uses"]);
    expect(await labels(["book"])).toEqual(["the book"]);
    expect(await labels(["vault"])).toEqual(["the owner's notes"]);
  });

  it("gets a folder listing only when it says it reads folders", async () => {
    expect(await labels(["folders"])).toEqual([`listing of ${dir.split("/").pop() ?? dir}`]);
    expect(await labels(["book"])).not.toContain(`listing of ${dir.split("/").pop() ?? dir}`);
  });
});

describe("a folder the owner paused", () => {
  it("is not read, because it is no longer in the granted list", async () => {
    // The pause is subtracted at the ceiling, so by the time anything reaches
    // here the folder simply is not granted. That is the whole reason it can be
    // believed: an off switch with an exception is not an off switch.
    expect(await labels(["folders"], [])).toEqual([]);
  });
});

describe("with the book closed", () => {
  it("says nothing rather than something stale", async () => {
    const evidence = await gatherFor(briefThatReads(["glossary", "book", "vault"]), [dir], null);

    expect(evidence).toEqual([]);
  });
});

describe("the figures an agent is told", () => {
  it("come from the book and never from a note", async () => {
    // One source for an amount. The notes source carries prose only, so there
    // is exactly one place a number in a prompt can have come from.
    const [notes] = await gatherFor(briefThatReads(["vault"]), [dir], db);

    expect(notes?.content).toBe("Devgiri Traders: Agreed 45 days from October.");
    expect(notes?.content).not.toMatch(/\d[\d,]*\.\d\d|₹/u);

    const [book] = await gatherFor(briefThatReads(["book"]), [dir], db);
    expect(book?.content).toContain("₹9,440");
  });
});
