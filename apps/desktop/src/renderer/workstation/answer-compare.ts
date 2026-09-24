export interface AnswerInput {
  readonly providerId: string;
  readonly label: string;
  readonly text: string;
}

export interface ComparisonPoint {
  readonly point: string;
  readonly agreedBy: readonly string[];
  readonly missingFrom: readonly string[];
}

export interface Comparison {
  readonly headline: string;
  readonly agreements: readonly ComparisonPoint[];
  readonly differences: readonly ComparisonPoint[];
  readonly only: readonly {
    readonly label: string;
    readonly points: readonly string[];
  }[];
  readonly lengths: readonly {
    readonly label: string;
    readonly words: number;
  }[];
  readonly shortest: string;
  readonly longest: string;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "arent", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "cant", "cannot", "could", "couldnt",
  "did", "didnt", "do", "does", "doesnt", "doing", "dont", "down", "during",
  "each", "few", "for", "from", "further", "had", "hadnt", "has", "hasnt",
  "have", "havent", "having", "he", "hed", "hell", "hes", "her", "here",
  "heres", "hers", "herself", "him", "himself", "his", "how", "hows", "i",
  "id", "ill", "im", "ive", "if", "in", "into", "is", "isnt", "it", "its",
  "itself", "lets", "me", "more", "most", "mustnt", "my", "myself", "no",
  "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought",
  "our", "ours", "ourselves", "out", "over", "own", "same", "shant", "she",
  "shed", "shell", "shes", "should", "shouldnt", "so", "some", "such", "than",
  "that", "thats", "the", "their", "theirs", "them", "themselves", "then",
  "there", "theres", "these", "they", "theyd", "theyll", "theyre", "theyve",
  "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "wasnt", "we", "wed", "well", "were", "weve", "werent", "what",
  "whats", "when", "whens", "where", "wheres", "which", "while", "who",
  "whos", "whom", "why", "whys", "with", "wont", "would", "wouldnt", "you",
  "youd", "youll", "youre", "youve", "your", "yours", "yourself", "yourselves",
]);

const NUMBER_WORDS: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // ASCII values up to 32 represent whitespace characters including space, tab, and newlines
    if (code <= 32) {
      if (inWord) {
        count++;
        inWord = false;
      }
    } else {
      inWord = true;
    }
  }
  if (inWord) {
    count++;
  }
  return count;
}

function splitProseLine(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (!/[.!?]/.test(trimmed)) {
    return [trimmed];
  }

  // Preserve period tokens in recognized abbreviations and numbers so they are not treated as sentence boundaries
  const protectedText = trimmed
    .replace(/\b(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof)\./gi, "$1\u0000")
    .replace(/(\d+)\.(\d+)/g, "$1\u0000$2");

  const rawParts = protectedText.split(/(?<=[.!?]+)\s+/);
  const result: string[] = [];

  for (const part of rawParts) {
    const restored = part.replace(/\u0000/g, ".").trim();
    if (restored.length > 0) {
      result.push(restored);
    }
  }

  return result.length > 0 ? result : [trimmed];
}

function extractSentences(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const rawSentences: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const bulletMatch = /^\s*(?:[-*+•–—]|\(?\d+[.)\]]|\[\d+\])\s+(.*)$/.exec(trimmed);
    if (bulletMatch !== null) {
      const content = bulletMatch[1]?.trim() ?? "";
      if (content.length > 0) {
        rawSentences.push(content);
      }
      continue;
    }

    const proseSentences = splitProseLine(trimmed);
    for (const s of proseSentences) {
      if (s.length > 0) {
        rawSentences.push(s);
      }
    }
  }

  // Cap to 400 sentences to constrain processing latency without truncating visible claims
  return rawSentences.slice(0, 400);
}

