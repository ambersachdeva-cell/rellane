import { describe, expect, it } from "vitest";
import {
  planResearch,
  MAX_SUB_QUESTIONS,
  MIN_SUB_QUESTIONS
} from "./research-plan.js";

describe("planResearch", () => {
  it("decomposes a supplier comparison question without URLs into four sub-questions and flags live pricing as unanswerable", () => {
    const plan = planResearch({
      question: "Should I switch supplier for aluminium sections?",
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(4);

    const q1 = plan.subQuestions[0]!;
    const q2 = plan.subQuestions[1]!;
    const q3 = plan.subQuestions[2]!;
    const q4 = plan.subQuestions[3]!;

    expect(q1.question.toLowerCase()).toContain("cost");
    expect(q2.question.toLowerCase()).toContain("alternative");
    expect(q3.question.toLowerCase()).toContain("files");
    expect(q3.looksIn).toEqual(["your-files"]);
    expect(q4.question.toLowerCase()).toContain("alter");
    expect(q4.dependsOn).toEqual(["sub-1", "sub-2"]);

    expect(plan.unanswerable).toEqual([
      "Nobody here can look up today's price. Give me a page and I will read it."
    ]);
    expect(plan.summary).toBe(
      "Four research questions planned to compare your options, examining costs, trade-offs, and your files."
    );
  });

  it("clears unanswerable pricing when URLs are provided in the input", () => {
    const plan = planResearch({
      question: "Should I switch supplier for aluminium sections?",
      haveFiles: true,
      haveUrls: ["https://example.com/aluminium-pricing"],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.unanswerable).toEqual([]);
    expect(plan.subQuestions[0]!.looksIn).toContain("a-page-you-gave");
  });

  it("detects embedded URLs directly within the question text", () => {
    const plan = planResearch({
      question: "Should I switch supplier to https://metalsupplies.co.uk/prices for our aluminium sections?",
      haveFiles: false,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.unanswerable).toEqual([]);
    expect(plan.subQuestions[0]!.looksIn).toContain("a-page-you-gave");
  });

  it("refuses a single-word question with a plain British English explanation", () => {
    const plan = planResearch({
      question: "Aluminium?",
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.subQuestions).toHaveLength(0);
    expect(plan.refusedBecause).toBe(
      "Ask a full question rather than a single word so we can work out what would answer it."
    );
    expect(plan.summary).toBe("Your question is too short to plan research for.");
  });

  it("refuses an empty or whitespace-only question", () => {
    const plan = planResearch({
      question: "   ",
      haveFiles: false,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.subQuestions).toHaveLength(0);
    expect(plan.refusedBecause).toBe("Enter a question so we can work out what would answer it.");
  });

  it("refuses a question exceeding 10,000 characters", () => {
    const longQuestion = "Should I switch? ".repeat(600);
    expect(longQuestion.length).toBeGreaterThan(10000);

    const plan = planResearch({
      question: longQuestion,
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.subQuestions).toHaveLength(0);
    expect(plan.refusedBecause).toBe(
      "Your question is too long to plan research for. Keep it under 10,000 characters."
    );
  });

  it("decomposes a 'what is' question into definition, specific application, prerequisites, and failure modes", () => {
    const plan = planResearch({
      question: "What is reverse charge VAT?",
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(4);
    expect(plan.subQuestions[0]!.question.toLowerCase()).toContain("definition");
    expect(plan.subQuestions[1]!.question.toLowerCase()).toContain("apply");
    expect(plan.subQuestions[1]!.looksIn).toContain("your-files");
    expect(plan.subQuestions[2]!.question.toLowerCase()).toContain("prerequisites");
    expect(plan.subQuestions[3]!.question.toLowerCase()).toContain("commonly goes wrong");
    expect(plan.unanswerable).toEqual([]);
  });

  it("decomposes a 'should I' question into costs, savings, break-even conditions, and prior decisions", () => {
    const plan = planResearch({
      question: "Should I buy an electric delivery van?",
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(4);
    expect(plan.subQuestions[0]!.question.toLowerCase()).toContain("cost");
    expect(plan.subQuestions[1]!.question.toLowerCase()).toContain("save");
    expect(plan.subQuestions[2]!.question.toLowerCase()).toContain("pay for itself");
    expect(plan.subQuestions[3]!.question.toLowerCase()).toContain("files");
    expect(plan.subQuestions[3]!.looksIn).toEqual(["your-files"]);
  });

  it("decomposes a 'what changed' question into prior baseline, current state, timing, and business impact", () => {
    const plan = planResearch({
      question: "What changed in the building regulations since October?",
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(4);
    expect(plan.subQuestions[0]!.question.toLowerCase()).toContain("previous");
    expect(plan.subQuestions[1]!.question.toLowerCase()).toContain("current");
    expect(plan.subQuestions[2]!.question.toLowerCase()).toContain("take effect");
    expect(plan.subQuestions[3]!.question.toLowerCase()).toContain("affect your specific workflow");
  });

  it("decomposes general questions into knowns, missing items, and settling proof", () => {
    const plan = planResearch({
      question: "Can we deliver the project to Birmingham before Thursday?",
      haveFiles: false,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(3);
    expect(plan.subQuestions[0]!.question.toLowerCase()).toContain("facts");
    expect(plan.subQuestions[1]!.question.toLowerCase()).toContain("missing");
    expect(plan.subQuestions[2]!.question.toLowerCase()).toContain("settle");
    expect(plan.summary).toBe(
      "Three research questions planned to establish what is known, what is missing, and what settles your question."
    );
  });

  it("preserves questions already formatted as lists and caps them at six sub-questions", () => {
    const listText = `1. Check aluminium prices\n2. Review supplier lead times\n3. Inspect existing invoices\n4. Compare credit terms\n5. Check minimum order quantities\n6. Assess delivery reliability\n7. Check surcharge policies\n8. Evaluate return procedures`;

    const plan = planResearch({
      question: listText,
      haveFiles: true,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(MAX_SUB_QUESTIONS);
    expect(plan.subQuestions.length).toBeLessThanOrEqual(MAX_SUB_QUESTIONS);
    expect(plan.subQuestions.length).toBeGreaterThanOrEqual(MIN_SUB_QUESTIONS);
    expect(plan.summary).toContain("capped at 6 from 8 items");
  });

  it("handles requests with neither files nor URLs without throwing", () => {
    const plan = planResearch({
      question: "Should I switch supplier for aluminium sections?",
      haveFiles: false,
      haveUrls: [],
      now: 1700000000000
    });

    expect(plan.refusedBecause).toBeNull();
    expect(plan.subQuestions).toHaveLength(4);
    expect(plan.unanswerable).toEqual([
      "Nobody here can look up today's price. Give me a page and I will read it."
    ]);
    expect(plan.subQuestions[0]!.looksIn).toEqual(["the-subscription"]);
  });
});
