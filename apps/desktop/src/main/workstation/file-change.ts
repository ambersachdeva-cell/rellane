import { createHash } from "node:crypto";

export type ChangeKind = "added" | "removed" | "modified" | "unchanged" | "binary" | "missing";

export interface Hunk {
  readonly beforeStart: number;
  readonly beforeLines: readonly string[];
  readonly afterStart: number;
  readonly afterLines: readonly string[];
  readonly context: readonly string[];
}

export interface FileChange {
  readonly relativePath: string;
  readonly kind: ChangeKind;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly Hunk[];
  readonly truncated: boolean;
  /** One plain sentence: "12 lines added, 3 removed." */
  readonly summary: string;
}

export const MAX_DIFF_LINES = 4_000;
export const CONTEXT_LINES = 3;

type DiffKind = "same" | "added" | "removed";

interface InternalDiffLine {
  readonly kind: DiffKind;
  readonly text: string;
  readonly beforeLine: number | null;
  readonly afterLine: number | null;
}

function formatSummary(added: number, removed: number): string {
  if (added === 0 && removed === 0) {
    return "No changes.";
  }
  if (added > 0 && removed === 0) {
    return `${added} ${added === 1 ? "line" : "lines"} added.`;
  }
  if (added === 0 && removed > 0) {
    return `${removed} ${removed === 1 ? "line" : "lines"} removed.`;
  }
  return `${added} ${added === 1 ? "line" : "lines"} added, ${removed} removed.`;
}

