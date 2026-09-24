import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityLog, SkillRunResult } from "@cadrane/contracts";
import { Timeline } from "./Timeline.js";

function show(log: ActivityLog | null, details: Readonly<Record<string, SkillRunResult>> = {}): string {
  return renderToStaticMarkup(createElement(Timeline, {
    log, details, busy: false, canGrant: true, onRestore: () => {}, onGrantFolder: () => {}
  }));
}

describe("a missing readable history is not a fresh start", () => {
  it("keeps an actual session result and its restore visible without inventing durable history", () => {
    const result: SkillRunResult = { receiptId: "fictional-r1", headline: "1 change made.", steps: [], canUndo: true,
      undoableUntil: "2999-01-01T00:00:00Z", historyWarning: "The history receipt could not be saved." };
    const html = show({ entries: [], trustworthy: false, integrity: "History unreadable." }, { r1: result });
    expect(html).toContain("Results from this session");
    expect(html).toContain("1 change made.");
    expect(html).toContain("The history receipt could not be saved.");
    expect(html).toContain(">Restore</button>");
    expect(html).toContain("not proof of saved history");
    const expired = show({ entries: [], trustworthy: true, integrity: "Empty." }, { r1: { ...result, undoableUntil: "2000-01-01T00:00:00Z" } });
    expect(expired).not.toContain(">Restore</button>");
    expect(expired).not.toContain("The record starts here");
  });
  it("does not turn a failed integrity check into onboarding or a no-actions claim", () => {
    const html = show({ entries: [], trustworthy: false, integrity: "Entry 1 could not be decrypted." });
    expect(html).toContain("History is unavailable");
    expect(html).toContain("Entry 1 could not be decrypted.");
    expect(html).toContain("does not mean that no actions took place");
    expect(html).not.toContain("The record starts here");
    expect(html).not.toContain("firstrun__steps");
  });

  it("still distinguishes loading and a genuinely verified empty record", () => {
    expect(show(null)).toContain("Reading the record.");
    const html = show({ entries: [], trustworthy: true, integrity: "Nothing has been recorded yet." });
    expect(html).toContain("The record starts here");
    expect(html).not.toContain("History is unavailable");
  });
});
