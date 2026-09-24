import { compareText, type FileChange } from "./file-change.js";

export type WatchTarget =
  | { readonly kind: "page"; readonly url: string; readonly label: string }
  | { readonly kind: "folder"; readonly path: string; readonly label: string }
  | { readonly kind: "routine"; readonly routineId: string; readonly label: string };

export type Cadence = "hourly" | "daily" | "weekly";

export interface Watch {
  readonly id: string;
  readonly target: WatchTarget;
  readonly cadence: Cadence;
  readonly tellMeWhen: "anything-changes" | "numbers-change" | "something-new-appears";
  readonly quietHours: boolean;
  readonly lastCheckedAt: number | null;
  readonly lastChangedAt: number | null;
  readonly paused: boolean;
}

export interface ChangeVerdict {
  readonly changed: boolean;
  readonly worthTelling: boolean;
  readonly what: string;
  readonly detail: readonly string[];
}

export const CADENCE_INTERVAL_MS: Readonly<Record<Cadence, number>> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function isDue(watch: Watch, now: number): boolean {
  if (watch.paused) {
    return false;
  }
  if (watch.lastCheckedAt === null) {
    return true;
  }
  const elapsed = now - watch.lastCheckedAt;
  if (elapsed < 0) {
    return false;
  }
  const interval = CADENCE_INTERVAL_MS[watch.cadence];
  return elapsed >= interval;
}

function stripEphemeral(text: string): string {
  // Pages routinely inject volatile tokens, view counters, timestamps and banner copy that do not represent genuine business changes.
  return text
    .replace(/(?:we\s+use\s+cookies|this\s+(?:site|website)\s+uses\s+cookies|cookie\s+preferences|accept\s+(?:all\s+)?cookies|reject\s+(?:all\s+)?cookies|manage\s+cookies|cookie\s+policy)[^\n.]*[.\n]?/gi, " ")
    .replace(/(?:last\s+(?:updated|modified|checked|reviewed|refreshed|edited)|updated\s+at|modified\s+on)[:\s]+[^\n]+/gi, " ")
    .replace(/\b(?:session_?id|sessid|phpsessid|jsessionid|csrf_?token|nonce|auth_?token|sid)=[\w-]+/gi, " ")
    .replace(/[?&](?:v|_t|t|cb|cache|ver|version|ts|timestamp|hash|_)=[\w.-]+/gi, " ")
    .replace(/\b[\d,]+(?:\.\d+)?\s*(?:views?|reads?|comments?|likes?|visitors?|visits?|impressions?|hits?|shares?|followers?|subscribers?)\b/gi, " ")
    .replace(/\b(?:views?|visitors?|visits?|reads?|comments?|likes?)\s*[:=]\s*[\d,]+/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi, " ")
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{4})?\b/gi, " ")
    .replace(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?(?:\s+\d{4})?\b/gi, " ")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{4})?\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|AM|PM|UTC|GMT|BST))?\b/gi, " ")
    .replace(/\b\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s*ago\b/gi, " ")
    .replace(/\b(?:just now|today|yesterday|tomorrow)\b/gi, " ")
    .replace(/\b(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–—]\s*)?\d{4}\b/gi, " ");
}

function normalizeLines(text: string): readonly string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  }
  return result;
}

function areListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const itemA = a[i];
    const itemB = b[i];
    if (itemA !== itemB) {
      return false;
    }
  }
  return true;
}

function isPermutation(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return areListsEqual(sortedA, sortedB);
}

function extractDiffDetail(diff: FileChange): readonly string[] {
  const detail: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.beforeLines) {
      const stripped = stripEphemeral(line).trim();
      if (stripped.length > 0) {
        detail.push(`- ${stripped}`);
        if (detail.length >= 5) {
          return detail;
        }
      }
    }
    for (const line of hunk.afterLines) {
      const stripped = stripEphemeral(line).trim();
      if (stripped.length > 0) {
        detail.push(`+ ${stripped}`);
        if (detail.length >= 5) {
          return detail;
        }
      }
    }
  }
  return detail;
}

