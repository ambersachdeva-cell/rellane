/** Turning a reviewed enquiry into the first draft of a quotation's lines.
 *
 * This is a bridge, not a second reader. `main/workroom/enquiry.ts` already
 * reads a print enquiry into thirteen domain fields, with a prompt that handles
 * negations, quantity alternatives, artwork-versus-delivery dates and
 * pickup-versus-delivery, and that already forbids inventing prices. A first
 * version of this file re-implemented a cruder three-field version of the same
 * job before that was found; the duplicate is gone, and what survives is the
 * quantity parser, which the older path had no need for.
 *
 * ## Still no prices
 *
 * `item` and `quantities` become a description and a count. Nothing here
 * produces a rate, because nothing upstream is allowed to propose one. The
 * owner prices their own work.
 */

import type { EnquirySuggestion, Proposed } from "@cadrane/contracts";

/** Anything that means money. A price is never a quantity. */
const MONEY = /[\u20B9$\u00A3\u20AC\u00A5]|\b(?:rs|inr|usd|rupees?|paise|lakh|crore)\b/iu;
/** A span between two figures. Neither end is ours to choose. */
const RANGE = /\d\s*(?:[-\u2013\u2014~]|to)\s*\d/iu;
/** A decimal in any of the forms a person writes one, including a bare ".5". */
const FRACTION = /\d[.]\d|(?:^|[^\d])[.]\d/u;
/** Indian grouping: 1,000 and 1,00,000 are counts; "12,5" is a European decimal. */
const GROUPED = /^\d{1,3}(?:,\d{2,3})*$/u;
/**
 * A figure standing on its own, not glued to letters.
 *
 * The leading boundary is what stops "A4, 500 copies" reading as 4, and the
 * trailing one is what stops "100gsm bond" reading as 100.
 */
const STANDALONE = /(?:^|[^\p{L}\p{N}])(\d[\d,]*)(?![\p{L}\d])/u;
/**
 * Units that describe the product rather than count it.
 *
 * "300 gsm" is the paper and "1200 dpi" is the artwork; neither is how many the
 * customer wants. A print enquiry almost always carries one, so a quantity field
 * that came back holding one is a misread — and a quotation for 300 visiting
 * cards when 500 were asked for is wrong by the kind of factor a customer
 * notices and the shop eats.
 *
 * Checked against what follows the matched figure, never against the whole
 * string: "500 cards 90x54mm" is five hundred cards, and a blanket search for
 * "mm" would refuse it. And deliberately short. Flex is sold by the square foot
 * and banners by the metre, so `ft` and `m` are counts in this trade and are not
 * here; every entry below is a specification in every context a print shop has.
 */
const SPEC_UNIT = /^\s*(?:gsm|micron|mm|cm|dpi|ppi|lpi)\b/iu;

/**
 * A count, or nothing.
 *
 * Every refusal below is a quantity this would otherwise have got wrong by a
 * factor, on a document a customer reads as the shop's considered answer. The
 * whole function is cheaper than one of those.
 */
export function countOf(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const text = raw.trim();
  if (text === "" || MONEY.test(text) || RANGE.test(text) || FRACTION.test(text)) {
    return null;
  }
  // A leading minus is a deduction or a correction, not a count, and stripping
  // it would turn one into the other.
  if (/^[-\u2013\u2014]/u.test(text)) {
    return null;
  }
  const match = STANDALONE.exec(text);
  if (match === null) {
    return null;
  }
  const token = match[1];
  if (token === undefined) {
    return null;
  }
  // What comes straight after it decides whether it was ever a count.
  if (SPEC_UNIT.test(text.slice(match.index + match[0].length))) {
    return null;
  }
  // A comma has to be grouping. "12,5" is a decimal written the European way,
  // and stripping its comma would read it as 125.
  if (token.includes(",") && !GROUPED.test(token)) {
    return null;
  }
  const digits = token.replace(/,/g, "");
  if (digits.length > 9) {
    return null;
  }
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A count typed into a box that asks for one.
 *
 * Not `countOf`, which digs a number out of a customer's sentence and refuses
 * anything ambiguous. This is the simpler job: somebody is looking at a field
 * labelled "how many" and typing into it, so the only work is accepting the
 * shapes an Indian shop owner actually writes.
 *
 * `Number("1,000")` is `NaN`, and a quantity written with its grouping comma is
 * not a mistake — it is how four figures are written on every invoice pad in
 * the country. Refusing it told the owner their own number was not a whole
 * number above zero.
 *
 * Still no decimals, no ranges and no units: a quotation line is for a count of
 * things, and `quotation_item.quantity` is an INTEGER column.
 *
 * That is a real limit and not only a parser one. A shop selling flex by the
 * running metre or paper by weight has fractional quantities, and this book
 * cannot hold one — the workaround is to quote a count of whatever unit the
 * owner names ("5" × "per 100", or "1" × "2.5 running metres" in the
 * description), which reads correctly on the quotation and does the right
 * arithmetic. Whether that is enough is a question for a shop using it, not one
 * to answer by guessing at a migration.
 */
export function parseCount(input: string): number | null {
  const cleaned = input.replace(/[\s,]/gu, "");
  if (cleaned === "" || !/^\d+$/u.test(cleaned) || cleaned.length > 9) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** One proposed quotation line. A rate is the owner's to add. */
export interface ProposedQuotationLine {
  readonly description: Proposed<string>;
  readonly quantity: Proposed<number>;
}

/**
 * The first line of a quotation, proposed from a reviewed enquiry.
 *
 * One line, not several: the enquiry schema describes one printed product, and
 * inventing a second line from `finish` or `stock` would put a charge on the
 * page that the customer never asked to be billed separately for. Those fields
 * belong in the description or in the owner's head, not in a row with a price
 * beside it.
 */
export function proposeLines(enquiry: EnquirySuggestion): readonly ProposedQuotationLine[] {
  const fields = enquiry.fields;
  const item = fields.item;
  if (item === null || item.trim() === "") {
    return [];
  }

  // The finished size and the stock describe the same product, so they read as
  // part of its name rather than as separate chargeable lines.
  const described = [item, fields.dimensions, fields.stock]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(", ");

  return [
    {
      description: { value: described, from: item },
      quantity:
        fields.quantities === null
          ? { value: null, from: null }
          : {
              value: countOf(fields.quantities),
              from: fields.quantities,
              ...(countOf(fields.quantities) === null
                ? { problem: "This quantity could not be read as a single number. Check and enter it yourself." }
                : {})
            }
    }
  ];
}
