import {
  OpenWeightModelSchema,
  type OpenWeightModel
} from "@cadrane/contracts";
import { z } from "zod";

const gb = 1_000_000_000;
const gib = 1024 ** 3;
const allPlatforms = ["darwin", "linux", "win32"] as const;
const allArchitectures = ["arm64", "x64"] as const;
const apacheLicense = {
  id: "Apache-2.0",
  name: "Apache License 2.0",
  officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  distributionReview: "permissive-terms-reviewed" as const,
  legalAdvice: false as const
};

export const STARTER_CATALOG_REVIEWED_AT = "2026-08-19";

export const STARTER_OPEN_WEIGHT_CATALOG: OpenWeightModel[] = z.array(
  OpenWeightModelSchema
).parse([
  {
    catalogVersion: 1,
    id: "ibm-granite-3.3-2b-instruct-q4-k-m",
    family: "IBM Granite 3.3",
    displayName: "Granite 3.3 2B Instruct",
    description: "Compact text model optimized for fast assistants, summarization, and function calling on entry-level Macs.",
    parametersBillions: 2,
    officialModelUrl: "https://huggingface.co/ibm-granite/granite-3.3-2b-instruct",
    license: apacheLicense,
    artifact: {
      format: "gguf",
      quantization: "Q4_K_M",
      downloadBytes: 1_545_303_328,
      sourceUrl: "https://huggingface.co/ibm-granite/granite-3.3-2b-instruct-GGUF/resolve/7cdf86ccd1f1bb3491c9b7017b033f2e51367397/granite-3.3-2b-instruct-Q4_K_M.gguf",
      sha256: "ac71e9e32c0bea919b409c5918f69ca74339854b0319c5065e4e9fb6d95c4852",
      repositoryRevision: "7cdf86ccd1f1bb3491c9b7017b033f2e51367397",
      filename: "granite-3.3-2b-instruct-Q4_K_M.gguf"
    },
    requirements: {
      minimumMemoryBytes: 4 * gib,
      comfortableMemoryBytes: 8 * gib,
      minimumFreeDiskBytes: 4 * gb,
      supportedPlatforms: allPlatforms,
      supportedArchitectures: allArchitectures,
      validatedTargets: []
    },
    capabilities: {
      chat: true,
      structuredOutput: true,
      tools: "function-calling-claimed",
      vision: false,
      languages: ["Multilingual text"]
    },
    context: {
      nativeMaxTokens: 131_072,
      extendedMaxTokens: null,
      conciergeDefaultTokens: 4_096
    },
    reviewedAt: STARTER_CATALOG_REVIEWED_AT,
    evidenceNote: "Official IBM Granite GGUF listing verified."
  },
  {
    catalogVersion: 1,
    id: "qwen3-4b-q4-k-m",
    family: "Qwen3",
    displayName: "Qwen3 4B",
    description: "Compact multilingual text model with strong agent tools and deep chain-of-thought capabilities.",
    parametersBillions: 4,
    officialModelUrl: "https://huggingface.co/Qwen/Qwen3-4B",
    license: apacheLicense,
    artifact: {
      format: "gguf",
      quantization: "Q4_K_M",
      downloadBytes: 2_497_280_256,
      sourceUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
      sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
      repositoryRevision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
      filename: "Qwen3-4B-Q4_K_M.gguf"
    },
    requirements: {
      minimumMemoryBytes: 6 * gib,
      comfortableMemoryBytes: 10 * gib,
      minimumFreeDiskBytes: 6 * gb,
      supportedPlatforms: allPlatforms,
      supportedArchitectures: allArchitectures,
      validatedTargets: []
    },
    capabilities: {
      chat: true,
      structuredOutput: true,
      tools: "agent-tools-claimed",
      vision: false,
      languages: ["100+ languages"]
    },
    context: {
      nativeMaxTokens: 32_768,
      extendedMaxTokens: 131_072,
      conciergeDefaultTokens: 4_096
    },
    reviewedAt: STARTER_CATALOG_REVIEWED_AT,
    evidenceNote: "Official Qwen3-4B GGUF listing verified."
  },
]);
