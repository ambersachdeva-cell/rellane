/**
 * How the shop signs a quotation.
 *
 * It was in the settings file from the beginning and no screen ever set it, so
 * every quotation this product composed went out unsigned — on the one piece of
 * text that leaves the shop and arrives in somebody else's hands, beside prices
 * the customer is comparing against two other shops' replies.
 *
 * ## Saved on a button, not on every keystroke
 *
 * The same reason the Telegram token is: a name typed character by character
 * would write a dozen half-names, and the last one is the one that would end up
 * on a customer's phone if the owner walked away mid-word.
 *
 * ## Blank is allowed and means blank
 *
 * `quotationMessage` omits the sign-off entirely when there is no name, rather
 * than inventing one or leaving a dangling line. A shop that would rather not
 * sign is making a choice, not leaving a field empty by mistake.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Field } from "./ui.js";

export function ShopName({
  name,
  onSave
}: {
  readonly name: string;
  readonly onSave: (name: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // See AddLine: two Enter presses in one batch both read the old `saving`.
  const inFlight = useRef(false);

  // Follows the stored value when it changes underneath — the settings screen
  // re-reads after other writes, and a box showing an older name than the one
  // on the quotations is worse than no box.
  useEffect(() => {
    setDraft(name);
  }, [name]);

  const changed = draft.trim() !== name.trim();

  async function save(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setProblem(null);
    try {
      await onSave(draft.trim());
      setSaid("Saved. New quotations are signed with it.");
    } catch (error) {
      // Without this the write failed silently: no message, no retry, and the
      // box still showing a name that is not the one on the quotations.
      setSaid(null);
      setProblem(error instanceof Error ? error.message : "That did not save.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    // A form, so Enter saves. It was a bare input with a button beside it, which
    // is a field nobody typing can leave without reaching for the mouse.
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="field__hint">
        Put at the end of every quotation you send, so the customer knows who it is from.
        Leave it blank and quotations go out unsigned.
      </p>
      <Field label="Shop name">
        <input
          type="text"
          value={draft}
          autoComplete="off"
          placeholder="Sachdeva Printers"
          onChange={(event) => {
            setDraft(event.target.value);
            setSaid(null);
            setProblem(null);
          }}
        />
      </Field>
      <div className="row">
        <Button type="submit" tone="primary" disabled={saving || !changed}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {said === null ? null : (
          <span className="field__hint" role="status">
            {said}
          </span>
        )}
        {problem === null ? null : (
          <span className="field__hint" role="alert">
            {problem}
          </span>
        )}
      </div>
    </form>
  );
}
