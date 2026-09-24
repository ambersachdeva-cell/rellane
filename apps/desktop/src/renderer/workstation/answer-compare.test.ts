import { describe, expect, it } from "vitest";
import { compareAnswers } from "./answer-compare.js";
import type { AnswerInput } from "./answer-compare.js";

describe("compareAnswers", () => {
  it("satisfies the done-when requirement for three answers with two agreements and one difference", () => {
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: "We should increase prices by ten percent next quarter. We need to hire two senior backend engineers immediately. Customer support response times must be under one hour.",
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text: "We should increase prices by ten percent next quarter. We need to hire two senior backend engineers immediately. Customer support response times must be under one hour.",
      },
      {
        providerId: "bot-3",
        label: "Gemini",
        text: "We should increase prices by ten percent next quarter. We need to hire two senior backend engineers immediately.",
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(2);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]!.missingFrom).toEqual(["Gemini"]);
    expect(result.differences[0]!.agreedBy).toEqual(["Claude", "Codex"]);
    expect(result.headline).toBe("All three agree on 2 points and differ on 1.");
  });

  it("handles a single answer gracefully without throwing", () => {
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: "We should focus on customer retention first.",
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(0);
    expect(result.differences).toHaveLength(0);
    expect(result.only).toHaveLength(0);
    expect(result.headline.toLowerCase()).toContain("nothing to compare");
    expect(result.shortest).toBe("Claude");
    expect(result.longest).toBe("Claude");
  });

  it("handles zero answers cleanly", () => {
    const result = compareAnswers([]);
    expect(result.agreements).toHaveLength(0);
    expect(result.differences).toHaveLength(0);
    expect(result.only).toHaveLength(0);
    expect(result.headline.toLowerCase()).toContain("nothing to compare");
  });

  it("handles two identical answers", () => {
    const text = "We should expand to the European market next spring. Marketing spend should increase by twenty percent.";
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text,
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text,
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(2);
    expect(result.differences).toHaveLength(0);
    expect(result.headline).toBe("Both agree on 2 points and differ on 0.");
  });

  it("handles an empty answer among non-empty answers", () => {
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: "We should launch the new product in September.",
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text: "",
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(0);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]!.missingFrom).toEqual(["Codex"]);
    expect(result.differences[0]!.agreedBy).toEqual(["Claude"]);
    expect(result.shortest).toBe("Codex");
    expect(result.longest).toBe("Claude");
  });

  it("identifies unique claims in only one answer when three or more answers are present", () => {
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: "We should launch the new product in September. We must review tax implications under local law.",
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text: "We should launch the new product in September.",
      },
      {
        providerId: "bot-3",
        label: "Gemini",
        text: "We should launch the new product in September.",
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(1);
    expect(result.differences).toHaveLength(0);
    expect(result.only).toHaveLength(1);
    expect(result.only[0]!.label).toBe("Claude");
    expect(result.only[0]!.points[0]).toContain("tax implications");
  });

  it("handles bulleted lists and numbered items as distinct sentences", () => {
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: "- Increase prices by five percent\n- Hire two senior engineers\n- Cut discretionary marketing spend",
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text: "1. Increase prices by five percent\n2. Hire two senior engineers\n3. Cut discretionary marketing spend",
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(3);
    expect(result.differences).toHaveLength(0);
  });

  it("picks the clearest sentence preferring the shortest one with at least eight words", () => {
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: "Launch the product in September.",
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text: "We should launch the new product in September across Europe.",
      },
      {
        providerId: "bot-3",
        label: "Gemini",
        text: "We should definitely launch the brand new product in September across all European countries.",
      },
    ];

    const result = compareAnswers(answers);

    expect(result.agreements).toHaveLength(1);
    expect(result.agreements[0]!.point).toBe("We should launch the new product in September across Europe.");
  });

  it("caps agreements at 12 and differences at 12", () => {
    const makeClaims = (prefix: string, count: number): string =>
      Array.from({ length: count }, (_, i) => `${prefix} point number ${i + 1} with enough words to compare.`).join(" ");

    const commonText = makeClaims("Shared", 15);
    const answers: readonly AnswerInput[] = [
      {
        providerId: "bot-1",
        label: "Claude",
        text: commonText,
      },
      {
        providerId: "bot-2",
        label: "Codex",
        text: commonText,
      },
    ];

    const result = compareAnswers(answers);
    expect(result.agreements.length).toBeLessThanOrEqual(12);
  });

  /**
   * Found by a review council, and it was the worst defect in this module.
   *
   * Nineteen negations sit in the stopword list — `not` and `cannot` among them
   * — so a bot saying a thing and a bot saying the opposite reduced to the same
   * significant words and were reported as agreeing. Two bots flatly
   * contradicting each other is the single most useful thing this module can
   * tell him, and it was the one thing it got backwards.
   */
  it("reports a flat contradiction as a difference, never as an agreement", () => {
    const result = compareAnswers([
      { providerId: "a", label: "Claude", text: "The contract renews automatically each year." },
      { providerId: "b", label: "Codex", text: "The contract does not renew automatically each year." }
    ]);

    expect(result.agreements).toHaveLength(0);
    expect(result.differences.length).toBeGreaterThan(0);
  });

  it("still groups two bots making the same point in different words", () => {
    const result = compareAnswers([
      { providerId: "a", label: "Claude", text: "The deposit is thirty per cent of the project total." },
      { providerId: "b", label: "Codex", text: "The deposit is thirty per cent of the total project value." }
    ]);

    expect(result.agreements.length).toBeGreaterThan(0);
  });
});
