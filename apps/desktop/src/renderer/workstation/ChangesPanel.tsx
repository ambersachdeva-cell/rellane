import { useMemo, useState } from "react";
import { Icon, Modal } from "./ui.js";

export interface FileChangeRow {
  readonly relativePath: string;
  readonly kind: "added" | "changed" | "removed";
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly canRestore: boolean;
  readonly whyNot: string | null;
}

export interface ChangesPanelProps {
  readonly changes: readonly FileChangeRow[];
  readonly folderKnown: boolean;
  readonly beforeKnown: boolean;
  readonly diff: { readonly relativePath: string; readonly before: string; readonly after: string } | null;
  readonly now: number;
  readonly busy: boolean;
  readonly restoring: string | null;
  readonly onOpenDiff: (relativePath: string) => void;
  readonly onRestore: (relativePath: string) => void;
  readonly onReveal: (relativePath: string) => void;
  readonly onClose: () => void;
}

interface DiffLine {
  readonly lineNumber: number;
  readonly text: string;
}

export interface SideBySideRow {
  readonly before: DiffLine | null;
  readonly after: DiffLine | null;
  readonly kind: "unchanged" | "changed" | "added" | "removed";
}

function splitLines(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return clean.split("\n");
}

function fallbackDiff(
  beforeLines: readonly string[],
  afterLines: readonly string[],
): readonly SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let prefix = 0;
  const maxPrefix = Math.min(beforeLines.length, afterLines.length);
  while (prefix < maxPrefix) {
    const b = beforeLines[prefix];
    const a = afterLines[prefix];
    if (b === undefined || a === undefined || b !== a) {
      break;
    }
    rows.push({
      before: { lineNumber: prefix + 1, text: b },
      after: { lineNumber: prefix + 1, text: a },
      kind: "unchanged",
    });
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = Math.min(beforeLines.length - prefix, afterLines.length - prefix);
  while (suffix < maxSuffix) {
    const b = beforeLines[beforeLines.length - 1 - suffix];
    const a = afterLines[afterLines.length - 1 - suffix];
    if (b === undefined || a === undefined || b !== a) {
      break;
    }
    suffix++;
  }

  const midBefore = beforeLines.slice(prefix, beforeLines.length - suffix);
  const midAfter = afterLines.slice(prefix, afterLines.length - suffix);
  const maxMid = Math.max(midBefore.length, midAfter.length);

  for (let k = 0; k < maxMid; k++) {
    const b = midBefore[k];
    const a = midAfter[k];
    if (b !== undefined && a !== undefined) {
      rows.push({
        before: { lineNumber: prefix + k + 1, text: b },
        after: { lineNumber: prefix + k + 1, text: a },
        kind: "changed",
      });
    } else if (b !== undefined) {
      rows.push({
        before: { lineNumber: prefix + k + 1, text: b },
        after: null,
        kind: "removed",
      });
    } else if (a !== undefined) {
      rows.push({
        before: null,
        after: { lineNumber: prefix + k + 1, text: a },
        kind: "added",
      });
    }
  }

  const beforeStart = beforeLines.length - suffix;
  const afterStart = afterLines.length - suffix;
  for (let s = 0; s < suffix; s++) {
    const b = beforeLines[beforeStart + s];
    const a = afterLines[afterStart + s];
    if (b !== undefined && a !== undefined) {
      rows.push({
        before: { lineNumber: beforeStart + s + 1, text: b },
        after: { lineNumber: afterStart + s + 1, text: a },
        kind: "unchanged",
      });
    }
  }

  return rows;
}

