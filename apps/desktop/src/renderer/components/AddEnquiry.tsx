/**
 * Getting an enquiry into the book by hand.
 *
 * Until a channel is connected this is the only way one exists, and without one
 * the whole product is theoretical: Today has nothing to show and the deal room
 * has nothing to open. So it is on the front door rather than behind a menu.
 *
 * It stays useful after the channels are connected. A customer who telephones,
 * or walks in, or writes on a platform Rellane will never read, is still an
 * enquiry — and a product that can only see the channels it automates teaches
 * its owner to keep a second list somewhere else.
 *
 * Closed by default. Today's job is to say what needs answering, and a form
 * sitting open above that list competes with it every morning for the sake of
 * something done a few times a day.
 */

import { useEffect, useRef, useState } from "react";
import type { Deal } from "@cadrane/contracts";
import { Button, Field } from "./ui.js";
import "../styles/add-enquiry.css";

/**
 * A filled-in enquiry handed to the form from outside.
 *
 * Only the first run uses it, to put a real-looking enquiry in the box instead
 * of an empty one. It fills the fields and stops there — the owner still reads
 * it, still edits it, still presses the button. Writing a demonstration record
 * into a business's book without being asked is the kind of thing that makes
 * everything else the product says about not inventing figures worth nothing.
 */
export interface EnquirySeed {
  readonly channel: Deal["channel"];
  readonly partyName: string;
  readonly partyPhone: string;
  readonly rawText: string;
}

/** In the order an owner actually receives them. */
const CHANNELS: readonly { readonly id: Deal["channel"]; readonly label: string }[] = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "indiamart", label: "IndiaMART" },
  { id: "phone", label: "Phone" },
  { id: "walk_in", label: "Came in" },
  { id: "email", label: "Email" },
  { id: "telegram", label: "Telegram" }
];

export function AddEnquiry({
  onAdd,
  seed = null,
  onSeedUsed,
  startOpen = false
}: {
  readonly onAdd: (input: {
    channel: Deal["channel"];
    rawText: string;
    partyName: string | null;
    partyPhone: string | null;
  }) => Promise<void>;
  /** Fills the form once, when it arrives. Null the rest of the time. */
  readonly seed?: EnquirySeed | null;
  /** Told the moment a seed has been taken, so the same one cannot land twice. */
  readonly onSeedUsed?: () => void;
  /** Opens the form without a click. The first run does; nothing else should. */
  readonly startOpen?: boolean;
}) {
  // Seeded from `startOpen` rather than opened by the effect below, which runs
  // after the first paint: a first run would otherwise show the collapsed button
  // for one frame and then replace it with the form.
  const [open, setOpen] = useState(startOpen);
  const [channel, setChannel] = useState<Deal["channel"]>("whatsapp");
  const [rawText, setRawText] = useState("");
  const [partyName, setPartyName] = useState("");
  const [partyPhone, setPartyPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, not the `saving` state: two Enter presses inside one React batch both
  // read the old state and both submit, which files the same enquiry twice. A
  // ref changes on the first line of the first call.
  const inFlight = useRef(false);
  /** What the example put there, so a typed-over box stops calling itself one. */
  const seedText = useRef<string>("");

  const ready = rawText.trim() !== "" && !saving;
  /** True while the box holds words nobody in this shop actually received. */
  const [showing, setShowing] = useState(false);

  // Opened for somebody who has never used this, and only ever opened: a form
  // that closes itself when the condition that opened it goes away would shut
  // mid-sentence the moment the first enquiry lands.
  useEffect(() => {
    if (startOpen) {
      setOpen(true);
    }
  }, [startOpen]);

  useEffect(() => {
    if (seed === null) {
      return;
    }
    setOpen(true);
    setChannel(seed.channel);
    setPartyName(seed.partyName);
    setPartyPhone(seed.partyPhone);
    setRawText(seed.rawText);
    seedText.current = seed.rawText;
    setShowing(true);
    setProblem(null);
    onSeedUsed?.();
  }, [seed, onSeedUsed]);

  async function save(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setProblem(null);
    try {
      await onAdd({
        channel,
        rawText,
        // Trimmed, not merely tested. The name is trimmed again by
        // `findOrAddParty`; the phone was not, so a pasted number arrived in
        // the book carrying the space the paste brought with it.
        partyName: partyName.trim() === "" ? null : partyName.trim(),
        partyPhone: partyPhone.trim() === "" ? null : partyPhone.trim()
      });
      // Cleared only on success. A failed save that wiped what somebody pasted
      // would lose the customer's words, which is the one thing here that cannot
      // be retyped from memory.
      setRawText("");
      setPartyName("");
      setPartyPhone("");
      setShowing(false);
      setOpen(false);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "It did not save.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <p className="add-enquiry__open">
        <Button onClick={() => setOpen(true)}>Add an enquiry</Button>
      </p>
    );
  }

  return (
    <form
      className="add-enquiry"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void save();
      }}
    >
      <Field label="Who asked" hint="Leave it blank if you do not know yet.">
        <input
          type="text"
          value={partyName}
          onChange={(event) => setPartyName(event.target.value)}
          placeholder="Sharma Printers"
        />
      </Field>

      {/* Optional, like the name. An enquiry usually arrives before anybody has
          asked for a number, and a required field here is how intake stops
          being used — which costs more than a missing number ever does. It is
          the one thing that lets a quotation leave by the way it came in. */}
      <Field label="Their number" hint="For sending the quotation back. Leave it blank if you do not have it.">
        <input
          type="tel"
          value={partyPhone}
          autoComplete="off"
          onChange={(event) => setPartyPhone(event.target.value)}
          placeholder="98765 43210"
        />
      </Field>

      <Field label="How it came">
        <select
          value={channel}
          onChange={(event) => setChannel(event.target.value as Deal["channel"])}
        >
          {CHANNELS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="What they said">
        {/* Stored exactly as pasted. Every price quoted later has to be
            defensible against this, so it is never tidied on the way in. */}
        <textarea
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          rows={4}
          placeholder="Paste what the customer wrote"
          autoFocus
        />
      </Field>

      {/* Said plainly, and it stops being said the moment a single character is
          typed over it. An example the owner has forgotten is an example, and a
          shop that finds a customer it has never heard of in its own book stops
          trusting the book. */}
      {showing && rawText === seedText.current ? (
        <p className="add-enquiry__example">
          This is an example, so you can see what happens. Type over it with a real one, or add
          it and mark it “Not a real enquiry” afterwards.
        </p>
      ) : null}

      {/* Announced, not just shown. A save that failed silently for somebody
          using a screen reader is a customer's words lost without a word. */}
      <p className="add-enquiry__problem" role="alert">
        {problem ?? ""}
      </p>

      <div className="add-enquiry__actions">
        <Button type="submit" tone="primary" disabled={!ready}>
          {saving ? "Saving…" : "Add it"}
        </Button>
        {/* Disabled mid-save: closing the form while a save is in flight throws
            away the failure message it is about to produce. */}
        <Button
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setProblem(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