function getSignificantWords(sentence: string): Set<string> {
  const cleaned = sentence
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();

  if (cleaned.length === 0) {
    return new Set<string>();
  }

  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  const filtered = words.filter((w) => !STOP_WORDS.has(w));

  // Retain the full word set if removing stopwords leaves nothing, preserving comparison on single-word sentences
  const finalWords = filtered.length > 0 ? filtered : words;
  return new Set<string>(finalWords);
}

/**
 * How much two sentences are saying the same thing.
 *
 * Jaccard alone was wrong here, and wrong in the direction that matters. Three
 * bots answering one brief are verbose by different amounts: "Launch the product
 * in September" and "We should launch the new product in September across
 * Europe" share every word the first one has, and Jaccard scores that 0.5
 * because the second says more. The owner reading that would be told his bots
 * disagreed, when all that differs is how much detail each gave.
 *
 * So this is containment — how much of the *shorter* sentence the longer one
 * covers — with Jaccard kept as a floor so a one-word sentence cannot be
 * declared identical to a paragraph that happens to contain that word. A short
 * sentence must also carry at least two significant words before it can be
 * contained in anything.
 */
/**
 * Whether a sentence says the opposite.
 *
 * The stopword list discards nineteen negations, `not` and `cannot` among them,
 * so "the contract renews" and "the contract does not renew" reduced to the
 * same significant words and were reported as an **agreement** — the two bots
 * flatly contradicting each other was the case this whole module exists to
 * surface, and it was the case it got exactly backwards.
 *
 * Removing them from the stopwords is not enough on its own: one extra word out
 * of four still clears the similarity threshold. Polarity has to be compared
 * separately from wording, which is what this is for. An even number of
 * negations is a positive statement again, which is why it counts rather than
 * looks.
 */
const NEGATIONS: ReadonlySet<string> = new Set([
  "not", "no", "never", "none", "cannot", "cant", "dont", "doesnt", "didnt",
  "isnt", "arent", "wasnt", "werent", "wont", "shouldnt", "couldnt", "wouldnt",
  "hasnt", "havent", "hadnt", "nor", "neither", "without", "unable", "fails",
  "failed", "lacks", "excludes", "denies", "refuses"
]);

export function isNegated(sentence: string): boolean {
  const words = sentence.toLowerCase().replace(/[^a-z0-9\s]/gu, " ").split(/\s+/u);
  let count = 0;
  for (const word of words) {
    if (NEGATIONS.has(word)) count += 1;
  }
  return count % 2 === 1;
}

