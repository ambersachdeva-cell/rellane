/**
 * What the enquiry appears to ask for, beside the words it was read from.
 *
 * Nothing here is applied. Each proposal shows its excerpt, because the excerpt
 * is the thing worth checking: the model can only quote, so the owner is
 * confirming that a real phrase was understood as the right field — not judging
 * how confident the machine sounds.
 *
 * ## Every field is editable, including the ones that were proposed
 *
 * The first version rendered the description as static text. A person could see
 * a misread and could not fix it: their only options were to accept the line as
 * written or throw the whole thing away and retype it. That is not review, it is
 * a choice between two bad outcomes, and it made the feature worse than typing.
 * A proposal seeds a field; it never owns one.
 *
 * ## The rate is never seeded
 *
 * Everything else arrives proposed; the price never does, because nothing
 * upstream of this screen is permitted to invent one. That asymmetry is the
 * point of the feature rather than a gap in it.
 */

import { useEffect, useState } from "react";
import { parseCount } from "../../main/book/enquiry-lines.js";
import { parseRupees } from "../../main/book/money.js";
import { Button, Field } from "./ui.js";
import "../styles/proposed-lines.css";

export interface ProposedLine {
  readonly description: { readonly value: string | null; readonly from: string | null; readonly problem?: string };
  readonly quantity: { readonly value: number | null; readonly from: string | null; readonly problem?: string };
}

interface Draft {
  readonly description: string;
  readonly quantity: string;
  readonly rate: string;
}

function seed(lines: readonly ProposedLine[]): Draft[] {
  return lines.map((line) => ({
    description: line.description.value ?? "",
    quantity: line.quantity.value === null ? "" : String(line.quantity.value),
    // Never seeded. See the note above.
    rate: ""
  }));
}

export function ProposedLines({
  lines,
  said,
  onAdd,
  onDismiss,
  onInstallModel
}: {
  readonly lines: readonly ProposedLine[];
  readonly said: string;
  /** Offered only when nothing was read, which is usually why. */
  readonly onInstallModel: () => void;
  readonly onAdd: (line: { description: string; quantity: number; unitPricePaise: number }) => Promise<void>;
  readonly onDismiss: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => seed(lines));
  const [added, setAdded] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // A second reading replaces the proposals, so what was typed against the old
  // ones must go with them. Without this, a rate entered for line 1 of the first
  // reading silently attaches to line 1 of the second.
  useEffect(() => {
    setDrafts(seed(lines));
    setAdded(new Set());
    setProblem(null);
  }, [lines]);

  function edit(index: number, part: Partial<Draft>): void {
    setDrafts((was) => was.map((draft, at) => (at === index ? { ...draft, ...part } : draft)));
  }

  async function add(index: number): Promise<void> {
    const draft = drafts[index];
    if (draft === undefined) {
      return;
    }
    const description = draft.description.trim();
    const quantity = parseCount(draft.quantity);
    const unitPricePaise = parseRupees(draft.rate);

    if (description === "") {
      setProblem("Give this line a description before adding it.");
      return;
    }
    if (quantity === null) {
      // Names the box the unit belongs in. Somebody in a hurry types "1 rim"
      // into the first field, and an error that only says no is one they read
      // twice before working out where the word was supposed to go.
      setProblem("Enter how many, as a whole number. Put “rim” or “pcs” in the Each box.");
      return;
    }
    // A negative rate is a credit note, which this is not. Zero is allowed: a
    // shop does throw something in, and saying so on the quotation is honest.
    if (unitPricePaise === null || unitPricePaise < 0) {
      setProblem("Enter a rate. Nothing proposes a price for you.");
      return;
    }

    setBusy(index);
    setProblem(null);
    try {
      await onAdd({ description, quantity, unitPricePaise });
      // Marked rather than removed: removing would shift every index beneath it
      // and move what the owner typed onto a different line.
      setAdded((was) => new Set(was).add(index));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That line was not added.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="proposed" aria-label="What the enquiry asks for">
      <header className="proposed__head">
        <h3>What this asks for</h3>
        <Button tone="ghost" onClick={onDismiss}>
          Hide
        </Button>
      </header>

      {lines.length === 0 ? null : (
        <ol className="proposed__list">
          {lines.map((line, index) => {
            const draft = drafts[index];
            const done = added.has(index);
            const name = draft?.description.trim() || `line ${index + 1}`;
            return (
              <li key={index} className={`proposed__line${done ? " proposed__line--added" : ""}`}>
                {/* The words it was read from, which is what the owner checks. */}
                {line.description.from === null ? null : (
                  <p className="proposed__from">read from “{line.description.from}”</p>
                )}

                <div className="proposed__fields">
                  <Field label="What">
                    <input
                      type="text"
                      value={draft?.description ?? ""}
                      disabled={done}
                      onChange={(event) => edit(index, { description: event.target.value })}
                    />
                  </Field>

                  <Field label="How many">
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={`How many — ${name}`}
                      value={draft?.quantity ?? ""}
                      disabled={done}
                      placeholder={line.quantity.from ?? "—"}
                      onChange={(event) => edit(index, { quantity: event.target.value })}
                    />
                  </Field>

                  <Field label="Rate">
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Rate — ${name}`}
                      value={draft?.rate ?? ""}
                      disabled={done}
                      placeholder="₹ per unit"
                      onChange={(event) => edit(index, { rate: event.target.value })}
                    />
                  </Field>

                  {done ? (
                    <span className="proposed__done">Added</span>
                  ) : (
                    <Button tone="primary" disabled={busy !== null} onClick={() => void add(index)}>
                      {busy === index ? "Adding…" : "Add line"}
                    </Button>
                  )}
                </div>

                {line.quantity.problem === undefined || done ? null : (
                  <p className="proposed__problem">{line.quantity.problem}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <p className="proposed__said">{said}</p>

      {/* Only when there is nothing to show. The commonest reason a reading
          produces no lines is that this Mac has no model on it yet, and the
          message says so — but a sentence that names a thing to do and gives
          no way to do it is half an answer. When lines *are* here, the owner is
          working; a link to a settings screen would be an interruption. */}
      {lines.length === 0 ? (
        <p>
          <button type="button" className="link" onClick={onInstallModel}>
            Models on this Mac
          </button>
        </p>
      ) : null}

      {problem === null ? null : (
        <p className="proposed__problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
