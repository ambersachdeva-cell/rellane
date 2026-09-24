import { describe, expect, it } from "vitest";
import {
  STORAGE_CAPABILITY_DOMAIN,
  STORAGE_CAPABILITY_GATE_ENTRY,
  STORAGE_CAPABILITY_MAIN_ENTRY,
  STORAGE_CAPABILITY_UTILITY_ENTRY,
  StorageCapabilityPackageStaticEvidenceSchema
} from "./storage-capability.js";

const HASH = "a".repeat(64);

describe("StorageCapabilityPackageStaticEvidenceSchema", () => {
  it("accepts only deterministic package-static evidence with explicit unobserved facts", () => {
    expect(StorageCapabilityPackageStaticEvidenceSchema.parse(evidence())).toEqual(evidence());
  });

  it.each([
    ["timestamps", { inspectedAt: "2026-08-02T00:00:00.000Z" }],
    ["host paths", { asarPath: "/private/app.asar" }],
    ["availability claims", { available: true }],
    ["platform support claims", { macosSupported: true }]
  ])("rejects extra %s", (_name, extra) => {
    expect(StorageCapabilityPackageStaticEvidenceSchema.safeParse({ ...evidence(), ...extra }).success).toBe(false);
  });

  it("rejects false observations, noncanonical hashes, wrong entries, and oversized bytes", () => {
    const base = evidence();
    expect(StorageCapabilityPackageStaticEvidenceSchema.safeParse({
      ...base, unobserved: { ...base.unobserved, databaseOpen: "observed" }
    }).success).toBe(false);
    expect(StorageCapabilityPackageStaticEvidenceSchema.safeParse({
      ...base, package: { asarSha256: HASH.toUpperCase(), asarBytes: 1 }
    }).success).toBe(false);
    expect(StorageCapabilityPackageStaticEvidenceSchema.safeParse({
      ...base, entries: { ...base.entries, mainProbe: { ...base.entries.mainProbe, path: "dist/main/index.cjs" } }
    }).success).toBe(false);
    expect(StorageCapabilityPackageStaticEvidenceSchema.safeParse({
      ...base, entries: { ...base.entries, utilityProbe: { ...base.entries.utilityProbe, bytes: 2 * 1024 * 1024 + 1 } }
    }).success).toBe(false);
  });
});

function evidence() {
  return {
    schemaVersion: 1 as const,
    domain: STORAGE_CAPABILITY_DOMAIN,
    inspectionKind: "packaged-static-inspection" as const,
    durableSpacesEnabled: false as const,
    package: { asarSha256: HASH, asarBytes: 1024 },
    entries: {
      mainProbe: { path: STORAGE_CAPABILITY_MAIN_ENTRY, sha256: HASH, bytes: 64, safeStorageReference: "present" as const },
      utilityProbe: { path: STORAGE_CAPABILITY_UTILITY_ENTRY, sha256: HASH, bytes: 64, nodeSqliteReference: "present" as const },
      durableSpacesGate: { path: STORAGE_CAPABILITY_GATE_ENTRY, sha256: HASH, bytes: 64, durableSpacesEnabled: false as const }
    },
    unobserved: {
      safeStorageAvailability: "unobserved" as const,
      safeStorageRoundtrip: "unobserved" as const,
      nodeSqliteModuleLoad: "unobserved" as const,
      databaseOpen: "unobserved" as const,
      fts5: "unobserved" as const,
      schemaTransaction: "unobserved" as const,
      restart: "unobserved" as const,
      recovery: "unobserved" as const
    }
  };
}
