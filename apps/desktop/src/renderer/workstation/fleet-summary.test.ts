import { describe, expect, it } from "vitest";
import { type FleetSession, summariseFleet } from "./fleet-summary.js";

function createSession(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    operationId: overrides.operationId ?? "op-1",
    providerLabel: overrides.providerLabel ?? "Codex",
    state: overrides.state ?? "running",
    startedAt: overrides.startedAt ?? 1_000_000,
    endedAt: overrides.endedAt !== undefined ? overrides.endedAt : null,
    toolCalls: overrides.toolCalls ?? 0,
    declined: overrides.declined ?? 0,
    outcome: overrides.outcome !== undefined ? overrides.outcome : null
  };
}

describe("summariseFleet", () => {
  it("returns zeroed summary with empty headline when no sessions are provided", () => {
    const summary = summariseFleet([], 1_000_000);

    expect(summary.headline).toBe("Nothing is running.");
    expect(summary.working).toBe(0);
    expect(summary.waitingOnYou).toBe(0);
    expect(summary.finished).toBe(0);
    expect(summary.subscriptionsInUse).toEqual([]);
    expect(summary.toolCalls).toBe(0);
    expect(summary.declined).toBe(0);
    expect(summary.longestRunning).toBeNull();
    expect(summary.attention).toEqual([]);
  });

  it("omits zero categories from headline and counts states accurately", () => {
    const sessions: readonly FleetSession[] = [
      createSession({ operationId: "1", state: "starting" }),
      createSession({ operationId: "2", state: "running" }),
      createSession({ operationId: "3", state: "stopping" }),
      createSession({ operationId: "4", state: "needs-approval" }),
      createSession({ operationId: "5", state: "done", outcome: "completed" }),
      createSession({ operationId: "6", state: "done", outcome: "completed" })
    ];

    const summary = summariseFleet(sessions, 1_000_000);

    expect(summary.working).toBe(3);
    expect(summary.waitingOnYou).toBe(1);
    expect(summary.finished).toBe(2);
    expect(summary.headline).toBe("3 working, 1 needs you, 2 finished.");
  });

  it("handles singular and plural phrasing across varied state combinations", () => {
    const onlyWorking = summariseFleet([createSession({ state: "running" })], 1_000_000);
    expect(onlyWorking.headline).toBe("1 working.");

    const onlyWaitingSingle = summariseFleet(
      [createSession({ state: "needs-approval" })],
      1_000_000
    );
    expect(onlyWaitingSingle.headline).toBe("1 needs you.");

    const onlyWaitingPlural = summariseFleet(
      [
        createSession({ operationId: "1", state: "needs-approval" }),
        createSession({ operationId: "2", state: "needs-approval" })
      ],
      1_000_000
    );
    expect(onlyWaitingPlural.headline).toBe("2 need you.");

    const onlyFinished = summariseFleet(
      [createSession({ state: "done", outcome: "completed" })],
      1_000_000
    );
    expect(onlyFinished.headline).toBe("1 finished.");

    const workingAndFinished = summariseFleet(
      [
        createSession({ operationId: "1", state: "running" }),
        createSession({ operationId: "2", state: "done", outcome: "completed" })
      ],
      1_000_000
    );
    expect(workingAndFinished.headline).toBe("1 working, 1 finished.");
  });

  it("lists distinct running provider labels in first-seen order while excluding finished ones", () => {
    const sessions: readonly FleetSession[] = [
      createSession({ operationId: "1", providerLabel: "Claude", state: "running" }),
      createSession({ operationId: "2", providerLabel: "Codex", state: "done" }),
      createSession({ operationId: "3", providerLabel: "Claude", state: "needs-approval" }),
      createSession({ operationId: "4", providerLabel: "Gemini 1", state: "starting" })
    ];

    const summary = summariseFleet(sessions, 1_000_000);
    expect(summary.subscriptionsInUse).toEqual(["Claude", "Gemini 1"]);
  });

  it("aggregates tool calls and declines across both active and finished sessions", () => {
    const sessions: readonly FleetSession[] = [
      createSession({ operationId: "1", state: "running", toolCalls: 4, declined: 1 }),
      createSession({ operationId: "2", state: "done", toolCalls: 6, declined: 2 }),
      createSession({ operationId: "3", state: "needs-approval", toolCalls: 1, declined: 0 })
    ];

    const summary = summariseFleet(sessions, 1_000_000);
    expect(summary.toolCalls).toBe(11);
    expect(summary.declined).toBe(3);
  });

  it("selects the oldest running session and formats duration appropriately", () => {
    const now = 2_000_000;
    const sessions: readonly FleetSession[] = [
      createSession({ operationId: "1", state: "done", startedAt: now - 300_000 }),
      createSession({ operationId: "2", state: "running", startedAt: now - 40_000 }),
      createSession({ operationId: "3", state: "needs-approval", startedAt: now - 10_000 })
    ];

    const summary = summariseFleet(sessions, now);
    expect(summary.longestRunning).toBe("40 sec");

    const sevenMin = summariseFleet(
      [createSession({ state: "running", startedAt: now - 7 * 60 * 1000 })],
      now
    );
    expect(sevenMin.longestRunning).toBe("7 min");

    const hrMin = summariseFleet(
      [createSession({ state: "running", startedAt: now - (60 + 2) * 60 * 1000 })],
      now
    );
    expect(hrMin.longestRunning).toBe("1 hr 2 min");

    const exactHour = summariseFleet(
      [createSession({ state: "running", startedAt: now - 60 * 60 * 1000 })],
      now
    );
    expect(exactHour.longestRunning).toBe("1 hr");

    const pluralHours = summariseFleet(
      [createSession({ state: "running", startedAt: now - 120 * 60 * 1000 })],
      now
    );
    expect(pluralHours.longestRunning).toBe("2 hrs");

    const negativeElapsed = summariseFleet(
      [createSession({ state: "running", startedAt: now + 5_000 })],
      now
    );
    expect(negativeElapsed.longestRunning).toBe("0 sec");

    const nonFiniteStarted = summariseFleet(
      [createSession({ state: "running", startedAt: Number.NaN })],
      now
    );
    expect(nonFiniteStarted.longestRunning).toBe("0 sec");

    const allDone = summariseFleet(
      [createSession({ state: "done", startedAt: now - 40_000 })],
      now
    );
    expect(allDone.longestRunning).toBeNull();
  });

  it("populates attention notices for approval, failures, interruptions and declines", () => {
    const sessions: readonly FleetSession[] = [
      createSession({
        operationId: "1",
        state: "needs-approval",
        declined: 2
      }),
      createSession({
        operationId: "2",
        state: "done",
        outcome: "failed"
      }),
      createSession({
        operationId: "3",
        state: "done",
        outcome: "interrupted"
      })
    ];

    const summary = summariseFleet(sessions, 1_000_000);
    expect(summary.attention).toEqual([
      "1 session is waiting on you.",
      "A session failed.",
      "A session was interrupted.",
      "2 declines occurred."
    ]);
  });

  it("leaves attention empty when active sessions run normally with no alerts", () => {
    const sessions: readonly FleetSession[] = [
      createSession({ operationId: "1", state: "running", toolCalls: 3, declined: 0 }),
      createSession({ operationId: "2", state: "starting", toolCalls: 0, declined: 0 }),
      createSession({
        operationId: "3",
        state: "done",
        toolCalls: 5,
        declined: 0,
        outcome: "completed"
      })
    ];

    const summary = summariseFleet(sessions, 1_000_000);
    expect(summary.attention).toEqual([]);
  });

  it("never outputs prohibited terminology or exclamation marks", () => {
    const sessions: readonly FleetSession[] = [
      createSession({
        operationId: "1",
        state: "needs-approval",
        declined: 1
      }),
      createSession({
        operationId: "2",
        state: "done",
        outcome: "failed"
      }),
      createSession({
        operationId: "3",
        state: "done",
        outcome: "interrupted"
      })
    ];

    const summary = summariseFleet(sessions, 1_000_000);
    const textPool = [summary.headline, summary.longestRunning ?? "", ...summary.attention];

    for (const text of textPool) {
      expect(text.toLowerCase()).not.toContain("the owner");
      expect(text.toLowerCase()).not.toContain("stuck");
      expect(text).not.toContain("!");
    }
  });

  it("produces identical output across deterministic invocations", () => {
    const sessions: readonly FleetSession[] = [
      createSession({ operationId: "1", state: "running", startedAt: 900_000, toolCalls: 2 }),
      createSession({ operationId: "2", state: "needs-approval", startedAt: 950_000 })
    ];

    const first = summariseFleet(sessions, 1_000_000);
    const second = summariseFleet(sessions, 1_000_000);

    expect(first).toEqual(second);
  });
});
