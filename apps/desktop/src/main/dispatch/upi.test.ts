/**
 * A reminder somebody can pay from.
 *
 * The gap this closes is the one between "please pay ₹9,440" and money actually
 * arriving: the customer opening a bank app and keying an id and an amount. Each
 * step is a day of delay and a chance to type the wrong figure.
 */

import { describe, expect, it } from "vitest";
import { chaseMessage, upiLink, whatsappLink } from "./upi.js";

describe("a payment link", () => {
  it("carries the payee and the exact amount, so nothing is typed", () => {
    const link = upiLink({
      payeeId: "demo@okhdfcbank",
      payeeName: "Example Studio",
      amountPaise: 944_000,
      note: "Bill A-114"
    });

    expect(link.ok).toBe(true);
    const query = new URLSearchParams(link.uri.split("?")[1]);
    expect(query.get("pa")).toBe("demo@okhdfcbank");
    expect(query.get("am")).toBe("9440.00");
    expect(query.get("cu")).toBe("INR");
    expect(link.uri.startsWith("upi://pay?")).toBe(true);
  });

  it("leaves the @ alone, because payment apps do not decode it", () => {
    // URLSearchParams turns @ into %40 and spaces into +. Real apps do not
    // decode %40 in the payee field, so the VPA fails to resolve — every link
    // would have looked right and paid nobody.
    const link = upiLink({
      payeeId: "demo@okhdfcbank",
      payeeName: "Example Studio",
      amountPaise: 100,
      note: "Bill A 114"
    });

    expect(link.uri).toContain("pa=demo@okhdfcbank");
    expect(link.uri).not.toContain("%40");
    expect(link.uri).not.toContain("+");
    expect(link.uri).toContain("Example%20Studio");
  });

  it("refuses an email address, which passes every other test", () => {
    // One @, text on both sides, no whitespace. The dot in the suffix is the
    // only thing that tells them apart, and every real UPI handle is one token.
    expect(upiLink({ payeeId: "demo@gmail.com", payeeName: "x", amountPaise: 1, note: "n" }).ok).toBe(
      false
    );
    expect(upiLink({ payeeId: "demo@ybl", payeeName: "x", amountPaise: 1, note: "n" }).ok).toBe(true);
  });

  it("refuses a request for nothing", () => {
    // A payment request for zero is confusing at best, and at worst it is a
    // bill somebody believes they have paid.
    expect(upiLink({ payeeId: "a@bank", payeeName: "x", amountPaise: 0, note: "n" }).ok).toBe(false);
    expect(upiLink({ payeeId: "a@bank", payeeName: "x", amountPaise: -100, note: "n" }).ok).toBe(
      false
    );
  });

  it("catches an id that is not a UPI id", () => {
    // Loose on the handle because banks invent suffixes constantly; strict on
    // the shape, which is what separates a UPI id from a pasted email.
    expect(upiLink({ payeeId: "demo@ybl", payeeName: "x", amountPaise: 1, note: "n" }).ok).toBe(
      true
    );
    expect(upiLink({ payeeId: "not a upi id", payeeName: "x", amountPaise: 1, note: "n" }).ok).toBe(
      false
    );
    expect(
      upiLink({ payeeId: "demo@okhdfcbank", payeeName: "x", amountPaise: 1, note: "n" }).problem
    ).toBeNull();
  });
});

describe("a WhatsApp link", () => {
  it("takes a number written the way people write them", () => {
    // The same person, typed three ways, every day.
    const expected = whatsappLink("+91 98765 43210", "hello");

    expect(whatsappLink("9876543210", "hello")).toBe(expected);
    expect(whatsappLink("098765 43210", "hello")).toBe(expected);
    expect(expected).toContain("wa.me/919876543210");
  });

  it("refuses something that is not a number", () => {
    expect(whatsappLink("12", "hello")).toBeNull();
    expect(whatsappLink("", "hello")).toBeNull();
  });

  it("escapes the message rather than breaking the link", () => {
    const link = whatsappLink("9876543210", "₹9,440 & bill A-114 — due?");

    expect(link).not.toContain(" ");
    expect(decodeURIComponent(link?.split("text=")[1] ?? "")).toContain("₹9,440 & bill A-114");
  });
});

describe("what the reminder says", () => {
  it("states the fact, gives the number, and asks", () => {
    // Written to be sent unedited by somebody busy. A template that reads as a
    // threat or an apology gets rewritten, and one nobody sends does not exist.
    const message = chaseMessage({
      party: "Devgiri Traders",
      amountPaise: 944_000,
      daysLate: 15,
      billNumber: "A-114",
      from: "Example Studio",
      payLink: "upi://pay?pa=demo@okhdfcbank"
    });

    expect(message).toContain("₹9,440");
    expect(message).toContain("bill A-114");
    expect(message).toContain("15 days ago");
    expect(message).toContain("upi://pay");
    expect(message).toContain("Example Studio");
    // Neither threatening nor grovelling.
    expect(message.toLowerCase()).not.toContain("legal");
    expect(message.toLowerCase()).not.toContain("sorry");
  });

  it("states paise when there are any, to match the payment link", () => {
    // A reminder that says ₹9,441 beside a link for ₹9,440.50 is one nobody
    // sends.
    const message = chaseMessage({
      party: "X",
      amountPaise: 944_050,
      daysLate: 1,
      billNumber: null,
      from: "Y"
    });

    expect(message).toContain("9,440.50");
    expect(message).not.toContain("9,441");
  });

  it("survives an emoji at the truncation point", () => {
    // Slicing by code units can cut a surrogate pair in half, and
    // encodeURIComponent throws URIError on a lone surrogate.
    const long = `${"🙏".repeat(1_500)}`;

    expect(() => whatsappLink("9876543210", long)).not.toThrow();
    expect(whatsappLink("9876543210", long)).toContain("wa.me");
  });

  it("says 'due now' rather than 'due 0 days ago'", () => {
    const message = chaseMessage({
      party: "X",
      amountPaise: 100,
      daysLate: 0,
      billNumber: null,
      from: "Y"
    });

    expect(message).toContain("due now");
    expect(message).not.toContain("0 days");
  });

  it("leaves the payment line out when there is no link", () => {
    const message = chaseMessage({
      party: "X",
      amountPaise: 100,
      daysLate: 2,
      billNumber: null,
      from: "Y"
    });

    expect(message).not.toContain("You can pay here");
  });
});
