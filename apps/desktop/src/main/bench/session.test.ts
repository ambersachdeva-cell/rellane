import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, describeBench, runBench, type BenchSeats } from "./session.js";
import { readClaim, readVerdict } from "./roles.js";

const seats = (
  proposerReplies: readonly string[],
  adversaryReplies: readonly string[]
): BenchSeats => {
  let p = 0;
  let a = 0;
  return {
    proposer: { label: "Claude", ask: async () => proposerReplies[p++] ?? "CLAIM: nothing" },
    adversary: { label: "Gemini", ask: async () => adversaryReplies[a++] ?? "AGREE" }
  };
};

describe("two models arguing", () => {
  it("ends when the second reaches the same conclusion independently", async () => {
    const session = await runBench(
      "Is the sky blue?",
      seats(["CLAIM: Yes.\nBecause of scattering."], ["AGREE — same conclusion, and here is why."])
    );

    expect(session.outcome).toBe("agreed");
    expect(session.rounds).toBe(1);
    expect(describeBench(session)).toBe("Both agreed after one round.");
  });

  it("treats a concession as the best available outcome, not a failure", async () => {
    // Conceding is the cheapest correct result there is: the objection held and
    // the answer changed because of it.
    const session = await runBench(
      "How many files changed?",
      seats(
        ["CLAIM: Forty.", "CONCEDE — you are right, it is thirty-eight."],
        ["DISAGREE — two of those are the same file."]
      )
    );

    expect(session.outcome).toBe("corrected");
    expect(session.answer).toContain("thirty-eight");
  });

  it("says they disagree rather than presenting the longer answer as a verdict", async () => {
    const session = await runBench(
      "Which approach is better?",
      seats(
        ["CLAIM: A.", "HOLD — your objection misses the constraint.", "HOLD — still A.", "HOLD"],
        ["DISAGREE — B is better.", "DISAGREE — still B.", "DISAGREE", "DISAGREE"]
      ),
      { maxRounds: 2, maxTokens: 100_000 }
    );

    expect(session.outcome).toBe("unresolved");
    expect(describeBench(session)).toBe("They did not agree. You decide.");
  });

  it("attacks what is being claimed now, not what was claimed first", async () => {
    // The claim moves when the proposer holds but refines. Arguing with the
    // original would be arguing with something nobody is asserting any more.
    const seen: string[] = [];
    const session = await runBench("Q", {
      proposer: {
        label: "Claude",
        ask: async () => "HOLD\nCLAIM: the refined answer"
      },
      adversary: {
        label: "Gemini",
        ask: async (prompt) => {
          seen.push(prompt);
          return "DISAGREE";
        }
      }
    }, { maxRounds: 2, maxTokens: 100_000 });

    expect(session.rounds).toBe(2);
    expect(seen[1]).toContain("the refined answer");
  });
});

describe("the stop", () => {
  it("checks the budget before spending, not after", async () => {
    // Discovering the budget is blown once the tokens are gone is a report,
    // not a limit.
    const ask = vi.fn(async () => "x".repeat(8_000));
    const session = await runBench(
      "Q",
      {
        proposer: { label: "Claude", ask },
        adversary: { label: "Gemini", ask: async () => "DISAGREE" }
      },
      { maxRounds: 10, maxTokens: 2_000 }
    );

    expect(session.outcome).toBe("exhausted");
    expect(session.stoppedBecause).toContain("2,000-token budget");
  });

  it("stops at the round ceiling rather than arguing forever", async () => {
    const session = await runBench(
      "Q",
      seats(["CLAIM: A", "HOLD", "HOLD", "HOLD"], ["DISAGREE", "DISAGREE", "DISAGREE"]),
      { maxRounds: 2, maxTokens: 1_000_000 }
    );

    expect(session.rounds).toBe(2);
    expect(session.outcome).toBe("unresolved");
  });

  it("keeps the transcript when an engine dies mid-argument", async () => {
    // Those turns cost real money. Throwing them away with the error would be
    // the most expensive possible way to report a failure.
    const session = await runBench("Q", {
      proposer: { label: "Claude", ask: async () => "CLAIM: A" },
      adversary: {
        label: "Gemini",
        ask: async () => {
          throw new Error("the CLI exited with code 1");
        }
      }
    });

    expect(session.outcome).toBe("failed");
    expect(session.turns).toHaveLength(1);
    expect(session.stoppedBecause).toContain("exited with code 1");
  });

  it("counts every turn toward the bill, not just the largest", async () => {
    const session = await runBench("Q", seats(["CLAIM: A"], ["AGREE"]));

    expect(session.approxTokens).toBe(
      session.turns.reduce((sum, turn) => sum + turn.approxTokens, 0)
    );
  });
});

