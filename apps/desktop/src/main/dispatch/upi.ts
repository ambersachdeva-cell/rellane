/**
 * A reminder somebody can pay from.
 *
 * ## The gap this closes
 *
 * Chasing a payment ends with *"please pay ₹9,440"* and then a gap: the
 * customer has to open their bank app, type an ID, type an amount, and get both
 * right. Every step in that gap is a day of delay and a chance to key the wrong
 * figure. A UPI link closes it — one tap, the app opens with the payee and the
 * amount already filled in, and the customer presses send.
 *
 * That is worth more to this business than any amount of agent cleverness. It is
 * the difference between a reminder and a payment.
 *
 * ## Why a URI and not an integration
 *
 * `upi://pay` is a published deep-link scheme every Indian payment app honours —
 * GPay, PhonePe, Paytm, BHIM, every bank app. No merchant account, no gateway,
 * no per-transaction fee, no API to be cut off from, and **no money passing
 * through Rellane at any point.** The customer pays the owner directly, exactly
 * as they would if they had typed it.
 *
 * ## It still cannot send anything
 *
 * This builds a string. Putting it in front of a person is
 * `dispatch/stage.ts`'s job, and staging still asks (D-033, D-035). A reminder
 * that could send itself would be the one place this product broke its own rule,
 * and it would break it on the topic where a mistake costs a relationship.
 */

/** What a payment request needs. Nothing here is optional by accident. */
export interface UpiRequest {
  /** The owner's UPI id — `name@bank`. Their own, never Rellane's. */
  readonly payeeId: string;
  /** The name shown in the customer's app. */
  readonly payeeName: string;
  readonly amountPaise: number;
  /** What it is for, shown in the payment app. */
  readonly note: string;
}

/**
 * Whether this is a UPI id at all.
 *
 * Deliberately loose on the handle and strict on the suffix: banks invent new
 * ones constantly (`@okhdfcbank`, `@ybl`, `@ibl`, `@apl`), so a list of known
 * ones would be wrong within a month — but every real one is a **single token
 * with no dot in it**. That is what separates a UPI id from an email address
 * pasted by mistake, which otherwise passes every other test: one `@`, text on
 * both sides, no whitespace.
 */
export const UPI_ID = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9\-_]{1,32}$/u;

export interface UpiLink {
  readonly ok: boolean;
  /** The `upi://pay` URI, or empty. */
  readonly uri: string;
  /** What is wrong, in the owner's words. Null when nothing is. */
  readonly problem: string | null;
}

/**
 * Builds a payment link.
 *
 * The amount goes in as rupees with two decimals, which is what the scheme
 * specifies — the one place in this product an amount is written as a decimal,
 * and it happens here at the boundary where it can be seen.
 */
export function upiLink(request: UpiRequest): UpiLink {
  const payeeId = request.payeeId.trim();
  if (!UPI_ID.test(payeeId)) {
    return {
      ok: false,
      uri: "",
      problem:
        "That does not look like a UPI id. It should be something like yourname@okhdfcbank — the one your own bank app shows you."
    };
  }
  if (!Number.isInteger(request.amountPaise) || request.amountPaise <= 0) {
    return {
      ok: false,
      uri: "",
      // Refused rather than sent as zero. A payment request for nothing is
      // confusing at best, and at worst it is a bill somebody thinks they paid.
      problem: "A payment link needs an amount above zero."
    };
  }

  // Built by hand, not with `URLSearchParams`.
  //
  // That serialises as form-encoding: it turns `@` into `%40` and a space into
  // `+`. Real payment apps do not decode `%40` in the payee field, so the VPA
  // fails to resolve, and the `+` renders literally in the name and the note.
  // Every link this produced would have looked right and paid nobody.
  const fields: readonly [string, string][] = [
    ["pa", payeeId],
    ["pn", request.payeeName.trim().slice(0, 60)],
    ["am", (request.amountPaise / 100).toFixed(2)],
    ["cu", "INR"],
    ["tn", request.note.trim().slice(0, 80)]
  ];
  const query = fields
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%40/gu, "@")}`)
    .join("&");

  return { ok: true, uri: `upi://pay?${query}`, problem: null };
}

/**
 * A WhatsApp link that opens a chat with the message already written.
 *
 * The honest way to reach WhatsApp from a desktop app. The alternative —
 * driving `whatsapp-web.js` — means bundling a second browser and risks the
 * owner's own number being banned by Meta, which is a real cost to a real person
 * rather than an abstract one.
 *
 * And it is the *right* shape anyway: it opens WhatsApp with the words ready and
 * **the owner presses send**, which is the outbound rule (D-035) implemented by
 * the operating system rather than promised by us.
 */
export function whatsappLink(phone: string, message: string): string | null {
  // Digits only, and the country code without a plus, which is what the scheme
  // wants. An Indian mobile written as `+91 98765 43210` or `098765 43210` or
  // `9876543210` is the same person, and all three are typed daily.
  // Leading zeros come off *first*, then the country code is decided.
  //
  // Doing it the other way round meant `098765 43210` — an entirely ordinary
  // way to write an Indian mobile — produced eleven digits, missed the
  // ten-digit test, and came back as null.
  const digits = phone.replace(/\D/gu, "").replace(/^0+/u, "");
  const national = digits.length === 10 ? `91${digits}` : digits;
  if (national.length < 11 || national.length > 15) {
    return null;
  }
  // Sliced by code *points*, not code units. Cutting between the halves of a
  // surrogate pair — which is any emoji — leaves a lone surrogate, and
  // `encodeURIComponent` throws `URIError: URI malformed` on one.
  const trimmed = [...message].slice(0, 2_000).join("");
  return `https://wa.me/${national}?text=${encodeURIComponent(trimmed)}`;
}

/**
 * What a chase actually says.
 *
 * Written to be sent unedited by somebody who is busy, which means it has to be
 * short, exact and not embarrassing. It states the fact, gives the number, and
 * asks — it does not threaten, and it does not apologise for asking either.
 * A reminder that reads as either is one the owner rewrites, and a template
 * nobody sends is a feature that does not exist.
 */
export function chaseMessage(input: {
  readonly party: string;
  readonly amountPaise: number;
  readonly daysLate: number;
  readonly billNumber: string | null;
  readonly from: string;
  readonly payLink?: string;
}): string {
  // Paise are kept when there are any. Rounding to the rupee made the sentence
  // disagree with the exact figure in the payment link beside it — and a
  // reminder that states two different amounts is one nobody sends.
  const rupeesOwed = input.amountPaise / 100;
  const amount = `₹${rupeesOwed.toLocaleString("en-IN", {
    minimumFractionDigits: input.amountPaise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
  const bill = input.billNumber === null ? "" : ` (bill ${input.billNumber})`;
  const when =
    input.daysLate <= 0
      ? "which is due now"
      : `which was due ${input.daysLate} ${input.daysLate === 1 ? "day" : "days"} ago`;

  return [
    `Namaste ${input.party},`,
    "",
    `${amount}${bill} is outstanding, ${when}.`,
    input.payLink === undefined ? null : `You can pay here: ${input.payLink}`,
    "",
    "Please let me know if there is any problem with the bill.",
    "",
    input.from
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
