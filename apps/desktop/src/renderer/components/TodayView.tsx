/**
 * The front door — what needs you today.
 *
 * The plan calls this the moment that sells the product, and describes it
 * precisely: you open the Mac in the morning and are told, in your own words,
 * the handful of things about to be dropped. Not a dashboard, not a greeting,
 * not a chart. Sentences.
 *
 * ## Why this and not a summary of everything
 *
 * A ledger describes the past; a dropped promise is a fact about the future, and
 * that is the thing no accounting package can tell you. So this screen shows
 * only what is *waiting on you* — never turnover, never a total, never a figure
 * that is merely interesting. If it is not something to act on this morning, it
 * does not belong here.
 *
 * ## A quiet morning is silent
 *
 * No tick, no "all caught up", no encouragement. A product that congratulates
 * you for nothing happening is one you stop believing when something has, and
 * the empty state's job here is to be trusted rather than to be nice. It says
 * what it looked at and stops.
 *
 * ## Sentences, ruled, one saturated thing
 *
 * `DESIGN.md`: a list of records is ruled rather than carded, and only the thing
 * worth acting on takes colour. Urgent takes the danger hue and nothing else on
 * the screen competes with it. Everything that carries a number carries it in
 * mono, because those are numbers a person compares.
 */

import type { Deal, TodayItem } from "@cadrane/contracts";
import { useCallback, useState } from "react";
import { AddEnquiry, type EnquirySeed } from "./AddEnquiry.js";
import { EXAMPLE_ENQUIRY, FirstEnquiry } from "./FirstEnquiry.js";

interface Props {
  /** Null until the first read returns — "checking…", never a zero nobody saw. */
  readonly items: readonly TodayItem[] | null;
  /** Opens the case or the record a line came from. */
  readonly onOpen: (item: TodayItem) => void;
  readonly onRefresh: () => void;
  /** Whether nobody has put anything here yet. Null until the first read lands. */
  readonly freshBook: boolean | null;
  /** Records an enquiry by hand. Until a channel is connected, the only way one exists. */
  readonly onAddEnquiry: (input: {
    channel: Deal["channel"];
    rawText: string;
    partyName: string | null;
    partyPhone: string | null;
  }) => Promise<void>;
}

export function TodayView({ items, onOpen, onRefresh, onAddEnquiry, freshBook }: Props) {
  const greeting = greets(items, freshBook);
  // Handed down to the form and taken back the instant it lands, so pressing the
  // button a second time fills the box again rather than doing nothing.
  const [seed, setSeed] = useState<EnquirySeed | null>(null);
  // Stable, because the form takes it as an effect dependency: an arrow written
  // inline here is a new function every render, and the effect that consumes a
  // seed would re-run on renders that had nothing to do with it.
  const seedUsed = useCallback(() => setSeed(null), []);

  return (
    <section className="place-body">
      <header className="place-head">
        <h1>{greeting ? "Rellane" : heading(items)}</h1>
        {/* What this screen looked at — useful to somebody with records, and to
            somebody on their first morning it is the machinery talking. That is
            the exact complaint the greeting exists to answer, so it waits. It
            waits for the read too: appearing during the check and disappearing
            when the answer arrives is a flash, not a transition. */}
        {greeting || items === null || freshBook === null ? null : (
          <p className="muted">
            Enquiries with no price yet, quotes with no answer, and work nobody has replied to.
            Everything here is worked out from your records when you open it — nothing is a
            stored total.
          </p>
        )}
      </header>

      {items === null || freshBook === null ? (
        <p className="muted">Checking…</p>
      ) : greeting ? (
        // Never quoted anything. Explain the loop once, then get out of the way.
        <FirstEnquiry onTryExample={() => setSeed(EXAMPLE_ENQUIRY)} />
      ) : items.length === 0 ? (
        <div className="today-quiet">
          <p>Every enquiry has a price and every quote has an answer.</p>
          <p className="muted">
            Rellane looked at every enquiry with nothing quoted against it, every quote sent
            and still unanswered, and every case with no answer for a week. An enquiry that
            arrived this morning is not waiting yet.
          </p>
        </div>
      ) : (
        <ul className="today">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <button
                type="button"
                className={item.severity === "urgent" ? "today-row today-row--urgent" : "today-row"}
                onClick={() => onOpen(item)}
              >
                <span className="today-row__line">{item.line}</span>
                <span className="today-row__meta">{noun(item.kind)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddEnquiry
        onAdd={onAddEnquiry}
        seed={seed}
        onSeedUsed={seedUsed}
        startOpen={greeting}
      />

      {/* Nothing to look again at before the first enquiry exists, and nothing
          to look again at while the first look is still happening. */}
      {greeting || items === null || freshBook === null ? null : (
        <p>
          <button type="button" className="link" onClick={onRefresh}>
            Look again
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * Whether this is somebody's first morning with the product.
 *
 * An empty book is not a quiet morning, it is somebody meeting Rellane, and the
 * two want opposite screens. The signal is the *book*, not the day: a shop that
 * has quoted and closed everything has an empty Today on an ordinary Thursday,
 * and being told what the product is for again would read as the app forgetting
 * them. It is also wider than "no enquiries", because a shop carrying parties or
 * cases from before the loop existed is not a stranger either.
 *
 * Both nulls are "not yet known" and neither greets. A greeting that flashes for
 * one frame while the first read lands is worse than one that arrives a moment
 * late.
 */
export function greets(
  items: readonly TodayItem[] | null,
  freshBook: boolean | null
): boolean {
  return items !== null && items.length === 0 && freshBook === true;
}

/**
 * The heading is the count, in words.
 *
 * "Four things need you today" is the sentence the plan wrote and it is better
 * than the word "Today" above a list, because it says the answer before the
 * reader has to count anything themselves.
 */
export function heading(items: readonly TodayItem[] | null): string {
  if (items === null) {
    return "Today";
  }
  if (items.length === 0) {
    return "Nothing needs you today";
  }
  if (items.length === 1) {
    return "One thing needs you today";
  }
  return `${inWords(items.length)} things need you today`;
}

/** Small numbers read better as words in a sentence; six is the ceiling. */
function inWords(n: number): string {
  return ["", "One", "Two", "Three", "Four", "Five", "Six"][n] ?? String(n);
}

/** What kind of thing a line came from, in the owner's noun. */
export function noun(kind: TodayItem["kind"]): string {
  switch (kind) {
    case "enquiry":
      return "enquiry";
    case "quotation":
      return "quote";
    // Billing left the product on 12 September and Tally keeps the accounts, but
    // a book written before that still holds bills and they must still read.
    case "invoice":
      return "bill";
    default:
      return "case";
  }
}
