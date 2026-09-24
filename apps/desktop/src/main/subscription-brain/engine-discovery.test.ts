/** A version string must not admit a provider request or manufacture model access. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverProvider } from "./cli-discovery.js";
import { describeEngineRoom, readEngineRoom } from "./engine-room.js";
import { markLocalRuntimeFailed, markLocalRuntimeReady } from "../runtime-status.js";
import { newBrief } from "../agents/brief.js";
import { selectEngine } from "../agents/select.js";
import { roster } from "./seats.js";

vi.mock("./cli-discovery.js", () => ({ discoverProvider: vi.fn() }));

beforeEach(() => {
  markLocalRuntimeFailed("No model in this fictional profile.");
  vi.mocked(discoverProvider).mockImplementation(async definition => ({
    providerId: definition.id, label: definition.label,
    executablePath: `/fictional/${definition.binary}`, version: "9.0-fixture"
  }));
});
afterEach(() => { vi.resetAllMocks(); markLocalRuntimeFailed("Test finished."); });

describe("provider discovery is not request readiness", () => {
  it("retains presence evidence without admitting a default, pinned agent or account seat", async () => {
    const room = await readEngineRoom();
    const providers = room.engines.filter(engine => engine.access === "subscription");
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(provider.state).toBe("detected");
      expect(provider.models).toEqual([]);
      expect(provider.evidence?.result).toBe("9.0-fixture");
      expect(provider.summary).not.toContain("signed in as you");
    }
    expect(room.active).toBeNull();
    expect(room.allUnavailable).toBe(true);
    expect(selectEngine(room, newBrief({ id: "general", name: "General", purpose: "A fictional draft", tier: "fast" })).ok).toBe(false);
    expect(selectEngine(room, newBrief({ id: "pinned", name: "Pinned", purpose: "A fictional draft", pinnedEngineId: "claude" })).ok).toBe(false);
    expect(roster(room, [{ id: "fixture-account", label: "Fixture", providerId: "antigravity", profileDir: "/fictional/profile" }]).seats).toEqual([]);
  });

  it("keeps the observed local runtime usable without preferring a merely detected provider", async () => {
    markLocalRuntimeReady();
    const room = await readEngineRoom();
    expect(room.active?.engineId).toBe("local");
    expect(room.allUnavailable).toBe(false);
    const selected = selectEngine(room, newBrief({ id: "local", name: "Local", purpose: "A fictional draft", tier: "on-device" }));
    expect(selected.ok && selected.selection.engineId).toBe("local");
  });

  it("keeps a failed local model out of the verified list and raw startup details in evidence", async () => {
    markLocalRuntimeFailed("ENOENT: /fictional/missing/model.gguf");
    const local = (await readEngineRoom()).engines.find(engine => engine.id === "local");
    expect(local?.state).toBe("problem");
    expect(local?.models).toEqual([]);
    expect(local?.summary).not.toContain("/fictional");
    expect(local?.summary).not.toContain("ENOENT");
    expect(local?.evidence?.result).toBe("ENOENT: /fictional/missing/model.gguf");
  });

  it("replaces earlier detection with absence when a fresh check cannot find the tool", async () => {
    const before = await readEngineRoom();
    expect(before.engines.some(engine => engine.state === "detected")).toBe(true);
    vi.mocked(discoverProvider).mockResolvedValue(null);
    const after = await readEngineRoom();
    expect(after.engines.filter(engine => engine.access === "subscription").every(engine => engine.state === "not-installed")).toBe(true);
    expect(after.active).toBeNull();
  });

  it("does not claim installation after a failed presence check, or name an unready active entry", async () => {
    vi.mocked(discoverProvider).mockRejectedValue(new Error("Presence check refused."));
    const room = await readEngineRoom();
    expect(room.engines.filter(engine => engine.access === "subscription").every(engine =>
      engine.state === "problem" && !engine.summary.includes("is installed"))).toBe(true);
    const stale = { ...room, active: { engineId: "claude", modelId: "sonnet" } };
    expect(describeEngineRoom(stale)).toBe("No verified model");
  });
});
