/** One part of a split request, and who is taking it. */
export interface CrewPart {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
}

export interface CrewSplitInput {
  readonly request: string;
  readonly seats: readonly { readonly id: string; readonly label: string }[];
  readonly sourceIds: readonly string[];
}

export interface CrewSplit {
  readonly parts: readonly CrewPart[];
  readonly summary: string;
  readonly wholeJob: boolean;
  readonly refusedBecause: string | null;
}

export const MAX_PARTS = 6;
const MIN_REQUEST_LENGTH = 3;
const MAX_REQUEST_LENGTH = 10000;

// Flags ordering markers between sequential task phases.
const DEPENDENCY_REGEX =
  /^(?:(?:and\s+)?then|after\s+that|afterwards|once\s+you\s+have)\b|\b(?:from\s+(?:that|this|it|those)|based\s+on\s+(?:that|this|it|those|the\s+above)|using\s+(?:that|this|it|the\s+(?:output|results?)))\b/i;

// Splits sequential transitions that cannot run concurrently.
const SEQUENTIAL_SPLIT_REGEX =
  /\s*(?:,\s*)?\band\s+then\b\s*|\s*(?:,\s*)\bthen\b\s*|\s*(?:,\s*)?\bafter\s+that\b\s*|\s*(?:,\s*)?\bonce\s+you\s+have\b\s*|\s*(?:,\s*)?\bafterwards\b\s*/i;

const EXPLICIT_PART_REGEX = /\b(?:part|section)\s+([a-zA-Z0-9]+)\b\s*[:\-\.]?\s*/gi;
const LIST_LINE_REGEX = /^\s*(?:(?:\d+|[a-zA-Z])[\.\)]|[-*•])\s+(.+)$/;
const INLINE_LIST_REGEX = /(?:^|[\s(])([a-zA-Z]|\d{1,2})[\)\.]\s+/g;
const CONJUNCTION_SPLIT_REGEX = /\s*(?:,\s*)?\band\s+also\b\s*|\s*(?:,\s*)?\bas\s+well\s+as\b\s*|\s*(?:,\s*)?\bplus\b\s*/i;
const PLEASANTRY_REGEX = /^(?:thanks!?|thank\s+you.*|cheers!?|regards.*|best\s+wishes.*)$/i;

// Common instruction verbs in task requests.
const VERBS = new Set([
  "analyse", "analyze", "answer", "apply", "arrange", "assess", "audit", "build",
  "calculate", "check", "choose", "clarify", "clean", "compare", "compile", "compose",
  "confirm", "convert", "correct", "count", "create", "debug", "decide", "define",
  "describe", "design", "detect", "determine", "develop", "dispatch", "do", "draft",
  "draw", "edit", "evaluate", "examine", "explain", "extract", "find", "fix",
  "format", "generate", "get", "give", "handle", "identify", "implement", "inspect",
  "investigate", "list", "make", "modify", "organise", "organize", "outline", "parse",
  "perform", "plan", "prepare", "print", "produce", "propose", "provide", "read",
  "record", "refactor", "remove", "report", "research", "resolve", "review", "run",
  "save", "scan", "search", "select", "send", "show", "simplify", "solve",
  "sort", "specify", "split", "summarise", "summarize", "test", "update", "verify", "write"
]);

interface ParsedItem {
  readonly text: string;
  readonly isSequential: boolean;
  readonly explicitDependsOn: readonly string[];
}

interface ParseResult {
  readonly items: readonly ParsedItem[];
  readonly wasCapped: boolean;
  readonly totalItems: number;
}

function countWords(text: string): number {
  const tokens = text.trim().split(/\s+/);
  return tokens[0] === "" ? 0 : tokens.length;
}

function hasVerb(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 0);
  for (const word of words) {
    if (VERBS.has(word) || (word.length > 4 && (word.endsWith("ing") || word.endsWith("ed") || word.endsWith("ize") || word.endsWith("ise")))) {
      return true;
    }
  }
  return false;
}

function isEntirelyCodeBlock(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("```") && trimmed.endsWith("```") && trimmed.length >= 6) ||
    (trimmed.startsWith("~~~") && trimmed.endsWith("~~~") && trimmed.length >= 6)
  );
}

