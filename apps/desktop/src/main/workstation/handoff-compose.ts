export interface ComposeInput {
  /** The provider about to run. */
  readonly providerId: string;
  /** The provider that last answered in this work, or null when none has. */
  readonly lastProviderId: string | null;
  /** The brief text from handoff-brief.ts. May be empty. */
  readonly briefText: string;
  /** The request the owner typed. */
  readonly prompt: string;
  /** Hard ceiling for prompt + brief together. */
  readonly budgetChars: number;
}

export interface ComposeResult {
  /** What would be sent. Equals `prompt` exactly when no brief is carried. */
  readonly composed: string;
  readonly carried: boolean;
  /** One sentence for the review, or null when nothing is carried. */
  readonly reviewNote: string | null;
  /** Why nothing was carried, when it was not. Null when it was. */
  readonly skipped: string | null;
}

export const HANDOFF_HEADING = "What this work has established so far";

export function composeWithHandoff(input: ComposeInput): ComposeResult {
  // A handoff only makes sense when a different provider answered previously.
  // The first turn in a work has no prior context to carry forward.
  if (input.lastProviderId === null || input.lastProviderId.trim().length === 0) {
    return {
      composed: input.prompt,
      carried: false,
      reviewNote: null,
      skipped: "No previous provider has answered in this work.",
    };
  }

  const currentProvider = input.providerId.trim();
  const previousProvider = input.lastProviderId.trim();

  // Continuing with the same provider retains that provider's existing session;
  // repeating previous turns would waste context window and token budget.
  if (currentProvider === previousProvider) {
    return {
      composed: input.prompt,
      carried: false,
      reviewNote: null,
      skipped: "The same provider is continuing this session.",
    };
  }

  const trimmedBrief = input.briefText.trim();
  if (trimmedBrief.length === 0) {
    return {
      composed: input.prompt,
      carried: false,
      reviewNote: null,
      skipped: "The handoff brief is empty.",
    };
  }

  // Prepend the brief under the heading and separate from the owner's request
  // with a horizontal divider so the new request remains the final thing read.
  const composed = `${HANDOFF_HEADING}\n\n${trimmedBrief}\n\n---\n\n${input.prompt}`;

  // When the composed request exceeds budget, drop the brief rather than truncating
  // the owner's prompt. The owner's typed words are strictly non-negotiable.
  if (!Number.isFinite(input.budgetChars) || composed.length > input.budgetChars) {
    return {
      composed: input.prompt,
      carried: false,
      reviewNote: null,
      skipped: `The combined request (${composed.length} characters) exceeds the budget of ${input.budgetChars} characters.`,
    };
  }

  return {
    composed,
    carried: true,
    reviewNote: `A summary of earlier work produced by ${previousProvider} is included for you to review.`,
    skipped: null,
  };
}
