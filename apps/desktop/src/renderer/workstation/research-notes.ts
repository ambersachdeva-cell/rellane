export interface SourceRef {
  readonly id: string;
  readonly kind: "page" | "file" | "subscription";
  readonly label: string;
  readonly url: string | null;
  readonly readAt: number;
}

export interface Note {
  readonly finding: string;
  readonly source: SourceRef;
  readonly quote: string;
  readonly confidence: "stated" | "inferred" | "uncertain";
}

export interface Scratchpad {
  readonly notes: readonly Note[];
  readonly bySource: readonly { readonly source: SourceRef; readonly count: number }[];
  readonly agreed: readonly { readonly finding: string; readonly sources: readonly string[] }[];
  readonly conflicting: readonly {
    readonly finding: string;
    readonly saidBy: readonly string[];
    readonly contradictedBy: readonly string[];
  }[];
  readonly thin: readonly string[];
  readonly headline: string;
}

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  hundred: "100",
  thousand: "1000",
  million: "1000000",
};

const SAFE_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "did", "do", "does", "doing",
  "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "me", "more", "most", "my", "myself", "of", "off", "on", "once",
  "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "same", "she", "so", "some", "such", "than", "that", "the", "their",
  "theirs", "them", "themselves", "then", "there", "these", "they", "this",
  "those", "through", "to", "too", "under", "until", "up", "very", "was",
  "we", "were", "what", "when", "where", "which", "while", "who", "whom",
  "why", "with", "you", "your", "yours", "yourself", "yourselves",
]);

const NEGATION_PATTERNS: readonly RegExp[] = [
  /\b(?:not|no|never|none|neither|nor|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|shouldn't|wouldn't|couldn't|hardly|scarcely|barely|without)\b/i,
  /\b(?:fails?\s+to|failed\s+to|refuses?\s+to|refused\s+to|unable\s+to|unlikely\s+to|no\s+longer)\b/i,
];

const UNCERTAINTY_PATTERNS: readonly RegExp[] = [
  /\b(?:uncertain|unclear|doubtful|unconfirmed|alleged|supposedly|tentative)\b/i,
  /\b(?:might|maybe|perhaps|possibly|may\s+be|could\s+be|not\s+sure|not\s+certain)\b/i,
];

const INFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:inferred|infer|implies|imply|suggests|suggest|indicates|indicate)\b/i,
  /\b(?:therefore|presumably|likely|appears\s+to|seems\s+to|we\s+believe|in\s+our\s+opinion)\b/i,
];

function detectConfidence(text: string): "stated" | "inferred" | "uncertain" {
  for (const pattern of UNCERTAINTY_PATTERNS) {
    if (pattern.test(text)) {
      return "uncertain";
    }
  }
  for (const pattern of INFERENCE_PATTERNS) {
    if (pattern.test(text)) {
      return "inferred";
    }
  }
  return "stated";
}

