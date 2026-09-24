import { describe, expect, it } from "vitest";
import { said } from "./copy.js";

describe("what a person is shown when something fails", () => {
  it("strips the plumbing Electron wraps around a thrown message", () => {
    // The sentence was written for a person and arrives wearing a channel name
    // and a class name. Both make it read as a crash rather than an answer.
    expect(
      said(
        new Error(
          "Error invoking remote method 'cadrane:v4:automation-snapshot': RuntimeBoundaryError: Flows are locked."
        ),
        "fallback"
      )
    ).toBe("Flows are locked.");
  });

  it("keeps a colon that belongs to the sentence", () => {
    expect(said(new Error("Flows are locked: the key is from an older build."), "fallback")).toBe(
      "Flows are locked: the key is from an older build."
    );
  });

  it("removes the plain Error prefix from a native bill deadline without losing the reason", () => {
    expect(said(new Error("Error invoking remote method 'cadrane:v4:book-read-file': Error: This local request took too long. Nothing was applied. Try a shorter source."), "fallback"))
      .toBe("This local request took too long. Nothing was applied. Try a shorter source.");
    expect(said("Error:   ", "That could not be read.")).toBe("That could not be read.");
  });

  it("falls back rather than inventing", () => {
    // A generic apology in place of a real reason is how a product stops being
    // worth reading, so this only ever happens when there is genuinely nothing.
    expect(said(new Error("   "), "That could not be read.")).toBe("That could not be read.");
    expect(said(undefined, "That could not be read.")).toBe("That could not be read.");
    expect(said({ weird: true }, "That could not be read.")).toBe("That could not be read.");
  });

  it("takes a plain string too, since not everything thrown is an Error", () => {
    expect(said("Nothing is connected.", "fallback")).toBe("Nothing is connected.");
  });
});
