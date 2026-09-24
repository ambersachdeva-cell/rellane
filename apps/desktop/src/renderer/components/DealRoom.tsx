/**
 * One enquiry's whole life, in one room.
 *
 * Two panes, and which side a thing is on is the argument. On the left is what
 * the customer actually wrote, verbatim, on an inset surface that never takes a
 * cursor — it is evidence, and the room is built so that editing it is not an
 * option somebody has to resist. On the right is the shop's answer, which is the
 * only part anyone is allowed to change.
 *
 * The outcome dock is pinned to the bottom and never scrolls. A quotation's
 * close — won, lost, or no reply, and the owner's own words for why — is the
 * most valuable row this product will ever write, and burying it under a long
 * line-item table is how a business ends up with a year of quotes and no idea
 * which ones it won.
 *
 * Colour is scarce here on purpose (DESIGN.md §1.3). The three outcome buttons
 * are quiet until a deal is closed; it is the *closed state* that earns
 * saturation, because that is the fact worth seeing from across the room.
 */

import { useState } from "react";
import type { PastLine } from "@cadrane/contracts";
import type { Deal, QuotationState } from "../../main/book/records.js";
import { rupees, taxRate } from "../../main/book/money.js";
import { plural } from "../../shared/copy.js";
import { Button, Empty, Field } from "./ui.js";
import { AddLine } from "./AddLine.js";
import { DealCustomer } from "./DealCustomer.js";
import { ProposedLines, type ProposedLine } from "./ProposedLines.js";
import "../styles/deal.css";

const CHANNEL_LABEL: Record<Deal["channel"], string> = {
  indiamart: "IndiaMART",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  email: "Email",
  phone: "Phone",
  walk_in: "Came in"
};

/** How a finished deal reads afterwards. */
export const CLOSED_LABEL: Partial<Record<QuotationState, string>> = {
  won: "Order confirmed",
  lost: "Order lost",
  no_reply: "Closed with no reply"
};

/**
 * How long something has been waiting, as a phrase that is true.
 *
 * Three things this must not say. "0 days ago" for something that arrived this
 * morning — it reads as broken and it is not what a person would say. "-1 days"
 * when a clock has drifted backwards, which happens on a laptop that has slept.
 * And "1 days", which is the cheapest possible signal that nobody looked.
 */
export function waited(from: number, to: number): string {
  const whole = Math.floor((to - from) / 86_400_000);
  if (whole <= 0) {
    return "today";
  }
  return `${plural(whole, "day")} ago`;
}

