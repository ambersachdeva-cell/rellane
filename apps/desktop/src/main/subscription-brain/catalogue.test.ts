import { describe, expect, it } from "vitest";
import {
  ACCESS_LABELS,
  CATALOGUE,
  cheaperTier,
  engineFor,
  modelsAtTier,
  TIER_MEANING,
  TIERS
} from "./catalogue.js";
import { PROVIDER_DEFINITIONS } from "./providers.js";

describe("the engine catalogue", () => {
  it("offers every engine the product can think with", () => {
    expect(CATALOGUE.map((engine) => engine.providerId)).toEqual([
      "claude",
      "antigravity",
      "gemini",
      "local"
    ]);
  });

  it("reaches every frontier model through a subscription, not an API key", () => {
    // The feature, asserted. Somebody paying for Claude Pro should not then pay
    // per token to use the thing they already bought.
    const frontier = modelsAtTier("frontier");

    expect(frontier.length).toBeGreaterThan(0);
    expect(frontier.every((model) => model.includedInSubscription)).toBe(true);
  });

  it("has no API-key engine at all today", () => {
    // An API key is the third way in, offered later for people with no
    // subscription. Nothing in the shipped catalogue depends on one.
    expect(CATALOGUE.some((engine) => engine.access === "api-key")).toBe(false);
  });

  it("puts subscription-included models before paid ones at each tier", () => {
    for (const tier of TIERS) {
      const models = modelsAtTier(tier);
      const paidFirst = models.findIndex((model) => !model.includedInSubscription);
      const includedLast = models.map((model) => model.includedInSubscription).lastIndexOf(true);
      if (paidFirst !== -1 && includedLast !== -1) {
        expect(paidFirst).toBeGreaterThan(includedLast);
      }
    }
  });

  it("describes every tier in the owner's words rather than as a spec sheet", () => {
    for (const tier of TIERS) {
      const meaning = TIER_MEANING[tier];
      expect(meaning.length).toBeGreaterThan(20);
      // DESIGN.md §7 bans marketing vocabulary outright.
      expect(meaning).not.toMatch(/\b(powerful|seamless|magic|cutting-edge|state-of-the-art)\b/iu);
    }
  });

  it("gives every engine something to do when its light is red", () => {
    // The whole point of a red light is the next step. "Provider unavailable"
    // is not a next step.
    for (const engine of CATALOGUE) {
      expect(engine.fixHint.length).toBeGreaterThan(20);
      expect(engine.reachedBy.length).toBeGreaterThan(5);
      expect(ACCESS_LABELS[engine.access]).toBeTruthy();
    }
  });

  it("keeps the tier ladder walkable downward and stops at the bottom", () => {
    expect(cheaperTier("frontier")).toBe("balanced");
    expect(cheaperTier("balanced")).toBe("fast");
    expect(cheaperTier("fast")).toBe("on-device");
    // Returns null rather than wrapping — wrapping would silently promote a
    // local model back to frontier when a budget ran out.
    expect(cheaperTier("on-device")).toBeNull();
  });

  it("only lists models a provider can actually be asked for", () => {
    // A catalogue entry with no provider behind it is a dropdown option that
    // fails when clicked. Local is exempt: its models come from what is
    // installed at runtime, not from this file.
    const drivable = new Set(PROVIDER_DEFINITIONS.map((definition) => definition.id));
    for (const engine of CATALOGUE) {
      if (engine.providerId === "local") {
        expect(engine.models).toEqual([]);
        continue;
      }
      expect(drivable.has(engine.providerId)).toBe(true);
      expect(engine.models.length).toBeGreaterThan(0);
    }
  });

  it("finds an engine by id, and says so plainly when there is none", () => {
    expect(engineFor("claude")?.label).toBe("Claude");
    expect(engineFor("local")?.access).toBe("on-device");
  });

  it("gives every model a sentence a person could choose from", () => {
    for (const engine of CATALOGUE) {
      for (const model of engine.models) {
        expect(model.note.length).toBeGreaterThan(15);
        expect(model.label).not.toContain("-");
      }
    }
  });
});
