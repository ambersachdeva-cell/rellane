/**
 * What the owner is told when the reading does not happen.
 *
 * This is the message on the most common failure there is — a Mac with no model
 * installed, which is every Mac on its first day — so it is held to the same bar
 * as anything else a person reads.
 */
import { describe, expect, it } from "vitest";
import { saidFor } from "./enquiry-local.js";

describe("what the owner is told", () => {
  it("says a model is not installed, not that something is broken", () => {
    const said = saidFor(
      new Error("The bundled model is not ready. Check Models and try again. No subscription was contacted.")
    );
    expect(said).toMatch(/No model is installed/u);
    // The engine's own words, every one of them wrong for this reader: a phrase
    // they have never heard, a screen that is no longer on the rail, and a
    // reassurance about a worry nobody had.
    expect(said).not.toMatch(/bundled|Check Models|subscription/iu);
  });

  it("always ends with the thing they can do right now", () => {
    for (const error of [
      new Error("The bundled model is not ready."),
      new Error("something nobody predicted"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      "not an error at all"
    ]) {
      expect(saidFor(error)).toMatch(/yourself/u);
    }
  });

  it("does not blame the owner or apologise", () => {
    const said = saidFor(new Error("something nobody predicted"));
    expect(said).not.toMatch(/sorry|oops|unfortunately|failed|error/iu);
  });

  it("says a stopped read was stopped rather than guessing why", () => {
    expect(saidFor(Object.assign(new Error("x"), { name: "TimeoutError" }))).toMatch(/took too long/u);
    expect(saidFor(Object.assign(new Error("x"), { name: "AbortError" }))).toMatch(/took too long/u);
  });
});
