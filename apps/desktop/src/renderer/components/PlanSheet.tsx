/**
 * The plan sheet: what is about to happen, before it happens.
 *
 * This is the single most important screen in the product. Everything else —
 * the sandbox, the autonomy ceiling, the snapshots — is machinery that only
 * earns trust if the person can read the intention first and recognise it as
 * what they wanted.
 *
 * So: the headline is a sentence, not a count. Every step is shown, not a
 * sample. And what is being *left alone* is shown too, because a tidying tool
 * that quietly skips things is one you stop trusting the first time you notice.
 */

import { useEffect, useRef } from "react";
import type { SkillPreview, UndoOutlook } from "@cadrane/contracts";
import { plural, size } from "../../shared/copy.js";
import { Button } from "./ui";

/**
 * What the footer says about putting this folder back.
 *
 * Three outcomes, because there are three, and the sheet's whole job is to be
 * the screen that does not round them off to the pleasant one. `blocks` is not
 * a UI preference: when no pre-image can be taken the executor refuses the run
 * outright rather than proceeding without undo, so an enabled button here would
 * promise work that is already decided against.
 */
export function undoTerms(
  undo: UndoOutlook,
  minutes: number
): { readonly line: string; readonly blocks: boolean } {
  switch (undo.kind) {
    case "instant":
      return {
        line: `Rellane snapshots the folder first — ${size(
          undo.bytes
        )}, using no extra disk. You can put it back for ${plural(minutes, "minute")} after it runs.`,
        blocks: false
      };
    case "copied":
      // Named rather than smoothed over: this volume cannot clone, so the
      // snapshot is a real copy and the reader is about to wait for it.
      return {
        line: `This folder is not on a volume Rellane can snapshot instantly, so it copies all ${size(
          undo.bytes
        )} first. That takes a moment. You can put it back for ${plural(
          minutes,
          "minute"
        )} after it runs.`,
        blocks: false
      };
    case "unavailable":
      return { line: undo.reason, blocks: true };
  }
}

interface Props {
  preview: SkillPreview;
  folder: string;
  onApprove(): void;
  onCancel(): void;
}

export function PlanSheet({ preview, folder, onApprove, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const nothingToDo = preview.steps.length === 0;
  const terms = undoTerms(preview.undo, preview.undoWindowMinutes);

  // Focus lands on Cancel, not Approve. The safe choice should be the one a
  // stray Return key hits.
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

  return (
    <>
      <div className="scrim" onClick={onCancel} aria-hidden="true" />
      <section className="plan" role="dialog" aria-modal="true" aria-label="Review this plan">
        <header className="plan__head">
          <p className="plan__where">{folder}</p>
          <h2 className="plan__headline">{preview.headline}</h2>
          <p className="plan__promise">Nothing has been changed yet.</p>
        </header>

        <div className="plan__body">
          {nothingToDo ? null : (
            <section className="plan__group">
              <h3 className="plan__grouphead">Will move {plural(preview.steps.length, "file")}</h3>
              <ul className="plan__list">
                {preview.steps.map((step, index) => (
                  // Indexed rather than keyed by summary: two steps can produce
                  // the same sentence, and duplicate keys silently drop a row
                  // from a list whose whole job is to be complete.
                  <li key={`${preview.planId}-${index}`} className="plan__step">
                    <span className="plan__stepline">{step.summary}</span>
                    <span className="plan__stepwhy">{step.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {preview.untouched.length === 0 ? null : (
            <section className="plan__group">
              <h3 className="plan__grouphead">
                Leaving {plural(preview.untouched.length, "file")} alone
              </h3>
              <ul className="plan__list plan__list--quiet">
                {preview.untouched.map((item) => (
                  <li key={item.name} className="plan__step">
                    <span className="plan__stepline">{item.name}</span>
                    <span className="plan__stepwhy">{item.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="plan__foot">
          {/**
           * The real terms, at the moment consent is given.
           *
           * This line used to read "Everything here can be undone afterwards."
           * — unbounded, and promised before the snapshot that makes undo
           * possible had been taken. Someone could approve a run, come back
           * after lunch and find the button gone, which is the same broken
           * promise as offering an undo that fails, moved one screen earlier
           * where it is harder to notice.
           */}
          <span className={terms.blocks ? "plan__undo plan__undo--none" : "plan__undo"}>
            {terms.line}
          </span>
          <span className="plan__actions">
            <Button ref={cancelRef} onClick={onCancel}>
              {terms.blocks ? "Close" : "Cancel"}
            </Button>
            <Button
              tone="primary"
              onClick={onApprove}
              disabled={nothingToDo || terms.blocks}
            >
              {terms.blocks ? "Cannot be undone here" : nothingToDo ? "Nothing to do" : "Do it"}
            </Button>
          </span>
        </footer>
      </section>
    </>
  );
}
