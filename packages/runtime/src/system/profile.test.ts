import { describe, expect, it } from "vitest";
import { parseWindowsGraphics, recommendQualityMode } from "./profile.js";

const gib = 1024 ** 3;

describe("hardware profile helpers", () => {
  it("chooses a balanced mode for a typical 16 GB laptop", () => {
    expect(recommendQualityMode(16 * gib, 80 * gib).mode).toBe("balanced");
  });

  it("reads Windows GPU inventory without claiming an unverified backend", () => {
    expect(parseWindowsGraphics(JSON.stringify([
      { Name: "Intel Integrated Graphics", AdapterRAM: 2 * gib },
      { Name: "NVIDIA Laptop GPU", AdapterRAM: 8 * gib }
    ]))).toEqual({
      name: "NVIDIA Laptop GPU",
      memoryBytes: 8 * gib,
      acceleration: "unknown"
    });
  });
});
