/**
 * Whole-workspace recovery manifest module anchored in R24 multi-store manifest authority.
 *
 * Integrates directly with r24-recovery-manifest.ts, enforcing fail-closed readiness
 * invariants (status: "blocked", readyForRecovery: false, readyForExport: false) until
 * live Host writer coverage and trusted key broker wiring exist.
 */
import { createHash } from "node:crypto";
import { type PortableWorkspaceKeyEnvelope } from "../r24-portable-workspace-key-envelope.js";
import { type OwnedDataStoreId, OWNED_DATA_STORES } from "./owned-data-inventory.js";
import {
  RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION,
  RECOVERY_MANIFEST_DRAFT_DOMAIN,
  MAX_RECOVERY_MANIFEST_ENTRIES,
  MAX_RECOVERY_MANIFEST_DEPTH,
  MAX_RECOVERY_MANIFEST_PATH_BYTES,
  MAX_RECOVERY_MANIFEST_FILE_BYTES,
  MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES,
  DIGEST_NOTICE,
  SNAPSHOT_COORDINATION_NOTICE,
  DEFAULT_BLOCKED_REASONS,
  RecoveryManifestPlannerError,
  type AppStorageIdentityEvidence,
  type SourceRootIdentityEvidence,
  type StoreReceipt,
  type RecoveryBookSnapshotReceipt,
  type PortableKeyEnvelopeMetadata,
  type RecoveryManifestDraft,
  type RecoveryManifestReadiness,
  validateRecoveryManifestDraft,
  computeRecoveryManifestDraftDigest,
  computeStoreContentHash
} from "./r24-recovery-manifest.js";

export const RECOVERY_MANIFEST_MAGIC = "CADRANE-WORKSPACE-MANIFEST" as const;
export const RECOVERY_MANIFEST_VERSION = 1 as const;
export const RECOVERY_APP_IDENTITY = "Cadrane" as const;

export const MAX_RECOVERY_ENTRIES = MAX_RECOVERY_MANIFEST_ENTRIES; // 10,000
export const MAX_RECOVERY_PATH_DEPTH = MAX_RECOVERY_MANIFEST_DEPTH; // 32
export const MAX_RECOVERY_PATH_CHARS = MAX_RECOVERY_MANIFEST_PATH_BYTES; // 2,048
export const MAX_RECOVERY_FILE_BYTES = MAX_RECOVERY_MANIFEST_FILE_BYTES; // 64 MiB
export const MAX_RECOVERY_TOTAL_BYTES = MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES; // 64 MiB
export const MAX_RECOVERY_MANIFEST_BYTES = 10 * 1024 * 1024; // 10 MB

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONTROL_OR_NUL_REGEX = /[\x00-\x1f\x7f]/;

export class RecoveryManifestError extends RecoveryManifestPlannerError {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryManifestError";
  }
}

export interface RecoveryManifestStoreEntry {
  readonly storeId: OwnedDataStoreId;
  readonly classification: "portable-data" | "machine-bound" | "regenerable" | "unknown";
  readonly entryCount: number;
  readonly totalBytes: number;
}

export interface RecoveryManifestFileEntry {
  readonly relativePath: string;
  readonly storeId: OwnedDataStoreId;
  readonly kind: "file" | "directory";
  readonly bytes: number;
  readonly sha256: string;
}

export interface WorkspaceRecoveryManifest {
  readonly magic: typeof RECOVERY_MANIFEST_MAGIC;
  readonly schemaVersion: typeof RECOVERY_MANIFEST_VERSION;
  readonly appIdentity: typeof RECOVERY_APP_IDENTITY;
  readonly sourceIdentity: string;
  readonly createdAt: string;
  readonly bookSchema: number;
  readonly stores: readonly RecoveryManifestStoreEntry[];
  readonly files: readonly RecoveryManifestFileEntry[];
  readonly keyEnvelope: PortableWorkspaceKeyEnvelope | null;
  readonly exclusions: readonly string[];
  readonly totalFiles: number;
  readonly totalPlainBytes: number;
  readonly manifestSha256: string;
  readonly readiness: RecoveryManifestReadiness;
}

