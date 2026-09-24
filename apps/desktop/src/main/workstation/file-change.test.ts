import { describe, expect, it } from "vitest";
import { compareText, snapshotKey, MAX_DIFF_LINES } from "./file-change.js";

describe("compareText", () => {
  it("reports one addition when inserting one line at the top of a five-line file", () => {
    const before = "one\ntwo\nthree\nfour\nfive";
    const after = "zero\none\ntwo\nthree\nfour\nfive";
    const change = compareText(before, after, "src/index.ts");

    expect(change.kind).toBe("modified");
    expect(change.added).toBe(1);
    expect(change.removed).toBe(0);
    expect(change.summary).toBe("1 line added.");
    expect(change.hunks).toHaveLength(1);

    const hunk = change.hunks[0];
    if (hunk !== undefined) {
      expect(hunk.beforeStart).toBe(1);
      expect(hunk.afterStart).toBe(1);
      expect(hunk.afterLines[0]).toBe("zero");
      expect(hunk.context).toEqual(["one", "two", "three"]);
    }
  });

  it("detects a middle deletion cleanly", () => {
    const before = "alpha\nbeta\ngamma\ndelta\nepsilon";
    const after = "alpha\nbeta\ndelta\nepsilon";
    const change = compareText(before, after, "notes.txt");

    expect(change.kind).toBe("modified");
    expect(change.added).toBe(0);
    expect(change.removed).toBe(1);
    expect(change.summary).toBe("1 line removed.");
    expect(change.hunks).toHaveLength(1);

    const hunk = change.hunks[0];
    if (hunk !== undefined) {
      expect(hunk.beforeStart).toBe(1);
      expect(hunk.afterStart).toBe(1);
      expect(hunk.beforeLines).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
      expect(hunk.afterLines).toEqual(["alpha", "beta", "delta", "epsilon"]);
      expect(hunk.context).toEqual(["alpha", "beta", "delta", "epsilon"]);
    }
  });

  it("detects an in-place edit with singular summary wording", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nline2_modified\nline3";
    const change = compareText(before, after, "config.json");

    expect(change.kind).toBe("modified");
    expect(change.added).toBe(1);
    expect(change.removed).toBe(1);
    expect(change.summary).toBe("1 line added, 1 removed.");
    expect(change.hunks).toHaveLength(1);
  });

  it("detects binary files via NUL bytes without producing hunks", () => {
    const before = "hello\0world";
    const after = "hello\0there";
    const change = compareText(before, after, "asset.bin");

    expect(change.kind).toBe("binary");
    expect(change.added).toBe(0);
    expect(change.removed).toBe(0);
    expect(change.hunks).toHaveLength(0);
    expect(change.summary).toBe("Binary file.");
  });

  it("flags truncation when file length exceeds MAX_DIFF_LINES", () => {
    const manyLinesBefore = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `item_${i}`).join("\n");
    const manyLinesAfter = `${manyLinesBefore}\nextra`;
    const change = compareText(manyLinesBefore, manyLinesAfter, "huge.log");

    expect(change.truncated).toBe(true);
  });

  it("detects changes that consist solely of trailing whitespace", () => {
    const before = "function run() {\n  return 1;\n}";
    const after = "function run() { \n  return 1;\n}";
    const change = compareText(before, after, "code.ts");

    expect(change.kind).toBe("modified");
    expect(change.added).toBe(1);
    expect(change.removed).toBe(1);
    expect(change.summary).toBe("1 line added, 1 removed.");
  });

  it("handles added and removed whole files", () => {
    const addedChange = compareText("", "first\nsecond", "new.txt");
    expect(addedChange.kind).toBe("added");
    expect(addedChange.added).toBe(2);
    expect(addedChange.removed).toBe(0);
    expect(addedChange.summary).toBe("2 lines added.");

    const removedChange = compareText("first\nsecond", "", "deleted.txt");
    expect(removedChange.kind).toBe("removed");
    expect(removedChange.added).toBe(0);
    expect(removedChange.removed).toBe(2);
    expect(removedChange.summary).toBe("2 lines removed.");
  });

  it("returns unchanged when content is identical", () => {
    const content = "stable line 1\nstable line 2";
    const change = compareText(content, content, "same.txt");

    expect(change.kind).toBe("unchanged");
    expect(change.added).toBe(0);
    expect(change.removed).toBe(0);
    expect(change.hunks).toHaveLength(0);
    expect(change.summary).toBe("No changes.");
  });
});

describe("snapshotKey", () => {
  it("produces deterministic and stable keys for identical inputs", () => {
    const key1 = snapshotKey("file content sample");
    const key2 = snapshotKey("file content sample");
    const differentKey = snapshotKey("file content sample altered");

    expect(key1).toBe(key2);
    expect(key1).not.toBe(differentKey);
    expect(typeof key1).toBe("string");
    expect(key1.length).toBeGreaterThan(0);
  });
});
