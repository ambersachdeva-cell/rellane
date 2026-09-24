/**
 * FilesPanel renders the session workspace tree and displays either text
 * previews or line-by-line diffs for changes made during a session.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, IconButton, Modal } from "./ui.js";

export interface WorkspaceEntryLike {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "file" | "folder";
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly textual: boolean;
  readonly depth: number;
}

export interface WorkspaceListingLike {
  readonly entries: readonly WorkspaceEntryLike[];
  readonly truncated: boolean;
  readonly totalBytes: number;
}

export type PreviewLike =
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean; readonly bytes: number }
  | { readonly status: "unavailable"; readonly reason: string };

export type ChangeKindLike = "added" | "removed" | "modified" | "unchanged" | "binary" | "missing";

export interface HunkLike {
  readonly beforeStart: number;
  readonly beforeLines: readonly string[];
  readonly afterStart: number;
  readonly afterLines: readonly string[];
  readonly context: readonly string[];
}

export interface FileChangeLike {
  readonly relativePath: string;
  readonly kind: ChangeKindLike;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly HunkLike[];
  readonly truncated: boolean;
  readonly summary: string;
}

export interface FilesPanelProps {
  readonly listing: WorkspaceListingLike | null;
  readonly preview: PreviewLike | null;
  readonly change: FileChangeLike | null;
  readonly onSelect: (relativePath: string) => void;
  readonly onRefresh: () => void;
  readonly onReveal: (relativePath: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

interface DiffRenderLine {
  readonly kind: "added" | "removed" | "same";
  readonly text: string;
  readonly beforeLineNumber: number | null;
  readonly afterLineNumber: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Aligning hunks against context lines ensures added and removed lines retain their proper sequence for display.
function reconstructHunkLines(hunk: HunkLike): readonly DiffRenderLine[] {
  const result: DiffRenderLine[] = [];
  const beforeLines = hunk.beforeLines;
  const afterLines = hunk.afterLines;
  const context = hunk.context;

  let beforeIdx = 0;
  let afterIdx = 0;
  let beforeLineNum = hunk.beforeStart;
  let afterLineNum = hunk.afterStart;

  for (let c = 0; c < context.length; c++) {
    const ctx = context[c];
    if (ctx === undefined) {
      continue;
    }

    while (beforeIdx < beforeLines.length) {
      const bText = beforeLines[beforeIdx];
      if (bText === undefined || bText === ctx) {
        break;
      }
      result.push({
        kind: "removed",
        text: bText,
        beforeLineNumber: beforeLineNum,
        afterLineNumber: null,
      });
      beforeLineNum++;
      beforeIdx++;
    }

    while (afterIdx < afterLines.length) {
      const aText = afterLines[afterIdx];
      if (aText === undefined || aText === ctx) {
        break;
      }
      result.push({
        kind: "added",
        text: aText,
        beforeLineNumber: null,
        afterLineNumber: afterLineNum,
      });
      afterLineNum++;
      afterIdx++;
    }

    result.push({
      kind: "same",
      text: ctx,
      beforeLineNumber: beforeLineNum,
      afterLineNumber: afterLineNum,
    });
    beforeLineNum++;
    afterLineNum++;
    beforeIdx++;
    afterIdx++;
  }

  while (beforeIdx < beforeLines.length) {
    const bText = beforeLines[beforeIdx];
    if (bText !== undefined) {
      result.push({
        kind: "removed",
        text: bText,
        beforeLineNumber: beforeLineNum,
        afterLineNumber: null,
      });
      beforeLineNum++;
    }
    beforeIdx++;
  }

  while (afterIdx < afterLines.length) {
    const aText = afterLines[afterIdx];
    if (aText !== undefined) {
      result.push({
        kind: "added",
        text: aText,
        beforeLineNumber: null,
        afterLineNumber: afterLineNum,
      });
      afterLineNum++;
    }
    afterIdx++;
  }

  return result;
}

export function FilesPanel({
  listing,
  preview,
  change,
  onSelect,
  onRefresh,
  onReveal,
  onClose,
  busy,
}: FilesPanelProps): ReactNode {
  const [selectedPath, setSelectedPath] = useState<string | null>(change?.relativePath ?? null);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [announcement, setAnnouncement] = useState<string>("");
  const treeContainerRef = useRef<HTMLDivElement>(null);

  // Synchronise active selection if a new file change arrives from an ongoing session.
  useEffect(() => {
    if (change?.relativePath && selectedPath === null) {
      setSelectedPath(change.relativePath);
    }
  }, [change, selectedPath]);

  const activePath = selectedPath ?? change?.relativePath ?? null;
  const entries = listing?.entries ?? [];
  const selectedEntry = entries.find((e) => e.relativePath === activePath);

  const handleSelect = (relativePath: string) => {
    setSelectedPath(relativePath);
    onSelect(relativePath);
    setAnnouncement(`Selected ${relativePath}`);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) {
      return;
    }

    let nextIndex = focusedIndex;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      nextIndex = Math.min(entries.length - 1, focusedIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      nextIndex = Math.max(0, focusedIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      nextIndex = entries.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const current = entries[focusedIndex];
      if (current !== undefined) {
        handleSelect(current.relativePath);
      }
      return;
    } else {
      return;
    }

    setFocusedIndex(nextIndex);
    const target = entries[nextIndex];
    if (target !== undefined) {
      handleSelect(target.relativePath);
    }
  };

  const renderViewer = () => {
    if (activePath === null) {
      return (
        <div className="ws-files-empty" role="region" aria-label="File viewer">
          <p>Select a file from the list to view its contents or changes.</p>
        </div>
      );
    }

    if (selectedEntry?.kind === "folder") {
      return (
        <div className="ws-files-empty" role="region" aria-label="Folder viewer">
          <p>The selected path is a folder. Select a file to view its contents or changes.</p>
        </div>
      );
    }

    const hasMatchingChange = change !== null && change.relativePath === activePath;

    if (hasMatchingChange) {
      if (change.kind === "binary") {
        return (
          <div className="ws-files-empty" role="status">
            <p>This is a binary file and cannot be previewed as text.</p>
            <button
              type="button"
              className="ws-button ws-button--secondary"
              onClick={() => onReveal(activePath)}
              aria-label={`Reveal ${activePath} in Finder`}
            >
              Reveal in Finder
            </button>
          </div>
        );
      }

      if (change.kind === "missing") {
        return (
          <div className="ws-files-empty" role="status">
            <p>This file could not be found.</p>
          </div>
        );
      }

      if (change.kind === "unchanged") {
        return (
          <div className="ws-files-preview-wrapper" role="region" aria-label={`Changes for ${activePath}`}>
            <div className="ws-files-banner" role="status">
              <p>No changes in this file.</p>
            </div>
            {renderPreviewContent()}
          </div>
        );
      }

      return (
        <div className="ws-files-diff" role="region" aria-label={`Diff for ${activePath}`}>
          <div className="ws-files-summary" role="status">
            <p>{change.summary}</p>
          </div>
          {change.truncated ? (
            <div className="ws-files-banner" role="status">
              <p>This diff is truncated because the file is large. Showing the first 4,000 lines.</p>
            </div>
          ) : null}
          {change.hunks.length === 0 ? (
            <div className="ws-files-empty">
              <p>No changed lines to display.</p>
            </div>
          ) : (
            change.hunks.map((hunk, hunkIdx) => {
              const diffLines = reconstructHunkLines(hunk);
              return (
                <div key={`hunk-${hunkIdx}`} className="ws-files-diff-hunk">
                  <div
                    className="ws-files-diff-hunk-header"
                    aria-label={`Change hunk starting at line ${hunk.afterStart}`}
                  >
                    <span className="ws-files-diff-hunk-range">
                      @@ -{hunk.beforeStart},{hunk.beforeLines.length} +{hunk.afterStart},{hunk.afterLines.length} @@
                    </span>
                  </div>
                  <div className="ws-files-diff-hunk-lines" role="table" aria-label="Diff lines">
                    {diffLines.map((line, lineIdx) => {
                      const isAdded = line.kind === "added";
                      const isRemoved = line.kind === "removed";
                      const marker = isAdded ? "+" : isRemoved ? "−" : " ";
                      const accessiblePrefix = isAdded ? "Added: " : isRemoved ? "Removed: " : "Unchanged: ";
                      const lineClass = isAdded
                        ? "ws-files-diff-line ws-files-diff-line--added"
                        : isRemoved
                          ? "ws-files-diff-line ws-files-diff-line--removed"
                          : "ws-files-diff-line ws-files-diff-line--same";

                      return (
                        <div key={`line-${lineIdx}`} className={lineClass} role="row">
                          <span className="ws-files-diff-gutter" aria-hidden="true">
                            <span className="ws-files-diff-linenum">{line.beforeLineNumber ?? ""}</span>
                            <span className="ws-files-diff-linenum">{line.afterLineNumber ?? ""}</span>
                          </span>
                          <span className="ws-files-diff-marker" aria-hidden="true">
                            {marker}
                          </span>
                          <span className="ws-visually-hidden">{accessiblePrefix}</span>
                          <span className="ws-files-diff-text" role="cell">
                            {line.text.length === 0 ? "\u00A0" : line.text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      );
    }

    if (selectedEntry !== undefined && !selectedEntry.textual) {
      return (
        <div className="ws-files-empty" role="status">
          <p>This is a binary file and cannot be previewed as text.</p>
          <button
            type="button"
            className="ws-button ws-button--secondary"
            onClick={() => onReveal(activePath)}
            aria-label={`Reveal ${activePath} in Finder`}
          >
            Reveal in Finder
          </button>
        </div>
      );
    }

    return renderPreviewContent();
  };

  const renderPreviewContent = () => {
    if (activePath === null) {
      return null;
    }

    if (preview === null) {
      return (
        <div className="ws-files-empty" role="status">
          <p>{busy ? "Reading file preview…" : "No preview available for this file."}</p>
        </div>
      );
    }

    if (preview.status === "unavailable") {
      const isBinary = preview.reason.toLowerCase().includes("binary");
      return (
        <div className="ws-files-empty" role="status">
          <p>{preview.reason}</p>
          {isBinary ? (
            <button
              type="button"
              className="ws-button ws-button--secondary"
              onClick={() => onReveal(activePath)}
              aria-label={`Reveal ${activePath} in Finder`}
            >
              Reveal in Finder
            </button>
          ) : null}
        </div>
      );
    }

    const lines = preview.text.split("\n");
    return (
      <div className="ws-files-preview" role="region" aria-label={`File content for ${activePath}`}>
        {preview.truncated ? (
          <div className="ws-files-banner" role="status">
            <p>Showing the first 256 KB. This file is larger than the preview limit.</p>
          </div>
        ) : null}
        <pre className="ws-files-code">
          <code>
            {lines.map((line, idx) => (
              <div key={`preview-line-${idx}`} className="ws-files-preview-line">
                <span className="ws-files-preview-linenum" aria-hidden="true">
                  {idx + 1}
                </span>
                <span className="ws-files-preview-text">{line.length === 0 ? "\u00A0" : line}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    );
  };

  return (
    <Modal title="Session files" eyebrow="Session workspace" onClose={onClose} wide={true}>
      <div className="ws-files-container">
        <div className="ws-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {busy ? "Updating files…" : ""}
          {announcement}
        </div>

        <div className="ws-files-toolbar">
          <div className="ws-files-toolbar-meta">
            {listing !== null ? (
              <span className="ws-files-meta-text">
                {listing.entries.length} {listing.entries.length === 1 ? "item" : "items"} ({formatBytes(listing.totalBytes)})
              </span>
            ) : null}
            {busy ? (
              <span className="ws-files-status" role="status">
                Updating files…
              </span>
            ) : null}
          </div>
          <div className="ws-files-toolbar-actions">
            <IconButton
              icon="refresh"
              label="Refresh file listing"
              onClick={onRefresh}
              disabled={busy}
            />
          </div>
        </div>

        <div className="ws-files-layout">
          <nav
            ref={treeContainerRef}
            className="ws-files-sidebar"
            aria-label="Workspace file tree"
            tabIndex={0}
            onKeyDown={handleKeyDown}
          >
            {listing === null ? (
              <div className="ws-files-empty">
                <p>{busy ? "Reading workspace files…" : "Workspace listing is not available."}</p>
              </div>
            ) : listing.entries.length === 0 ? (
              <div className="ws-files-empty">
                <p>This folder is empty.</p>
              </div>
            ) : (
              <>
                {listing.truncated ? (
                  <div className="ws-files-banner" role="status">
                    <p>
                      Showing the first {listing.entries.length} items. Additional items were omitted to keep the workspace responsive.
                    </p>
                  </div>
                ) : null}
                <div className="ws-files-tree" role="tree" aria-label="Workspace files">
                  {entries.map((entry, index) => {
                    const isSelected = entry.relativePath === activePath;
                    const isFocused = index === focusedIndex;
                    const iconName = entry.kind === "folder" ? "folder" : "file";
                    const isChanged = change !== null && change.relativePath === entry.relativePath;

                    return (
                      <div
                        key={entry.relativePath}
                        role="treeitem"
                        aria-selected={isSelected}
                        tabIndex={isFocused ? 0 : -1}
                        className={`ws-files-tree-item ws-files-tree-item--${entry.kind} ${isSelected ? "ws-files-tree-item--selected" : ""}`}
                        style={{ paddingLeft: `${(entry.depth - 1) * 16 + 8}px` }}
                        onClick={() => {
                          setFocusedIndex(index);
                          handleSelect(entry.relativePath);
                        }}
                      >
                        <span className="ws-files-tree-icon" aria-hidden="true">
                          <Icon name={iconName} size={16} />
                        </span>
                        <span className="ws-files-tree-name">{entry.name}</span>
                        {entry.kind === "file" ? (
                          <span className="ws-files-tree-size" aria-hidden="true">
                            {formatBytes(entry.bytes)}
                          </span>
                        ) : null}
                        {isChanged ? (
                          <span className="ws-files-tree-badge" aria-label="Has uncommitted changes">
                            {change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "•"}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </nav>

          <main className="ws-files-main" aria-label="File content and diffs">
            {activePath !== null ? (
              <header className="ws-files-header">
                <div className="ws-files-header-info">
                  <h3 className="ws-files-title">{activePath}</h3>
                </div>
                <div className="ws-files-header-actions">
                  <button
                    type="button"
                    className="ws-button ws-button--secondary"
                    onClick={() => onReveal(activePath)}
                    aria-label={`Reveal ${activePath} in Finder`}
                  >
                    Reveal in Finder
                  </button>
                </div>
              </header>
            ) : null}
            <div className="ws-files-content">{renderViewer()}</div>
          </main>
        </div>
      </div>
    </Modal>
  );
}
