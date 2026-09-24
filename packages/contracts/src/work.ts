import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.uuid();
const IsoDateSchema = z.iso.datetime({ offset: true });

export const ModelManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  format: z.enum(["gguf", "ollama", "lm-studio", "loopback"]),
  digestSha256: HashSchema.nullable(),
  sizeBytes: z.number().int().positive().safe().nullable(),
  license: z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(300),
    sourceUrl: z.string().url().max(2_048),
    commercialUseReviewed: z.boolean()
  }),
  source: z.object({
    kind: z.enum(["catalog", "user-import", "local-runtime"]),
    url: z.string().url().max(2_048).nullable()
  }),
  minimumMemoryBytes: z.number().int().positive().safe().nullable(),
  capabilities: z.object({
    chat: z.boolean(),
    structuredOutput: z.boolean(),
    tools: z.boolean(),
    vision: z.boolean(),
    embeddings: z.boolean()
  }),
  catalogVersion: z.string().min(1).max(100)
});
export type ModelManifest = z.infer<typeof ModelManifestSchema>;

export const CapabilityGrantSchema = z.object({
  id: IdentifierSchema,
  mode: z.enum(["read-only", "create-drafts", "ask-before-change", "sandbox-automation"]),
  readPaths: z.array(z.string().min(1).max(4_096)).max(100),
  writePaths: z.array(z.string().min(1).max(4_096)).max(100),
  commands: z.array(z.string().min(1).max(500)).max(100),
  networkOrigins: z.array(z.string().url().max(2_048)).max(100),
  externalActions: z.array(z.string().min(1).max(500)).max(100),
  expiresAt: IsoDateSchema,
  approvedBy: z.enum(["user", "workspace-policy"])
});
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const RunContractSchema = z.object({
  contractVersion: z.literal(1),
  id: IdentifierSchema,
  goal: z.string().trim().min(1).max(16_000),
  inputArtifactIds: z.array(IdentifierSchema).max(1_000),
  requiredOutputs: z.array(z.object({
    kind: z.string().min(1).max(100),
    format: z.string().min(1).max(100),
    acceptanceCriteria: z.array(z.string().min(1).max(2_000)).min(1).max(100)
  })).min(1).max(20),
  runtimeId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(512),
  workspaceRoots: z.array(z.string().min(1).max(4_096)).max(100),
  timeBudgetSeconds: z.number().int().min(1).max(86_400),
  grants: z.array(CapabilityGrantSchema).max(100),
  verificationRules: z.array(z.string().min(1).max(2_000)).max(100)
});
export type RunContract = z.infer<typeof RunContractSchema>;

export const NormalizedRunEventSchema = z.object({
  eventVersion: z.literal(1),
  id: IdentifierSchema,
  runId: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  type: z.enum([
    "progress",
    "model-output",
    "tool-proposal",
    "approval",
    "artifact",
    "usage",
    "warning",
    "failure",
    "completion"
  ]),
  occurredAt: IsoDateSchema,
  payload: z.record(z.string(), z.unknown())
});
export type NormalizedRunEvent = z.infer<typeof NormalizedRunEventSchema>;

export const EvidenceReceiptSchema = z.object({
  receiptVersion: z.literal(1),
  id: IdentifierSchema,
  runId: IdentifierSchema,
  runtime: z.object({
    adapterId: z.string().min(1).max(100),
    adapterVersion: z.string().min(1).max(100),
    modelId: z.string().min(1).max(512),
    modelDigest: HashSchema.nullable()
  }),
  policyVersion: z.string().min(1).max(100),
  inputHashes: z.array(HashSchema).max(10_000),
  outputHashes: z.array(HashSchema).max(10_000),
  approvalIds: z.array(IdentifierSchema).max(1_000),
  actionEventIds: z.array(IdentifierSchema).max(100_000),
  checks: z.array(z.object({
    name: z.string().min(1).max(300),
    outcome: z.enum(["passed", "failed", "not-run"]),
    detail: z.string().max(4_000)
  })).max(1_000),
  errors: z.array(z.string().max(4_000)).max(1_000),
  unobservedActivity: z.array(z.string().max(2_000)).max(1_000),
  createdAt: IsoDateSchema
});
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