function deriveTitle(prompt: string): string {
  const cleaned = prompt.replace(/[.;]+$/u, "").trim();
  const base = cleaned.length > 0 ? cleaned : prompt;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function formatSeatList(labels: readonly string[]): string {
  const first = labels[0];
  if (!first) return "";
  if (labels.length === 1) return first;
  const second = labels[1];
  if (labels.length === 2 && second) return `${first} and ${second}`;
  const allExceptLast = labels.slice(0, -1).join(", ");
  const last = labels[labels.length - 1];
  return `${allExceptLast} and ${last ?? ""}`;
}

function formatAction(title: string): string {
  if (title.toLowerCase().startsWith("part ") || title.length <= 3) {
    return `handle ${title}`;
  }
  const tokens = title.split(/\s+/);
  const firstWord = tokens[0]?.toLowerCase() ?? "";
  if (VERBS.has(firstWord)) {
    return title.charAt(0).toLowerCase() + title.slice(1);
  }
  return `handle ${title.charAt(0).toLowerCase() + title.slice(1)}`;
}

function parseExplicitParts(text: string): ParseResult | null {
  const matches = Array.from(text.matchAll(EXPLICIT_PART_REGEX));
  if (matches.length < 2) return null;

  const items: ParsedItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current || current.index === undefined) break;
    const startIndex = current.index + current[0].length;
    const nextMatch = matches[i + 1];
    const endIndex = nextMatch && nextMatch.index !== undefined ? nextMatch.index : text.length;
    const cleaned = text.slice(startIndex, endIndex).replace(/\s*(?:,\s*)?(?:\band\b|[;,])\s*$/i, "").replace(/[.;]+$/u, "").trim();
    if (cleaned.length === 0) continue;
    items.push({
      text: cleaned,
      isSequential: i > 0 && DEPENDENCY_REGEX.test(cleaned),
      explicitDependsOn: []
    });
  }

  if (items.length < 2) return null;
  return { items: items.slice(0, MAX_PARTS), wasCapped: items.length > MAX_PARTS, totalItems: items.length };
}

function parseInlineLetterList(text: string): ParseResult | null {
  const matches = Array.from(text.matchAll(INLINE_LIST_REGEX));
  if (matches.length < 2) return null;
  const m0 = matches[0]?.[1]?.toLowerCase();
  const m1 = matches[1]?.[1]?.toLowerCase();
  if (!m0 || !m1) return null;

  const isAlpha = /^[a-z]$/.test(m0) && /^[a-z]$/.test(m1);
  const isNum = /^\d+$/.test(m0) && /^\d+$/.test(m1);
  if (!isAlpha && !isNum) return null;
  if (isAlpha && m1.charCodeAt(0) - m0.charCodeAt(0) !== 1) return null;
  if (isNum && Number.parseInt(m1, 10) - Number.parseInt(m0, 10) !== 1) return null;

  const items: ParsedItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current || current.index === undefined) break;
    const startIndex = current.index + current[0].length;
    const next = matches[i + 1];
    const endIndex = next && next.index !== undefined ? next.index : text.length;
    const cleaned = text.slice(startIndex, endIndex).replace(/\s*(?:,\s*)?(?:\band\b|[;,])\s*$/i, "").replace(/[.;]+$/u, "").trim();
    if (cleaned.length === 0) continue;
    /**
     * A sign-off is not a part of the job.
     *
     * This parser runs before the line-based one, so a numbered list ending
     * "3. thanks!" never reached that one's filter and became a third part — a
     * bot asked to work on the word "thanks", and the owner's quota spent on
     * it. No four-word minimum here, unlike the line parser: an inline item is
     * legitimately short ("a) list the risks"), and a single word never is.
     */
    if (PLEASANTRY_REGEX.test(cleaned) || countWords(cleaned) < 2) continue;
    items.push({
      text: cleaned,
      isSequential: i > 0 && DEPENDENCY_REGEX.test(cleaned),
      explicitDependsOn: []
    });
  }

  if (items.length < 2) return null;
  return { items: items.slice(0, MAX_PARTS), wasCapped: items.length > MAX_PARTS, totalItems: items.length };
}

function parseOrdinals(text: string): ParseResult | null {
  const match = /\b(?:first|firstly)\b\s*[:\-]?\s*([\s\S]+?)\s*\b(?:second|secondly)\b\s*[:\-]?\s*([\\s\S]+)/i.exec(text);
  if (!match) return null;
  const part1 = match[1]?.trim().replace(/\s*(?:,\s*)?(?:\band\b|[;,])\s*$/i, "").replace(/[.;]+$/u, "").trim();
  const rest = match[2]?.trim().replace(/[.;]+$/u, "").trim();
  if (!part1 || !rest) return null;
  return {
    items: [
      { text: part1, isSequential: false, explicitDependsOn: [] },
      { text: rest, isSequential: false, explicitDependsOn: [] }
    ],
    wasCapped: false,
    totalItems: 2
  };
}

