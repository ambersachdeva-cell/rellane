import { describe, expect, it } from "vitest";
import { resumeOptions, type PastSession } from "./session-continuity.js";

function makeSession(overrides: Partial<PastSession> = {}): PastSession {
  return {
    operationId: "op-1",
    providerId: "claude",
    providerLabel: "Claude",
    sessionId: "sess-1",
    caseId: "case-1",
    caseTitle: "Client advisory",
    endedAt: 1_700_000_000_000,
    status: "completed",
    hadTools: false,
    workspacePath: "/Users/amber/work",
    ...overrides,
  };
}

describe("resumeOptions", () => {
  it("only returns sessions matching the chosen provider", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [
      makeSession({ operationId: "c1", providerId: "claude", providerLabel: "Claude" }),
      makeSession({ operationId: "cx1", providerId: "codex", providerLabel: "Codex" }),
      makeSession({ operationId: "g1", providerId: "gemini", providerLabel: "Gemini" }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.operationId).toBe("c1");
    expect(options[0]!.label).toContain("Claude");
  });

  it("marks tool-bearing sessions unavailable with the required plain message", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [
      makeSession({ operationId: "tool-op", hadTools: true }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.available).toBe(false);
    expect(options[0]!.unavailableBecause).toBe(
      "That one could use your files, so it starts fresh.",
    );
  });

  it("marks sessions from a different workspace folder unavailable", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [
      makeSession({
        operationId: "foreign-folder",
        workspacePath: "/Users/amber/other-business",
      }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.available).toBe(false);
    expect(options[0]!.unavailableBecause).toBe(
      "That was in a different folder, so it cannot be resumed here.",
    );
  });

  it("marks sessions with null sessionId unavailable", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [
      makeSession({ operationId: "null-sess", sessionId: null }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.available).toBe(false);
    expect(options[0]!.unavailableBecause).toBe(
      "The provider never gave a session to carry on from.",
    );
  });

  it("allows failed and interrupted sessions to be resumed", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [
      makeSession({ operationId: "failed-op", status: "failed", endedAt: now - 3600_000 }),
      makeSession({
        operationId: "interrupted-op",
        sessionId: "sess-2",
        status: "interrupted",
        endedAt: now - 7200_000,
      }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(2);
    expect(options[0]!.available).toBe(true);
    expect(options[0]!.unavailableBecause).toBeNull();
    expect(options[1]!.available).toBe(true);
    expect(options[1]!.unavailableBecause).toBeNull();
  });

  it("offers sessions older than 7 days with an honest caveat about provider memory", () => {
    const now = Date.parse("2026-09-15T14:00:00Z");
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const past: PastSession[] = [
      makeSession({
        operationId: "old-op",
        endedAt: eightDaysAgo,
        caseTitle: "Annual accounts",
      }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.available).toBe(true);
    expect(options[0]!.unavailableBecause).toBeNull();
    expect(options[0]!.detail).toContain("older than 7 days");
    expect(options[0]!.detail).toContain("may have been forgotten by Claude");
  });

  it("formats label and detail honestly for a session completed earlier today", () => {
    // 14:00 local time today
    const now = new Date(2026, 8, 15, 16, 0, 0).getTime();
    const earlierToday = new Date(2026, 8, 15, 14, 0, 0).getTime();

    const past: PastSession[] = [
      makeSession({
        operationId: "today-op",
        endedAt: earlierToday,
        caseTitle: "VAT return",
      }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.label).toBe("Carry on with Claude, from this afternoon");
    expect(options[0]!.detail).toBe(
      "Earlier conversation from “VAT return”, if Claude still retains it.",
    );
  });

  it("sorts most recent first and caps results at 5 options", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [];
    for (let i = 1; i <= 7; i++) {
      past.push(
        makeSession({
          operationId: `op-${i}`,
          sessionId: `sess-${i}`,
          endedAt: now - i * 10_000,
        }),
      );
    }

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(5);
    expect(options[0]!.operationId).toBe("op-1");
    expect(options[4]!.operationId).toBe("op-5");
  });

  it("deduplicates multiple operations sharing a sessionId to the most recent turn", () => {
    const now = 1_700_000_000_000;
    const past: PastSession[] = [
      makeSession({
        operationId: "op-first-turn",
        sessionId: "thread-abc",
        endedAt: now - 50_000,
      }),
      makeSession({
        operationId: "op-second-turn",
        sessionId: "thread-abc",
        endedAt: now - 10_000,
      }),
    ];

    const options = resumeOptions({
      past,
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.operationId).toBe("op-second-turn");
  });

  it("handles empty input and future timestamps cleanly without throwing", () => {
    const now = 1_700_000_000_000;

    const empty = resumeOptions({
      past: [],
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });
    expect(empty).toEqual([]);

    const future = resumeOptions({
      past: [makeSession({ operationId: "future-op", endedAt: now + 60_000 })],
      caseId: "case-1",
      providerId: "claude",
      workspacePath: "/Users/amber/work",
      now,
    });
    expect(future).toHaveLength(1);
    expect(future[0]!.label).toBe("Carry on with Claude, from just now");
  });
});
