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

export interface CitedAnswer {
  readonly markdown: string;
  readonly sources: readonly {
    readonly marker: number;
    readonly label: string;
    readonly url: string | null;
  }[];
  readonly uncited: readonly string[];
  readonly conflicts: readonly string[];
  readonly gaps: readonly string[];
  readonly confidence: "well-sourced" | "partly-sourced" | "thin";
}

interface SubQuestionInput {
  readonly id: string;
  readonly question: string;
}

interface SourceRecord {
  readonly marker: number;
  readonly label: string;
  readonly url: string | null;
}

interface ClaimItem {
  readonly finding: string;
  readonly quote: string;
  readonly marker: number | null;
  readonly isUncited: boolean;
  readonly sourceKind: "page" | "file" | "subscription" | null;
}

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "all", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "could", "did", "do", "does", "doing", "down", "during", "each",
  "few", "for", "from", "further", "had", "has", "have", "having", "he", "her", "here",
  "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into", "is",
  "it", "its", "itself", "just", "me", "more", "most", "my", "myself", "no", "nor",
  "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "ours",
  "ourselves", "out", "over", "own", "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "we", "were", "what", "when", "where", "which", "while", "who",
  "whom", "why", "will", "with", "would", "you", "your", "yours", "yourself"
]);

const MONTH_NAMES = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
]);

const NEGATION_WORDS = new Set([
  "not", "cannot", "never", "unable", "unsupported", "disabled",
  "prohibited", "forbidden", "neither", "no"
]);

const ANTONYM_PAIRS: readonly (readonly [string, string])[] = [
  ["enabled", "disabled"],
  ["active", "inactive"],
  ["included", "excluded"],
  ["mandatory", "optional"],
  ["compatible", "incompatible"],
  ["free", "paid"],
  ["supported", "unsupported"],
  ["allowed", "prohibited"],
  ["permitted", "forbidden"],
  ["true", "false"],
  ["yes", "no"],
  ["success", "failed"]
];

function isValidSource(source: SourceRef | undefined): boolean {
  if (!source) {
    return false;
  }
  const label = source.label.trim();
  if (label === "") {
    return false;
  }
  const lower = label.toLowerCase();
  if (lower === "unknown" || lower === "uncited" || lower === "none" || lower === "no source") {
    return false;
  }
  return true;
}

function getSourceKey(source: SourceRef): string {
  if (source.id.trim() !== "") {
    return `id:${source.id.trim()}`;
  }
  return `label:${source.label.trim()}::${source.url ?? ""}`;
}

function extractKeywords(text: string): readonly string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length >= 2);

  const nonStop = words.filter(w => !STOP_WORDS.has(w) && w.length >= 3);
  if (nonStop.length > 0) {
    return nonStop;
  }
  return words;
}

function doesNoteMatchSubQuestion(note: Note, sq: SubQuestionInput): boolean {
  const noteText = `${note.finding} ${note.quote} ${note.source.label}`.toLowerCase();

  if (sq.id.trim() !== "") {
    const idLower = sq.id.toLowerCase();
    const idPattern = new RegExp(`\\b${idLower}\\b`, "i");
    if (idPattern.test(noteText)) {
      return true;
    }
  }

  const keywords = extractKeywords(sq.question);
  if (keywords.length === 0) {
    return false;
  }

  for (const kw of keywords) {
    if (noteText.includes(kw)) {
      return true;
    }
    // Prefix matching for words of length at least 4 allows singular/plural and verb forms to correlate
    if (kw.length >= 4) {
      const stem = kw.slice(0, kw.length - 1);
      if (noteText.includes(stem)) {
        return true;
      }
    }
  }

  return false;
}

function stripTrailingPeriod(text: string): string {
  const trimmed = text.trim();
  if (trimmed.endsWith(".")) {
    return trimmed.slice(0, -1).trim();
  }
  return trimmed;
}

function ensureTrailingPeriod(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.endsWith(".") || trimmed.endsWith("!") || trimmed.endsWith("?")) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function cleanFindingForConflict(finding: string): string {
  const stripped = stripTrailingPeriod(finding);
  if (stripped.length === 0) {
    return "";
  }
  const words = stripped.split(/\s+/);
  const firstWord = words.length > 0 && words[0] !== undefined ? words[0] : "";
  if (
    firstWord.length > 1 &&
    firstWord.charAt(0) === firstWord.charAt(0).toUpperCase() &&
    firstWord.charAt(1) === firstWord.charAt(1).toLowerCase()
  ) {
    return firstWord.toLowerCase() + stripped.slice(firstWord.length);
  }
  return stripped;
}

