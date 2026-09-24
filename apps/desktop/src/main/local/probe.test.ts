import { describe, it } from "vitest";
import { readHardwareProfile } from "./profile.js";
import { planLoad } from "./plan.js";

describe("what this machine decides", () => {
  it.runIf(process.env["PLAN_PROBE"] === "1")("prints the real plan", async () => {
    const profile = await readHardwareProfile();
    const GB = 1024 ** 3;
    // eslint-disable-next-line no-console
    console.log(
      `\n${profile.chip} · ${profile.acceleration} · ${(profile.memoryBytes / GB).toFixed(0)} GB · ${profile.logicalCores} cores · vram=${profile.dedicatedGpuMemoryBytes ?? "none"}\n`
    );
    for (const [label, bytes] of [["4B q4 (2.5GB)", 2.5], ["14B q4 (8.5GB)", 8.5], ["32B q4 (19GB)", 19], ["70B q4 (40GB)", 40]] as const) {
      for (const mode of ["fast", "quality"] as const) {
        const result = planLoad(profile, bytes * GB, mode);
        // eslint-disable-next-line no-console
        console.log(
          result.ok
            ? `  ${label} ${mode.padEnd(8)} → ngl=${result.plan.gpuLayers} ctx=${result.plan.ctxSize} threads=${result.plan.threads}`
            : `  ${label} ${mode.padEnd(8)} → REFUSED: ${result.why.slice(0, 90)}…`
        );
      }
    }
  });
});
