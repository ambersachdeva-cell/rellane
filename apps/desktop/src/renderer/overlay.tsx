/**
 * The ⌥Space overlay.
 *
 * Its entire value is that it opens instantly and gets out of the way, so this
 * is a separate document from the workbench and loads none of its chunks.
 *
 * Interaction mechanics follow the research, including what it warned against:
 * no artificial typing delay, no theatrical status text, no bouncing springs,
 * no skeleton flash on results that are already in memory. Everything here is
 * either real signal or absent.
 */

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { route, type Action, type SkillSummary } from "./command-router";
import "./styles/overlay.css";

/** Placeholder catalogue until skills are loaded from disk. */
const SKILLS: readonly SkillSummary[] = [
  {
    id: "librarian",
    name: "Desktop Librarian",
    description: "Read every file and propose where it should go",
    triggers: ["organise", "organize", "tidy", "clean", "downloads", "desktop", "sort"]
  },
  {
    id: "paper",
    name: "Paper Trail",
    description: "Pull structured rows out of a PDF or photo",
    triggers: ["pdf", "invoice", "receipt", "bill", "extract", "scan"]
  },
  {
    id: "shortcut",
    name: "Shortcuts Builder",
    description: "Turn a sentence into a real macOS Shortcut",
    triggers: ["automate", "shortcut", "every", "when", "schedule"]
  },
  {
    id: "paste",
    name: "Paste As…",
    description: "Reshape the clipboard for wherever it is going",
    triggers: ["paste", "clipboard", "convert", "reshape"]
  }
];

function Overlay() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const actions = useMemo(
    // Null, always, and not a placeholder for something better.
    //
    // This window asked the main process for the docked engine on every open
    // and was refused on every open: `assertTrustedSender` accepts the
    // workbench window and nothing else, which is correct — a second window
    // that can read the subscription is a second window worth attacking. The
    // request only ever produced a logged rejection and a swallowed catch, so
    // the overlay showed "not connected" whether or not anything was, and the
    // one visible symptom was a scary error on every single launch.
    //
    // The fix is not to widen the guard for a drawer. It is for this window to
    // say what it actually knows, which is nothing about engines.
    () => route(query, { skills: SKILLS, engineLabel: null }),
    [query]
  );

  // Selection must never point past the list after the query narrows it.
  useEffect(() => {
    setSelected((current) => (current >= actions.length ? 0 : current));
  }, [actions.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const dismiss = useCallback(() => {
    window.cadraneOverlay?.hide();
  }, []);

  const run = useCallback(
    (action: Action) => {
      if (action.kind === "compute") {
        void navigator.clipboard.writeText(action.title).then(() => {
          setCopied(true);
          window.setTimeout(dismiss, 420);
        });
        return;
      }
      window.cadraneOverlay?.run({ kind: action.kind, id: action.id, query });
    },
    [dismiss, query]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Hierarchical dismissal: clear the query first, close only when empty.
      if (event.key === "Escape") {
        event.preventDefault();
        if (query.length > 0) {
          setQuery("");
        } else {
          dismiss();
        }
        return;
      }
      if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
        event.preventDefault();
        setSelected((current) => (current + 1) % Math.max(actions.length, 1));
        return;
      }
      if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
        event.preventDefault();
        setSelected((current) => (current - 1 + actions.length) % Math.max(actions.length, 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const action = actions[selected];
        if (action !== undefined) {
          run(action);
        }
      }
    },
    [actions, dismiss, query.length, run, selected]
  );

  return (
    <div className="ov">
      <div className="ov__bar">
        <span className="ov__glyph" aria-hidden="true">⌘</span>
        <input
          ref={inputRef}
          className="ov__input"
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder="Ask, or describe what you want done…"
          aria-label="Command"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      {actions.length === 0 ? null : (
        <ul className="ov__list" role="listbox" aria-label="Actions">
          {actions.map((action, index) => (
            <li
              key={action.id}
              role="option"
              aria-selected={index === selected}
              className={`ov__item${index === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(action)}
            >
              <span className={`ov__kind ov__kind--${action.kind}`} aria-hidden="true" />
              <span className="ov__text">
                <span className="ov__title">
                  {copied && action.kind === "compute" ? "Copied" : action.title}
                </span>
                <span className="ov__detail">{action.detail}</span>
              </span>
              {action.badge === undefined ? null : (
                <span className="ov__badge">{action.badge}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="ov__foot">
        <kbd>↑↓</kbd> move <kbd>⏎</kbd> run <kbd>esc</kbd> close
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Rellane overlay root is missing.");
}
createRoot(root).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
);
