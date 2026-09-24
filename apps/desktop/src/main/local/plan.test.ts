import { describe, expect, it } from "vitest";
import { ALL_LAYERS, isUnifiedMemory, layersThatFit, planLoad } from "./plan.js";
import type { HardwareProfile } from "@cadrane/contracts";

const GB = 1024 ** 3;

const mac = (over: Partial<HardwareProfile> = {}): HardwareProfile => ({
  platform: "darwin",
  operatingSystem: "macOS 27",
  architecture: "arm64",
  chip: "Apple M4 Pro",
  gpuName: "Apple M4 Pro",
  dedicatedGpuMemoryBytes: null,
  logicalCores: 12,
  memoryBytes: 24 * GB,
  freeDiskBytes: 400 * GB,
  acceleration: "metal",
  recommendation: "balanced",
  recommendationReason: "r",
  measuredAt: "2026-09-01T00:00:00.000Z",
  ...over
});

const pc = (over: Partial<HardwareProfile> = {}): HardwareProfile =>
  mac({
    platform: "win32",
    operatingSystem: "Windows 11",
    chip: "Intel i5-13400",
    gpuName: "NVIDIA GeForce RTX 4060",
    dedicatedGpuMemoryBytes: 8 * GB,
    acceleration: "cuda",
    memoryBytes: 32 * GB,
    logicalCores: 16,
    ...over
  });

describe("machines where the split does not exist", () => {
  it("puts every layer on the GPU when memory is unified", () => {
    // The GPU already addresses this RAM. Splitting would be a control that
    // does nothing, which is worse than no control.
    const result = planLoad(mac(), 8.5 * GB, "quality");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.gpuLayers).toBe(ALL_LAYERS);
      expect(result.plan.offloads).toBe(false);
      expect(result.plan.expectation).toContain("shares memory");
    }
  });

  it("does not treat unknown VRAM as unified", () => {
    // A null reading also means "we could not measure it". Assuming unified
    // there would place every layer on a card that cannot hold them.
    expect(isUnifiedMemory(mac())).toBe(true);
    expect(isUnifiedMemory(pc({ dedicatedGpuMemoryBytes: null, acceleration: "cuda" }))).toBe(
      false
    );
  });
});

describe("the hard no", () => {
  it("refuses a model that would not fit in physical memory", () => {
    // Offloading to RAM is a slope; swapping to SSD is a cliff that takes the
    // whole machine with it. This is the one refusal that is not a trade-off.
    const result = planLoad(mac({ memoryBytes: 16 * GB }), 19 * GB, "quality");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.why).toContain("swapping");
      expect(result.why).toContain("19.0 GB");
    }
  });

  it("leaves room for the rest of the machine", () => {
    // 70% of 16 GB is 11.2. A 12 GB model technically "fits" in 16 GB and would
    // still put the owner into swap once anything else is open.
    expect(planLoad(mac({ memoryBytes: 16 * GB }), 12 * GB, "quality").ok).toBe(false);
    expect(planLoad(mac({ memoryBytes: 16 * GB }), 8 * GB, "quality").ok).toBe(true);
  });
});

describe("a discrete card that cannot hold the model", () => {
  it("is what Fast mode refuses, with the way out named", () => {
    const result = planLoad(pc(), 8.5 * GB, "fast");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.why).toContain("Switch to Careful");
    }
  });

  it("is what Careful mode allows, splitting the layers", () => {
    const result = planLoad(pc(), 8.5 * GB, "quality");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.offloads).toBe(true);
      expect(result.plan.gpuLayers).toBeGreaterThan(0);
      expect(result.plan.gpuLayers).toBeLessThan(ALL_LAYERS);
    }
  });

  it("warns about reading long documents, not about answers being slow", () => {
    // The finding specific to this product: generation degrades ~4x, prompt
    // processing ~30x, and agents here mostly read. A warning about slow
    // answers would point at the wrong cost.
    const result = planLoad(pc(), 8.5 * GB, "quality");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.warning).toContain("reads a long document");
    }
  });

  it("keeps every layer on the card when the model does fit", () => {
    const result = planLoad(pc(), 4.1 * GB, "fast");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.gpuLayers).toBe(ALL_LAYERS);
      expect(result.plan.offloads).toBe(false);
      expect(result.plan.warning).toBeNull();
    }
  });
});

describe("no graphics card at all", () => {
  it("runs, and says plainly what that costs", () => {
    const result = planLoad(
      pc({ dedicatedGpuMemoryBytes: 0, acceleration: "cpu", gpuName: null }),
      4.1 * GB,
      "balanced"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.gpuLayers).toBe(0);
      expect(result.plan.warning).toContain("minutes rather than seconds");
    }
  });
});

describe("how many layers fit", () => {
  it("rounds down, because one layer too many is an allocation failure", () => {
    // One too few costs a little speed. One too many costs a crash on load.
    expect(layersThatFit(8.5 * GB, 8 * GB)).toBeLessThan(ALL_LAYERS);
    expect(layersThatFit(8.5 * GB, 8 * GB)).toBeGreaterThan(0);
  });

  it("reserves working memory rather than filling the card", () => {
    // A model that exactly equals VRAM does not fit: the KV cache and compute
    // graph still need room, and ignoring that loads fine then dies on the
    // first long prompt, which reads as a random crash.
    expect(layersThatFit(8 * GB, 8 * GB)).toBeLessThan(ALL_LAYERS);
  });

  it("returns nothing rather than a negative count for a tiny card", () => {
    expect(layersThatFit(4 * GB, 512 * 1024 * 1024)).toBe(0);
  });
});

describe("threads", () => {
  it("does not halve cores on Apple Silicon, which has no hyperthreading", () => {
    // Caught by printing the real plan for an M1 Pro: `logicalCores / 2` gave 5
    // where 8 is correct, a regression from the hardcoded value it replaced.
    // Apple Silicon's logical cores *are* physical cores.
    const m1pro = planLoad(mac({ logicalCores: 10 }), 4 * GB, "fast");

    expect(m1pro.ok && m1pro.plan.threads).toBe(8);
  });

  it("halves them on x86, where they are hyperthreads", () => {
    const desktop = planLoad(pc({ logicalCores: 16 }), 4 * GB, "fast");

    expect(desktop.ok && desktop.plan.threads).toBe(8);
  });

  it("never drops below two, or above sixteen", () => {
    const tiny = planLoad(pc({ logicalCores: 2 }), 4 * GB, "fast");
    const huge = planLoad(pc({ logicalCores: 128, memoryBytes: 256 * GB }), 4 * GB, "fast");

    expect(tiny.ok && tiny.plan.threads).toBe(2);
    expect(huge.ok && huge.plan.threads).toBe(16);
  });
});

describe("context", () => {
  it("costs memory, so it grows only with the mode that accepts the cost", () => {
    const fast = planLoad(mac(), 4 * GB, "fast");
    const careful = planLoad(mac(), 4 * GB, "quality");

    expect(fast.ok && careful.ok && careful.plan.ctxSize).toBeGreaterThan(
      fast.ok ? fast.plan.ctxSize : 0
    );
  });
});
