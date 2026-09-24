import { describe, expect, it } from "vitest";
import { askHint, howLong } from "./AgentsView";
import { builtInAgents } from "../../main/agents/defaults.js";

/**
 * The placeholder in each agent's ask box.
 *
 * It used to be `agent.purpose`, which the row already prints two lines above —
 * so every agent said the same sentence twice, and the box taught nothing about
 * what could go in it. Caught by looking at the shipped app, not by a test.
 */
describe("what to type", () => {
  it("never repeats the purpose the row already shows", () => {
    for (const agent of builtInAgents(["/Users/a/Downloads"])) {
      expect(askHint(agent)).not.toBe(agent.purpose);
    }
  });

  it("gives every shipped agent a real example rather than the generic fallback", () => {
    // The fallback exists for agents somebody wrote themselves, where inventing
    // an example would mislead. A shipped agent has no excuse for it.
    for (const agent of builtInAgents(["/Users/a/Downloads"])) {
      expect(askHint(agent)).not.toBe("What should it do?");
    }
  });

  it("falls back rather than guessing for an agent it does not know", () => {
    expect(askHint({ id: "something-someone-wrote" })).toBe("What should it do?");
  });
});

describe("how long a run took", () => {
  it("says it in words, not decimals", () => {
    // `4.3s` is console output. D-028 removed those from surfaces a customer
    // sees — they were most of why the product read as cheap.
    expect(howLong(4_300)).toBe("4 seconds");
    expect(howLong(1_000)).toBe("1 second");
    expect(howLong(200)).toBe("instant");
  });

  it("switches to minutes rather than counting to two hundred seconds", () => {
    expect(howLong(95_000)).toBe("2 minutes");
    expect(howLong(60_000)).toBe("1 minute");
  });
});