export interface CreateRecoveryManifestInput {
  readonly sourceIdentity: string;
  readonly bookSchema: number;
  readonly files: readonly RecoveryManifestFileEntry[];
  readonly keyEnvelope?: PortableWorkspaceKeyEnvelope | null;
  readonly exclusions?: readonly string[];
}

export function isSafeRecoveryRelativePath(relPath: string): boolean {
  if (
    !relPath ||
    typeof relPath !== "string" ||
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    relPath.startsWith("/") ||
    relPath.length > MAX_RECOVERY_PATH_CHARS ||
    CONTROL_OR_NUL_REGEX.test(relPath)
  ) {
    return false;
  }
  const parts = relPath.split("/");
  if (parts.length > MAX_RECOVERY_PATH_DEPTH) {
    return false;
  }
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      return false;
    }
  }
  return true;
}

export function computeManifestSha256(
  manifest: Omit<WorkspaceRecoveryManifest, "manifestSha256">
): string {
  const json = JSON.stringify({
    magic: manifest.magic,
    schemaVersion: manifest.schemaVersion,
    appIdentity: manifest.appIdentity,
    sourceIdentity: manifest.sourceIdentity,
    createdAt: manifest.createdAt,
    bookSchema: manifest.bookSchema,
    stores: manifest.stores,
    files: manifest.files,
    keyEnvelope: manifest.keyEnvelope,
    exclusions: manifest.exclusions,
    totalFiles: manifest.totalFiles,
    totalPlainBytes: manifest.totalPlainBytes,
    readiness: manifest.readiness
  });
  return createHash("sha256").update(json, "utf8").digest("hex");
}

export function createRecoveryManifest(
  input: CreateRecoveryManifestInput
): WorkspaceRecoveryManifest {
  if (!input.sourceIdentity || typeof input.sourceIdentity !== "string" || input.sourceIdentity.length > 200) {
    throw new RecoveryManifestError("Invalid sourceIdentity for recovery manifest.");
  }
  if (!Number.isSafeInteger(input.bookSchema) || input.bookSchema < 1) {
    throw new RecoveryManifestError("Invalid bookSchema for recovery manifest.");
  }
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > MAX_RECOVERY_ENTRIES) {
    throw new RecoveryManifestError("File entries count exceeds bounded limits or is empty.");
  }

  const seenPaths = new Set<string>();
  let totalFiles = 0;
  let totalPlainBytes = 0;
  const storeCounts = new Map<OwnedDataStoreId, { count: number; bytes: number }>();

  for (const file of input.files) {
    if (!isSafeRecoveryRelativePath(file.relativePath)) {
      throw new RecoveryManifestError(`Unsafe or invalid relative path: ${file.relativePath}`);
    }
    if (seenPaths.has(file.relativePath)) {
      throw new RecoveryManifestError(`Duplicate file path in manifest: ${file.relativePath}`);
    }
    seenPaths.add(file.relativePath);

    if (file.kind !== "file" && file.kind !== "directory") {
      throw new RecoveryManifestError(`Invalid entry kind: ${file.kind}`);
    }

    if (file.kind === "file") {
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_RECOVERY_FILE_BYTES) {
        throw new RecoveryManifestError(`File size exceeds bounded limits: ${file.relativePath} (${file.bytes} bytes)`);
      }
      if (!SHA256_HEX.test(file.sha256)) {
        throw new RecoveryManifestError(`Invalid sha256 digest: ${file.relativePath}`);
      }
      totalFiles += 1;
      totalPlainBytes += file.bytes;
      if (totalPlainBytes > MAX_RECOVERY_TOTAL_BYTES) {
        throw new RecoveryManifestError(`Total plain bytes exceeds bounded limit (${MAX_RECOVERY_TOTAL_BYTES} bytes).`);
      }
    } else {
      if (file.bytes !== 0 || file.sha256 !== "") {
        throw new RecoveryManifestError(`Directory entry must have 0 bytes and empty sha256: ${file.relativePath}`);
      }
    }

    const current = storeCounts.get(file.storeId) ?? { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += file.bytes;
    storeCounts.set(file.storeId, current);
  }

  const stores: RecoveryManifestStoreEntry[] = [];
  for (const storeDef of OWNED_DATA_STORES) {
    const stat = storeCounts.get(storeDef.id);
    if (stat) {
      stores.push({
        storeId: storeDef.id,
        classification: storeDef.class,
        entryCount: stat.count,
        totalBytes: stat.bytes
      });
    }
  }

  // Preserve whole-root unavailable status until real writer coverage and key broker wiring exist
  const readiness: RecoveryManifestReadiness = Object.freeze({
    readyForRecovery: false,
    readyForExport: false,
    authenticated: false,
    quiescenceAttested: false,
    brokerAttested: false,
    coherentSnapshotCoordinated: false,
    status: "blocked",
    blockedReasons: Object.freeze([
      ...DEFAULT_BLOCKED_REASONS,
      "Descriptor pinning boundary: Node filesystem operations cannot guarantee atomic immunity to concurrent parent directory swaps without native descriptor pins.",
      "Host writer integration: WorkstationHost writer registration must be integrated in production service.ts."
    ])
  });

  const baseManifest = {
    magic: RECOVERY_MANIFEST_MAGIC,
    schemaVersion: RECOVERY_MANIFEST_VERSION,
    appIdentity: RECOVERY_APP_IDENTITY,
    sourceIdentity: input.sourceIdentity,
    createdAt: new Date().toISOString(),
    bookSchema: input.bookSchema,
    stores: Object.freeze(stores),
    files: Object.freeze([...input.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))),
    keyEnvelope: input.keyEnvelope ?? null,
    exclusions: Object.freeze(input.exclusions ? [...input.exclusions] : []),
    totalFiles,
    totalPlainBytes,
    readiness
  };

  const manifestSha256 = computeManifestSha256(baseManifest);

  return Object.freeze({
    ...baseManifest,
    manifestSha256
  });
}

