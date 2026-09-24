import { describe, expect, it } from "vitest";
import { OpenWeightModelSchema } from "@cadrane/contracts";
import { rankOpenWeightModels } from "./concierge.js";
import { STARTER_OPEN_WEIGHT_CATALOG } from "./starter-catalog.js";

describe("starter open-weight catalog", () => {
  it("contains only source-reviewed Apache-2.0 text models", () => {
    expect(STARTER_OPEN_WEIGHT_CATALOG.every(
      (model) =>
        model.license.id === "Apache-2.0" &&
        model.capabilities.vision === false &&
        model.artifact.format === "gguf"
    )).toBe(true);
  });

  it("carries no fabricated hashes", () => {
    // Five entries were removed in August 2026 whose sha256 values were
    // hand-typed patterns — rotations of one repeating nibble sequence — rather
    // than digests of any real file. They could never have passed the integrity
    // check they were supposed to satisfy, so they were never verified at all.
    //
    // The guard is structural rather than a list of known-bad strings: a real
    // digest does not consist of a short run repeating. Model Scout is the
    // live catalogue now, so this list only needs to hold what was genuinely
    // checked by hand.
    for (const model of STARTER_OPEN_WEIGHT_CATALOG) {
      const sha = model.artifact.sha256;
      if (sha === null) {
        continue;
      }
      expect(sha).toMatch(/^[0-9a-f]{64}$/u);
      const distinctPairs = new Set(sha.match(/.{2}/gu) ?? []);
      expect(distinctPairs.size).toBeGreaterThan(16);
    }
  });

  it("pins every entry it ships, or ships none", () => {
    // A half-pinned entry is the dangerous shape: enough to look installable,
    // not enough to verify. Either all four fields are present or the artifact
    // is explicitly unpinned.
    for (const model of STARTER_OPEN_WEIGHT_CATALOG) {
      const { sourceUrl, sha256, repositoryRevision, filename } = model.artifact;
      const present = [sourceUrl, sha256, repositoryRevision, filename].filter(
        (field) => field !== null
      ).length;
      expect([0, 4]).toContain(present);
    }
  });

  it("pins the two first-candidate artifacts but keeps install locked until native conformance", () => {
    const pinned = STARTER_OPEN_WEIGHT_CATALOG.filter(
      (model) =>
        model.artifact.sourceUrl !== null &&
        model.artifact.sha256 !== null &&
        model.artifact.repositoryRevision !== null &&
        model.artifact.filename !== null
    );
    expect(pinned.map((model) => ({
      id: model.id,
      sourceUrl: model.artifact.sourceUrl,
      sha256: model.artifact.sha256,
      repositoryRevision: model.artifact.repositoryRevision,
      filename: model.artifact.filename
    }))).toEqual([
      {
        id: "ibm-granite-3.3-2b-instruct-q4-k-m",
        sourceUrl: "https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF/resolve/7cdf86ccd1f1bb3491c9b7017b033f2e51367397/granite-3.3-2b-instruct-Q4_K_M.gguf",
        sha256: "ac71e9e32c0bea919b409c5918f69ca74339854b0319c5065e4e9fb6d95c4852",
        repositoryRevision: "7cdf86ccd1f1bb3491c9b7017b033f2e51367397",
        filename: "granite-3.3-2b-instruct-Q4_K_M.gguf"
      },
      {
        id: "qwen3-4b-q4-k-m",
        sourceUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
        sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        repositoryRevision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
        filename: "Qwen3-4B-Q4_K_M.gguf"
      }
    ]);
    expect(pinned.every((model) => model.requirements.validatedTargets.length === 0)).toBe(true);
  });

  it("rejects partial artifact pins", () => {
    const model = STARTER_OPEN_WEIGHT_CATALOG[0]!;
    expect(OpenWeightModelSchema.safeParse({
      ...model,
      artifact: { ...model.artifact, filename: null }
    }).success).toBe(false);
  });

  it.each([
    "https://example.com/model.gguf",
    "https://huggingface.co/test-org/test-model/resolve/main/model-Q4_K_M.gguf",
    "https://huggingface.co/test-org/test-model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model-Q4_K_M.gguf",
    "https://huggingface.co/test-org/test-model/resolve/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/other.gguf"
  ])("rejects an artifact URL that is not its immutable pin", (sourceUrl) => {
    const model = STARTER_OPEN_WEIGHT_CATALOG[0]!;
    expect(OpenWeightModelSchema.safeParse({
      ...model,
      artifact: { ...model.artifact, sourceUrl }
    }).success).toBe(false);
  });

  it("makes Fast actually prefer the smaller 2B footprint on a 16 GB Mac", () => {
    const ranked = rankOpenWeightModels({
      platform: "darwin",
      operatingSystem: "macOS test",
      architecture: "arm64",
      chip: "Apple M1 Pro",
      gpuName: "Apple M1 Pro",
      dedicatedGpuMemoryBytes: null,
      logicalCores: 10,
      memoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 100 * 1024 ** 3,
      acceleration: "metal",
      recommendation: "balanced",
      recommendationReason: "Test.",
      measuredAt: "2026-07-30T00:00:00.000Z"
    }, STARTER_OPEN_WEIGHT_CATALOG, "fast");
    expect(ranked[0]?.model.id).toBe("ibm-granite-3.3-2b-instruct-q4-k-m");
    expect(ranked[0]?.platformVerification).toBe("estimated");
  });
});
