import { describe, expect, it } from "vitest";
import {
  buildToolLedger,
  MAX_ARGUMENT_SUMMARY_CHARS,
  MAX_LEDGER_ENTRIES,
  type ToolLedgerEntry
} from "./tool-ledger.js";

function makeEntry(overrides: Partial<ToolLedgerEntry> = {}): ToolLedgerEntry {
  return {
    callId: "call-1",
    tool: "rellane_read_source",
    at: 1710000000000,
    outcome: "ran",
    argumentSummary: "source 1",
    resultBytes: 120,
    detail: "",
    ...overrides
  };
}

describe("buildToolLedger", () => {
  it("returns empty receipt text and zeroed rollup for empty input", () => {
    const ledger = buildToolLedger([]);
    expect(ledger.receiptText).toBe("");
    expect(ledger.rollup).toEqual({
      total: 0,
      ran: 0,
      declined: 0,
      refused: 0,
      failed: 0,
      withheld: 0,
      bytesReturned: 0,
      toolsUsed: []
    });
  });

  it("handles one declined call and nothing else", () => {
    const ledger = buildToolLedger([
      makeEntry({
        callId: "call-declined",
        outcome: "declined",
        resultBytes: 0,
        detail: "Declined by owner"
      })
    ]);
    expect(ledger.receiptText).toContain("1 call");
    expect(ledger.receiptText).toContain("1 declined");
    expect(ledger.receiptText).not.toContain("0 ran");
    expect(ledger.rollup.declined).toBe(1);
    expect(ledger.rollup.ran).toBe(0);
    expect(ledger.rollup.total).toBe(1);
  });

  it("renders exactly MAX_LEDGER_ENTRIES lines plus one not listed line when given 70 entries", () => {
    const entries = Array.from({ length: 70 }, (_, i) =>
      makeEntry({
        callId: `call-${i}`,
        tool: "rellane_list_sources",
        at: 1710000000000 + i * 1000,
        outcome: "ran",
        resultBytes: 50
      })
    );
    const ledger = buildToolLedger(entries);
    expect(ledger.rollup.total).toBe(70);

    const lines = ledger.receiptText.split("\n");
    expect(lines.length).toBe(MAX_LEDGER_ENTRIES + 2);
    expect(lines[lines.length - 1]).toBe("6 further calls are not listed.");
  });

  it("keeps duplicate callIds, marks repeats visibly, and counts both in total", () => {
    const ledger = buildToolLedger([
      makeEntry({ callId: "dup-1", at: 1710000000000 }),
      makeEntry({ callId: "dup-1", at: 1710000005000 })
    ]);
    expect(ledger.rollup.total).toBe(2);
    const lines = ledger.receiptText.split("\n");
    expect(lines[1]).not.toContain("[repeat]");
    expect(lines[2]).toContain("[repeat]");
  });

  it("excludes resultBytes on a declined entry from bytesReturned", () => {
    const ledger = buildToolLedger([
      makeEntry({ callId: "c1", outcome: "declined", resultBytes: 2048 }),
      makeEntry({ callId: "c2", outcome: "ran", resultBytes: 512 })
    ]);
    expect(ledger.rollup.bytesReturned).toBe(512);
    expect(ledger.receiptText).toContain("512 characters were read back.");
  });

  it("formats invalid or negative timestamps as --:--:-- without throwing", () => {
    const ledger = buildToolLedger([
      makeEntry({ callId: "c-nan", at: Number.NaN }),
      makeEntry({ callId: "c-neg", at: -1 })
    ]);
    expect(ledger.receiptText).toContain("--:--:--");
    const lines = ledger.receiptText.split("\n");
    expect(lines[1]).toMatch(/^--:--:-- /);
    expect(lines[2]).toMatch(/^--:--:-- /);
  });

  it("truncates an argumentSummary over 200 chars with an ellipsis", () => {
    const longSummary = "a".repeat(500);
    const ledger = buildToolLedger([
      makeEntry({ argumentSummary: longSummary })
    ]);
    const expected = `${"a".repeat(MAX_ARGUMENT_SUMMARY_CHARS)}…`;
    expect(ledger.receiptText).toContain(expected);
    expect(ledger.receiptText).not.toContain("a".repeat(201));
  });

  it("excludes a tool from toolsUsed that only ever failed or was refused", () => {
    const ledger = buildToolLedger([
      makeEntry({ tool: "tool_failed", outcome: "failed" }),
      makeEntry({ tool: "tool_refused", outcome: "refused" }),
      makeEntry({ tool: "tool_ran", outcome: "ran" })
    ]);
    expect(ledger.rollup.toolsUsed).toEqual(["tool_ran"]);
  });

  it("formats UTC timestamps from milliseconds since epoch", () => {
    const ledger = buildToolLedger([
      makeEntry({ at: Date.UTC(2024, 2, 9, 17, 20, 0) })
    ]);
    expect(ledger.receiptText).toContain("17:20:00");
  });
});
