export interface AgentPlanInput {
  readonly goal: string;
  readonly sources: readonly {
    readonly id: string;
    readonly label: string;
    readonly chars: number;
  }[];
  readonly toolLabels: readonly string[];
  readonly stepsAllowed: number;
  readonly providerLabel: string;
}

export interface AgentPlanStep {
  readonly title: string;
  readonly detail: string;
}

export interface AgentPlan {
  readonly summary: string;
  readonly steps: readonly AgentPlanStep[];
  readonly reads: readonly string[];
  readonly mayUse: readonly string[];
  readonly leavesThisMac: string;
  readonly warnings: readonly string[];
  readonly refusedBecause: string | null;
}

function checkRefusal(input: AgentPlanInput): string | null {
  const trimmed = input.goal.trim();
  if (trimmed.length === 0) {
    return "Please provide a goal. The goal cannot be blank.";
  }
  if (trimmed.length < 3) {
    return "The goal must be at least 3 characters long.";
  }
  if (input.goal.length > 10000) {
    return "The goal is too long. Please keep it under 10,000 characters.";
  }
  if (input.stepsAllowed < 1) {
    return "Steps allowed must be at least 1.";
  }
  return null;
}

function buildSummary(hasSources: boolean, hasQuestion: boolean, asksToDraft: boolean): string {
  if (hasSources) {
    if (asksToDraft) {
      return "Review your selected sources and produce a draft to achieve your goal.";
    }
    if (hasQuestion) {
      return "Review your selected sources and answer your question.";
    }
    return "Review your selected sources and carry out your request.";
  }
  if (asksToDraft) {
    return "Produce a draft according to your instructions.";
  }
  if (hasQuestion) {
    return "Work through your instructions and answer your question.";
  }
  return "Work through your instructions to achieve your goal.";
}

function buildLeavesThisMac(providerLabel: string, hasSources: boolean): string {
  const label = providerLabel.trim();
  if (label.length === 0 || label.toLowerCase() === "local") {
    return "Nothing leaves this Mac.";
  }
  if (hasSources) {
    return `Your goal and selected sources will be sent to your ${label} subscription.`;
  }
  return `Your goal will be sent to your ${label} subscription.`;
}

function buildWarnings(input: AgentPlanInput): readonly string[] {
  const warnings: string[] = [];

  if (input.sources.length === 0) {
    warnings.push("No files are selected, so it can only use what you typed.");
  }

  for (const source of input.sources) {
    if (source.chars > 200000) {
      warnings.push(`${source.label} is over 200,000 characters and may take longer to read.`);
    }
  }

  if (input.stepsAllowed > 12) {
    warnings.push("This could take a while and use a lot of your subscription.");
  }

  return warnings;
}

function deriveSteps(goal: string, hasSources: boolean): readonly AgentPlanStep[] {
  const hasQuestionWord = /\b(what|why|how|who|when|where|which|whose|whom)\b/i.test(goal) || goal.includes("?");
  const mentionsFiles = /\b(file|files|document|documents|doc|docs|spreadsheet|spreadsheets|sheet|sheets|pdf|pdfs|csv|csvs|source|sources|attachment|attachments)\b/i.test(goal);
  const asksToDraft = /\b(write|draft|drafting|compose|author)\b/i.test(goal);

  const steps: AgentPlanStep[] = [];

  // Determine the leading step based on question words or file references.
  if (hasQuestionWord) {
    steps.push({
      title: "Understand the question",
      detail: "Identify what you are asking and determine what information is needed.",
    });
  } else if (mentionsFiles) {
    steps.push({
      title: hasSources ? "Read the selected sources" : "Read the referenced files",
      detail: hasSources
        ? "Review your selected sources to find the relevant information."
        : "Review the referenced files to find the relevant information.",
    });
  } else {
    steps.push({
      title: "Understand the goal",
      detail: "Break down what you want to achieve and plan the approach.",
    });
  }

  // Follow question understanding with reading materials when files or sources are present.
  if (hasQuestionWord && (mentionsFiles || hasSources)) {
    steps.push({
      title: hasSources ? "Read the selected sources" : "Read the referenced files",
      detail: hasSources
        ? "Review your selected sources to find facts relevant to your question."
        : "Review the referenced files to find facts relevant to your question.",
    });
  }

  // Intermediate reasoning or preparation step.
  if (asksToDraft) {
    steps.push({
      title: "Analyse the details",
      detail: "Work through the gathered information to prepare the key points for drafting.",
    });
  } else if (hasSources) {
    steps.push({
      title: "Analyse the findings",
      detail: "Work through the gathered information step by step to address your goal.",
    });
  }

  // Concluding steps: drafting and/or checking.
  if (asksToDraft) {
    steps.push({
      title: "Produce the draft",
      detail: "Write out the response clearly according to your instructions.",
    });
  }

  if (hasSources) {
    // A run with sources must always conclude by checking against those sources.
    steps.push({
      title: "Check against sources",
      detail: "Verify the findings against your selected sources to ensure accuracy.",
    });
  } else if (!asksToDraft) {
    steps.push({
      title: "Review and present answer",
      detail: "Review the findings and present a clear answer to your request.",
    });
  }

  // Clamp step count to house bounds between 2 and 6.
  if (steps.length < 2) {
    steps.push({
      title: "Review and present answer",
      detail: "Review the findings and present a clear answer to your request.",
    });
  }

  if (steps.length > 6) {
    const lastStep = steps[steps.length - 1];
    if (lastStep !== undefined) {
      steps.length = 5;
      steps.push(lastStep);
    }
  }

  return steps;
}

export function planAgentRun(input: AgentPlanInput): AgentPlan {
  const refusedBecause = checkRefusal(input);
  const reads = input.sources.map((s) => s.label);
  const mayUse = [...input.toolLabels];

  if (refusedBecause !== null) {
    return {
      summary: "This run cannot proceed.",
      steps: [],
      reads,
      mayUse,
      leavesThisMac: "Nothing leaves this Mac.",
      warnings: [],
      refusedBecause,
    };
  }

  const hasSources = input.sources.length > 0;
  const hasQuestionWord = /\b(what|why|how|who|when|where|which|whose|whom)\b/i.test(input.goal) || input.goal.includes("?");
  const asksToDraft = /\b(write|draft|drafting|compose|author)\b/i.test(input.goal);

  return {
    summary: buildSummary(hasSources, hasQuestionWord, asksToDraft),
    steps: deriveSteps(input.goal, hasSources),
    reads,
    mayUse,
    leavesThisMac: buildLeavesThisMac(input.providerLabel, hasSources),
    warnings: buildWarnings(input),
    refusedBecause: null,
  };
}
