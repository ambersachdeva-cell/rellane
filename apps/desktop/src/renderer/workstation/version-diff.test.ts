import { describe, expect, it } from "vitest";
import { diffVersions, MAX_DIFF_LINES } from "./version-diff.js";

describe("diffVersions", () => {
  it("reports identical texts with identical: true and no added or removed lines", () => {
    const text = "Alpha\nBeta\nGamma";
    const diff = diffVersions(text, text);
    expect(diff.identical).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.truncated).toBe(false);
    expect(diff.lines).toHaveLength(3);
    expect(diff.lines.every(line => line.kind === "same")).toBe(true);
    expect(diff.lines[0]).toEqual({ kind: "same", text: "Alpha", beforeLine: 1, afterLine: 1 });
    expect(diff.lines[1]).toEqual({ kind: "same", text: "Beta", beforeLine: 2, afterLine: 2 });
    expect(diff.lines[2]).toEqual({ kind: "same", text: "Gamma", beforeLine: 3, afterLine: 3 });
  });

  it("handles empty texts as identical with no lines", () => {
    const diff = diffVersions("", "");
    expect(diff.identical).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.truncated).toBe(false);
    expect(diff.lines).toEqual([]);
  });

  it("detects an insertion at the top of a 5-line document without shifting subsequent lines", () => {
    const before = "one\ntwo\nthree\nfour\nfive";
    const after = "intro\none\ntwo\nthree\nfour\nfive";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.truncated).toBe(false);
    expect(diff.lines).toHaveLength(6);
    expect(diff.lines[0]).toEqual({ kind: "added", text: "intro", beforeLine: null, afterLine: 1 });
    expect(diff.lines[1]).toEqual({ kind: "same", text: "one", beforeLine: 1, afterLine: 2 });
    expect(diff.lines[2]).toEqual({ kind: "same", text: "two", beforeLine: 2, afterLine: 3 });
    expect(diff.lines[3]).toEqual({ kind: "same", text: "three", beforeLine: 3, afterLine: 4 });
    expect(diff.lines[4]).toEqual({ kind: "same", text: "four", beforeLine: 4, afterLine: 5 });
    expect(diff.lines[5]).toEqual({ kind: "same", text: "five", beforeLine: 5, afterLine: 6 });
  });

  it("detects a line deleted from the middle with surrounding lines unchanged", () => {
    const before = "header\nmiddle\nfooter";
    const after = "header\nfooter";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toHaveLength(3);
    expect(diff.lines[0]).toEqual({ kind: "same", text: "header", beforeLine: 1, afterLine: 1 });
    expect(diff.lines[1]).toEqual({ kind: "removed", text: "middle", beforeLine: 2, afterLine: null });
    expect(diff.lines[2]).toEqual({ kind: "same", text: "footer", beforeLine: 3, afterLine: 2 });
  });

  it("reports a line edited in place with removal listed before addition", () => {
    const before = "first\nold value\nthird";
    const after = "first\nnew value\nthird";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toHaveLength(4);
    expect(diff.lines[0]).toEqual({ kind: "same", text: "first", beforeLine: 1, afterLine: 1 });
    expect(diff.lines[1]).toEqual({ kind: "removed", text: "old value", beforeLine: 2, afterLine: null });
    expect(diff.lines[2]).toEqual({ kind: "added", text: "new value", beforeLine: null, afterLine: 2 });
    expect(diff.lines[3]).toEqual({ kind: "same", text: "third", beforeLine: 3, afterLine: 3 });
  });

  it("reports multiple lines edited in place with all removals before additions", () => {
    const before = "prefix\nold A\nold B\nsuffix";
    const after = "prefix\nnew A\nnew B\nsuffix";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
    expect(diff.lines).toHaveLength(6);
    expect(diff.lines[0]).toEqual({ kind: "same", text: "prefix", beforeLine: 1, afterLine: 1 });
    expect(diff.lines[1]).toEqual({ kind: "removed", text: "old A", beforeLine: 2, afterLine: null });
    expect(diff.lines[2]).toEqual({ kind: "removed", text: "old B", beforeLine: 3, afterLine: null });
    expect(diff.lines[3]).toEqual({ kind: "added", text: "new A", beforeLine: null, afterLine: 2 });
    expect(diff.lines[4]).toEqual({ kind: "added", text: "new B", beforeLine: null, afterLine: 3 });
    expect(diff.lines[5]).toEqual({ kind: "same", text: "suffix", beforeLine: 4, afterLine: 4 });
  });

  it("reports empty before and non-empty after as every line added with null beforeLine", () => {
    const before = "";
    const after = "title\nparagraph";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
    expect(diff.lines).toHaveLength(2);
    expect(diff.lines.every(l => l.kind === "added" && l.beforeLine === null)).toBe(true);
    expect(diff.lines[0]).toEqual({ kind: "added", text: "title", beforeLine: null, afterLine: 1 });
    expect(diff.lines[1]).toEqual({ kind: "added", text: "paragraph", beforeLine: null, afterLine: 2 });
  });

  it("reports non-empty before and empty after as every line removed with null afterLine", () => {
    const before = "title\nparagraph";
    const after = "";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(2);
    expect(diff.lines).toHaveLength(2);
    expect(diff.lines.every(l => l.kind === "removed" && l.afterLine === null)).toBe(true);
    expect(diff.lines[0]).toEqual({ kind: "removed", text: "title", beforeLine: 1, afterLine: null });
    expect(diff.lines[1]).toEqual({ kind: "removed", text: "paragraph", beforeLine: 2, afterLine: null });
  });

  it("reports trailing whitespace differences as changes rather than same", () => {
    const before = "const a = 1;  ";
    const after = "const a = 1;";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toHaveLength(2);
    expect(diff.lines[0]).toEqual({ kind: "removed", text: "const a = 1;  ", beforeLine: 1, afterLine: null });
    expect(diff.lines[1]).toEqual({ kind: "added", text: "const a = 1;", beforeLine: null, afterLine: 1 });
  });

  it("reports indentation differences as changes", () => {
    const before = "    function run() {}";
    const after = "  function run() {}";
    const diff = diffVersions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines[0]).toEqual({ kind: "removed", text: "    function run() {}", beforeLine: 1, afterLine: null });
    expect(diff.lines[1]).toEqual({ kind: "added", text: "  function run() {}", beforeLine: null, afterLine: 1 });
  });

  it("sets truncated: true and considers no more than MAX_DIFF_LINES lines when text exceeds limit", () => {
    const totalLines = MAX_DIFF_LINES + 50;
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (let i = 0; i < totalLines; i++) {
      beforeLines.push(`Row ${i + 1}`);
      afterLines.push(i === 0 ? "Modified Row 1" : `Row ${i + 1}`);
    }
    const before = beforeLines.join("\n");
    const after = afterLines.join("\n");
    const diff = diffVersions(before, after);

    expect(diff.truncated).toBe(true);
    for (const line of diff.lines) {
      if (line.beforeLine !== null) {
        expect(line.beforeLine).toBeLessThanOrEqual(MAX_DIFF_LINES);
      }
      if (line.afterLine !== null) {
        expect(line.afterLine).toBeLessThanOrEqual(MAX_DIFF_LINES);
      }
    }
  });
});
