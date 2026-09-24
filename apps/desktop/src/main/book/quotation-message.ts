/** The words a customer actually reads.
 *
 * Composed here, in one place, because this is the only text in the product
 * that leaves the shop and arrives in somebody else's hands. It gets read on a
 * phone, usually in a hurry, often while the customer is comparing it against
 * two other shops' replies.
 *
 * ## Nothing is invented
 *
 * Every figure comes from the quotation's own lines and is recomputed here from
 * integer paise. No greeting claims a relationship that does not exist, no
 * closing promises a delivery date nobody agreed, and there is no "please find
 * attached" — a message that says things nobody chose to say is how a shop's
 * own voice stops sounding like it.
 *
 * ## It is staged, never sent
 *
 * This function returns a string. Whether it reaches anyone is the outbound
 * lock's decision and the owner's tap (D-033, D-035). Composing is not sending,
 * and keeping those separate is why this file has no dependencies beyond money
 * formatting.
 */

import type { Deal } from "@cadrane/contracts";
import { rupees, taxRate } from "./money.js";

/**
 * One line of a plain-text document, kept to one line.
 *
 * A description or a customer's name carrying a newline does not merely look
 * wrong: this message is structured *by* its line breaks, so a pasted "\nTotal:
 * ₹1.00" forges a total. Every value that lands on its own line is flattened
 * first. Nothing is truncated — a long description stays long and simply wraps
 * on the reader's phone.
 */
function oneLine(text: string): string {
  return text.replace(SEPARATORS, " ").trim();
}

/**
 * Everything that can start a new line, which is more than `\s`.
 *
 * JavaScript's `\s` covers the usual whitespace and `\u2028`/`\u2029`, and does
 * **not** cover `\u0085` — NEL, a C1 control that plenty of text renderers break
 * on. A description carrying `\u0085Total: ₹1.00` therefore passed through this
 * function unflattened and forged a total on the one document that leaves the
 * shop, which is the exact failure this function exists to prevent. The other
 * C0 controls are here for the same reason: a vertical tab or a form feed is
 * not something a person typed into a quotation on purpose.
 */
const SEPARATORS = /[\s\u0000-\u001F\u007F-\u009F]+/gu;

/** How the shop signs off. Read from settings; never guessed. */
export interface ShopIdentity {
  readonly name: string;
}

/**
 * The quotation as a message.
 *
 * Returns null when there is nothing a customer could act on — no quotation, or
 * one with no lines. An empty quotation is not a short message, it is a mistake,
 * and sending one would cost the shop more than sending nothing.
 */
export function quotationMessage(deal: Deal, shop: ShopIdentity): string | null {
  const quote = deal.quotation;
  if (quote === null || quote.lines.length === 0) {
    return null;
  }

  const lines: string[] = [];

  // Named if we know them. "Dear Customer" is worse than no greeting: it tells
  // the reader they are a row in somebody's system. A name that is only
  // whitespace is not a name either, so it is trimmed before the check.
  const who = oneLine(deal.partyName ?? "");
  lines.push(who === "" ? "Quotation" : `Quotation for ${who}`);
  lines.push("");

  for (const line of quote.lines) {
    const unit = oneLine(line.unit ?? "");
    const described = oneLine(line.description);
    lines.push(
      `${described} — ${line.quantity}${unit === "" ? "" : ` ${unit}`} × ${rupees(line.unitPricePaise, { paise: true })} = ${rupees(line.linePaise, { paise: true })}`
    );
  }

  lines.push("");

  // Shown only when tax is actually being charged. Printing "GST 0%" on a
  // quotation from a shop that does not charge it is a claim about their
  // registration nobody here is entitled to make — and a recorded rate of zero
  // says exactly the same thing as no rate at all. The first version tested
  // `!== null`, which let a zero through and printed the forbidden line.
  const rateBp = quote.gstRateBp ?? 0;
  if (rateBp > 0) {
    // Computed from the rate rather than as total minus net. They agree today,
    // but the moment a discount or a round-off line exists, the subtraction
    // would quietly relabel it as tax on a document the customer keeps.
    const taxPaise = Math.round((quote.netPaise * rateBp) / 10_000);
    lines.push(`Before tax: ${rupees(quote.netPaise, { paise: true })}`);
    lines.push(`GST ${taxRate(rateBp)}: ${rupees(taxPaise, { paise: true })}`);
  }

  lines.push(`Total: ${rupees(quote.totalPaise, { paise: true })}`);

  const signed = oneLine(shop.name ?? "");
  if (signed !== "") {
    lines.push("");
    lines.push(signed);
  }

  return lines.join("\n");
}
