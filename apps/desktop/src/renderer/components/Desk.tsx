/**
 * The Desk — one box, where you say anything.
 *
 * ## What this replaces, and why
 *
 * The old home screen was a dashboard. It showed ₹82,910 outstanding, three
 * customers, a folder count and four agent cards, and **not one of them was a
 * verb.** A man looking at money he is owed could not chase it, could not
 * record the payment that just landed, could not add the bill in his hand. He
 * had to already know which of nine places held the action he wanted.
 *
 * Nobody thinks in places. They think *"has Patel paid"*, *"put this bill in"*,
 * *"is this quote fair — ask both of them"*. So the front door takes the
 * sentence, and the product finds the screen.
 *
 * ## What is late stays; the balance does not
 *
 * The strip above the conversation used to carry both — the total outstanding
 * and the count of late bills. The total is gone. A balance is a figure you
 * *look at*, and a figure on a front door is the dashboard growing back on the
 * screen built to replace it; it lives in Records now, one keystroke away, for
 * when reading it is the thing you came to do.
 *
 * What is late is not a balance. It is the one state of the book that asks
 * something of you today, so it stays — as the question it makes you want to
 * ask, and only when the answer is not "nothing".
 *
 * ## It says which door it took
 *
 * Every answer carries *why* it went where it went — "you asked about what is
 * late", "that reads like a bill". A router that guesses silently cannot be
 * corrected, and being occasionally wrong is fine as long as being wrong is
 * visible.
 */

import { useEffect, useRef, useState } from "react";
import type { BookStanding, DeskAnswer } from "@cadrane/contracts";
import { Markdown } from "../markdown";

export interface DeskTurn {
  readonly id: string;
  readonly mine: boolean;
  readonly text: string;
  /** Present on Rellane's turns. Null on the owner's own. */
  readonly answer: DeskAnswer | null;
}

interface Props {
  turns: readonly DeskTurn[];
  book: BookStanding | null;
  busy: boolean;
  onSay(text: string): void;
  onOpen(what: "bill" | "bench" | "agent", id?: string): void;
  /** Opens a link in the owner's browser or WhatsApp. Never sends anything. */
  onOpenLink(url: string): void;
  /** Reads a bill from a photograph, a scan or a PDF the owner picks. */
  onReadFile(): void;
}

/** Things worth trying, shown only while there is nothing else on screen. */
const OPENERS: readonly string[] = [
  "Who owes me money?",
  "Who is late?",
  "Paste a bill and I will read it",
  "Ask both models whether this quote is fair"
];

export function Desk({ turns, book, busy, onSay, onOpen, onOpenLink, onReadFile }: Props) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  // Follows the conversation down. Only when something new arrives, so it never
  // yanks the view while somebody is reading back through it.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  const send = () => {
    const said = text.trim();
    if (said.length === 0 || busy) {
      return;
    }
    onSay(said);
    setText("");
  };

  const late = book?.overdue.length ?? 0;

  return (
    <div className="desk">
      {/**
       * Context, not a headline — and only when there is something worth
       * saying. A shop that is square sees nothing here and gets the whole
       * screen for asking. Still clickable, because the original failure of the
       * dashboard was that its figures led nowhere.
       */}
      {late === 0 ? null : (
        <div className="desk__strip">
          <button type="button" className="desk__late" onClick={() => onSay("Who is late?")}>
            {late} {late === 1 ? "bill is" : "bills are"} past the date agreed
          </button>
        </div>
      )}

      <div className="desk__scroll">
        {turns.length === 0 ? (
          <div className="desk__blank">
            <p className="desk__hello">What would you like to do?</p>
            <ul className="desk__openers">
              {OPENERS.map((opener) => (
                <li key={opener}>
                  <button type="button" className="desk__opener" onClick={() => onSay(opener)}>
                    {opener}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="desk__turns">
            {turns.map((turn) => (
              <li key={turn.id} className={turn.mine ? "dturn dturn--mine" : "dturn"}>
                {turn.mine ? (
                  <p className="dturn__said">{turn.text}</p>
                ) : (
                  <div className="dturn__body">
                    <Markdown text={turn.text} />
                    {turn.answer?.because ? (
                      // Said out loud so a wrong route is correctable rather
                      // than mysterious.
                      <p className="dturn__why">Read that as: {turn.answer.because}.</p>
                    ) : null}
                    {/**
                      * A reminder, written out where it can be read before it
                      * goes anywhere. The button opens WhatsApp with the words
                      * already typed — the owner presses send, which is the
                      * outbound rule done by the operating system rather than
                      * promised.
                      */}
                    {turn.answer?.draft == null ? null : (
                      <div className="ddraft">
                        <p className="ddraft__to">To {turn.answer.draft.to}</p>
                        <pre className="ddraft__text">{turn.answer.draft.text}</pre>
                        <div className="ddraft__acts">
                          {turn.answer.draft.whatsapp === null ? null : (
                            <button
                              type="button"
                              className="btn btn--whatsapp"
                              onClick={() => onOpenLink(turn.answer!.draft!.whatsapp!)}
                            >
                              Open in WhatsApp
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void navigator.clipboard.writeText(turn.answer!.draft!.text)}
                          >
                            Copy it
                          </button>
                        </div>
                        <p className="ddraft__note">
                          Rellane has not sent this and cannot. You press send.
                        </p>
                      </div>
                    )}
                    {turn.answer?.open == null ? null : (
                      <button
                        type="button"
                        className="btn btn--primary dturn__open"
                        onClick={() => onOpen(turn.answer!.open!.what, turn.answer!.open!.id)}
                      >
                        {turn.answer.open.what === "bill"
                          ? "Check the figures"
                          : turn.answer.open.what === "bench"
                            ? "Open the argument"
                            : "Watch it run"}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
            {busy ? (
              <li className="dturn">
                <p className="dturn__thinking">
                  <span className="dturn__pulse" aria-hidden="true" />
                  Thinking…
                </p>
              </li>
            ) : null}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <div className="desk__ask">
        <textarea
          className="input desk__in"
          rows={2}
          value={text}
          disabled={busy}
          placeholder="Ask anything, or paste a bill…"
          aria-label="Say what you would like"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; shift-enter is a new line. A pasted bill is many
            // lines and must not send itself halfway through.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {/**
          * Beside the box, because somebody holding a photograph of a bill is
          * already here — and until now the fastest way into the book began
          * with them retyping a page.
          */}
        <button type="button" className="btn" disabled={busy} onClick={onReadFile}>
          Read a bill
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || text.trim().length === 0}
          onClick={send}
        >
          {busy ? "…" : "Say it"}
        </button>
      </div>
    </div>
  );
}
