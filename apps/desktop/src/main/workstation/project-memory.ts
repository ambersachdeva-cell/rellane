/**
 * Project memory: persists and refines learned facts across cases.
 *
 * This module is pure. It accumulates findings across multiple pieces of work,
 * confirms repeated observations, tracks decision reversals explicitly, flags
 * stale facts for review, and tightly bounds recall to protect quota.
 */

export interface Learned {
  readonly id: string;
  readonly fact: string;             // one plain sentence
  readonly learnedFrom: string;      // the piece of work it came from, by title
  readonly firstSeenAt: number;
  readonly lastConfirmedAt: number;
  readonly timesSeen: number;
  readonly kind: "about-the-business" | "about-a-person" | "a-decision" | "a-preference" | "a-constraint";
  readonly pinned: boolean;          // he said keep this
  readonly hidden: boolean;          // he said stop using this
}

export interface Memory {
  readonly facts: readonly Learned[];
  readonly headline: string;
  readonly stale: readonly Learned[];      // not seen in a long time; offered for removal
}

/** Threshold after which an unconfirmed, unpinned fact is offered for review (30 days). */
export const STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Quota protection: hard limit on recalled lines presented to a model prompt. */
export const MAX_RECALL_LINES = 12;

/** Bound on individual fact length to prevent runaway findings from inflating memory. */
const MAX_FACT_CHARS = 240;

const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and", "any",
  "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "did", "do", "does", "doing", "down",
  "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "herself", "him", "himself", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me",
  "more", "most", "my", "myself", "of", "off", "on", "once", "only", "or",
  "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "whom", "why", "with", "you",
  "your", "yours", "yourself", "yourselves",
]);

function extractTokens(text: string): readonly string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const rawWords = normalized.split(/\s+/);
  const tokens: string[] = [];
  for (const word of rawWords) {
    if (word.length > 1 && !STOPWORDS.has(word)) {
      tokens.push(stemWord(word));
    }
  }
  return tokens;
}

function stemWord(word: string): string {
  // Common inflection stripping allows wordings with differing tense or pluralisation to match.
  if (word.endsWith("ing") && word.length > 5) {
    return word.slice(0, -3);
  }
  if (word.endsWith("ed") && word.length > 4) {
    return word.slice(0, -2);
  }
  if (word.endsWith("es") && word.length > 4) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    return word.slice(0, -1);
  }
  return word;
}

function extractNumbers(text: string): readonly string[] {
  const matches = text.match(/\b\d+\b/g);
  return matches !== null ? matches : [];
}

function cleanSentence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  // Take the first plain sentence to ensure individual facts remain atomic and concise.
  const sentenceMatch = trimmed.match(/^([^.!?\n]+[.!?]?)/);
  const firstSentence =
    sentenceMatch !== null && sentenceMatch[1] !== undefined
      ? sentenceMatch[1].trim()
      : trimmed;

  if (firstSentence.length <= MAX_FACT_CHARS) {
    return ensurePunctuation(firstSentence);
  }

  const slice = firstSentence.slice(0, MAX_FACT_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const bounded = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
  return `${bounded.trim()}...`;
}

function ensurePunctuation(text: string): string {
  if (text.endsWith(".") || text.endsWith("!") || text.endsWith("?")) {
    return text;
  }
  return `${text}.`;
}

function classifyKind(
  text: string
): "about-the-business" | "about-a-person" | "a-decision" | "a-preference" | "a-constraint" {
  const lower = text.toLowerCase();

  // Explicit decision vocabulary takes precedence to track evolving commitments over time.
  if (
    /\b(decided|decision|chose|chosen|agreed|adopted|settled on|switched to|switched from|will use|selected|resolved|reversed)\b/.test(
      lower
    )
  ) {
    return "a-decision";
  }

  // Hard operational boundaries or constraints.
  if (
    /\b(must not|must|cannot|can't|never|required|strictly|budget is|deadline is|limit to|cap at)\b/.test(
      lower
    )
  ) {
    return "a-constraint";
  }

  // Personal working styles, stylistic preferences or guidance.
  if (
    /\b(prefer|prefers|preferred|preference|likes to|wants to|favours|favors|rather than)\b/.test(
      lower
    )
  ) {
    return "a-preference";
  }

  // Statements specifically identifying people and roles.
  if (
    /\b(amber|founder|director|manager|colleague|accountant|lawyer|client|customer|person|he|she|his|her)\b/.test(
      lower
    )
  ) {
    return "about-a-person";
  }

  return "about-the-business";
}

