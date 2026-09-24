/**
 * Scout against the real Hugging Face API, on the real machine.
 *
 * Opt-in: it needs the network and it reflects whatever the hub says today, so
 * it cannot be a gate in CI. Run it whenever the ranking or the fit maths
 * changes — a mocked test proves the logic, only this proves the recommendation
 * is any good.
 *
 *   CADRANE_SCOUT_LIVE=1 ./node_modules/.bin/vitest run \
 *     packages/runtime/src/model/scout/scout.live.test.ts \
 *     --pool=threads --maxWorkers=1 --reporter=verbose
 */

import { describe, expect, it } from "vitest";
import { profileHardware } from "../../system/profile.js";
import { scout, type ScoutRole } from "./scout.js";
import { gib } from "./fit.js";

const live = process.env["CADRANE_SCOUT_LIVE"] === "1";

describe.skipIf(!live)("scout, live", () => {
  it("recommends something installable for every role on this machine", async () => {
    const profile = await profileHardware(process.cwd());

    /* eslint-disable no-console */
    console.log(
      `\n${profile.chip} · ${gib(profile.memoryBytes)} RAM · ${profile.acceleration} · ` +
        `${gib(profile.freeDiskBytes)} free\n`
    );

    const roles: ScoutRole[] = ["agentic", "vision-doc", "embedding", "reranker"];
    for (const role of roles) {
      const result = await scout({ role, profile });
      const best = result.recommended;
      console.log(`${role.toUpperCase()}`);
      if (best === null) {
        console.log("  nothing fits\n");
        continue;
      }
      console.log(`  → ${best.id}`);
      console.log(`    ${best.rationale}`);
      for (const alt of result.alternatives.slice(0, 2)) {
        console.log(`    alt: ${alt.id} (${alt.licence.label})`);
      }
      const blocked = result.rejected.slice(0, 2);
      for (const reject of blocked) {
        console.log(`    skipped ${reject.id}: ${reject.reason}`);
      }
      console.log();

      expect(best.fit.verdict).not.toBe("will-not-fit");
      expect(best.licence.commercialSafe).toBe(true);
    }
    /* eslint-enable no-console */
  }, 180_000);
});
