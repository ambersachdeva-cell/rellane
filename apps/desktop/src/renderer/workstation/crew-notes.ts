/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
}

export type CrewPartState =
  | "waiting"
  | "claimed"
  | "working"
  | "answered"
  | "refining"
  | "done"
  | "failed"
  | "stopped";

export interface CrewPartView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartState;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed";
  readonly headline: string;
  readonly canStop: boolean;
}

/** What one seat learned, written back so the next round starts with it. */
export interface CrewNote {
  readonly partId: string;
  readonly seatLabel: string;
  readonly finding: string;
  readonly confidence: "stated" | "inferred" | "uncertain";
  readonly at: number;
}

export interface SharedMemory {
  readonly agreed: readonly CrewNote[];
  readonly contested: readonly {
    readonly finding: string;
    readonly bySeat: readonly string[];
    readonly against: readonly string[];
  }[];
  readonly open: readonly CrewNote[];
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

const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "not", "no", "never", "cannot", "cant", "isnt", "doesnt", "wont", "shouldnt", "wouldnt",
]);

const STEM_EXCEPTIONS: ReadonlySet<string> = new Set([
  "this", "less", "pass", "plus", "status", "focus", "basis", "series", "always",
]);

function cleanFindingText(raw: string): string {
  return raw
    .replace(/^[\s*•\-–—+]+/, "")
    .replace(/^\d+[\.\)]\s+/, "")
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function isPleasantry(sentence: string): boolean {
  const s = sentence.toLowerCase().trim();
  const patterns: readonly RegExp[] = [
    /^(hi|hello|hey|greetings|dear)\b/,
    /^good (morning|afternoon|evening|day)\b/,
    /\b(thank you|thanks for|thanks!|thank you!)\b/,
    /\b(happy to help|glad to help|my pleasure)\b/,
    /\b(hope this helps|hope that helps|hope it helps)\b/,
    /\b(let me know if|feel free to|please let me know)\b/,
    /^(certainly|sure thing|of course)[,!.]?\s*(here is|here are)?\b/,
    /\b(best regards|kind regards|warm regards|warmly|cheers)\b/,
  ];
  return patterns.some((p) => p.test(s));
}

function isQuestionRestatement(sentence: string): boolean {
  const s = sentence.toLowerCase().trim();
  const patterns: readonly RegExp[] = [
    /^you asked (about|whether|if|for|to)\b/,
    /^you ('?ve|have) asked (about|whether|if|for|to)\b/,
    /^(regarding|in regards to|as for) your question\b/,
    /^in response to your question\b/,
    /^to answer your question\b/,
    /^you want to know\b/,
    /^as you (asked|requested|mentioned|noted)\b/,
  ];
  return patterns.some((p) => p.test(s));
}

function hasClaimMarkers(sentence: string): boolean {
  const hasDigit = /\d+/.test(sentence);
  const hasNumberWord = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|halves|third|thirds|quarter|quarters|percent|percentage|per cent)\b/i.test(sentence);
  const hasDate = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|today|tomorrow|yesterday|annually|monthly|weekly|daily|quarterly|deadline|q1|q2|q3|q4|year|month|decade)\b/i.test(sentence) || /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/.test(sentence) || /\b\d{1,2}(st|nd|rd|th)\b/i.test(sentence);
  const hasAcronym = /\b[A-Z]{2,}\b/.test(sentence);

  let hasMidSentenceProperNoun = false;
  const words = sentence.trim().split(/\s+/);
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      const stripped = words[i]!.replace(/[^a-zA-Z]/g, "");
      if (/^[A-Z][a-z]+$/.test(stripped) && !/^(I|I'm|I've|I'd|I'll)$/.test(stripped)) {
        hasMidSentenceProperNoun = true;
        break;
      }
    }
  }

  const hasComparative = /\b(more|less|fewer|greater|higher|lower|better|worse|faster|slower|earlier|later|larger|smaller|cheaper|longer|shorter|exceeds|exceeding|increased|decreased|increase|decrease|before|after|than)\b/i.test(sentence);
  const hasModal = /\b(must|should|cannot|can't|could|would|shall|may|might|ought)\b/i.test(sentence);

  /**
   * Saying plainly what is *not* known is a finding too.
   *
   * Without this, a sentence like "It is unclear whether the policy covers
   * transport" carried no number, date, proper noun, comparative or modal, so
   * it was dropped before it was ever classified — which meant the `uncertain`
   * confidence below could almost never fire, and the one thing the owner most
   * needs from a second bot, an admission of doubt, was the thing thrown away.
   */
  const statesAnUnknown =
    /\b(unclear|cannot tell|can't tell|would need|not clear|hard to tell|unknown|unsure|no way to know|not stated|does not say)\b/i.test(sentence);

  return hasDigit || hasNumberWord || hasDate || hasAcronym || hasMidSentenceProperNoun || hasComparative || hasModal || statesAnUnknown;
}

function detectConfidence(sentence: string): "stated" | "inferred" | "uncertain" {
  if (sentence.includes("?") || /\b(unclear|cannot tell|can't tell|would need|not clear|hard to tell|unknown|unsure)\b/i.test(sentence)) {
    return "uncertain";
  }
  if (/\b(appears|suggests|likely|probably|seems?|seemed|presumed?|presumably|estimated?|assumes?|assumed)\b/i.test(sentence)) {
    return "inferred";
  }
  return "stated";
}

function calculateSpecificity(sentence: string): number {
  let score = 0;
  const digits = sentence.match(/\d+/g);
  if (digits) {
    score += digits.length;
  }
  const numberWords = sentence.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter|percent|percentage)\b/gi);
  if (numberWords) {
    score += numberWords.length;
  }
  const acronyms = sentence.match(/\b[A-Z0-9]{2,}\b/g);
  if (acronyms) {
    score += acronyms.length;
  }
  const words = sentence.trim().split(/\s+/);
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!.replace(/[^a-zA-Z]/g, "");
      if (/^[A-Z][a-z]+$/.test(w) && !/^(I|I'm|I've)$/.test(w)) {
        score += 1;
      }
    }
  }
  return score;
}

