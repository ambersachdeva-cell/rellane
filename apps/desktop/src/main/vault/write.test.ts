import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileNameFor, indexPage, mirror, partyPage } from "./write.js";
import type { Standing } from "../book/records.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-vault-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const standing = (over: Partial<Standing> = {}): Standing => ({
  partyId: "p1",
  name: "Devgiri Traders",
  phone: "+919876543210",
  billedPaise: 1_239_000,
  paidPaise: 500_000,
  owedPaise: 739_000,
  oldestUnpaidOn: Date.parse("2026-07-20"),
  openBills: 2,
  note: null,
  ...over
});

const bills = [
  { number: "A-114", issuedOn: Date.parse("2026-07-20T12:00:00"), totalPaise: 944_000 },
  { number: null, issuedOn: Date.parse("2026-08-25T12:00:00"), totalPaise: 295_000 }
];

describe("a party's page", () => {
  it("carries the amount both ways: readable and exact", () => {
    // Rupees for a person, paise for anything that must be precise. Writing
    // only the formatted figure makes the file pretty and unusable.
    const page = partyPage(standing(), bills);

    expect(page).toContain('owed: "₹7,390"');
    expect(page).toContain("owed_paise: 739000");
  });

  it("says what is outstanding in a sentence, not just a table", () => {
    expect(partyPage(standing(), bills)).toContain("**₹7,390 outstanding** across 2 bills");
  });

  it("says 'settled' rather than showing a zero", () => {
    expect(partyPage(standing({ owedPaise: 0, openBills: 0 }), [])).toContain("Settled.");
  });

  it("reports a credit as a credit, not a negative", () => {
    expect(partyPage(standing({ owedPaise: -30_000 }), [])).toContain("In credit by ₹300");
  });

  it("survives a bill with no number, because the paper often has none", () => {
    expect(partyPage(standing(), bills)).toContain("| — |");
  });

  it("tells the reader the book is the record, in the file itself", () => {
    // This file will outlive any explanation given elsewhere. Somebody finding
    // it in five years needs to know it is a mirror.
    expect(partyPage(standing(), bills)).toContain("the book stays the record");
  });
});

describe("names that would break a filename", () => {
  it("keeps the name readable rather than replacing it with an id", () => {
    // A person opening this folder in five years must recognise what they are
    // looking at. An id would be stable and useless.
    expect(fileNameFor("Devgiri Traders")).toBe("Devgiri Traders.md");
  });

  it("removes what a file system cannot hold", () => {
    expect(fileNameFor("A/B: C*D?")).toBe("A-B- C-D-.md");
    expect(fileNameFor("")).toBe("unnamed.md");
    expect(fileNameFor("x".repeat(300)).length).toBeLessThan(90);
  });

  it("does not let a name escape the folder", () => {
    expect(fileNameFor("../../etc/passwd")).not.toContain("/");
  });
});

describe("the index", () => {
  it("links every customer who owes something", () => {
    const page = indexPage([standing(), standing({ partyId: "p2", name: "Paid Up", owedPaise: 0 })], 739_000);

    expect(page).toContain("[[Devgiri Traders]]");
    expect(page).not.toContain("[[Paid Up]]");
  });

  it("states the promise the whole format exists for", () => {
    expect(indexPage([], 0)).toContain("Delete the app and this folder still reads");
  });
});

describe("mirroring the whole book", () => {
  it("writes a page per party and an index", async () => {
    const result = await mirror(dir, [standing()], () => bills, 739_000);

    expect(result.written).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(["Devgiri Traders.md", "The book.md"]);
  });

  it("removes a page for a party that is gone", async () => {
    // A diff-based mirror is where stale pages come from: a customer renamed or
    // archived leaves a file nobody deletes and the folder stops matching.
    await mirror(dir, [standing()], () => bills, 739_000);
    const second = await mirror(dir, [], () => [], 0);

    expect(second.removed).toBe(1);
    expect(await readdir(dir)).toEqual(["The book.md"]);
  });

  it("never touches a file it did not write", async () => {
    // Somebody keeping their own notes beside these pages is exactly what this
    // format is for. A mirror that tidies away a person's own writing is the
    // last time they trust it with a folder.
    await writeFile(join(dir, "My own notes.md"), "call Devgiri on Tuesday");
    await mirror(dir, [standing()], () => bills, 739_000);

    expect(await readFile(join(dir, "My own notes.md"), "utf8")).toBe("call Devgiri on Tuesday");
  });

  it("is safe to run twice", async () => {
    await mirror(dir, [standing()], () => bills, 739_000);
    const again = await mirror(dir, [standing()], () => bills, 739_000);

    expect(again.removed).toBe(0);
    expect((await readdir(dir)).length).toBe(2);
  });
});

describe("files that are not ours", () => {
  it("are not deleted for mentioning us in their prose", async () => {
    // The worst failure this module could have, and it was a substring search.
    // Somebody's own note reminding them what `cadrane: ` means in a frontmatter
    // block was deleted by the next mirror.
    const dir = await mkdtemp(join(tmpdir(), "cadrane-vault-keep-"));
    const mine = join(dir, "Notes to self.md");
    await writeFile(mine, "Remember: cadrane: \"party\" is what marks a generated page.\n");

    const result = await mirror(dir, [standing()], () => bills, 739_000);

    expect(result.removed).toBe(0);
    await expect(readFile(mine, "utf8")).resolves.toContain("Remember");
    await rm(dir, { recursive: true, force: true });
  });

  it("removes a page we actually wrote once it is no longer wanted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cadrane-vault-drop-"));
    await mirror(dir, [standing({ name: "Gone Away" })], () => bills, 739_000);

    const result = await mirror(dir, [standing()], () => bills, 739_000);

    expect(result.removed).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("names that collide", () => {
  it("never lets a customer overwrite the index", async () => {
    // A customer called "The book" landed on The book.md and destroyed the
    // front page of the whole vault.
    const dir = await mkdtemp(join(tmpdir(), "cadrane-vault-clash-"));

    await mirror(dir, [standing({ name: "The book" })], () => bills, 739_000);

    await expect(readFile(join(dir, "The book.md"), "utf8")).resolves.toContain('cadrane: "index"');
    await expect(readFile(join(dir, "The book (2).md"), "utf8")).resolves.toContain('cadrane: "party"');
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps both customers when two names sanitise the same", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cadrane-vault-two-"));

    const result = await mirror(
      dir,
      [standing({ partyId: "a", name: "A/B Traders" }), standing({ partyId: "b", name: "A:B Traders" })],
      () => bills,
      739_000
    );

    expect(result.written).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });
});
