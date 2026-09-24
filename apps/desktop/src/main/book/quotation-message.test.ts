/**
 * The only text in this product that ends up in somebody else's hands.
 *
 * These tests are mostly about what the message must *not* say. A figure it
 * invents, a greeting it fakes, or a tax line on a shop that charges none are
 * all things a customer reads as the shop's own words.
 */
import { describe, expect, it } from "vitest";
import type { Deal } from "@cadrane/contracts";
import { quotationMessage } from "./quotation-message.js";

const SHOP = { name: "Sachdeva Printers" };

function deal(over: Partial<Deal> = {}, quote: Partial<NonNullable<Deal["quotation"]>> | null = {}): Deal {
  const lines = quote?.lines ?? [
    {
      id: "l1",
      position: 1,
      description: "Letterheads, A4, 100gsm bond",
      quantity: 1000,
      unit: null,
      unitPricePaise: 450,
      linePaise: 450_000
    }
  ];
  const netPaise = lines.reduce((sum, line) => sum + line.linePaise, 0);
  return {
    enquiryId: "e1",
    channel: "whatsapp",
    receivedAt: 0,
    rawText: "need letterheads",
    partyId: "p1",
    partyName: "Sharma Printers",
    triage: "unsorted",
    quotation:
      quote === null
        ? null
        : {
            quotationId: "q1",
            state: "draft",
            gstRateBp: null,
            draftedAt: 0,
            sentAt: null,
            closedAt: null,
            closedReason: null,
            lines,
            netPaise,
            totalPaise: netPaise,
            ...quote
          },
    ...over
  } as Deal;
}

describe("what the customer reads", () => {
  it("names them, and shows every line's arithmetic", () => {
    const text = quotationMessage(deal(), SHOP)!;
    expect(text).toContain("Quotation for Sharma Printers");
    expect(text).toContain("Letterheads, A4, 100gsm bond — 1000 × ₹4.50 = ₹4,500.00");
    expect(text).toContain("Total: ₹4,500.00");
    expect(text.trimEnd().endsWith("Sachdeva Printers")).toBe(true);
  });

  it("does not fake a relationship when the sender is unknown", () => {
    // "Dear Customer" is worse than no greeting: it tells the reader they are a
    // row in somebody's system.
    const text = quotationMessage(deal({ partyName: null }), SHOP)!;
    expect(text.startsWith("Quotation\n")).toBe(true);
    expect(text).not.toMatch(/Dear|Customer,/);
  });

  it("shows tax only when a rate was actually recorded", () => {
    // "GST 0%" on a shop that does not charge it is a claim about their
    // registration that nothing here is entitled to make.
    expect(quotationMessage(deal(), SHOP)!).not.toContain("GST");

    const taxed = quotationMessage(
      deal({}, { gstRateBp: 1800, totalPaise: 450_000 + Math.round((450_000 * 1800) / 10_000) }),
      SHOP
    )!;
    expect(taxed).toContain("GST 18%");
    expect(taxed).toContain("Before tax: ₹4,500.00");
    expect(taxed).toContain("Total: ₹5,310.00");
  });

  it("carries the unit when there is one", () => {
    const text = quotationMessage(
      deal({}, {
        lines: [
          { id: "l1", position: 1, description: "Banner", quantity: 2, unit: "sqft", unitPricePaise: 12_000, linePaise: 24_000 }
        ],
        netPaise: 24_000,
        totalPaise: 24_000
      }),
      SHOP
    )!;
    expect(text).toContain("Banner — 2 sqft × ₹120.00 = ₹240.00");
  });

  it("refuses to compose a quotation with nothing on it", () => {
    // An empty quotation is not a short message, it is a mistake, and sending
    // one costs the shop more than sending nothing.
    expect(quotationMessage(deal({}, { lines: [], netPaise: 0, totalPaise: 0 }), SHOP)).toBeNull();
    expect(quotationMessage(deal({}, null), SHOP)).toBeNull();
  });

  it("leaves the signature off rather than signing with a blank", () => {
    const text = quotationMessage(deal(), { name: "   " })!;
    expect(text.trimEnd().endsWith("₹4,500.00")).toBe(true);
  });

  it("treats a recorded rate of zero as no tax at all", () => {
    // A zero rate says the same thing as no rate: the shop is not charging tax.
    // The first version checked `!== null` and printed "GST 0%: ₹0.00", which
    // is a claim about their registration.
    const text = quotationMessage(deal({}, { gstRateBp: 0 }), SHOP)!;
    expect(text).not.toContain("GST");
    expect(text).not.toContain("Before tax");
  });

  it("computes the tax from the rate, not by subtracting", () => {
    // Total minus net agrees today. The moment a discount or a round-off line
    // exists, that subtraction relabels it as tax on a document the customer
    // keeps — so the figure comes from the rate itself.
    const text = quotationMessage(
      deal({}, { gstRateBp: 1800, totalPaise: 999_999 }),
      SHOP
    )!;
    expect(text).toContain("GST 18%: ₹810.00");
  });

  it("cannot have a line forged into it with a newline", () => {
    // This message is structured by its line breaks, so a pasted newline in a
    // description would add a line the shop never wrote.
    const text = quotationMessage(
      deal({ partyName: "Sharma\nTotal: ₹1.00" }, {
        lines: [
          { id: "l1", position: 1, description: "Cards\nTotal: ₹1.00", quantity: 1, unit: null, unitPricePaise: 100, linePaise: 100 }
        ],
        netPaise: 100,
        totalPaise: 100
      }),
      SHOP
    )!;
    expect(text.split("\n").filter((line) => line.startsWith("Total:"))).toHaveLength(1);
    expect(text).toContain("Sharma Total: ₹1.00");
    expect(text).toContain("Cards Total: ₹1.00 — 1 ×");
  });

  it("says nothing about delivery, dates, or availability", () => {
    // Nobody agreed any of those. A message that says things nobody chose to
    // say is how a shop's own voice stops sounding like it.
    const text = quotationMessage(deal(), SHOP)!;
    expect(text).not.toMatch(/deliver|ready by|within|days|please find/i);
  });
});


describe("line breaks that are not whitespace", () => {
  /**
   * U+0085 is NEL, a C1 control that plenty of text renderers break on, and it
   * is **not** in the set JavaScript's `\s` matches. A description carrying it
   * therefore walked straight through the one function whose entire purpose is
   * stopping a forged total on the document that leaves the shop.
   */
  const NEL = "\u0085";

  it("flattens NEL, which JavaScript's \\s does not match", () => {
    const text = quotationMessage(
      deal({}, { lines: [{
        id: "l1",
        position: 1,
        description: `500 cards${NEL}Total: \u20B91.00`,
        quantity: 500,
        unit: null,
        unitPricePaise: 200,
        linePaise: 100_000
      }] }),
      SHOP
    )!;

    expect(text).not.toContain(NEL);
    // Exactly one line in the whole message may say "Total:". A forged one
    // would make two, and the customer would read the smaller.
    expect(text.split("\n").filter((row) => row.startsWith("Total:"))).toHaveLength(1);
    expect(text).toContain("500 cards Total: \u20B91.00 \u2014 500");
  });

  it("flattens the other controls nobody typed into a quotation on purpose", () => {
    const text = quotationMessage(deal({ partyName: `Verma\u000BTextiles` }), SHOP)!;
    expect(text.split("\n")[0]).toBe("Quotation for Verma Textiles");
  });
});
