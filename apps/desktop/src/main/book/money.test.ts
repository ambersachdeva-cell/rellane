import { describe, expect, it } from "vitest";
import { parseQuantity, parseRupees, quantity, rupees, taxOf, taxRate } from "./money.js";

describe("rupees on the screen", () => {
  it("groups the Indian way", () => {
    // ₹3,42,000 is read once. ₹342,000 is read twice by the person it belongs to.
    expect(rupees(34_200_000)).toBe("₹3,42,000");
    expect(rupees(100_000)).toBe("₹1,000");
    expect(rupees(1_00_00_00_000)).toBe("₹1,00,00,000");
  });

  it("drops paise in summaries and keeps them on a document", () => {
    expect(rupees(118_050)).toBe("₹1,180");
    expect(rupees(118_050, { paise: true })).toBe("₹1,180.50");
  });

  it("pads a single paisa rather than printing ₹12.5", () => {
    expect(rupees(1205, { paise: true })).toBe("₹12.05");
  });

  it("uses a minus sign for money going the other way", () => {
    expect(rupees(-50_000)).toBe("−₹500");
  });

  it("says it does not know rather than printing NaN", () => {
    expect(rupees(Number.NaN)).toBe("—");
  });

  it("shows zero as zero", () => {
    expect(rupees(0)).toBe("₹0");
  });
});

describe("what a person types", () => {
  it("reads plain rupees", () => {
    expect(parseRupees("1000")).toBe(100_000);
  });

  it("reads what they pasted off a bill, symbols and all", () => {
    expect(parseRupees("₹3,42,000")).toBe(34_200_000);
    expect(parseRupees(" 1,180.50 ")).toBe(118_050);
  });

  it("rounds the paisa a person meant rather than losing it", () => {
    // Math.trunc would make 12.005 into ₹12.00 and quietly drop half a paisa
    // on every line of a long bill.
    expect(parseRupees("12.01")).toBe(1201);
  });

  it("refuses what is not a number, rather than guessing zero", () => {
    // Guessing zero here would silently write a bill for nothing.
    expect(parseRupees("")).toBeNull();
    expect(parseRupees("about five thousand")).toBeNull();
    expect(parseRupees("12.345")).toBeNull();
  });
});

describe("quantities", () => {
  it("shows a whole number as whole", () => {
    expect(quantity(500_000)).toBe("500");
  });

  it("keeps a half", () => {
    expect(quantity(2500)).toBe("2.5");
  });

  it("reads what a person types", () => {
    expect(parseQuantity("2.5")).toBe(2500);
    expect(parseQuantity("1,000")).toBe(1_000_000);
    expect(parseQuantity("nope")).toBeNull();
  });
});

describe("tax", () => {
  it("computes GST from basis points", () => {
    // 18% of ₹1,000
    expect(taxOf(100_000, 1800)).toBe(18_000);
  });

  it("rounds to the paisa rather than carrying a fraction", () => {
    expect(taxOf(101, 1800)).toBe(18);
  });

  it("reads a rate back as a person writes it", () => {
    expect(taxRate(1800)).toBe("18%");
    expect(taxRate(500)).toBe("5%");
    expect(taxRate(1250)).toBe("12.5%");
  });
});

describe("what this ledger renders, it must be able to read back", () => {
  it("round-trips a negative amount", () => {
    // `rupees` renders negatives with the typographic minus `−` (U+2212) and
    // `parseRupees` only ever matched ASCII `-`. So the ledger's own output did
    // not survive its own parser: every credit note and overpayment parsed to
    // null.
    const rendered = rupees(-50_000);

    expect(rendered).toContain("\u2212");
    expect(parseRupees(rendered)).toBe(-50_000);
  });

  it("round-trips a negative quantity", () => {
    // A returned item and a stock correction are both negative quantities.
    expect(parseQuantity(quantity(-2_500))).toBe(-2_500);
  });

  it("refuses a third decimal rather than rounding it", () => {
    // A comment here claimed `12.005` becomes `12.01`, which the code has always
    // refused. The code is right: money has two decimals, a third means a typo
    // or a quantity pasted into an amount field, and quietly adjusting somebody's
    // amount is what reconciliation disputes are made of. The comment was fixed.
    expect(parseRupees("12.005")).toBeNull();
    expect(parseRupees("12.34")).toBe(1_234);
  });

  it("still refuses things that are not amounts", () => {
    // Loosening the decimals must not loosen anything else.
    for (const bad of ["", "-", "abc", "1.2.3", "--5", "1-2"]) {
      expect(parseRupees(bad)).toBeNull();
    }
  });
});

describe("an amount written by hand", () => {
  it("takes the words people write instead of the symbol", () => {
    // "Rs 450" is not sloppy: it is how a rate is written on every estimate pad
    // in the country, and refusing it told the owner their own handwriting was
    // not a number.
    expect(parseRupees("Rs 450")).toBe(45_000);
    expect(parseRupees("rs.450")).toBe(45_000);
    expect(parseRupees("INR 4.50")).toBe(450);
    expect(parseRupees("450 rupees")).toBe(45_000);
  });

  it("takes the trailing dash that means 'and no paise'", () => {
    expect(parseRupees("450/-")).toBe(45_000);
    expect(parseRupees("₹1,250/-")).toBe(125_000);
  });

  it("only takes that dash at the end, so a mistyped date is not money", () => {
    expect(parseRupees("12/-/2026")).toBeNull();
    expect(parseRupees("12/-3")).toBeNull();
  });

  it("still refuses what is not an amount", () => {
    for (const said of ["", "rs", "abc", "4.505", "-", "1-2"]) {
      expect(parseRupees(said)).toBeNull();
    }
  });
});
