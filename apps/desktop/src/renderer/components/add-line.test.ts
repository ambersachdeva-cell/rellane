/**
 * How long ago a remembered rate was charged.
 *
 * The date's whole job is to say whether the figure is stale, and that is a
 * judgement the owner makes in a second or not at all.
 */
import { describe, expect, it } from "vitest";
import { ago } from "./AddLine.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-13T10:00:00.000Z");

describe("how long ago", () => {
  it("says today and yesterday, because nobody counts those in days", () => {
    expect(ago(NOW - 3600_000, NOW)).toBe("today");
    expect(ago(NOW - DAY, NOW)).toBe("yesterday");
  });

  it("counts days for a fortnight, then stops counting them", () => {
    expect(ago(NOW - 3 * DAY, NOW)).toBe("3 days ago");
    expect(ago(NOW - 13 * DAY, NOW)).toBe("13 days ago");
    expect(ago(NOW - 23 * DAY, NOW)).toBe("3 weeks ago");
  });

  it("gets rougher as it gets older, which is the point", () => {
    // "23 August" makes the reader do arithmetic before it means anything; the
    // question they are actually asking is whether this rate is still good.
    expect(ago(NOW - 96 * DAY, NOW)).toBe("3 months ago");
    expect(ago(NOW - 400 * DAY, NOW)).toBe("over a year ago");
  });

  it("does not say '-2 days' when a clock has drifted backwards", () => {
    expect(ago(NOW + 2 * DAY, NOW)).toBe("today");
  });
});
