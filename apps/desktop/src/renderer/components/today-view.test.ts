import { describe, expect, it } from "vitest";
import type { TodayItem } from "@cadrane/contracts";
import { greets, heading, noun } from "./TodayView.js";

const item = (over: Partial<TodayItem> = {}): TodayItem => ({
  kind: "invoice",
  id: "i1",
  line: "The ADM invoice has been unpaid for 47 days.",
  severity: "urgent",
  days: 47,
  ...over
});

describe("the sentence at the top", () => {
  it("says the answer before the reader has to count", () => {
    // "Four things need you today" is the sentence the plan wrote, and it beats
    // the word "Today" over a list because the count is the point.
    expect(heading([item(), item(), item(), item()])).toBe("Four things need you today");
  });

  it("is singular-aware, because '1 things' tells the reader nobody looked", () => {
    expect(heading([item()])).toBe("One thing needs you today");
    expect(heading([item(), item()])).toBe("Two things need you today");
  });

  it("says nothing needs you, and does not congratulate anybody for it", () => {
    const said = heading([]);
    expect(said).toBe("Nothing needs you today");
    // A product that cheers when nothing happened is one you stop believing
    // when something has.
    expect(said).not.toMatch(/great|well done|caught up|nice|✓/iu);
  });

  it("says 'Today' while it is still looking, never a zero nobody observed", () => {
    expect(heading(null)).toBe("Today");
    expect(heading(null)).not.toMatch(/nothing/iu);
  });
});

describe("the owner's nouns", () => {
  it("calls an invoice a bill, because that is what a person says out loud", () => {
    expect(noun("invoice")).toBe("bill");
    expect(noun("case")).toBe("case");
  });
});

describe("somebody's first morning", () => {
  it("greets an empty book", () => {
    expect(greets([], true)).toBe(true);
  });

  it("does not greet a shop that has records and a quiet Thursday", () => {
    // The whole point of asking about the book and not about the day. A shop
    // that has quoted and closed everything gets the quiet empty state.
    expect(greets([], false)).toBe(false);
  });

  it("never greets while the answer is still being fetched", () => {
    // Both nulls mean "not known yet". A greeting that appears for one frame and
    // vanishes reads as a bug in a way that a greeting arriving late does not.
    expect(greets(null, true)).toBe(false);
    expect(greets([], null)).toBe(false);
    expect(greets(null, null)).toBe(false);
  });

  it("does not greet over the top of work that needs doing", () => {
    // A fresh book with items in it should be impossible — an item is made of
    // records. If the two ever disagree, the work wins.
    expect(greets([item()], true)).toBe(false);
  });
});