export function snapshotKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function compareText(before: string, after: string, relativePath: string): FileChange {
  // Embedded NUL characters signify non-text data that would corrupt terminal and editor displays.
  if (before.includes("\0") || after.includes("\0")) {
    return {
      relativePath,
      kind: "binary",
      added: 0,
      removed: 0,
      hunks: [],
      truncated: false,
      summary: "Binary file.",
    };
  }

  if (before === after) {
    return {
      relativePath,
      kind: "unchanged",
      added: 0,
      removed: 0,
      hunks: [],
      truncated: false,
      summary: "No changes.",
    };
  }

  const allBeforeLines = before.length === 0 ? [] : before.split("\n");
  const allAfterLines = after.length === 0 ? [] : after.split("\n");

  const truncated = allBeforeLines.length > MAX_DIFF_LINES || allAfterLines.length > MAX_DIFF_LINES;

  // Capping diff inputs keeps memory bounded and guarantees sub-second responsiveness on large generated files.
  const beforeLines = truncated ? allBeforeLines.slice(0, MAX_DIFF_LINES) : allBeforeLines;
  const afterLines = truncated ? allAfterLines.slice(0, MAX_DIFF_LINES) : allAfterLines;

  let prefixCount = 0;
  while (
    prefixCount < beforeLines.length &&
    prefixCount < afterLines.length &&
    beforeLines[prefixCount] === afterLines[prefixCount]
  ) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < beforeLines.length - prefixCount &&
    suffixCount < afterLines.length - prefixCount &&
    beforeLines[beforeLines.length - 1 - suffixCount] === afterLines[afterLines.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const prefixDiffLines: InternalDiffLine[] = [];
  for (let k = 0; k < prefixCount; k++) {
    const text = beforeLines[k];
    if (text !== undefined) {
      prefixDiffLines.push({
        kind: "same",
        text,
        beforeLine: k + 1,
        afterLine: k + 1,
      });
    }
  }

  const midBefore = beforeLines.slice(prefixCount, beforeLines.length - suffixCount);
  const midAfter = afterLines.slice(prefixCount, afterLines.length - suffixCount);
  const midDiffLines: InternalDiffLine[] = [];

  const n = midBefore.length;
  const m = midAfter.length;

  if (n === 0) {
    for (let j = 0; j < m; j++) {
      const text = midAfter[j];
      if (text !== undefined) {
        midDiffLines.push({
          kind: "added",
          text,
          beforeLine: null,
          afterLine: prefixCount + j + 1,
        });
      }
    }
  } else if (m === 0) {
    for (let i = 0; i < n; i++) {
      const text = midBefore[i];
      if (text !== undefined) {
        midDiffLines.push({
          kind: "removed",
          text,
          beforeLine: prefixCount + i + 1,
          afterLine: null,
        });
      }
    }
  } else {
    const stride = m + 1;
    const dp = new Uint16Array((n + 1) * stride);

    for (let i = 1; i <= n; i++) {
      const rowPrev = (i - 1) * stride;
      const rowCurr = i * stride;
      const textA = midBefore[i - 1];
      if (textA === undefined) continue;

      for (let j = 1; j <= m; j++) {
        const textB = midAfter[j - 1];
        if (textA === textB) {
          dp[rowCurr + j] = (dp[rowPrev + j - 1] ?? 0) + 1;
        } else {
          const fromAbove = dp[rowPrev + j] ?? 0;
          const fromLeft = dp[rowCurr + j - 1] ?? 0;
          dp[rowCurr + j] = fromAbove >= fromLeft ? fromAbove : fromLeft;
        }
      }
    }

    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const textA = i > 0 ? midBefore[i - 1] : undefined;
      const textB = j > 0 ? midAfter[j - 1] : undefined;

      if (i > 0 && j > 0 && textA !== undefined && textA === textB) {
        midDiffLines.push({
          kind: "same",
          text: textA,
          beforeLine: prefixCount + i,
          afterLine: prefixCount + j,
        });
        i--;
        j--;
      } else if (
        j > 0 &&
        (i === 0 || (dp[i * stride + (j - 1)] ?? 0) >= (dp[(i - 1) * stride + j] ?? 0))
      ) {
        const text = midAfter[j - 1];
        if (text !== undefined) {
          midDiffLines.push({
            kind: "added",
            text,
            beforeLine: null,
            afterLine: prefixCount + j,
          });
        }
        j--;
      } else if (i > 0) {
        const text = midBefore[i - 1];
        if (text !== undefined) {
          midDiffLines.push({
            kind: "removed",
            text,
            beforeLine: prefixCount + i,
            afterLine: null,
          });
        }
        i--;
      }
    }

    midDiffLines.reverse();
  }

  const suffixDiffLines: InternalDiffLine[] = [];
  for (let s = 0; s < suffixCount; s++) {
    const bIndex = beforeLines.length - suffixCount + s;
    const aIndex = afterLines.length - suffixCount + s;
    const text = beforeLines[bIndex];
    if (text !== undefined) {
      suffixDiffLines.push({
        kind: "same",
        text,
        beforeLine: bIndex + 1,
        afterLine: aIndex + 1,
      });
    }
  }

  const allDiffLines: InternalDiffLine[] = [...prefixDiffLines, ...midDiffLines, ...suffixDiffLines];

  let added = 0;
  let removed = 0;
  for (const line of allDiffLines) {
    if (line.kind === "added") {
      added++;
    } else if (line.kind === "removed") {
      removed++;
    }
  }

  const changeIndices: number[] = [];
  for (let idx = 0; idx < allDiffLines.length; idx++) {
    const item = allDiffLines[idx];
    if (item !== undefined && item.kind !== "same") {
      changeIndices.push(idx);
    }
  }

  const hunks: Hunk[] = [];
  if (changeIndices.length > 0) {
    interface Span {
      start: number;
      end: number;
    }

    const spans: Span[] = [];
    for (const idx of changeIndices) {
      const rangeStart = Math.max(0, idx - CONTEXT_LINES);
      const rangeEnd = Math.min(allDiffLines.length - 1, idx + CONTEXT_LINES);

      const lastSpan = spans[spans.length - 1];
      if (lastSpan !== undefined && rangeStart <= lastSpan.end + 1) {
        lastSpan.end = Math.max(lastSpan.end, rangeEnd);
      } else {
        spans.push({ start: rangeStart, end: rangeEnd });
      }
    }

    for (const span of spans) {
      const slice = allDiffLines.slice(span.start, span.end + 1);
      const hunkBeforeLines: string[] = [];
      const hunkAfterLines: string[] = [];
      const hunkContext: string[] = [];
      let beforeStart: number | null = null;
      let afterStart: number | null = null;

      for (const line of slice) {
        if (line.kind !== "added") {
          hunkBeforeLines.push(line.text);
          if (beforeStart === null && line.beforeLine !== null) {
            beforeStart = line.beforeLine;
          }
        }
        if (line.kind !== "removed") {
          hunkAfterLines.push(line.text);
          if (afterStart === null && line.afterLine !== null) {
            afterStart = line.afterLine;
          }
        }
        if (line.kind === "same") {
          hunkContext.push(line.text);
        }
      }

      hunks.push({
        beforeStart: beforeStart ?? 0,
        beforeLines: hunkBeforeLines,
        afterStart: afterStart ?? 0,
        afterLines: hunkAfterLines,
        context: hunkContext,
      });
    }
  }

  let kind: ChangeKind = "modified";
  if (before.length === 0 && after.length > 0) {
    kind = "added";
  } else if (before.length > 0 && after.length === 0) {
    kind = "removed";
  }

  return {
    relativePath,
    kind,
    added,
    removed,
    hunks,
    truncated,
    summary: formatSummary(added, removed),
  };
}
