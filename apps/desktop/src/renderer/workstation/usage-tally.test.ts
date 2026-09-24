import { describe, expect, it } from "vitest";
import { tallyUsage } from "./usage-tally.js";
import type { UsageReceipt } from "./usage-tally.js";

describe("usage-tally", () => {
  const fixedNow = new Date("2026-09-15T14:30:00.000Z").getTime();

  const standardKnown = [
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude" },
    { id: "gemini-1", label: "Gemini 1" },
    { id: "gemini-2", label: "Gemini 2" },
    { id: "gemini-3", label: "Gemini 3" },
  ] as const;

  it("preserves five known subscriptions with unused ones showing zeros and not yet", () => {
    const receipts: UsageReceipt[] = [
      {
        providerId: "codex",
        providerLabel: "Codex",
        modelId: "codex-v1",
        status: "completed",
        startedAt: fixedNow - 30 * 60_000,
        endedAt: fixedNow - 26 * 60_000,
        caseId: "case-1",
      },
      {
        providerId: "codex",
        providerLabel: "Codex",
        modelId: "codex-v1",
        status: "completed",
        startedAt: fixedNow - 15 * 60_000,
        endedAt: fixedNow - 16 * 60_000, // Backwards clock skew
        caseId: "case-2",
      },
      {
        providerId: "claude",
        providerLabel: "Claude",
        modelId: "claude-3-5-sonnet",
        status: "completed",
        startedAt: fixedNow - 60 * 60_000,
        endedAt: fixedNow - 59 * 60_000,
        caseId: "case-3",
      },
    ];

    const view = tallyUsage({
      receipts,
      known: standardKnown,
      window: "week",
      now: fixedNow,
    });

    expect(view.subscriptions.length).toBe(5);

    const topRow = view.subscriptions[0]!;
    expect(topRow.providerId).toBe("codex");
    expect(topRow.asked).toBe(2);
    expect(topRow.totalMs).toBe(4 * 60_000);
    expect(topRow.longest).toBe("4 min");
    expect(topRow.lastUsed).toBe("15 minutes ago");

    const secondRow = view.subscriptions[1]!;
    expect(secondRow.providerId).toBe("claude");
    expect(secondRow.asked).toBe(1);
    expect(secondRow.totalMs).toBe(60_000);
    expect(secondRow.longest).toBe("1 min");
    expect(secondRow.lastUsed).toBe("1 hour ago");

    const emptyRows = view.subscriptions.slice(2);
    expect(emptyRows.length).toBe(3);
    for (const row of emptyRows) {
      expect(row.asked).toBe(0);
      expect(row.finished).toBe(0);
      expect(row.stopped).toBe(0);
      expect(row.failed).toBe(0);
      expect(row.totalMs).toBe(0);
      expect(row.longest).toBe("0 sec");
      expect(row.lastUsed).toBe("not yet");
      expect(row.busiestDay).toBeNull();
      expect(row.models).toEqual([]);
    }

    expect(view.totalAsked).toBe(3);
    expect(view.note).toBe(
      "This counts what Rellane asked. How much of each subscription is left is something only that provider can tell you.",
    );
  });

  it("produces calm zero-count headline and null quietest for an empty receipt history", () => {
    const view = tallyUsage({
      receipts: [],
      known: standardKnown,
      window: "today",
      now: fixedNow,
    });

    expect(view.totalAsked).toBe(0);
    expect(view.headline).toBe("You asked no subscriptions today.");
    expect(view.quietest).toBeNull();
    expect(view.subscriptions.length).toBe(5);
  });

  it("omits receipts outside the active window boundary or in the future", () => {
    const eightDaysAgo = fixedNow - 8 * 86_400_000;
    const futureTime = fixedNow + 3_600_000;

    const receipts: UsageReceipt[] = [
      {
        providerId: "codex",
        providerLabel: "Codex",
        modelId: null,
        status: "completed",
        startedAt: eightDaysAgo,
        endedAt: eightDaysAgo + 2_000,
        caseId: "case-old",
      },
      {
        providerId: "codex",
        providerLabel: "Codex",
        modelId: null,
        status: "completed",
        startedAt: futureTime,
        endedAt: futureTime + 2_000,
        caseId: "case-future",
      },
      {
        providerId: "codex",
        providerLabel: "Codex",
        modelId: null,
        status: "completed",
        startedAt: fixedNow - 10_000,
        endedAt: fixedNow - 5_000,
        caseId: "case-current",
      },
    ];

    const view = tallyUsage({
      receipts,
      known: [{ id: "codex", label: "Codex" }],
      window: "week",
      now: fixedNow,
    });

    expect(view.totalAsked).toBe(1);
    expect(view.headline).toBe("You asked one subscription 1 time this week.");
  });

  it("flags quietest subscription only when a 4x usage gap exists without nagging on even usage", () => {
    const evenReceipts: UsageReceipt[] = [
      {
        providerId: "codex",
        providerLabel: "Codex",
        modelId: null,
        status: "completed",
        startedAt: fixedNow - 10_000,
        endedAt: fixedNow,
        caseId: "c1",
      },
      {
        providerId: "claude",
        providerLabel: "Claude",
        modelId: null,
        status: "completed",
        startedAt: fixedNow - 20_000,
        endedAt: fixedNow,
        caseId: "c2",
      },
    ];

    const evenView = tallyUsage({
      receipts: evenReceipts,
      known: [
        { id: "codex", label: "Codex" },
        { id: "claude", label: "Claude" },
      ],
      window: "week",
      now: fixedNow,
    });
    expect(evenView.quietest).toBeNull();

    const gappedReceipts: UsageReceipt[] = [
      { providerId: "claude", providerLabel: "Claude", modelId: null, status: "completed", startedAt: fixedNow - 5_000, endedAt: fixedNow, caseId: "cl1" },
    ];
    for (let i = 0; i < 4; i++) {
      gappedReceipts.push({
        providerId: "codex",
        providerLabel: "Codex",
        modelId: null,
        status: "completed",
        startedAt: fixedNow - (i + 1) * 10_000,
        endedAt: fixedNow,
        caseId: `cd${i}`,
      });
    }

    const gappedView = tallyUsage({
      receipts: gappedReceipts,
      known: [
        { id: "codex", label: "Codex" },
        { id: "claude", label: "Claude" },
      ],
      window: "week",
      now: fixedNow,
    });
    expect(gappedView.quietest).toBe("Claude");
  });

  it("incorporates unrecognised provider IDs directly using their raw ID as the label", () => {
    const receipts: UsageReceipt[] = [
      {
        providerId: "custom-cli",
        providerLabel: "Different Display Name",
        modelId: "v2",
        status: "completed",
        startedAt: fixedNow - 5_000,
        endedAt: fixedNow - 1_000,
        caseId: "c-custom",
      },
    ];

    const view = tallyUsage({
      receipts,
      known: [{ id: "codex", label: "Codex" }],
      window: "today",
      now: fixedNow,
    });

    expect(view.subscriptions.length).toBe(2);
    const customEntry = view.subscriptions.find((s) => s.providerId === "custom-cli");
    expect(customEntry).toBeDefined();
    expect(customEntry!.label).toBe("custom-cli");
    expect(customEntry!.asked).toBe(1);
    expect(customEntry!.models).toEqual([{ id: "v2", asked: 1 }]);
  });

  it("categorises stopped, interrupted and failed requests properly", () => {
    const receipts: UsageReceipt[] = [
      { providerId: "codex", providerLabel: "Codex", modelId: null, status: "completed", startedAt: fixedNow - 40_000, endedAt: fixedNow - 30_000, caseId: "c1" },
      { providerId: "codex", providerLabel: "Codex", modelId: null, status: "stopped", startedAt: fixedNow - 30_000, endedAt: fixedNow - 25_000, caseId: "c2" },
      { providerId: "codex", providerLabel: "Codex", modelId: null, status: "interrupted", startedAt: fixedNow - 20_000, endedAt: fixedNow - 15_000, caseId: "c3" },
      { providerId: "codex", providerLabel: "Codex", modelId: null, status: "failed", startedAt: fixedNow - 10_000, endedAt: fixedNow - 5_000, caseId: "c4" },
    ];

    const view = tallyUsage({
      receipts,
      known: [{ id: "codex", label: "Codex" }],
      window: "today",
      now: fixedNow,
    });

    const sub = view.subscriptions[0]!;
    expect(sub.asked).toBe(4);
    expect(sub.finished).toBe(1);
    expect(sub.stopped).toBe(2);
    expect(sub.failed).toBe(1);
  });

  it("executes in linear time without performance degradation over 50,000 receipts", () => {
    const largeReceipts: UsageReceipt[] = [];
    const baseTime = fixedNow - 60_000;

    for (let i = 0; i < 50_000; i++) {
      largeReceipts.push({
        providerId: i % 2 === 0 ? "codex" : "claude",
        providerLabel: i % 2 === 0 ? "Codex" : "Claude",
        modelId: i % 3 === 0 ? "fast" : "deep",
        status: "completed",
        startedAt: baseTime + (i % 50_000),
        endedAt: baseTime + (i % 50_000) + 100,
        caseId: `run-${i}`,
      });
    }

    const start = performance.now();
    const view = tallyUsage({
      receipts: largeReceipts,
      known: standardKnown,
      window: "week",
      now: fixedNow,
    });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(view.totalAsked).toBe(50_000);
    expect(view.subscriptions[0]!.asked).toBe(25_000);
    expect(view.subscriptions[1]!.asked).toBe(25_000);
  });
});
