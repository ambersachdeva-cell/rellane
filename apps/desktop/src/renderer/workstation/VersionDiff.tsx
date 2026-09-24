/** Visual alignment between two versions of an output document. */
import { useMemo } from "react";
import { diffVersions, MAX_DIFF_LINES } from "./version-diff.js";

export interface VersionDiffViewProps {
  readonly before: string;
  readonly after: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
}

function formatDiffCounts(added: number, removed: number, identical: boolean): string {
  if (identical || (added === 0 && removed === 0)) {
    return "No changes";
  }
  const addedPart = added === 1 ? "1 line added" : `${added} lines added`;
  const removedPart = removed === 1 ? "1 removed" : `${removed} removed`;
  if (added > 0 && removed > 0) {
    return `${addedPart}, ${removedPart}`;
  }
  if (added > 0) {
    return addedPart;
  }
  return removed === 1 ? "1 line removed" : `${removed} lines removed`;
}

export function VersionDiffView({
  before,
  after,
  beforeLabel,
  afterLabel,
}: VersionDiffViewProps) {
  const diff = useMemo(() => diffVersions(before, after), [before, after]);
  const countsSummary = formatDiffCounts(diff.added, diff.removed, diff.identical);

  return (
    <div className="ws-version-diff" role="region" aria-label="Version comparison">
      <div className="ws-version-history">
        <p className="ws-version-diff-summary">
          {beforeLabel} to {afterLabel}: {countsSummary}
        </p>
        {diff.truncated ? (
          <p className="ws-form-hint">
            Only the first {MAX_DIFF_LINES.toLocaleString()} lines were compared; the rest were not.
          </p>
        ) : null}
      </div>
      <div className="ws-editor-paper">
        <div className="ws-prose ws-diff-lines" role="region" aria-label="Diff lines">
          {diff.lines.map((line, index) => (
            <div
              key={`diff-line-${index}`}
              className={`ws-diff-line ws-diff-line--${line.kind}`}
            >
              {line.kind === "added" ? (
                <span className="ws-diff-marker" aria-label="Added" title="Added">
                  +{" "}
                </span>
              ) : line.kind === "removed" ? (
                <span className="ws-diff-marker" aria-label="Removed" title="Removed">
                  −{" "}
                </span>
              ) : (
                <span className="ws-diff-marker" aria-hidden="true">
                  {"  "}
                </span>
              )}
              <span className="ws-diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
