import { describe, expect, it } from "vitest";
import { whenOf } from "./BookView";

describe("which end of the day a date means", () => {
  it("starts the day for an issue date", () => {
    // These were stamped at local noon, and the standing counts bills where
    // `issued_on <= now`. A bill entered at nine in the morning was three hours
    // in the future and appeared in nobody's balance until midday. Found by
    // entering one through the real screen, not by a test.
    const at = whenOf("2026-09-02", "start");

    expect(at).not.toBeNull();
    expect(new Date(at ?? 0).getHours()).toBe(0);
  });

  it("ends the day for a due date", () => {
    // A bill due on the 2nd is not late at one minute past midnight on the 2nd.
    const at = whenOf("2026-09-02", "end");

    expect(new Date(at ?? 0).getHours()).toBe(23);
  });

  it("is null for an empty or unreadable date", () => {
    expect(whenOf("")).toBeNull();
    expect(whenOf("not a date")).toBeNull();
  });
});
