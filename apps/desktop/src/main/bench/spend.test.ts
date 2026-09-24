/**
 * What an argument cost, per side, while it is still running.
 *
 * The done-when is *"the price of an argument is known before it finishes"*. A
 * figure printed at the end is a receipt, not a meter — by then the money is
 * spent, which is the opposite of knowing the price.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, runBench, spendOf, type BenchSpend, type BenchTurn } from "./session.js";

const turn = (seat: BenchTurn["seat"], approxTokens: number): BenchTurn => ({
  seat,
  engineLabel: "Claude",
  text: "x",
  verdict: null as unknown as BenchTurn["verdict"],
  approxTokens
});

describe("what each side spent", () => {
  it("is counted per seat, not only in total", () => {
    // An argument where one side wrote four times as much as the other is not a
    // balanced argument, and a combined figure hides exactly that.
    const spend = spendOf([
      turn("proposer", 400),
      turn("adversary", 100),
      turn("proposer", 400)
    ]);

    expect(spend.proposerTokens).toBe(800);
    expect(spend.adversaryTokens).toBe(100);
    expect(spend.totalTokens).toBe(900);
  });

  it("never reads past the budget", () => {
    // The budget is checked before spending, not during, so a final turn can
    // carry the total past it. A meter reading 104% looks like a bug rather
    // than like a budget doing its job.
    const spend = spendOf([turn("proposer", DEFAULT_LIMITS.maxTokens * 2)]);

    expect(spend.fraction).toBe(1);
  });

  it("is zero, not undefined, before anything has happened", () => {
    expect(spendOf([])).toEqual<BenchSpend>({
      proposerTokens: 0,
      adversaryTokens: 0,
      totalTokens: 0,
      fraction: 0
    });
  });
});

describe("the meter while it runs", () => {
  it("reports before the argument has finished", async () => {
    const seen: number[] = [];

    await runBench(
      "Is this right?",
      {
        proposer: { label: "A", ask: async () => "I propose the thing." },
        adversary: { label: "B", ask: async () => "AGREE, that is right." }
      },
      DEFAULT_LIMITS,
      (_turn, spend) => seen.push(spend.totalTokens)
    );

    expect(seen.length).toBeGreaterThan(1);
    // Monotonic: a meter that went down would mean turns were being forgotten.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("is not allowed to break the argument it is watching", async () => {
    // The turns that already happened cost real money and must not be thrown
    // away because an observer threw.
    const session = await runBench(
      "Is this right?",
      {
        proposer: { label: "A", ask: async () => "I propose the thing." },
        adversary: { label: "B", ask: async () => "AGREE, that is right." }
      },
      DEFAULT_LIMITS,
      () => {
        throw new Error("the meter is broken");
      }
    );

    expect(session.turns.length).toBeGreaterThan(0);
  });
});
