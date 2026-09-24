/**
 * WhatsApp, as a handoff rather than a sender.
 *
 * WhatsApp has no official API for a personal number. The two ways to reach one
 * are an unofficial library that drives a real session, or a link that opens
 * WhatsApp with a message already typed. Rellane takes the link, decided by the
 * Bench on 2026-09-01 (D-033) and for the reason that settles it:
 *
 *   > An unofficial library holds a live authenticated session, so the send path
 *   > exists independent of the approval gate. One bug, one retry loop, one
 *   > queue replay and a message goes out unapproved. That is not a risk you
 *   > mitigate with careful code — the capability itself is the violation.
 *
 * It would also put the owner's own number at ban risk on an account this
 * product does not control and could not restore. For a hardware trader whose
 * business *is* his WhatsApp, that is not a tolerable failure.
 *
 * So the value here is the composition — the right recipient, the right message,
 * at the right moment — and a person presses send. That last tap is not a
 * limitation to apologise for; it is the product's central promise, expressed as
 * a step nobody can skip.
 */

import { diagnostics } from "../foundations/diagnostics.js";
import type { Channel } from "./mark.js";

/**
 * WhatsApp truncates very long prefills silently, and a message that arrives
 * missing its last line is worse than one that is refused. The documented
 * ceiling for a message is 65,536 characters; this is well under it, chosen so
 * the whole thing survives being carried in a URL.
 */
export const MAX_PREFILL_CHARS = 4_000;

/**
 * The ceiling on the encoded link.
 *
 * Well under the ~64 KB that browsers and OS handlers accept, and above what
 * 4,000 characters of Devanagari encodes to.
 */
export const MAX_ENCODED_CHARS = 24_000;

export class WhatsAppHandoffError extends Error {}

/** Digits only, with the country code, as `wa.me` requires. */
export function toWaNumber(raw: string): string {
  const trimmed = raw.trim();
  /**
   * An explicit country code is never second-guessed.
   *
   * `+65 1234 5678` is ten digits and Singaporean; prepending 91 to it produced
   * a valid-looking number belonging to a stranger in India. That was guarded
   * by `startsWith("+")`, which two shapes people actually paste walk straight
   * past: `(+65) 1234 5678`, because the bracket is first, and `0065 1234 5678`,
   * because the international prefix is digits. Both are ten digits after the
   * code is stripped, and both were being sent to India.
   *
   * So: a `+` anywhere in the leading punctuation counts, and a `00` prefix
   * counts — it is the international prefix spelled out, and a number that
   * begins with it has already said which country it is for.
   */
  const explicit = /^[^\d]*\+/u.test(trimmed) || /^[^\d+]*00\d/u.test(trimmed);
  let digits = trimmed.replace(/[^\d]/gu, "");

  // The international prefix is not part of the number either way.
  digits = digits.replace(/^00/u, "");
  if (!explicit) {
    // The domestic trunk prefix, which people paste from contact cards.
    // `09876543210` is the same number as `9876543210`, and `wa.me` accepts
    // neither with its leading zero.
    digits = digits.replace(/^0/u, "");
  }

  if (digits.length < 10) {
    // The number itself is never in the message. Errors reach diagnostics, and
    // a diagnostics bundle is something a person hands to somebody else — so
    // this said the opposite of what the module claims about not logging
    // recipients.
    throw new WhatsAppHandoffError(
      "That is not a phone number WhatsApp can open. Use the full number including the country code."
    );
  }
  // A bare ten-digit number with no country code is an Indian mobile: the
  // overwhelmingly common case here, and a guess the owner sees in the open
  // WhatsApp window before pressing send.
  return !explicit && digits.length === 10 ? `91${digits}` : digits;
}

/**
 * The link that opens WhatsApp with the message already in the box.
 *
 * `wa.me` rather than `whatsapp://`: it works whether or not the desktop app is
 * installed, falling back to WhatsApp Web, and it is the form Meta documents.
 */
export function handoffLink(to: string, text: string): string {
  if (text.trim().length === 0) {
    throw new WhatsAppHandoffError("There is no message to hand over.");
  }
  /**
   * Two limits, because they catch different failures.
   *
   * The character count is what WhatsApp truncates on. The *encoded* length is
   * what the URL actually carries: `₹` and Devanagari expand to nine characters
   * each under `encodeURIComponent`, so four thousand characters of Hindi
   * becomes tens of thousands in the link and hits limits the raw count never
   * sees. Checking only the encoded length would have made plain ASCII three
   * times more permissive than documented, which is not a fix.
   */
  if (text.length > MAX_PREFILL_CHARS) {
    throw new WhatsAppHandoffError(
      `That message is ${text.length.toLocaleString()} characters. WhatsApp will cut it off, and a message that arrives half-written is worse than one that is refused. Shorten it to ${MAX_PREFILL_CHARS.toLocaleString()}.`
    );
  }
  if (encodeURIComponent(text).length > MAX_ENCODED_CHARS) {
    // Separated, because the two limits produce different advice and the
    // combined version gave the wrong one: three thousand characters of Hindi
    // encodes past the link limit while staying under the character limit, and
    // the owner was told to shorten a 3,000-character message "to 4,000".
    throw new WhatsAppHandoffError(
      "That message is too long for a WhatsApp link once its ₹ signs and Hindi are encoded. Shorten it — roughly half its current length will fit."
    );
  }
  return `https://wa.me/${toWaNumber(to)}?text=${encodeURIComponent(text)}`;
}

/** Opens a URL. Injected so the channel can be tested without a browser. */
export type OpenLink = (url: string) => Promise<void>;

/**
 * A channel that composes and hands over, and never claims to have sent.
 *
 * `delivery: "stages"` is the load-bearing field. Everything downstream that
 * reports an outcome reads it, so nothing in the record can say a WhatsApp
 * message was delivered when what actually happened is that a window opened.
 */
export function whatsAppHandoff(open: OpenLink): Channel {
  return {
    name: "whatsapp",
    delivery: "stages",
    async send(to: string, text: string): Promise<void> {
      const link = handoffLink(to, text);
      await open(link);
      // The number is not logged. Who the owner messages is the most sensitive
      // thing this channel touches, and a diagnostics bundle is something a
      // person hands to somebody else.
      diagnostics.info("dispatch", "staged a WhatsApp message for the owner to send", {
        chars: text.length
      });
    }
  };
}