function splitIntoSentences(text: string): readonly string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }
  const boundedText = text.length > 300_000 ? text.slice(0, 300_000) : text;
  const lines = boundedText.split(/\r?\n/);
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const stripped = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[\s*•\-–—+]+/, "")
      .replace(/^\d+[\.\)]\s+/, "")
      .trim();
    if (!stripped) {
      continue;
    }

    const shielded = stripped
      .replace(/(\d)\.(\d)/g, "$1__DEC__$2")
      .replace(/\b(e\.g|i\.e|etc|vs|mr|mrs|ms|dr)\./gi, "$1__DOT__");

    const parts = shielded.split(/(?<=[.!?])(?:\s+|$)/);
    for (const part of parts) {
      const restored = part
        .replace(/__DEC__/g, ".")
        .replace(/__DOT__/g, ".")
        .trim();
      if (restored.length > 0) {
        collected.push(restored);
        if (collected.length >= 400) {
          return collected;
        }
      }
    }
  }

  return collected;
}

export function notesFromAnswer(input: {
  readonly partId: string;
  readonly seatLabel: string;
  readonly answer: string;
  readonly at: number;
}): readonly CrewNote[] {
  const sentences = splitIntoSentences(input.answer);
  interface ScoredCandidate {
    readonly finding: string;
    readonly confidence: "stated" | "inferred" | "uncertain";
    readonly specificity: number;
    readonly index: number;
  }

  const candidates: ScoredCandidate[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const rawSentence = sentences[i]!;
    if (countWords(rawSentence) < 6) {
      continue;
    }
    if (isPleasantry(rawSentence)) {
      continue;
    }
    if (isQuestionRestatement(rawSentence)) {
      continue;
    }
    if (!hasClaimMarkers(rawSentence)) {
      continue;
    }

    const confidence = detectConfidence(rawSentence);
    const cleaned = cleanFindingText(rawSentence);
    if (!cleaned) {
      continue;
    }

    candidates.push({
      finding: cleaned,
      confidence,
      specificity: calculateSpecificity(rawSentence),
      index: i,
    });
  }

  candidates.sort((a, b) => {
    if (b.specificity !== a.specificity) {
      return b.specificity - a.specificity;
    }
    return a.index - b.index;
  });

  const capped = candidates.slice(0, 8);
  return capped.map((item) => ({
    partId: input.partId,
    seatLabel: input.seatLabel,
    finding: item.finding,
    confidence: item.confidence,
    at: input.at,
  }));
}

interface NormalizedFinding {
  readonly note: CrewNote;
  readonly significantWords: ReadonlySet<string>;
  readonly hasNegation: boolean;
}

function extractSignificantWords(text: string): {
  readonly words: ReadonlySet<string>;
  readonly hasNegation: boolean;
} {
  const lower = text.toLowerCase();
  const hasNegation = /\b(not|no|never|cannot|can't|cant|isn't|isnt|doesn't|doesnt|won't|wont|shouldn't|shouldnt|wouldn't|wouldnt)\b/i.test(lower);

  let normalized = lower
    .replace(/%/g, " percent ")
    .replace(/\bper cent\b/g, "percent");

  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    const re = new RegExp(`\\b${word}\\b`, "g");
    normalized = normalized.replace(re, digit);
  }

  const cleaned = normalized.replace(/[^\w\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  const result = new Set<string>();

  for (const token of tokens) {
    if (STOPWORDS.has(token) || NEGATION_WORDS.has(token)) {
      continue;
    }
    let stemmed = token;
    if (stemmed.endsWith("s") && stemmed.length > 3 && !STEM_EXCEPTIONS.has(stemmed)) {
      stemmed = stemmed.slice(0, -1);
    }
    result.add(stemmed);
  }

  return { words: result, hasNegation };
}

function calculateWordOverlap(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  const minSize = Math.min(setA.size, setB.size);
  if (minSize === 0) {
    return 0;
  }
  let intersectionCount = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersectionCount++;
    }
  }
  return intersectionCount / minSize;
}

