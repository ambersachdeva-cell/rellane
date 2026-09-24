/**
 * Everything this product can do, one keystroke away.
 *
 * ## Why it is a dialog and not a drawer
 *
 * A drawer is a place you go; this is a thing you say. It opens over whatever
 * you were looking at, takes one instruction, and gets out of the way — so it
 * closes on Escape, on a click outside, and on running anything, and it puts
 * focus back where it found it. A palette that leaves you somewhere new after
 * you cancelled out of it is a palette people stop opening.
 *
 * ## The keyboard contract, in full
 *
 * ⌘K opens it from anywhere. ↑ and ↓ move, wrapping at both ends because a list
 * you cannot get out of the bottom of makes people reach for the mouse. ⏎ runs
 * the selection. Escape closes. Nothing else is bound, because a palette that
 * eats keys is worse than one that misses some.
 *
 * ## Unavailable commands are shown, not hidden
 *
 * A verb that cannot run right now appears with the reason it cannot. Hiding it
 * is how a product teaches somebody that a feature does not exist, when the
 * truth is that no engine is docked yet. Asking for what you cannot have is
 * answered here, never ignored — the same rule the brief editor already follows.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { groupRanked, rankCommands, type Command, type RankedCommand } from "../commands";

/**
 * The typed characters, lit inside the title they matched.
 *
 * Built as runs rather than one element per character: "Raise a bill" matched on
 * `rab` is three lit letters, which is three elements and not twelve. The
 * difference matters because this rebuilds on every keystroke, for every visible
 * row, and a palette that stutters while you type is the only defect a palette
 * cannot survive.
 */
function Marked({ title, marks }: { title: string; marks: readonly number[] }) {
  if (marks.length === 0) {
    return <>{title}</>;
  }

  const lit = new Set(marks);
  const runs: { readonly text: string; readonly on: boolean }[] = [];

  for (const [index, character] of [...title].entries()) {
    const on = lit.has(index);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.on === on) {
      runs[runs.length - 1] = { text: last.text + character, on };
    } else {
      runs.push({ text: character, on });
    }
  }

  return (
    <>
      {runs.map((run, index) =>
        run.on ? (
          <b className="cmd__hit" key={`${index}-${run.text}`}>
            {run.text}
          </b>
        ) : (
          <span key={`${index}-${run.text}`}>{run.text}</span>
        )
      )}
    </>
  );
}

export function CommandPalette({
  commands,
  onRun,
  onClose
}: {
  commands: readonly Command[];
  onRun(id: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => rankCommands(query, commands), [query, commands]);
  const sections = useMemo(() => groupRanked(ranked), [ranked]);

  // The flat order the cursor walks. It has to be derived from the *sections*
  // rather than from `ranked`, or the selection jumps around the screen as it
  // moves — the eye follows the rows, not the score.
  const walk = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  const selected: RankedCommand | undefined = walk[Math.min(cursor, walk.length - 1)];

  // A new query means a new best answer, and the cursor belongs on it. Leaving
  // it where it was is how people run the wrong command.
  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      // Restore before a command's next dialog captures its return target.
      // Navigating away may have removed the original field.
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  // Keep the selection on screen when it moves by keyboard. `block: "nearest"`
  // so an already-visible row does not scroll the list under the pointer.
  useEffect(() => {
    listRef.current?.querySelector("[data-on='true']")?.scrollIntoView({ block: "nearest" });
  }, [cursor, query]);

  const run = (command: Command) => {
    if (command.unavailable !== undefined) {
      return;
    }
    onRun(command.id);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((at) => (walk.length === 0 ? 0 : (at + 1) % walk.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((at) => (walk.length === 0 ? 0 : (at - 1 + walk.length) % walk.length));
      return;
    }
    if (event.key === "Enter" && selected !== undefined) {
      event.preventDefault();
      run(selected.command);
    }
  };

  let row = -1;

  return (
    <>
      <div className="scrim scrim--palette" onClick={onClose} aria-hidden="true" />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Commands" onKeyDown={onKeyDown}>
        <div className="palette__query">
          <span className="palette__prompt" aria-hidden="true">
            ⌘K
          </span>
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={selected === undefined ? undefined : `cmd-${selected.command.id}`}
            placeholder="What do you want to do?"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>

        <div className="palette__list" id="palette-list" role="listbox" ref={listRef}>
          {walk.length === 0 ? (
            <p className="palette__none">
              Nothing matches <b>{query.trim()}</b>
            </p>
          ) : (
            sections.map((section) => (
              <div className="palette__group" key={section.group}>
                <p className="palette__heading">{section.group}</p>
                {section.rows.map((entry) => {
                  row += 1;
                  const on = row === Math.min(cursor, walk.length - 1);
                  const blocked = entry.command.unavailable !== undefined;
                  return (
                    <div
                      key={entry.command.id}
                      id={`cmd-${entry.command.id}`}
                      role="option"
                      aria-selected={on}
                      aria-disabled={blocked}
                      data-on={on ? "true" : "false"}
                      className={`cmd${on ? " cmd--on" : ""}${blocked ? " cmd--blocked" : ""}`}
                      onMouseMove={() => setCursor(walk.indexOf(entry))}
                      onClick={() => run(entry.command)}
                    >
                      <span className="cmd__title">
                        <Marked title={entry.command.title} marks={entry.marks} />
                      </span>
                      <span className="cmd__hint">
                        {entry.command.unavailable ?? entry.command.hint ?? ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette__foot">
          <span className="palette__key">↑↓</span> move
          <span className="palette__key">⏎</span> run
          <span className="palette__key">esc</span> close
        </div>
      </div>
    </>
  );
}