describe("reading what a model wrote", () => {
  it("is conservative about verdicts it does not recognise", () => {
    // Mis-reading a hedge as agreement would end a debate on a false consensus,
    // which is the one failure that makes the whole feature misleading.
    expect(readVerdict("It depends on several factors.")).toBe("unclear");
    expect(readVerdict("AGREE, and here is why")).toBe("agree");
    expect(readVerdict("DISAGREE — the second premise fails")).toBe("disagree");
  });

  it("prefers the strongest word when several appear", () => {
    // "CONCEDE ... though I did initially DISAGREE" is a concession.
    expect(readVerdict("CONCEDE — though I did DISAGREE at first")).toBe("concede");
  });

  it("pulls out the marked claim", () => {
    expect(readClaim("Some preamble\nCLAIM: forty files moved\nBecause…")).toBe(
      "forty files moved"
    );
  });

  it("falls back to the first line rather than handing over the reasoning", () => {
    // The adversary is shown the conclusion without the argument on purpose;
    // an unmarked answer must not leak the whole case.
    expect(readClaim("Forty files moved.\nBecause the manifest says so.")).toBe(
      "Forty files moved."
    );
  });
});

describe("defaults", () => {
  it("ships a ceiling low enough to be affordable and high enough to be useful", () => {
    expect(DEFAULT_LIMITS.maxRounds).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_LIMITS.maxRounds).toBeLessThanOrEqual(4);
    expect(DEFAULT_LIMITS.maxTokens).toBeGreaterThan(10_000);
  });
});

describe("reading a verdict out of ordinary prose", () => {
  it("does not find HOLD inside withholding", () => {
    // These arguments are about an Indian business ledger, where TDS
    // withholding is everyday vocabulary. Substring matching recorded a model
    // discussing it as holding its position.
    expect(readVerdict("The TDS withholding was calculated correctly.")).toBe("unclear");
    expect(readVerdict("That is below the threshold agreed with the stakeholder.")).toBe("unclear");
  });

  it("does not read a refusal to agree as agreement", () => {
    // The one failure that makes the whole feature misleading rather than
    // merely wrong: the owner is told two independent models concurred when one
    // said the opposite.
    expect(readVerdict("I do not agree with that reading.")).toBe("unclear");
    expect(readVerdict("I cannot agree — the second premise fails.")).toBe("unclear");
    expect(readVerdict("I will never concede that point.")).toBe("unclear");
  });

  it("still reads the verdicts the models are told to write", () => {
    // Loosening nothing: the instructed tokens must still land.
    expect(readVerdict("AGREE — same conclusion.")).toBe("agree");
    expect(readVerdict("DISAGREE, because the manifest says otherwise.")).toBe("disagree");
    expect(readVerdict("CONCEDE — you are right.")).toBe("concede");
    expect(readVerdict("HOLD. My objection stands.")).toBe("hold");
  });

  it("finds a claim written on the line after the marker", () => {
    // `CLAIM:` alone returned an empty string, and the adversary was handed
    // "Its conclusion: " and asked to argue with nothing.
    expect(readClaim("CLAIM:\nForty files moved overnight.\nBecause…")).toBe(
      "Forty files moved overnight."
    );
  });
});