interface ExtractedNumber {
  readonly raw: string;
  readonly value: number;
  readonly context: string;
}

function extractNumbersFromText(text: string): readonly ExtractedNumber[] {
  const cleaned = stripEphemeral(text);
  const lines = cleaned.split("\n");
  const extracted: ExtractedNumber[] = [];

  const numberRegex = /(?:([£$€₹¥]|USD|GBP|EUR|INR)\s*)?(\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(paise|USD|GBP|EUR|INR|p\b))?/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const contextWords = trimmed
      .replace(numberRegex, " ")
      .replace(/[^\w\s]/g, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();

    let match: RegExpExecArray | null;
    numberRegex.lastIndex = 0;
    while ((match = numberRegex.exec(trimmed)) !== null) {
      const prefix = match[1] ?? "";
      const numStr = match[2];
      if (numStr === undefined) {
        continue;
      }
      const suffix = match[3] ?? "";
      const raw = `${prefix}${numStr}${suffix.length > 0 ? ` ${suffix}` : ""}`;
      const numericValue = parseFloat(numStr.replace(/,/g, ""));
      if (!Number.isNaN(numericValue)) {
        extracted.push({
          raw,
          value: numericValue,
          context: contextWords,
        });
      }
    }
  }

  return extracted;
}

interface NumericDifference {
  readonly oldRaw: string;
  readonly newRaw: string;
  readonly context: string;
}

function findNumericDifferences(
  beforeNums: readonly ExtractedNumber[],
  afterNums: readonly ExtractedNumber[],
): readonly NumericDifference[] {
  const differences: NumericDifference[] = [];

  // One number on each side is the document's whole answer, so pair them even
  // when the words around them were rewritten.
  if (beforeNums.length === 1 && afterNums.length === 1) {
    const only = beforeNums[0]!;
    const becameOnly = afterNums[0]!;
    if (only.raw !== becameOnly.raw || only.value !== becameOnly.value) {
      differences.push({
        oldRaw: only.raw,
        newRaw: becameOnly.raw,
        context: only.context.length > 0 ? only.context : becameOnly.context,
      });
    }
    return differences;
  }

  /**
   * Queued by context, not scanned for it. This walked the entire after list
   * once per before entry, which costs nothing across a few changed lines and
   * turns quadratic across a price list read end to end — which is precisely
   * the document this feature exists to watch.
   *
   * Built back to front so that popping hands back the earliest unmatched
   * number, the same one the scan used to settle on.
   */
  const unmatchedByContext = new Map<string, ExtractedNumber[]>();
  for (let j = afterNums.length - 1; j >= 0; j -= 1) {
    const a = afterNums[j]!;
    const queue = unmatchedByContext.get(a.context);
    if (queue === undefined) {
      unmatchedByContext.set(a.context, [a]);
    } else {
      queue.push(a);
    }
  }

  for (const b of beforeNums) {
    const queue = unmatchedByContext.get(b.context);
    if (queue === undefined) {
      continue;
    }
    const a = queue.pop();
    if (a === undefined) {
      continue;
    }
    if (b.raw !== a.raw || b.value !== a.value) {
      differences.push({
        oldRaw: b.raw,
        newRaw: a.raw,
        context: b.context.length > 0 ? b.context : a.context,
      });
    }
  }

  return differences;
}

function judgeAnythingChanges(
  watch: Watch,
  before: string,
  after: string,
): { readonly worthTelling: boolean; readonly what: string; readonly detail: readonly string[] } {
  const cleanBefore = stripEphemeral(before);
  const cleanAfter = stripEphemeral(after);

  const normBefore = normalizeLines(cleanBefore);
  const normAfter = normalizeLines(cleanAfter);

  if (areListsEqual(normBefore, normAfter)) {
    return {
      worthTelling: false,
      what: "Only routine dates, counters or session details changed.",
      detail: [],
    };
  }

  if (isPermutation(normBefore, normAfter)) {
    return {
      worthTelling: false,
      what: "List items were reordered with no content changes.",
      detail: [],
    };
  }

  const diff = compareText(before, after, watch.target.label);
  const detail = extractDiffDetail(diff);

  return {
    worthTelling: true,
    what: `Content changed on ${watch.target.label}.`,
    detail,
  };
}

