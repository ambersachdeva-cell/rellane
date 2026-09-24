/**
 * What a stranger sees the first time they open Rellane.
 *
 * The owner's complaint about the old build was that nobody would know how to
 * use it, and the cause was that the front door described the machinery — which
 * engines were connected, which folders were granted — to somebody who had come
 * to run a print shop. None of that is here.
 *
 * ## It promises only what always happens
 *
 * The second step says the owner sets the rate and that nothing invents one.
 * It does not mention reading the message into lines, which is the part that
 * needs a model — and on the one Mac guaranteed to read this screen, there is
 * no model yet. A first version promised the reading outright and was wrong on
 * every fresh install; the correction said "if a model is installed on this
 * Mac", which is accurate and is the machinery talking, on the screen that
 * exists because the machinery was talking. The reading introduces itself when
 * it works, and says why not when it does not.
 *
 * ## Three sentences and one thing to do
 *
 * A person opening this has one question: what is it for. The answer is the
 * loop, in their nouns, in the order it happens — and then the only action that
 * exists on day one, which is to put in the enquiry they are probably already
 * looking at on their phone.
 *
 * ## It is shown once and never nags
 *
 * The condition is *ever recorded an enquiry*, not *Today is empty*. A shop that
 * has quoted and closed everything has an empty Today on an ordinary Thursday,
 * and being told what the product is for again would read as the app forgetting
 * them.
 *
 * ## Nothing here is set up
 *
 * No folder to grant, no model to install, no account. The loop needs none of
 * it, and a first run that opens with four prerequisites is how a person decides
 * to do it later.
 *
 * ## There is an example, because an empty box is a wall
 *
 * Somebody reading this may have nothing to hand: no enquiry open on their
 * phone, and no idea what this box expects — raw Hinglish, or tidy bullet
 * points, or dimensions in some format nobody has named. So there is a worked
 * one, in the voice these actually arrive in. It fills the form and does nothing
 * else: the owner reads it, can change it, and presses the button themselves.
 * Nothing is written to their book on their behalf.
 */

import type { EnquirySeed } from "./AddEnquiry.js";
import { Button } from "./ui.js";
import "../styles/first-enquiry.css";

/**
 * The worked example, in the voice an enquiry actually arrives in.
 *
 * Hinglish, lower case, no punctuation to speak of, the quantity and the stock
 * and the deadline all in one breath. A tidy specimen would demonstrate a
 * product nobody has, and would teach the owner to tidy up their customers'
 * messages before pasting them — which is the one habit that would make every
 * price quoted afterwards undefendable.
 */
export const EXAMPLE_ENQUIRY: EnquirySeed = {
  channel: "whatsapp",
  partyName: "Verma Textiles",
  // A number nobody can dial. The example demonstrates the field without
  // handing somebody a stranger's phone if they press the button and forget.
  partyPhone: "",
  rawText:
    "bhai 500 visiting cards banwane hain, 300 gsm matte, dono side printing. rate kya lagega? thursday tak chahiye"
};

export function FirstEnquiry({ onTryExample }: { readonly onTryExample: () => void }) {
  return (
    <div className="first-enquiry">
      <h2>Start with one enquiry.</h2>

      <ol className="first-enquiry__steps">
        <li>
          <strong>Put in what a customer asked for.</strong> Paste their message exactly as they
          sent it — WhatsApp, IndiaMART, or what they said on the phone.
        </li>
        <li>
          <strong>Price it.</strong> You set the rate, every time. Rellane never invents one.
        </li>
        <li>
          <strong>Say what happened.</strong> Won, lost, or no reply. That is the part that tells
          you later which jobs are worth quoting.
        </li>
      </ol>

      <p className="first-enquiry__try">
        <Button onClick={onTryExample}>Fill in an example</Button>
      </p>

      <p className="muted">
        Everything stays on this Mac. Nothing is sent to a customer unless you send it.
      </p>
    </div>
  );
}
