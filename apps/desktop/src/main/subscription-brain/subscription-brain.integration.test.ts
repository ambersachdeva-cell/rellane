/**
 * Live check against a real, installed CLI.
 *
 * Skipped by default: it starts the user's own paid tool, takes about a minute,
 * and consumes their quota. Run it deliberately when changing anything in this
 * module, because unit tests cannot tell you whether the CLI still behaves the
 * way `providers.ts` claims.
 *
 *   CADRANE_BRAIN_LIVE=1 ./node_modules/.bin/vitest run \
 *     apps/desktop/src/main/subscription-brain/subscription-brain.integration.test.ts \
 *     --pool=threads --maxWorkers=1
 */

import { describe, expect, it } from "vitest";
import { SubscriptionBrain } from "./index.js";

const live = process.env["CADRANE_BRAIN_LIVE"] === "1";

describe.skipIf(!live)("docked brain, live", () => {
  it("finds an installed CLI", async () => {
    const found = await new SubscriptionBrain().available();
    // eslint-disable-next-line no-console
    console.log("installed:", found.map((f) => `${f.label} ${f.version}`).join(", ") || "none");
    expect(found.length).toBeGreaterThan(0);
  }, 60_000);

  it("docks and probes every capability honestly", async () => {
    const brain = new SubscriptionBrain();
    const { installation, capabilities } = await brain.dock("antigravity");

    // eslint-disable-next-line no-console
    console.log(`docked ${installation.label} ${installation.version} @ ${installation.executablePath}`);
    for (const capability of capabilities) {
      // eslint-disable-next-line no-console
      console.log(`  ${capability.state.padEnd(12)} ${capability.title}${capability.reason ? ` — ${capability.reason}` : ""}`);
    }

    expect(capabilities.length).toBeGreaterThan(0);
    // Every probe must actually succeed. Asserting only "not unknown" would
    // pass with all three unavailable, which is the failure this guards.
    for (const capability of capabilities) {
      expect(capability.state, `${capability.title}: ${capability.reason ?? ""}`).toBe(
        "available"
      );
    }
  }, 600_000);

  it("dims capabilities on undock without deleting them", async () => {
    const brain = new SubscriptionBrain();
    await brain.dock("antigravity");
    const before = brain.capabilities().length;
    brain.undock();
    const after = brain.capabilities();
    expect(after).toHaveLength(before);
    expect(after.every((capability) => capability.state === "unknown")).toBe(true);
  }, 600_000);
});
