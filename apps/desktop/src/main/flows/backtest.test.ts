/**
 * Replaying a flow against the folder's own history.
 *
 * The question this settles is the one nobody can answer about their own
 * Downloads: **how often does it actually change?** The guess is always "a few
 * times a day". The answer is regularly four hundred.
 */

import { describe, expect, it } from "vitest";
import type { AutomationWorkflow } from "@cadrane/contracts";
import { backtest } from "./backtest.js";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const DAY = 86_400_000;

const flow = (trigger: AutomationWorkflow["trigger"]): AutomationWorkflow =>
  ({
    schemaVersion: 1,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Tidy Downloads",
    description: "d",
    enabled: true,
    trigger,
    budget: { maxDurationMs: 60_000, maxNodeExecutions: 6, maxOutputCharacters: 20_000 },
    nodes: [],
    revision: 1,
    pausedReason: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastRunAt: null,
    nextRunAt: null
  }) as unknown as AutomationWorkflow;

const folder = flow({ kind: "folder", root: "/Users/amber/Downloads" });

describe("a folder that changes at a human pace", () => {
  it("says how often, in a number somebody can act on", () => {
    // Once a day for a fortnight. Ordinary work.
    const moments = Array.from({ length: 14 }, (_, day) => NOW - (14 - day) * DAY);

    const result = backtest(folder, moments, NOW);

    expect(result.ok).toBe(true);
    expect(result.starts).toBe(14);
    expect(result.trips).toBe(0);
    expect(result.said).toContain("about 1 a day");
    expect(result.said).toContain("would not have run away");
  });
});

describe("a folder something else is writing to", () => {
  it("catches the flow that would have run away, before it is armed", () => {
    // A sync client touching the folder every twenty seconds for an hour. This
    // is the failure the whole feature exists to catch, and the person arming
    // the flow has no way to know it without being told.
    const moments = Array.from({ length: 180 }, (_, index) => NOW - DAY + index * 20_000);

    const result = backtest(folder, moments, NOW);

    expect(result.ok).toBe(false);
    expect(result.trips).toBeGreaterThan(10);
    // Measured before the guard's reset, so it reports what the folder actually
    // did rather than being capped at the threshold that stopped it.
    expect(result.worstBurst).toBeGreaterThan(4);
    expect(result.said).toContain("switched itself off");
    expect(result.said).toContain("Downloads changes too often");
  });

  it("agrees with the guard that would actually pause it", () => {
    // Exactly four inside two minutes is the guard's threshold, and the
    // backtest must reach the same verdict — a prediction that disagrees with
    // the rule is a promise the product then breaks.
    const burst = [0, 30_000, 60_000, 90_000].map((offset) => NOW - DAY + offset);

    expect(backtest(folder, burst, NOW).trips).toBe(0);
    expect(backtest(folder, [...burst, NOW - DAY + 100_000], NOW).trips).toBe(1);
  });
});

describe("a long history", () => {
  it("is replayed without re-scanning everything on every step", async () => {
    // The window is pruned as it goes. Without that, a year of captures turns a
    // replay into an O(n²) walk on the main process — the one that draws the
    // window somebody is waiting in front of.
    const many = Array.from({ length: 20_000 }, (_, index) => NOW - DAY + index * 1_000);

    const started = Date.now();
    const result = backtest(folder, many, NOW);

    expect(result.starts).toBe(20_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("flows there is nothing to replay for", () => {
  it("says so rather than inventing a verdict", () => {
    expect(backtest(flow({ kind: "manual" }), [], NOW).said).toContain("only runs when you run it");
    expect(
      backtest(flow({ kind: "interval", everyMinutes: 60, runOnceIfOverdue: true }), [], NOW).said
    ).toContain("whatever happens");
  });

  it("admits when a folder has no history yet", () => {
    // Not "it would never run" — that would be a confident wrong answer about a
    // folder granted this morning.
    const result = backtest(folder, [], NOW);

    expect(result.said).toContain("no history for that folder yet");
    expect(result.since).toBeNull();
  });
});
