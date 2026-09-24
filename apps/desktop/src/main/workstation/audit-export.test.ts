import { describe, expect, it } from "vitest";
import {
  buildAuditDocument,
  MAX_BODY_CHARS,
  MAX_ENTRIES,
  type TrailTurn
} from "./audit-export.js";

describe("buildAuditDocument", () => {
  it("orders turns chronologically by timestamp regardless of input order", () => {
    const turns: readonly TrailTurn[] = [
      { id: "3", seat: "codex", kind: "response", body: "Third event", at: 1_700_000_030_000 },
      { id: "1", seat: "user", kind: "prompt", body: "First event", at: 1_700_000_010_000 },
      { id: "2", seat: "rellane", kind: "record", body: "Second event", at: 1_700_000_020_000 }
    ];
    const doc = buildAuditDocument("Timeline Test", turns);

    expect(doc.entryCount).toBe(3);
    const firstPos = doc.markdown.indexOf("First event");
    const secondPos = doc.markdown.indexOf("Second event");
    const thirdPos = doc.markdown.indexOf("Third event");

    expect(firstPos).toBeGreaterThan(-1);
    expect(secondPos).toBeGreaterThan(firstPos);
    expect(thirdPos).toBeGreaterThan(secondPos);
  });

  it("counts and labels an approval receipt clearly", () => {
    const turns: readonly TrailTurn[] = [
      { id: "1", seat: "user", kind: "prompt", body: "Please run the migration", at: 1_700_000_000_000 },
      { id: "2", seat: "user", kind: "approval", body: "Approved running db migration", at: 1_700_000_001_000 },
      { id: "3", seat: "rellane", kind: "tool_call", body: "Ran tool migrate_db", at: 1_700_000_002_000 }
    ];
    const doc = buildAuditDocument("Migration Work", turns);

    expect(doc.approvals).toBe(1);
    expect(doc.toolCalls).toBe(1);
    expect(doc.entryCount).toBe(3);
    expect(doc.markdown).toContain("Record of 3 entries: 1 approval, 1 tool call.");
    expect(doc.markdown).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} — You — Approval/);
  });

  it("cuts a body exceeding MAX_BODY_CHARS and marks the truncation visibly", () => {
    const hugeBody = "X".repeat(MAX_BODY_CHARS + 250);
    const turns: readonly TrailTurn[] = [
      { id: "1", seat: "codex", kind: "response", body: hugeBody, at: 1_700_000_000_000 }
    ];
    const doc = buildAuditDocument("Cap Test", turns);

    expect(doc.markdown).toContain("X".repeat(MAX_BODY_CHARS));
    expect(doc.markdown).not.toContain("X".repeat(MAX_BODY_CHARS + 1));
    expect(doc.markdown).toContain("[Truncated: body exceeded 4,000 characters]");
  });

  it("sets truncated and reports the count of omitted entries when exceeding MAX_ENTRIES", () => {
    const excessCount = 12;
    const turns: TrailTurn[] = [];
    for (let i = 0; i < MAX_ENTRIES + excessCount; i++) {
      turns.push({
        id: `turn-${i}`,
        seat: "rellane",
        kind: "record",
        body: `Log entry ${i}`,
        at: 1_700_000_000_000 + i * 1_000
      });
    }

    const doc = buildAuditDocument("Over Limit Test", turns);

    expect(doc.truncated).toBe(true);
    expect(doc.entryCount).toBe(MAX_ENTRIES);
    expect(doc.markdown).toContain(`${excessCount} left out`);
    expect(doc.markdown).toContain("Log entry 0");
    expect(doc.markdown).toContain(`Log entry ${MAX_ENTRIES - 1}`);
    expect(doc.markdown).not.toContain(`Log entry ${MAX_ENTRIES}`);
  });

  it("safely fences a body containing code blocks with triple backticks", () => {
    const codeSnippet = "Here is the implementation:\n```typescript\nconst total: number = 42;\n```\nIt works.";
    const turns: readonly TrailTurn[] = [
      { id: "1", seat: "codex", kind: "response", body: codeSnippet, at: 1_700_000_000_000 }
    ];
    const doc = buildAuditDocument("Code Fence Test", turns);

    expect(doc.markdown).toContain("````\n" + codeSnippet + "\n````");
  });

  it("produces a valid document stating nothing is recorded yet for empty input", () => {
    const doc = buildAuditDocument("Empty Case", []);

    expect(doc.title).toBe("Empty Case");
    expect(doc.entryCount).toBe(0);
    expect(doc.approvals).toBe(0);
    expect(doc.toolCalls).toBe(0);
    expect(doc.truncated).toBe(false);
    expect(doc.markdown).toBe("# Empty Case\n\nThere is nothing recorded yet.\n");
  });
});
