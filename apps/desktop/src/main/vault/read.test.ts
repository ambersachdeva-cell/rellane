import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frontmatterValue, noteFrom, readNotes } from "./read.js";
import { mirror, partyPage } from "./write.js";
import type { Standing } from "../book/records.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-vault-read-"));
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

const bills = [{ number: "A-114", issuedOn: Date.parse("2026-07-20T12:00:00"), totalPaise: 944_000 }];

describe("a page with nothing added", () => {
  it("yields no note, so writing then reading changes nothing", async () => {
    // The round-trip that must be a no-op. If our own output came back as a
    // note, every write would grow the page a copy of itself.
    await mirror(dir, [standing()], () => bills, 739_000);

    expect(await readNotes(dir)).toEqual([]);
  });

  it("recognises every line the writer emits", () => {
    expect(noteFrom(partyPage(standing(), bills))).toBe("");
    expect(noteFrom(partyPage(standing({ owedPaise: 0, openBills: 0 }), []))).toBe("");
    expect(noteFrom(partyPage(standing({ owedPaise: -500 }), []))).toBe("");
  });
});

describe("prose the owner added", () => {
  it("comes back", async () => {
    await mirror(dir, [standing()], () => bills, 739_000);
    const file = join(dir, "Devgiri Traders.md");
    const body = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
    await writeFile(
      file,
      body.replace("## Bills", "Agreed 45 days from October. Ring Rakesh, not the office.\n\n## Bills")
    );

    const [note] = await readNotes(dir);

    expect(note?.partyName).toBe("Devgiri Traders");
    expect(note?.note).toBe("Agreed 45 days from October. Ring Rakesh, not the office.");
  });

  it("survives being written between our own lines", () => {
    const page = partyPage(standing(), bills).replace(
      "## Bills",
      "He prefers a call to a message.\n\n## Bills"
    );

    expect(noteFrom(page)).toBe("He prefers a call to a message.");
  });
});

describe("what never comes back", () => {
  it("returns prose, and has no way to return a figure", async () => {
    // The safety argument, stated as a test: a number edited in a text file
    // must not be able to reach a balance, because then the book would have two
    // authorities that can silently disagree.
    await mirror(dir, [standing()], () => bills, 739_000);
    const file = join(dir, "Devgiri Traders.md");
    const body = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
    await writeFile(file, body.replace("owed_paise: 739000", "owed_paise: 1"));

    const [note] = await readNotes(dir);

    // Nothing came back at all — an edited amount is simply not something this
    // function can express.
    expect(note).toBeUndefined();
    // And the shape it returns has no numeric field to carry one.
    expect(Object.keys((await readNotes(dir))[0] ?? { file: "", partyName: "", note: "" })).toEqual(
      expect.not.arrayContaining(["paise", "amount", "owed"])
    );
  });

  it("ignores a file Rellane did not write", async () => {
    // Somebody's own separate notes are theirs. Hoovering them into the book
    // would be reading something they never offered.
    await writeFile(join(dir, "My own thoughts.md"), "buy more angle iron");

    expect(await readNotes(dir)).toEqual([]);
  });

  it("ignores the index page, which is ours entirely", async () => {
    await mirror(dir, [standing()], () => bills, 739_000);

    expect((await readNotes(dir)).map((note) => note.file)).not.toContain("The book.md");
  });
});

describe("things a real vault does that a clean one does not", () => {
  it("keeps a note written below our footer", async () => {
    // Writing underneath is exactly what somebody does when they add to a page
    // that already ends in a signature. Slicing at the footer threw it away.
    await mirror(dir, [standing()], () => bills, 739_000);
    const file = join(dir, "Devgiri Traders.md");
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, `${await fs.readFile(file, "utf8")}\nHe rang about the angle iron.\n`);

    expect((await readNotes(dir))[0]?.note).toBe("He rang about the angle iron.");
  });

  it("survives Windows line endings", () => {
    // A vault synced through iCloud or edited on another machine comes back
    // CRLF. A reader that only knows \n decides the file has no frontmatter,
    // after which the whole document — amounts included — reads as prose.
    const page = partyPage(standing(), bills)
      .replace("## Bills", "Ring Rakesh.\n\n## Bills")
      .replace(/\n/gu, "\r\n");

    expect(frontmatterValue(page, "name")).toBe("Devgiri Traders");
    expect(noteFrom(page)).toBe("Ring Rakesh.");
    expect(noteFrom(page)).not.toContain("owed_paise");
  });

  it("ignores a stranger's file that merely mentions us", async () => {
    // The frontmatter search used to run over the whole document, so any file
    // containing this line anywhere was read as one of ours.
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      join(dir, "My own notes.md"),
      'Reminder to check what cadrane: "party" means in that export.\n\nBuy more angle iron.'
    );

    expect(await readNotes(dir)).toEqual([]);
  });

  it("does not put a stray rule at the top of somebody's note", () => {
    // In markdown a `---` under a line turns that line into a heading, so a
    // kept rule silently reformats the note it precedes.
    const page = partyPage(standing(), bills).replace("## Bills", "A note.\n\n## Bills");

    expect(noteFrom(page).startsWith("---")).toBe(false);
    expect(noteFrom(page)).toBe("A note.");
  });
});

describe("reading the frontmatter", () => {
  it("takes a quoted value without needing a YAML parser", () => {
    const body = '---\ncadrane: "party"\nname: "A: B"\n---\n# x';

    expect(frontmatterValue(body, "cadrane")).toBe("party");
    // A colon in a customer's name is why the writer quotes these.
    expect(frontmatterValue(body, "name")).toBe("A: B");
    expect(frontmatterValue(body, "missing")).toBeNull();
    // A name carrying its own quotes. The writer escapes it with
    // JSON.stringify, so the reader parses it back — the only exact inverse.
    const quoted = `---\nname: ${JSON.stringify('Acme "Widgets" Ltd')}\n---\n`;
    expect(frontmatterValue(quoted, "name")).toBe('Acme "Widgets" Ltd');
  });
});
