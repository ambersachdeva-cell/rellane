import { describe, expect, it } from "vitest";
import { delta, moment } from "./FolderHistory";

describe("how a size change reads", () => {
  it("signs the change, so it reads as a change and not a size", () => {
    expect(delta(2048)).toBe("+2 KB");
    expect(delta(-2048)).toBe("−2 KB");
  });

  it("says so when an edit kept the length", () => {
    // Which happens: a corrected digit in an invoice is the ordinary case.
    expect(delta(0)).toBe("same size");
  });

  it("uses a minus sign rather than a hyphen", () => {
    // U+2212. A hyphen next to a numeral reads as a hyphenated word at 12px.
    expect(delta(-1024).startsWith("−")).toBe(true);
  });
});

describe("how a moment reads", () => {
  const now = new Date("2026-08-30T15:00:00");

  it("gives today a clock and nothing else", () => {
    expect(moment("2026-08-30T09:05:00", now)).toBe("09:05");
  });

  it("names yesterday, rather than making the reader subtract", () => {
    expect(moment("2026-08-29T18:30:00", now)).toBe("yesterday 18:30");
  });

  it("gives anything older a date", () => {
    // "5 days ago" makes a person work out which day that was, which is the
    // arithmetic this exists to avoid.
    //
    // Asserted on content rather than on order: the day/month arrangement is
    // the reader's locale's decision, and pinning "25 Aug" here would pass in
    // Delhi and fail in a US locale for no reason a user would recognise.
    const rendered = moment("2026-08-25T18:30:00", now);
    expect(rendered).toContain("25");
    expect(rendered).toContain("18:30");
    expect(rendered).not.toContain("yesterday");
  });

  it("says it does not know rather than printing Invalid Date", () => {
    expect(moment("not a date", now)).toBe("an unknown time");
  });

  it("pads the clock, so a column stays a column", () => {
    expect(moment("2026-08-30T09:05:00", now)).toBe("09:05");
    expect(moment("2026-08-30T14:05:00", now)).toBe("14:05");
  });
});
