import { describe, expect, it } from "vitest";
import {
  buildHandoffBrief,
  ELISION_MARKER,
  HANDOFF_BUDGET_CHARS,
  type TurnLike
} from "./handoff-brief.js";

describe("buildHandoffBrief", () => {
  it("returns an empty brief with trimmed false on empty input", () => {
    const brief = buildHandoffBrief([]);
    expect(brief.text).toBe("");
    expect(brief.evidence).toEqual([]);
    expect(brief.chars).toBe(0);
    expect(brief.trimmed).toBe(false);
  });

  it("returns an empty brief when given receipts and host bookkeeping only", () => {
    const turns: TurnLike[] = [
      { id: "r1", seat: "system", kind: "receipt", body: "Session checkpoint recorded" },
      { id: "p1", seat: "host", kind: "permission", body: "File read permission decided" },
      { id: "a1", seat: "host", kind: "activity", body: "Searching directory hierarchy" }
    ];
    const brief = buildHandoffBrief(turns);
    expect(brief.text).toBe("");
    expect(brief.evidence).toEqual([]);
    expect(brief.chars).toBe(0);
    expect(brief.trimmed).toBe(false);
  });

  it("never includes turns listed in excludeSourceIds in text or evidence", () => {
    const turns: TurnLike[] = [
      { id: "req1", seat: "Owner", kind: "verbatim", body: "Design user session architecture" },
      { id: "src1", seat: "Codex", kind: "answer", body: "Detailed schema proposal in session.sql" },
      { id: "ans2", seat: "Claude", kind: "answer", body: "Refined token validation rules" }
    ];
    const brief = buildHandoffBrief(turns, { excludeSourceIds: ["src1"] });
    expect(brief.evidence).not.toContain("src1");
    expect(brief.text).not.toContain("session.sql");
    expect(brief.evidence).toEqual(["req1", "ans2"]);
    expect(brief.text).toContain("Design user session architecture");
    expect(brief.text).toContain("Refined token validation rules");
  });

  it("keeps text within budget, marks trimmed true, and preserves the owner's first request", () => {
    const turns: TurnLike[] = [
      {
        id: "initial-request",
        seat: "Owner",
        kind: "verbatim",
        body: "FIRST_REQUEST: Build the authentication flow"
      },
      {
        id: "old-answer",
        seat: "Codex",
        kind: "answer",
        body: "Intermediate scaffolding with session tokens and cookie handling logic"
      },
      {
        id: "second-request",
        seat: "Owner",
        kind: "verbatim",
        body: "Second prompt: Add password hashing using argon2id"
      },
      {
        id: "recent-answer",
        seat: "Claude",
        kind: "answer",
        body: "Implemented argon2id hashing with cryptographic salt verification"
      }
    ];

    const budgetChars = 190;
    const brief = buildHandoffBrief(turns, { budgetChars });

    expect(brief.chars).toBeLessThanOrEqual(budgetChars);
    expect(brief.text.length).toBe(brief.chars);
    expect(brief.trimmed).toBe(true);
    expect(brief.text).toContain("FIRST_REQUEST: Build the authentication flow");
    expect(brief.evidence).toContain("initial-request");
    expect(brief.evidence).not.toContain("old-answer");
  });

  it("attributes different provider seats without merging or changing seat strings", () => {
    const turns: TurnLike[] = [
      { id: "t1", seat: "Owner", kind: "verbatim", body: "Review pull request" },
      { id: "t2", seat: "Codex", kind: "answer", body: "Worker pool concurrency looks sound." },
      { id: "t3", seat: "Gemini (Profile 1)", kind: "answer", body: "Add timeout handling for slow child processes." }
    ];
    const brief = buildHandoffBrief(turns);

    expect(brief.text).toContain("Codex: Worker pool concurrency looks sound.");
    expect(brief.text).toContain("Gemini (Profile 1): Add timeout handling for slow child processes.");
    expect(brief.evidence).toEqual(["t1", "t2", "t3"]);
  });

  it("summarises a very long answer with an elision marker while retaining start and end content", () => {
    const startAnchor = "START_ANALYSIS: Memory allocation patterns verified.";
    const endAnchor = "END_ANALYSIS: Final recommendation is to prune caches.";
    const longBody = `${startAnchor} ${'x'.repeat(3000)} ${endAnchor}`;

    const turns: TurnLike[] = [
      { id: "t1", seat: "Owner", kind: "verbatim", body: "Inspect memory usage" },
      { id: "t2", seat: "Claude", kind: "answer", body: longBody }
    ];

    const brief = buildHandoffBrief(turns);
    expect(brief.text).toContain(ELISION_MARKER);
    expect(brief.text).toContain("START_ANALYSIS");
    expect(brief.text).toContain("END_ANALYSIS");
    expect(brief.trimmed).toBe(true);
  });

  it("ensures every id in evidence exists in the input and every carried body traces to one", () => {
    const turns: TurnLike[] = [
      { id: "req-1", seat: "Owner", kind: "verbatim", body: "Create user repository" },
      { id: "receipt-1", seat: "host", kind: "receipt", body: "Internal checkpoint" },
      { id: "ans-1", seat: "Codex", kind: "answer", body: "Repository created with findById and persist" }
    ];
    const brief = buildHandoffBrief(turns);
    const inputIds = new Set(turns.map(t => t.id));

    for (const id of brief.evidence) {
      expect(inputIds.has(id)).toBe(true);
    }
    expect(brief.evidence).not.toContain("receipt-1");
    expect(brief.text).toContain("Create user repository");
    expect(brief.text).toContain("Repository created with findById and persist");
    expect(brief.text).not.toContain("Internal checkpoint");
  });

  it("produces identical output for identical input (pure and deterministic)", () => {
    const turns: TurnLike[] = [
      { id: "1", seat: "Owner", kind: "verbatim", body: "Prepare release bundle" },
      { id: "2", seat: "Codex", kind: "answer", body: "Built artifacts in release directory" },
      { id: "3", seat: "Claude", kind: "answer", body: "Validated cryptographic checksums" }
    ];
    const brief1 = buildHandoffBrief(turns, { budgetChars: 2000 });
    const brief2 = buildHandoffBrief(turns, { budgetChars: 2000 });
    expect(brief1).toEqual(brief2);
  });

  it("handles session with no verbatim turn by carrying recent answers within budget", () => {
    const turns: TurnLike[] = [
      { id: "ans-1", seat: "Codex", kind: "answer", body: "First established decision" },
      { id: "ans-2", seat: "Claude", kind: "answer", body: "Second established decision" }
    ];
    const brief = buildHandoffBrief(turns, { budgetChars: 100 });
    expect(brief.chars).toBeLessThanOrEqual(100);
    expect(brief.evidence).toContain("ans-2");
    expect(brief.text).toContain("Second established decision");
  });

  it("does not mutate the input array", () => {
    const turns: readonly TurnLike[] = Object.freeze([
      Object.freeze({ id: "1", seat: "Owner", kind: "verbatim", body: "Task description" }),
      Object.freeze({ id: "2", seat: "Codex", kind: "answer", body: "Task completed" })
    ]);
    const originalLength = turns.length;
    buildHandoffBrief(turns);
    expect(turns.length).toBe(originalLength);
  });
});