function sentenceSimilarity(setA: ReadonlySet<string>, setB: ReadonlySet<string>): number {
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const word of smaller) {
    if (larger.has(word)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;
  if (smaller.size < 2) {
    return jaccard;
  }

  const containment = intersectionSize / smaller.size;
  return Math.max(jaccard, containment);
}

function pickClearestSentence(sentences: readonly string[]): string {
  if (sentences.length === 0) {
    return "";
  }
  const eightPlus = sentences.filter((s) => countWords(s) >= 8);
  if (eightPlus.length > 0) {
    return eightPlus.reduce((best, current) => (current.length < best.length ? current : best));
  }
  return sentences.reduce((best, current) => (current.length < best.length ? current : best));
}

function getCountWord(n: number): string {
  if (n >= 0 && n < NUMBER_WORDS.length) {
    return NUMBER_WORDS[n]!;
  }
  return String(n);
}

function formatHeadline(answersCount: number, agreementsCount: number, differencesCount: number): string {
  if (answersCount === 0) {
    return "There is nothing to compare.";
  }
  if (answersCount === 1) {
    return "There is only one answer, so there is nothing to compare.";
  }

  const pointWord = agreementsCount === 1 ? "point" : "points";
  const prefix = answersCount === 2 ? "Both" : `All ${getCountWord(answersCount)}`;
  return `${prefix} agree on ${agreementsCount} ${pointWord} and differ on ${differencesCount}.`;
}

interface SentenceMatch {
  readonly text: string;
  readonly answerIndex: number;
  readonly label: string;
  readonly words: ReadonlySet<string>;
}

interface Cluster {
  readonly sentences: SentenceMatch[];
  readonly answerIndices: Set<number>;
}

export function compareAnswers(answers: readonly AnswerInput[]): Comparison {
  const lengths = answers.map((a) => ({
    label: a.label,
    words: countWords(a.text),
  }));

  let shortest = "";
  let longest = "";
  let minWords = Infinity;
  let maxWords = -1;

  for (const item of lengths) {
    if (item.words < minWords) {
      minWords = item.words;
      shortest = item.label;
    }
    if (item.words > maxWords) {
      maxWords = item.words;
      longest = item.label;
    }
  }

  if (answers.length <= 1) {
    return {
      headline: formatHeadline(answers.length, 0, 0),
      agreements: [],
      differences: [],
      only: [],
      lengths,
      shortest,
      longest,
    };
  }

  const clusters: Cluster[] = [];

  for (let ansIdx = 0; ansIdx < answers.length; ansIdx++) {
    const answer = answers[ansIdx]!;
    const sentences = extractSentences(answer.text);

    for (const text of sentences) {
      const words = getSignificantWords(text);
      const matchItem: SentenceMatch = {
        text,
        answerIndex: ansIdx,
        label: answer.label,
        words,
      };

      // Two sentences about the same thing that disagree about it are not the
      // same point. Polarity is compared apart from wording; see `isNegated`.
      const negated = isNegated(text);

      let bestCluster: Cluster | null = null;
      let bestSim = 0;

      for (const cluster of clusters) {
        for (const existing of cluster.sentences) {
          // A sentence only joins a cluster when it agrees with it. Same words,
          // opposite polarity, is the disagreement worth reading.
          if (isNegated(existing.text) !== negated) continue;
          const sim = sentenceSimilarity(words, existing.words);
          if (sim >= 0.6 && sim > bestSim) {
            bestSim = sim;
            bestCluster = cluster;
          }
        }
      }

      if (bestCluster !== null) {
        bestCluster.sentences.push(matchItem);
        bestCluster.answerIndices.add(ansIdx);
      } else {
        clusters.push({
          sentences: [matchItem],
          answerIndices: new Set([ansIdx]),
        });
      }
    }
  }

  const rawAgreements: ComparisonPoint[] = [];
  const rawDifferences: ComparisonPoint[] = [];
  const providerOnlyMap = new Map<string, string[]>();

  for (const answer of answers) {
    providerOnlyMap.set(answer.label, []);
  }

  for (const cluster of clusters) {
    const point = pickClearestSentence(cluster.sentences.map((s) => s.text));
    const agreedBy: string[] = [];
    const missingFrom: string[] = [];

    for (let i = 0; i < answers.length; i++) {
      const label = answers[i]!.label;
      if (cluster.answerIndices.has(i)) {
        agreedBy.push(label);
      } else {
        missingFrom.push(label);
      }
    }

    if (agreedBy.length === answers.length) {
      rawAgreements.push({ point, agreedBy, missingFrom });
    } else if (answers.length >= 3 && agreedBy.length === 1) {
      const onlyLabel = agreedBy[0]!;
      const list = providerOnlyMap.get(onlyLabel);
      if (list !== undefined) {
        list.push(point);
      }
    } else {
      rawDifferences.push({ point, agreedBy, missingFrom });
    }
  }

  const agreements = rawAgreements.slice(0, 12);
  const differences = rawDifferences.slice(0, 12);

  const rawOnly: { readonly label: string; readonly points: readonly string[] }[] = [];
  if (answers.length >= 3) {
    for (const answer of answers) {
      const points = (providerOnlyMap.get(answer.label) ?? []).slice(0, 6);
      if (points.length > 0) {
        rawOnly.push({ label: answer.label, points });
      }
    }
  }

  return {
    headline: formatHeadline(answers.length, agreements.length, differences.length),
    agreements,
    differences,
    only: rawOnly,
    lengths,
    shortest,
    longest,
  };
}