function formatConflict(noteA: Note, noteB: Note): string {
  const labelA = noteA.source.label.trim();
  const labelB = noteB.source.label.trim();
  const claimA = cleanFindingForConflict(noteA.finding);
  const claimB = cleanFindingForConflict(noteB.finding);
  return `${labelA} states that ${claimA}, whereas ${labelB} states that ${claimB}.`;
}

function extractNumbers(text: string): readonly string[] {
  const matches = text.match(/\b\d+(?:\.\d+)?\b/g);
  return matches ? Array.from(matches) : [];
}

function extractMonths(text: string): readonly string[] {
  const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
  return words.filter(w => MONTH_NAMES.has(w));
}

function detectConflictBetweenNotes(noteA: Note, noteB: Note): string | null {
  if (noteA.source.id === noteB.source.id || noteA.source.label === noteB.source.label) {
    return null;
  }
  if (!isValidSource(noteA.source) || !isValidSource(noteB.source)) {
    return null;
  }

  const textA = noteA.finding.toLowerCase();
  const textB = noteB.finding.toLowerCase();

  const wordsA = new Set(extractKeywords(noteA.finding));
  const wordsB = new Set(extractKeywords(noteB.finding));
  let sharedKeywords = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) {
      sharedKeywords++;
    }
  }

  if (sharedKeywords < 1) {
    return null;
  }

  for (const [ant1, ant2] of ANTONYM_PAIRS) {
    const hasAnt1InA = textA.includes(ant1);
    const hasAnt2InA = textA.includes(ant2);
    const hasAnt1InB = textB.includes(ant1);
    const hasAnt2InB = textB.includes(ant2);

    if (
      (hasAnt1InA && hasAnt2InB && !hasAnt2InA && !hasAnt1InB) ||
      (hasAnt2InA && hasAnt1InB && !hasAnt1InA && !hasAnt2InB)
    ) {
      return formatConflict(noteA, noteB);
    }
  }

  let hasNegA = false;
  for (const neg of NEGATION_WORDS) {
    const reg = new RegExp(`\\b${neg}\\b`, "i");
    if (reg.test(textA)) {
      hasNegA = true;
      break;
    }
  }
  let hasNegB = false;
  for (const neg of NEGATION_WORDS) {
    const reg = new RegExp(`\\b${neg}\\b`, "i");
    if (reg.test(textB)) {
      hasNegB = true;
      break;
    }
  }
  if (hasNegA !== hasNegB && sharedKeywords >= 1) {
    return formatConflict(noteA, noteB);
  }

  const numsA = extractNumbers(noteA.finding);
  const numsB = extractNumbers(noteB.finding);
  if (numsA.length > 0 && numsB.length > 0 && sharedKeywords >= 1) {
    const hasCommonNumber = numsA.some(n => numsB.includes(n));
    if (!hasCommonNumber) {
      return formatConflict(noteA, noteB);
    }
  }

  const monthsA = extractMonths(noteA.finding);
  const monthsB = extractMonths(noteB.finding);
  if (monthsA.length > 0 && monthsB.length > 0 && sharedKeywords >= 1) {
    const hasCommonMonth = monthsA.some(m => monthsB.includes(m));
    if (!hasCommonMonth) {
      return formatConflict(noteA, noteB);
    }
  }

  return null;
}

function deriveConfidence(
  notes: readonly Note[],
  subQuestions: readonly SubQuestionInput[]
): "well-sourced" | "partly-sourced" | "thin" {
  if (notes.length === 0) {
    return "thin";
  }

  const pageOrFileNotes = notes.filter(
    n => n.source.kind === "page" || n.source.kind === "file"
  );
  const subscriptionNotes = notes.filter(
    n => n.source.kind === "subscription"
  );

  // When subscriptions make up the majority or no files/pages exist, claims lack external backing
  if (pageOrFileNotes.length === 0 || subscriptionNotes.length > notes.length / 2) {
    return "thin";
  }

  if (subQuestions.length > 0) {
    const allCoveredByPageOrFile = subQuestions.every(sq =>
      pageOrFileNotes.some(note => doesNoteMatchSubQuestion(note, sq))
    );
    if (allCoveredByPageOrFile) {
      return "well-sourced";
    }
    return "partly-sourced";
  }

  return "well-sourced";
}

