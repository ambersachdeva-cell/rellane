import { describe, expect, it } from "vitest";
import { selectEngine } from "./select.js";
import { newBrief } from "./brief.js";
import type { EngineModel, EngineRoomStatus, EngineStatus, EngineTier } from "@cadrane/contracts";

const model = (id: string, tier: EngineTier): EngineModel => ({
  id,
  label: id,
  tier,
  tierLabel: tier,
  note: "n",
  includedInSubscription: true
});

const engine = (
  id: string,
  state: EngineStatus["state"],
  models: readonly EngineModel[]
): EngineStatus => ({
  id,
  label: id === "claude" ? "Claude" : id === "local" ? "On this Mac" : id,
  access: id === "local" ? "on-device" : "subscription",
  accessLabel: "x",
  state,
  summary: "s",
  fixHint: state === "ready" ? null : "Install it and sign in once.",
  evidence: null,
  models
});

const room = (engines: readonly EngineStatus[]): EngineRoomStatus => ({
  engines,
  active: null,
  checkedAt: "2026-09-01T00:00:00.000Z",
  allUnavailable: engines.every((e) => e.state !== "ready")
});

const brief = (tier: EngineTier, pinnedEngineId: string | null = null) =>
  newBrief({ id: "a", name: "A", purpose: "p", tier, pinnedEngineId });

const full = () =>
  room([
    engine("claude", "ready", [
      model("opus", "frontier"),
      model("sonnet", "balanced"),
      model("haiku", "fast")
    ]),
    engine("local", "ready", [model("bundled", "on-device")])
  ]);

describe("picking who thinks", () => {
  it("gives a brief the tier it asked for", () => {
    const result = selectEngine(full(), brief("balanced"));

    expect(result.ok).toBe(true);
    expect(result.ok && result.selection.modelId).toBe("sonnet");
    // Got what it asked for, so nothing to explain.
    expect(result.ok && result.selection.substituted).toBeNull();
  });

  it("falls one tier down rather than refusing to run", () => {
    // An agent that wanted the deepest model can still do useful work on the
    // everyday one, and refusing outright is worse than saying so.
    const noFrontier = room([
      engine("claude", "ready", [model("sonnet", "balanced"), model("haiku", "fast")])
    ]);

    const result = selectEngine(noFrontier, brief("frontier"));

    expect(result.ok && result.selection.modelId).toBe("sonnet");
    // Names the tier it landed on rather than saying "one tier down", which was
    // hardcoded while the walk can drop several — so a frontier-to-fast run told
    // the owner it had dropped to balanced, on the one line that records exactly
    // this substitution.
    expect(result.ok && result.selection.substituted).toContain("balanced model");
  });

  it("never falls upward onto a more expensive tier", () => {
    // The rule that protects a subscription: an agent asked for the quickest
    // model, and silently spending frontier tokens on it in the background is
    // how a plan disappears into filing.
    const onlyFrontier = room([engine("claude", "ready", [model("opus", "frontier")])]);

    const result = selectEngine(onlyFrontier, brief("fast"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("or anything below it");
  });

  it("reaches the on-device model as the bottom of the ladder", () => {
    const localOnly = room([
      engine("claude", "not-installed", []),
      engine("local", "ready", [model("bundled", "on-device")])
    ]);

    const result = selectEngine(localOnly, brief("frontier"));

    expect(result.ok && result.selection.engineId).toBe("local");
    expect(result.ok && result.selection.substituted).not.toBeNull();
  });

  it("says so plainly when nothing is connected", () => {
    const dead = room([engine("claude", "not-installed", [])]);

    const result = selectEngine(dead, brief("balanced"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Open the Engine Room");
  });
});

describe("a pinned engine", () => {
  it("wins outright when it is ready", () => {
    const result = selectEngine(full(), brief("balanced", "claude"));

    expect(result.ok && result.selection.engineId).toBe("claude");
  });

  it("is reported rather than worked around when it is not connected", () => {
    // "Use Claude" and "use whatever is up" are different instructions, and
    // honouring the second when told the first makes a pin decorative.
    const down = room([
      engine("claude", "not-installed", []),
      engine("local", "ready", [model("bundled", "on-device")])
    ]);

    const result = selectEngine(down, brief("balanced", "claude"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("pinned to Claude");
    // Carries the fix from the engine row rather than inventing one.
    expect(!result.ok && result.reason).toContain("sign in once");
  });

  it("names an engine that does not exist rather than falling back", () => {
    const result = selectEngine(full(), brief("balanced", "invented"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("not an engine Rellane knows");
  });

  it("explains when the pinned engine lacks the tier asked for", () => {
    const onlyFast = room([engine("claude", "ready", [model("haiku", "fast")])]);

    const result = selectEngine(onlyFast, brief("frontier", "claude"));

    expect(result.ok && result.selection.modelId).toBe("haiku");
    expect(result.ok && result.selection.substituted).toContain("had no frontier model");
  });
});

describe("a pinned engine never runs dearer than asked", () => {
  it("walks down within the pinned engine instead of taking its first model", () => {
    // This was `?? engine.models[0]`. On an engine that lists frontier first, a
    // brief asking for the quickest model got frontier — so a background filing
    // job silently spent frontier tokens. A cheap tier is a budget as much as a
    // capability, which the file says three lines further down.
    const frontierFirst = room([
      engine("claude", "ready", [model("opus", "frontier"), model("haiku", "fast")])
    ]);

    const result = selectEngine(frontierFirst, brief("balanced", "claude"));

    expect(result.ok && result.selection.modelId).toBe("haiku");
    expect(result.ok && result.selection.tier).toBe("fast");
  });

  it("still takes the exact tier when the pinned engine has it", () => {
    const result = selectEngine(full(), brief("balanced", "claude"));

    expect(result.ok && result.selection.modelId).toBe("sonnet");
    expect(result.ok && result.selection.substituted).toBeNull();
  });
});

describe("the substitution the owner reads", () => {
  it("names the tier it actually reached, however far it fell", () => {
    // Frontier asked for, only fast available: two steps down, and the message
    // must not claim one.
    const onlyFast = room([engine("claude", "ready", [model("haiku", "fast")])]);

    const result = selectEngine(onlyFast, brief("frontier"));

    // The fixture's tierLabel is the raw tier; in the shipped catalogue it reads
    // "Quick". Either way the sentence names the tier actually reached.
    expect(result.ok && result.selection.substituted).toContain("fast model");
    expect(result.ok && result.selection.substituted).not.toContain("one tier down");
  });
});
