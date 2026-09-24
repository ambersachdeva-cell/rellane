import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox } from "../tools/sandbox.js";
import { execute, releaseUndo, undo } from "../tools/executor.js";
import { LIST_FOLDER } from "../tools/registry.js";
import { summarise } from "../tools/receipt.js";
import {
  categoryFor,
  CATEGORIES,
  describeSurvey,
  planFrom,
  survey,
  type FileEntry
} from "./librarian.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-08-21T12:00:00.000Z");

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  return {
    name,
    path: `/root/${name}`,
    kind: "file",
    extension: ext,
    bytes: 1024,
    modified: new Date(NOW - 5 * HOUR).toISOString(),
    ...over
  };
}

describe("the extension table", () => {
  // The table is generated, so these are the only two ways it can be wrong:
  // an entry that is not a real extension, or one claimed by two categories.
  it("has no malformed entries", () => {
    for (const category of CATEGORIES) {
      for (const extension of category.extensions) {
        expect(extension).toMatch(/^\.[a-z0-9_+-]{1,10}$/u);
      }
    }
  });

  it("gives every extension exactly one home", () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const category of CATEGORIES) {
      for (const extension of category.extensions) {
        const previous = owner.get(extension);
        if (previous !== undefined && previous !== category.id) {
          clashes.push(`${extension}: ${previous} and ${category.id}`);
        }
        owner.set(extension, category.id);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("covers enough of a real Downloads folder to be useful", () => {
    // A file it cannot place is a file it leaves behind, so breadth is the
    // feature. A short list is how a tidying tool quietly does nothing.
    const total = CATEGORIES.reduce((sum, c) => sum + c.extensions.length, 0);
    expect(total).toBeGreaterThan(150);
    for (const common of [".pdf", ".csv", ".png", ".ai", ".zip", ".mp4", ".ts", ".dmg"]) {
      expect(categoryFor(common)).not.toBeNull();
    }
  });
});

describe("deciding what goes where", () => {
  it("files by extension", () => {
    expect(categoryFor(".pdf")?.folder).toBe("Documents");
    expect(categoryFor(".AI")?.folder).toBe("Artwork");
    expect(categoryFor(".csv")?.folder).toBe("Spreadsheets");
    expect(categoryFor(".wat")).toBeNull();
  });

  it("proposes a destination for each loose file", () => {
    const result = survey("/root", [entry("invoice.pdf"), entry("logo.ai")], { now: NOW });
    expect(result.proposals.map((p) => p.category.folder)).toEqual(["Documents", "Artwork"]);
    expect(result.proposals[0]?.destination).toBe("/root/Documents");
  });

  it("leaves folders alone", () => {
    const result = survey("/root", [entry("Projects", { kind: "folder", extension: "" })], { now: NOW });
    expect(result.proposals).toHaveLength(0);
    expect(result.untouched[0]?.reason).toMatch(/Folders are left alone/u);
  });

  it("does not nest the folders it files into", () => {
    const result = survey("/root", [entry("Documents", { kind: "folder", extension: "" })], { now: NOW });
    expect(result.untouched[0]?.reason).toMatch(/Already one of the folders/u);
  });

  it("leaves anything saved in the last hour", () => {
    const fresh = entry("wip.pdf", { modified: new Date(NOW - 5 * 60_000).toISOString() });
    const result = survey("/root", [fresh], { now: NOW });
    expect(result.proposals).toHaveLength(0);
    expect(result.untouched[0]?.reason).toMatch(/still in use/u);
  });

  it("says why it skipped something rather than dropping it", () => {
    const result = survey("/root", [entry("mystery.wat"), entry("noext")], { now: NOW });
    expect(result.untouched).toHaveLength(2);
    expect(result.untouched.map((u) => u.reason)).toEqual([
      "Nothing is filed by .wat yet.",
      "No file extension, so there is nothing to go on yet."
    ]);
  });

  it("describes the plan in one sentence before anything happens", () => {
    const result = survey("/root", [entry("a.pdf"), entry("b.pdf"), entry("c.wat")], { now: NOW });
    expect(describeSurvey(result)).toBe("Move 2 files into 1 folder, leaving 1 alone.");
    expect(describeSurvey(survey("/root", [], { now: NOW }))).toBe("That folder is empty.");
  });

  it("counts in the singular when there is one of something", () => {
    // "Move 1 files" is the cheapest possible signal that nobody read the
    // screen, and it appears directly above a button that changes the folder.
    const one = survey("/root", [entry("a.pdf")], { now: NOW });
    expect(describeSurvey(one)).toBe("Move 1 file into 1 folder.");

    const nothingToDo = survey("/root", [entry("mystery.wat")], { now: NOW });
    expect(describeSurvey(nothingToDo)).toBe(
      "Nothing to file — the one item here is already where it should be."
    );
  });
});

describe("end to end, on real files", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cadrane-librarian-"));
    const old = new Date(Date.now() - 5 * HOUR);
    for (const name of ["invoice.pdf", "quote.pdf", "logo.ai", "rates.csv", "notes.wat"]) {
      const file = join(root, name);
      await writeFile(file, name);
      await utimes(file, old, old);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("files real files, then puts them all back", async () => {
    const sandbox = await createSandbox([root]);
    const context = { sandbox };

    // 1. Look at the folder through the real tool.
    const listing = (await LIST_FOLDER.handler({ path: root }, context)) as {
      files: FileEntry[];
    };
    expect(listing.files).toHaveLength(5);

    // 2. Decide, and say so before touching anything.
    const decided = survey(root, listing.files);
    expect(describeSurvey(decided)).toBe("Move 4 files into 3 folders, leaving 1 alone.");
    expect(await readdir(root)).toHaveLength(5);

    // 3. Run it.
    const plan = planFrom(decided, root, Date.now());
    const { receipt, snapshots } = await execute({
      plan,
      policy: { byRisk: { read: "auto", write: "auto" } },
      context,
      protect: [root],
      approve: async () => true
    });

    expect(summarise(receipt)).toBe("4 done");
    expect((await readdir(join(root, "Documents"))).sort()).toEqual(["invoice.pdf", "quote.pdf"]);
    expect(await readdir(join(root, "Artwork"))).toEqual(["logo.ai"]);
    expect(await readdir(join(root, "Spreadsheets"))).toEqual(["rates.csv"]);
    // The one it could not classify is exactly where it was left.
    await expect(stat(join(root, "notes.wat"))).resolves.toBeTruthy();

    // 4. Undo puts the folder back as it was.
    await undo(snapshots);
    expect((await readdir(root)).sort()).toEqual([
      "invoice.pdf",
      "logo.ai",
      "notes.wat",
      "quote.pdf",
      "rates.csv"
    ]);
    await releaseUndo(snapshots);
  }, 30_000);

  it("moves nothing when the skill may only read", async () => {
    const sandbox = await createSandbox([root]);
    const context = { sandbox };
    const listing = (await LIST_FOLDER.handler({ path: root }, context)) as { files: FileEntry[] };
    const plan = planFrom(survey(root, listing.files), root, Date.now());

    const { receipt } = await execute({
      plan,
      policy: { byRisk: { read: "auto" } },
      context,
      protect: [root],
      approve: async () => true
    });

    expect(summarise(receipt)).toBe("4 not allowed");
    expect((await readdir(root)).sort()).toHaveLength(5);
  }, 30_000);

  it("records a step the user declined without abandoning the rest", async () => {
    const sandbox = await createSandbox([root]);
    const context = { sandbox };
    const listing = (await LIST_FOLDER.handler({ path: root }, context)) as { files: FileEntry[] };
    const plan = planFrom(survey(root, listing.files), root, Date.now());

    let asked = 0;
    const { receipt, snapshots } = await execute({
      plan,
      // "confirm" makes every write ask.
      policy: { byRisk: { read: "auto", write: "confirm" } },
      context,
      protect: [root],
      approve: async () => {
        asked += 1;
        return asked !== 1; // decline the first, allow the rest
      }
    });

    expect(asked).toBe(4);
    expect(summarise(receipt)).toBe("3 done · 1 not allowed");
    await releaseUndo(snapshots);
  }, 30_000);

  it("refuses to move a file outside the folder it was granted", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "cadrane-elsewhere-"));
    try {
      const sandbox = await createSandbox([root]);
      const plan = planFrom(
        {
          proposals: [
            {
              file: entry("invoice.pdf", { path: join(root, "invoice.pdf") }),
              category: { id: "x", folder: "X", extensions: [] },
              destination: elsewhere
            }
          ],
          untouched: []
        },
        root,
        Date.now()
      );

      const { receipt } = await execute({
        plan,
        policy: { byRisk: { read: "auto", write: "auto" } },
        context: { sandbox },
        protect: [root],
        approve: async () => true
      });

      expect(receipt.steps[0]?.outcome).toBe("failed");
      expect(receipt.steps[0]?.error).toMatch(/outside every folder/u);
      await expect(stat(join(root, "invoice.pdf"))).resolves.toBeTruthy();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);

  it("never overwrites a file that is already there", async () => {
    await mkdir(join(root, "Documents"));
    await writeFile(join(root, "Documents", "invoice.pdf"), "the real one");

    const sandbox = await createSandbox([root]);
    const context = { sandbox };
    const listing = (await LIST_FOLDER.handler({ path: root }, context)) as { files: FileEntry[] };
    const plan = planFrom(survey(root, listing.files), root, Date.now());

    const { receipt, snapshots } = await execute({
      plan,
      policy: { byRisk: { read: "auto", write: "auto" } },
      context,
      protect: [root],
      approve: async () => true
    });

    const clash = receipt.steps.find((step) => step.summary.startsWith("invoice.pdf"));
    expect(clash?.outcome).toBe("failed");
    expect(clash?.error).toMatch(/already exists/u);
    // The existing file is untouched.
    await expect(stat(join(root, "Documents", "invoice.pdf"))).resolves.toBeTruthy();
    await releaseUndo(snapshots);
  }, 30_000);
});
