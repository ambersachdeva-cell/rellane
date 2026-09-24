import { describe, expect, it } from "vitest";
import { fitWord, licenceLine, machineLine } from "./ModelsView";
import type { ConciergeSnapshot } from "@cadrane/contracts";

describe("the fit verdict", () => {
  it("says what a person would do about it, not what the scorer thinks", () => {
    // "Comfortable" and "Tight" are decisions. "excellent" and "tight" are
    // adjectives from a scoring function that nobody outside it has to care
    // about.
    expect(fitWord("excellent")).toBe("Comfortable");
    expect(fitWord("good")).toBe("Fine");
    expect(fitWord("tight")).toBe("Tight");
  });

  it("is blunt about what will not run", () => {
    expect(fitWord("unsupported")).toBe("Will not run");
  });
});

describe("how a licence is described", () => {
  it("says reviewed without claiming to be advice", () => {
    // "Terms reviewed as permissive" is an engineering statement. "Free to
    // use" would be a legal one, and we are not qualified to make it.
    expect(licenceLine("Apache-2.0", "permissive-terms-reviewed")).toBe(
      "Apache-2.0, terms reviewed as permissive"
    );
  });

  it("tells somebody to read conditional terms themselves", () => {
    expect(licenceLine("Llama 3", "conditional")).toContain("read them before you rely on it");
  });

  it("says unreviewed rather than treating it as fine", () => {
    // Silence here would be read as approval, which is the failure mode worth
    // designing against.
    expect(licenceLine("Custom", "unreviewed")).toBe("Custom, terms not reviewed");
  });
});

describe("the machine the verdicts are measured against", () => {
  it("names it, so the fit scores have a source", () => {
    const snapshot = {
      profile: {
        chip: "Apple M1 Pro",
        memoryBytes: 17_179_869_184,
        freeDiskBytes: 107_374_182_400,
        acceleration: "metal"
      },
      catalogReviewedAt: "2026-07-30",
      recommendations: []
    } as unknown as ConciergeSnapshot;

    const line = machineLine(snapshot);

    expect(line).toContain("Apple M1 Pro");
    expect(line).toContain("16.0 GB");
    expect(line).toContain("metal");
  });
});
