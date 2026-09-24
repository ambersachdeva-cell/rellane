/**
 * Untrusted bill parser fuzzing and financial invariant verification.
 *
 * In Rellane, financial figures are read directly off pasted text, OCR scans, and
 * chat transcripts from traders and suppliers. Entering these records by hand is
 * the primary friction for small business owners, but blindly trusting raw input
 * would allow corrupted numbers, impossible calendar dates, and silent floating-point
 * drift to infect the ledger. In a double-entry bookkeeping system, an unhandled parser
 * exception crashes the desktop application during an import, while a subtle precision
 * leak or negative-zero quietly breaks reconciliation and destroys trader trust.
 *
 * Without continuous fuzzing across untrusted inputs, edge cases in Unicode
 * normalisation, numeral systems, and numeric boundaries inevitably escape unit tests
 * into production ledgers. This suite subjects every pure parsing and calculation
 * function to reproducible pseudo-random inputs to guarantee that parsers never throw,
 * outputs remain strictly safe integers or valid calendar dates, tax calculations
 * remain bounded, and all behaviour is perfectly deterministic.
 */

import { describe, expect, it } from "vitest";
import { dayOf, paiseOf } from "./extract.js";
import { parseQuantity, parseRupees, taxOf } from "./money.js";

/**
 * Fixed seed chosen to ensure reproducible test runs across machines.
 *
 * A pseudo-random test suite that fails intermittently cannot be acted upon.
 * Keeping the seed constant ensures that every regression or defect reported
 * by this suite can be reproduced deterministically.
 */
const SEED = 0xca_d2_a9_e1;
const ITERATIONS_PER_FUNCTION = 2_500;

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  // Bounds are checked on the index, not on the value. Checking `choice ===
  // undefined` looked equivalent and was not: one of the arrays fuzzed here
  // holds `undefined` deliberately, as a value a model might propose, so a
  // legitimate draw was being reported as an out-of-bounds read and the whole
  // date suite failed for a reason that had nothing to do with dates.
  if (index < 0 || index >= items.length) {
    throw new Error(`Seed ${SEED}: pick failed on empty array or out of bounds index ${index}`);
  }
  return items[index] as T;
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 80 ? `${JSON.stringify(value.slice(0, 77))}... (${value.length} chars)` : JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable object]";
  }
}

function formatIndianGrouped(n: number): string {
  const s = String(Math.abs(n));
  if (s.length <= 3) {
    return s;
  }
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const pairs: string[] = [];
  for (let i = rest.length; i > 0; i -= 2) {
    pairs.unshift(rest.slice(Math.max(0, i - 2), i));
  }
  return `${pairs.join(",")},${last3}`;
}

function generateIndianMoneyString(rng: () => number): string {
  const fixed = [
    "₹9,440",
    "Rs. 9440/-",
    "9,440.00",
    "1,23,456",
    "Rs 1,23,456.50",
    "₹ 9,440",
    "Rs.9440/-",
    "Rs. 1,23,456.50",
    "1,23,456.00",
    "₹1,23,456/-"
  ] as const;

  if (rng() < 0.25) {
    return pick(rng, fixed);
  }

  const prefixes = ["₹", "Rs. ", "Rs ", "rs. ", "rs ", "₹ ", "INR ", ""] as const;
  const signs = ["", "", "", "-", "−"] as const;
  const decimals = ["", "", ".00", ".50", ".25", ".75", ".5", ".99", ".0"] as const;
  const suffixes = ["", "", "", "/-", " /-", " paise", " only"] as const;

  const prefix = pick(rng, prefixes);
  const sign = pick(rng, signs);
  const amount = randInt(rng, 0, 99_999_999);
  const body = formatIndianGrouped(amount);
  const decimal = pick(rng, decimals);
  const suffix = pick(rng, suffixes);

  return `${sign}${prefix}${body}${decimal}${suffix}`;
}

