import type { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBook } from "../book/database.js";
import { addInvoice, addParty, outstanding } from "../book/records.js";
import { syncVault } from "./sync.js";

let db: DatabaseSync;
let home: string;
let dir: string;
let partyId: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cadrane-vault-sync-"));
  db = (await openBook(join(home, "book.sqlite"))).db;
  dir = join(home, "Vault");
  partyId = addParty(db, { name: "Devgiri Traders", phone: "+919876543210" });
  addInvoice(db, {
    partyId,
    number: "A-114",
    issuedOn: Date.parse("2026-08-01"),
    subtotalPaise: 800_000,
    totalPaise: 944_000
  });
});

afterEach(async () => {
  db.close();
  await rm(home, { recursive: true, force: true });
});

const page = () => readFile(join(dir, "Devgiri Traders.md"), "utf8");

describe("a note typed into the markdown", () => {
  it("reaches the book, and is still in the file afterwards", async () => {
    // The failure this guards is the one that ends trust in a folder: the owner
    // writes a sentence, the mirror runs, and their sentence is gone.
    await syncVault(db, dir);
    await writeFile(
      join(dir, "Devgiri Traders.md"),
      (await page()).replace("## Bills", "Agreed 45 days from October. Ring Rakesh.\n\n## Bills")
    );

    const result = await syncVault(db, dir);

    expect(result.notesFound).toBe(1);
    expect(result.notesSaved).toBe(1);
    const party = outstanding(db).find((row) => row.partyId === partyId);
    expect(party?.note).toBe("Agreed 45 days from October. Ring Rakesh.");
    expect(await page()).toContain("Agreed 45 days from October. Ring Rakesh.");
  });

  it("settles: syncing again changes nothing", async () => {
    // Written verbatim and read back whole, so the second pass is a no-op. This
    // is what makes it safe to run on a schedule rather than only by hand.
    await syncVault(db, dir);
    await writeFile(
      join(dir, "Devgiri Traders.md"),
      (await page()).replace("## Bills", "Prefers a call.\n\n## Bills")
    );
    await syncVault(db, dir);
    const settled = await page();

    const again = await syncVault(db, dir);

    expect(again.notesSaved).toBe(0);
    expect(await page()).toBe(settled);
  });
});

describe("an amount typed into the markdown", () => {
  it("is ignored — the book keeps its own figure", async () => {
    // The ruling, as a test (D-061). Two authorities that can silently disagree
    // is worse than one that is occasionally inconvenient.
    await syncVault(db, dir);
    await writeFile(
      join(dir, "Devgiri Traders.md"),
      (await page()).replace("owed_paise: 944000", "owed_paise: 1").replace("₹9,440", "₹1")
    );

    await syncVault(db, dir);

    expect(outstanding(db).find((row) => row.partyId === partyId)?.owedPaise).toBe(944_000);
    expect(await page()).toContain("owed_paise: 944000");
  });
});

describe("a page from before the id was stamped", () => {
  it("is left alone rather than guessed at", async () => {
    await syncVault(db, dir);
    const body = (await page())
      .replace(/^id: .*\n/mu, "")
      .replace("## Bills", "An old note.\n\n## Bills");
    await writeFile(join(dir, "Devgiri Traders.md"), body);

    const result = await syncVault(db, dir);

    expect(result.notesFound).toBe(0);
    expect(outstanding(db).find((row) => row.partyId === partyId)?.note).toBeNull();
  });
});