export function computeSideBySideDiff(beforeText: string, afterText: string): readonly SideBySideRow[] {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);

  if (beforeLines.length === 0 && afterLines.length === 0) {
    return [];
  }
  if (beforeLines.length === 0) {
    return afterLines.map((line, idx) => ({
      before: null,
      after: { lineNumber: idx + 1, text: line },
      kind: "added" as const,
    }));
  }
  if (afterLines.length === 0) {
    return beforeLines.map((line, idx) => ({
      before: { lineNumber: idx + 1, text: line },
      after: null,
      kind: "removed" as const,
    }));
  }

  // Prevent matrix memory exhaustion when comparing very large files
  const maxCells = 250_000;
  if (beforeLines.length * afterLines.length > maxCells) {
    return fallbackDiff(beforeLines, afterLines);
  }

  const n = beforeLines.length;
  const m = afterLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = 0; i < n; i++) {
    const bLine = beforeLines[i];
    const rowCurrent = dp[i + 1];
    const rowPrev = dp[i];
    if (bLine === undefined || rowCurrent === undefined || rowPrev === undefined) {
      continue;
    }
    for (let j = 0; j < m; j++) {
      const aLine = afterLines[j];
      const prevVal = rowPrev[j];
      const upVal = rowPrev[j + 1];
      const leftVal = rowCurrent[j];
      if (aLine === undefined || prevVal === undefined || upVal === undefined || leftVal === undefined) {
        continue;
      }
      if (bLine === aLine) {
        rowCurrent[j + 1] = prevVal + 1;
      } else {
        rowCurrent[j + 1] = upVal > leftVal ? upVal : leftVal;
      }
    }
  }

  type Op =
    | { readonly type: "keep"; readonly beforeIdx: number; readonly afterIdx: number }
    | { readonly type: "delete"; readonly beforeIdx: number }
    | { readonly type: "insert"; readonly afterIdx: number };

  const ops: Op[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const bLine = i > 0 ? beforeLines[i - 1] : undefined;
    const aLine = j > 0 ? afterLines[j - 1] : undefined;
    const curRow = dp[i];
    const prevRow = i > 0 ? dp[i - 1] : undefined;

    if (i > 0 && j > 0 && bLine !== undefined && aLine !== undefined && bLine === aLine) {
      ops.push({ type: "keep", beforeIdx: i - 1, afterIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && curRow !== undefined && prevRow !== undefined) {
      const left = curRow[j - 1] ?? 0;
      const up = prevRow[j] ?? 0;
      if (i === 0 || left >= up) {
        ops.push({ type: "insert", afterIdx: j - 1 });
        j--;
      } else {
        ops.push({ type: "delete", beforeIdx: i - 1 });
        i--;
      }
    } else if (j > 0) {
      ops.push({ type: "insert", afterIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: "delete", beforeIdx: i - 1 });
      i--;
    }
  }

  ops.reverse();

  const rows: SideBySideRow[] = [];
  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx];
    if (op === undefined) {
      idx++;
      continue;
    }
    if (op.type === "keep") {
      const bText = beforeLines[op.beforeIdx];
      const aText = afterLines[op.afterIdx];
      if (bText !== undefined && aText !== undefined) {
        rows.push({
          before: { lineNumber: op.beforeIdx + 1, text: bText },
          after: { lineNumber: op.afterIdx + 1, text: aText },
          kind: "unchanged",
        });
      }
      idx++;
    } else {
      const deletes: number[] = [];
      const inserts: number[] = [];
      while (idx < ops.length) {
        const cur = ops[idx];
        if (cur === undefined || cur.type === "keep") {
          break;
        }
        if (cur.type === "delete") {
          deletes.push(cur.beforeIdx);
        } else {
          inserts.push(cur.afterIdx);
        }
        idx++;
      }

      const maxLen = Math.max(deletes.length, inserts.length);
      for (let k = 0; k < maxLen; k++) {
        const bIdx = deletes[k];
        const aIdx = inserts[k];
        const bText = bIdx !== undefined ? beforeLines[bIdx] : undefined;
        const aText = aIdx !== undefined ? afterLines[aIdx] : undefined;

        if (bIdx !== undefined && bText !== undefined && aIdx !== undefined && aText !== undefined) {
          rows.push({
            before: { lineNumber: bIdx + 1, text: bText },
            after: { lineNumber: aIdx + 1, text: aText },
            kind: "changed",
          });
        } else if (bIdx !== undefined && bText !== undefined) {
          rows.push({
            before: { lineNumber: bIdx + 1, text: bText },
            after: null,
            kind: "removed",
          });
        } else if (aIdx !== undefined && aText !== undefined) {
          rows.push({
            before: null,
            after: { lineNumber: aIdx + 1, text: aText },
            kind: "added",
          });
        }
      }
    }
  }

  return rows;
}