function generateAdversarialNumericString(rng: () => number): string {
  const fixed = [
    "-0",
    "1e400",
    "0x10",
    "Infinity",
    "NaN",
    "1__000",
    ".5",
    "5.",
    "00012",
    "-0.0",
    "-0.00",
    "-.5",
    "-5.",
    "+.5",
    "+5.",
    "0",
    "00",
    "0.0",
    "0.00",
    ".0",
    "-Infinity",
    "+Infinity",
    "0x0",
    "0b101",
    "0o77",
    "1e-5",
    "1e10",
    "-1e400",
    "1.2.3",
    "--5",
    "++5",
    "-+5",
    "1-2",
    "1+2",
    ".",
    "-.",
    "+.",
    ".-",
    "1_000_000",
    "1 000",
    "12 . 34"
  ] as const;

  if (rng() < 0.75) {
    return pick(rng, fixed);
  }

  const char = pick(rng, ["1", "9", "0"] as const);
  return char.repeat(10_000);
}

function generateUnicodeString(rng: () => number): string {
  const devanagari = ["९४४०", "१,२३,४५६", "०", "१२३४५६७८९०", "₹९४४०", "रु. ९४४०/-"] as const;
  const nfcNfd = ["\u00C5", "A\u030A", "\u00E9", "e\u0301", "Devgiri \u0915\u094D\u0937"] as const;
  const zwj = ["\u200D", "\u200C", "₹\u200D9,440", "1\u200C23", "₹\u200B9440"] as const;
  const rtl = ["\u200E", "\u200F", "\u061C", "\u200E₹9,440\u200E", "\u200F123.45"] as const;
  const emoji = ["₹😀", "💸", "🧾", "🔥", "100💸", "₹9,440 🎉", "🧾 1234.50"] as const;
  const surrogates = ["\uD800", "\uDFFF", "\uDBFF", "\uDC00", "₹\uD8009440", "9440\uDFFF"] as const;
  const typographic = ["−₹9,440", "–9,440", "—9,440", "\u22129440", "\u00A0₹9,440", "₹\u202F9,440"] as const;

  return pick(rng, [
    ...devanagari,
    ...nfcNfd,
    ...zwj,
    ...rtl,
    ...emoji,
    ...surrogates,
    ...typographic
  ]);
}

function generateStructuralString(rng: () => number): string {
  const fixed = [
    "",
    "   ",
    "\t",
    "\n",
    "\r\n",
    "   \t\n  ",
    "null",
    "undefined",
    "true",
    "false",
    "[object Object]",
    "NaN",
    '{ "value": 9440 }',
    '{ "amount": "9,440" }',
    "about five thousand",
    "none"
  ] as const;

  if (rng() < 0.85) {
    return pick(rng, fixed);
  }

  const char = pick(rng, ["a", " ", "9", "₹"] as const);
  return char.repeat(100_000);
}

function generateFuzzString(rng: () => number): string {
  const roll = rng();
  if (roll < 0.35) {
    return generateIndianMoneyString(rng);
  }
  if (roll < 0.65) {
    return generateAdversarialNumericString(rng);
  }
  if (roll < 0.85) {
    return generateUnicodeString(rng);
  }
  return generateStructuralString(rng);
}