function isSameFact(factA: string, factB: string): boolean {
  // Different numbers represent different dates, sums, or targets even if all other words match.
  const numsA = extractNumbers(factA);
  const numsB = extractNumbers(factB);
  if (numsA.length > 0 && numsB.length > 0) {
    if (numsA.length !== numsB.length) {
      return false;
    }
    const sortedA = [...numsA].sort();
    const sortedB = [...numsB].sort();
    for (let i = 0; i < sortedA.length; i++) {
      if (sortedA[i] !== sortedB[i]) {
        return false;
      }
    }
  }

  const tokensA = extractTokens(factA);
  const tokensB = extractTokens(factB);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return factA.trim().toLowerCase() === factB.trim().toLowerCase();
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      shared += 1;
    }
  }

  const minSize = Math.min(setA.size, setB.size);
  const maxSize = Math.max(setA.size, setB.size);
  if (minSize === 0) {
    return false;
  }

  /**
   * High overlap is not the same fact when they name different things.
   *
   * "We decided to use Stripe for payment processing" and "We decided to use
   * Adyen for payment processing" share four words of five, so containment
   * alone called them one fact and confirmed it — which would have left the app
   * telling every future request he uses Stripe, months after he stopped. The
   * word that differs is the entire content of the sentence.
   *
   * Proper nouns and numbers are what carry that content. When each side has
   * one the other lacks, this is two facts, and the caller's contradiction
   * check is what decides which of them still holds. Requiring *both* sides to
   * have one is what keeps "the deposit is 30%" and "the deposit is thirty per
   * cent of the total" as a single confirmed fact.
   */
  if (namesDifferentThings(factA, factB)) {
    return false;
  }

  // Containment comparison: high overlap confirms the same observation across different pieces of work.
  return shared / minSize >= 0.75 && shared / maxSize >= 0.5;
}

/** Proper nouns and numbers, which is where a sentence keeps its subject. */
function distinguishingTerms(sentence: string): ReadonlySet<string> {
  const terms = new Set<string>();
  const words = sentence.split(/\s+/u);
  for (let i = 0; i < words.length; i += 1) {
    const raw = words[i];
    if (raw === undefined) continue;
    // Dots are kept for decimals and trimmed at the edges, or a sentence-ending
    // full stop makes "£50." a different thing from "£50".
    const bare = raw.replace(/[^A-Za-z0-9.%-]/gu, "").replace(/^[.-]+|[.-]+$/gu, "");
    if (bare.length === 0) continue;
    if (/\d/u.test(bare)) {
      terms.add(bare.toLowerCase());
      continue;
    }
    // Not the first word: a capital there is only the sentence starting.
    if (i > 0 && /^[A-Z][a-z]{2,}$/u.test(bare)) terms.add(bare.toLowerCase());
  }
  return terms;
}

function namesDifferentThings(oldText: string, newText: string): boolean {
  const oldTerms = distinguishingTerms(oldText);
  const newTerms = distinguishingTerms(newText);
  if (oldTerms.size === 0 || newTerms.size === 0) return false;
  for (const term of newTerms) {
    if (oldTerms.has(term)) return false;
  }
  return true;
}