export function DealRoom({
  deal,
  now,
  onDraft,
  onReadEnquiry,
  onAddLine,
  onRemoveLine,
  onRecall,
  onMessage,
  onSend,
  onClose,
  onSetCustomer,
  onTriage,
  onModels,
  backTo,
  onWhatsApp,
  onAllowCustomer,
  onBack
}: {
  readonly deal: Deal;
  readonly now: number;
  readonly onDraft: () => void;
  /** Proposes what the enquiry asks for. Saves nothing, prices nothing. */
  readonly onReadEnquiry: () => Promise<{ lines: readonly ProposedLine[]; said: string }>;
  readonly onAddLine: (line: {
    description: string;
    quantity: number;
    unitPricePaise: number;
    unit?: string | null;
  }) => Promise<void>;
  /**
   * Takes one line back off, while the quotation is still a draft.
   *
   * Pricing is the step most likely to be got wrong, and until this existed it
   * could only be got wrong once: a rate typed as ₹450 instead of ₹45 stayed on
   * the quotation, and the shop's only way out was to abandon the enquiry.
   */
  readonly onRemoveLine: (itemId: string) => Promise<void>;
  /** What this shop charged for work like this. Reads only, proposes nothing. */
  readonly onRecall: (like: string) => Promise<readonly PastLine[]>;
  /** The quotation as the customer would read it. Composed, never sent. */
  readonly onMessage: () => Promise<string | null>;
  readonly onSend: () => void;
  readonly onClose: (state: "won" | "lost" | "no_reply", reason: string) => void;
  /** Who this turned out to be from. Usually learned after it arrived. */
  readonly onSetCustomer: (who: { name: string; phone: string | null }) => Promise<void>;
  /** Says whether this was work at all. Nothing is deleted either way. */
  readonly onTriage: (triage: "real" | "junk") => void;
  /** Where a person goes when the reading says no model is installed. */
  readonly onModels: () => void;
  /** The screen this was opened from, named so the way out is not a guess. */
  readonly backTo: string;
  /**
   * Opens WhatsApp with the quotation typed in. It never sends.
   *
   * Returns what happened in the owner's words either way — most often a
   * refusal, because the customer is not on the outbound list yet, and a button
   * that silently does nothing is worse than one that says why.
   */
  readonly onWhatsApp: () => Promise<{ said: string; canAdd: boolean }>;
  /**
   * Adds this one customer to the outbound list, then tries the handoff again.
   *
   * Offered only after a refusal, and only where the refusal was about the
   * list. The owner already typed this number into the enquiry; a trip to
   * Settings to type it a second time is the same decision asked twice.
   */
  readonly onAllowCustomer: () => Promise<string>;
  readonly onBack: () => void;
}) {
  const [reason, setReason] = useState("");
  const [proposed, setProposed] = useState<{ lines: readonly ProposedLine[]; said: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** What the handoff said last. Null until it has been asked. */
  const [handoff, setHandoff] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  /** Which line is on its way out. One at a time, so no two removals race. */
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * Whether adding this customer would let the handoff through.
   *
   * The main process decides it. The first version matched the lock's refusal
   * prose with a regex, which meant the offer would have vanished silently the
   * day somebody reworded a sentence — and offering "add them" after a "this
   * quotation has no lines" refusal would be worse than offering nothing.
   */
  const [notOnList, setNotOnList] = useState(false);
  /*
   * Nothing is reset here, and that is the fix rather than an omission.
   *
   * Every piece of state above belonged to one deal and was cleared by an
   * effect keyed on `deal.enquiryId`. Effects run after paint, so the new
   * customer appeared for a frame wearing the previous one's typed reason,
   * message preview and proposed lines — and a reading still in flight when
   * the owner moved on resolved into the new room and attached one customer's
   * lines to another's quotation, which is the one thing a screen built around
   * "every figure is defensible against the message beside it" cannot do.
   *
   * `App` keys this component on the enquiry instead. A different deal is a
   * different component: the state starts empty because it is new, and a
   * promise from the old room resolves into an instance nobody is looking at.
   */

  async function read(): Promise<void> {
    setReading(true);
    try {
      setProposed(await onReadEnquiry());
    } finally {
      setReading(false);
    }
  }

  const quote = deal.quotation;
  const junk = deal.triage === "junk";
  const closed = quote !== null && quote.closedAt !== null;
  const sent = quote !== null && quote.state === "sent";

  return (
    <section className={`deal${closed ? ` deal--closed deal--${quote.state}` : ""}`}>
      <header className="deal__bar">
        <Button tone="ghost" onClick={onBack}>
          ← {backTo}
        </Button>
        <DealCustomer name={deal.partyName} phone={deal.partyPhone} onSave={onSetCustomer} />
        <span className="deal__origin">
          {CHANNEL_LABEL[deal.channel]} · {waited(deal.receivedAt, now)}
        </span>
        <span className="deal__anchor">
          {quote === null ? "—" : rupees(quote.totalPaise, { paise: true })}
        </span>
      </header>

      {junk ? (
        // Said where the work would be, not in a corner. Nothing was deleted:
        // the words are still on the left, and the only claim being made is
        // that nobody owes this a price.
        <p className="deal__junk" role="status">
          Marked as not a real enquiry, so it is off Today. Nothing was deleted.{" "}
          <button type="button" className="link" onClick={() => onTriage("real")}>
            Put it back
          </button>
        </p>
      ) : null}

      <div className="deal__panes">
        {/* tabIndex makes the scroll region reachable: it holds no focusable
            children, so without it a keyboard-only reader cannot scroll a long
            message — and this pane is the evidence every price answers to. */}
        <article className="deal__evidence" tabIndex={0} aria-label="Customer's original message">
          <h2 className="deal__label">Customer's original message</h2>
          {/* Rendered as pre-wrapped text, not an input. Line breaks, spelling and
              whatever else arrived are kept exactly; this is the thing every
              figure on the right has to be defensible against. */}
          <pre className="deal__raw">{deal.rawText}</pre>
        </article>

        <article className="deal__draft" aria-label="Quotation">
          {quote === null ? (
            <Empty
              title="Enquiry received. No quotation prepared yet."
              body="Nothing has been priced against this yet. It stays on Today until a price reaches the customer."
              action={
                <>
                  <Button tone="primary" onClick={onDraft}>Make quotation</Button>
                  <Button disabled={reading} onClick={() => void read()}>
                    {reading ? "Reading…" : "Read it into lines"}
                  </Button>
                  {/* Only here. An enquiry somebody has already priced is not
                      junk, whatever it turned out to be, and offering the button
                      beside a quotation invites a click that contradicts the
                      work already done. */}
                  {junk ? null : (
                    <Button tone="ghost" onClick={() => onTriage("junk")}>
                      Not a real enquiry
                    </Button>
                  )}
                </>
              }
            />
          ) : (
            <>
              <div className="deal__quote-head">
                <h2 className="deal__quote-title">Quotation</h2>
                {closed ? null : (
                  <>
                    {/* Reading proposes lines, and a sent quotation cannot take
                        one — the customer is holding it. Offering the button
                        there is an invitation to watch something happen and
                        then find there was nowhere for it to go. */}
                    {sent ? null : (
                      <Button disabled={reading} onClick={() => void read()}>
                        {reading ? "Reading…" : "Read it into lines"}
                      </Button>
                    )}
                    <Button
                      disabled={quote.lines.length === 0}
                      onClick={() => {
                        void (async () => {
                          setCopied(false);
                          setPreview(await onMessage());
                        })();
                      }}
                    >
                      {sent ? "Send it again" : "Preview message"}
                    </Button>
                  </>
                )}
              </div>
              <table className="deal__lines">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col" className="num">Qty</th>
                    <th scope="col" className="num">Rate</th>
                    <th scope="col" className="num">Amount</th>
                    {/* Unlabelled on purpose: a column heading of "Remove" over
                        a row of crosses is a heading nobody reads twice, and
                        the buttons name themselves for a screen reader. */}
                    {closed || sent ? null : <th scope="col" />}
                  </tr>
                </thead>
                <tbody>
                  {quote.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        {line.description}
                        {line.unit === null ? null : <span className="deal__unit"> {line.unit}</span>}
                      </td>
                      <td className="num">{line.quantity}</td>
                      <td className="num">{rupees(line.unitPricePaise, { paise: true })}</td>
                      <td className="num">{rupees(line.linePaise, { paise: true })}</td>
                      {/* Only on a draft. Once it is sent the customer is
                          holding this, and quietly changing what the shop is on
                          record as having offered is worse than the mistake. */}
                      {closed || sent ? null : (
                        <td className="deal__strike">
                          <button
                            type="button"
                            className="link"
                            aria-label={`Remove ${line.description}`}
                            disabled={removing !== null}
                            onClick={() => {
                              void (async () => {
                                setRemoving(line.id);
                                try {
                                  await onRemoveLine(line.id);
                                } finally {
                                  setRemoving(null);
                                }
                              })();
                            }}
                          >
                            {removing === line.id ? "Removing…" : "Remove"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {quote.gstRateBp === null ? null : (
                    <>
                      <tr>
                        <th scope="row" colSpan={3}>Before tax</th>
                        <td className="num">{rupees(quote.netPaise, { paise: true })}</td>
                        {closed || sent ? null : <td />}
                      </tr>
                      <tr>
                        <th scope="row" colSpan={3}>GST {taxRate(quote.gstRateBp)}</th>
                        <td className="num">
                          {rupees(quote.totalPaise - quote.netPaise, { paise: true })}
                        </td>
                        {closed || sent ? null : <td />}
                      </tr>
                    </>
                  )}
                  <tr className="deal__grand">
                    <th scope="row" colSpan={3}>Total amount</th>
                    <td className="num">{rupees(quote.totalPaise, { paise: true })}</td>
                    {closed || sent ? null : <td />}
                  </tr>
                </tfoot>
              </table>

              {/* The plain way to price something, and the only way there was
                  none of until now: every route to a line went through a local
                  model reading the enquiry, so on a Mac without one the loop
                  stopped here and the refusal told the owner to do a thing the
                  product did not let them do. */}
              {closed || sent ? null : (
                <AddLine onAdd={onAddLine} onRecall={onRecall} now={now} />
              )}

              {preview === null ? null : (
                <section className="deal__preview" aria-label="What the customer will see">
                  <header className="deal__preview-head">
                    <h3>What the customer will see</h3>
                    <Button
                      onClick={() => {
                        void navigator.clipboard.writeText(preview).then(() => setCopied(true));
                      }}
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                    {/* Offered only where the message is, and only when there
                        is a number to open a chat with. A button that always
                        refuses teaches people to stop pressing buttons. */}
                    {deal.partyPhone === null || deal.partyPhone.trim() === "" ? null : (
                      <Button
                        tone="primary"
                        disabled={opening}
                        onClick={() => {
                          void (async () => {
                            setOpening(true);
                            try {
                              const answer = await onWhatsApp();
                              setHandoff(answer.said);
                              setNotOnList(answer.canAdd);
                            } finally {
                              setOpening(false);
                            }
                          })();
                        }}
                      >
                        {opening ? "Opening…" : "Open in WhatsApp"}
                      </Button>
                    )}
                    <Button tone="ghost" onClick={() => setPreview(null)}>
                      Hide
                    </Button>
                  </header>
                  {/* Exactly the text that would be staged — not a rendering of
                      it. Reading a paraphrase before sending defeats the point. */}
                  <pre className="deal__preview-text">{preview}</pre>

                  {/* Said whether it opened or was refused. A refusal here is
                      usually the outbound list, which is a thing the owner can
                      fix and needs to be told about rather than left guessing. */}
                  {handoff === null ? null : (
                    <p className="deal__handoff" role="status">
                      {handoff}
                    </p>
                  )}

                  {notOnList ? (
                    <p className="deal__handoff">
                      <Button
                        disabled={opening}
                        onClick={() => {
                          void (async () => {
                            setOpening(true);
                            try {
                              const said = await onAllowCustomer();
                              setHandoff(said);
                              setNotOnList(false);
                            } finally {
                              setOpening(false);
                            }
                          })();
                        }}
                      >
                        Add {deal.partyName ?? "this customer"} to my contacts
                      </Button>
                    </p>
                  ) : null}
                </section>
              )}

            </>
          )}

          {/* Outside both branches on purpose. "Read it into lines" is offered
              before anything is priced — it is the whole of step two on a first
              run — and while this lived inside the quoted branch the button set
              `proposed`, nothing rendered it, and the owner watched "Reading…"
              finish into silence. */}
          {proposed === null || closed ? null : (
            <ProposedLines
              lines={proposed.lines}
              said={proposed.said}
              onDismiss={() => setProposed(null)}
              onAdd={onAddLine}
              onInstallModel={onModels}
            />
          )}
        </article>
      </div>

      <footer className="deal__dock">
        {closed ? (
          <div className="deal__verdict">
            <strong>{CLOSED_LABEL[quote.state]}</strong>
            {quote.closedReason === null ? null : (
              <span className="deal__reason">{quote.closedReason}</span>
            )}
          </div>
        ) : (
          <>
            <span className="deal__state">
              {quote === null
                ? "Nothing priced yet"
                : sent && quote.sentAt !== null
                  ? `Quotation sent ${waited(quote.sentAt, now)}. Waiting for customer reply.`
                  : "Draft. The customer has not had this yet."}
            </span>

            {quote !== null && !sent ? (
              // Nothing leaves without being asked for (D-033, D-035). This is a
              // request to stage the message, never a send.
              <Button tone="primary" onClick={onSend} disabled={quote.lines.length === 0}>
                Send this quotation
              </Button>
            ) : null}

            {quote !== null ? (
              <div className="deal__outcomes">
                <Field label="Reason">
                  <input
                    type="text"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="In your own words"
                  />
                </Field>
                {/* An empty quotation cannot have been confirmed: there is no
                    price for anyone to have agreed to. */}
                <Button disabled={quote.lines.length === 0} onClick={() => onClose("won", reason)}>
                  Order confirmed
                </Button>
                <Button onClick={() => onClose("lost", reason)}>Order lost</Button>
                {/* Only offered once it has actually gone out. Nobody can fail to
                    reply to something they were never sent. */}
                {sent ? (
                  <Button onClick={() => onClose("no_reply", reason)}>No reply</Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </footer>
    </section>
  );
}
