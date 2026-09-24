/**
 * Email, as a handoff rather than a sender.
 *
 * The same shape as WhatsApp and for the same structural reason (D-034): a
 * stored SMTP credential is a send path that exists whether or not anybody
 * approved *this* message. SMTP is official where an unofficial WhatsApp library
 * is not, so the ban argument does not carry over — but the approval one does,
 * and it arrives with a credential store, a queue and a retry policy, which is a
 * far larger surface than the feature.
 *
 * So: compose the message, open the owner's own mail client with it filled in,
 * and a person presses send. No credential, nothing to leak, and it works on a
 * fresh install with no setup at all.
 *
 * ## The header-injection problem, which is real here
 *
 * A `mailto:` URL carries the recipient, subject and body as structured fields.
 * A newline or a stray `&` in an *unescaped* subject can introduce headers — a
 * second recipient, a Bcc — that nobody chose. Every field is therefore
 * percent-encoded, and the address is validated before it is used at all. This
 * is the same class of bug as CRLF injection in HTTP headers, and the same fix.
 */

import { diagnostics } from "../foundations/diagnostics.js";
import type { Channel } from "./mark.js";
import type { OpenLink } from "./whatsapp.js";

/**
 * Long bodies survive in a `mailto:`, but not everywhere: some clients and some
 * OS handlers truncate the URL. Refusing is better than a half-written email,
 * which the recipient will read and act on.
 */
export const MAX_BODY_CHARS = 8_000;

export class EmailHandoffError extends Error {}

/**
 * Checks an address well enough to refuse the dangerous shapes.
 *
 * Deliberately not a full RFC 5322 parser: those accept things no mail client
 * will, and the job here is narrower — reject anything carrying a newline, a
 * comma or a semicolon, because those are how a second recipient gets added to
 * a message somebody approved for one.
 */
export function checkAddress(raw: string): string {
  const address = raw.trim();
  // `?`, `&` and `#` are excluded too: they are the mailto: field separators,
  // so an address containing one could append `?bcc=` and add a recipient the
  // owner never approved.
  if (!/^[^\s@,;<>?&#]+@[^\s@,;<>?&#]+\.[^\s@,;<>?&#]+$/u.test(address)) {
    throw new EmailHandoffError(
      "That is not an email address Rellane will open. One address, no separators."
    );
  }
  return address;
}

/** Builds the `mailto:` link, with every field encoded. */
export function mailtoLink(to: string, subject: string, body: string): string {
  if (body.trim().length === 0) {
    throw new EmailHandoffError("There is no message to hand over.");
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new EmailHandoffError(
      `That email is ${body.length.toLocaleString()} characters, which some mail clients will cut off. A half-written email is worse than one that is refused — shorten it to ${MAX_BODY_CHARS.toLocaleString()}.`
    );
  }
  const query = new URLSearchParams({ subject, body });
  // Two encoding rules, both learned the hard way:
  //   - URLSearchParams encodes a space as "+", correct for a form body and
  //     wrong for a mailto: field, where some clients render the plus literally.
  //   - The address is validated but NOT encoded. RFC 6068 wants a literal `@`
  //     in a mailto: target; `user%40example.com` fails to parse in some
  //     clients into any recipient at all.
  return `mailto:${checkAddress(to)}?${query.toString().replace(/\+/gu, "%20")}`;
}

/**
 * Splits a composed message into a subject and a body.
 *
 * The first line if it reads like a subject — short, and followed by a blank
 * line. Otherwise no subject at all, because a wrong subject line is worse than
 * an absent one: the owner will notice a missing subject and will not notice a
 * subject that is merely the first sentence repeated.
 */
export function splitSubject(text: string): { subject: string; body: string } {
  // Normalised first: a trailing `\r` made a 78-character subject measure 79
  // and pushed `\r` through into the body.
  const [first = "", second, ...rest] = text.replace(/\r\n/gu, "\n").split("\n");
  // `rest` must hold something. "Hello\n" would otherwise become a subject with
  // an empty body, and an empty body is refused — so a one-line message threw.
  const looksLikeSubject =
    first.length <= 78 &&
    second !== undefined &&
    second.trim() === "" &&
    rest.join("\n").trim().length > 0;
  return looksLikeSubject
    ? { subject: first.trim(), body: rest.join("\n").trim() }
    : { subject: "", body: text };
}

/**
 * A channel that composes and hands over, and never claims to have sent.
 *
 * `delivery: "stages"`, like WhatsApp: what resolves here is a mail client
 * opening, not a message leaving the Mac.
 */
export function emailHandoff(open: OpenLink): Channel {
  return {
    name: "email",
    delivery: "stages",
    async send(to: string, text: string): Promise<void> {
      const { subject, body } = splitSubject(text);
      await open(mailtoLink(to, subject, body));
      // Neither the address nor the subject is logged: who the owner writes to
      // is the most sensitive thing this channel touches, and a diagnostics
      // bundle is something a person hands to somebody else.
      diagnostics.info("dispatch", "staged an email for the owner to send", {
        chars: text.length,
        hasSubject: subject.length > 0
      });
    }
  };
}