function isContradiction(
  existingFact: Learned,
  newText: string,
  newKind: "about-the-business" | "about-a-person" | "a-decision" | "a-preference" | "a-constraint"
): boolean {
  if (existingFact.fact.startsWith("Superseded:")) {
    return false;
  }

  const oldLower = existingFact.fact.toLowerCase();
  const newLower = newText.toLowerCase();

  const oldTokens = extractTokens(existingFact.fact);
  const newTokens = extractTokens(newText);
  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);

  let shared = 0;
  for (const t of newSet) {
    if (oldSet.has(t)) {
      shared += 1;
    }
  }

  // Explicit phrases marking a switch, replacement, or reversal.
  const hasReversalPhrase =
    /\b(switch|switched|switching|replace|replaced|replaces|instead of|no longer|not anymore|reversed|changed from|abandoned|stopped using|decided against)\b/.test(
      newLower
    );

  if (hasReversalPhrase && shared >= 1) {
    return true;
  }

  // Direct polar negation over the same shared topic.
  const hasOldNegation = /\b(not|never|no longer|cannot|can't|stop)\b/.test(oldLower);
  const hasNewNegation = /\b(not|never|no longer|cannot|can't|stop)\b/.test(newLower);
  if (hasOldNegation !== hasNewNegation && shared >= 2) {
    return true;
  }

  // Competing decisions or constraints on the same core topic.
  const bothDecisions =
    (existingFact.kind === "a-decision" || existingFact.kind === "a-constraint") &&
    (newKind === "a-decision" || newKind === "a-constraint");

  if (bothDecisions && shared >= 2 && !isSameFact(existingFact.fact, newText)) {
    return true;
  }

  return false;
}

function formatDate(timestamp: number): string {
  const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  const date = new Date(ms);
  const day = date.getUTCDate();
  const months: readonly string[] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthIndex = date.getUTCMonth();
  const month =
    monthIndex >= 0 && monthIndex < months.length ? months[monthIndex]! : "Unknown";
  const year = date.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

function buildHeadline(facts: readonly Learned[], stale: readonly Learned[]): string {
  const count = facts.length;
  if (count === 0) {
    return "Nothing remembered yet.";
  }
  const staleCount = stale.length;
  if (count === 1) {
    return staleCount === 1
      ? "1 fact remembered, ready for review."
      : "1 fact remembered.";
  }
  if (staleCount === 0) {
    return `${count} facts remembered.`;
  }
  if (staleCount === 1) {
    return `${count} facts remembered, 1 ready for review.`;
  }
  return `${count} facts remembered, ${staleCount} ready for review.`;
}

function generateDeterministicId(text: string, timestamp: number, index: number): string {
  // Simple deterministic DJB2 hash avoiding pseudo-random generation.
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  const hexHash = Math.abs(hash).toString(16);
  return `mem-${timestamp}-${index}-${hexHash}`;
}

export function learnFrom(input: {
  readonly existing: readonly Learned[];
  readonly newFindings: readonly { readonly finding: string; readonly fromTitle: string }[];
  readonly now: number;
}): Memory {
  const currentFacts: Learned[] = [...input.existing];

  let nextIndex = 0;
  for (const item of input.newFindings) {
    const cleanedText = cleanSentence(item.finding);
    if (cleanedText.length === 0) {
      continue;
    }

    const kind = classifyKind(cleanedText);

    // Check whether this confirms an existing observation.
    let confirmedIndex = -1;
    for (let i = 0; i < currentFacts.length; i++) {
      const existing = currentFacts[i]!;
      if (isSameFact(existing.fact, cleanedText)) {
        confirmedIndex = i;
        break;
      }
    }

    if (confirmedIndex >= 0) {
      const existing = currentFacts[confirmedIndex]!;
      currentFacts[confirmedIndex] = {
        id: existing.id,
        fact: existing.fact,
        learnedFrom: existing.learnedFrom,
        firstSeenAt: existing.firstSeenAt,
        lastConfirmedAt: input.now,
        timesSeen: existing.timesSeen + 1,
        kind: existing.kind,
        pinned: existing.pinned,
        hidden: existing.hidden,
      };
      continue;
    }

    // Check whether this contradicts or supersedes an existing decision or rule.
    let contradictionIndex = -1;
    for (let i = 0; i < currentFacts.length; i++) {
      const existing = currentFacts[i]!;
      if (isContradiction(existing, cleanedText, kind)) {
        contradictionIndex = i;
        break;
      }
    }

    if (contradictionIndex >= 0) {
      const older = currentFacts[contradictionIndex]!;
      const formattedWhen = formatDate(input.now);
      // The older fact records what changed and when, while the newer fact becomes the active decision.
      const updatedOlderFactText = `Superseded: previously "${older.fact}", changed to "${cleanedText}" in ${item.fromTitle} on ${formattedWhen}.`;

      currentFacts[contradictionIndex] = {
        id: older.id,
        fact: updatedOlderFactText,
        learnedFrom: older.learnedFrom,
        firstSeenAt: older.firstSeenAt,
        lastConfirmedAt: input.now,
        timesSeen: older.timesSeen,
        kind: older.kind,
        pinned: older.pinned,
        hidden: older.hidden,
      };

      const newId = generateDeterministicId(cleanedText, input.now, nextIndex);
      nextIndex += 1;
      currentFacts.push({
        id: newId,
        fact: cleanedText,
        learnedFrom: item.fromTitle,
        firstSeenAt: input.now,
        lastConfirmedAt: input.now,
        timesSeen: 1,
        kind,
        pinned: false,
        hidden: false,
      });
      continue;
    }

    // New independent fact.
    const newId = generateDeterministicId(cleanedText, input.now, nextIndex);
    nextIndex += 1;
    currentFacts.push({
      id: newId,
      fact: cleanedText,
      learnedFrom: item.fromTitle,
      firstSeenAt: input.now,
      lastConfirmedAt: input.now,
      timesSeen: 1,
      kind,
      pinned: false,
      hidden: false,
    });
  }

  // Pinned facts never go stale; unpinned facts not seen in 30 days are flagged.
  const staleFacts = currentFacts.filter(
    (f) => !f.pinned && input.now - f.lastConfirmedAt >= STALE_AGE_MS
  );

  return {
    facts: currentFacts,
    headline: buildHeadline(currentFacts, staleFacts),
    stale: staleFacts,
  };
}

export function recall(memory: Memory, question: string, maxChars: number): readonly string[] {
  if (memory.facts.length === 0 || maxChars <= 0) {
    return [];
  }

  const queryTokens = extractTokens(question);
  const queryNums = extractNumbers(question);

  if (queryTokens.length === 0 && queryNums.length === 0) {
    return [];
  }

  const querySet = new Set(queryTokens);

  interface ScoredFact {
    readonly fact: Learned;
    readonly score: number;
    readonly isSuperseded: boolean;
  }

  const scored: ScoredFact[] = [];

  for (const item of memory.facts) {
    // Hidden facts must never be recalled under any circumstances.
    if (item.hidden) {
      continue;
    }

    const factTokens = extractTokens(item.fact);
    let matchCount = 0;
    for (const token of factTokens) {
      if (querySet.has(token)) {
        matchCount += 1;
      }
    }

    const factNums = extractNumbers(item.fact);
    for (const num of factNums) {
      if (queryNums.includes(num)) {
        matchCount += 2;
      }
    }

    // A question with no matching relevance signals returns nothing for this item.
    if (matchCount === 0) {
      continue;
    }

    const isSuperseded = item.fact.startsWith("Superseded:");
    scored.push({
      fact: item,
      score: matchCount,
      isSuperseded,
    });
  }

  if (scored.length === 0) {
    return [];
  }

  // Sort order: active winning decisions first, pinned first, highest confirmations first, highest relevance first.
  scored.sort((a, b) => {
    if (a.isSuperseded !== b.isSuperseded) {
      return a.isSuperseded ? 1 : -1;
    }
    if (a.fact.pinned !== b.fact.pinned) {
      return a.fact.pinned ? -1 : 1;
    }
    if (a.fact.timesSeen !== b.fact.timesSeen) {
      return b.fact.timesSeen - a.fact.timesSeen;
    }
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return b.fact.lastConfirmedAt - a.fact.lastConfirmedAt;
  });

  const lines: string[] = [];
  let currentChars = 0;

  for (const candidate of scored) {
    if (lines.length >= MAX_RECALL_LINES) {
      break;
    }

    const line = candidate.fact.fact;
    const additionalChars = lines.length === 0 ? line.length : line.length + 1;
    if (currentChars + additionalChars > maxChars) {
      continue;
    }

    lines.push(line);
    currentChars += additionalChars;
  }

  return lines;
}
