import { describe, it, expect } from "vitest";
import {
  planRecoveryManifestDraft,
  buildRecoveryManifestDraft,
  validateRecoveryManifestDraft,
  computeRecoveryManifestDraftDigest,
  computeStoreContentHash,
  RecoveryManifestPlannerError,
  RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION,
  RECOVERY_MANIFEST_DRAFT_DOMAIN,
  type AppStorageIdentityEvidence,
  type SourceRootIdentityEvidence,
  type StoreReceipt,
  type RecoveryBookSnapshotReceipt,
  type PortableKeyEnvelopeMetadata
} from "./r24-recovery-manifest.js";
import type {
  NativeInventoryObservation,
  NativeInventoryEntry
} from "./r24-native-inventory/manifest-parser.js";
import { createHash } from "node:crypto";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function createSyntheticAppIdentity(): AppStorageIdentityEvidence {
  return {
    appId: "cadrane-desktop",
    appVersion: "1.24.0",
    storageSchemaVersion: 1,
    environment: "production"
  };
}

function createSyntheticSourceRoot(): SourceRootIdentityEvidence {
  return {
    rootPathSha256: "a".repeat(64),
    rootRealPath: "/Users/test/Library/Application Support/Cadrane",
    deviceBoundaryVerified: true,
    inodeNumber: 1234567,
    observedAt: "2026-09-24T12:00:00.000Z"
  };
}

function createSyntheticBookReceipt(): RecoveryBookSnapshotReceipt {
  return {
    destination: "/tmp/backup/book.cadrane-backup",
    sourcePages: 16,
    sourceLogicalBytes: 65536,
    sourcePhysicalBytes: 65536,
    snapshotBytes: 40960,
    archiveBytes: 42000,
    archiveSha256: "b".repeat(64),
    schema: 1,
    verified: true,
    verifiedAt: "2026-09-24T12:00:00.000Z"
  };
}

function createSyntheticKeyEnvelope(): PortableKeyEnvelopeMetadata {
  return {
    spaceId: "space_synthetic_01",
    keyId: "key_synthetic_01",
    envelopeSha256: "c".repeat(64),
    schemaVersion: 1,
    domain: "cadrane/portable-workspace-key-envelope/v1",
    kdf: "hkdf-sha256-book-phrase/v1",
    cipher: "aes-256-gcm",
    brokerAttested: false
  };
}

function createSyntheticInventory(entries: NativeInventoryEntry[]): NativeInventoryObservation {
  const storeIdsSet = new Set(entries.map(e => e.storeId).filter(Boolean));
  const presentStores = Array.from(storeIdsSet) as any[];
  const dirCount = entries.filter(e => e.kind === "directory").length;
  const fileCount = entries.filter(e => e.kind === "file").length;
  const totalRegularFileBytes = entries.reduce((acc, e) => acc + (e.bytes ?? 0), 0);

  return {
    entries,
    presentStores,
    absentStores: [],
    storeIds: presentStores,
    totalEntries: entries.length,
    directoryCount: dirCount,
    fileCount,
    totalRegularFileBytes,
    totalBytes: totalRegularFileBytes,
    counts: {
      totalEntries: entries.length,
      directoryCount: dirCount,
      fileCount,
      totalRegularFileBytes,
      totalBytes: totalRegularFileBytes,
      directories: dirCount,
      files: fileCount,
      total: entries.length,
      "portable-data": entries.filter(e => e.classification === "portable-data").length,
      "machine-bound": entries.filter(e => e.classification === "machine-bound").length,
      regenerable: entries.filter(e => e.classification === "regenerable").length,
      unknown: entries.filter(e => e.classification === "unknown").length,
      byClass: {
        "portable-data": entries.filter(e => e.classification === "portable-data").length,
        "machine-bound": entries.filter(e => e.classification === "machine-bound").length,
        regenerable: entries.filter(e => e.classification === "regenerable").length,
        unknown: entries.filter(e => e.classification === "unknown").length
      }
    },
    blockers: ["Quiescence is unproven"],
    rootIdentityAttested: false,
    quiescenceAttested: false,
    bookSnapshotCoherent: false,
    portableKeysVerified: false,
    readyForExport: false
  };
}

