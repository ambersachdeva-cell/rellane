import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./ui.js";

export interface AgentEditorProps {
  readonly id: string;
  readonly origin: "bundled" | "mine";
  readonly markdown: string;
  readonly check: {
    readonly ok: boolean;
    readonly problems: readonly string[];
    readonly hints: readonly string[];
  };
  readonly saving: boolean;
  readonly savedAt: number | null;
  readonly now: number;
  readonly onChange: (markdown: string) => void;
  readonly onSave: () => void;
  readonly onRun: () => void;
  readonly onClose: () => void;
}

export interface OutlineHeading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

const CHARACTER_LIMIT = 20000;

export function extractHeadings(markdown: string): readonly OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = markdown.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // Code blocks can start or end with triple backticks or tildes
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    // Markdown ATX headings: 1 to 6 hash symbols followed by space
    const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (match && match[1] && match[2]) {
      const level = match[1].length;
      const text = match[2].replace(/\s+#+$/, "").trim();
      if (text.length > 0) {
        headings.push({
          level,
          text,
          line: i + 1,
        });
      }
    }
  }

  return headings;
}

export function formatSavedAt(savedAt: number | null, now: number): string | null {
  if (savedAt === null) {
    return null;
  }

  // Handle both epoch milliseconds and epoch seconds
  const isSeconds = now < 1e11;
  const nowMs = isSeconds ? now * 1000 : now;
  const savedAtMs = isSeconds ? savedAt * 1000 : savedAt;

  const diffMs = Math.max(0, nowMs - savedAtMs);
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 45) {
    return "saved just now";
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin === 1) {
    return "saved 1 minute ago";
  }
  if (diffMin < 60) {
    return `saved ${diffMin} minutes ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours === 1) {
    return "saved 1 hour ago";
  }
  if (diffHours < 24) {
    return `saved ${diffHours} hours ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return "saved 1 day ago";
  }
  return `saved ${diffDays} days ago`;
}