export function validateRecoveryManifest(data: unknown): WorkspaceRecoveryManifest {
  if (typeof data !== "object" || data === null) {
    throw new RecoveryManifestError("Manifest must be a non-null object.");
  }
  const obj = data as Record<string, unknown>;

  if (obj.magic !== RECOVERY_MANIFEST_MAGIC) {
    throw new RecoveryManifestError("Invalid recovery manifest magic identifier.");
  }
  if (obj.schemaVersion !== RECOVERY_MANIFEST_VERSION) {
    throw new RecoveryManifestError(`Unsupported recovery manifest schema version: ${obj.schemaVersion}`);
  }
  if (obj.appIdentity !== RECOVERY_APP_IDENTITY) {
    throw new RecoveryManifestError(`Mismatched app identity: expected ${RECOVERY_APP_IDENTITY}, got ${obj.appIdentity}`);
  }
  if (typeof obj.sourceIdentity !== "string" || obj.sourceIdentity.length === 0 || obj.sourceIdentity.length > 200) {
    throw new RecoveryManifestError("Invalid sourceIdentity in manifest.");
  }
  if (typeof obj.createdAt !== "string" || Number.isNaN(Date.parse(obj.createdAt))) {
    throw new RecoveryManifestError("Invalid createdAt timestamp in manifest.");
  }
  if (!Number.isSafeInteger(obj.bookSchema) || (obj.bookSchema as number) < 1) {
    throw new RecoveryManifestError("Invalid bookSchema in manifest.");
  }
  if (!Array.isArray(obj.files) || obj.files.length === 0 || obj.files.length > MAX_RECOVERY_ENTRIES) {
    throw new RecoveryManifestError("Manifest files array is empty or exceeds bounded capacity.");
  }
  if (!Array.isArray(obj.stores)) {
    throw new RecoveryManifestError("Manifest stores array is missing or invalid.");
  }
  if (!Array.isArray(obj.exclusions)) {
    throw new RecoveryManifestError("Manifest exclusions must be an array.");
  }

  const readiness = obj.readiness as RecoveryManifestReadiness | undefined;
  if (!readiness || typeof readiness !== "object") {
    throw new RecoveryManifestError("Missing manifest readiness section");
  }
  if (
    readiness.readyForRecovery !== false ||
    readiness.readyForExport !== false ||
    readiness.status !== "blocked" ||
    !Array.isArray(readiness.blockedReasons) ||
    readiness.blockedReasons.length === 0
  ) {
    throw new RecoveryManifestError("Readiness invariants violated: manifest must remain strictly blocked and unavailable.");
  }

  const seenPaths = new Set<string>();
  let calculatedFiles = 0;
  let calculatedBytes = 0;

  for (const raw of obj.files) {
    if (typeof raw !== "object" || raw === null) {
      throw new RecoveryManifestError("Invalid file entry in manifest.");
    }
    const file = raw as RecoveryManifestFileEntry;
    if (!isSafeRecoveryRelativePath(file.relativePath)) {
      throw new RecoveryManifestError(`Unsafe or malformed relative path in manifest: ${file.relativePath}`);
    }
    if (seenPaths.has(file.relativePath)) {
      throw new RecoveryManifestError(`Duplicate file path in manifest: ${file.relativePath}`);
    }
    seenPaths.add(file.relativePath);

    if (file.kind !== "file" && file.kind !== "directory") {
      throw new RecoveryManifestError(`Invalid entry kind for ${file.relativePath}: ${file.kind}`);
    }

    if (file.kind === "file") {
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_RECOVERY_FILE_BYTES) {
        throw new RecoveryManifestError(`File size exceeds bounded limits: ${file.relativePath}`);
      }
      if (!SHA256_HEX.test(file.sha256)) {
        throw new RecoveryManifestError(`Invalid sha256 digest in manifest: ${file.relativePath}`);
      }
      calculatedFiles += 1;
      calculatedBytes += file.bytes;
    } else {
      if (file.bytes !== 0 || file.sha256 !== "") {
        throw new RecoveryManifestError(`Directory entry has invalid bytes/sha256: ${file.relativePath}`);
      }
    }
  }

  if (obj.totalFiles !== calculatedFiles || obj.totalPlainBytes !== calculatedBytes) {
    throw new RecoveryManifestError("Manifest total file count or byte tally disagrees with itemised entries.");
  }

  if (typeof obj.manifestSha256 !== "string" || !SHA256_HEX.test(obj.manifestSha256)) {
    throw new RecoveryManifestError("Invalid manifestSha256 digest string.");
  }

  const expectedSha256 = computeManifestSha256({
    magic: obj.magic as typeof RECOVERY_MANIFEST_MAGIC,
    schemaVersion: obj.schemaVersion as typeof RECOVERY_MANIFEST_VERSION,
    appIdentity: obj.appIdentity as typeof RECOVERY_APP_IDENTITY,
    sourceIdentity: obj.sourceIdentity as string,
    createdAt: obj.createdAt as string,
    bookSchema: obj.bookSchema as number,
    stores: obj.stores as readonly RecoveryManifestStoreEntry[],
    files: obj.files as readonly RecoveryManifestFileEntry[],
    keyEnvelope: (obj.keyEnvelope ?? null) as PortableWorkspaceKeyEnvelope | null,
    exclusions: obj.exclusions as readonly string[],
    totalFiles: obj.totalFiles as number,
    totalPlainBytes: obj.totalPlainBytes as number,
    readiness
  });

  if (obj.manifestSha256 !== expectedSha256) {
    throw new RecoveryManifestError("Manifest integrity check failed: manifestSha256 digest mismatch.");
  }

  return obj as unknown as WorkspaceRecoveryManifest;
}

// Re-export r24-recovery-manifest authority
export {
  RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION,
  RECOVERY_MANIFEST_DRAFT_DOMAIN,
  DIGEST_NOTICE,
  SNAPSHOT_COORDINATION_NOTICE,
  DEFAULT_BLOCKED_REASONS,
  RecoveryManifestPlannerError,
  validateRecoveryManifestDraft,
  computeRecoveryManifestDraftDigest,
  computeStoreContentHash,
  type RecoveryManifestDraft,
  type RecoveryManifestReadiness,
  type AppStorageIdentityEvidence,
  type SourceRootIdentityEvidence,
  type StoreReceipt,
  type RecoveryBookSnapshotReceipt,
  type PortableKeyEnvelopeMetadata
};
