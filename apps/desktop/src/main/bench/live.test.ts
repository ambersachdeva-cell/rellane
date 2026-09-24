import { describe, expect, it } from "vitest";
import { runBench } from "./session.js";
import { askEngine } from "../agents/ask.js";

/**
 * The Bench against the real engines on this machine.
 *
 * Skipped unless BENCH_LIVE=1, because it spends the owner's subscription. It
 * exists so the claim "Opus and Gemini argue and reach a better answer" is
 * something observed rather than asserted.
 */
describe("the Bench, live", () => {
  it.runIf(process.env["BENCH_LIVE"] === "1")(
    "runs Claude against Gemini and reaches an outcome",
    async () => {
      const question =
        "Rellane is a local-first macOS app. Its agents can currently read a folder listing but cannot read file contents. Should the next capability be (A) reading file contents, or (B) writing files under the existing plan-sheet approval? Pick one and justify it in under 120 words.";

      const session = await runBench(
        question,
        {
          proposer: {
            label: "Claude Opus",
            ask: (prompt) =>
              askEngine({
                engineId: "claude",
                modelId: "opus",
                system: "You are arguing a product decision. Be decisive and brief.",
                prompt,
                signal: AbortSignal.timeout(180_000)
              })
          },
          adversary: {
            label: "Gemini Pro",
            ask: (prompt) =>
              askEngine({
                engineId: "antigravity",
                modelId: "gemini-3.1-pro-high",
                system: "You are stress-testing a product decision. Be specific.",
                prompt,
                signal: AbortSignal.timeout(180_000)
              })
          }
        },
        { maxRounds: 2, maxTokens: 40_000 }
      );

      console.log(`\n════ BENCH · ${session.outcome} · ${session.stoppedBecause}`);
      console.log(`════ ${session.turns.length} turns, ~${session.approxTokens} tokens\n`);
      for (const turn of session.turns) {
        console.log(`──── ${turn.seat} (${turn.engineLabel}) → ${turn.verdict}`);
        console.log(turn.text.slice(0, 900));
        console.log();
      }

      expect(session.turns.length).toBeGreaterThan(0);
      expect(["agreed", "corrected", "unresolved", "exhausted"]).toContain(session.outcome);
    },
    600_000
  );
});
