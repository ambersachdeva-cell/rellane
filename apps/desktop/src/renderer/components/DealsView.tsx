/**
 * Every enquiry this shop has had, and how each one went.
 *
 * The rail has two words on it. The first, Today, answers *what needs me this
 * morning*. This is the second, and until now it opened the old workroom screen
 * — the owner of a print shop pressed it and was offered a brand campaign
 * starter. That gap is the thing the plan diagnosed in one sentence: plausible
 * surfaces with nothing behind them.
 *
 * It says "Enquiries" and not "Deals". A deal is Salesforce's word; the six
 * steps of D-111 are written in the shop's own nouns, and a rail that
 * introduces a third one is how a codebase ends up with a Case, a Deal and an
 * Enquiry all meaning the same job. The types keep the name `Deal`, because in
 * code it usefully means an enquiry and its quotation together — but nothing a
 * person reads says it.
 *
 * ## It is a list, not a dashboard
 *
 * No conversion rate, no revenue chart, no month-on-month. A shop with eleven
 * deals does not have a trend, and a figure nobody can act on is decoration.
 * What is here is what a person actually comes looking for: which job was that,
 * what did we say, and what happened.
 *
 * ## Why the outcome is the loudest thing in a row
 *
 * "Say what happened" is the sixth step and the one with no immediate reward —
 * the customer already knows the answer, so recording it is purely for later.
 * This screen is the later. If a closed deal were invisible here, the tenth
 * second the owner spends on the dock would be wasted, and they would stop.
 *
 * ## Junk is shown
 *
 * It is off Today because it needs nothing done. Hiding it here as well would
 * make "nothing is deleted" true only in the database, which is not where the
 * owner lives.
 */

import type { DealSummary } from "../../main/book/records.js";
import { rupees } from "../../main/book/money.js";
import { Empty } from "./ui.js";
import "../styles/deals.css";

const CHANNEL_LABEL: Record<DealSummary["channel"], string> = {
  indiamart: "IndiaMART",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  email: "Email",
  phone: "Phone",
  walk_in: "Came in"
};

/**
 * What has happened to a deal, in the owner's words, and how loud it is.
 *
 * The three endings take colour and nothing else does, because an ending is the
 * fact worth seeing from across the room (DESIGN.md §1.3). "Waiting" is ink: it
 * is the commonest state in the list and a wall of amber would highlight
 * nothing.
 */
export function standing(deal: DealSummary): { readonly said: string; readonly tone: string } {
  if (deal.triage === "junk") {
    return { said: "Not a real enquiry", tone: "junk" };
  }
  switch (deal.state) {
    case null:
      return { said: "No price yet", tone: "open" };
    case "draft":
      return { said: "Draft", tone: "open" };
    case "sent":
      return { said: "Waiting for an answer", tone: "open" };
    case "won":
      return { said: "Won", tone: "won" };
    case "lost":
      return { said: "Lost", tone: "lost" };
    case "no_reply":
      return { said: "No reply", tone: "quiet" };
  }
}

/**
 * Month names, written out rather than formatted.
 *
 * `toLocaleDateString("en-IN", { month: "short" })` returns "Sept" for September
 * and three letters for everything else, so one row in twelve is a character
 * wider than the rest of the column. It also depends on whichever ICU data the
 * machine shipped with, which is not a thing a date column should vary by.
 */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
] as const;

/**
 * The date a person would use to find this again.
 *
 * Day and month, and the year only when it is not this one — a list where every
 * row says 2026 has taught the reader to skip four characters on every line.
 */
export function on(at: number, now: number): string {
  const date = new Date(at);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? day
    : `${day} ${String(date.getFullYear())}`;
}

export function DealsView({
  deals,
  more,
  now,
  onOpen
}: {
  /** Null until the first read lands — "checking…", never a zero nobody saw. */
  readonly deals: readonly DealSummary[] | null;
  /** Whether older enquiries exist below the ones shown. */
  readonly more: boolean;
  readonly now: number;
  readonly onOpen: (enquiryId: string) => void;
}) {
  return (
    <section className="place-body">
      <header className="place-head">
        <h1>Enquiries</h1>
        <p className="muted">
          Every one this shop has had, newest first, and what came of it.
        </p>
      </header>

      {deals === null ? (
        <p className="muted">Checking…</p>
      ) : deals.length === 0 ? (
        <Empty
          title="No enquiries yet."
          body="Every one you record turns up here, and stays after it is closed — this is where you find out which jobs are worth quoting."
        />
      ) : (
        <ul className="deals">
          {deals.map((deal) => {
            const state = standing(deal);
            return (
              <li key={deal.enquiryId}>
                <button
                  type="button"
                  className={`deals__row${deal.partyName === null ? " deals__row--unnamed" : ""}`}
                  // Tied to the sentence below it, so somebody moving through
                  // this list by button hears why a job went the way it did.
                  // Without it, the most valuable line on the screen is the one
                  // a screen reader skips.
                  aria-describedby={
                    deal.closedReason === null ? undefined : `because-${deal.enquiryId}`
                  }
                  onClick={() => onOpen(deal.enquiryId)}
                >
                  {deal.partyName === null ? null : (
                    <span className="deals__who">{deal.partyName}</span>
                  )}
                  {/* The customer's own words, which is how a person recognises
                      which job this was. A title the shop invented would be one
                      more thing to keep in step with the message. */}
                  <span className="deals__said">{deal.excerpt}</span>
                  <span className={`deals__state deals__state--${state.tone}`}>{state.said}</span>
                  <span className="deals__money">
                    {deal.totalPaise === null ? "—" : rupees(deal.totalPaise, { paise: true })}
                  </span>
                  <span className="deals__when">
                    {CHANNEL_LABEL[deal.channel]} · {on(deal.receivedAt, now)}
                  </span>
                </button>
                {/* Shown under the row it belongs to rather than inside it: the
                    owner's own sentence about why a job went, which is the most
                    valuable thing on this screen and the easiest to lose in a
                    column of figures. */}
                {deal.closedReason === null ? null : (
                  <p className="deals__because" id={`because-${deal.enquiryId}`}>
                    {deal.closedReason}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Said rather than left to be noticed. A list of a business's own records
          that quietly stops is worse than a short one, and this is the only
          screen where a closed job can be found again. */}
      {more ? (
        <p className="muted">
          Older enquiries than these are in the book and are not shown here.
        </p>
      ) : null}
    </section>
  );
}