function countToWord(n: number): string {
  const words: readonly string[] = [
    "zero", "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  ];
  if (n >= 0 && n < words.length) {
    return words[n]!;
  }
  return String(n);
}

function thingNoun(n: number): string {
  return n === 1 ? "thing" : "things";
}

function capitalizeFirst(text: string): string {
  if (!text) {
    return "";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildHeadline(agreedCount: number, contestedCount: number, openCount: number): string {
  if (agreedCount > 0 && contestedCount > 0) {
    return `${capitalizeFirst(countToWord(agreedCount))} ${thingNoun(agreedCount)} they agree on, ${countToWord(contestedCount)} they do not.`;
  }
  if (agreedCount > 0 && contestedCount === 0) {
    return `${capitalizeFirst(countToWord(agreedCount))} ${thingNoun(agreedCount)} they agree on.`;
  }
  if (agreedCount === 0 && contestedCount > 0) {
    return `${capitalizeFirst(countToWord(contestedCount))} ${thingNoun(contestedCount)} they do not agree on.`;
  }
  if (agreedCount === 0 && contestedCount === 0 && openCount > 0) {
    return `${capitalizeFirst(countToWord(openCount))} ${thingNoun(openCount)} noted, none yet confirmed.`;
  }
  return "Nothing noted yet.";
}

export function mergeNotes(notes: readonly CrewNote[]): SharedMemory {
  if (notes.length === 0) {
    return {
      agreed: [],
      contested: [],
      open: [],
      headline: buildHeadline(0, 0, 0),
    };
  }

  const distinctSeats = new Set(notes.map((n) => n.seatLabel));

  if (distinctSeats.size <= 1) {
    const deduplicatedOpen: CrewNote[] = [];
    for (const note of notes) {
      const { words: noteWords } = extractSignificantWords(note.finding);
      const exists = deduplicatedOpen.some((existing) => {
        const { words: existingWords } = extractSignificantWords(existing.finding);
        return calculateWordOverlap(noteWords, existingWords) >= 0.6;
      });
      if (!exists) {
        deduplicatedOpen.push(note);
      }
    }
    return {
      agreed: [],
      contested: [],
      open: deduplicatedOpen,
      headline: buildHeadline(0, 0, deduplicatedOpen.length),
    };
  }

  const normalizedList: readonly NormalizedFinding[] = notes.map((note) => {
    const { words, hasNegation } = extractSignificantWords(note.finding);
    return { note, significantWords: words, hasNegation };
  });

  interface NoteCluster {
    readonly items: NormalizedFinding[];
  }

  const clusters: NoteCluster[] = [];

  for (const item of normalizedList) {
    let matched = false;
    for (const cluster of clusters) {
      const representative = cluster.items[0]!;
      if (calculateWordOverlap(item.significantWords, representative.significantWords) >= 0.6) {
        cluster.items.push(item);
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({ items: [item] });
    }
  }

  const agreedList: CrewNote[] = [];
  const contestedList: {
    readonly finding: string;
    readonly bySeat: readonly string[];
    readonly against: readonly string[];
  }[] = [];
  const openList: CrewNote[] = [];

  for (const cluster of clusters) {
    const positiveItems = cluster.items.filter((it) => !it.hasNegation);
    const negativeItems = cluster.items.filter((it) => it.hasNegation);

    const positiveSeats = Array.from(new Set(positiveItems.map((it) => it.note.seatLabel)));
    const negativeSeats = Array.from(new Set(negativeItems.map((it) => it.note.seatLabel)));

    if (positiveSeats.length > 0 && negativeSeats.length > 0) {
      const positiveFinding = (positiveItems[0] ?? cluster.items[0])!.note.finding;
      contestedList.push({
        finding: positiveFinding,
        bySeat: positiveSeats,
        against: negativeSeats,
      });
      continue;
    }

    const clusterSeats = new Set(cluster.items.map((it) => it.note.seatLabel));

    if (clusterSeats.size >= 2) {
      const sortedByConfidence = [...cluster.items].sort((a, b) => {
        const order = { stated: 3, inferred: 2, uncertain: 1 };
        return order[b.note.confidence] - order[a.note.confidence];
      });
      agreedList.push(sortedByConfidence[0]!.note);
    } else {
      openList.push(cluster.items[0]!.note);
    }
  }

  return {
    agreed: agreedList,
    contested: contestedList,
    open: openList,
    headline: buildHeadline(agreedList.length, contestedList.length, openList.length),
  };
}