function parseListLines(text: string): ParseResult | null {
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  const items: ParsedItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const match = LIST_LINE_REGEX.exec(line);
    if (!match?.[1]) continue;
    const content = match[1].trim();
    // Polite closings and short fragments are omitted to avoid wasted model runs.
    if (PLEASANTRY_REGEX.test(content) || countWords(content) < 4) continue;
    items.push({
      text: content,
      isSequential: items.length > 0 && DEPENDENCY_REGEX.test(content),
      explicitDependsOn: []
    });
  }

  if (items.length < 2) return null;
  return { items: items.slice(0, MAX_PARTS), wasCapped: items.length > MAX_PARTS, totalItems: items.length };
}

function parseConjunctionsAndSemicolons(text: string): ParseResult | null {
  if (text.includes(";")) {
    const segments = text.split(";").map((s) => s.trim().replace(/[.;]+$/u, "")).filter((s) => s.length > 0);
    if (segments.length >= 2 && segments.every((s) => countWords(s) >= 4 && hasVerb(s))) {
      const items = segments.slice(0, MAX_PARTS).map((seg, idx) => ({
        text: seg,
        isSequential: idx > 0 && DEPENDENCY_REGEX.test(seg),
        explicitDependsOn: []
      }));
      return { items, wasCapped: segments.length > MAX_PARTS, totalItems: segments.length };
    }
  }

  const parts = text.split(CONJUNCTION_SPLIT_REGEX).map((p) => p.trim().replace(/[.;]+$/u, "")).filter((p) => p.length > 0);
  if (parts.length >= 2 && parts.every((p) => countWords(p) >= 4 && hasVerb(p))) {
    const items = parts.slice(0, MAX_PARTS).map((p, idx) => ({
      text: p,
      isSequential: idx > 0 && DEPENDENCY_REGEX.test(p),
      explicitDependsOn: []
    }));
    return { items, wasCapped: parts.length > MAX_PARTS, totalItems: parts.length };
  }

  return null;
}

function parseSequentialAndParallel(text: string): ParseResult | null {
  const phases = text.split(SEQUENTIAL_SPLIT_REGEX).map((p) => p.trim().replace(/[.;]+$/u, "")).filter((p) => p.length > 0);
  if (phases.length < 2) return null;

  const stageGroups: { readonly texts: readonly string[]; readonly isSequential: boolean }[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phaseText = phases[i];
    if (!phaseText) continue;
    const subParts = phaseText.split(/\s*(?:,\s*)?\band\b\s*|\s*,\s*/i).map((s) => s.trim().replace(/[.;]+$/u, "")).filter((s) => s.length > 0);
    if (subParts.length >= 2 && subParts.every((s) => s.length > 0)) {
      stageGroups.push({ texts: subParts, isSequential: i > 0 });
    } else {
      stageGroups.push({ texts: [phaseText], isSequential: i > 0 });
    }
  }

  const flatItems: { readonly text: string; readonly dependsOnIds: readonly string[] }[] = [];
  let previousStageIds: readonly string[] = [];

  for (const stage of stageGroups) {
    const currentStageIds: string[] = [];
    for (const subText of stage.texts) {
      const id = `part-${flatItems.length + 1}`;
      currentStageIds.push(id);
      flatItems.push({
        text: subText,
        dependsOnIds: stage.isSequential ? previousStageIds : []
      });
    }
    previousStageIds = currentStageIds;
  }

  if (flatItems.length < 2) return null;
  return {
    items: flatItems.slice(0, MAX_PARTS).map((item) => ({
      text: item.text,
      isSequential: item.dependsOnIds.length > 0,
      explicitDependsOn: item.dependsOnIds
    })),
    wasCapped: flatItems.length > MAX_PARTS,
    totalItems: flatItems.length
  };
}

function buildWholeJobSummary(
  activeSeat: { readonly id: string; readonly label: string },
  spareSeats: readonly { readonly id: string; readonly label: string }[]
): string {
  if (spareSeats.length === 0) return `${activeSeat.label} will take the whole job.`;
  const spareLabels = formatSeatList(spareSeats.map((s) => s.label));
  const verb = spareSeats.length === 1 ? "sits" : "sit";
  return `${activeSeat.label} will take the whole job, while ${spareLabels} ${verb} this one out to preserve your quota.`;
}