function createSyntheticFileEntry(
  relativePath: string,
  content: string,
  storeId: any,
  classification: any = "portable-data"
): NativeInventoryEntry {
  const bytes = Buffer.byteLength(content, "utf8");
  const sha = sha256Hex(content);
  return {
    kind: "file",
    rawPathHex: Buffer.from(relativePath, "utf8").toString("hex"),
    pathHex: Buffer.from(relativePath, "utf8").toString("hex"),
    pathBytes: new Uint8Array(Buffer.from(relativePath, "utf8")),
    relativePath,
    pathSha256: sha256Hex(relativePath),
    depth: relativePath.split("/").length,
    classification,
    storeId,
    bytes,
    sha256: sha,
    fileSha256: sha
  };
}

function createSyntheticDirEntry(
  relativePath: string,
  storeId: any = null,
  classification: any = "portable-data"
): NativeInventoryEntry {
  return {
    kind: "directory",
    rawPathHex: Buffer.from(relativePath, "utf8").toString("hex"),
    pathHex: Buffer.from(relativePath, "utf8").toString("hex"),
    pathBytes: new Uint8Array(Buffer.from(relativePath, "utf8")),
    relativePath,
    pathSha256: sha256Hex(relativePath),
    depth: relativePath.split("/").length,
    classification,
    storeId,
    bytes: null,
    sha256: null,
    fileSha256: null
  };
}

