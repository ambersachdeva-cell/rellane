/**
 * Putting a line on a quotation by hand.
 *
 * ## Why this is the most important form in the product
 *
 * Until it existed there was exactly one route to a quotation line: read the
 * enquiry with a local model, then accept a proposal. On a Mac with no model —
 * which is every Mac on its first day, and this one — the reader refuses with
 * *"add the lines yourself"*, and there was nowhere to add them. The whole loop
 * stopped at step three on the machine it shipped to.
 *
 * So this is the plain path and the reading is the shortcut, not the other way
 * round. Everything downstream — the total, the message, the handoff, the
 * outcome, the record of what this shop wins — hangs off a line existing.
 *
 * ## It proposes nothing, and it does remember
 *
 * Nothing fills the rate box on its own. What the form does do, once enough of
 * a description is typed, is show what this shop charged for work like it
 * before — with the quantity, the date and the customer beside each one.
 *
 * Those are not the same thing, and the difference is the whole product. A
 * proposal is a figure somebody else arrived at; this is the owner's own
 * handwriting, read back to them. "Rellane never invents a price" is about
 * invention, and a shop's record of what it charged is the opposite of
 * invented. The context travels with the figure because the same job at a
 * different quantity is a different price, and only the owner knows which one
 * applies today.
 */

import { useEffect, useRef, useState } from "react";
import type { PastLine } from "@cadrane/contracts";
import { parseCount } from "../../main/book/enquiry-lines.js";
import { parseRupees, rupees } from "../../main/book/money.js";
import { Button, Field } from "./ui.js";

/**
 * How long ago, in the roughest terms that are still true.
 *
 * The point of the date is whether the rate is stale, and "3 weeks ago" answers
 * that better than "23 August" — which the reader has to do arithmetic on
 * before it means anything.
 */
export function ago(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return "over a year ago";
}

export function AddLine({
  onAdd,
  onRecall,
  now
}: {
  readonly onAdd: (line: {
    description: string;
    quantity: number;
    unitPricePaise: number;
    unit: string | null;
  }) => Promise<void>;
  /** What this shop charged for work like this. Reads only, proposes nothing. */
  readonly onRecall: (like: string) => Promise<readonly PastLine[]>;
  readonly now: number;
}) {
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not `busy`: two Enter presses inside one React batch both read the
  // old state and both submit, which puts the line on the quotation twice.
  const inFlight = useRef(false);
  const [past, setPast] = useState<readonly PastLine[]>([]);
  // Monotonic: a slower lookup for a shorter prefix must never overwrite the
  // answer to what is in the box now.
  const lookup = useRef(0);

  // Asked after a pause, not on every keystroke: it is a read of the whole
  // quotation_item table and the owner is mid-word for most of them.
  useEffect(() => {
    const wanted = description.trim();
    if (wanted.length < 3) {
      setPast([]);
      return;
    }
    const mine = ++lookup.current;
    const timer = setTimeout(() => {
      void onRecall(wanted).then((lines) => {
        if (mine === lookup.current) {
          setPast(lines);
        }
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [description, onRecall]);

  async function add(): Promise<void> {
    if (inFlight.current) return;

    const said = description.trim();
    const count = parseCount(quantity);
    const paise = parseRupees(rate);

    if (said === "") {
      setProblem("Say what this line is for.");
      return;
    }
    if (count === null) {
      // Names the box the unit belongs in. Somebody in a hurry types "1 rim"
      // into the first field, and an error that only says no is one they read
      // twice before working out where the word was supposed to go.
      setProblem("Enter how many, as a whole number. Put “rim” or “pcs” in the Each box.");
      return;
    }
    // A negative rate is a credit note, which this is not. Zero is allowed: a
    // shop does throw something in, and saying so on the quotation is honest.
    if (paise === null || paise < 0) {
      setProblem("Enter a rate.");
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await onAdd({
        description: said,
        quantity: count,
        unitPricePaise: paise,
        unit: unit.trim() === "" ? null : unit.trim()
      });
      setDescription("");
      setQuantity("");
      setUnit("");
      setRate("");
    } catch (error) {
      // Kept, not cleared. What was typed is the only copy of it.
      setProblem(error instanceof Error ? error.message : "That line was not added.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="deal__add"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <Field label="What">
        <input
          type="text"
          value={description}
          placeholder="500 visiting cards, 300 gsm matte"
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field label="How many">
        <input
          type="text"
          inputMode="numeric"
          value={quantity}
          placeholder="500"
          onChange={(event) => setQuantity(event.target.value)}
        />
      </Field>
      {/* No hint. A `Field` with one is taller than a `Field` without, so in a
          row aligned at the baseline this label rode up above the other three.
          An empty box that submits fine already says the word. */}
      <Field label="Each">
        <input
          type="text"
          value={unit}
          placeholder="pcs"
          onChange={(event) => setUnit(event.target.value)}
        />
      </Field>
      <Field label="Rate">
        <input
          type="text"
          inputMode="decimal"
          value={rate}
          placeholder="₹ each"
          onChange={(event) => setRate(event.target.value)}
        />
      </Field>
      <Button type="submit" tone="primary" disabled={busy}>
        {busy ? "Adding…" : "Add line"}
      </Button>

      {problem === null ? null : (
        <p className="deal__add-problem" role="alert">
          {problem}
        </p>
      )}

      {past.length === 0 ? null : (
        <ul className="deal__past" aria-label="What you charged before">
          {past.map((line, index) => (
            <li key={index}>
              {/* Each figure with what makes it judgeable. Pressing one fills
                  the description, the unit and the rate — never the quantity,
                  which belongs to the job in front of the owner today. */}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setDescription(line.description);
                  setUnit(line.unit ?? "");
                  // The same string the button shows, which `parseRupees`
                  // reads back exactly: it strips ₹ and grouping commas, so
                  // what lands in the box is the figure in the form the owner
                  // recognises rather than a bare number they have to check.
                  setRate(rupees(line.unitPricePaise, { paise: true }));
                  setProblem(null);
                }}
              >
                {rupees(line.unitPricePaise, { paise: true })}
              </button>{" "}
              <span className="deal__past-why">
                for {line.quantity}
                {line.unit === null ? "" : ` ${line.unit}`} of “{line.description}”
                {line.partyName === null ? "" : `, ${line.partyName}`}, {ago(line.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
