import { describe, expect, it } from "vitest";
import { CLOSED_LABEL, waited } from "./DealRoom.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-12T10:00:00.000Z");

describe("how long something has been waiting", () => {
  it("says today rather than '0 days ago'", () => {
    // An enquiry that arrived this morning has not been ignored, and "0 days
    // ago" is not a phrase any person has ever written on purpose.
    expect(waited(NOW - 3600_000, NOW)).toBe("today");
    expect(waited(NOW, NOW)).toBe("today");
  });

  it("is singular-aware", () => {
    expect(waited(NOW - DAY, NOW)).toBe("1 day ago");
    expect(waited(NOW - 2 * DAY, NOW)).toBe("2 days ago");
  });

  it("does not say '-1 days' when the clock has drifted backwards", () => {
    // A laptop that has slept can wake with a timestamp ahead of now. The screen
    // should look unremarkable, not broken.
    expect(waited(NOW + 5 * DAY, NOW)).toBe("today");
  });

  it("reads the same at a day boundary as the day either side of it", () => {
    expect(waited(NOW - DAY - 1, NOW)).toBe("1 day ago");
    expect(waited(NOW - DAY + 1, NOW)).toBe("today");
  });
});

describe("how a finished deal reads", () => {
  it("names the outcome in the owner's words, not the database's", () => {
    expect(CLOSED_LABEL.won).toBe("Order confirmed");
    expect(CLOSED_LABEL.lost).toBe("Order lost");
    expect(CLOSED_LABEL.no_reply).toBe("Closed with no reply");
  });

  it("has no label for a state that is not an ending", () => {
    expect(CLOSED_LABEL.draft).toBeUndefined();
    expect(CLOSED_LABEL.sent).toBeUndefined();
  });
});
