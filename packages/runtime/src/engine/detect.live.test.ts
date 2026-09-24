import { describe, expect, it } from "vitest";
import { detectBackends } from "./detect.js";
import { chooseBackend } from "./backend.js";

/** What this machine can really do. Opt-in: it runs subprocesses. */
const live = process.env["CADRANE_ENGINE_LIVE"] === "1";

describe.skipIf(!live)("backends, live", () => {
  it("reports what is actually installed", async () => {
    const backends = await detectBackends({
      machine: { platform: process.platform, architecture: process.arch, acceleration: "metal" },
      bundledServerPath: "/Applications/Cadrane.app/Contents/Resources/llama-b10182/llama-server"
    });
    /* eslint-disable no-console */
    for (const backend of backends) {
      console.log(`  ${backend.id.padEnd(10)} ${backend.available ? "yes" : "no "}  ${backend.detail}`);
    }
    const choice = chooseBackend({ parametersBillions: 9, backends });
    console.log(`  → for a 9B model: ${choice.backend} (${choice.reason})`);
    /* eslint-enable no-console */
    expect(backends).toHaveLength(2);
  }, 60_000);
});
