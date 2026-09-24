/**
 * The worked example is the first thing the product ever does in front of
 * somebody, so it is held to what the product claims about itself.
 *
 * It is a fixture in the literal sense: if it stops parsing, the demonstration
 * demonstrates a failure, and it does so to the one person whose opinion of this
 * app has not formed yet.
 */
import { describe, expect, it } from "vitest";
import { countOf } from "../../main/book/enquiry-lines.js";
import { EXAMPLE_ENQUIRY } from "./FirstEnquiry.js";

describe("the example enquiry", () => {
  it("names no price, because the product refuses to invent one", () => {
    // An example carrying a rate would teach, in the first thirty seconds, the
    // exact thing every other screen spends its credibility denying.
    expect(EXAMPLE_ENQUIRY.rawText).not.toMatch(/₹|\brs\.?\b|\binr\b/iu);
  });

  it("asks for a price rather than stating one", () => {
    expect(EXAMPLE_ENQUIRY.rawText).toMatch(/rate kya/iu);
  });

  it("reads like a message somebody sent, not like a specification", () => {
    // Hinglish, lower case, one breath. A tidy specimen would demonstrate a
    // product nobody has, and would teach the owner to clean up what their
    // customers wrote before pasting it — which is what makes a quoted price
    // undefendable later.
    expect(EXAMPLE_ENQUIRY.rawText).toMatch(/\bbhai\b/u);
    expect(EXAMPLE_ENQUIRY.rawText).not.toMatch(/^[A-Z]/u);
    expect(EXAMPLE_ENQUIRY.rawText.split("\n")).toHaveLength(1);
  });

  it("carries a quantity the reader can actually find", () => {
    // The whole demonstration is that the enquiry turns into a priced line. If
    // nothing countable survives, the owner watches the loop produce nothing.
    expect(countOf("500 visiting cards")).toBe(500);
    expect(EXAMPLE_ENQUIRY.rawText).toContain("500");
  });

  it("has a stock weight in it, which is the part that can go wrong", () => {
    // Writing this example is what turned up the gap: "300 gsm" reads as a
    // perfectly good standalone number, so a quantity field that came back
    // holding the paper weight would have quoted 300 cards instead of 500.
    expect(EXAMPLE_ENQUIRY.rawText).toContain("300 gsm");
    expect(countOf("300 gsm matte")).toBeNull();
  });

  it("arrives by the channel these actually arrive by", () => {
    expect(EXAMPLE_ENQUIRY.channel).toBe("whatsapp");
  });
});
