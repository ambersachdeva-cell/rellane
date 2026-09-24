export interface Progress {
  readonly hasSource: boolean;
  readonly hasSentRequest: boolean;
  readonly hasOutput: boolean;
  readonly hasExport: boolean;
  readonly hasSecondProvider: boolean;
  readonly connectionsDetected: number;
}

export interface Step {
  readonly id: "connect" | "ask" | "context" | "output" | "export" | "compare";
  readonly title: string;
  readonly detail: string;
  readonly done: boolean;
  readonly current: boolean;
}

export interface OnboardingView {
  readonly steps: readonly Step[];
  readonly completed: number;
  readonly headline: string;
  /** Null once everything is done — the guide must get out of the way. */
  readonly nextAction: string | null;
  readonly finished: boolean;
}

interface StepBlueprint {
  readonly id: Step["id"];
  readonly title: string;
  readonly detail: string;
  readonly isDone: (progress: Progress) => boolean;
}

const STEP_BLUEPRINTS: readonly StepBlueprint[] = [
  {
    id: "connect",
    title: "Connect a subscription",
    detail: "Connect your subscription so you can run tasks on your Mac.",
    isDone: (progress) =>
      typeof progress.connectionsDetected === "number" &&
      Number.isFinite(progress.connectionsDetected) &&
      progress.connectionsDetected > 0,
  },
  {
    id: "ask",
    title: "Ask something",
    detail: "Review and approve your prompt before anything is sent.",
    isDone: (progress) => progress.hasSentRequest === true,
  },
  {
    id: "context",
    title: "Bring in a file",
    detail: "Add a file so answers can cite it.",
    isDone: (progress) => progress.hasSource === true,
  },
  {
    id: "output",
    title: "Save an output",
    detail: "Keep the response in your workspace so you can return to it.",
    isDone: (progress) => progress.hasOutput === true,
  },
  {
    id: "export",
    title: "Export it",
    detail: "Export your work so you can use it outside Rellane.",
    isDone: (progress) => progress.hasExport === true,
  },
  {
    id: "compare",
    title: "Try a second AI on the same work",
    detail: "Run another model on the same brief so you can compare answers.",
    isDone: (progress) => progress.hasSecondProvider === true,
  },
] as const;

export function onboardingView(progress: Progress): OnboardingView {
  // Gracefully normalise missing or unshaped input so non-programmer workflows never crash.
  const safeProgress: Progress = {
    hasSource: progress?.hasSource === true,
    hasSentRequest: progress?.hasSentRequest === true,
    hasOutput: progress?.hasOutput === true,
    hasExport: progress?.hasExport === true,
    hasSecondProvider: progress?.hasSecondProvider === true,
    connectionsDetected:
      typeof progress?.connectionsDetected === "number" &&
      Number.isFinite(progress.connectionsDetected)
        ? progress.connectionsDetected
        : 0,
  };

  // State is evaluated independently without back-filling so out-of-order usage is honestly represented.
  const stepBases = STEP_BLUEPRINTS.map((blueprint) => ({
    id: blueprint.id,
    title: blueprint.title,
    detail: blueprint.detail,
    done: blueprint.isDone(safeProgress),
  }));

  // Guide focus settles on the earliest incomplete milestone to provide an honest, unblocked next step.
  const firstNotDoneId = stepBases.find((step) => !step.done)?.id;

  const steps: readonly Step[] = stepBases.map((step) => ({
    id: step.id,
    title: step.title,
    detail: step.detail,
    done: step.done,
    current: step.id === firstNotDoneId,
  }));

  const completed = steps.filter((step) => step.done).length;
  const finished = completed === steps.length;
  const headline = finished ? "All steps complete" : `${completed} of ${steps.length} done`;

  // Provide a direct action prompt until all milestones are met, then clear it to let the owner work uninterrupted.
  const currentStep = steps.find((step) => step.current);
  const nextAction = currentStep !== undefined ? `${currentStep.title}.` : null;

  return {
    steps,
    completed,
    headline,
    nextAction,
    finished,
  };
}
