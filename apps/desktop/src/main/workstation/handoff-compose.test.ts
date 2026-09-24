import { describe, expect, it } from "vitest";
import {
  composeWithHandoff,
  HANDOFF_HEADING,
  type ComposeInput,
} from "./handoff-compose.js";

describe("composeWithHandoff", () => {
  const baseInput: ComposeInput = {
    providerId: "claude",
    lastProviderId: "codex",
    briefText: "Codex: Established authentication flow using local tokens.",
    prompt: "Now implement the sign-out route.",
    budgetChars: 1_000,
  };

  it("does not carry when there is no previous provider", () => {
    const input: ComposeInput = {
      ...baseInput,
      lastProviderId: null,
    };
    const result = composeWithHandoff(input);

    expect(result.carried).toBe(false);
    expect(result.composed).toBe(input.prompt);
    expect(result.reviewNote).toBeNull();
    expect(result.skipped).toBe("No previous provider has answered in this work.");
  });

  it("does not carry when the same provider continues the session", () => {
    const input: ComposeInput = {
      ...baseInput,
      providerId: "codex",
      lastProviderId: "codex",
    };
    const result = composeWithHandoff(input);

    expect(result.carried).toBe(false);
    expect(result.composed).toBe(input.prompt);
    expect(result.reviewNote).toBeNull();
    expect(result.skipped).toBe("The same provider is continuing this session.");
  });

  it("treats provider identifiers with surrounding whitespace as identical", () => {
    const input: ComposeInput = {
      ...baseInput,
      providerId: "claude",
      lastProviderId: " claude ",
    };
    const result = composeWithHandoff(input);

    expect(result.carried).toBe(false);
    expect(result.composed).toBe(input.prompt);
    expect(result.reviewNote).toBeNull();
    expect(result.skipped).toBe("The same provider is continuing this session.");
  });

  it("does not carry when the brief is empty or whitespace-only", () => {
    const emptyResult = composeWithHandoff({
      ...baseInput,
      briefText: "",
    });
    expect(emptyResult.carried).toBe(false);
    expect(emptyResult.composed).toBe(baseInput.prompt);
    expect(emptyResult.reviewNote).toBeNull();
    expect(emptyResult.skipped).toBe("The handoff brief is empty.");

    const whitespaceResult = composeWithHandoff({
      ...baseInput,
      briefText: "   \n\t  \n  ",
    });
    expect(whitespaceResult.carried).toBe(false);
    expect(whitespaceResult.composed).toBe(baseInput.prompt);
    expect(whitespaceResult.reviewNote).toBeNull();
    expect(whitespaceResult.skipped).toBe("The handoff brief is empty.");
  });

  it("carries the brief when provider changed with a real brief", () => {
    const result = composeWithHandoff(baseInput);

    expect(result.carried).toBe(true);
    expect(result.skipped).toBeNull();
    expect(result.reviewNote).not.toBeNull();
    expect(result.composed).toContain(HANDOFF_HEADING);
    expect(result.composed).toContain(baseInput.briefText);
    expect(result.composed).toContain("---");
    expect(result.composed.endsWith(baseInput.prompt)).toBe(true);

    const expectedComposed = `${HANDOFF_HEADING}\n\n${baseInput.briefText}\n\n---\n\n${baseInput.prompt}`;
    expect(result.composed).toBe(expectedComposed);
  });

  it("does not carry when prompt plus brief exceeds the character budget", () => {
    const expectedComposed = `${HANDOFF_HEADING}\n\n${baseInput.briefText}\n\n---\n\n${baseInput.prompt}`;
    const overBudgetInput: ComposeInput = {
      ...baseInput,
      budgetChars: expectedComposed.length - 1,
    };
    const result = composeWithHandoff(overBudgetInput);

    expect(result.carried).toBe(false);
    expect(result.composed).toBe(overBudgetInput.prompt);
    expect(result.reviewNote).toBeNull();
    expect(result.skipped).not.toBeNull();
    expect(result.skipped).toContain(String(expectedComposed.length));
    expect(result.skipped).toContain(String(overBudgetInput.budgetChars));
    expect(result.composed).toHaveLength(overBudgetInput.prompt.length);
  });

  it("carries the brief when exactly at budget", () => {
    const expectedComposed = `${HANDOFF_HEADING}\n\n${baseInput.briefText}\n\n---\n\n${baseInput.prompt}`;
    const exactBudgetInput: ComposeInput = {
      ...baseInput,
      budgetChars: expectedComposed.length,
    };
    const result = composeWithHandoff(exactBudgetInput);

    expect(result.carried).toBe(true);
    expect(result.composed).toBe(expectedComposed);
    expect(result.skipped).toBeNull();
    expect(result.reviewNote).not.toBeNull();
  });

  it("includes previous provider in reviewNote and addresses the user without mentioning the owner", () => {
    const input: ComposeInput = {
      ...baseInput,
      lastProviderId: "Claude 3.5 Sonnet",
    };
    const result = composeWithHandoff(input);

    expect(result.carried).toBe(true);
    expect(result.reviewNote).not.toBeNull();
    const note = result.reviewNote!;
    expect(note).toContain("Claude 3.5 Sonnet");
    expect(note.toLowerCase()).toContain("you");
    expect(note.toLowerCase()).not.toContain("owner");
    expect(note).toBe("A summary of earlier work produced by Claude 3.5 Sonnet is included for you to review.");
  });

  it("is deterministic across repeated calls with identical inputs", () => {
    const firstCall = composeWithHandoff(baseInput);
    const secondCall = composeWithHandoff(baseInput);

    expect(firstCall.composed).toBe(secondCall.composed);
    expect(firstCall.carried).toBe(secondCall.carried);
    expect(firstCall.reviewNote).toBe(secondCall.reviewNote);
    expect(firstCall.skipped).toBe(secondCall.skipped);
  });

  it("guarantees composed is byte-identical to prompt whenever not carried", () => {
    const promptWithOddSpacing = "  Keep this spacing\n\n\tand indentation intact.\t  ";
    const uncarriedInput: ComposeInput = {
      providerId: "claude",
      lastProviderId: "claude",
      briefText: "Some brief",
      prompt: promptWithOddSpacing,
      budgetChars: 1_000,
    };
    const result = composeWithHandoff(uncarriedInput);

    expect(result.carried).toBe(false);
    expect(result.composed).toBe(promptWithOddSpacing);
  });
});
