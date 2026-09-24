/**
 * Who this enquiry is from, edited where the enquiry is.
 *
 * Intake leaves the name and the number optional on purpose: an enquiry almost
 * always arrives before anybody has asked for either, and a required field
 * there is how intake stops being used. The other half was missing. The number
 * is learned on the phone call *after* the message arrives, and there was
 * nowhere in the product to write it down — so the handoff that carries a
 * quotation back to a customer worked only on the enquiries least likely to
 * need it.
 *
 * ## It is a line of text until somebody asks otherwise
 *
 * The header of a room is not a form. Closed, this is the customer's name and
 * number as a sentence; open, it is two boxes. A deal is read far more often
 * than its contact is edited.
 */

import { useRef, useState } from "react";
import { Button, Field } from "./ui.js";

export function DealCustomer({
  name,
  phone,
  onSave
}: {
  readonly name: string | null;
  readonly phone: string | null;
  readonly onSave: (who: { name: string; phone: string | null }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(name ?? "");
  const [draftPhone, setDraftPhone] = useState(phone ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not `saving`: two Enter presses inside one React batch both read the
  // old state and both submit, which writes the customer twice.
  const inFlight = useRef(false);

  async function save(): Promise<void> {
    if (inFlight.current) return;
    const wanted = draftName.trim();
    if (wanted === "") {
      // The book refuses this too. Saying so here saves a round trip and keeps
      // what they typed in front of them.
      setProblem("Give this customer a name.");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setProblem(null);
    try {
      await onSave({ name: wanted, phone: draftPhone.trim() === "" ? null : draftPhone.trim() });
      setOpen(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That did not save.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="deal__who deal__who--edit"
        onClick={() => {
          // Seeded when it opens, not when it mounts: the deal may have been
          // given a customer by something else since this last rendered.
          setDraftName(name ?? "");
          setDraftPhone(phone ?? "");
          setProblem(null);
          setOpen(true);
        }}
      >
        {name ?? "Not in the book yet"}
        {phone === null ? null : <span className="deal__phone"> {phone}</span>}
      </button>
    );
  }

  return (
    <form
      className="deal__customer"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Who">
        <input
          type="text"
          value={draftName}
          autoComplete="off"
          placeholder="Verma Textiles"
          autoFocus
          onChange={(event) => setDraftName(event.target.value)}
        />
      </Field>
      <Field label="Their number">
        <input
          type="tel"
          value={draftPhone}
          autoComplete="off"
          placeholder="98765 43210"
          onChange={(event) => setDraftPhone(event.target.value)}
        />
      </Field>
      <Button type="submit" tone="primary" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
      <Button disabled={saving} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {problem === null ? null : (
        <p className="deal__customer-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
