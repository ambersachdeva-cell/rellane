/** Structurally a subset of the real turn row; do not import the real one. */
export interface TurnLike {
  readonly id: string;
  readonly seat: string;
  readonly kind: string;
  readonly body: string;
}

export interface ProposedRoutine {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly sourceHint: string;
  readonly outputLabel: string;
  /** Why this was proposed, in the owner's language. Shown beside the proposal. */
  readonly because: string;
  /** Turn ids the proposal was derived from, so the owner can check it. */
  readonly evidence: readonly string[];
}

export const MIN_PROMPT_CHARS = 40;
export const MAX_PROMPT_CHARS = 8_000;

const DEFAULT_OUTPUT_LABEL = "Draft answer";
const NEUTRAL_PLACEHOLDER = "[subject]";

interface QuotedProperNoun {
  readonly fullMatch: string;
  readonly noun: string;
}

/**
 * Escapes characters with special meaning in regular expressions so user text
 * can be safely searched for exact word-boundary matches.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Counts whole-word occurrences of a noun within the text to distinguish
 * single mentions from recurring job-specific concepts.
 */
function countOccurrences(text: string, term: string): number {
  const pattern = new RegExp(`\\b${escapeRegex(term)}\\b`, "gi");
  const matches = text.match(pattern);
  return matches !== null ? matches.length : 0;
}

/**
 * Discovers proper nouns wrapped in quotes so they can be inspected for
 * safe generalisation across routine executions.
 */
function findQuotedProperNouns(text: string): readonly QuotedProperNoun[] {
  const quoteRegex =
    /(?:"([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*)"|'([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*)'|“([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*)”|‘([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*)’)/g;

  const matches: QuotedProperNoun[] = [];
  let m: RegExpExecArray | null;
  while ((m = quoteRegex.exec(text)) !== null) {
    const fullMatch = m[0];
    const noun = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (fullMatch !== undefined && noun !== undefined) {
      matches.push({ fullMatch, noun });
    }
  }
  return matches;
}

/**
 * Removes conversational greetings from prompt openings to produce a neutral,
 * reusable instruction template.
 */
function stripGreeting(text: string): string {
  const trimmed = text.trim();
  const greetingPattern =
    /^(?:(?:hi|hello|hey|greetings)\b(?:\s+(?:there|rellane|assistant|codex|claude|gemini|all|team|[A-Z][a-z]+))?|good\s+(?:morning|afternoon|evening))\s*[,!.:;\-–—]?\s*/i;

  let current = trimmed;
  while (greetingPattern.test(current)) {
    const next = current.replace(greetingPattern, "").trim();
    if (next.length === 0) {
      break;
    }
    current = next;
  }

  if (current.length === 0) {
    return trimmed;
  }

  return current.charAt(0).toUpperCase() + current.slice(1);
}

/**
 * Replaces a quoted proper noun only when it appears once in the entire request,
 * leaving repeated entities intact to avoid corrupting specific dependencies.
 */
function generalisePrompt(text: string): string {
  const quotedItems = findQuotedProperNouns(text);
  let result = text;

  for (const item of quotedItems) {
    if (countOccurrences(text, item.noun) === 1) {
      result = result.replace(item.fullMatch, NEUTRAL_PLACEHOLDER);
    }
  }

  return result;
}

/**
 * Extracts a concise, non-technical title from the owner's request words,
 * constrained to 60 characters in sentence case without trailing punctuation.
 */
function deriveTitle(promptText: string): string {
  const firstSentence = promptText.split(/[.!?;\n]/)[0] ?? promptText;
  let candidate = firstSentence.trim();

  const politePrefix =
    /^(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+need\s+you\s+to\s+|help\s+me\s+)/i;
  candidate = candidate.replace(politePrefix, "").trim();

  if (candidate.length === 0) {
    candidate = promptText.trim();
  }

  const isAllCaps = candidate === candidate.toUpperCase() && /[A-Z]/.test(candidate);
  const normalized = isAllCaps ? candidate.toLowerCase() : candidate;
  let title = normalized.charAt(0).toUpperCase() + normalized.slice(1);

  title = title.replace(/\.+$/, "").trim();

  if (title.length > 60) {
    const slice = title.slice(0, 60);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > 20) {
      title = slice.slice(0, lastSpace).trim();
    } else {
      title = slice.trim();
    }
  }

  title = title.replace(/[,;:\s\-–—.]+$/, "").trim();
  return title;
}

/**
 * Extracts an identifiable document or artifact label from the answer's primary
 * heading, defaulting calmly when no recognizable structure exists.
 */
function deriveOutputLabel(answerBody: string): string {
  const lines = answerBody.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch && headingMatch[1]) {
      const heading = headingMatch[1].trim();
      const primary = heading.split(/[:\-–—|]/)[0]?.trim() ?? heading;
      if (primary.length > 0 && primary.length <= 40) {
        const cleaned = primary.replace(/^\d+\.\s*/, "").replace(/[.#*]+$/, "").trim();
        if (
          cleaned.length > 0 &&
          !/^(?:introduction|overview|answer|response|summary)$/i.test(cleaned)
        ) {
          return cleaned;
        }
      }
    }

    const boldMatch = line.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch && boldMatch[1]) {
      const boldText = boldMatch[1].trim();
      const primary = boldText.split(/[:\-–—|]/)[0]?.trim() ?? boldText;
      if (primary.length > 0 && primary.length <= 40) {
        return primary;
      }
    }

    break;
  }

  return DEFAULT_OUTPUT_LABEL;
}