function formatClaimsIntoParagraphs(claims: readonly ClaimItem[]): string {
  if (claims.length === 0) {
    return "";
  }

  // Deduplicate identical findings to keep the text succinct when multiple subscriptions or notes repeat a claim
  const grouped = new Map<string, { finding: string; markers: Set<number>; quotes: Set<string>; isUncited: boolean }>();
  for (const claim of claims) {
    const key = claim.finding.trim().toLowerCase();
    if (key === "") {
      continue;
    }
    const existing = grouped.get(key);
    if (existing !== undefined) {
      if (claim.marker !== null) {
        existing.markers.add(claim.marker);
      }
      if (claim.quote.trim() !== "") {
        existing.quotes.add(claim.quote.trim());
      }
      if (!claim.isUncited) {
        existing.isUncited = false;
      }
    } else {
      const markers = new Set<number>();
      if (claim.marker !== null) {
        markers.add(claim.marker);
      }
      const quotes = new Set<string>();
      if (claim.quote.trim() !== "") {
        quotes.add(claim.quote.trim());
      }
      grouped.set(key, {
        finding: claim.finding.trim(),
        markers,
        quotes,
        isUncited: claim.isUncited
      });
    }
  }

  const sentences: string[] = [];
  for (const item of grouped.values()) {
    const baseFinding = stripTrailingPeriod(item.finding);
    let formattedSentence: string;
    if (item.markers.size > 0) {
      const sortedMarkers = Array.from(item.markers).sort((a, b) => a - b);
      const markerString = sortedMarkers.map(m => `[${m}]`).join("");
      formattedSentence = `${baseFinding} ${markerString}.`;
    } else {
      formattedSentence = ensureTrailingPeriod(baseFinding);
    }

    if (item.quotes.size > 0 && item.quotes.size <= 2) {
      const quoteList = Array.from(item.quotes).join(" / ");
      formattedSentence += ` (\"${quoteList}\")`;
    }
    sentences.push(formattedSentence);
  }

  // Group sentences into paragraphs of up to 4 sentences each to keep documents readable
  const paragraphs: string[] = [];
  const chunkSize = 4;
  for (let i = 0; i < sentences.length; i += chunkSize) {
    const chunk = sentences.slice(i, i + chunkSize);
    paragraphs.push(chunk.join(" "));
  }
  return paragraphs.join("\n\n");
}

