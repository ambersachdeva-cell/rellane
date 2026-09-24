import { describe, expect, it } from "vitest";
import type { Seat, SeatAccount } from "./accounts.js";
import { Governor } from "./governor.js";
import { ledger, ledgerSentence } from "./ledger.js";

const account = (id: string, label: string): SeatAccount => ({
  id,
  label,
  providerId: "antigravity",
  profileDir: `/tmp/${id}`
});

const seat = (accountId: string, family: "gemini" | "claude" | "open"): Seat => ({
  accountId,
  providerId: "antigravity",
  modelId: family === "gemini" ? "gemini-3.8-flash-high" : "claude-opus-4-6-thinking",
  family,
  label: `${family} · ${accountId}`
});

function clock(start = 1_700_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("the number the pitch turns on", () => {
  it("reports three logins as six separate budgets", () => {
    const time = clock();
    const gov = new Governor({}, time.now);
    const view = ledger(
      [account("a", "personal"), account("b", "work"), account("c", "studio")],
      [],
      gov
    );

    expect(view.accounts).toBe(3);
    // Claude and Gemini bill against different quotas inside one login, so
    // reporting per account would understate what the owner actually has.
    expect(view.pools).toBe(9);
    expect(ledgerSentence(view)).toContain("9 separate budgets");
  });

  it("says so plainly when nothing is docked, and names what still answers", () => {
    const view = ledger([], [], new Governor({}, clock().now));
    expect(view.accounts).toBe(0);
    expect(ledgerSentence(view)).toMatch(/local model/iu);
  });
});

describe("what it refuses to claim", () => {
  it("reports an unobserved pool as not measured rather than as full", () => {
    const time = clock();
    const view = ledger([account("a", "personal")], [], new Governor({}, time.now));

    // A vendor does not publish remaining quota. Printing a full bar here would
    // be a claim dressed as a default, which is the thing principle 4 forbids.
    expect(view.lines.every((line) => line.measured === false)).toBe(true);
  });

  it("counts a pool as measured once this Mac has actually spent against it", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1000 }, time.now);
    gov.admit(seat("a", "gemini"), "case1", 250);

    const view = ledger([account("a", "personal")], [], gov);
    const gemini = view.lines.find((line) => line.family === "gemini");

    expect(gemini?.measured).toBe(true);
    expect(gemini?.spentToday).toBe(250);
    expect(gemini?.remainingToday).toBe(750);
  });

  it("still lists an account that is signed out, marked unavailable", () => {
    const time = clock();
    // Omitting it would silently shrink the number the whole pitch rests on,
    // and a login the owner added and then signed out of is a fact they need.
    const view = ledger([account("a", "personal")], [], new Governor({}, time.now));

    expect(view.lines).toHaveLength(3);
    expect(view.lines.every((line) => line.unavailable)).toBe(true);
  });
});

describe("pools run out separately", () => {
  it("leaves Claude untouched when Gemini on the same login is spent", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 100, maxInFlight: 9 }, time.now);
    gov.admit(seat("a", "gemini"), "case1", 100);

    const view = ledger([account("a", "personal")], [seat("a", "gemini")], gov);
    const gemini = view.lines.find((line) => line.family === "gemini");
    const claude = view.lines.find((line) => line.family === "claude");

    expect(gemini?.remainingToday).toBe(0);
    expect(claude?.remainingToday).toBe(100);
    expect(view.allSpent).toBe(false);
  });

  it("distinguishes every budget spent from none configured", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 10, maxInFlight: 9, maxInFlightPerPool: 9 }, time.now);
    for (const family of ["gemini", "claude", "open"] as const) {
      gov.admit(seat("a", family), "case1", 10);
    }

    const spent = ledger([account("a", "personal")], [], gov);
    expect(spent.allSpent).toBe(true);
    expect(ledgerSentence(spent)).toMatch(/spent for today/iu);

    // An empty ledger is a different state and must not read as exhausted.
    expect(ledger([], [], new Governor({}, time.now)).allSpent).toBe(false);
  });
});

describe("the floor", () => {
  it("always reports the local model as available, even with everything spent", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1, maxInFlight: 9, maxInFlightPerPool: 9 }, time.now);
    gov.admit(seat("a", "gemini"), "c", 1);

    // "Rellane always works; your subscriptions make it faster." A spent ledger
    // is an inconvenience, not an outage, and the screen has to say so.
    expect(ledger([account("a", "p")], [], gov).localAlwaysAvailable).toBe(true);
  });
});

describe("what is running", () => {
  it("counts seats in flight across every pool", () => {
    const time = clock();
    const gov = new Governor({ maxInFlight: 9, maxInFlightPerPool: 9 }, time.now);
    gov.admit(seat("a", "gemini"), "c", 1);
    gov.admit(seat("b", "claude"), "c", 1);

    expect(ledger([account("a", "p"), account("b", "w")], [], gov).working).toBe(2);
  });
});
