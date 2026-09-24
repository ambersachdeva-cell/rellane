import { describe, expect, it } from "vitest";
import { allAgents, findAgent, rehydrate, SHIPPED_IDS, type StoredBrief } from "./roster.js";

const FOLDERS = ["/Users/a/Downloads"];

const written = (over: Partial<StoredBrief> = {}): StoredBrief => ({
  id: "chase-payments",
  name: "Chase payments",
  purpose: "Find who still owes and draft a reminder",
  ...over
});

describe("agents the owner wrote", () => {
  it("appear alongside the ones that ship, shipped first", () => {
    const all = allAgents(FOLDERS, [written()]);

    expect(all).toHaveLength(4);
    expect(all.slice(0, 3).map((brief) => brief.id)).toEqual(SHIPPED_IDS);
    expect(all[3]?.name).toBe("Chase payments");
  });

  it("cannot redefine an agent that ships", () => {
    // A hand-edited settings file could otherwise replace "Filing clerk" with
    // something pointing at a different folder and a different outbound policy,
    // under a name the owner trusts because they recognise it.
    const all = allAgents(FOLDERS, [
      written({ id: "filing-clerk", name: "Filing clerk", outbound: "ask" })
    ]);

    expect(all).toHaveLength(3);
    expect(all.find((brief) => brief.id === "filing-clerk")?.outbound).toBe("never");
  });

  it("cannot be listed twice under one id", () => {
    const all = allAgents(FOLDERS, [written(), written({ name: "Impostor" })]);

    expect(all).toHaveLength(4);
    expect(all[3]?.name).toBe("Chase payments");
  });

  it("resolves through the same path everything else uses", () => {
    // Four call sites used to resolve agents independently, which is four
    // chances for the screen to show one brief and the runtime to run another.
    expect(findAgent(FOLDERS, [written()], "chase-payments")?.name).toBe("Chase payments");
    expect(findAgent(FOLDERS, [], "chase-payments")).toBeUndefined();
  });
});

describe("a stored brief is untrusted", () => {
  it("clamps a hand-edited step count instead of honouring it", () => {
    // Settings are JSON on disk: hand-editable, restorable from an old backup.
    // `maxSteps: 100000` must not buy a hundred thousand model calls because it
    // arrived as data rather than as an argument.
    const brief = rehydrate(written({ maxSteps: 100_000, maxMinutes: 10_000 }));

    expect(brief?.limits.maxSteps).toBeLessThanOrEqual(60);
    expect(brief?.limits.maxMinutes).toBeLessThanOrEqual(60);
  });

  it("refuses a negative or nonsensical budget rather than passing it through", () => {
    const brief = rehydrate(written({ maxSteps: -5, maxMinutes: 0 }));

    expect(brief?.limits.maxSteps).toBeGreaterThanOrEqual(1);
    expect(brief?.limits.maxMinutes).toBeGreaterThanOrEqual(1);
  });

  it("treats any unrecognised outbound value as never", () => {
    // The failure direction that matters. `"maybe"` or a typo must not become
    // permission to prepare something to send.
    expect(rehydrate(written({ outbound: "always" }))?.outbound).toBe("never");
    expect(rehydrate(written({ outbound: "ask" }))?.outbound).toBe("ask");
    expect(rehydrate(written({}))?.outbound).toBe("never");
  });

  it("falls back to the cheapest tier for an unknown one", () => {
    expect(rehydrate(written({ tier: "gpt-9" }))?.engine.tier).toBe("fast");
    expect(rehydrate(written({ tier: "frontier" }))?.engine.tier).toBe("frontier");
  });

  it("drops a brief with no id or no name, and keeps its neighbours", () => {
    // One corrupt entry must not hide the other nine.
    const all = allAgents(FOLDERS, [
      { id: "", name: "nameless", purpose: "p" },
      written({ id: "b", name: "   " }),
      written()
    ]);

    expect(all).toHaveLength(4);
    expect(all[3]?.id).toBe("chase-payments");
  });

  it("truncates rather than storing unbounded text", () => {
    const brief = rehydrate(written({ name: "x".repeat(500), instructions: "y".repeat(99_999) }));

    expect(brief?.name.length).toBeLessThanOrEqual(60);
    expect(brief?.instructions.length).toBeLessThanOrEqual(4_000);
  });
});

describe("a settings file somebody edited by hand", () => {
  it("survives a purpose that is not a string", () => {
    // `?? ""` catches only null and undefined, so a number reached `.trim()`
    // and threw — during startup, from a file the owner can edit, taking the
    // window down with it.
    const brief = rehydrate({ ...written(), purpose: 42 as unknown as string });

    expect(brief?.purpose).toBe("No purpose written yet");
  });

  it("survives entries that are not objects at all", () => {
    const all = allAgents(FOLDERS, [
      null as unknown as StoredBrief,
      "nonsense" as unknown as StoredBrief,
      written()
    ]);

    expect(all).toHaveLength(4);
  });

  it("reserves every shipped id even if that agent was not built", () => {
    // Derived only from `builtInAgents`, an omitted shipped agent would stop
    // being reserved and a stored brief could claim the trusted name.
    for (const id of SHIPPED_IDS) {
      const all = allAgents([], [written({ id, name: "Impostor" })]);
      expect(all.find((brief) => brief.id === id)?.name).not.toBe("Impostor");
    }
  });
});
