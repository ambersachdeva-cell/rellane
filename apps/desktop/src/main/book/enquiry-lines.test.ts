/**
 * Proposing a quotation's first line from a reviewed enquiry.
 *
 * Most of this file guards the quantity parser, and every case in it is a
 * quantity an earlier version got wrong by a factor — on a document a customer
 * reads as the shop's considered answer.
 */
import { describe, expect, it } from "vitest";
import type { EnquirySuggestion } from "@cadrane/contracts";
import { countOf, parseCount, proposeLines } from "./enquiry-lines.js";

function enquiry(over: Partial<EnquirySuggestion["fields"]> = {}): EnquirySuggestion {
  return {
    scope: "one_job",
    fields: {
      item: null,
      quantities: null,
      dimensions: null,
      printing: null,
      stock: null,
      finish: null,
      fulfilment: null,
      timing: null,
      destination: null,
      artwork: null,
      invoice: null,
      changes: null,
      other: null,
      ...over
    }
  } as EnquirySuggestion;
}

describe("reading a count", () => {
  it("reads a plain number and Indian grouping", () => {
    expect(countOf("500")).toBe(500);
    expect(countOf("1,000")).toBe(1000);
    expect(countOf("1,00,000 pcs")).toBe(100000);
  });

  it("refuses money, because a budget is not a quantity", () => {
    // An earlier version read "₹12,000" as a count of twelve thousand, which
    // would have multiplied a rate by a budget.
    expect(countOf("₹12,000 budget")).toBeNull();
    expect(countOf("Rs 5000")).toBeNull();
    expect(countOf("2 lakh")).toBeNull();
  });

  it("refuses a range, because neither end is ours to choose", () => {
    expect(countOf("500-600")).toBeNull();
    expect(countOf("500 to 600")).toBeNull();
    expect(countOf("500 – 600")).toBeNull();
    expect(countOf("500—600")).toBeNull();
    expect(countOf("500~600")).toBeNull();
  });

  it("refuses a figure glued to letters", () => {
    // "A4, 500 copies" read as 4; "100gsm bond" read as 100.
    expect(countOf("A4, 500 copies")).toBe(500);
    expect(countOf("100gsm bond")).toBeNull();
    expect(countOf("A4")).toBeNull();
  });

  it("refuses every shape of decimal", () => {
    // "12.5 kg" read as 5 by backtracking past the point; ".5" had no leading
    // digit for the first guard to see; "12,5" lost its comma to the grouping
    // strip and became 125.
    expect(countOf("12.5 kg")).toBeNull();
    expect(countOf(".5 reams")).toBeNull();
    expect(countOf("12,5")).toBeNull();
  });

  it("refuses a negative, nothing, zero and the absurd", () => {
    expect(countOf("-50")).toBeNull();
    expect(countOf("")).toBeNull();
    expect(countOf("some")).toBeNull();
    expect(countOf("0")).toBeNull();
    expect(countOf("1234567890123")).toBeNull();
    expect(countOf(null)).toBeNull();
    expect(countOf(42)).toBeNull();
  });
});

describe("proposing the line", () => {
  it("names the product and reads how many", () => {
    const [line] = proposeLines(
      enquiry({ item: "visiting cards", quantities: "500" })
    );
    expect(line?.description.value).toBe("visiting cards");
    expect(line?.quantity.value).toBe(500);
    expect(line?.quantity.from).toBe("500");
  });

  it("folds the size and the paper into the product's name", () => {
    // They describe the same thing. A separate row for "300gsm" would put a
    // charge on the page the customer never asked to be billed for.
    const [line] = proposeLines(
      enquiry({ item: "visiting cards", dimensions: "90x54mm", stock: "300gsm art card", quantities: "500" })
    );
    expect(line?.description.value).toBe("visiting cards, 90x54mm, 300gsm art card");
    expect(proposeLines(enquiry({ item: "cards", finish: "matte lamination" }))).toHaveLength(1);
  });

  it("proposes one line, never one per field", () => {
    const lines = proposeLines(
      enquiry({
        item: "flyers",
        quantities: "1,000",
        finish: "matte lamination",
        printing: "both sides colour",
        fulfilment: "delivery"
      })
    );
    expect(lines).toHaveLength(1);
  });

  it("keeps the line when the quantity cannot be read, and says why", () => {
    // The owner types one number instead of the whole row.
    const [line] = proposeLines(enquiry({ item: "banners", quantities: "500 to 600" }));
    expect(line?.description.value).toBe("banners");
    expect(line?.quantity.value).toBeNull();
    expect(line?.quantity.from).toBe("500 to 600");
    expect(line?.quantity.problem).toMatch(/could not be read as a single number/);
  });

  it("leaves the quantity unresolved rather than guessing when none was stated", () => {
    const [line] = proposeLines(enquiry({ item: "letterheads" }));
    expect(line?.quantity.value).toBeNull();
    expect(line?.quantity.from).toBeNull();
    expect(line?.quantity.problem).toBeUndefined();
  });

  it("proposes nothing when no product was identified", () => {
    expect(proposeLines(enquiry({ quantities: "500" }))).toHaveLength(0);
    expect(proposeLines(enquiry({ item: "   ", quantities: "500" }))).toHaveLength(0);
  });

  it("never produces a rate, because nothing upstream may propose one", () => {
    const [line] = proposeLines(
      enquiry({ item: "cards", quantities: "500", other: "budget is ₹5000" })
    );
    expect(Object.keys(line ?? {})).toEqual(["description", "quantity"]);
  });
});

describe("a specification is not a count", () => {
  it("refuses the paper weight", () => {
    // The one that actually turned up: a print enquiry nearly always carries a
    // gsm, so a quantity field holding it is a misread that would quote 300
    // cards against an order for 500.
    expect(countOf("300 gsm")).toBeNull();
    expect(countOf("300 gsm matte")).toBeNull();
    expect(countOf("130 GSM art paper")).toBeNull();
  });

  it("refuses a size and a resolution", () => {
    expect(countOf("90 mm")).toBeNull();
    expect(countOf("21 cm")).toBeNull();
    expect(countOf("1200 dpi")).toBeNull();
  });

  it("still counts things measured in feet and metres", () => {
    // Flex is sold by the square foot and banners by the metre. A guard that
    // took those too would refuse the quantity on half this trade's work.
    expect(countOf("50 ft")).toBe(50);
    expect(countOf("12 m")).toBe(12);
    expect(countOf("8 sq ft")).toBe(8);
  });

  it("does not let a size later in the line refuse the count in front of it", () => {
    // The check reads what follows the matched figure, not the whole string.
    expect(countOf("500 cards 90x54mm")).toBe(500);
    expect(countOf("1000 stickers, 50 mm round")).toBe(1000);
  });
});

describe("a count typed into a box that asks for one", () => {
  it("takes a grouping comma, because that is how four figures are written", () => {
    // `Number("1,000")` is NaN, so an owner typing their own number the way
    // every invoice pad in the country writes it was told it was not a whole
    // number above zero.
    expect(parseCount("1,000")).toBe(1000);
    expect(parseCount("1,00,000")).toBe(100000);
    expect(parseCount(" 500 ")).toBe(500);
  });

  it("still refuses what is not a count", () => {
    // A quotation line is for a count of things. "2.5 kg" and "1 rim" are
    // descriptions and belong where the customer can read them.
    for (const said of ["", "  ", "0", "-5", "2.5", "1 rim", "500 pcs", "5-10", "abc"]) {
      expect(parseCount(said)).toBeNull();
    }
  });

  it("refuses a number too big to be a print run", () => {
    expect(parseCount("1234567890")).toBeNull();
  });
});
