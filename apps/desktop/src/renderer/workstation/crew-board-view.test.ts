import { describe, expect, it } from "vitest";
import {
  buildCrewRunView,
  crewStatusLines,
  type RawPart,
} from "./crew-board-view.js";

function makePart(overrides: Partial<RawPart> & { readonly id: string; readonly title: string }): RawPart {
  return {
    id: overrides.id,
    title: overrides.title,
    seatLabel: overrides.seatLabel ?? "Claude",
    state: overrides.state ?? "working",
    dependsOn: overrides.dependsOn ?? [],
    startedAt: overrides.startedAt !== undefined ? overrides.startedAt : null,
    endedAt: overrides.endedAt !== undefined ? overrides.endedAt : null,
    answerTurnId: overrides.answerTurnId !== undefined ? overrides.answerTurnId : null,
    refinedFrom: overrides.refinedFrom ?? [],
    failure: overrides.failure !== undefined ? overrides.failure : null,
  };
}

describe("crew-board-view", () => {
  it("names waiting parts by title rather than raw identifier", () => {
    const partA = makePart({ id: "part-1", title: "Part A", state: "working" });
    const partB = makePart({
      id: "part-2",
      title: "Part B",
      state: "waiting",
      dependsOn: ["part-1"],
    });

    const view = buildCrewRunView({
      runId: "run-101",
      caseId: "case-202",
      request: "Split task between models",
      round: "working",
      parts: [partA, partB],
      now: 10_000,
    });

    const partBView = view.parts.find((p) => p.id === "part-2");
    expect(partBView).toBeDefined();
    expect(partBView?.line).toBe("Waiting for Part A.");
  });

  it("handles waiting parts with multiple dependencies joined clearly", () => {
    const partA = makePart({ id: "p1", title: "First Slice", state: "done" });
    const partB = makePart({ id: "p2", title: "Second Slice", state: "done" });
    const partC = makePart({
      id: "p3",
      title: "Review",
      state: "waiting",
      dependsOn: ["p1", "p2"],
    });

    const view = buildCrewRunView({
      runId: "run-101",
      caseId: "case-202",
      request: "Review both slices",
      round: "working",
      parts: [partA, partB, partC],
      now: 15_000,
    });

    const partCView = view.parts.find((p) => p.id === "p3");
    expect(partCView?.line).toBe("Waiting for First Slice and Second Slice.");
  });

  it("leaves elapsed empty when clock is backwards or part is unstarted", () => {
    const unstarted = makePart({ id: "p1", title: "Unstarted Part", startedAt: null });
    const backwards = makePart({
      id: "p2",
      title: "Backwards Part",
      startedAt: 5_000,
      endedAt: 2_000,
    });
    const nowBeforeStarted = makePart({
      id: "p3",
      title: "Skewed Part",
      startedAt: 10_000,
      endedAt: null,
    });

    const view = buildCrewRunView({
      runId: "run-101",
      caseId: "case-202",
      request: "Check elapsed safeguards",
      round: "working",
      parts: [unstarted, backwards, nowBeforeStarted],
      now: 5_000,
    });

    expect(view.parts[0]?.elapsed).toBe("");
    expect(view.parts[1]?.elapsed).toBe("");
    expect(view.parts[2]?.elapsed).toBe("");
  });

  it("formats elapsed time in calm human words", () => {
    const secondsPart = makePart({
      id: "p1",
      title: "Quick Part",
      startedAt: 0,
      endedAt: 12_000,
    });
    const minutesPart = makePart({
      id: "p2",
      title: "Medium Part",
      startedAt: 0,
      endedAt: 240_000,
    });
    const hoursPart = makePart({
      id: "p3",
      title: "Long Part",
      startedAt: 0,
      endedAt: 4_800_000,
    });

    const view = buildCrewRunView({
      runId: "run-101",
      caseId: "case-202",
      request: "Check durations",
      round: "working",
      parts: [secondsPart, minutesPart, hoursPart],
      now: 10_000_000,
    });

    expect(view.parts[0]?.elapsed).toBe("12 sec");
    expect(view.parts[1]?.elapsed).toBe("4 min");
    expect(view.parts[2]?.elapsed).toBe("1 hr 20 min");
  });

  it("computes part line for working, refining, failed and stopped states", () => {
    const working = makePart({
      id: "p1",
      title: "Worker",
      state: "working",
      startedAt: 0,
      endedAt: 120_000,
    });
    const refining = makePart({
      id: "p2",
      title: "Refiner",
      state: "refining",
      refinedFrom: ["p1"],
    });
    const failed = makePart({
      id: "p3",
      title: "Failure",
      state: "failed",
      failure: "quota exhausted.",
    });
    const stopped = makePart({
      id: "p4",
      title: "Halted",
      state: "stopped",
    });

    const view = buildCrewRunView({
      runId: "run-101",
      caseId: "case-202",
      request: "Verify line phrasing",
      round: "working",
      parts: [working, refining, failed, stopped],
      now: 200_000,
    });

    expect(view.parts[0]?.line).toBe("Working, 2 min so far.");
    expect(view.parts[1]?.line).toBe("Reading Worker before revising.");
    expect(view.parts[2]?.line).toBe("Could not finish: quota exhausted.");
    expect(view.parts[3]?.line).toBe("Stopped, at your request.");
  });

  it("reflects stop authority accurately on parts and the run", () => {
    const working = makePart({ id: "p1", title: "Active", state: "working" });
    const done = makePart({ id: "p2", title: "Finished", state: "done" });

    const activeView = buildCrewRunView({
      runId: "run-1",
      caseId: "case-1",
      request: "Can stop active part",
      round: "working",
      parts: [working, done],
      now: 1000,
    });
    expect(activeView.parts[0]?.canStop).toBe(true);
    expect(activeView.parts[1]?.canStop).toBe(false);
    expect(activeView.canStop).toBe(true);

    const completedView = buildCrewRunView({
      runId: "run-2",
      caseId: "case-1",
      request: "Finished run cannot stop",
      round: "done",
      parts: [done],
      now: 1000,
    });
    expect(completedView.canStop).toBe(false);
  });

  it("counts headline accurately from observable states", () => {
    const p1 = makePart({ id: "p1", title: "Part A", state: "working" });
    const p2 = makePart({ id: "p2", title: "Part B", state: "working" });
    const p3 = makePart({ id: "p3", title: "Part C", state: "done" });

    const mixedView = buildCrewRunView({
      runId: "run-1",
      caseId: "case-1",
      request: "Count bots",
      round: "working",
      parts: [p1, p2, p3],
      now: 1000,
    });
    expect(mixedView.headline).toBe("Two bots working, one finished.");

    const pDone1 = makePart({ id: "d1", title: "Part 1", state: "done" });
    const pDone2 = makePart({ id: "d2", title: "Part 2", state: "answered" });
    const finishedView = buildCrewRunView({
      runId: "run-2",
      caseId: "case-1",
      request: "All done",
      round: "done",
      parts: [pDone1, pDone2],
      now: 1000,
    });
    expect(finishedView.headline).toBe("Both finished.");
  });

  it("caps phone status lines to at most five lines under 80 characters for a six-part run", () => {
    const parts: RawPart[] = [];
    for (let i = 1; i <= 6; i++) {
      parts.push(
        makePart({
          id: `part-${i}`,
          title: `Section ${i} of Market Analysis Plan`,
          state: i === 1 ? "working" : "waiting",
          dependsOn: i > 1 ? [`part-${i - 1}`] : [],
          startedAt: i === 1 ? 0 : null,
        }),
      );
    }

    const view = buildCrewRunView({
      runId: "run-6",
      caseId: "case-6",
      request: "Handle six parts simultaneously",
      round: "working",
      parts,
      now: 30_000,
    });

    const lines = crewStatusLines(view);

    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toBe(view.headline);

    for (const line of lines) {
      expect(line.length).toBeLessThan(80);
      expect(line).not.toMatch(/run-[0-9]/);
      expect(line).not.toMatch(/case-[0-9]/);
      expect(line).not.toMatch(/part-[0-9]/);
    }
  });
});