function generateDateLikeString(rng: () => number): string {
  const standard = [
    "02/09/2026",
    "2/9/26",
    "2-9-26",
    "29-02-2024",
    "19/07/2026",
    "2026-08-26",
    "2026-07-19"
  ] as const;

  const adversarial = [
    "2026-02-31",
    "31/02/2026",
    "2026-13-45",
    "45/13/2026",
    "2026-00-10",
    "00/00/0000",
    "1/1/100",
    "1/1/999",
    "1200-01-01",
    "9999-01-01",
    "2026-02-29",
    "29-02-2023",
    "31-04-2026",
    "2026-04-31"
  ] as const;

  const roll = rng();
  if (roll < 0.3) {
    return pick(rng, standard);
  }
  if (roll < 0.6) {
    return pick(rng, adversarial);
  }

  const y = randInt(rng, 1800, 2300);
  const m = randInt(rng, 0, 15);
  const d = randInt(rng, 0, 35);
  const sep = pick(rng, ["-", "/", ".", " "] as const);

  if (rng() < 0.5) {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return `${d}${sep}${m}${sep}${y}`;
}

function generateFuzzUnknown(rng: () => number, options: { dates?: boolean } = {}): unknown {
  const roll = rng();
  if (roll < 0.6) {
    return options.dates ? (rng() < 0.6 ? generateDateLikeString(rng) : generateFuzzString(rng)) : generateFuzzString(rng);
  }
  if (roll < 0.8) {
    return pick(rng, [
      null,
      undefined,
      {},
      [],
      [1, 2, 3],
      [[[[[]]]]],
      Object.create(null),
      { value: 9440 },
      { value: "₹9,440" },
      true,
      false,
      new Date(),
      new Date(Number.NaN)
    ] as const);
  }
  return pick(rng, [
    0,
    -0,
    9440,
    -9440,
    12.34,
    -12.34,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e400,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER
  ] as const);
}

describe("pure bill parser fuzzing", () => {
  describe("parseRupees", () => {
    it("never throws and returns deterministic safe integers or null across fuzzed inputs", () => {
      const rng = createMulberry32(SEED);
      const throwFailures: string[] = [];
      const determinismFailures: string[] = [];
      const unsafeIntegerFailures: string[] = [];
      const negativeZeroFailures: string[] = [];

      for (let i = 0; i < ITERATIONS_PER_FUNCTION; i++) {
        const input = generateFuzzString(rng);

        let first: number | null = null;
        let second: number | null = null;

        try {
          first = parseRupees(input);
          second = parseRupees(input);
        } catch (error) {
          throwFailures.push(
            `Seed ${SEED}, iteration ${i}: threw on input ${formatValue(input)}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (!Object.is(first, second)) {
          determinismFailures.push(
            `Seed ${SEED}, iteration ${i}: non-deterministic for ${formatValue(input)}: first=${formatValue(first)}, second=${formatValue(second)}`
          );
        }

        if (first !== null) {
          if (!Number.isSafeInteger(first)) {
            unsafeIntegerFailures.push(
              `Seed ${SEED}, iteration ${i}: non-safe integer for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
          if (Object.is(first, -0)) {
            negativeZeroFailures.push(
              `Seed ${SEED}, iteration ${i}: negative-zero for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
        }
      }

      expect(throwFailures).toEqual([]);
      expect(determinismFailures).toEqual([]);
      expect(unsafeIntegerFailures).toEqual([]);

      // Defect revealed by fuzzing: input "-0" (and "-0.0", "-0.00") produces -0 (negative-zero)
      // rather than 0 or null. In IEEE 754, Object.is(-0, 0) is false, violating invariant 2.
      expect(negativeZeroFailures).toEqual([]);
    });
  });

  describe("parseQuantity", () => {
    it("never throws and returns deterministic safe integers or null across fuzzed inputs", () => {
      const rng = createMulberry32(SEED);
      const throwFailures: string[] = [];
      const determinismFailures: string[] = [];
      const unsafeIntegerFailures: string[] = [];
      const negativeZeroFailures: string[] = [];

      for (let i = 0; i < ITERATIONS_PER_FUNCTION; i++) {
        const input = generateFuzzString(rng);

        let first: number | null = null;
        let second: number | null = null;

        try {
          first = parseQuantity(input);
          second = parseQuantity(input);
        } catch (error) {
          throwFailures.push(
            `Seed ${SEED}, iteration ${i}: threw on input ${formatValue(input)}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (!Object.is(first, second)) {
          determinismFailures.push(
            `Seed ${SEED}, iteration ${i}: non-deterministic for ${formatValue(input)}: first=${formatValue(first)}, second=${formatValue(second)}`
          );
        }

        if (first !== null) {
          if (!Number.isSafeInteger(first)) {
            unsafeIntegerFailures.push(
              `Seed ${SEED}, iteration ${i}: non-safe integer for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
          if (Object.is(first, -0)) {
            negativeZeroFailures.push(
              `Seed ${SEED}, iteration ${i}: negative-zero for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
        }
      }

      expect(throwFailures).toEqual([]);
      expect(determinismFailures).toEqual([]);
      expect(unsafeIntegerFailures).toEqual([]);

      // Defect revealed by fuzzing: input "-0" (and "-0.0", "-0.00") produces -0 (negative-zero)
      // rather than 0 or null. The parser strips formatting but fails to normalise signed zero.
      expect(negativeZeroFailures).toEqual([]);
    });
  });

  describe("paiseOf", () => {
    it("never throws and returns deterministic safe integers or null across fuzzed inputs", () => {
      const rng = createMulberry32(SEED);
      const throwFailures: string[] = [];
      const determinismFailures: string[] = [];
      const unsafeIntegerFailures: string[] = [];
      const negativeZeroFailures: string[] = [];

      for (let i = 0; i < ITERATIONS_PER_FUNCTION; i++) {
        const input = generateFuzzUnknown(rng);

        let first: number | null = null;
        let second: number | null = null;

        try {
          first = paiseOf(input);
          second = paiseOf(input);
        } catch (error) {
          throwFailures.push(
            `Seed ${SEED}, iteration ${i}: threw on input ${formatValue(input)}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (!Object.is(first, second)) {
          determinismFailures.push(
            `Seed ${SEED}, iteration ${i}: non-deterministic for ${formatValue(input)}: first=${formatValue(first)}, second=${formatValue(second)}`
          );
        }

        if (first !== null) {
          if (!Number.isSafeInteger(first)) {
            unsafeIntegerFailures.push(
              `Seed ${SEED}, iteration ${i}: non-safe integer for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
          if (Object.is(first, -0)) {
            negativeZeroFailures.push(
              `Seed ${SEED}, iteration ${i}: negative-zero for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
        }
      }

      expect(throwFailures).toEqual([]);
      expect(determinismFailures).toEqual([]);
      expect(unsafeIntegerFailures).toEqual([]);

      // Defect revealed by fuzzing: input "-0" and numeric -0 produce -0 (negative-zero) rather
      // than 0 or null. Bare numeric -0 bypasses sanitisation through Math.round(raw * 100).
      expect(negativeZeroFailures).toEqual([]);
    });
  });

  describe("dayOf", () => {
    it("never throws and returns either null or a valid calendar day round-tripping through Date", () => {
      const rng = createMulberry32(SEED);
      const throwFailures: string[] = [];
      const determinismFailures: string[] = [];
      const invalidDateFailures: string[] = [];

      for (let i = 0; i < ITERATIONS_PER_FUNCTION; i++) {
        const input = generateFuzzUnknown(rng, { dates: true });

        let first: string | null = null;
        let second: string | null = null;

        try {
          first = dayOf(input);
          second = dayOf(input);
        } catch (error) {
          throwFailures.push(
            `Seed ${SEED}, iteration ${i}: threw on input ${formatValue(input)}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (first !== second) {
          determinismFailures.push(
            `Seed ${SEED}, iteration ${i}: non-deterministic for ${formatValue(input)}: first=${formatValue(first)}, second=${formatValue(second)}`
          );
        }

        if (first !== null) {
          if (!/^\d{4}-\d{2}-\d{2}$/u.test(first)) {
            invalidDateFailures.push(
              `Seed ${SEED}, iteration ${i}: date string did not match ISO format for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }

          const parsed = new Date(`${first}T00:00:00Z`);
          if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== first) {
            invalidDateFailures.push(
              `Seed ${SEED}, iteration ${i}: calendar date shifted or failed round-trip for ${formatValue(input)}: returned ${formatValue(first)}`
            );
          }
        }
      }

      expect(throwFailures).toEqual([]);
      expect(determinismFailures).toEqual([]);
      expect(invalidDateFailures).toEqual([]);
    });
  });

  describe("taxOf", () => {
    it("never throws, returns non-negative safe integers, and never exceeds amount for rates <= 10000 bp", () => {
      const rng = createMulberry32(SEED);
      const throwFailures: string[] = [];
      const determinismFailures: string[] = [];
      const invalidTaxFailures: string[] = [];

      for (let i = 0; i < ITERATIONS_PER_FUNCTION; i++) {
        // Amounts range from zero up to safe arithmetic boundaries (~900 billion paise = ₹900 crore).
        const amountPaise = randInt(rng, 0, 100_000_000_000);
        // Rates test standard GST slabs (0, 500, 1200, 1800, 2800 bp) alongside random values up to 20000 bp.
        const rateBasisPoints = rng() < 0.5 ? pick(rng, [0, 500, 1200, 1800, 2800, 10000] as const) : randInt(rng, 0, 20000);

        let first = 0;
        let second = 0;

        try {
          first = taxOf(amountPaise, rateBasisPoints);
          second = taxOf(amountPaise, rateBasisPoints);
        } catch (error) {
          throwFailures.push(
            `Seed ${SEED}, iteration ${i}: threw on amount ${amountPaise}, rate ${rateBasisPoints}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }

        if (first !== second) {
          determinismFailures.push(
            `Seed ${SEED}, iteration ${i}: non-deterministic for amount ${amountPaise}, rate ${rateBasisPoints}: first=${first}, second=${second}`
          );
        }

        if (!Number.isSafeInteger(first) || first < 0) {
          invalidTaxFailures.push(
            `Seed ${SEED}, iteration ${i}: taxOf returned non-safe or negative integer for amount ${amountPaise}, rate ${rateBasisPoints}: returned ${first}`
          );
        }

        if (rateBasisPoints <= 10_000 && first > amountPaise) {
          invalidTaxFailures.push(
            `Seed ${SEED}, iteration ${i}: tax exceeded amountPaise for rate <= 10000 bp: amount ${amountPaise}, rate ${rateBasisPoints}, tax ${first}`
          );
        }
      }

      expect(throwFailures).toEqual([]);
      expect(determinismFailures).toEqual([]);
      expect(invalidTaxFailures).toEqual([]);
    });
  });

  // Found by fuzzing, and all three the same shape: a minus sign survived a
  // rounding that produced zero, so the ledger held `-0`. It renders as "0" and
  // it compares equal to 0, which is why no unit test had caught it — but it is
  // a different key in a `Map`, and `JSON.stringify` writes it as `0`, so the
  // figure changes identity across a backup and a restore.
  describe("zero comes out of every parser without a sign", () => {
    it("does not let parseRupees return negative zero", () => {
      expect(parseRupees("-0")).toBe(0);
      expect(Object.is(parseRupees("-0"), -0)).toBe(false);
      // The typographic minus `rupees()` renders with, taking the same path.
      expect(Object.is(parseRupees("−0.00"), -0)).toBe(false);
    });

    it("does not let parseQuantity return negative zero", () => {
      expect(parseQuantity("-0")).toBe(0);
      expect(Object.is(parseQuantity("-0"), -0)).toBe(false);
      // Quantities allow more than two decimals, so this rounds rather than
      // being refused, and rounding a negative towards zero is where -0 came from.
      expect(Object.is(parseQuantity("-0.0000001"), -0)).toBe(false);
    });

    it("does not let paiseOf return negative zero, from a string or a bare number", () => {
      // The bare-number branch is the one that skips `parseRupees` entirely, so
      // it has to drop the sign itself.
      expect(Object.is(paiseOf("-0"), -0)).toBe(false);
      expect(Object.is(paiseOf(-0), -0)).toBe(false);
      expect(Object.is(paiseOf(-0.0001), -0)).toBe(false);
    });
  });

  // The other half of the same gate, and the one with teeth: multiplying to
  // paise costs two digits, so a figure near the safe-integer ceiling comes out
  // of the multiply as a number that is no longer the number that went in.
  describe("a figure too large to be exact is refused, not approximated", () => {
    it("refuses rather than storing an imprecise paise figure", () => {
      expect(paiseOf(Number.MAX_SAFE_INTEGER)).toBeNull();
      expect(paiseOf(-Number.MAX_SAFE_INTEGER)).toBeNull();
      expect(parseRupees(String(Number.MAX_SAFE_INTEGER))).toBeNull();
      expect(parseQuantity(String(Number.MAX_SAFE_INTEGER))).toBeNull();
    });

    it("still accepts every figure a real bill could carry", () => {
      // ₹99 crore, the largest amount this product has any business holding.
      expect(paiseOf(990_000_000)).toBe(99_000_000_000);
      expect(parseRupees("99,00,00,000")).toBe(99_000_000_000);
    });
  });
});