/**
 * Formats a list of seat names into plain British English without inventing
 * categories not present in the demonstrated work.
 */
function formatSeats(seats: readonly string[]): string {
  if (seats.length === 0) {
    return "sources";
  }
  if (seats.length === 1) {
    return seats[0]!;
  }
  if (seats.length === 2) {
    return `${seats[0]!} or ${seats[1]!}`;
  }
  const leading = seats.slice(0, -1).join(", ");
  const last = seats[seats.length - 1]!;
  return `${leading} or ${last}`;
}

/**
 * Translates a numeric count into plain British English words for small counts.
 */
function formatSourceCount(count: number): string {
  const wordMap: Record<number, string> = {
    1: "one",
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten"
  };
  const countWord = wordMap[count] ?? String(count);
  return `${countWord} ${count === 1 ? "source" : "sources"}`;
}

/**
 * Prepend an appropriate indefinite article in calm British English.
 */
function formatWithArticle(label: string): string {
  const lower = label.toLowerCase();
  const article = /^[aeiou]/i.test(lower) ? "an" : "a";
  return `${article} ${lower}`;
}

/**
 * Evaluates finished work turns to propose a reusable routine when an owner's
 * repeated workflow pattern has been demonstrated with sources and outputs.
 */
export function proposeRoutine(turns: readonly TurnLike[]): ProposedRoutine | null {
  if (turns.length === 0) {
    return null;
  }

  // Identify the owner's initial qualifying request turn.
  const ownerTurn = turns.find(
    (t) =>
      t.seat === "owner" &&
      t.kind === "verbatim" &&
      t.body.trim().length >= MIN_PROMPT_CHARS
  );

  if (!ownerTurn) {
    return null;
  }

  if (ownerTurn.body.length > MAX_PROMPT_CHARS) {
    return null;
  }

  // Work must contain at least one external source turn grounding the job.
  const sourceTurns = turns.filter(
    (t) => t.kind === "verbatim" && t.seat !== "owner" && t.body.trim().length > 0
  );

  if (sourceTurns.length === 0) {
    return null;
  }

  // Work must demonstrate a produced answer from an assistant seat.
  const answerTurns = turns.filter(
    (t) => t.seat !== "owner" && t.kind === "answer" && t.body.trim().length > 0
  );

  if (answerTurns.length === 0) {
    return null;
  }

  const primaryAnswer = answerTurns[0]!;

  const generalizedPrompt = generalisePrompt(stripGreeting(ownerTurn.body));

  if (generalizedPrompt.length > MAX_PROMPT_CHARS) {
    return null;
  }

  const seenSeats = new Set<string>();
  const uniqueSeats: string[] = [];
  for (const source of sourceTurns) {
    const seat = source.seat.trim();
    if (seat.length > 0 && !seenSeats.has(seat)) {
      seenSeats.add(seat);
      uniqueSeats.push(seat);
    }
  }

  const title = deriveTitle(generalizedPrompt);
  const outputLabel = deriveOutputLabel(primaryAnswer.body);
  const sourceHint = `Select ${formatSeats(uniqueSeats)} to ground this routine.`;
  const because = `Observed ${formatSourceCount(sourceTurns.length)} used to produce ${formatWithArticle(outputLabel)}.`;
  const description = `Produce ${formatWithArticle(outputLabel)} from selected ${formatSeats(uniqueSeats)}.`;

  // Preserve input sequence order for all turns used to establish the routine.
  const usedIds = new Set<string>();
  usedIds.add(ownerTurn.id);
  for (const source of sourceTurns) {
    usedIds.add(source.id);
  }
  usedIds.add(primaryAnswer.id);

  const evidence: readonly string[] = turns
    .filter((t) => usedIds.has(t.id))
    .map((t) => t.id);

  return {
    title,
    description,
    prompt: generalizedPrompt,
    sourceHint,
    outputLabel,
    because,
    evidence
  };
}
