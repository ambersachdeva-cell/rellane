import { z } from "zod";
import { DesktopErrorSchema } from "./desktop-error.js";

const IsoDateSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const ModelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,255}$/);

export const MODEL_LICENSE_NOTICE_MAX_CHARACTERS = 64 * 1024;
export const MODEL_LICENSE_NOTICE_MAX_UTF8_BYTES = 64 * 1024;
export const MODEL_INSTALL_SNAPSHOT_MAX_ITEMS = 100;

export const LicenseNoticeTextSchema = z.string()
  .min(1)
  .max(MODEL_LICENSE_NOTICE_MAX_CHARACTERS)
  .refine((value) => new TextEncoder().encode(value).byteLength <=
    MODEL_LICENSE_NOTICE_MAX_UTF8_BYTES, {
    message: "The license notice exceeds its UTF-8 byte boundary."
  })
  .refine((value) => value.trim().length > 0, {
    message: "The license notice must contain visible text."
  })
  .refine((value) => !value.includes("\u0000"), {
    message: "The license notice must not contain NUL characters."
  });

export const ModelTargetSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64"
]);
export type ModelTarget = z.infer<typeof ModelTargetSchema>;

export const PinnedModelArtifactSchema = z.object({
  artifactVersion: z.literal(1),
  modelId: ModelIdSchema,
  displayName: z.string().trim().min(1).max(300),
  repository: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
  ),
  repositoryRevision: GitRevisionSchema,
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}\.gguf$/i),
  downloadUrl: z.string().url().max(2_048),
  downloadBytes: z.number().int().positive().safe(),
  sha256: Sha256Schema,
  eligibleTargets: z.array(ModelTargetSchema).min(1).max(6),
  license: z.object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(300),
    officialUrl: z.string().url().max(2_048),
    noticeText: LicenseNoticeTextSchema,
    noticeVersion: z.string().trim().min(1).max(100),
    noticeSha256: Sha256Schema
  })
});
export type PinnedModelArtifact = z.infer<typeof PinnedModelArtifactSchema>;

export const ModelCatalogBodySchema = z.object({
  schemaVersion: z.literal(2),
  catalogId: z.literal("switchboard-model-catalog"),
  generation: z.number().int().nonnegative().safe(),
  issuedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  artifacts: z.array(PinnedModelArtifactSchema).min(1).max(100)
});
export type ModelCatalogBody = z.infer<typeof ModelCatalogBodySchema>;

export const SignedModelCatalogSchema = z.object({
  keyId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  algorithm: z.literal("Ed25519"),
  body: ModelCatalogBodySchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
});
export type SignedModelCatalog = z.infer<typeof SignedModelCatalogSchema>;

export const LicenseAcknowledgementSchema = z.object({
  acknowledgementVersion: z.literal(1),
  modelId: ModelIdSchema,
  artifactSha256: Sha256Schema,
  licenseNoticeVersion: z.string().trim().min(1).max(100),
  licenseNoticeSha256: Sha256Schema,
  catalogGeneration: z.number().int().nonnegative().safe(),
  acceptedAt: IsoDateSchema
}).strict();
export type LicenseAcknowledgement = z.infer<typeof LicenseAcknowledgementSchema>;

export const ModelLicenseReviewSchema = z.object({
  modelId: ModelIdSchema,
  displayName: z.string().trim().min(1).max(300),
  artifactSha256: Sha256Schema,
  downloadBytes: z.number().int().positive().safe(),
  sourceHost: z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  repository: PinnedModelArtifactSchema.shape.repository,
  catalogGeneration: z.number().int().nonnegative().safe(),
  licenseId: z.string().trim().min(1).max(100),
  licenseName: z.string().trim().min(1).max(300),
  licenseNoticeVersion: z.string().trim().min(1).max(100),
  licenseNoticeSha256: Sha256Schema,
  noticeText: LicenseNoticeTextSchema,
  acknowledgementCurrent: z.boolean()
}).strict();
export type ModelLicenseReview = z.infer<typeof ModelLicenseReviewSchema>;

export const LicenseAcceptanceIntentSchema = z.object({
  modelId: ModelIdSchema,
  artifactSha256: Sha256Schema,
  catalogGeneration: z.number().int().nonnegative().safe(),
  licenseNoticeVersion: z.string().trim().min(1).max(100),
  licenseNoticeSha256: Sha256Schema,
  accepted: z.literal(true)
}).strict();
export type LicenseAcceptanceIntent = z.infer<typeof LicenseAcceptanceIntentSchema>;

export const ModelInstallStartIntentSchema = z.object({
  modelId: ModelIdSchema
}).strict();
export type ModelInstallStartIntent = z.infer<typeof ModelInstallStartIntentSchema>;

export const ModelInstallStateSchema = z.enum([
  "not-installed",
  "license-required",
  "queued",
  "downloading",
  "paused",
  "verifying",
  "installed",
  "failed",
  "quarantined",
  "removed"
]);
export type ModelInstallState = z.infer<typeof ModelInstallStateSchema>;

export const ModelInstallStatusSchema = z.object({
  modelId: ModelIdSchema,
  state: ModelInstallStateSchema,
  operationId: z.uuid().nullable(),
  catalogGeneration: z.number().int().nonnegative().safe(),
  artifactSha256: Sha256Schema,
  bytesReceived: z.number().int().nonnegative().safe(),
  totalBytes: z.number().int().positive().safe(),
  resumeAvailable: z.boolean(),
  detail: z.string().trim().min(1).max(1_000),
  error: DesktopErrorSchema.nullable(),
  updatedAt: IsoDateSchema
}).strict();
export type ModelInstallStatus = z.infer<typeof ModelInstallStatusSchema>;

export const ModelInstallSnapshotSchema = z.array(ModelInstallStatusSchema)
  .max(MODEL_INSTALL_SNAPSHOT_MAX_ITEMS);
export type ModelInstallSnapshot = z.infer<typeof ModelInstallSnapshotSchema>;

export const ModelInstallCancelResultSchema = z.object({
  cancelRequested: z.boolean(),
  status: ModelInstallStatusSchema.nullable()
}).strict();
export type ModelInstallCancelResult = z.infer<typeof ModelInstallCancelResultSchema>;

export const ModelInstallRequestSchema = z.object({
  modelId: ModelIdSchema,
  acknowledgement: LicenseAcknowledgementSchema
});
export type ModelInstallRequest = z.infer<typeof ModelInstallRequestSchema>;

export const ModelInstallCancelRequestSchema = z.object({
  operationId: z.uuid()
}).strict();
export type ModelInstallCancelRequest = z.infer<typeof ModelInstallCancelRequestSchema>;
