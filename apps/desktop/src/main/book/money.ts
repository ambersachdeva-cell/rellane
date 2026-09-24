/**
 * Money, as integers.
 *
 * Every amount in Rellane is **paise** — an integer — and never a float. This is
 * not fastidiousness. `0.1 + 0.2 !== 0.3` in IEEE-754, and a shop's outstanding
 * balance is a long chain of additions and subtractions across hundreds of bills
 * and part-payments. Floats would make the total drift by a few paise, which is
 * exactly the kind of error that destroys trust in a number the owner cannot
 * check by hand: he does not need to know why it is wrong to stop believing it.
 *
 * Quantities are stored the same way, in thousandths, because a print job is
 * quoted in reams and half-kilos and 2.5 has the same problem 0.1 does.
 *
 * Rendering is Indian by default: two, two, three grouping — ₹3,42,000 and not
 * ₹342,000 — because the owner reads the second one twice and the first one once.
 */

/** 1 rupee = 100 paise. */
export const PAISE_PER_RUPEE = 100;

/** Quantities are stored ×1000, so 2.5 kg is 2500. */
export const MILLI = 1000;

/**
 * Formats paise as rupees, grouped the Indian way.
 *
 * `rupees(34200000)` → "₹3,42,000", or "₹3,42,000.00" with `{ paise: true }`.
 * Stated both ways because the example previously showed the paise form against
 * a default that omits it — so a caller copying it dropped the paise silently.
 * `rupees(34200000, { paise: false })` → "₹3,42,000"
 *
 * Paise are dropped by default in summaries and kept on a document, because a
 * total of "₹3,42,000.00" in a dashboard is noise while a bill that says
 * "₹1,180" when it means "₹1,180.50" is wrong.
 */
export function rupees(paise: number, options: { paise?: boolean } = {}): string {
  const withPaise = options.paise ?? false;
  if (!Number.isFinite(paise)) {
    return "—";
  }

  const negative = paise < 0;
  const whole = Math.trunc(Math.abs(paise) / PAISE_PER_RUPEE);
  const fraction = Math.abs(paise) % PAISE_PER_RUPEE;

  const grouped = groupIndian(whole);
  const body = withPaise ? `${grouped}.${String(fraction).padStart(2, "0")}` : grouped;
  return `${negative ? "−" : ""}₹${body}`;
}

/**
 * Indian digit grouping: the last three digits, then twos.
 *
 * 342000 → "3,42,000". `Intl.NumberFormat("en-IN")` does this correctly, but it
 * is called on every row of a long list and constructing a formatter per call is
 * measurably slower than the arithmetic, so the formatter is built once.
 */
const INDIAN = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0, useGrouping: true });

function groupIndian(whole: number): string {
  return INDIAN.format(whole);
}

/** Parses what a person typed into paise. Returns null when it is not a number. */
export function parseRupees(input: string): number | null {
  /**
   * The Unicode minus is normalised to ASCII first.
   *
   * `rupees()` renders negatives with `−` (U+2212), because that is the correct
   * typographic character — and this regex only ever matched `-`. So the ledger's
   * own output did not survive its own parser: every negative amount, which is
   * to say every credit note and every overpayment, round-tripped to `null`.
   */
  const cleaned = input
    // The ways an amount is written by hand here, beside the symbol.
    //
    // "Rs 450" and "450/-" are not sloppy: they are how a rate is written on
    // every estimate pad in the country, and refusing them told the owner their
    // own handwriting was not a number. `/-` is a terminator, so it only counts
    // at the end; stripping it anywhere would turn a mistyped date into money.
    .replace(/\b(?:rs|inr|rupees?)\b\.?/giu, "")
    .replace(/\/-\s*$/u, "")
    .replace(/[₹,\s]/gu, "")
    .replace(/\u2212/gu, "-")
    .trim();

  /**
   * Two decimals, and a third is refused rather than rounded.
   *
   * The comment here used to claim `12.005` becomes `12.01`, which the regex has
   * always refused — a real contradiction, and the code was right. Money has two
   * decimal places; a third means somebody mistyped, or pasted a quantity into
   * an amount field. On a ledger, surfacing that beats silently altering the
   * number, because a quietly-adjusted amount is what reconciliation disputes
   * are made of.
   */
  if (cleaned.length === 0 || !/^-?\d*(\.\d{0,2})?$/u.test(cleaned) || cleaned === "-") {
    return null;
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }
  // Rounded rather than truncated, for the floating-point residue only:
  // `12.34 * 100` is `1233.9999999999998`, and `Math.trunc` would lose a paisa
  // on amounts that were typed perfectly correctly.
  return ledgerInteger(Math.round(value * PAISE_PER_RUPEE));
}

/**
 * The last gate before a number is money, and it refuses two things.
 *
 * **A signed zero.** `Math.round` carries the sign through, so `-0`, `-0.004`
 * and `−0.00` all arrive here as negative zero. It renders as "0" and compares
 * equal to 0 with `===`, so nothing on screen looks wrong — but
 * `Object.is(-0, 0)` is false, so is a `Map` or `Set` keyed on the amount, and
 * `JSON.stringify(-0)` is `"0"`. The figure changes identity the moment it is
 * written to a backup and read back, and a row that reconciles before a restore
 * and not after is the worst shape this bug could take.
 *
 * **A figure past the safe-integer range.** Multiplying by a hundred costs two
 * digits of precision, so a rupee amount near `MAX_SAFE_INTEGER` comes out of
 * the multiply as something that is no longer the number that went in — and it
 * is still a `number`, still an integer, and still passes every check that only
 * asks those two questions. `null` is the honest answer: this module's rule is
 * that money is an exact integer paise, and a figure that cannot be one is not
 * a figure this book can hold. Refusing is also what the rest of the parser
 * already does with anything it cannot read exactly, rather than storing an
 * approximation nobody was told about.
 *
 * Both were found by fuzzing; neither had a unit test, because both look
 * correct at every size a person would ever type.
 */
export function ledgerInteger(value: number): number | null {
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  return value === 0 ? 0 : value;
}

/** Renders a stored quantity. `quantity(2500)` → "2.5". */
export function quantity(milli: number): string {
  if (!Number.isFinite(milli)) {
    return "—";
  }
  const whole = milli / MILLI;
  // Trailing zeros dropped: "500" reads better than "500.000" on a line item.
  return Number.isInteger(whole) ? String(whole) : String(Number(whole.toFixed(3)));
}

export function parseQuantity(input: string): number | null {
  // Negatives accepted, and the Unicode minus normalised, for the same reason as
  // amounts: a returned item and a stock correction are both negative
  // quantities, and `quantity()` will happily render them.
  const cleaned = input.replace(/[,\s]/gu, "").replace(/\u2212/gu, "-").trim();
  if (cleaned.length === 0 || !/^-?\d*(\.\d*)?$/u.test(cleaned) || cleaned === "-") {
    return null;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? ledgerInteger(Math.round(value * MILLI)) : null;
}

/**
 * Tax rates are basis points: 18% is 1800.
 *
 * Integers again, and for the same reason — GST rates are multiplied against
 * amounts and the result is money.
 */
export function taxOf(amountPaise: number, rateBasisPoints: number): number {
  return Math.round((amountPaise * rateBasisPoints) / 10_000);
}

/** "18%" from 1800. */
export function taxRate(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}
