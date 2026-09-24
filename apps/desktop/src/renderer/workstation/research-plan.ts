/**
 * research-plan.ts
 *
 * Decomposes an open research question into a structured plan of sub-questions,
 * identifying which local source can answer each part and stating plainly
 * what cannot be answered with current inputs.
 */

export type SourceKind = "your-files" | "a-page-you-gave" | "the-subscription";

export interface SubQuestion {
  readonly id: string;
  readonly question: string;
  readonly looksIn: readonly SourceKind[];
  readonly why: string;
  readonly dependsOn: readonly string[];
}

export interface ResearchPlan {
  readonly question: string;
  readonly subQuestions: readonly SubQuestion[];
  readonly summary: string;
  readonly unanswerable: readonly string[];
  readonly refusedBecause: string | null;
}

export const MAX_SUB_QUESTIONS = 6;
export const MIN_SUB_QUESTIONS = 2;
const MAX_QUESTION_LENGTH = 10000;

const LIST_LINE_REGEX = /^\s*(?:(?:\d+|[a-zA-Z])[\.\)]|[-*•])\s+(.+)$/;
const INLINE_LIST_REGEX = /(?:^|[\s(])([a-zA-Z]|\d{1,2})[\)\.]\s+/g;
const URL_REGEX = /\bhttps?:\/\/[^\s)\]>"',]+/gi;

function countWords(text: string): number {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  return tokens.length;
}

function extractUrls(text: string): readonly string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  const results: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const raw = matches[i]!;
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (cleaned.length > 0 && !results.includes(cleaned)) {
      results.push(cleaned);
    }
  }
  return results;
}

function parseListItems(text: string): readonly string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const listItems: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = LIST_LINE_REGEX.exec(line);
    if (match?.[1]) {
      const content = match[1].trim();
      if (content.length > 0) {
        listItems.push(content);
      }
    }
  }

  if (listItems.length >= 2) {
    return listItems;
  }

  const inlineMatches = Array.from(text.matchAll(INLINE_LIST_REGEX));
  if (inlineMatches.length >= 2) {
    const inlineItems: string[] = [];
    for (let i = 0; i < inlineMatches.length; i++) {
      const current = inlineMatches[i]!;
      if (current.index === undefined) continue;
      const start = current.index + current[0].length;
      const next = inlineMatches[i + 1];
      const end = next && next.index !== undefined ? next.index : text.length;
      const chunk = text.slice(start, end).replace(/\s*(?:,\s*)?(?:\band\b|[;,])\s*$/i, "").trim();
      if (chunk.length > 0) {
        inlineItems.push(chunk);
      }
    }
    if (inlineItems.length >= 2) {
      return inlineItems;
    }
  }

  return [];
}

type QuestionArchetype = "comparison" | "what-changed" | "what-is" | "should-i" | "general";

