import { defineConfig } from "vitest/config";

/**
 * 20s, not 5s.
 *
 * The `durable/` family does real fsync-heavy disk work, and measured on this
 * machine on 2026-08-30 its slowest test takes 3.0s — 40% headroom under a 5s
 * budget. That was enough here and not enough on a shared CI runner, where two
 * of them timed out and went red without anything being broken.
 *
 * The cost of the larger budget is that a genuine hang now takes 20s to report
 * instead of 5s. That is worth paying: a suite that goes red for reasons
 * unrelated to the code is one people stop reading.
 */
const TEST_TIMEOUT = 20_000;
const EXCLUDE = ["**/dist/**", "**/node_modules/**", "**/release/**"];

/**
 * Two projects, because a component needs a DOM and nothing else should pay for
 * one.
 *
 * Until now the suite ran `.test.ts` only, so this repo had no way to test a
 * React component at all — which is how a wave of panels shipped with class
 * names no stylesheet defined, and two screens that displayed a readiness
 * nothing had observed. Neither is visible to the typechecker, and neither
 * would have survived a render test.
 */
export default defineConfig({
  test: {
    pool: "threads",
    maxWorkers: 2,
    testTimeout: TEST_TIMEOUT,
    projects: [
      {
        test: {
          name: "node",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: EXCLUDE,
          environment: "node",
          testTimeout: TEST_TIMEOUT
        }
      },
      {
        test: {
          name: "dom",
          include: ["apps/**/*.test.tsx"],
          exclude: EXCLUDE,
          environment: "jsdom",
          setupFiles: ["./test/dom-setup.ts"],
          testTimeout: TEST_TIMEOUT
        }
      }
    ]
  }
});
