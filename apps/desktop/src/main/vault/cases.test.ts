/**
 * A case has to survive Rellane being deleted, like everything else here.
 *
 * The party pages were the easy half — figures written down stay figures. A case
 * is a conversation, and the vault's promise only holds if the *reasoning* comes
 * out too: what was decided, and who said what on the way to deciding it.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { casePage, mirrorCases } from "./write.js";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "cadrane-vault-cases-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const OPEN = {
  id: "c1",
  title: "Sharma quote",
  question: "Why is the revised quote ₹4,000 out?",
  openedAt: Date.UTC(2026, 8, 5),
  closedAt: null,
  closedAs: null,
  verdict: null
};

const SETTLED = {
  ...OPEN,
  closedAt: Date.UTC(2026, 8, 6),
  closedAs: "settled",
  verdict: "CGST and SGST were both applied to the whole subtotal."
};

const TURNS = [
  {
    seat: "owner",
    kind: "verbatim",
    body: "Why is the revised quote ₹4,000 out?",
    at: Date.UTC(2026, 8, 5),
    compactedFrom: null
  },
  {
    seat: "builder",
    kind: "verbatim",
    body: "Line three carries tax twice.",
    at: Date.UTC(2026, 8, 5),
    compactedFrom: null
  },
  {
    seat: "qwen3-4b",
    kind: "compacted",
    body: "They checked each line and found the tax.",
    at: Date.UTC(2026, 8, 6),
    compactedFrom: ["t1", "t2", "t3"]
  }
];

describe("a case as a page somebody can read without us", () => {
  it("puts the verdict above the transcript", () => {
    const page = casePage(SETTLED, TURNS);
    // A reader already persuaded does not revise on a footnote (D-084).
    expect(page.indexOf("Verdict.")).toBeLessThan(page.indexOf("## The room"));
    expect(page).toContain("CGST and SGST were both applied");
  });

  it("says a case is still open rather than inventing a verdict", () => {
    expect(casePage(OPEN, TURNS)).toContain("Still open.");
  });

  it("keeps who said what, because the reasoning is the point", () => {
    const page = casePage(SETTLED, TURNS);
    expect(page).toContain("### You");
    expect(page).toContain("### builder");
    expect(page).toContain("Line three carries tax twice.");
  });

  it("labels a summary as a summary, in the file", () => {
    // Rellane may be long gone when somebody reads this folder. They still have
    // to be able to tell what was said from what a model said about it.
    expect(casePage(SETTLED, TURNS)).toContain("_(summary of 3 earlier turns)_");
  });

  it("carries frontmatter Obsidian reads and plain text degrades to", () => {
    const page = casePage(SETTLED, TURNS);
    expect(page.startsWith("---\n")).toBe(true);
    expect(page).toContain('cadrane: "case"');
    expect(page).toContain("[[The book]]");
  });
});

describe("mirroring a folder of cases", () => {
  it("writes one page per case, in its own folder", async () => {
    const result = await mirrorCases(folder, [SETTLED], () => TURNS);

    expect(result.written).toBe(1);
    expect(await readdir(join(folder, "Cases"))).toEqual(["Sharma quote.md"]);
    expect(await readFile(join(folder, "Cases", "Sharma quote.md"), "utf8"))
      .toContain("Line three carries tax twice.");
  });

  it("does not let two cases with one title overwrite each other", async () => {
    const twin = { ...SETTLED, id: "c2" };
    const result = await mirrorCases(folder, [SETTLED, twin], () => TURNS);

    expect(result.written).toBe(2);
    expect((await readdir(join(folder, "Cases"))).sort())
      .toEqual(["Sharma quote (2).md", "Sharma quote.md"]);
  });

  it("removes the page of a case that has been erased", async () => {
    await mirrorCases(folder, [SETTLED], () => TURNS);
    // Erasure that misses a copy is not erasure, and this folder is the copy
    // most likely to be forgotten.
    const second = await mirrorCases(folder, [], () => []);

    expect(second.removed).toBe(1);
    expect(await readdir(join(folder, "Cases"))).toEqual([]);
  });

  it("leaves a file the owner put there alone if it is not a case page", async () => {
    await mirrorCases(folder, [SETTLED], () => TURNS);
    await writeFile(join(folder, "Cases", "my own notes.txt"), "mine", "utf8");

    await mirrorCases(folder, [SETTLED], () => TURNS);
    expect((await readdir(join(folder, "Cases"))).sort())
      .toEqual(["Sharma quote.md", "my own notes.txt"]);
  });
});
