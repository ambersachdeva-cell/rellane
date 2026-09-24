/**
 * Putting a folder back, before it is put back.
 *
 * Restore used to be undo on a card describing a run you had just watched
 * happen. Moving it onto the timeline made it a one-click reversal of work from
 * any session the record remembers — and a reversal *is* a change to someone's
 * files, so it earns the same sheet as the run that made them.
 *
 * It wears the plan sheet's own classes rather than a set of its own. This is
 * the same kind of object: a document you are asked to read before something
 * moves, not a dialog you are asked to dismiss.
 *
 * What it deliberately does not do is show a diff. Rellane holds a pre-image of
 * the folder, not a comparison against it, so listing "what comes back and what
 * gets overwritten" would mean inventing detail it has not measured. It states
 * the rule instead, plainly, and W1.5 is where the real diff belongs.
 */

import { useEffect, useRef } from "react";
import type { RestoreSubject } from "@cadrane/contracts";
import { Button } from "./ui";

interface Props {
  entry: RestoreSubject;
  onConfirm(): void;
  onCancel(): void;
}

export function RestoreSheet({ entry, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus lands on Cancel. The reader should have to reach for the option that
  // changes files.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const folder = entry.where ?? "that folder";

  return (
    <>
      <div className="scrim" onClick={onCancel} aria-hidden="true" />
      <section className="plan" role="dialog" aria-modal="true" aria-label="Put this back">
        <header className="plan__head">
          <p className="plan__where">{folder}</p>
          <h2 className="plan__headline">Put {folder} back?</h2>
          <p className="plan__promise">Nothing has been changed yet.</p>
        </header>

        <div className="plan__body">
          <section className="plan__group">
            <h3 className="plan__grouphead">What this reverses</h3>
            <ul className="plan__list">
              <li className="plan__step">
                <span className="plan__stepline">{entry.summary}</span>
                <span className="plan__stepwhy">
                  {entry.at === null ? "Completed in this session." : `Completed at ${absolute(entry.at)}.`}
                </span>
              </li>
            </ul>
          </section>

          <section className="plan__group">
            <h3 className="plan__grouphead">What that means</h3>
            <ul className="plan__list plan__list--quiet">
              <li className="plan__step">
                <span className="plan__stepline">
                  {folder} returns to how it was before that run.
                </span>
                <span className="plan__stepwhy">
                  Rellane copied the folder before it ran, and puts that copy back.
                </span>
              </li>
              <li className="plan__step">
                <span className="plan__stepline">
                  Anything changed in {folder} since then is replaced.
                </span>
                <span className="plan__stepwhy">
                  Rellane holds a copy of the folder, not a comparison against it, so it
                  cannot list what those changes are. If you have worked in {folder} since,
                  look before you decide.
                </span>
              </li>
            </ul>
          </section>
        </div>

        <footer className="plan__foot">
          <span className="plan__undo">Rellane will try to record the restoration. If history cannot be saved, the result will say so.</span>
          <span className="plan__actions">
            <Button ref={cancelRef} onClick={onCancel}>
              Cancel
            </Button>
            <Button tone="danger" onClick={onConfirm}>
              Put it back
            </Button>
          </span>
        </footer>
      </section>
    </>
  );
}

/**
 * A date and a time, not "3 hours ago".
 *
 * The reader is deciding whether to discard work, and the question underneath
 * that is whether they touched the folder after the run. Relative time makes
 * them do arithmetic at exactly the wrong moment.
 */
function absolute(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "an unknown time";
  }
  return at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}
