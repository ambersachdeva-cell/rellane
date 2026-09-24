/**
 * Who can answer.
 *
 * A seat is an account plus a model, because that is the thing that answers a
 * question — and because two accounts of one provider are two seats rather than
 * one green light.
 */

import { describe, expect, it } from "vitest";
import type { EngineRoomStatus, EngineModel } from "@cadrane/contracts";
import type { SeatAccount } from "./accounts.js";
import { poolOf } from "./accounts.js";
import { firstSeat, roomSeats, roster, seatNamed, shortModel, PREFERRED } from "./seats.js";

const model = (id: string): EngineModel => ({
  id,
  label: id,
  tier: "balanced",
  tierLabel: "Balanced",
  note: "n",
  includedInSubscription: true
});

const room = (ready = true): EngineRoomStatus => ({
  engines: [
    {
      id: "antigravity",
      label: "Antigravity",
      access: "subscription",
      accessLabel: "Your subscription",
      state: ready ? "ready" : "not-installed",
      summary: "s",
      fixHint: null,
      evidence: null,
      models: [
        model(PREFERRED.gemini),
        model(PREFERRED.claude),
        model(PREFERRED.open)
      ]
    }
  ],
  active: null,
  checkedAt: "2026-09-03T00:00:00.000Z",
  allUnavailable: !ready
});

const account = (id: string, label: string): SeatAccount => ({
  id,
  providerId: "antigravity",
  label,
  profileDir: `/Users/amber/agy-setup/config${id}`
});

const three = [account("1", "work"), account("2", "personal"), account("3", "second")];

describe("the roster", () => {
  it("gives every account its own seats", () => {
    // The thing one green light per provider could never express.
    const seats = roster(room(), three).seats;

    expect(seats).toHaveLength(9);
    expect(new Set(seats.map((seat) => seat.accountId)).size).toBe(3);
  });

  it("offers the cheapest pool first", () => {
    // Opus is overflow, not a better first choice: it costs a different pool,
    // and that is the pool worth still having when the cheap one runs out.
    expect(firstSeat(room(), three)?.modelId).toBe(PREFERRED.gemini);
  });

  it("lists nothing for an account whose provider is not ready", () => {
    // A seat naming an unavailable engine is one that fails when asked, which
    // is worse than one that was never offered.
    expect(roster(room(false), three).seats).toEqual([]);
  });
});

describe("a spent quota", () => {
  it("takes one family, not the whole account", () => {
    // Marking the account spent when its Gemini ran out strands an untouched
    // Opus budget sitting right beside it.
    const spent = new Set([poolOf({ accountId: "1", family: "gemini" })]);

    const seats = roster(room(), three, spent).seats;

    expect(seats.some((seat) => seat.accountId === "1" && seat.family === "claude")).toBe(true);
    expect(seats.some((seat) => seat.accountId === "1" && seat.family === "gemini")).toBe(false);
    // And the other accounts' Gemini is untouched.
    expect(seats.some((seat) => seat.accountId === "2" && seat.family === "gemini")).toBe(true);
  });

  it("says everything is spent, distinctly from having no accounts", () => {
    // One means the owner has not added an account; the other means they have
    // and every budget is gone. The screen says different things about those.
    const everything = new Set(
      roster(room(), three).seats.map((seat) => poolOf(seat))
    );

    expect(roster(room(), three, everything).allSpent).toBe(true);
    expect(roster(room(), []).allSpent).toBe(false);
  });
});

describe("asking the room", () => {
  it("prefers different models over the same model three times", () => {
    // Asking one model on three accounts costs three calls to hear the same
    // answer with different quota attached.
    const picked = roomSeats(room(), three, new Set(), 3);

    expect(new Set(picked.map((seat) => seat.modelId)).size).toBe(3);
  });

  it("falls back to other accounts once the models run out", () => {
    const picked = roomSeats(room(), three, new Set(), 5);

    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((seat) => seat.accountId)).size).toBeGreaterThan(1);
  });
});

describe("naming a seat", () => {
  it("finds the one the owner said", () => {
    const seats = roster(room(), three).seats;

    expect(seatNamed(seats, "Opus, what do you think?")?.family).toBe("claude");
    // Nobody says "Gemini 3.8" out loud. A matcher needing the version would
    // silently fan out to the whole room instead of asking the one they meant.
    expect(seatNamed(seats, "ask gemini about this")?.family).toBe("gemini");
    expect(seatNamed(seats, "gpt, have a look")?.family).toBe("open");
    // The version wins when it is given: they meant that one.
    expect(seatNamed(seats, "ask Gemini 3.8")?.modelId).toBe(PREFERRED.gemini);
  });

  it("is not matched inside another word", () => {
    // The same rule the party matcher follows, for the same reason.
    expect(seatNamed(roster(room(), three).seats, "the opuscule was odd")).toBeNull();
    expect(seatNamed(roster(room(), three).seats, "what do you think")).toBeNull();
  });
});

describe("what a person calls a model", () => {
  it("is short enough to sit on every answer", () => {
    expect(shortModel("gemini-3.8-flash-high")).toBe("Gemini 3.8");
    expect(shortModel("claude-opus-4-6-thinking")).toBe("Opus");
    expect(shortModel("claude-sonnet-4-6")).toBe("Sonnet");
    expect(shortModel("gpt-oss-120b-medium")).toBe("GPT-OSS");
  });
});
