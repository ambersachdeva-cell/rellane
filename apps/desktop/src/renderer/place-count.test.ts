import { describe, expect, it } from "vitest";
import { placeCount } from "./App";
import type { AgentCard, EngineRoomStatus } from "@cadrane/contracts";
import { newBrief } from "../main/agents/brief.js";

/**
 * The numbers in the sidebar.
 *
 * A count earns its place only when it is something a person would act on. Two
 * adjacent places both showing "3" for unrelated reasons is worse than showing
 * nothing: it invites a connection that does not exist.
 */

const engines = (ready: number, total: number): EngineRoomStatus => ({
  engines: Array.from({ length: total }, (_, index) => ({
    id: `e${index}`,
    label: `E${index}`,
    access: "subscription" as const,
    accessLabel: "Your subscription",
    state: index < ready ? ("ready" as const) : ("not-installed" as const),
    summary: "s",
    fixHint: null,
    evidence: null,
    models: []
  })),
  active: null,
  checkedAt: "2026-09-01T00:00:00.000Z",
  allUnavailable: ready === 0
});

const agents = (count: number): AgentCard[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `a${index}`,
    name: `A${index}`,
    purpose: "p",
    brief: newBrief({ id: `a${index}`, name: `A${index}`, purpose: "p" }),
    sentence: "s",
    tierLabel: "Fast",
    outbound: "never" as const,
    outboundLabel: "Never sends anything",
    folders: [],
    capabilities: [],
    withheld: [],
    inert: false,
    custom: false,
    systemPrompt: ""
  }));

describe("the other counts", () => {
  it("counts agents that can actually run, not every card", () => {
    const cards: AgentCard[] = [
      ...agents(2),
      { ...agents(1)[0]!, id: "dead", inert: true }
    ];

    expect(placeCount("agents", cards, null, null)).toBe("2");
  });

  it("does not confuse tool detection with an unlabeled readiness ratio", () => {
    expect(placeCount("engines", null, engines(3, 4), null)).toBe("");
  });

  it("is empty for places where a number would mean nothing", () => {
    expect(placeCount("desk", agents(3), engines(3, 4), null)).toBe("");
    expect(placeCount("settings", agents(3), engines(3, 4), null)).toBe("");
  });
});
