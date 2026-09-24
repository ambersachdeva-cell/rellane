import { describe, expect, it } from "vitest";
import type { Seat } from "./accounts.js";
import { Governor } from "./governor.js";

const seat = (accountId: string, family: "gemini" | "claude" | "open" = "gemini"): Seat => ({
  accountId,
  providerId: "antigravity",
  modelId: family === "gemini" ? "gemini-3.8-flash-high" : "claude-opus-4-6-thinking",
  family,
  label: `${family} · ${accountId}`
});

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(start = 1_700_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("the hole a recorded-spend ceiling leaves", () => {
  it("refuses a fourth seat while three are still running and have reported nothing", () => {
    // This is the failure the whole module exists for: vendor CLIs report
    // nothing for up to half an hour, so a governor reading only recorded spend
    // admits every seat and learns it was broke long after it mattered.
    const time = clock();
    const gov = new Governor({ maxInFlight: 3, maxInFlightPerPool: 3 }, time.now);

    for (const account of ["a", "b", "c"]) {
      expect(gov.admit(seat(account), "case1", 1000).ok).toBe(true);
    }
    // Nobody has finished. Nothing has been recorded. It still refuses.
    const fourth = gov.admit(seat("d"), "case1", 1000);
    expect(fourth.ok).toBe(false);
    expect(gov.running).toBe(3);
  });

  it("charges a seat the moment it starts, not when it finishes", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1000, maxInFlightPerPool: 5 }, time.now);
    const one = seat("a");

    expect(gov.remainingToday(one)).toBe(1000);
    gov.admit(one, "case1", 900);
    // Still in flight, reported nothing — and the budget already reflects it.
    expect(gov.remainingToday(one)).toBe(100);
  });
});

describe("pools are separate budgets", () => {
  it("lets Claude answer when the Gemini pool on the same account is spent", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1000, maxInFlight: 9 }, time.now);

    gov.admit(seat("a", "gemini"), "case1", 1000);
    expect(gov.admit(seat("a", "gemini"), "case1", 100).ok).toBe(false);
    // Same account, different pool. Marking the whole account spent would strand
    // an untouched quota sitting right beside it (D-091).
    expect(gov.admit(seat("a", "claude"), "case1", 100).ok).toBe(true);
  });

  it("names the pool that ran out and what is still possible", () => {
    const time = clock();
    // Concurrency is checked before budget, so the first seat is finished here
    // to isolate the refusal this test is actually about.
    const gov = new Governor({ dailyPerPool: 100 }, time.now);
    const first = gov.admit(seat("work"), "case1", 100);
    if (!first.ok) return;
    gov.finished(first.ticket, 100);

    const refused = gov.admit(seat("work"), "case1", 50);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.pool).toBe("work:gemini");
    // The useful part of "no" is what to do next.
    expect(refused.because).toMatch(/other accounts|local model/iu);
  });

  it("holds one seat per pool by default, so one subscription is not hammered", () => {
    const time = clock();
    const gov = new Governor({}, time.now);

    expect(gov.admit(seat("a"), "case1", 1).ok).toBe(true);
    const second = gov.admit(seat("a"), "case1", 1);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.because).toMatch(/another account/iu);
  });
});

describe("reconciling an estimate", () => {
  it("gives back what an over-cautious estimate did not spend", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1000, maxInFlightPerPool: 5 }, time.now);
    const one = seat("a");

    const admitted = gov.admit(one, "case1", 900);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    gov.finished(admitted.ticket, 100);
    // A reservation never given back is a budget that shrinks all day for
    // nothing.
    expect(gov.remainingToday(one)).toBe(900);
    expect(gov.running).toBe(0);
  });

  it("keeps the overspend when a seat cost more than it said", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1000, maxInFlightPerPool: 5 }, time.now);
    const one = seat("a");

    const admitted = gov.admit(one, "case1", 100);
    if (!admitted.ok) return;
    gov.finished(admitted.ticket, 600);

    expect(gov.remainingToday(one)).toBe(400);
  });

  it("does not charge twice for a seat the wall clock already released", () => {
    const time = clock();
    const gov = new Governor({ dailyPerPool: 1000, wallClockMs: 1000, maxInFlightPerPool: 5 }, time.now);
    const one = seat("a");

    const admitted = gov.admit(one, "case1", 300);
    if (!admitted.ok) return;

    time.advance(2000);
    expect(gov.running).toBe(0);

    // It really did spend the 300; reconciling now must not add it again.
    gov.finished(admitted.ticket, 300);
    expect(gov.remainingToday(one)).toBe(700);
  });
});

describe("a hung seat", () => {
  it("stops holding its pool closed once it outruns the wall clock", () => {
    const time = clock();
    const gov = new Governor({ wallClockMs: 60_000 }, time.now);

    gov.admit(seat("a"), "case1", 10);
    expect(gov.admit(seat("a"), "case1", 10).ok).toBe(false);

    time.advance(61_000);
    // The vendor's print timeout is the vendor's patience, not our budget.
    expect(gov.admit(seat("a"), "case1", 10).ok).toBe(true);
  });
});

describe("a case has its own ceiling", () => {
  it("stops a single case spending across every pool it can reach", () => {
    const time = clock();
    const gov = new Governor(
      { perCase: 500, dailyPerPool: 100_000, maxInFlight: 9, maxInFlightPerPool: 9 },
      time.now
    );

    expect(gov.admit(seat("a", "gemini"), "runaway", 300).ok).toBe(true);
    expect(gov.admit(seat("b", "claude"), "runaway", 300).ok).toBe(false);
    // A different case is unaffected — the ceiling is per case, not global.
    expect(gov.admit(seat("b", "claude"), "another", 300).ok).toBe(true);
  });

  it("will not let a running case raise its own ceiling", () => {
    const time = clock();
    const gov = new Governor({ perCase: 100 }, time.now);
    gov.admit(seat("a"), "case1", 100);

    // There is no method to call. That is the assertion: the only way past this
    // limit is a different Governor, constructed by the owner's own settings.
    const asRecord = gov as unknown as Record<string, unknown>;
    for (const name of ["setLimits", "raise", "allowAll", "disable", "override"]) {
      expect(asRecord[name]).toBeUndefined();
    }
  });
});

describe("a fresh day", () => {
  it("starts the pool budget again", () => {
    const time = clock(Date.UTC(2026, 8, 5, 6, 0, 0));
    const gov = new Governor({ dailyPerPool: 1000, maxInFlightPerPool: 5 }, time.now);
    const one = seat("a");

    const admitted = gov.admit(one, "case1", 1000);
    if (!admitted.ok) return;
    gov.finished(admitted.ticket, 1000);
    expect(gov.remainingToday(one)).toBe(0);

    time.advance(48 * 60 * 60 * 1000);
    expect(gov.remainingToday(one)).toBe(1000);
  });
});
