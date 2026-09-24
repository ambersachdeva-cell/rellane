import { afterEach, describe, expect, it, vi } from "vitest";
import { describeEngineRoom, readEngineRoom } from "./engine-room.js";
import { markLocalRuntimeFailed, markLocalRuntimeReady } from "../runtime-status.js";
import type { EngineRoomStatus } from "@cadrane/contracts";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * These run against whatever is installed on the machine running them, so they
 * assert the *properties* the Engine Room must hold rather than which lights
 * happen to be green. CI has none of these CLIs; this Mac has two. Both must
 * produce a screen that tells the truth.
 */
describe("the Engine Room", () => {
  it("answers for every engine without throwing, whatever is installed", async () => {
    const room = await readEngineRoom();

    expect(room.engines.length).toBeGreaterThan(0);
    expect(room.engines.map((engine) => engine.id)).toContain("claude");
    expect(room.engines.map((engine) => engine.id)).toContain("local");
    expect(room.checkedAt).toMatch(/^\d{4}-/u);
  }, 30_000);

  it("never claims a readiness it did not observe", async () => {
    const room = await readEngineRoom();

    for (const engine of room.engines) {
      if (engine.state === "ready") {
        // A green light with no probe behind it is a rumour.
        expect(engine.evidence).not.toBeNull();
        expect(engine.evidence?.result.length ?? 0).toBeGreaterThan(0);
      }
    }
  }, 30_000);

  it("gives every red light something to do about it", async () => {
    const room = await readEngineRoom();

    for (const engine of room.engines) {
      if (engine.state === "not-installed" || engine.state === "problem") {
        expect(engine.fixHint).not.toBeNull();
        expect((engine.fixHint ?? "").length).toBeGreaterThan(20);
      }
    }
  }, 30_000);

  it("puts no fix on a working row", async () => {
    // A "fix" beside something that works is noise, and noise in that column
    // trains people to stop reading it.
    const room = await readEngineRoom();

    for (const engine of room.engines.filter((candidate) => candidate.state === "ready")) {
      expect(engine.fixHint).toBeNull();
    }
  }, 30_000);

  it("reports a tool that did not answer without inventing an installation", async () => {
    const room = await readEngineRoom();

    for (const engine of room.engines) {
      if (engine.state === "not-installed") {
        // Most people have not installed most CLIs. Treating that as failure
        // teaches the reader to ignore red.
        expect(engine.summary).toMatch(/No responding/u);
        expect(engine.summary).not.toMatch(/error|failed|broken/iu);
      }
    }
  }, 30_000);

  it("treats the on-device engine as a working state in its own right", async () => {
    markLocalRuntimeReady();

    const room = await readEngineRoom();
    const local = room.engines.find((engine) => engine.id === "local");

    expect(local?.state).toBe("ready");
    expect(local?.access).toBe("on-device");
    // Someone deliberately running local-only must never be told nothing works.
    expect(room.allUnavailable).toBe(false);
  }, 30_000);

  it("says what stopped the on-device model, when something did", async () => {
    markLocalRuntimeFailed("The bundled runtime did not bind its port.");

    const room = await readEngineRoom();
    const local = room.engines.find((engine) => engine.id === "local");

    expect(local?.state).toBe("problem");
    expect(local?.evidence?.result).toContain("did not bind its port");
    expect(local?.fixHint).not.toBeNull();
  }, 30_000);

  it("picks something to answer with when anything is ready", async () => {
    markLocalRuntimeReady();

    const room = await readEngineRoom();

    expect(room.active).not.toBeNull();
    const engine = room.engines.find((candidate) => candidate.id === room.active?.engineId);
    expect(engine?.state).toBe("ready");
    expect(engine?.models.some((model) => model.id === room.active?.modelId)).toBe(true);
  }, 30_000);
});

describe("the sentence in the header", () => {
  const room = (over: Partial<EngineRoomStatus> = {}): EngineRoomStatus => ({
    engines: [
      {
        id: "claude",
        label: "Claude",
        access: "subscription",
        accessLabel: "Your subscription",
        state: "ready",
        summary: "Connected.",
        fixHint: null,
        evidence: null,
        models: [
          {
            id: "sonnet",
            label: "Sonnet",
            tier: "balanced",
            tierLabel: "Balanced",
            note: "The everyday setting.",
            includedInSubscription: true
          }
        ]
      }
    ],
    active: { engineId: "claude", modelId: "sonnet" },
    checkedAt: "2026-08-31T00:00:00.000Z",
    allUnavailable: false,
    ...over
  });

  it("names what is answering rather than asserting a state", () => {
    // "Claude · Sonnet" tells a reader something. "Engine ON" does not, and
    // "Engine OFF" told them only that something was wrong.
    expect(describeEngineRoom(room())).toBe("Claude · Sonnet");
  });

  it("reports no verified model without a default", () => {
    expect(describeEngineRoom(room({ active: null, allUnavailable: true }))).toBe(
      "No verified model"
    );
  });

  it("does not invent a name when the active engine is missing from the list", () => {
    expect(
      describeEngineRoom(room({ active: { engineId: "ghost", modelId: "sonnet" } }))
    ).toBe("No verified model");
  });
});