function buildCrewSummary(
  parts: readonly CrewPart[],
  allSeats: readonly { readonly id: string; readonly label: string }[],
  wasCapped: boolean,
  totalItems: number
): string {
  const assignedSeatIds = new Set(parts.map((p) => p.seatId));
  const spareSeats = allSeats.filter((s) => !assignedSeatIds.has(s.id));
  const assignedLabels = formatSeatList(allSeats.filter((s) => assignedSeatIds.has(s.id)).map((s) => s.label));
  const spareLabels = spareSeats.length > 0 ? formatSeatList(spareSeats.map((s) => s.label)) : "";
  const spareVerb = spareSeats.length === 1 ? "sits" : "sit";
  const spareClause = spareLabels.length > 0 ? `, while ${spareLabels} ${spareVerb} this one out to preserve your quota` : "";

  if (wasCapped) {
    return `${parts.length} parts divided across ${assignedLabels}, capped at ${MAX_PARTS} from ${totalItems} items in your request${spareClause}.`;
  }

  if (parts.length === 2 && allSeats.length === 2 && spareSeats.length === 0) {
    const p1 = parts[0]!;
    const p2 = parts[1]!;
    const isSeq = p2.dependsOn.includes(p1.id);
    return `${p1.seatLabel} will ${formatAction(p1.title)}${isSeq ? ", then " : ", and "}${p2.seatLabel} will ${formatAction(p2.title)}.`;
  }

  if (parts.length === 2 && spareSeats.length > 0) {
    const p1 = parts[0]!;
    const p2 = parts[1]!;
    const isSeq = p2.dependsOn.includes(p1.id);
    return `${p1.seatLabel} will ${formatAction(p1.title)}${isSeq ? ", then " : " and "}${p2.seatLabel} will ${formatAction(p2.title)}${spareClause}.`;
  }

  if (allSeats.length === 1) {
    return `${parts.length} parts assigned to ${allSeats[0]!.label}, running in sequence.`;
  }

  return `${parts.length} parts divided across ${assignedLabels}${spareClause}.`;
}

export function splitForCrew(input: CrewSplitInput): CrewSplit {
  const normalized = input.request.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.trim();

  if (trimmed.length < MIN_REQUEST_LENGTH) {
    return {
      parts: [],
      summary: "Your request is too short to divide.",
      wholeJob: false,
      refusedBecause: "Your request must be at least 3 characters long."
    };
  }

  if (input.request.length > MAX_REQUEST_LENGTH) {
    return {
      parts: [],
      summary: "Your request is too long to divide.",
      wholeJob: false,
      refusedBecause: "Your request is too long to divide. Keep it under 10,000 characters."
    };
  }

  if (input.seats.length === 0) {
    return {
      parts: [],
      summary: "No bots are selected to run this request.",
      wholeJob: false,
      refusedBecause: "Select at least one bot to divide work."
    };
  }

  // Code blocks should be audited as a unit rather than broken into syntax fragments.
  if (isEntirelyCodeBlock(trimmed)) {
    const seat = input.seats[0]!;
    return {
      parts: [{
        id: "part-1",
        title: "Review code block",
        prompt: trimmed,
        seatId: seat.id,
        seatLabel: seat.label,
        dependsOn: []
      }],
      summary: buildWholeJobSummary(seat, input.seats.slice(1)),
      wholeJob: true,
      refusedBecause: null
    };
  }

  const parseResult =
    parseExplicitParts(trimmed) ??
    parseInlineLetterList(trimmed) ??
    parseOrdinals(trimmed) ??
    parseListLines(trimmed) ??
    parseConjunctionsAndSemicolons(trimmed) ??
    parseSequentialAndParallel(trimmed);

  if (!parseResult || parseResult.items.length < 2) {
    const seat = input.seats[0]!;
    return {
      parts: [{
        id: "part-1",
        title: deriveTitle(trimmed),
        prompt: trimmed,
        seatId: seat.id,
        seatLabel: seat.label,
        dependsOn: []
      }],
      summary: buildWholeJobSummary(seat, input.seats.slice(1)),
      wholeJob: true,
      refusedBecause: null
    };
  }

  const { items, wasCapped, totalItems } = parseResult;
  const numSeats = input.seats.length;
  const parts: CrewPart[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const seat = input.seats[i % numSeats]!;
    const depSet = new Set<string>();

    if (item.explicitDependsOn.length > 0) {
      for (const dep of item.explicitDependsOn) depSet.add(dep);
    } else if (item.isSequential && i > 0) {
      depSet.add(`part-${i}`);
    }

    // When a seat takes multiple parts, enforce strict execution order for that seat.
    if (i >= numSeats) {
      depSet.add(`part-${i - numSeats + 1}`);
    }

    parts.push({
      id: `part-${i + 1}`,
      title: deriveTitle(item.text),
      prompt: item.text,
      seatId: seat.id,
      seatLabel: seat.label,
      dependsOn: Array.from(depSet)
    });
  }

  return {
    parts,
    summary: buildCrewSummary(parts, input.seats, wasCapped, totalItems),
    wholeJob: false,
    refusedBecause: null
  };
}
