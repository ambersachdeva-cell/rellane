import { describe, expect, it } from "vitest";
import { onboardingView } from "./onboarding-path.js";
import type { Progress } from "./onboarding-path.js";

describe("onboardingView", () => {
  const emptyProgress: Progress = {
    hasSource: false,
    hasSentRequest: false,
    hasOutput: false,
    hasExport: false,
    hasSecondProvider: false,
    connectionsDetected: 0,
  };

  it("keys the connect step strictly off connectionsDetected", () => {
    const disconnected = onboardingView(emptyProgress);
    expect(disconnected.steps.find((s) => s.id === "connect")?.done).toBe(false);

    const connectedSingle = onboardingView({
      ...emptyProgress,
      connectionsDetected: 1,
    });
    expect(connectedSingle.steps.find((s) => s.id === "connect")?.done).toBe(true);

    const connectedMultiple = onboardingView({
      ...emptyProgress,
      connectionsDetected: 4,
    });
    expect(connectedMultiple.steps.find((s) => s.id === "connect")?.done).toBe(true);

    const negativeDetected = onboardingView({
      ...emptyProgress,
      connectionsDetected: -1,
    });
    expect(negativeDetected.steps.find((s) => s.id === "connect")?.done).toBe(false);
  });

  it("maintains exactly one current step across every progressive stage", () => {
    const stages: readonly Progress[] = [
      emptyProgress,
      { ...emptyProgress, connectionsDetected: 1 },
      { ...emptyProgress, connectionsDetected: 1, hasSentRequest: true },
      { ...emptyProgress, connectionsDetected: 1, hasSentRequest: true, hasSource: true },
      { ...emptyProgress, connectionsDetected: 1, hasSentRequest: true, hasSource: true, hasOutput: true },
      {
        ...emptyProgress,
        connectionsDetected: 1,
        hasSentRequest: true,
        hasSource: true,
        hasOutput: true,
        hasExport: true,
      },
    ];

    const expectedCurrentIds = ["connect", "ask", "context", "output", "export", "compare"] as const;

    if (stages.length === 6 && expectedCurrentIds.length === 6) {
      stages.forEach((stageProgress, index) => {
        const view = onboardingView(stageProgress);
        const currentSteps = view.steps.filter((s) => s.current);
        expect(currentSteps).toHaveLength(1);
        expect(currentSteps[0]?.id).toBe(expectedCurrentIds[index]!);
        expect(view.finished).toBe(false);
        expect(view.nextAction).toBe(`${currentSteps[0]?.title}.`);
      });
    }
  });

  it("ensures nothing is current and nextAction is null when finished", () => {
    const allDoneProgress: Progress = {
      connectionsDetected: 1,
      hasSentRequest: true,
      hasSource: true,
      hasOutput: true,
      hasExport: true,
      hasSecondProvider: true,
    };

    const view = onboardingView(allDoneProgress);
    expect(view.finished).toBe(true);
    expect(view.completed).toBe(6);
    expect(view.headline).toBe("All steps complete");
    expect(view.nextAction).toBeNull();
    expect(view.steps.some((s) => s.current)).toBe(false);
    expect(view.steps.every((s) => s.done)).toBe(true);
  });

  it("does not back-fill earlier steps when later steps are done", () => {
    const outOfOrderProgress: Progress = {
      connectionsDetected: 0,
      hasSentRequest: false,
      hasSource: false,
      hasOutput: true,
      hasExport: true,
      hasSecondProvider: false,
    };

    const view = onboardingView(outOfOrderProgress);

    expect(view.steps.find((s) => s.id === "connect")?.done).toBe(false);
    expect(view.steps.find((s) => s.id === "ask")?.done).toBe(false);
    expect(view.steps.find((s) => s.id === "context")?.done).toBe(false);
    expect(view.steps.find((s) => s.id === "output")?.done).toBe(true);
    expect(view.steps.find((s) => s.id === "export")?.done).toBe(true);
    expect(view.steps.find((s) => s.id === "compare")?.done).toBe(false);

    expect(view.steps.find((s) => s.id === "connect")?.current).toBe(true);
    expect(view.steps.find((s) => s.id === "output")?.current).toBe(false);
    expect(view.completed).toBe(2);
    expect(view.headline).toBe("2 of 6 done");
    expect(view.nextAction).toBe("Connect a subscription.");
    expect(view.finished).toBe(false);
  });

  it("calculates accurate completed counts and progress headlines", () => {
    const zeroDone = onboardingView(emptyProgress);
    expect(zeroDone.completed).toBe(0);
    expect(zeroDone.headline).toBe("0 of 6 done");

    const twoDone = onboardingView({
      ...emptyProgress,
      connectionsDetected: 2,
      hasSentRequest: true,
    });
    expect(twoDone.completed).toBe(2);
    expect(twoDone.headline).toBe("2 of 6 done");

    const fourDone = onboardingView({
      ...emptyProgress,
      connectionsDetected: 1,
      hasSentRequest: true,
      hasSource: true,
      hasOutput: true,
    });
    expect(fourDone.completed).toBe(4);
    expect(fourDone.headline).toBe("4 of 6 done");
  });

  it("keeps nextAction non-null for all incomplete states and null only on completion", () => {
    const incompleteView = onboardingView({
      ...emptyProgress,
      connectionsDetected: 1,
      hasSentRequest: true,
    });
    expect(incompleteView.nextAction).toBe("Bring in a file.");

    const completeView = onboardingView({
      connectionsDetected: 1,
      hasSentRequest: true,
      hasSource: true,
      hasOutput: true,
      hasExport: true,
      hasSecondProvider: true,
    });
    expect(completeView.nextAction).toBeNull();
  });
});