function judgeNumbersChange(
  watch: Watch,
  before: string,
  after: string,
): { readonly worthTelling: boolean; readonly what: string; readonly detail: readonly string[] } {
  const diff = compareText(before, after, watch.target.label);

  // Scoping number extraction to hunks bounds CPU time and guarantees sub-second execution on multi-megabyte documents.
  const beforeHunkLines: string[] = [];
  const afterHunkLines: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.beforeLines) {
      beforeHunkLines.push(line);
    }
    for (const line of hunk.afterLines) {
      afterHunkLines.push(line);
    }
  }

  /**
   * Hunks are the fast path, and normally the complete one: every line that
   * differs is in one, so every number that could have changed is in one too.
   *
   * Unless the diff was truncated. compareText stops at the first
   * MAX_DIFF_LINES, and a long page puts the interesting line well past that,
   * leaving hunks that describe a prefix rather than a document. Answering "no
   * meaningful numbers changed" off a prefix is a watcher reporting that nothing
   * happened because it stopped reading — the one answer it must never give.
   * So read the whole thing instead. Pairing below is linear, which is what
   * makes that affordable.
   */
  const readWholeDocument = diff.truncated;

  const beforeNums = extractNumbersFromText(
    readWholeDocument ? before : beforeHunkLines.join("\n"),
  );
  const afterNums = extractNumbersFromText(
    readWholeDocument ? after : afterHunkLines.join("\n"),
  );
  const differences = findNumericDifferences(beforeNums, afterNums);

  if (differences.length === 0) {
    return {
      worthTelling: false,
      what: "No meaningful numbers changed.",
      detail: [],
    };
  }

  const firstDiff = differences[0]!;
  const isPriceContext =
    firstDiff.context.includes("price") ||
    firstDiff.context.includes("rate") ||
    firstDiff.context.includes("fee") ||
    firstDiff.context.includes("cost") ||
    firstDiff.oldRaw.includes("£") ||
    firstDiff.oldRaw.includes("$") ||
    firstDiff.oldRaw.includes("€") ||
    firstDiff.oldRaw.includes("₹") ||
    firstDiff.newRaw.includes("£") ||
    firstDiff.newRaw.includes("$") ||
    firstDiff.newRaw.includes("€") ||
    firstDiff.newRaw.includes("₹") ||
    firstDiff.context.length === 0;

  let what = "";
  if (isPriceContext) {
    if (differences.length === 1) {
      what = `Price changed from ${firstDiff.oldRaw} to ${firstDiff.newRaw} on ${watch.target.label}.`;
    } else {
      const extra = differences.length - 1;
      what = `Price changed from ${firstDiff.oldRaw} to ${firstDiff.newRaw} (and ${extra} other ${extra === 1 ? "number" : "numbers"}) on ${watch.target.label}.`;
    }
  } else {
    const shortContext = firstDiff.context.slice(0, 30);
    const capitalized = shortContext.charAt(0).toUpperCase() + shortContext.slice(1);
    if (differences.length === 1) {
      what = `${capitalized} changed from ${firstDiff.oldRaw} to ${firstDiff.newRaw} on ${watch.target.label}.`;
    } else {
      const extra = differences.length - 1;
      what = `${capitalized} changed from ${firstDiff.oldRaw} to ${firstDiff.newRaw} (and ${extra} other numbers) on ${watch.target.label}.`;
    }
  }

  const detail: string[] = [];
  for (const item of differences) {
    if (detail.length >= 5) {
      break;
    }
    const prefix = item.context.length > 0 ? `${item.context}: ` : "";
    detail.push(`${prefix}${item.oldRaw} to ${item.newRaw}`);
  }

  return {
    worthTelling: true,
    what,
    detail,
  };
}

