export type DiffKind = "same" | "added" | "removed";

export interface DiffLine {
  readonly kind: DiffKind;
  /** Exact text of the line, preserving leading and trailing whitespace. */
  readonly text: string;
  /** 1-based line number in the older text, or null when this line is new. */
  readonly beforeLine: number | null;
  /** 1-based line number in the newer text, or null when this line was removed. */
  readonly afterLine: number | null;
}

export interface VersionDiff {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  /** True when the two texts are identical, including whitespace. */
  readonly identical: boolean;
  /** True when the comparison was cut short by a size limit. */
  readonly truncated: boolean;
}

export const MAX_DIFF_LINES = 4_000;

export function diffVersions(before: string, after: string): VersionDiff {
  const identical = before === after;

  const allBeforeLines = before.length === 0 ? [] : before.split("\n");
  const allAfterLines = after.length === 0 ? [] : after.split("\n");

  const truncated = allBeforeLines.length > MAX_DIFF_LINES || allAfterLines.length > MAX_DIFF_LINES;

  // Capping lines prevents quadratic memory allocation and UI freezing on huge files.
  const beforeLines = truncated ? allBeforeLines.slice(0, MAX_DIFF_LINES) : allBeforeLines;
  const afterLines = truncated ? allAfterLines.slice(0, MAX_DIFF_LINES) : allAfterLines;

  if (beforeLines.length === 0 && afterLines.length === 0) {
    return {
      lines: [],
      added: 0,
      removed: 0,
      identical: true,
      truncated: false,
    };
  }

  // Trimming shared prefixes reduces the search space so typical mid-document edits run in linear time.
  let prefixCount = 0;
  while (
    prefixCount < beforeLines.length &&
    prefixCount < afterLines.length &&
    beforeLines[prefixCount] === afterLines[prefixCount]
  ) {
    prefixCount++;
  }

  // Trimming shared suffixes avoids running dynamic programming over unmodified trailing content.
  let suffixCount = 0;
  while (
    suffixCount < beforeLines.length - prefixCount &&
    suffixCount < afterLines.length - prefixCount &&
    beforeLines[beforeLines.length - 1 - suffixCount] === afterLines[afterLines.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  const prefixLines: DiffLine[] = [];
  for (let k = 0; k < prefixCount; k++) {
    const text = beforeLines[k];
    if (text !== undefined) {
      prefixLines.push({
        kind: "same",
        text,
        beforeLine: k + 1,
        afterLine: k + 1,
      });
    }
  }

  const midBefore = beforeLines.slice(prefixCount, beforeLines.length - suffixCount);
  const midAfter = afterLines.slice(prefixCount, afterLines.length - suffixCount);
  const midLines: DiffLine[] = [];

  const n = midBefore.length;
  const m = midAfter.length;

  if (n === 0) {
    for (let j = 0; j < m; j++) {
      const text = midAfter[j];
      if (text !== undefined) {
        midLines.push({
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
        midLines.push({
          kind: "removed",
          text,
          beforeLine: prefixCount + i + 1,
          afterLine: null,
        });
      }
    }
  } else {
    // Uint16Array limits heap allocation to at most 32 MB for the capped 4,000 line matrix.
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

    // Backtrack from bottom-right. Preferring additions on backward traversal ensures removals read first in forward order.
    let i = n;
    let j = m;

    while (i > 0 || j > 0) {
      const textA = i > 0 ? midBefore[i - 1] : undefined;
      const textB = j > 0 ? midAfter[j - 1] : undefined;

      if (i > 0 && j > 0 && textA !== undefined && textA === textB) {
        midLines.push({
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
          midLines.push({
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
          midLines.push({
            kind: "removed",
            text,
            beforeLine: prefixCount + i,
            afterLine: null,
          });
        }
        i--;
      }
    }

    midLines.reverse();
  }

  const suffixLines: DiffLine[] = [];
  for (let s = 0; s < suffixCount; s++) {
    const bIndex = beforeLines.length - suffixCount + s;
    const aIndex = afterLines.length - suffixCount + s;
    const text = beforeLines[bIndex];
    if (text !== undefined) {
      suffixLines.push({
        kind: "same",
        text,
        beforeLine: bIndex + 1,
        afterLine: aIndex + 1,
      });
    }
  }

  const lines: DiffLine[] = [...prefixLines, ...midLines, ...suffixLines];

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") {
      added++;
    } else if (line.kind === "removed") {
      removed++;
    }
  }

  return {
    lines,
    added,
    removed,
    identical,
    truncated,
  };
}
