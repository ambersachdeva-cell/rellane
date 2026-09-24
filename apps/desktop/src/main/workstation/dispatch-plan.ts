export interface AvailableProvider {
  readonly id: string;
  readonly label: string;
  readonly canApproveTools: boolean;
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  /** The exact request that would be reviewed before it is sent. */
  readonly prompt: string;
  readonly providerId: string;
  readonly providerLabel: string;
  /** Source ids this step would carry. May be empty. */
  readonly sourceIds: readonly string[];
  /** Step ids that must finish first. Empty means it can start immediately. */
  readonly dependsOn: readonly string[];
}

export interface DispatchPlan {
  readonly steps: readonly PlanStep[];
  /** Steps with no unmet dependency, in the order they should be offered. */
  readonly parallel: readonly string[];
  /** One plain sentence describing what would happen, for the review. */
  readonly summary: string;
  /** Why a plan could not be made. Null when steps is non-empty. */
  readonly refusal: string | null;
}

export const MAX_STEPS = 6;

interface ParsedClause {
  readonly text: string;
  readonly isSequential: boolean;
}

const SPLIT_THEN_REGEX =
  /\s*(?:,\s*)?\band\s+then\b\s*|\s*(?:,\s*)\bthen\b\s*|\s+\bthen\b\s*/i;

const DEPENDENCY_REGEX =
  /^(?:(?:and\s+)?then|after\s+that|afterwards)\b|\b(?:from\s+(?:that|this|it|those)|based\s+on\s+(?:that|this|it|those|the\s+above)|using\s+(?:that|this|it|the\s+(?:output|results?)))\b/i;

const LIST_LINE_REGEX = /^(?:\d+[\.)]|[-*•])\s+(.+)$/;

function parseListLines(goal: string): readonly ParsedClause[] | null {
  const lines = goal
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return null;
  }

  const listItems: ParsedClause[] = [];
  for (const line of lines) {
    const match = LIST_LINE_REGEX.exec(line);
    if (match?.[1]) {
      listItems.push({
        text: match[1].trim(),
        isSequential: false
      });
    }
  }

  // A list must contain at least two items to represent structured steps.
  if (listItems.length >= 2) {
    return listItems;
  }

  return null;
}

function parseSemicolons(goal: string): readonly ParsedClause[] | null {
  if (!goal.includes(";")) {
    return null;
  }

  const parts = goal
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2) {
    return null;
  }

  return parts.map((text) => ({
    text,
    isSequential: false
  }));
}

function parseThen(goal: string): readonly ParsedClause[] | null {
  const parts = goal
    .split(SPLIT_THEN_REGEX)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length < 2) {
    return null;
  }

  // Delimiters like 'and then' signify intentional sequential dependencies.
  return parts.map((text, index) => ({
    text,
    isSequential: index > 0
  }));
}

function deriveTitle(prompt: string): string {
  // Trailing punctuation is stripped so review headings remain clean.
  const cleaned = prompt.replace(/[.;]+$/u, "").trim();
  const base = cleaned.length > 0 ? cleaned : prompt;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function formatProviderList(labels: readonly string[]): string {
  const first = labels[0];
  if (!first) {
    return "";
  }
  if (labels.length === 1) {
    return first;
  }
  const second = labels[1];
  if (labels.length === 2 && second) {
    return `${first} and ${second}`;
  }
  const allExceptLast = labels.slice(0, -1).join(", ");
  const last = labels[labels.length - 1];
  return `${allExceptLast} and ${last ?? ""}`;
}

function buildSummary(steps: readonly PlanStep[], parallel: readonly string[]): string {
  if (steps.length === 0) {
    return "No steps can run.";
  }

  const stepCount = steps.length;
  const stepLabel = stepCount === 1 ? "step" : "steps";
  const parallelCount = parallel.length;
  const labels = steps.map((s) => s.providerLabel);
  const providerList = formatProviderList(labels);
  const preposition = stepCount === 1 ? "on" : "across";

  return `${stepCount} ${stepLabel} planned ${preposition} ${providerList}, with ${parallelCount} able to start at once.`;
}

export function planDispatch(input: {
  readonly goal: string;
  readonly sourceIds: readonly string[];
  readonly providers: readonly AvailableProvider[];
}): DispatchPlan {
  const trimmedGoal = input.goal.trim();

  // Goals under 12 characters or missing subscriptions cannot form a valid dispatch request.
  if (trimmedGoal.length < 12) {
    return {
      steps: [],
      parallel: [],
      summary: "No steps can run.",
      refusal: "A goal of at least 12 characters is required to make a plan."
    };
  }

  if (input.providers.length === 0) {
    return {
      steps: [],
      parallel: [],
      summary: "No steps can run.",
      refusal: "No subscriptions are available to run this goal."
    };
  }

  // The session pool enforces one session per provider, so deduplicate.
  const seenProviderIds = new Set<string>();
  const uniqueProviders: AvailableProvider[] = [];
  for (const provider of input.providers) {
    if (!seenProviderIds.has(provider.id)) {
      seenProviderIds.add(provider.id);
      uniqueProviders.push(provider);
    }
  }

  if (uniqueProviders.length === 0) {
    return {
      steps: [],
      parallel: [],
      summary: "No steps can run.",
      refusal: "No subscriptions are available to run this goal."
    };
  }

  const parsedClauses =
    parseListLines(input.goal) ??
    parseSemicolons(input.goal) ??
    parseThen(input.goal) ??
    [{ text: trimmedGoal, isSequential: false }];

  // Cap steps at MAX_STEPS and available providers to avoid assigning multiple steps to one subscription.
  const maxAllowedSteps = Math.min(MAX_STEPS, uniqueProviders.length);
  const selectedClauses = parsedClauses.slice(0, maxAllowedSteps);

  const steps: PlanStep[] = [];
  for (let i = 0; i < selectedClauses.length; i++) {
    const clause = selectedClauses[i];
    const provider = uniqueProviders[i];
    if (!clause || !provider) {
      break;
    }

    const hasDependency =
      i > 0 && (clause.isSequential || DEPENDENCY_REGEX.test(clause.text));
    const priorStepId = `step-${i}`;
    const dependsOn: readonly string[] = hasDependency ? [priorStepId] : [];

    steps.push({
      id: `step-${i + 1}`,
      title: deriveTitle(clause.text),
      prompt: clause.text.trim(),
      providerId: provider.id,
      providerLabel: provider.label,
      // Every step receives all source IDs because guessing narrows context silently.
      sourceIds: input.sourceIds,
      dependsOn
    });
  }

  const parallel: readonly string[] = steps
    .filter((step) => step.dependsOn.length === 0)
    .map((step) => step.id);

  return {
    steps,
    parallel,
    summary: buildSummary(steps, parallel),
    refusal: null
  };
}