function isNegativePolarity(text: string): boolean {
  for (const pattern of NEGATION_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function stemWord(word: string): string {
  if (word.length <= 4) {
    return word;
  }
  if (word.endsWith("ingly") || word.endsWith("edly")) {
    return word.slice(0, -5);
  }
  if (word.endsWith("ing")) {
    return word.slice(0, -3);
  }
  if (word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith("ed")) {
    return word.slice(0, -2);
  }
  if (word.endsWith("es")) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function extractPropositionTokens(text: string): readonly string[] {
  const lower = text.toLowerCase();
  const unnegated = lower
    .replace(/\b(?:can't|cannot)\b/g, "can")
    .replace(/\b(?:won't)\b/g, "will")
    .replace(/\b(?:n't)\b/g, "")
    .replace(/\b(?:not|no|never|neither|nor|none|no\s+longer)\b/g, " ");

  const rawWords = unnegated.match(/[a-z0-9£$€]+/g) ?? [];
  const tokens: string[] = [];
  for (const raw of rawWords) {
    const mappedNumber = NUMBER_WORDS[raw];
    const token = mappedNumber !== undefined ? mappedNumber : raw;
    if (!SAFE_STOPWORDS.has(token) && token.length > 0) {
      tokens.push(stemWord(token));
    }
  }
  return tokens;
}

function propositionsOverlap(
  tokensA: readonly string[],
  tokensB: readonly string[],
): boolean {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return false;
  }
  const setA = new Set(tokensA);
  let sharedCount = 0;
  for (const t of tokensB) {
    if (setA.has(t)) {
      sharedCount += 1;
    }
  }
  const minLength = Math.min(tokensA.length, tokensB.length);
  return sharedCount / minLength >= 0.65;
}

function hasNumericalConflict(
  tokensA: readonly string[],
  tokensB: readonly string[],
): boolean {
  const numsA = tokensA.filter((t) => /^\d+$/.test(t));
  const numsB = tokensB.filter((t) => /^\d+$/.test(t));
  if (numsA.length === 0 || numsB.length === 0) {
    return false;
  }
  const setA = new Set(numsA);
  for (const num of numsB) {
    if (setA.has(num)) {
      return false;
    }
  }
  const nonNumA = tokensA.filter((t) => !/^\d+$/.test(t));
  const nonNumB = tokensB.filter((t) => !/^\d+$/.test(t));
  return propositionsOverlap(nonNumA, nonNumB);
}

function boundClause(sentence: string, parentText: string, searchOffset: number): string {
  if (sentence.length <= 400) {
    return sentence;
  }
  const clauseBreaks = [";", ":", ",", " - ", " — "];
  let bestBreak = -1;
  for (const cb of clauseBreaks) {
    const idx = sentence.lastIndexOf(cb, 399);
    if (idx > 50 && idx > bestBreak) {
      bestBreak = idx;
    }
  }
  let candidate = "";
  if (bestBreak > 0) {
    candidate = sentence.slice(0, bestBreak).trim();
  } else {
    const lastSpace = sentence.lastIndexOf(" ", 399);
    candidate = lastSpace > 50 ? sentence.slice(0, lastSpace).trim() : sentence.slice(0, 400).trim();
  }
  const foundIndex = parentText.indexOf(candidate, searchOffset);
  if (foundIndex >= 0) {
    return candidate;
  }
  return sentence.slice(0, 400);
}

function extractQuotes(text: string): readonly { readonly quote: string; readonly finding: string }[] {
  if (text.trim().length === 0) {
    return [];
  }
  const results: { quote: string; finding: string }[] = [];
  const lines = text.split(/\r?\n/);
  let textSearchCursor = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const lineStartInText = text.indexOf(line, textSearchCursor);
    const effectiveLineStart = lineStartInText >= 0 ? lineStartInText : textSearchCursor;
    textSearchCursor = effectiveLineStart + line.length;

    const bulletMatch = /^(?:[-*•>]|\d+[.)])\s+/.exec(trimmedLine);
    let content = trimmedLine;
    if (bulletMatch && bulletMatch[0]) {
      content = trimmedLine.slice(bulletMatch[0].length).trim();
    }
    if (content.length === 0) {
      continue;
    }

    const rawSentences = content.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [content];
    let sentenceCursor = effectiveLineStart;

    for (const raw of rawSentences) {
      const trimmedSentence = raw.trim();
      if (trimmedSentence.length === 0) {
        continue;
      }
      const sentenceIdx = text.indexOf(trimmedSentence, sentenceCursor);
      const validStart = sentenceIdx >= 0 ? sentenceIdx : sentenceCursor;
      sentenceCursor = validStart + trimmedSentence.length;

      const bounded = boundClause(trimmedSentence, text, validStart);
      if (bounded.length > 0 && text.includes(bounded)) {
        const finding = bounded.replace(/^[\s-*•>]+/, "").trim();
        results.push({
          quote: bounded,
          finding: finding.length > 0 ? finding : bounded,
        });
      }
    }
  }
  return results;
}

function isQuestionAnswered(
  questionText: string,
  notes: readonly Note[],
): boolean {
  const qTokens = extractPropositionTokens(questionText);
  if (qTokens.length === 0) {
    return notes.length > 0;
  }
  for (const note of notes) {
    const noteTokens = extractPropositionTokens(`${note.finding} ${note.quote}`);
    const noteTokenSet = new Set(noteTokens);
    let matchCount = 0;
    for (const qt of qTokens) {
      if (noteTokenSet.has(qt)) {
        matchCount += 1;
      }
    }
    if (qTokens.length <= 2 && matchCount >= 1) {
      return true;
    }
    if (matchCount >= 2 || matchCount / qTokens.length >= 0.4) {
      return true;
    }
  }
  return false;
}

function buildHeadline(
  notesCount: number,
  sourcesCount: number,
  agreedCount: number,
  conflictingCount: number,
  thinCount: number,
): string {
  if (notesCount === 0) {
    if (thinCount === 0) {
      return "No notes recorded yet.";
    }
    const qWord = thinCount === 1 ? "question" : "questions";
    return `No notes recorded yet; ${thinCount} ${qWord} remain unanswered.`;
  }

  const nWord = notesCount === 1 ? "note" : "notes";
  const sWord = sourcesCount === 1 ? "source" : "sources";
  const prefix = `${notesCount} ${nWord} from ${sourcesCount} ${sWord}`;

  const details: string[] = [];
  if (agreedCount > 0) {
    const ptWord = agreedCount === 1 ? "point" : "points";
    details.push(`${agreedCount} agreed ${ptWord}`);
  }
  if (conflictingCount > 0) {
    const cfWord = conflictingCount === 1 ? "conflict" : "conflicts";
    details.push(`${conflictingCount} ${cfWord} to review`);
  }
  if (thinCount > 0) {
    const qWord = thinCount === 1 ? "question" : "questions";
    details.push(`${thinCount} ${qWord} still unanswered`);
  }

  if (details.length > 0) {
    return `${prefix}; ${details.join(", ")}.`;
  }
  return `${prefix}.`;
}

export function addToScratchpad(input: {
  readonly existing: readonly Note[];
  readonly text: string;
  readonly source: SourceRef;
  readonly subQuestions: readonly { readonly id: string; readonly question: string }[];
  readonly at: number;
}): Scratchpad {
  const combinedNotes: Note[] = [...input.existing];
  const extracted = extractQuotes(input.text);

  for (const item of extracted) {
    const candidateTokens = extractPropositionTokens(item.finding);
    const candidateNegative = isNegativePolarity(item.finding);

    let alreadyRecordedForSource = false;
    for (const existingNote of combinedNotes) {
      if (existingNote.source.id === input.source.id) {
        const existingTokens = extractPropositionTokens(existingNote.finding);
        const existingNegative = isNegativePolarity(existingNote.finding);
        if (
          existingNegative === candidateNegative &&
          propositionsOverlap(candidateTokens, existingTokens)
        ) {
          alreadyRecordedForSource = true;
          break;
        }
      }
    }

    if (!alreadyRecordedForSource) {
      combinedNotes.push({
        finding: item.finding,
        source: input.source,
        quote: item.quote,
        confidence: detectConfidence(item.finding),
      });
    }
  }

  const bySourceMap = new Map<string, { source: SourceRef; count: number }>();
  for (const n of combinedNotes) {
    const existingEntry = bySourceMap.get(n.source.id);
    if (existingEntry !== undefined) {
      existingEntry.count += 1;
    } else {
      bySourceMap.set(n.source.id, { source: n.source, count: 1 });
    }
  }
  if (!bySourceMap.has(input.source.id)) {
    bySourceMap.set(input.source.id, { source: input.source, count: 0 });
  }
  const bySource = Array.from(bySourceMap.values()).map((entry) => ({
    source: entry.source,
    count: entry.count,
  }));

  interface PropositionCluster {
    readonly baseFinding: string;
    readonly tokens: readonly string[];
    readonly positiveSources: Map<string, SourceRef>;
    readonly negativeSources: Map<string, SourceRef>;
  }

  const clusters: PropositionCluster[] = [];
  for (const n of combinedNotes) {
    const tokens = extractPropositionTokens(n.finding);
    const isNeg = isNegativePolarity(n.finding);

    let matchedCluster: PropositionCluster | null = null;
    for (const c of clusters) {
      if (propositionsOverlap(c.tokens, tokens)) {
        matchedCluster = c;
        break;
      }
    }

    if (matchedCluster !== null) {
      if (isNeg) {
        matchedCluster.negativeSources.set(n.source.id, n.source);
      } else {
        matchedCluster.positiveSources.set(n.source.id, n.source);
      }
    } else {
      const posMap = new Map<string, SourceRef>();
      const negMap = new Map<string, SourceRef>();
      if (isNeg) {
        negMap.set(n.source.id, n.source);
      } else {
        posMap.set(n.source.id, n.source);
      }
      clusters.push({
        baseFinding: n.finding,
        tokens,
        positiveSources: posMap,
        negativeSources: negMap,
      });
    }
  }

  const agreed: { finding: string; sources: readonly string[] }[] = [];
  const conflicting: {
    finding: string;
    saidBy: readonly string[];
    contradictedBy: readonly string[];
  }[] = [];

  for (const c of clusters) {
    const posSources = Array.from(c.positiveSources.values());
    const negSources = Array.from(c.negativeSources.values());

    if (posSources.length > 0 && negSources.length > 0) {
      conflicting.push({
        finding: c.baseFinding,
        saidBy: posSources.map((s) => s.label),
        contradictedBy: negSources.map((s) => s.label),
      });
    } else if (posSources.length >= 2 && negSources.length === 0) {
      agreed.push({
        finding: c.baseFinding,
        sources: posSources.map((s) => s.label),
      });
    } else if (negSources.length >= 2 && posSources.length === 0) {
      agreed.push({
        finding: c.baseFinding,
        sources: negSources.map((s) => s.label),
      });
    }
  }

  for (let i = 0; i < combinedNotes.length; i += 1) {
    const noteA = combinedNotes[i];
    if (noteA === undefined) {
      continue;
    }
    for (let j = i + 1; j < combinedNotes.length; j += 1) {
      const noteB = combinedNotes[j];
      if (noteB === undefined || noteA.source.id === noteB.source.id) {
        continue;
      }
      const tokensA = extractPropositionTokens(noteA.finding);
      const tokensB = extractPropositionTokens(noteB.finding);
      if (hasNumericalConflict(tokensA, tokensB)) {
        const alreadyLogged = conflicting.some(
          (cf) => cf.finding === noteA.finding || cf.finding === noteB.finding,
        );
        if (!alreadyLogged) {
          conflicting.push({
            finding: noteA.finding,
            saidBy: [noteA.source.label],
            contradictedBy: [noteB.source.label],
          });
        }
      }
    }
  }

  const thin: string[] = [];
  for (const sq of input.subQuestions) {
    if (!isQuestionAnswered(sq.question, combinedNotes)) {
      thin.push(sq.question.length > 0 ? sq.question : sq.id);
    }
  }

  const headline = buildHeadline(
    combinedNotes.length,
    bySource.length,
    agreed.length,
    conflicting.length,
    thin.length,
  );

  return {
    notes: combinedNotes,
    bySource,
    agreed,
    conflicting,
    thin,
    headline,
  };
}
