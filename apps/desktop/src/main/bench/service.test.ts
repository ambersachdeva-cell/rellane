import { describe, expect, it, vi } from "vitest";
import type { EngineRoomStatus } from "@cadrane/contracts";

const readEngineRoom = vi.fn<() => Promise<EngineRoomStatus>>();
const askEngine = vi.fn();

vi.mock("../subscription-brain/engine-room.js", () => ({
  readEngineRoom: () => readEngineRoom()
}));
vi.mock("../agents/ask.js", () => ({
  askEngine: (input: unknown) => askEngine(input)
}));

const { runBenchOnThisMac, declineUnreviewedBench } = await import("./service.js");

const engine = (
  id: string,
  label: string,
  state: "ready" | "not-installed",
  tier: "frontier" | "fast" = "frontier"
) => ({
  id,
  label,
  access: "subscription" as const,
  accessLabel: "Your subscription",
  state,
  summary: "s",
  fixHint: null,
  evidence: null,
  models: [
    {
      id: `${id}-model`,
      label: "Model",
      tier,
      tierLabel: "Frontier",
      note: "n",
      includedInSubscription: true
    }
  ]
});

const room = (engines: ReturnType<typeof engine>[]): EngineRoomStatus => ({
  engines,
  active: null,
  checkedAt: "2026-09-01T00:00:00.000Z",
  allUnavailable: engines.every((candidate) => candidate.state !== "ready")
});

describe("seating the Bench", () => {
  it("refuses the live unreviewed entry before discovering or asking either available subscription", () => {
    readEngineRoom.mockClear(); askEngine.mockClear();
    readEngineRoom.mockResolvedValue(room([engine("claude", "Claude", "ready"), engine("gemini", "Gemini", "ready")]));
    const result = declineUnreviewedBench("A synthetic decision");
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("outgoing review for each message");
    expect(result.turns).toEqual([]);
    expect(result.spend.totalTokens).toBe(0);
    expect(readEngineRoom).not.toHaveBeenCalled();
    expect(askEngine).not.toHaveBeenCalled();
  });
  it("refuses when only one engine is ready, and says why two are needed", async () => {
    // The whole feature is two *different* subscriptions. Falling back to one
    // model arguing with itself would produce agreement that looks like
    // corroboration and is not — the same blind spots, twice, at double cost.
    readEngineRoom.mockResolvedValue(
      room([engine("claude", "Claude", "ready"), engine("gemini", "Gemini", "not-installed")])
    );

    const result = await runBenchOnThisMac("Should we?");

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("two different subscriptions");
    expect(result.problem).toContain("Claude");
    expect(askEngine).not.toHaveBeenCalled();
  });

  it("refuses with a fix when nothing is ready", async () => {
    readEngineRoom.mockResolvedValue(room([engine("claude", "Claude", "not-installed")]));

    const result = await runBenchOnThisMac("Should we?");

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("Open Engines");
  });

  it("seats two different engines and never the same one twice", async () => {
    readEngineRoom.mockResolvedValue(
      room([engine("claude", "Claude", "ready"), engine("gemini", "Gemini", "ready")])
    );
    askEngine.mockImplementation(async ({ engineId }: { engineId: string }) =>
      engineId === "claude" ? "CLAIM: yes." : "AGREE — for the same reason."
    );

    const result = await runBenchOnThisMac("Should we?");

    expect(result.ok).toBe(true);
    expect(result.seats).toEqual({ proposer: "Claude Model", adversary: "Gemini Model" });
    const asked = askEngine.mock.calls.map((call) => (call[0] as { engineId: string }).engineId);
    expect(new Set(asked).size).toBe(2);
  });

  it("does not print the maker's name twice", async () => {
    // "Gemini" + "Gemini Pro" was rendering as "Gemini Gemini Pro" on the
    // transcript. Observed in the shipped app, not in a test.
    readEngineRoom.mockResolvedValue(
      room([
        { ...engine("gemini", "Gemini", "ready"), models: [{ ...engine("gemini", "Gemini", "ready").models[0]!, label: "Gemini Pro" }] },
        { ...engine("claude", "Claude", "ready"), models: [{ ...engine("claude", "Claude", "ready").models[0]!, label: "Opus" }] }
      ])
    );
    askEngine.mockResolvedValue("CLAIM: yes.");

    const result = await runBenchOnThisMac("Should we?");

    expect([result.seats?.proposer, result.seats?.adversary]).toEqual(
      expect.arrayContaining(["Gemini Pro", "Claude Opus"])
    );
  });

  it("returns a failure as a result, never as a rejection", async () => {
    // A screen with a reason on it, not an exception nobody sees.
    readEngineRoom.mockResolvedValue(
      room([engine("claude", "Claude", "ready"), engine("gemini", "Gemini", "ready")])
    );
    askEngine.mockRejectedValue(new Error("the CLI exited with code 1"));

    const result = await runBenchOnThisMac("Should we?");

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("failed");
    expect(result.stoppedBecause).toContain("exited with code 1");
  });
});
