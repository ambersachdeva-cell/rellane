import { describe, expect, it } from "vitest";
import { facts } from "./home-facts";
import type { AgentCard, EngineRoomStatus } from "@cadrane/contracts";
import { newBrief } from "../main/agents/brief.js";

const room = (over: Partial<EngineRoomStatus> = {}): EngineRoomStatus => ({
  engines: [
    {
      id: "claude",
      label: "Claude",
      access: "subscription",
      accessLabel: "Your subscription",
      state: "ready",
      summary: "s",
      fixHint: null,
      evidence: null,
      models: []
    }
  ],
  active: { engineId: "claude", modelId: "sonnet" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  allUnavailable: false,
  ...over
});

const agent = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: "a",
  name: "Filing clerk",
  purpose: "p",
  brief: newBrief({ id: "a", name: "Filing clerk", purpose: "p" }),
  sentence: "s",
  tierLabel: "Quick",
  outbound: "never",
  withheld: [],
  inert: false,
  custom: false,
  folders: [],
  capabilities: [],
  systemPrompt: "",
  ...over
});

describe("every fact on Home names where it came from", () => {
  it("never labels an unavailable history as nothing yet or a trusted count", () => {
    const empty = facts(room(), ["/fictional"], [], { entries: [], integrity: "Unreadable.", trustworthy: false })[3];
    expect(empty).toMatchObject({ value: "unavailable", wanting: true, go: "timeline" });
    const verified = facts(room(), ["/fictional"], [], { entries: [], integrity: "Empty.", trustworthy: true })[3];
    expect(verified).toMatchObject({ value: "nothing yet", wanting: false });
  });
  /**
   * Task 1.2: no status anywhere is an unsourced assertion. A claim you can
   * click through to the probe that ran is evidence; one you cannot is the same
   * as one nobody checked.
   */

  it("counts detected subscription tools separately from local readiness", () => {
    const provider = { ...room().engines[0]!, state: "detected" as const };
    const local = { ...provider, id: "local", access: "on-device" as const, state: "ready" as const };
    expect(facts(room({ engines: [provider, local] }), [], [], null)[0]).toMatchObject({
      label: "Provider tools", value: "1 detected", wanting: false
    });
    expect(facts(room({ engines: [local] }), [], [], null)[0]).toMatchObject({ value: "0 detected", wanting: false });
  });

  it("gives each fact a destination", () => {
    for (const fact of facts(room(), ["/Users/a/Downloads"], [agent()], null)) {
      expect(fact.go.length).toBeGreaterThan(0);
      expect(fact.value.length).toBeGreaterThan(0);
    }
  });

  it("says it is still checking rather than reporting a zero it has not measured", () => {
    // Unknown and none are different facts. "0 connected" while the probe is
    // still running is an assertion nobody made.
    const [engines, folders, agents] = facts(null, [], null, null);

    expect(engines?.value).toBe("checking…");
    expect(agents?.value).toBe("reading briefs…");
    // Text work does not require a folder grant.
    expect(folders).toMatchObject({ value: "none granted", wanting: false });
  });

  it("marks only what is worth acting on", () => {
    // Four highlighted tiles would highlight nothing (D-027).
    const healthy = facts(room(), ["/Users/a/Downloads"], [agent()], null);

    expect(healthy.filter((fact) => fact.wanting)).toHaveLength(0);
  });

  it("points the engine fact at Engines and the folder fact at Settings", () => {
    const [engines, folders] = facts(room(), [], [agent()], null);

    expect(engines?.go).toBe("engines");
    expect(folders?.go).toBe("settings");
  });
});
