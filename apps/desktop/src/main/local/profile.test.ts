import { describe, expect, it } from "vitest";
import { accelerationFor, readHardwareProfile } from "./profile.js";

describe("what backend will be used", () => {
  it("is Metal on Apple Silicon, whatever the VRAM reading says", () => {
    // There is no dedicated VRAM to read on this hardware, so a null here is
    // the correct answer rather than a failed measurement.
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(accelerationFor(null)).toBe("metal");
    }
  });

  it("treats an unmeasurable card as no card, not as a big one", () => {
    // The conservative direction. Assuming a card we could not measure would
    // produce a plan that fails at load, which reads as a broken app.
    if (process.platform !== "darwin") {
      expect(accelerationFor(null)).toBe("cpu");
      expect(accelerationFor(8 * 1024 ** 3)).toBe("cuda");
    }
  });
});

describe("reading this machine", () => {
  it("reports real memory and cores, and never zero cores", () => {
    // A zero would collapse the thread count to the floor and run everything
    // single-threaded, which is slow in a way nobody would trace back here.
    return readHardwareProfile().then((profile) => {
      expect(profile.memoryBytes).toBeGreaterThan(0);
      expect(profile.logicalCores).toBeGreaterThanOrEqual(1);
      expect(profile.measuredAt).toMatch(/^\d{4}-/u);
    });
  });

  it("reports unknown video memory as null rather than zero", async () => {
    // The planner reads these differently: null means "do not assume", zero
    // means "there is definitely no card". Conflating them loses that.
    const profile = await readHardwareProfile();

    expect(profile.dedicatedGpuMemoryBytes === null || profile.dedicatedGpuMemoryBytes > 0).toBe(
      true
    );
  });

  it("does not invent the fields it cannot measure", async () => {
    // Honest placeholders, and nothing in the planner reads them. An invented
    // disk figure would eventually be believed by something.
    const profile = await readHardwareProfile();

    expect(profile.freeDiskBytes).toBe(0);
    expect(profile.gpuName).toBeNull();
  });
});
