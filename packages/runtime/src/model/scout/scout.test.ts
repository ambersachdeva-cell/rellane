import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HardwareProfile } from "@cadrane/contracts";
import { assessFit, kvCacheBytes, usableAcceleratorBytes, weightsBytes } from "./fit.js";
import { classifyFromTags, classifyLicence, licenceIdFromTags } from "./licence.js";
import { parseParameters, type HfModel } from "./hf-client.js";

vi.mock("./hf-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./hf-client.js")>();
  return { ...actual, searchModels: vi.fn() };
});
const { searchModels } = await import("./hf-client.js");
const { scout } = await import("./scout.js");

const GIB = 1024 ** 3;

/** This machine: M1 Pro, 16 GB, Metal. The tier every estimate has to be right for. */
const M1_PRO_16: HardwareProfile = {
  platform: "darwin",
  operatingSystem: "Darwin 27.0.0",
  architecture: "arm64",
  chip: "Apple M1 Pro",
  gpuName: "Apple M1 Pro",
  dedicatedGpuMemoryBytes: null,
  logicalCores: 10,
  memoryBytes: 16 * GIB,
  freeDiskBytes: 500 * GIB,
  acceleration: "metal",
  recommendation: "balanced",
  recommendationReason: "test fixture",
  measuredAt: "2026-08-21T00:00:00.000Z"
};

function model(over: Partial<HfModel> & { id: string }): HfModel {
  return {
    downloads: 1_000_000,
    likes: 100,
    tags: ["license:apache-2.0", "gguf"],
    pipelineTag: "text-generation",
    libraryName: null,
    createdAt: null,
    gated: false,
    ...over
  };
}

describe("what a Mac can actually give a model", () => {
  it("caps Apple Silicon at ~75% of unified memory, not all of it", () => {
    // Verified on the real machine: iogpu.wired_mem_limit is unset, so the
    // kernel default applies and a 16 GB Mac offers about 12 GB.
    const usable = usableAcceleratorBytes({ memoryBytes: 16 * GIB, acceleration: "metal" });
    expect(usable / GIB).toBeCloseTo(12, 1);
  });

  it("uses dedicated VRAM when there is a discrete GPU", () => {
    expect(
      usableAcceleratorBytes({
        memoryBytes: 64 * GIB,
        acceleration: "cuda",
        dedicatedGpuMemoryBytes: 24 * GIB
      })
    ).toBe(24 * GIB);
  });

  it("leaves the OS room when falling back to CPU", () => {
    const usable = usableAcceleratorBytes({ memoryBytes: 16 * GIB, acceleration: "cpu" });
    expect(usable).toBeLessThan(16 * GIB * 0.7);
  });
});

describe("quantised size tracks real GGUF files", () => {
  // Calibration points from published Q4_K_M builds.
  it.each([
    [7.61, 4.68],
    [14.7, 8.99],
    [32.5, 19.8]
  ])("estimates %sB within 5%% of the real %s GB", (params, actualGiB) => {
    const estimated = weightsBytes(params, "Q4_K_M") / GIB;
    expect(Math.abs(estimated - actualGiB) / actualGiB).toBeLessThan(0.05);
  });

  it("grows with the quant", () => {
    const q4 = weightsBytes(9, "Q4_K_M");
    expect(weightsBytes(9, "Q8_0")).toBeGreaterThan(q4);
    expect(weightsBytes(9, "F16")).toBeGreaterThan(weightsBytes(9, "Q8_0"));
  });

  it("charges more KV cache for longer context", () => {
    expect(kvCacheBytes(9, 32_768)).toBeGreaterThan(kvCacheBytes(9, 4_096));
    expect(kvCacheBytes(9, 0)).toBe(0);
  });
});

describe("fit on a 16 GB Mac", () => {
  const base = {
    quant: "Q4_K_M" as const,
    contextTokens: 8_192,
    memoryBytes: M1_PRO_16.memoryBytes,
    freeDiskBytes: M1_PRO_16.freeDiskBytes,
    acceleration: "metal"
  };

  it("says a 9B fits comfortably", () => {
    expect(assessFit({ ...base, parametersBillions: 9 }).verdict).toBe("comfortable");
  });

  it("says a 30B will not fit", () => {
    const fit = assessFit({ ...base, parametersBillions: 30 });
    expect(fit.verdict).toBe("will-not-fit");
    expect(fit.reason).toMatch(/can give a model/u);
  });

  it("refuses when the disk is too full, before considering memory", () => {
    const fit = assessFit({ ...base, parametersBillions: 9, freeDiskBytes: 1 * GIB });
    expect(fit.verdict).toBe("no-disk");
  });

  it("mentions the speed advantage of a mixture-of-experts model", () => {
    const fit = assessFit({
      ...base,
      parametersBillions: 9,
      activeParametersBillions: 3
    });
    expect(fit.reason).toMatch(/3B parameters are active/u);
  });

  it("fits a 30B once the machine is big enough", () => {
    const fit = assessFit({ ...base, parametersBillions: 30, memoryBytes: 64 * GIB });
    expect(fit.verdict).toBe("comfortable");
  });
});

