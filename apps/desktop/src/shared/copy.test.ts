import { describe, expect, it } from "vitest";
import { list, plural, verb } from "./copy.js";

describe("counted nouns", () => {
  it("agrees with the count", () => {
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
  });

  it("takes an explicit plural where -s is wrong", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(4, "entry", "entries")).toBe("4 entries");
  });

  it("puts zero in the plural, which is what English does", () => {
    // The reason this cannot be an inline `n === 1 ? a : a + "s"` each time:
    // half the places that get written inline get zero wrong instead.
    expect(plural(0, "entry", "entries")).toBe("0 entries");
  });
});

describe("verb agreement", () => {
  it("matches the count even when the noun is far away", () => {
    expect(verb(1, "is", "are")).toBe("is");
    expect(verb(0, "is", "are")).toBe("are");
    expect(verb(3, "has", "have")).toBe("have");
  });
});

describe("lists read aloud", () => {
  it("joins the way a person would say it", () => {
    expect(list([])).toBe("");
    expect(list(["Downloads"])).toBe("Downloads");
    expect(list(["Downloads", "Desktop"])).toBe("Downloads and Desktop");
    expect(list(["Downloads", "Desktop", "Documents"])).toBe(
      "Downloads, Desktop and Documents"
    );
  });
});
