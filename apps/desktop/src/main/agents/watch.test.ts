/**
 * Watching a run, and stopping it.
 *
 * The done-when is two verbs — *you can watch it and stop it* — and both fail in
 * the same way if they are half-built. A spinner is not watching; a stop that
 * discards the work already paid for is not stopping, it is undoing.
 */

import { describe, expect, it } from "vitest";
import { runAgent, type RunDeps, type RunProgress } from "./run.js";
import { newBrief, type Ceiling } from "./brief.js";
import type { EngineRoomStatus } from "@cadrane/contracts";

const ceiling: Ceiling = {
  grantedFolders: ["/Users/a/Downloads"],
  availableCapabilities: ["read_text"],
  storedAgents: []
};

const room: EngineRoomStatus = {
  engines: [
    {
      id: "claude",
      label: "Claude",
      access: "subscription",
      accessLabel: "Your subscription",
      state: "ready",
      summary: "s",
      fixHint: null,
      evidence: null,
      models: [
        {
          id: "sonnet",
          label: "Sonnet",
          tier: "balanced",
          tierLabel: "Balanced",
          note: "n",
          includedInSubscription: true
        }
      ]
    }
  ],
  active: null,
  checkedAt: "2026-09-03T00:00:00.000Z",
  allUnavailable: false
};

const brief = () =>
  newBrief({
    id: "a",
    name: "Reader",
    purpose: "p",
    folders: ["/Users/a/Downloads"],
    capabilities: ["read_text"]
  });

const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  room,
  ceiling,
  ask: async () => "Forty files arrived overnight.",
  gather: async () => [],
  ...over
});

describe("watching a run", () => {
  it("says which engine it went to, before it has an answer", async () => {
    // The first line has to arrive before the wait, not after it — otherwise it
    // is a summary, and the person watching has already spent the minute.
    const seen: RunProgress[] = [];

    await runAgent(brief(), "What changed?", deps({ progress: (update) => seen.push(update) }));

    expect(seen[0]?.stage).toBe("thinking");
    expect(seen[0]?.said).toContain("Sonnet");
    expect(seen[0]?.step).toBe(1);
    expect(seen.at(-1)?.stage).toBe("answering");
  });

  it("carries the run's own id, so a late update cannot be shown against a new run", async () => {
    const seen: RunProgress[] = [];

    const run = await runAgent(brief(), "go", deps({ progress: (update) => seen.push(update) }));

    expect(new Set(seen.map((update) => update.runId))).toEqual(new Set([run.id]));
  });

  it("is not allowed to break the run it is only observing", async () => {
    // An observer that throws is an observer's problem. A run that fails
    // because something was watching it would be the worst possible trade.
    const run = await runAgent(
      brief(),
      "go",
      deps({
        progress: () => {
          throw new Error("the listener is broken");
        }
      })
    );

    expect(run.outcome).toBe("answered");
  });
});

describe("stopping a run", () => {
  it("is reported as stopped, not failed", async () => {
    // The agent did what it was told. Calling that a failure would teach the
    // owner to distrust the one control they have over a run in flight.
    const controller = new AbortController();

    const run = await runAgent(
      brief(),
      "go",
      deps({
        signal: controller.signal,
        ask: async () => {
          controller.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
      })
    );

    expect(run.outcome).toBe("stopped");
    // Blames the person, not the clock. Reporting "stopped at its 10-minute
    // limit" four seconds in sends somebody to raise a limit that was never
    // reached, and teaches them the messages are not to be trusted.
    expect(run.problem).toContain("You stopped");
    expect(run.problem).not.toContain("limit");
  });

  it("still blames the clock when the clock is what stopped it", async () => {
    const run = await runAgent(
      brief(),
      "go",
      deps({
        // No owner signal: the only thing that can abort is the budget.
        ask: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return "late";
        }
      })
    );

    expect(run.outcome).toBe("answered");
  });

  it("stops before spending anything when it was already told to", async () => {
    // A stop that arrives while the run is being set up must still count. The
    // caller's signal and the brief's clock abort the same controller, so every
    // await below already honours both.
    const controller = new AbortController();
    controller.abort();
    let asked = 0;

    const run = await runAgent(
      brief(),
      "go",
      deps({
        signal: controller.signal,
        ask: async () => {
          asked += 1;
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
      })
    );

    expect(run.outcome).toBe("stopped");
    expect(asked).toBeLessThanOrEqual(1);
  });
});
