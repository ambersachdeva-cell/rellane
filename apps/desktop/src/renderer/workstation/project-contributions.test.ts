import { describe, expect, it } from "vitest";
import { summariseContributions, type ContributionTurn } from "./project-contributions.js";

describe("project contributions provenance", () => {
  it("returns an empty, valid view for empty input", () => {
    const view = summariseContributions([], Date.now());
    expect(view.contributors).toEqual([]);
    expect(view.headline).toBe("");
    expect(view.workCount).toBe(0);
    expect(view.span).toBe("no activity yet");
  });

  it("excludes bookkeeping turns from all counts", () => {
    const turns: readonly ContributionTurn[] = [
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "codex",
        kind: "receipt",
        at: 1_000,
        chars: 800,
        producedOutput: true,
      },
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "codex",
        kind: "permission",
        at: 2_000,
        chars: 400,
        producedOutput: false,
      },
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "codex",
        kind: "answer",
        at: 3_000,
        chars: 250,
        producedOutput: true,
      },
    ];

    const view = summariseContributions(turns, 4_000);
    expect(view.contributors).toHaveLength(1);
    const codex = view.contributors[0]!;
    expect(codex.answers).toBe(1);
    expect(codex.outputs).toBe(1);
    expect(codex.chars).toBe(250);
    expect(codex.firstAt).toBe(3_000);
    expect(codex.lastAt).toBe(3_000);
    expect(codex.line).toBe("1 answer across 1 piece of work, 1 saved as output.");
  });

  it("orders contributors by outputs descending, then answers, then most recent", () => {
    const turns: readonly ContributionTurn[] = [
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "claude",
        kind: "answer",
        at: 1_000,
        chars: 100,
        producedOutput: false,
      },
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "codex",
        kind: "answer",
        at: 2_000,
        chars: 200,
        producedOutput: true,
      },
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "gemini1",
        kind: "answer",
        at: 3_000,
        chars: 150,
        producedOutput: false,
      },
      {
        caseId: "case-1",
        caseTitle: "Brief",
        seat: "gemini1",
        kind: "answer",
        at: 4_000,
        chars: 150,
        producedOutput: false,
      },
    ];

    const view = summariseContributions(turns, 5_000);
    expect(view.contributors).toHaveLength(3);
    expect(view.contributors[0]!.seat).toBe("codex");
    expect(view.contributors[1]!.seat).toBe("gemini1");
    expect(view.contributors[2]!.seat).toBe("claude");
  });

  it("de-duplicates works touched by each seat in first-seen order", () => {
    const turns: readonly ContributionTurn[] = [
      {
        caseId: "case-a",
        caseTitle: "Market Analysis",
        seat: "codex",
        kind: "answer",
        at: 1_000,
        chars: 120,
        producedOutput: false,
      },
      {
        caseId: "case-b",
        caseTitle: "Financial Forecast",
        seat: "codex",
        kind: "answer",
        at: 2_000,
        chars: 180,
        producedOutput: true,
      },
      {
        caseId: "case-a",
        caseTitle: "Market Analysis",
        seat: "codex",
        kind: "answer",
        at: 3_000,
        chars: 90,
        producedOutput: false,
      },
    ];

    const view = summariseContributions(turns, 4_000);
    expect(view.contributors).toHaveLength(1);
    const contributor = view.contributors[0]!;
    expect(contributor.works).toEqual(["Market Analysis", "Financial Forecast"]);
    expect(contributor.line).toBe("3 answers across 2 pieces of work, 1 saved as output.");
  });

  it("humanises seat labels and separates the owner in the headline", () => {
    const turns: readonly ContributionTurn[] = [
      {
        caseId: "c1",
        caseTitle: "Brief",
        seat: "provider:codex",
        kind: "answer",
        at: 1_000,
        chars: 100,
        producedOutput: true,
      },
      {
        caseId: "c2",
        caseTitle: "Review",
        seat: "claude",
        kind: "answer",
        at: 2_000,
        chars: 120,
        producedOutput: true,
      },
      {
        caseId: "c1",
        caseTitle: "Brief",
        seat: "gemini1",
        kind: "answer",
        at: 3_000,
        chars: 140,
        producedOutput: false,
      },
      {
        caseId: "c2",
        caseTitle: "Review",
        seat: "user",
        kind: "answer",
        at: 4_000,
        chars: 50,
        producedOutput: false,
      },
    ];

    const view = summariseContributions(turns, 5_000);
    const labels = view.contributors.map((c) => c.label);
    expect(labels).toContain("Codex");
    expect(labels).toContain("Claude");
    expect(labels).toContain("Gemini (Profile 1)");
    expect(labels).toContain("You");
    expect(view.headline).toBe("3 AIs and you, across 2 pieces of work");
    expect(view.workCount).toBe(2);
  });

  it("formats span wording for same-day, multi-day, and multi-week periods", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const base = 1_700_000_000_000;

    const sameDay = summariseContributions(
      [
        {
          caseId: "c1",
          caseTitle: "Brief",
          seat: "codex",
          kind: "answer",
          at: base,
          chars: 10,
          producedOutput: false,
        },
        {
          caseId: "c1",
          caseTitle: "Brief",
          seat: "codex",
          kind: "answer",
          at: base + 3_600_000,
          chars: 20,
          producedOutput: false,
        },
      ],
      base + 3_600_000
    );
    expect(sameDay.span).toBe("today");

    const multiDay = summariseContributions(
      [
        {
          caseId: "c1",
          caseTitle: "Brief",
          seat: "codex",
          kind: "answer",
          at: base,
          chars: 10,
          producedOutput: false,
        },
        {
          caseId: "c1",
          caseTitle: "Brief",
          seat: "codex",
          kind: "answer",
          at: base + 3 * dayMs,
          chars: 20,
          producedOutput: false,
        },
      ],
      base + 3 * dayMs
    );
    expect(multiDay.span).toBe("over 3 days");

    const multiWeek = summariseContributions(
      [
        {
          caseId: "c1",
          caseTitle: "Brief",
          seat: "codex",
          kind: "answer",
          at: base,
          chars: 10,
          producedOutput: false,
        },
        {
          caseId: "c1",
          caseTitle: "Brief",
          seat: "codex",
          kind: "answer",
          at: base + 14 * dayMs,
          chars: 20,
          producedOutput: false,
        },
      ],
      base + 14 * dayMs
    );
    expect(multiWeek.span).toBe("over 2 weeks");
  });

  it("formats headlines accurately without the owner and with singular counts", () => {
    const turns: readonly ContributionTurn[] = [
      {
        caseId: "c1",
        caseTitle: "Brief",
        seat: "codex",
        kind: "answer",
        at: 1_000,
        chars: 100,
        producedOutput: true,
      },
    ];

    const view = summariseContributions(turns, 2_000);
    expect(view.headline).toBe("1 AI, across 1 piece of work");
    expect(view.workCount).toBe(1);
  });
});
