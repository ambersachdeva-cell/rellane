/**
 * Unified search palette spanning quick actions, work titles, and historical writing transcripts.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon, Modal } from "./ui.js";

export interface CommandHitLike {
  readonly id?: string;
  readonly caseId?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly at?: number;
  readonly updatedAt?: number;
}

export interface ContentHitLike {
  readonly turnId: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly who: string;
  readonly at: number;
  readonly score?: number;
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
}

export interface ContentOutcomeLike {
  readonly hits: readonly ContentHitLike[];
  readonly scanned?: number;
  readonly matched?: number;
  readonly summary?: string;
}

export interface QuickActionLike {
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  readonly keywords?: readonly string[];
  readonly disabledBecause: string | null;
}

export interface SearchPanelProps {
  readonly query: string;
  readonly onQuery: (next: string) => void;
  readonly commandHits: readonly CommandHitLike[];
  readonly contentOutcome: ContentOutcomeLike | null;
  readonly actions: readonly QuickActionLike[];
  readonly onRunAction: (id: string) => void;
  readonly onOpenWork: (caseId: string) => void;
  readonly onOpenTurn: (caseId: string, turnId: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

interface ActionEntry {
  readonly kind: "action";
  readonly action: QuickActionLike;
  readonly globalIndex: number;
}

interface WorkEntry {
  readonly kind: "work";
  readonly hit: CommandHitLike;
  readonly globalIndex: number;
}

interface ContentEntry {
  readonly kind: "content";
  readonly hit: ContentHitLike;
  readonly globalIndex: number;
}

type NavEntry = ActionEntry | WorkEntry | ContentEntry;

function renderHighlightedSnippet(
  snippet: string,
  highlights: readonly (readonly [number, number])[]
): ReactNode {
  if (highlights.length === 0) {
    return snippet;
  }

  const elements: ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < highlights.length; i++) {
    const range = highlights[i];
    if (range === undefined) continue;
    const start = range[0];
    const end = range[1];
    if (start === undefined || end === undefined) continue;

    // Clamping protects against out-of-bounds offsets when snippets are trimmed at word boundaries
    const safeStart = Math.max(cursor, Math.min(start, snippet.length));
    const safeEnd = Math.max(safeStart, Math.min(end, snippet.length));

    if (safeStart > cursor) {
      elements.push(snippet.slice(cursor, safeStart));
    }

    if (safeEnd > safeStart) {
      const matchText = snippet.slice(safeStart, safeEnd);
      elements.push(
        <mark
          key={`match-${i}-${safeStart}`}
          className="ws-search-highlight"
          aria-label={`${matchText} (matched)`}
        >
          {matchText}
        </mark>
      );
    }

    cursor = safeEnd;
  }

  if (cursor < snippet.length) {
    elements.push(snippet.slice(cursor));
  }

  return elements;
}

export function SearchPanel({
  query,
  onQuery,
  commandHits,
  contentOutcome,
  actions,
  onRunAction,
  onOpenWork,
  onOpenTurn,
  onClose,
  busy,
}: SearchPanelProps): ReactNode {
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const listboxId = useId();
  const actionsHeadingId = useId();
  const workHeadingId = useId();
  const contentHeadingId = useId();

  // Resetting selection on query updates ensures keyboard navigation starts from the top match
  useEffect(() => {
    setFocusedIndex(0);
  }, [query]);

  // When the query is empty, actionable rows are elevated so work can begin without typing
  const orderedActions = query.trim().length === 0
    ? [...actions].sort((a, b) => {
        const aDis = a.disabledBecause !== null ? 1 : 0;
        const bDis = b.disabledBecause !== null ? 1 : 0;
        return aDis - bDis;
      })
    : actions;

  let currentIndex = 0;

  const actionEntries: ActionEntry[] = [];
  for (let i = 0; i < orderedActions.length; i++) {
    const action = orderedActions[i];
    if (action !== undefined) {
      actionEntries.push({
        kind: "action",
        action,
        globalIndex: currentIndex++,
      });
    }
  }

  const workEntries: WorkEntry[] = [];
  for (let i = 0; i < commandHits.length; i++) {
    const hit = commandHits[i];
    if (hit !== undefined) {
      workEntries.push({
        kind: "work",
        hit,
        globalIndex: currentIndex++,
      });
    }
  }

  const contentHits = contentOutcome?.hits ?? [];
  const contentEntries: ContentEntry[] = [];
  for (let i = 0; i < contentHits.length; i++) {
    const hit = contentHits[i];
    if (hit !== undefined) {
      contentEntries.push({
        kind: "content",
        hit,
        globalIndex: currentIndex++,
      });
    }
  }

  const totalItems = currentIndex;
  const allEntries: readonly NavEntry[] = [
    ...actionEntries,
    ...workEntries,
    ...contentEntries,
  ];

  const safeIndex = totalItems > 0
    ? Math.min(Math.max(0, focusedIndex), totalItems - 1)
    : 0;

  // Active row remains in the visible scroll container during keyboard navigation
  useEffect(() => {
    if (totalItems > 0 && safeIndex >= 0 && safeIndex < totalItems) {
      const el = itemRefs.current[safeIndex];
      if (el !== undefined && el !== null) {
        el.scrollIntoView({ block: "nearest" });
      }
    }
  }, [safeIndex, totalItems]);

  const handleSelectEntry = (entry: NavEntry) => {
    if (entry.kind === "action") {
      if (entry.action.disabledBecause !== null) {
        return;
      }
      onRunAction(entry.action.id);
      onClose();
      return;
    }

    if (entry.kind === "work") {
      const caseId = entry.hit.caseId ?? entry.hit.id ?? "";
      if (caseId.length > 0) {
        onOpenWork(caseId);
        onClose();
      }
      return;
    }

    if (entry.kind === "content") {
      onOpenTurn(entry.hit.caseId, entry.hit.turnId);
      onClose();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (totalItems > 0) {
        setFocusedIndex(prev => Math.min(totalItems - 1, prev + 1));
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (totalItems > 0) {
        setFocusedIndex(prev => Math.max(0, prev - 1));
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const currentEntry = allEntries[safeIndex];
      if (currentEntry !== undefined) {
        handleSelectEntry(currentEntry);
      }
    }
  };

  const activeItemId = totalItems > 0 ? `search-item-${safeIndex}` : undefined;
  const isQueryEmpty = query.trim().length === 0;
  const hasNoResults = totalItems === 0 && !isQueryEmpty;

  return (
    <Modal title="Search" onClose={onClose} wide>
      <div className="ws-search-container">
        <div className="ws-search-input-wrapper">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            data-autofocus
            type="search"
            className="ws-search-input"
            value={query}
            onChange={e => onQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search actions, work, and writing…"
            aria-label="Search actions, work, and writing"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={totalItems > 0}
            aria-controls={listboxId}
            aria-busy={busy}
            {...(activeItemId !== undefined
              ? { "aria-activedescendant": activeItemId }
              : {})}
          />
          {busy ? (
            <span
              className="ws-search-busy"
              role="status"
              aria-label="Searching"
            >
              <Icon name="refresh" size={14} />
              <span className="ws-search-busy-label">Searching…</span>
            </span>
          ) : null}
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-label="Search results"
          className="ws-search-results"
        >
          {hasNoResults ? (
            <div className="ws-search-empty" role="status">
              <p className="ws-search-empty-text">
                No matches found. Try searching with fewer words.
              </p>
            </div>
          ) : null}

          {actionEntries.length > 0 ? (
            <section
              role="group"
              aria-labelledby={actionsHeadingId}
              className="ws-search-group"
            >
              <h3 id={actionsHeadingId} className="ws-search-group-heading">
                Actions
              </h3>
              <ul className="ws-search-list">
                {actionEntries.map(entry => {
                  const { action, globalIndex } = entry;
                  const isSelected = globalIndex === safeIndex;
                  const isDisabled = action.disabledBecause !== null;

                  return (
                    <li
                      key={`action-${action.id}`}
                      id={`search-item-${globalIndex}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={isDisabled}
                      className={`ws-search-item ws-search-item--action ${
                        isSelected ? "ws-search-item--selected" : ""
                      } ${isDisabled ? "ws-search-item--disabled" : ""}`}
                      onClick={() => handleSelectEntry(entry)}
                      onMouseEnter={() => setFocusedIndex(globalIndex)}
                      ref={el => {
                        itemRefs.current[globalIndex] = el;
                      }}
                    >
                      <div className="ws-search-item-main">
                        <span className="ws-search-item-title">
                          {action.title}
                        </span>
                        {action.hint ? (
                          <span className="ws-search-item-hint">
                            {action.hint}
                          </span>
                        ) : null}
                      </div>
                      {isDisabled ? (
                        <span
                          className="ws-search-item-reason"
                          aria-label={`Unavailable: ${action.disabledBecause}`}
                        >
                          {action.disabledBecause}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {workEntries.length > 0 ? (
            <section
              role="group"
              aria-labelledby={workHeadingId}
              className="ws-search-group"
            >
              <h3 id={workHeadingId} className="ws-search-group-heading">
                Work
              </h3>
              <ul className="ws-search-list">
                {workEntries.map(entry => {
                  const { hit, globalIndex } = entry;
                  const isSelected = globalIndex === safeIndex;
                  const workKey = hit.caseId ?? hit.id ?? `work-${globalIndex}`;

                  return (
                    <li
                      key={`work-${workKey}`}
                      id={`search-item-${globalIndex}`}
                      role="option"
                      aria-selected={isSelected}
                      className={`ws-search-item ws-search-item--work ${
                        isSelected ? "ws-search-item--selected" : ""
                      }`}
                      onClick={() => handleSelectEntry(entry)}
                      onMouseEnter={() => setFocusedIndex(globalIndex)}
                      ref={el => {
                        itemRefs.current[globalIndex] = el;
                      }}
                    >
                      <div className="ws-search-item-main">
                        <span className="ws-search-item-title">
                          {hit.title}
                        </span>
                        {hit.subtitle ? (
                          <span className="ws-search-item-hint">
                            {hit.subtitle}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {contentEntries.length > 0 ? (
            <section
              role="group"
              aria-labelledby={contentHeadingId}
              className="ws-search-group"
            >
              <h3 id={contentHeadingId} className="ws-search-group-heading">
                In your writing
              </h3>
              <ul className="ws-search-list">
                {contentEntries.map(entry => {
                  const { hit, globalIndex } = entry;
                  const isSelected = globalIndex === safeIndex;

                  return (
                    <li
                      key={`content-${hit.caseId}-${hit.turnId}-${globalIndex}`}
                      id={`search-item-${globalIndex}`}
                      role="option"
                      aria-selected={isSelected}
                      className={`ws-search-item ws-search-item--content ${
                        isSelected ? "ws-search-item--selected" : ""
                      }`}
                      onClick={() => handleSelectEntry(entry)}
                      onMouseEnter={() => setFocusedIndex(globalIndex)}
                      ref={el => {
                        itemRefs.current[globalIndex] = el;
                      }}
                    >
                      <div className="ws-search-item-meta">
                        <span className="ws-search-item-work">
                          {hit.caseTitle}
                        </span>
                        <span className="ws-search-item-who">
                          {hit.who}
                        </span>
                      </div>
                      <p className="ws-search-snippet">
                        {renderHighlightedSnippet(hit.snippet, hit.highlights)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>

        <footer className="ws-search-footer">
          <div
            className="ws-search-keyboard-model"
            aria-label="Keyboard controls"
          >
            <span className="ws-search-key-hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span className="ws-search-key-hint">
              <kbd>↵</kbd> run
            </span>
            <span className="ws-search-key-hint">
              <kbd>esc</kbd> close
            </span>
          </div>
          <div className="ws-visually-hidden">
            Arrows move, Enter runs, Escape closes.
          </div>
          {contentOutcome?.summary ? (
            <span className="ws-search-summary">{contentOutcome.summary}</span>
          ) : null}
        </footer>
      </div>
    </Modal>
  );
}