export function writeCitedAnswer(input: {
  readonly question: string;
  readonly notes: readonly Note[];
  readonly subQuestions: readonly { readonly id: string; readonly question: string }[];
  readonly cutShort: boolean;
  readonly now: number;
}): CitedAnswer {
  const sourceMap = new Map<string, SourceRecord>();
  const sourcesList: SourceRecord[] = [];

  function registerSource(source: SourceRef): number {
    const key = getSourceKey(source);
    const existing = sourceMap.get(key);
    if (existing !== undefined) {
      return existing.marker;
    }
    const marker = sourcesList.length + 1;
    const record: SourceRecord = {
      marker,
      label: source.label.trim(),
      url: source.url
    };
    sourceMap.set(key, record);
    sourcesList.push(record);
    return marker;
  }

  const uncitedClaims: string[] = [];
  const processedClaims: ClaimItem[] = [];

  for (const note of input.notes) {
    const findingTrimmed = note.finding.trim();
    if (findingTrimmed === "") {
      continue;
    }

    if (isValidSource(note.source)) {
      const marker = registerSource(note.source);
      processedClaims.push({
        finding: findingTrimmed,
        quote: note.quote,
        marker,
        isUncited: false,
        sourceKind: note.source.kind
      });
    } else {
      uncitedClaims.push(findingTrimmed);
      processedClaims.push({
        finding: findingTrimmed,
        quote: note.quote,
        marker: null,
        isUncited: true,
        sourceKind: null
      });
    }
  }

  // Deduplicate uncited claims so the list remains clean and distinct
  const uniqueUncited = Array.from(new Set(uncitedClaims));

  // Identify gaps where sub-questions received no matching notes from any source
  const gaps: string[] = [];
  for (const sq of input.subQuestions) {
    const hasMatch = input.notes.some(note => doesNoteMatchSubQuestion(note, sq));
    if (!hasMatch) {
      gaps.push(sq.question);
    }
  }

  // Detect conflicts between distinct sources on the same topics without averaging
  const conflictSet = new Set<string>();
  const conflicts: string[] = [];
  for (let i = 0; i < input.notes.length; i++) {
    const noteA = input.notes[i];
    if (noteA === undefined) continue;
    for (let j = i + 1; j < input.notes.length; j++) {
      const noteB = input.notes[j];
      if (noteB === undefined) continue;
      const conflictText = detectConflictBetweenNotes(noteA, noteB);
      if (conflictText !== null && !conflictSet.has(conflictText)) {
        conflictSet.add(conflictText);
        conflicts.push(conflictText);
      }
    }
  }

  const confidence = deriveConfidence(input.notes, input.subQuestions);

  // Assemble markdown document
  const markdownSections: string[] = [];
  markdownSections.push(`# ${input.question}`);

  // Critical status messages must appear near the top so the reader sees constraints immediately
  const statusNotices: string[] = [];
  if (input.cutShort) {
    statusNotices.push(
      "This search was stopped early before checking all sources, so some details may be missing or incomplete."
    );
  }
  if (gaps.length > 0) {
    const gapList = gaps.map(g => `\"${g}\"`).join(", ");
    statusNotices.push(
      `No information was found in your sources to answer: ${gapList}.`
    );
  }

  if (statusNotices.length > 0) {
    markdownSections.push(statusNotices.join("\n\n"));
  }

  if (processedClaims.length === 0) {
    markdownSections.push(
      "No findings were recorded for this question. Your sources did not yield any notes to review."
    );
  } else {
    // Short answer summary first
    markdownSections.push("## Summary");

    // Derive a concise short answer from the primary findings
    const summaryClaimLimit = Math.min(processedClaims.length, 5);
    const summaryClaims = processedClaims.slice(0, summaryClaimLimit);
    const summaryText = formatClaimsIntoParagraphs(summaryClaims);
    markdownSections.push(summaryText);

    // Detail section organized by sub-questions or general findings
    markdownSections.push("## Details");

    if (input.subQuestions.length > 0) {
      const matchedNoteIndices = new Set<number>();
      for (const sq of input.subQuestions) {
        markdownSections.push(`### ${sq.question}`);
        const matchedClaims: ClaimItem[] = [];
        for (let i = 0; i < input.notes.length; i++) {
          const note = input.notes[i];
          const processed = processedClaims[i];
          if (note !== undefined && processed !== undefined && doesNoteMatchSubQuestion(note, sq)) {
            matchedClaims.push(processed);
            matchedNoteIndices.add(i);
          }
        }

        if (matchedClaims.length > 0) {
          markdownSections.push(formatClaimsIntoParagraphs(matchedClaims));
        } else {
          markdownSections.push(
            "No information was found in your sources for this question."
          );
        }
      }

      // Additional claims that were not mapped to a specific sub-question
      const leftoverClaims: ClaimItem[] = [];
      for (let i = 0; i < processedClaims.length; i++) {
        if (!matchedNoteIndices.has(i)) {
          const item = processedClaims[i];
          if (item !== undefined) {
            leftoverClaims.push(item);
          }
        }
      }
      if (leftoverClaims.length > 0) {
        markdownSections.push("### Additional findings");
        markdownSections.push(formatClaimsIntoParagraphs(leftoverClaims));
      }
    } else {
      markdownSections.push(formatClaimsIntoParagraphs(processedClaims));
    }

    if (conflicts.length > 0) {
      markdownSections.push("## Disagreements between sources");
      const conflictLines = conflicts.map(c => `- ${c}`);
      markdownSections.push(conflictLines.join("\n"));
    }

    if (sourcesList.length > 0) {
      markdownSections.push("## Sources");
      const sourceLines = sourcesList.map(s => {
        if (s.url !== null && s.url.trim() !== "") {
          return `[${s.marker}] ${s.label}: ${s.url}`;
        }
        return `[${s.marker}] ${s.label}`;
      });
      markdownSections.push(sourceLines.join("\n"));
    }
  }

  const markdown = markdownSections.join("\n\n");

  return {
    markdown,
    sources: sourcesList,
    uncited: uniqueUncited,
    conflicts,
    gaps,
    confidence
  };
}
