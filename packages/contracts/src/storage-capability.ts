import { z } from "zod";

export const STORAGE_CAPABILITY_SCHEMA_VERSION = 1 as const;
export const STORAGE_CAPABILITY_DOMAIN = "switchboard/storage-capability/package-static-inspection/v1" as const;
export const STORAGE_CAPABILITY_MAIN_ENTRY = "dist/main/storage-capability-probe.cjs" as const;
export const STORAGE_CAPABILITY_UTILITY_ENTRY = "dist/daemon/storage-capability-probe.cjs" as const;
export const STORAGE_CAPABILITY_GATE_ENTRY = "dist/main/durable-spaces-gate.cjs" as const;
export const STORAGE_CAPABILITY_MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export const STORAGE_CAPABILITY_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PackageBytesSchema = z.number().int().positive().max(STORAGE_CAPABILITY_MAX_PACKAGE_BYTES);
const EntryBytesSchema = z.number().int().positive().max(STORAGE_CAPABILITY_MAX_ENTRY_BYTES);
const EntryIdentitySchema = z.strictObject({ sha256: Sha256Schema, bytes: EntryBytesSchema });

export const StorageCapabilityPackageStaticEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(STORAGE_CAPABILITY_SCHEMA_VERSION),
  domain: z.literal(STORAGE_CAPABILITY_DOMAIN),
  inspectionKind: z.literal("packaged-static-inspection"),
  durableSpacesEnabled: z.literal(false),
  package: z.strictObject({
    asarSha256: Sha256Schema,
    asarBytes: PackageBytesSchema
  }),
  entries: z.strictObject({
    mainProbe: EntryIdentitySchema.extend({
      path: z.literal(STORAGE_CAPABILITY_MAIN_ENTRY),
      safeStorageReference: z.literal("present")
    }),
    utilityProbe: EntryIdentitySchema.extend({
      path: z.literal(STORAGE_CAPABILITY_UTILITY_ENTRY),
      nodeSqliteReference: z.literal("present")
    }),
    durableSpacesGate: EntryIdentitySchema.extend({
      path: z.literal(STORAGE_CAPABILITY_GATE_ENTRY),
      durableSpacesEnabled: z.literal(false)
    })
  }),
  unobserved: z.strictObject({
    safeStorageAvailability: z.literal("unobserved"),
    safeStorageRoundtrip: z.literal("unobserved"),
    nodeSqliteModuleLoad: z.literal("unobserved"),
    databaseOpen: z.literal("unobserved"),
    fts5: z.literal("unobserved"),
    schemaTransaction: z.literal("unobserved"),
    restart: z.literal("unobserved"),
    recovery: z.literal("unobserved")
  })
});

export type StorageCapabilityPackageStaticEvidence = z.infer<
  typeof StorageCapabilityPackageStaticEvidenceSchema
>;
