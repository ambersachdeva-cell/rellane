import { describe, expect, it } from "vitest";
import { CATALOGUE, noticesFor } from "./catalogue.js";

describe("what may be shipped", () => {
  it("carries only permissive licences", () => {
    // The filter is applied once, here, rather than carried as a risk forever.
    // Anything copyleft or with an anti-SaaS clause does not belong in a list
    // with an install button next to it.
    for (const entry of CATALOGUE) {
      expect(["MIT", "Apache-2.0"]).toContain(entry.licence);
    }
  });

  it("names an author and a homepage for every entry", () => {
    // Attribution is the entire cost of using this software. An entry that
    // cannot be attributed cannot be shipped.
    for (const entry of CATALOGUE) {
      expect(entry.by.length).toBeGreaterThan(0);
      expect(entry.homepage.startsWith("https://")).toBe(true);
    }
  });

  it("excludes the platforms whose licences forbid this use", () => {
    // Dify forbids removing its branding and forbids multi-tenant resale;
    // FastGPT paywalls multi-tenancy. Both are prominent enough that a
    // "just take it" plan would reach for them first.
    const ids = CATALOGUE.map((entry) => entry.id).join(" ");
    expect(ids).not.toMatch(/dify|fastgpt|activepieces/iu);
  });

  it("stays short enough to be a decision rather than a directory", () => {
    expect(CATALOGUE.length).toBeLessThanOrEqual(8);
  });

  it("says what each one needs before it will run", () => {
    // A connector that installs and immediately fails teaches the owner that
    // connectors do not work. Where setup is required, it is stated.
    for (const entry of CATALOGUE) {
      if (entry.args.some((arg) => arg.endsWith("--repository")) || entry.id === "filesystem") {
        expect(entry.needs).not.toBeNull();
      }
    }
  });
});

describe("the notices this Mac owes", () => {
  it("lists exactly what is installed, and nothing else", () => {
    // A NOTICES file that lists something uninstalled, or omits something
    // installed, is worse than none: it looks maintained and is not.
    const text = noticesFor(["filesystem"]);

    expect(text).toContain("Anthropic");
    expect(text).toContain("MIT");
    expect(text).toContain("https://github.com/modelcontextprotocol/servers");
    expect(text).not.toContain("Long-term memory");
  });

  it("says plainly when nothing is installed", () => {
    expect(noticesFor([])).toBe("No third-party connectors are installed.");
  });

  it("is generated from what is installed, so it cannot drift", () => {
    const all = noticesFor(CATALOGUE.map((entry) => entry.id));

    for (const entry of CATALOGUE) {
      expect(all).toContain(entry.label);
    }
  });
});