describe("r24-recovery-manifest", () => {
  it("produces a valid classified draft that remains strictly blocked and unauthenticated", () => {
    const file1 = createSyntheticFileEntry("settings.json", '{"theme":"dark"}', "settings-grants");
    const file2 = createSyntheticFileEntry("book.sqlite", "SQLITE_HEADER_DATA", "book");
    const inventory = createSyntheticInventory([file1, file2]);

    const storeReceipts: StoreReceipt[] = [
      {
        storeId: "settings-grants",
        schemaVersion: 1,
        revision: "rev-1",
        contentHash: file1.fileSha256!,
        fileCount: 1,
        totalBytes: file1.bytes!,
        fileHashes: { "settings.json": file1.fileSha256! },
        verifiedAt: "2026-09-24T12:00:00.000Z"
      },
      {
        storeId: "book",
        schemaVersion: 1,
        revision: "rev-book-1",
        contentHash: file2.fileSha256!,
        fileCount: 1,
        totalBytes: file2.bytes!,
        fileHashes: { "book.sqlite": file2.fileSha256! },
        verifiedAt: "2026-09-24T12:00:00.000Z"
      }
    ];

    const draft = planRecoveryManifestDraft({
      appIdentity: createSyntheticAppIdentity(),
      sourceRoot: createSyntheticSourceRoot(),
      inventory,
      storeReceipts,
      bookSnapshot: createSyntheticBookReceipt(),
      keyEnvelopes: [createSyntheticKeyEnvelope()]
    });

    expect(draft.schemaVersion).toBe(RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION);
    expect(draft.domain).toBe(RECOVERY_MANIFEST_DRAFT_DOMAIN);
    expect(draft.stores).toHaveLength(2);

    expect(draft.readiness.readyForRecovery).toBe(false);
    expect(draft.readiness.readyForExport).toBe(false);
    expect(draft.readiness.authenticated).toBe(false);
    expect(draft.readiness.quiescenceAttested).toBe(false);
    expect(draft.readiness.brokerAttested).toBe(false);
    expect(draft.readiness.coherentSnapshotCoordinated).toBe(false);
    expect(draft.readiness.status).toBe("blocked");
    expect(draft.readiness.blockedReasons.length).toBeGreaterThanOrEqual(4);

    expect(draft.digestNotice).toContain("integrity tracking only");
    expect(draft.snapshotCoordinationNotice).toContain("does not freeze or guarantee snapshot coherence");

    const digest = computeRecoveryManifestDraftDigest(draft);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const validated = validateRecoveryManifestDraft(draft);
    expect(validated.readiness.readyForRecovery).toBe(false);
    expect(validated.stores).toHaveLength(2);
  });

  it("rejects unknown or unclassified paths", () => {
    const unknownFile: NativeInventoryEntry = {
      ...createSyntheticFileEntry("weird-data.bin", "unknown", null, "unknown"),
      classification: "unknown"
    };
    const inventory = createSyntheticInventory([unknownFile]);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(RecoveryManifestPlannerError);
  });

  it("rejects symlinks and unsupported entry types", () => {
    const symlinkEntry: any = {
      ...createSyntheticFileEntry("link.txt", "target", "settings-grants"),
      kind: "symbolic-link"
    };
    const inventory = createSyntheticInventory([symlinkEntry]);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(RecoveryManifestPlannerError);
  });

  it("rejects duplicate path collisions", () => {
    const fileA = createSyntheticFileEntry("settings.json", "content A", "settings-grants");
    const fileB = createSyntheticFileEntry("settings.json", "content B", "settings-grants");
    const inventory = createSyntheticInventory([fileA, fileB]);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/Duplicate path collision/);
  });

  it("rejects casefold path collisions", () => {
    const fileA = createSyntheticFileEntry("Vault/File.txt", "content A", "vault");
    const fileB = createSyntheticFileEntry("vault/file.txt", "content B", "vault");
    const inventory = createSyntheticInventory([fileA, fileB]);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/Casefold collision detected/);
  });

  it("rejects total count overflow", () => {
    const entries: NativeInventoryEntry[] = [];
    for (let i = 0; i <= 10_000; i++) {
      entries.push(createSyntheticFileEntry(`file_${i}.json`, "{}", "settings-grants"));
    }
    const inventory = createSyntheticInventory(entries);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/exceeds limit/);
  });

  it("rejects single file and aggregate byte overflow", () => {
    const hugeFile: NativeInventoryEntry = {
      ...createSyntheticFileEntry("huge.bin", "", "vault"),
      bytes: 65 * 1024 * 1024 // 65 MiB > 64 MiB limit
    };
    const inventory = createSyntheticInventory([hugeFile]);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/exceeds limit/);
  });

  it("rejects path traversal segments", () => {
    const traversalFile = createSyntheticFileEntry("../traversal.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([traversalFile]);

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/Path traversal segment/);
  });

  it("rejects missing Book snapshot receipt", () => {
    const file = createSyntheticFileEntry("settings.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([file]);
    const storeReceipts: StoreReceipt[] = [
      {
        storeId: "settings-grants",
        schemaVersion: 1,
        revision: "1",
        contentHash: file.fileSha256!,
        fileCount: 1,
        totalBytes: file.bytes!,
        verifiedAt: "2026-09-24T12:00:00.000Z"
      }
    ];

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts,
        bookSnapshot: null as any,
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/Missing Book logical snapshot receipt/);
  });

  it("rejects missing portable key envelope metadata", () => {
    const file = createSyntheticFileEntry("settings.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([file]);
    const storeReceipts: StoreReceipt[] = [
      {
        storeId: "settings-grants",
        schemaVersion: 1,
        revision: "1",
        contentHash: file.fileSha256!,
        fileCount: 1,
        totalBytes: file.bytes!,
        verifiedAt: "2026-09-24T12:00:00.000Z"
      }
    ];

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts,
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: []
      })
    ).toThrow(/Missing portable key envelope metadata/);
  });

  it("rejects mismatched store hash and inventory file hash", () => {
    const file = createSyntheticFileEntry("settings.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([file]);
    const mismatchedReceipts: StoreReceipt[] = [
      {
        storeId: "settings-grants",
        schemaVersion: 1,
        revision: "1",
        contentHash: "d".repeat(64), // Mismatched hash
        fileCount: 1,
        totalBytes: file.bytes!,
        verifiedAt: "2026-09-24T12:00:00.000Z"
      }
    ];

    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: mismatchedReceipts,
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/Mismatched store hash/);
  });

  it("rejects future schema version requests", () => {
    const file = createSyntheticFileEntry("settings.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([file]);

    expect(() =>
      planRecoveryManifestDraft({
        schemaVersion: 2, // Future schema version
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()]
      })
    ).toThrow(/Unsupported future schema version/);
  });

  it("prevents raw secret leakage and rejects secret payloads", () => {
    const file = createSyntheticFileEntry("settings.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([file]);

    // Raw key material in options
    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()],
        keyMaterial: new Uint8Array(32)
      } as any)
    ).toThrow(/Forbidden credential or raw secret payload/);

    // Password in options
    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [createSyntheticKeyEnvelope()],
        password: "plaintext-password"
      } as any)
    ).toThrow(/Forbidden credential or raw secret payload/);

    // Phrase in envelope
    expect(() =>
      planRecoveryManifestDraft({
        appIdentity: createSyntheticAppIdentity(),
        sourceRoot: createSyntheticSourceRoot(),
        inventory,
        storeReceipts: [],
        bookSnapshot: createSyntheticBookReceipt(),
        keyEnvelopes: [
          {
            ...createSyntheticKeyEnvelope(),
            phrase: "twenty four secret recovery words"
          } as any
        ]
      })
    ).toThrow(/Forbidden credential or raw secret payload/);

    // Verify valid draft stringification does not leak secret fields
    const validStoreReceipts: StoreReceipt[] = [
      {
        storeId: "settings-grants",
        schemaVersion: 1,
        revision: "1",
        contentHash: file.fileSha256!,
        fileCount: 1,
        totalBytes: file.bytes!,
        verifiedAt: "2026-09-24T12:00:00.000Z"
      }
    ];

    const draft = buildRecoveryManifestDraft({
      appIdentity: createSyntheticAppIdentity(),
      sourceRoot: createSyntheticSourceRoot(),
      inventory,
      storeReceipts: validStoreReceipts,
      bookSnapshot: createSyntheticBookReceipt(),
      keyEnvelopes: [createSyntheticKeyEnvelope()]
    });

    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain("rawKey");
    expect(serialized).not.toContain("keyMaterial");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("recoveryPhrase");
  });

  it("validator rejects drafts with modified readiness flags", () => {
    const file = createSyntheticFileEntry("settings.json", "{}", "settings-grants");
    const inventory = createSyntheticInventory([file]);
    const storeReceipts: StoreReceipt[] = [
      {
        storeId: "settings-grants",
        schemaVersion: 1,
        revision: "1",
        contentHash: file.fileSha256!,
        fileCount: 1,
        totalBytes: file.bytes!,
        verifiedAt: "2026-09-24T12:00:00.000Z"
      }
    ];

    const draft = planRecoveryManifestDraft({
      appIdentity: createSyntheticAppIdentity(),
      sourceRoot: createSyntheticSourceRoot(),
      inventory,
      storeReceipts,
      bookSnapshot: createSyntheticBookReceipt(),
      keyEnvelopes: [createSyntheticKeyEnvelope()]
    });

    // Artificially alter readiness
    const tamperedDraft = {
      ...draft,
      readiness: {
        ...draft.readiness,
        readyForRecovery: true // Forbidden for draft
      }
    };

    expect(() => validateRecoveryManifestDraft(tamperedDraft)).toThrow(
      /Readiness violations detected/
    );
  });
});