describe("licence classification", () => {
  it("reads the tag Hugging Face actually returns", () => {
    expect(licenceIdFromTags(["pipeline:x", "license:apache-2.0"])).toBe("apache-2.0");
    expect(licenceIdFromTags(["no-licence-here"])).toBeNull();
  });

  // All three verified live against the HF API on 2026-08-21.
  it.each([
    ["cc-by-nc-4.0", "Salesforce/xLAM-7b-fc-r"],
    ["cc-by-nc-sa-4.0", "vikp/surya_layout"],
    ["cc-by-nc-4.0", "jinaai/jina-reranker-v2-base-multilingual"]
  ])("blocks %s, which %s really carries", (id) => {
    const verdict = classifyLicence(id);
    expect(verdict.klass).toBe("non-commercial");
    expect(verdict.commercialSafe).toBe(false);
  });

  it("allows permissive licences", () => {
    for (const id of ["apache-2.0", "mit", "bsd-3-clause"]) {
      expect(classifyLicence(id).commercialSafe).toBe(true);
    }
  });

  it("treats a missing licence as unknown rights, not as permission", () => {
    const verdict = classifyFromTags(["pipeline:text-generation"]);
    expect(verdict.klass).toBe("unknown");
    expect(verdict.commercialSafe).toBe(false);
  });

  it("does not guess at an unrecognised licence", () => {
    expect(classifyLicence("some-new-licence-2026").commercialSafe).toBe(false);
  });

  it("flags copyleft separately from non-commercial", () => {
    expect(classifyLicence("agpl-3.0").klass).toBe("copyleft");
    expect(classifyLicence("agpl-3.0").note).toMatch(/publish your own source/u);
  });
});

describe("reading a size out of a repo name", () => {
  it.each([
    ["Qwen/Qwen3.5-9B", 9, null],
    ["Qwen/Qwen3.5-4B", 4, null],
    ["unsloth/Qwen3.8-27B-GGUF", 27, null],
    ["Qwen/Qwen3.6-35B-A3B-FP8", 35, 3],
    ["unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", 30, 3],
    ["Qwen/Qwen3-Embedding-0.6B", 0.6, null]
  ])("reads %s as %sB", (id, total, active) => {
    const parsed = parseParameters(id);
    expect(parsed?.totalBillions).toBe(total);
    expect(parsed?.activeBillions).toBe(active);
  });

  it("returns null rather than guessing when the name says nothing", () => {
    expect(parseParameters("BAAI/bge-small-en-v1.5")).toBeNull();
  });
});

describe("scout ranking", () => {
  beforeEach(() => {
    vi.mocked(searchModels).mockReset();
  });

  it("recommends a model that fits over a bigger one that does not", async () => {
    vi.mocked(searchModels).mockResolvedValue([
      model({ id: "org/Huge-70B", downloads: 90_000_000 }),
      model({ id: "org/Right-9B", downloads: 5_000_000 })
    ]);

    const result = await scout({ role: "agentic", profile: M1_PRO_16 });

    expect(result.recommended?.id).toBe("org/Right-9B");
    expect(result.rejected.map((r) => r.id)).toContain("org/Huge-70B");
  });

  it("refuses a non-commercial model by default and says why", async () => {
    vi.mocked(searchModels).mockResolvedValue([
      model({ id: "org/Tempting-7B", tags: ["license:cc-by-nc-4.0", "gguf"], downloads: 50_000_000 }),
      model({ id: "org/Plain-7B", downloads: 100 })
    ]);

    const result = await scout({ role: "agentic", profile: M1_PRO_16 });

    expect(result.recommended?.id).toBe("org/Plain-7B");
    const rejection = result.rejected.find((r) => r.id === "org/Tempting-7B");
    expect(rejection?.reason).toMatch(/Non-commercial only/u);
  });

  it("allows non-commercial only when explicitly permitted", async () => {
    vi.mocked(searchModels).mockResolvedValue([
      model({ id: "org/Tempting-7B", tags: ["license:cc-by-nc-4.0", "gguf"], downloads: 50_000_000 })
    ]);

    const result = await scout({
      role: "agentic",
      profile: M1_PRO_16,
      allowNonCommercial: true
    });

    expect(result.recommended?.id).toBe("org/Tempting-7B");
  });

  it("skips gated repositories, which cannot be installed unattended", async () => {
    vi.mocked(searchModels).mockResolvedValue([
      model({ id: "org/Gated-9B", gated: true, downloads: 80_000_000 }),
      model({ id: "org/Open-9B", downloads: 10 })
    ]);

    const result = await scout({ role: "agentic", profile: M1_PRO_16 });

    expect(result.recommended?.id).toBe("org/Open-9B");
    expect(result.rejected[0]?.reason).toMatch(/gated/u);
  });

  it("explains every recommendation in a sentence", async () => {
    vi.mocked(searchModels).mockResolvedValue([model({ id: "org/Right-9B" })]);
    const result = await scout({ role: "agentic", profile: M1_PRO_16 });
    expect(result.recommended?.rationale).toMatch(/9B · Apache 2\.0 · Fits comfortably/u);
  });

  it("returns nothing rather than something unusable when nothing fits", async () => {
    vi.mocked(searchModels).mockResolvedValue([model({ id: "org/Huge-405B" })]);
    const result = await scout({ role: "agentic", profile: M1_PRO_16 });
    expect(result.recommended).toBeNull();
  });

  it("still sizes small encoders whose names carry no parameter count", async () => {
    vi.mocked(searchModels).mockResolvedValue([model({ id: "BAAI/bge-small-en-v1.5" })]);
    const result = await scout({ role: "embedding", profile: M1_PRO_16 });
    expect(result.recommended?.id).toBe("BAAI/bge-small-en-v1.5");
  });
});
