import type {
  HardwareProfile,
  OpenWeightModel
} from "@cadrane/contracts";
import { describe, expect, it } from "vitest";
import { rankOpenWeightModels, scoreModelFit } from "./concierge.js";

const gib = 1024 ** 3;

const profile: HardwareProfile = {
  platform: "darwin",
  operatingSystem: "macOS test",
  architecture: "arm64",
  chip: "Apple test",
  gpuName: "Apple test",
  dedicatedGpuMemoryBytes: null,
  logicalCores: 10,
  memoryBytes: 16 * gib,
  freeDiskBytes: 100 * gib,
  acceleration: "metal",
  recommendation: "balanced",
  recommendationReason: "Test profile.",
  measuredAt: "2026-07-30T00:00:00.000Z"
};

const baseModel: OpenWeightModel = {
  catalogVersion: 1,
  id: "test-7b",
  family: "Test",
  displayName: "Test 7B",
  description: "Fixture model.",
  parametersBillions: 7,
  officialModelUrl: "https://example.com/model",
  license: {
    id: "apache-2.0",
    name: "Apache License 2.0",
    officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    distributionReview: "permissive-terms-reviewed",
    legalAdvice: false
  },
  artifact: {
    format: "gguf",
    quantization: "Q4_K_M",
    downloadBytes: 5 * gib,
    sourceUrl: "https://huggingface.co/test-org/test-model/resolve/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/model-Q4_K_M.gguf",
    sha256: "a".repeat(64),
    repositoryRevision: "b".repeat(40),
    filename: "model-Q4_K_M.gguf"
  },
  requirements: {
    minimumMemoryBytes: 8 * gib,
    comfortableMemoryBytes: 12 * gib,
    minimumFreeDiskBytes: 8 * gib,
    supportedPlatforms: ["darwin", "linux", "win32"],
    supportedArchitectures: ["arm64", "x64"],
    validatedTargets: ["darwin-arm64"]
  },
  capabilities: {
    chat: true,
    structuredOutput: true,
    tools: "not-claimed",
    vision: false,
    languages: ["English"]
  },
  context: {
    nativeMaxTokens: 32_768,
    extendedMaxTokens: null,
    conciergeDefaultTokens: 4_096
  },
  reviewedAt: "2026-07-30",
  evidenceNote: "Test fixture only."
};

describe("model concierge", () => {
  it("scores a comfortable balanced model highly", () => {
    const result = scoreModelFit(profile, baseModel, "balanced");
    expect(result.fit).toBe("good");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.canInstall).toBe(true);
    expect(result.platformVerification).toBe("native-verified");
    expect(result.reasons.join(" ")).toMatch(/Metal/);
  });

  it("blocks models that exceed measured memory", () => {
    const result = scoreModelFit(profile, {
      ...baseModel,
      id: "test-70b",
      displayName: "Test 70B",
      parametersBillions: 70,
      requirements: {
        ...baseModel.requirements,
        minimumMemoryBytes: 40 * gib,
        comfortableMemoryBytes: 64 * gib
      }
    }, "quality");
    expect(result.fit).toBe("unsupported");
    expect(result.score).toBe(0);
    expect(result.canInstall).toBe(false);
  });

  it("ranks by hardware fit and chosen mode deterministically", () => {
    const small: OpenWeightModel = {
      ...baseModel,
      id: "test-3b",
      displayName: "Test 3B",
      parametersBillions: 3,
      artifact: { ...baseModel.artifact, downloadBytes: 2 * gib },
      requirements: {
        ...baseModel.requirements,
        minimumMemoryBytes: 4 * gib,
        comfortableMemoryBytes: 7 * gib,
        minimumFreeDiskBytes: 4 * gib
      }
    };
    const ranked = rankOpenWeightModels(profile, [baseModel, small], "fast");
    expect(ranked[0]?.model.id).toBe("test-3b");
  });

  it("labels compatible but untested platforms as estimates", () => {
    const result = scoreModelFit({
      ...profile,
      platform: "win32",
      architecture: "x64",
      operatingSystem: "Windows test",
      acceleration: "unknown"
    }, baseModel, "balanced");
    expect(result.platformVerification).toBe("estimated");
    expect(result.canInstall).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/hardware estimate/i);
  });

  it("does not allow installation when an artifact is intentionally unpinned", () => {
    const result = scoreModelFit(profile, {
      ...baseModel,
      artifact: {
        ...baseModel.artifact,
        sourceUrl: null,
        sha256: null,
        repositoryRevision: null,
        filename: null
      }
    }, "balanced");
    expect(result.canInstall).toBe(false);
  });
});
