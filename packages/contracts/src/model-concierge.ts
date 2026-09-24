import { z } from "zod";
import { HardwareProfileSchema, QualityModeSchema } from "./local-intelligence.js";
import { ModelTargetSchema } from "./model-install.js";

const ByteCountSchema = z.number().int().positive().safe();
const HuggingFaceRepositorySchema = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function isImmutableHuggingFaceResolverUrl(
  sourceUrl: string,
  repositoryRevision: string,
  filename: string
): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return false;
  }

  const expectedSuffix = `/resolve/${repositoryRevision}/${filename}`;
  const repository = url.pathname.endsWith(expectedSuffix)
    ? url.pathname.slice(1, -expectedSuffix.length)
    : null;
  return (
    url.protocol === "https:" &&
    url.hostname === "huggingface.co" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    repository !== null &&
    HuggingFaceRepositorySchema.test(repository)
  );
}

export const OpenWeightModelSchema = z.object({
  catalogVersion: z.literal(1),
  id: z.string().min(1).max(256),
  family: z.string().min(1).max(200),
  displayName: z.string().min(1).max(300),
  description: z.string().min(1).max(1_000),
  parametersBillions: z.number().positive().max(1_000),
  officialModelUrl: z.string().url().max(2_048),
  license: z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(300),
    officialUrl: z.string().url().max(2_048),
    distributionReview: z.enum(["permissive-terms-reviewed", "conditional", "unreviewed"]),
    legalAdvice: z.literal(false)
  }),
  artifact: z.object({
    format: z.literal("gguf"),
    quantization: z.string().min(1).max(100),
    downloadBytes: ByteCountSchema,
    sourceUrl: z.string().url().max(2_048).nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    repositoryRevision: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
    filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}\.gguf$/i).nullable()
  }).refine((artifact) => {
    const pins = [
      artifact.sourceUrl,
      artifact.sha256,
      artifact.repositoryRevision,
      artifact.filename
    ];
    return pins.every((pin) => pin === null) || pins.every((pin) => pin !== null);
  }, {
    message: "Artifact source URL, digest, revision, and filename must be pinned together."
  }).refine((artifact) => {
    if (
      artifact.sourceUrl === null ||
      artifact.repositoryRevision === null ||
      artifact.filename === null
    ) {
      return true;
    }
    return isImmutableHuggingFaceResolverUrl(
      artifact.sourceUrl,
      artifact.repositoryRevision,
      artifact.filename
    );
  }, {
    message: "Pinned artifact URLs must use an immutable approved Hugging Face resolver path."
  }),
  requirements: z.object({
    minimumMemoryBytes: ByteCountSchema,
    comfortableMemoryBytes: ByteCountSchema,
    minimumFreeDiskBytes: ByteCountSchema,
    supportedPlatforms: z.array(z.enum(["darwin", "linux", "win32"])).min(1).max(3),
    supportedArchitectures: z.array(z.enum(["arm64", "x64"])).min(1).max(2),
    validatedTargets: z.array(ModelTargetSchema).max(6)
  }),
  capabilities: z.object({
    chat: z.boolean(),
    structuredOutput: z.boolean(),
    tools: z.enum(["function-calling-claimed", "agent-tools-claimed", "not-claimed"]),
    vision: z.boolean(),
    languages: z.array(z.string().min(1).max(100)).min(1).max(100)
  }),
  context: z.object({
    nativeMaxTokens: z.number().int().positive().max(10_000_000),
    extendedMaxTokens: z.number().int().positive().max(10_000_000).nullable(),
    conciergeDefaultTokens: z.number().int().min(1_024).max(32_768)
  }),
  reviewedAt: z.iso.date(),
  evidenceNote: z.string().min(1).max(1_500)
});
export type OpenWeightModel = z.infer<typeof OpenWeightModelSchema>;

export const ModelFitSchema = z.object({
  model: OpenWeightModelSchema,
  fit: z.enum(["excellent", "good", "tight", "unsupported"]),
  score: z.number().int().min(0).max(100),
  platformVerification: z.enum(["native-verified", "estimated"]),
  recommendedMode: QualityModeSchema,
  reasons: z.array(z.string().min(1).max(500)).min(1).max(10),
  warnings: z.array(z.string().min(1).max(500)).max(10),
  estimatedMemoryHeadroomBytes: z.number().int().safe(),
  canInstall: z.boolean()
});
export type ModelFit = z.infer<typeof ModelFitSchema>;

export const ConciergeSnapshotSchema = z.object({
  profile: HardwareProfileSchema,
  catalogReviewedAt: z.iso.date(),
  recommendations: z.array(ModelFitSchema).max(100)
});
export type ConciergeSnapshot = z.infer<typeof ConciergeSnapshotSchema>;