function judgeSomethingNewAppears(
  watch: Watch,
  before: string,
  after: string,
): { readonly worthTelling: boolean; readonly what: string; readonly detail: readonly string[] } {
  const cleanBefore = stripEphemeral(before);
  const cleanAfter = stripEphemeral(after);

  const normBefore = normalizeLines(cleanBefore);
  const normAfter = normalizeLines(cleanAfter);

  const beforeSet = new Set(normBefore);
  const afterSet = new Set(normAfter);

  const added = normAfter.filter(line => !beforeSet.has(line));
  const removed = normBefore.filter(line => !afterSet.has(line));

  if (added.length === 0 && removed.length === 0) {
    return {
      worthTelling: false,
      what: "Routine updates detected, but nothing new appeared.",
      detail: [],
    };
  }

  const isFolder = watch.target.kind === "folder";
  const itemNoun = isFolder ? "file" : "item";
  const itemsNoun = isFolder ? "files" : "items";
  const prep = isFolder ? "in" : "on";

  let what = "";
  if (added.length > 0 && removed.length === 0) {
    const count = added.length === 1 ? `1 new ${itemNoun} appeared` : `${added.length} new ${itemsNoun} appeared`;
    what = `${count} ${prep} ${watch.target.label}.`;
  } else if (added.length === 0 && removed.length > 0) {
    const count = removed.length === 1 ? `1 ${itemNoun} was removed` : `${removed.length} ${itemsNoun} were removed`;
    what = `${count} from ${watch.target.label}.`;
  } else {
    const addedCount = added.length === 1 ? `1 new ${itemNoun} appeared` : `${added.length} new ${itemsNoun} appeared`;
    const removedCount = removed.length === 1 ? `1 was removed` : `${removed.length} were removed`;
    what = `${addedCount} and ${removedCount} ${prep} ${watch.target.label}.`;
  }

  const detail: string[] = [];
  for (const line of added) {
    if (detail.length >= 5) {
      break;
    }
    detail.push(`+ ${line}`);
  }
  for (const line of removed) {
    if (detail.length >= 5) {
      break;
    }
    detail.push(`- ${line}`);
  }

  return {
    worthTelling: true,
    what,
    detail,
  };
}

export function judgeChange(input: {
  readonly watch: Watch;
  readonly before: string;
  readonly after: string;
  readonly now: number;
}): ChangeVerdict {
  const { watch, before, after, now } = input;

  // First check saves a baseline and never alerts, because every line is technically new.
  if (before.length === 0) {
    if (after.length === 0) {
      return {
        changed: false,
        worthTelling: false,
        what: "Nothing has changed.",
        detail: [],
      };
    }
    return {
      changed: true,
      worthTelling: false,
      what: "First check completed; baseline recorded.",
      detail: [],
    };
  }

  if (before === after) {
    return {
      changed: false,
      worthTelling: false,
      what: "Nothing has changed.",
      detail: [],
    };
  }

  let verdict: {
    readonly worthTelling: boolean;
    readonly what: string;
    readonly detail: readonly string[];
  };

  switch (watch.tellMeWhen) {
    case "anything-changes":
      verdict = judgeAnythingChanges(watch, before, after);
      break;
    case "numbers-change":
      verdict = judgeNumbersChange(watch, before, after);
      break;
    case "something-new-appears":
      verdict = judgeSomethingNewAppears(watch, before, after);
      break;
  }

  /**
   * Quiet hours are not judged here, they are delivered later. This function
   * used to answer "not worth telling" for anything found between 22:00 and
   * 07:00, which is the one thing a pure judgement cannot do: it has no way to
   * come back in the morning, so the finding was not held, it was lost. The
   * runner holds it and flushes it after seven, saying when it was found.
   */

  return {
    changed: true,
    worthTelling: verdict.worthTelling,
    what: verdict.what,
    detail: verdict.detail,
  };
}