function numberToWord(n: number): string {
  const words = [
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
  if (n >= 0 && n < words.length) {
    const word = words[n];
    if (word !== undefined) {
      return word;
    }
  }
  return String(n);
}

function capitalizeFirst(text: string): string {
  const first = text.charAt(0);
  if (!first) {
    return text;
  }
  return first.toUpperCase() + text.slice(1);
}

export function formatLeadCount(changes: readonly FileChangeRow[]): string {
  const addedCount = changes.filter((c) => c.kind === "added").length;
  const changedCount = changes.filter((c) => c.kind === "changed").length;
  const removedCount = changes.filter((c) => c.kind === "removed").length;

  const clauses: string[] = [];

  if (changedCount > 0) {
    const word = numberToWord(changedCount);
    const noun = changedCount === 1 ? "file" : "files";
    clauses.push(`${word} ${noun} changed`);
  }

  if (addedCount > 0) {
    const word = numberToWord(addedCount);
    if (clauses.length === 0) {
      const noun = addedCount === 1 ? "file" : "files";
      clauses.push(`${word} ${noun} added`);
    } else {
      clauses.push(`${word} added`);
    }
  }

  if (removedCount > 0) {
    const word = numberToWord(removedCount);
    if (clauses.length === 0) {
      const noun = removedCount === 1 ? "file" : "files";
      clauses.push(`${word} ${noun} removed`);
    } else {
      clauses.push(`${word} removed`);
    }
  }

  if (clauses.length === 0) {
    return "No files changed.";
  }

  const combined = clauses.join(", ");
  return `${capitalizeFirst(combined)}.`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChangesPanel({
  changes,
  folderKnown,
  beforeKnown,
  diff,
  now,
  busy,
  restoring,
  onOpenDiff,
  onRestore,
  onReveal,
  onClose,
}: ChangesPanelProps) {
  // Referencing 'now' prevents unused variable warnings without duplicating duration formatters.
  void now;

  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);

  const diffRows = useMemo(() => {
    if (!diff) {
      return [];
    }
    return computeSideBySideDiff(diff.before, diff.after);
  }, [diff]);

  const addedFiles = useMemo(
    () => changes.filter((change) => change.kind === "added"),
    [changes],
  );
  const changedFiles = useMemo(
    () => changes.filter((change) => change.kind === "changed"),
    [changes],
  );
  const removedFiles = useMemo(
    () => changes.filter((change) => change.kind === "removed"),
    [changes],
  );

  const groups = useMemo(
    () =>
      [
        { kind: "added" as const, title: "Added", items: addedFiles },
        { kind: "changed" as const, title: "Changed", items: changedFiles },
        { kind: "removed" as const, title: "Removed", items: removedFiles },
      ].filter((group) => group.items.length > 0),
    [addedFiles, changedFiles, removedFiles],
  );

  const leadSummary = useMemo(() => formatLeadCount(changes), [changes]);
  const activeChange = useMemo(
    () => (diff ? changes.find((c) => c.relativePath === diff.relativePath) ?? null : null),
    [diff, changes],
  );

  return (
    <Modal title="What changed on your Mac" eyebrow="This session" wide onClose={onClose}>
      <div className="ws-changes-container">
        {!folderKnown ? (
          <div className="ws-changes-notice ws-changes-notice--no-folder">
            <p className="ws-changes-notice-message">
              This piece of work has no folder, so nothing could have been changed.
            </p>
          </div>
        ) : !beforeKnown ? (
          <div className="ws-changes-notice ws-changes-notice--no-before">
            <p className="ws-changes-notice-message">
              This session ran before the app started keeping snapshots, so what changed cannot be shown.
            </p>
          </div>
        ) : changes.length === 0 ? (
          <div className="ws-changes-empty">
            <Icon name="check" size={24} />
            <p className="ws-changes-empty-title">
              Nothing was changed on your Mac during this session.
            </p>
            <p className="ws-changes-empty-description">
              Your files remain exactly as they were before this work began.
            </p>
          </div>
        ) : (
          <>
            <header className="ws-changes-header">
              <p className="ws-changes-summary">{leadSummary}</p>
              {restoring ? (
                <div className="ws-changes-restoring-banner" role="status">
                  <span>Restoring {restoring}...</span>
                </div>
              ) : null}
            </header>

            <div className="ws-changes-body">
              <div className="ws-changes-list-pane" role="region" aria-label="Changed files">
                {groups.map((group) => (
                  <section key={group.kind} className="ws-changes-group">
                    <div className="ws-changes-group-heading">
                      <span className={`ws-changes-group-badge ws-changes-group-badge--${group.kind}`}>
                        {group.title}
                      </span>
                      <span className="ws-changes-group-count">
                        {group.items.length}
                      </span>
                    </div>

                    <div className="ws-changes-list">
                      {group.items.map((row) => {
                        const isSelected = diff?.relativePath === row.relativePath;
                        const isConfirming = confirmingPath === row.relativePath;
                        const isRestoringThis = restoring === row.relativePath;

                        return (
                          <div
                            key={row.relativePath}
                            className={`ws-changes-row ${isSelected ? "ws-changes-row--selected" : ""}`}
                          >
                            <button
                              type="button"
                              className="ws-changes-row-select"
                              onClick={() => onOpenDiff(row.relativePath)}
                              title={`Inspect changes in ${row.relativePath}`}
                              {...(isSelected ? { "aria-current": "true" as const } : {})}
                            >
                              <span className="ws-changes-row-path">{row.relativePath}</span>
                              <span className="ws-changes-row-meta">{formatBytes(row.bytes)}</span>
                            </button>

                            <div className="ws-changes-row-actions">
                              <button
                                type="button"
                                className="ws-changes-action-reveal"
                                onClick={() => onReveal(row.relativePath)}
                                title={`Show ${row.relativePath} in Finder`}
                                aria-label={`Show ${row.relativePath} in Finder`}
                              >
                                <Icon name="folder" size={14} />
                              </button>

                              {isRestoringThis ? (
                                <span className="ws-changes-row-restoring" role="status">
                                  Restoring...
                                </span>
                              ) : !row.canRestore ? (
                                <span
                                  className="ws-changes-why-not"
                                  title={row.whyNot ?? "This file cannot be put back."}
                                >
                                  {row.whyNot ?? "Cannot be put back"}
                                </span>
                              ) : isConfirming ? (
                                <div
                                  className="ws-changes-confirm"
                                  role="group"
                                  aria-label={`Confirm put back ${row.relativePath}`}
                                >
                                  <span className="ws-changes-confirm-prompt">
                                    Put back {row.relativePath}?
                                  </span>
                                  <button
                                    type="button"
                                    className="ws-changes-confirm-button"
                                    onClick={() => {
                                      setConfirmingPath(null);
                                      onRestore(row.relativePath);
                                    }}
                                    disabled={busy}
                                  >
                                    Put it back
                                  </button>
                                  <button
                                    type="button"
                                    className="ws-changes-cancel-button"
                                    onClick={() => setConfirmingPath(null)}
                                    disabled={busy}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="ws-changes-restore-button"
                                  onClick={() => setConfirmingPath(row.relativePath)}
                                  disabled={busy}
                                >
                                  Put it back
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>

              <div className="ws-changes-diff-pane" role="region" aria-label="Comparison view">
                {diff ? (
                  <div className="ws-changes-diff">
                    <div className="ws-changes-diff-header">
                      <div className="ws-changes-diff-title">
                        <span className="ws-changes-diff-path">{diff.relativePath}</span>
                      </div>

                      <div className="ws-changes-diff-actions">
                        <button
                          type="button"
                          className="ws-changes-action-reveal"
                          onClick={() => onReveal(diff.relativePath)}
                          title={`Show ${diff.relativePath} in Finder`}
                          aria-label={`Show ${diff.relativePath} in Finder`}
                        >
                          <Icon name="folder" size={14} />
                        </button>

                        {activeChange?.canRestore ? (
                          restoring === diff.relativePath ? (
                            <span className="ws-changes-row-restoring" role="status">
                              Restoring...
                            </span>
                          ) : confirmingPath === diff.relativePath ? (
                            <div
                              className="ws-changes-confirm"
                              role="group"
                              aria-label={`Confirm put back ${diff.relativePath}`}
                            >
                              <span className="ws-changes-confirm-prompt">
                                Put back {diff.relativePath}?
                              </span>
                              <button
                                type="button"
                                className="ws-changes-confirm-button"
                                onClick={() => {
                                  setConfirmingPath(null);
                                  onRestore(diff.relativePath);
                                }}
                                disabled={busy}
                              >
                                Put it back
                              </button>
                              <button
                                type="button"
                                className="ws-changes-cancel-button"
                                onClick={() => setConfirmingPath(null)}
                                disabled={busy}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="ws-changes-restore-button"
                              onClick={() => setConfirmingPath(diff.relativePath)}
                              disabled={busy}
                            >
                              Put it back
                            </button>
                          )
                        ) : activeChange && !activeChange.canRestore ? (
                          <span
                            className="ws-changes-why-not"
                            title={activeChange.whyNot ?? "This file cannot be put back."}
                          >
                            {activeChange.whyNot ?? "Cannot be put back"}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="ws-changes-diff-columns">
                      <div className="ws-changes-diff-column-header ws-changes-diff-column-header--before">
                        Before
                      </div>
                      <div className="ws-changes-diff-column-header ws-changes-diff-column-header--after">
                        After
                      </div>
                    </div>

                    <div
                      className="ws-changes-diff-body"
                      role="table"
                      aria-label={`Comparison for ${diff.relativePath}`}
                    >
                      {diffRows.length === 0 ? (
                        <div className="ws-changes-diff-empty">
                          <p className="ws-changes-diff-empty-text">
                            This file is empty in both versions.
                          </p>
                        </div>
                      ) : (
                        diffRows.map((row, index) => (
                          <div
                            key={index}
                            className={`ws-changes-diff-row ws-changes-diff-row--${row.kind}`}
                          >
                            <div
                              className={`ws-changes-diff-cell ws-changes-diff-cell--before ws-changes-diff-cell--${row.kind}`}
                            >
                              <span className="ws-changes-diff-line-number">
                                {row.before ? row.before.lineNumber : ""}
                              </span>
                              <pre className="ws-changes-diff-text">
                                {row.before ? row.before.text : ""}
                              </pre>
                            </div>
                            <div
                              className={`ws-changes-diff-cell ws-changes-diff-cell--after ws-changes-diff-cell--${row.kind}`}
                            >
                              <span className="ws-changes-diff-line-number">
                                {row.after ? row.after.lineNumber : ""}
                              </span>
                              <pre className="ws-changes-diff-text">
                                {row.after ? row.after.text : ""}
                              </pre>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="ws-changes-diff-placeholder">
                    <Icon name="compare" size={24} />
                    <p className="ws-changes-diff-placeholder-text">
                      Select a file from the list to inspect its changes side by side.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