function detectArchetype(text: string): QuestionArchetype {
  // Comparison questions evaluate competing options, suppliers, or product choices.
  if (
    /\b(?:should\s+(?:I|we)\s+switch|switch\s+(?:supplier|vendor|from|to)|better\s+than|\bor\b|versus|\bvs\.?\b|compare|comparison|prefer)\b/i.test(
      text
    )
  ) {
    return "comparison";
  }

  // What-changed questions inspect differences over time, effective dates, and transitional impact.
  if (
    /\b(?:what(?:'s|\s+has)?\s+changed|any\s+changes|differences?\s+since|changed\s+since|what\s+is\s+different)\b/i.test(
      text
    )
  ) {
    return "what-changed";
  }

  // What-is and how-does questions examine technical definitions, operational mechanics, and common failures.
  if (/^(?:what\s+is|what\s+are|what\s+does|how\s+does|how\s+do|how\s+would|how\s+can|explain)\b/i.test(text)) {
    return "what-is";
  }

  // Should-I questions assess proposed investments, hires, or operational initiatives.
  if (/\b(?:should\s+(?:I|we)|is\s+it\s+worth|would\s+it\s+be\s+worth|ought\s+(?:I|we))\b/i.test(text)) {
    return "should-i";
  }

  // Broad or non-standard queries default to establishing confirmed facts, gaps, and definitive tests.
  return "general";
}

function buildComparisonPlan(hasUrls: boolean): readonly SubQuestion[] {
  return [
    {
      id: "sub-1",
      question: "What does each supplier option cost, including unit prices, delivery fees, and payment terms?",
      looksIn: hasUrls ? ["a-page-you-gave", "the-subscription"] : ["the-subscription"],
      why: "Comparing total costs reveals whether switching produces a genuine financial saving.",
      dependsOn: []
    },
    {
      id: "sub-2",
      question: "What alternatives exist, and what would you give up in lead times, quality, or reliability?",
      looksIn: ["the-subscription"],
      why: "Assessing alternatives and trade-offs prevents moving to a supplier that creates operational delays.",
      dependsOn: []
    },
    {
      id: "sub-3",
      question: "What do your existing files and records show about past orders, agreed rates, and supplier terms?",
      looksIn: ["your-files"],
      why: "Checking past records establishes your current baseline prices and historical performance.",
      dependsOn: []
    },
    {
      id: "sub-4",
      question: "What changes in order volume, material prices, or delivery deadlines would alter this decision?",
      looksIn: ["the-subscription"],
      why: "Testing sensitivity to volume or price shifts ensures the decision remains sound if circumstances change.",
      dependsOn: ["sub-1", "sub-2"]
    }
  ];
}

function buildWhatIsPlan(hasUrls: boolean, haveFiles: boolean): readonly SubQuestion[] {
  return [
    {
      id: "sub-1",
      question: "What is the standard definition and core principle of this?",
      looksIn: hasUrls ? ["a-page-you-gave", "the-subscription"] : ["the-subscription"],
      why: "Establishing the baseline definition clarifies what rules and standards apply.",
      dependsOn: []
    },
    {
      id: "sub-2",
      question: "How does this apply to your specific business operations and existing setup?",
      looksIn: haveFiles ? ["your-files", "the-subscription"] : ["the-subscription"],
      why: "Connecting the concept to your own business reveals the practical workflow changes needed.",
      dependsOn: ["sub-1"]
    },
    {
      id: "sub-3",
      question: "What prerequisites, regulatory approvals, or inputs does this depend on?",
      looksIn: ["the-subscription"],
      why: "Identifying mandatory prerequisites prevents starting before the necessary foundations are in place.",
      dependsOn: ["sub-1"]
    },
    {
      id: "sub-4",
      question: "What commonly goes wrong with this, and what pitfalls should you avoid?",
      looksIn: ["the-subscription"],
      why: "Reviewing common points of failure helps you guard against costly errors early.",
      dependsOn: ["sub-2", "sub-3"]
    }
  ];
}

function buildShouldIPlan(hasUrls: boolean): readonly SubQuestion[] {
  return [
    {
      id: "sub-1",
      question: "What would this cost upfront and over time, including fees and running costs?",
      looksIn: hasUrls ? ["a-page-you-gave", "the-subscription"] : ["the-subscription"],
      why: "Totalling all direct and indirect expenses establishes the true capital required.",
      dependsOn: []
    },
    {
      id: "sub-2",
      question: "What would this save in time, labour, or direct expenses once in place?",
      looksIn: ["the-subscription"],
      why: "Quantifying expected returns shows whether the financial gain justifies the disruption.",
      dependsOn: []
    },
    {
      id: "sub-3",
      question: "What conditions, sales volumes, or utilisation levels must be met for this to pay for itself?",
      looksIn: ["the-subscription"],
      why: "Pinpointing break-even assumptions lets you judge if the payoff is realistic.",
      dependsOn: ["sub-1", "sub-2"]
    },
    {
      id: "sub-4",
      question: "What have you already decided, spent, or recorded regarding this in your files?",
      looksIn: ["your-files"],
      why: "Reviewing past decisions and supplier notes ensures you build on prior work rather than repeating it.",
      dependsOn: []
    }
  ];
}

function buildWhatChangedPlan(hasUrls: boolean, haveFiles: boolean): readonly SubQuestion[] {
  return [
    {
      id: "sub-1",
      question: "What was the previous state, baseline specification, or original arrangement?",
      looksIn: haveFiles ? ["your-files", "the-subscription"] : ["the-subscription"],
      why: "Establishing the original baseline gives you a clear point of comparison.",
      dependsOn: []
    },
    {
      id: "sub-2",
      question: "What is the current wording, price, or updated specification now in effect?",
      looksIn: hasUrls ? ["a-page-you-gave", "the-subscription"] : ["the-subscription"],
      why: "Identifying the specific changes reveals what has actually been modified.",
      dependsOn: ["sub-1"]
    },
    {
      id: "sub-3",
      question: "When did these changes take effect, and what transition deadlines apply?",
      looksIn: ["the-subscription"],
      why: "Knowing effective dates and grace periods prevents unexpected compliance or penalty deadlines.",
      dependsOn: ["sub-2"]
    },
    {
      id: "sub-4",
      question: "How does this change affect your specific workflow, profit margins, or liabilities?",
      looksIn: haveFiles ? ["your-files", "the-subscription"] : ["the-subscription"],
      why: "Assessing the practical business impact determines whether you need to take action.",
      dependsOn: ["sub-2", "sub-3"]
    }
  ];
}

function buildGeneralPlan(haveFiles: boolean): readonly SubQuestion[] {
  return [
    {
      id: "sub-1",
      question: "What facts, documented constraints, and baseline requirements are already established?",
      looksIn: haveFiles ? ["your-files", "the-subscription"] : ["the-subscription"],
      why: "Gathering confirmed facts prevents making assumptions on unverified grounds.",
      dependsOn: []
    },
    {
      id: "sub-2",
      question: "What critical information, external figures, or third-party responses are still missing?",
      looksIn: ["the-subscription"],
      why: "Highlighting the information gaps shows what must be obtained before acting.",
      dependsOn: ["sub-1"]
    },
    {
      id: "sub-3",
      question: "What specific evidence, calculation, or confirmation would definitively settle this question?",
      looksIn: ["the-subscription"],
      why: "Defining the settling criteria lets you reach a conclusive decision without wasted research.",
      dependsOn: ["sub-1", "sub-2"]
    }
  ];
}

function buildListPlan(items: readonly string[], hasUrls: boolean, haveFiles: boolean): readonly SubQuestion[] {
  const cappedItems = items.slice(0, MAX_SUB_QUESTIONS);
  const subQuestions: SubQuestion[] = [];

  for (let i = 0; i < cappedItems.length; i++) {
    const raw = cappedItems[i]!;
    const cleaned = raw.replace(/[.;]+$/u, "").trim();
    const firstChar = cleaned.charAt(0).toUpperCase();
    const rest = cleaned.slice(1);
    const baseSentence = `${firstChar}${rest}`;
    const sentence = baseSentence.endsWith("?") ? baseSentence : `${baseSentence}.`;

    const mentionsFiles = /\b(?:file|files|invoice|invoices|contract|contracts|record|records|agreements?|past)\b/i.test(cleaned);
    const mentionsPrices = /\b(?:price|prices|pricing|quote|quotes|rates?|cost|costs)\b/i.test(cleaned);

    let looksIn: SourceKind[];
    if (mentionsFiles && haveFiles) {
      looksIn = ["your-files"];
    } else if (mentionsPrices && hasUrls) {
      looksIn = ["a-page-you-gave", "the-subscription"];
    } else if (hasUrls) {
      looksIn = ["a-page-you-gave", "the-subscription"];
    } else {
      looksIn = ["the-subscription"];
    }

    subQuestions.push({
      id: `sub-${i + 1}`,
      question: sentence,
      looksIn,
      why: `Investigating this question settles part ${i + 1} of your listed items.`,
      dependsOn: i > 0 && /\b(?:then|after\s+that|once|using\s+that)\b/i.test(cleaned) ? [`sub-${i}`] : []
    });
  }

  return subQuestions;
}

function determineUnanswerable(
  archetype: "list" | QuestionArchetype,
  question: string,
  hasUrls: boolean
): readonly string[] {
  // Providing a URL allows direct page fetching; absence of a URL means web price lookup is impossible.
  if (hasUrls) {
    return [];
  }

  const needsLivePricing =
    archetype === "comparison" ||
    /\b(?:prices?|pricing|rates?|quotes?|market\s+price|today'?s\s+price|live\s+price|supplier|switch)\b/i.test(
      question
    );

  if (needsLivePricing) {
    return ["Nobody here can look up today's price. Give me a page and I will read it."];
  }

  return [];
}

function buildSummary(
  archetype: "list" | QuestionArchetype,
  subQuestionCount: number,
  totalListItems: number
): string {
  if (archetype === "list") {
    if (totalListItems > MAX_SUB_QUESTIONS) {
      return `Six research questions planned from your list, capped at 6 from ${totalListItems} items to keep the investigation focused.`;
    }
    const countWord =
      subQuestionCount === 2
        ? "Two"
        : subQuestionCount === 3
        ? "Three"
        : subQuestionCount === 4
        ? "Four"
        : subQuestionCount === 5
        ? "Five"
        : "Six";
    return `${countWord} research questions planned from your list, addressing each item in turn.`;
  }

  switch (archetype) {
    case "comparison":
      return "Four research questions planned to compare your options, examining costs, trade-offs, and your files.";
    case "what-is":
      return "Four research questions planned to define this topic, apply it to your business, and identify pitfalls.";
    case "should-i":
      return "Four research questions planned to evaluate this decision, examining costs, expected savings, and break-even conditions.";
    case "what-changed":
      return "Four research questions planned to trace what changed, when it took effect, and whether it affects your business.";
    case "general":
      return "Three research questions planned to establish what is known, what is missing, and what settles your question.";
  }
}

export function planResearch(input: {
  readonly question: string;
  readonly haveFiles: boolean;
  readonly haveUrls: readonly string[];
  readonly now: number;
}): ResearchPlan {
  const normalized = input.question.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.trim();

  if (trimmed.length === 0) {
    return {
      question: input.question,
      subQuestions: [],
      summary: "No question was provided to plan research for.",
      unanswerable: [],
      refusedBecause: "Enter a question so we can work out what would answer it."
    };
  }

  if (input.question.length > MAX_QUESTION_LENGTH) {
    return {
      question: trimmed,
      subQuestions: [],
      summary: "Your question is too long to plan research for.",
      unanswerable: [],
      refusedBecause: "Your question is too long to plan research for. Keep it under 10,000 characters."
    };
  }

  const wordCount = countWords(trimmed);
  if (wordCount <= 1) {
    return {
      question: trimmed,
      subQuestions: [],
      summary: "Your question is too short to plan research for.",
      unanswerable: [],
      refusedBecause: "Ask a full question rather than a single word so we can work out what would answer it."
    };
  }

  const embeddedUrls = extractUrls(trimmed);
  const combinedUrls = Array.from(new Set([...input.haveUrls, ...embeddedUrls]));
  const hasUrls = combinedUrls.length > 0;

  const listItems = parseListItems(trimmed);
  if (listItems.length >= 2) {
    const subQuestions = buildListPlan(listItems, hasUrls, input.haveFiles);
    const unanswerable = determineUnanswerable("list", trimmed, hasUrls);
    const summary = buildSummary("list", subQuestions.length, listItems.length);
    return {
      question: trimmed,
      subQuestions,
      summary,
      unanswerable,
      refusedBecause: null
    };
  }

  const archetype = detectArchetype(trimmed);
  let subQuestions: readonly SubQuestion[];

  switch (archetype) {
    case "comparison":
      subQuestions = buildComparisonPlan(hasUrls);
      break;
    case "what-is":
      subQuestions = buildWhatIsPlan(hasUrls, input.haveFiles);
      break;
    case "should-i":
      subQuestions = buildShouldIPlan(hasUrls);
      break;
    case "what-changed":
      subQuestions = buildWhatChangedPlan(hasUrls, input.haveFiles);
      break;
    case "general":
      subQuestions = buildGeneralPlan(input.haveFiles);
      break;
  }

  const unanswerable = determineUnanswerable(archetype, trimmed, hasUrls);
  const summary = buildSummary(archetype, subQuestions.length, 0);

  return {
    question: trimmed,
    subQuestions,
    summary,
    unanswerable,
    refusedBecause: null
  };
}