export function AgentEditor({
  id,
  origin,
  markdown,
  check,
  saving,
  savedAt,
  now,
  onChange,
  onSave,
  onRun,
  onClose,
}: AgentEditorProps): ReactNode {
  const lastSavedMarkdownRef = useRef(markdown);
  const lastSavedAtRef = useRef(savedAt);
  const lastIdRef = useRef(id);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Synchronise saved reference when savedAt updates or agent id changes
  if (id !== lastIdRef.current) {
    lastIdRef.current = id;
    lastSavedMarkdownRef.current = markdown;
    lastSavedAtRef.current = savedAt;
  } else if (savedAt !== null && savedAt !== lastSavedAtRef.current) {
    lastSavedAtRef.current = savedAt;
    lastSavedMarkdownRef.current = markdown;
  }

  useEffect(() => {
    setConfirmDiscard(false);
  }, [id]);

  const isDirty = origin === "mine" && markdown !== lastSavedMarkdownRef.current;
  const hasProblems = check.problems.length > 0 || !check.ok;

  const handleClose = () => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const handleConfirmDiscard = () => {
    setConfirmDiscard(false);
    onClose();
  };

  const handleCancelDiscard = () => {
    setConfirmDiscard(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (origin === "bundled") {
        return;
      }
      // Insert two spaces instead of losing focus to the next element
      event.preventDefault();
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const nextValue = markdown.slice(0, start) + "  " + markdown.slice(end);
      onChange(nextValue);

      queueMicrotask(() => {
        textarea.selectionStart = start + 2;
        textarea.selectionEnd = start + 2;
      });
    }
  };

  const headings = extractHeadings(markdown);
  const lineCount = markdown.length === 0 ? 0 : markdown.split("\n").length;
  const charCount = markdown.length;
  const savedLabel = formatSavedAt(savedAt, now);

  return (
    <section
      className="ws-agented-root"
      aria-label="Agent instruction editor"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (confirmDiscard) {
            e.stopPropagation();
            setConfirmDiscard(false);
          }
        }
      }}
    >
      <header className="ws-agented-header">
        <div className="ws-agented-header-main">
          <p className="ws-agented-eyebrow">
            {origin === "bundled" ? "Bundled agent" : "Custom agent"}
          </p>
          <h2 className="ws-agented-title">{id}</h2>
        </div>

        <div className="ws-agented-status">
          {saving ? (
            <span className="ws-agented-status-text">Saving…</span>
          ) : savedLabel !== null ? (
            <span className="ws-agented-status-text">{savedLabel}</span>
          ) : null}
        </div>

        <div className="ws-agented-actions">
          <button
            type="button"
            className="ws-agented-button ws-agented-button--secondary"
            onClick={onRun}
            disabled={hasProblems}
          >
            Try it
          </button>

          {origin === "bundled" ? (
            <button
              type="button"
              className="ws-agented-button ws-agented-button--primary"
              onClick={onSave}
              disabled={hasProblems || saving}
            >
              Start my own from this
            </button>
          ) : (
            <button
              type="button"
              className="ws-agented-button ws-agented-button--primary"
              onClick={onSave}
              disabled={hasProblems || saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          )}

          <button
            type="button"
            className="ws-agented-button ws-agented-button--ghost ws-agented-close"
            title="Close"
            aria-label="Close"
            onClick={handleClose}
          >
            <Icon name="close" />
            <span className="ws-agented-sr-only">Close</span>
          </button>
        </div>
      </header>

      {origin === "bundled" ? (
        <div className="ws-agented-bundled-banner" role="status">
          <Icon name="shield" size={16} />
          <span className="ws-agented-bundled-text">
            This is one of the agents that came with the app. Start your own from this to edit it.
          </span>
        </div>
      ) : null}

      <div className="ws-agented-body">
        <div className="ws-agented-pane ws-agented-pane--editor">
          <div className="ws-agented-pane-header">
            <h3 className="ws-agented-pane-title">Instructions</h3>
            <div className="ws-agented-meta">
              <span className="ws-agented-count">
                {lineCount} {lineCount === 1 ? "line" : "lines"}
              </span>
              <span className="ws-agented-divider" aria-hidden="true">
                ·
              </span>
              <span
                className={`ws-agented-count ${
                  charCount > CHARACTER_LIMIT ? "ws-agented-count--limit" : ""
                }`}
              >
                {charCount.toLocaleString("en-GB")} / {CHARACTER_LIMIT.toLocaleString("en-GB")}{" "}
                characters
              </span>
            </div>
          </div>

          <div className="ws-agented-textarea-wrapper">
            <textarea
              className="ws-agented-textarea"
              value={markdown}
              readOnly={origin === "bundled"}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Agent instructions"
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        </div>

        <aside className="ws-agented-pane ws-agented-pane--outline" aria-label="Instructions outline">
          <div className="ws-agented-pane-header">
            <h3 className="ws-agented-pane-title">Outline</h3>
            <span className="ws-agented-outline-count">
              {headings.length} {headings.length === 1 ? "section" : "sections"}
            </span>
          </div>

          {headings.length === 0 ? (
            <p className="ws-agented-outline-empty">
              No headings yet. Use # to create sections.
            </p>
          ) : (
            <nav className="ws-agented-outline-nav">
              <ol className="ws-agented-outline-list">
                {headings.map((heading, index) => (
                  <li
                    key={`${heading.line}-${index}`}
                    className={`ws-agented-outline-item ws-agented-outline-item--level-${heading.level}`}
                  >
                    <span className="ws-agented-outline-prefix" aria-hidden="true">
                      {"#".repeat(heading.level)}
                    </span>
                    <span className="ws-agented-outline-text">{heading.text}</span>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </aside>
      </div>

      <footer className="ws-agented-footer">
        {check.problems.length > 0 ? (
          <div className="ws-agented-problems" role="alert">
            <div className="ws-agented-problem-heading">
              <Icon name="shield" size={16} />
              <span>Problems to resolve before saving</span>
            </div>
            <ul className="ws-agented-problem-list">
              {check.problems.map((problem, i) => (
                <li key={i} className="ws-agented-problem-item">
                  {problem}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {check.hints.length > 0 ? (
          <div className="ws-agented-hints">
            <div className="ws-agented-hint-heading">
              <Icon name="spark" size={16} />
              <span>Suggestions</span>
            </div>
            <ul className="ws-agented-hint-list">
              {check.hints.map((hint, i) => (
                <li key={i} className="ws-agented-hint-item">
                  {hint}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </footer>

      {confirmDiscard ? (
        <div
          className="ws-agented-discard-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ws-agented-discard-title"
        >
          <div
            className="ws-agented-discard-backdrop"
            onClick={handleCancelDiscard}
          />
          <div className="ws-agented-discard-panel">
            <h4 id="ws-agented-discard-title" className="ws-agented-discard-title">
              Discard unsaved changes?
            </h4>
            <p className="ws-agented-discard-body">
              You have unsaved changes. Closing now will discard what you have written.
            </p>
            <div className="ws-agented-discard-actions">
              <button
                type="button"
                className="ws-agented-button ws-agented-button--secondary"
                onClick={handleCancelDiscard}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="ws-agented-button ws-agented-button--danger"
                onClick={handleConfirmDiscard}
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
