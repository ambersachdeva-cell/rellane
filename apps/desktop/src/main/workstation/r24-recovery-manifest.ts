/**
 * Bounded, strict DRAFT multi-store recovery manifest planner from trusted observations.
 *
 * Current native inventory and classification observe source trees but explicitly
 * cannot prove quiescence, lack of concurrent mutation, or coherent cross-store state.
 * The key envelope format is established, but no trusted portable workspace-key broker
 * exists.
 *
 * This module builds and validates versioned manifest drafts only. A draft is never
 * export-ready or authenticated; readiness flags remain strictly false with explicit
 * blocked dependencies documented until live quiescence, broker, Book and coordinated
 * snapshot evidence are wired.
 */
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  OWNED_DATA_STORES,
  type OwnedDataClass,
  type OwnedDataStoreId
} from "./owned-data-inventory.js";
import type {
  NativeInventoryEntry,
  NativeInventoryObservation
} from "./r24-native-inventory/manifest-parser.js";
import type { BoundedBookArchiveReceipt } from "../book/bounded-archive.js";

export const RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION = 1 as const;
export const RECOVERY_MANIFEST_DRAFT_DOMAIN = "cadrane/recovery-manifest-draft/v1" as const;

export const MAX_RECOVERY_MANIFEST_ENTRIES = 10_000;
export const MAX_RECOVERY_MANIFEST_DEPTH = 32;
export const MAX_RECOVERY_MANIFEST_PATH_BYTES = 2_048;
export const MAX_RECOVERY_MANIFEST_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES = 64 * 1024 * 1024; // 64 MiB

export const DIGEST_NOTICE =
  "A SHA-256 digest of a draft manifest provides integrity tracking only; it is NOT cryptographic authentication and does not make the draft ready for recovery." as const;

export const SNAPSHOT_COORDINATION_NOTICE =
  "The logical Book SQLite snapshot receipt verifies Book database integrity only; it does not freeze or guarantee snapshot coherence across independent stores." as const;

export const DEFAULT_BLOCKED_REASONS = [
  "Quiescence is unproven: inventory observation cannot attest absence of concurrent filesystem writes during scan.",
  "Portable workspace-key broker is absent: no trusted portable key broker exists; key envelopes are unbrokered draft metadata.",
  "Cross-store snapshot coherence is unproven: Book SQLite logical snapshot does not coordinate or freeze external filesystem stores.",
  "Draft integrity digest is not authentication: a SHA-256 digest of this draft does not authenticate or certify it for recovery."
] as const;

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const CONTROL_OR_NUL_REGEX = /[\x00-\x1f\x7f]/;
const KNOWN_STORE_IDS: ReadonlySet<string> = new Set(OWNED_DATA_STORES.map(s => s.id));

const FORBIDDEN_SECRET_TERMS = [
  "keymaterial",
  "rawkey",
  "phrase",
  "recoveryphrase",
  "mnemonic",
  "password",
  "passphrase",
  "seed",
  "privatekey",
  "plaintext"
] as const;

export class RecoveryManifestPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryManifestPlannerError";
  }
}

export interface AppStorageIdentityEvidence {
  readonly appId: string;
  readonly appVersion: string;
  readonly storageSchemaVersion: number;
  readonly environment?: string;
}

export interface SourceRootIdentityEvidence {
  readonly rootPathSha256: string;
  readonly rootRealPath: string;
  readonly deviceBoundaryVerified: boolean;
  readonly inodeNumber?: number | string;
  readonly observedAt: string;
}

export interface StoreReceipt {
  readonly storeId: OwnedDataStoreId;
  readonly schemaVersion: number;
  readonly revision: string;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly fileHashes?: Readonly<Record<string, string>>;
  readonly verifiedAt: string;
}

export type RecoveryBookSnapshotReceipt = BoundedBookArchiveReceipt;

export interface PortableKeyEnvelopeMetadata {
  readonly spaceId: string;
  readonly keyId: string;
  readonly envelopeSha256: string;
  readonly schemaVersion: number;
  readonly domain: string;
  readonly kdf: string;
  readonly cipher: string;
  readonly brokerAttested: false;
}

export type RecoveryKeyEnvelopeMetadata = PortableKeyEnvelopeMetadata;

export type PortableKeyEnvelopeInput = PortableKeyEnvelopeMetadata;

export interface RecoveryManifestFileEntry {
  readonly relativePath: string;
  readonly pathSha256: string;
  readonly depth: number;
  readonly bytes: number;
  readonly fileSha256: string;
}

export interface RecoveryManifestStoreEntry {
  readonly storeId: OwnedDataStoreId;
  readonly classification: OwnedDataClass;
  readonly schemaVersion: number;
  readonly revision: string;
  readonly contentHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly RecoveryManifestFileEntry[];
  readonly receiptVerifiedAt: string;
}

export interface RecoveryManifestInventorySummary {
  readonly totalEntries: number;
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly totalFileBytes: number;
  readonly presentStores: readonly OwnedDataStoreId[];
  readonly absentStores: readonly OwnedDataStoreId[];
  readonly countsByClass: Readonly<Record<OwnedDataClass, number>>;
}

export interface RecoveryManifestReadiness {
  readonly readyForRecovery: false;
  readonly readyForExport: false;
  readonly authenticated: false;
  readonly quiescenceAttested: false;
  readonly brokerAttested: false;
  readonly coherentSnapshotCoordinated: false;
  readonly status: "blocked";
  readonly blockedReasons: readonly string[];
}

export interface RecoveryManifestDraft {
  readonly schemaVersion: typeof RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION;
  readonly domain: typeof RECOVERY_MANIFEST_DRAFT_DOMAIN;
  readonly draftCreatedAt: string;
  readonly appIdentity: AppStorageIdentityEvidence;
  readonly sourceRoot: SourceRootIdentityEvidence;
  readonly inventorySummary: RecoveryManifestInventorySummary;
  readonly stores: readonly RecoveryManifestStoreEntry[];
  readonly bookSnapshot: RecoveryBookSnapshotReceipt;
  readonly keyEnvelopes: readonly PortableKeyEnvelopeMetadata[];
  readonly digestNotice: typeof DIGEST_NOTICE;
  readonly snapshotCoordinationNotice: typeof SNAPSHOT_COORDINATION_NOTICE;
  readonly readiness: RecoveryManifestReadiness;
}

export interface PlanRecoveryManifestDraftOptions {
  readonly schemaVersion?: number;
  readonly appIdentity: AppStorageIdentityEvidence;
  readonly sourceRoot: SourceRootIdentityEvidence;
  readonly inventory: NativeInventoryObservation;
  readonly storeReceipts: readonly StoreReceipt[];
  readonly bookSnapshot: RecoveryBookSnapshotReceipt;
  readonly keyEnvelopes: readonly PortableKeyEnvelopeInput[];
}

/**
 * Asserts that an input structure contains no raw secrets, passphrases,
 * passwords, or raw cryptographic keys.
 */
export function assertNoSecretPayloads(value: unknown, context = "root"): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    if (
      value instanceof Uint8Array &&
      !context.includes("envelope") &&
      !context.includes("receipt") &&
      /(?:^|\.)(?:inventory\.)?entries\[\d+\]\.pathBytes$/.test(context)
    ) {
      return;
    }
    throw new RecoveryManifestPlannerError(
      `Raw binary buffer or byte array is forbidden in recovery manifest planning at ${context}`
    );
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoSecretPayloads(value[i], `${context}[${i}]`);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key === "string") {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedKey !== "secretstore" && normalizedKey !== "secretstores") {
        if (
          normalizedKey === "secret" ||
          normalizedKey.includes("secretkey") ||
          normalizedKey.includes("rawsecret") ||
          FORBIDDEN_SECRET_TERMS.some(term => normalizedKey.includes(term))
        ) {
          throw new RecoveryManifestPlannerError(
            `Forbidden credential or raw secret payload field "${key}" detected at ${context}`
          );
        }
      }
      assertNoSecretPayloads(record[key], `${context}.${key}`);
    }
  }
}

/**
 * Deterministically computes a store content hash from inventory entries.
 */
export function computeStoreContentHash(
  files: readonly { readonly relativePath: string; readonly fileSha256?: string | null; readonly sha256?: string | null }[]
): string {
  if (files.length === 0) {
    return createHash("sha256").update("", "utf8").digest("hex");
  }
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash("sha256");
  for (const file of sorted) {
    const fileHash = file.fileSha256 ?? file.sha256 ?? "";
    hash.update(`${file.relativePath}\t${fileHash}\n`, "utf8");
  }
  return hash.digest("hex");
}

/**
 * Recursively serializes an object into canonical JSON with sorted keys.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys
    .filter(k => obj[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return "{" + pairs.join(",") + "}";
}

/**
 * Computes a SHA-256 digest of the canonical draft representation.
 *
 * NOTE: A SHA digest provides integrity verification of this draft only.
 * It is NOT an authentication attestation and does NOT make the draft
 * ready for recovery or export.
 */
export function computeRecoveryManifestDraftDigest(draft: RecoveryManifestDraft): string {
  validateRecoveryManifestDraft(draft);
  const canonical = canonicalJsonStringify(draft);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validateIsoTimestamp(timestamp: unknown, context: string): void {
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    throw new RecoveryManifestPlannerError(`${context} must be a non-empty ISO timestamp string`);
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new RecoveryManifestPlannerError(`${context} is an invalid timestamp: "${timestamp}"`);
  }
}

function assertValidPathString(relativePath: string): void {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new RecoveryManifestPlannerError("Path must be a non-empty string");
  }
  if (relativePath.startsWith("/")) {
    throw new RecoveryManifestPlannerError(`Absolute path is forbidden: "${relativePath}"`);
  }
  if (relativePath.includes("\\")) {
    throw new RecoveryManifestPlannerError(`Backslash in path is forbidden: "${relativePath}"`);
  }
  if (CONTROL_OR_NUL_REGEX.test(relativePath)) {
    throw new RecoveryManifestPlannerError(`Control or NUL character in path: "${relativePath}"`);
  }
  const segments = relativePath.split("/");
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new RecoveryManifestPlannerError(`Empty segment or duplicate slash in path: "${relativePath}"`);
    }
    if (seg === "." || seg === "..") {
      throw new RecoveryManifestPlannerError(`Path traversal segment "${seg}" in path: "${relativePath}"`);
    }
  }
}

function validateAppIdentity(evidence: AppStorageIdentityEvidence): void {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof evidence.appId !== "string" ||
    evidence.appId.length === 0 ||
    evidence.appId.length > 256 ||
    typeof evidence.appVersion !== "string" ||
    evidence.appVersion.length === 0 ||
    evidence.appVersion.length > 128 ||
    !Number.isSafeInteger(evidence.storageSchemaVersion) ||
    evidence.storageSchemaVersion < 1
  ) {
    throw new RecoveryManifestPlannerError("Invalid canonical app storage identity evidence");
  }
}

function validateSourceRootIdentity(evidence: SourceRootIdentityEvidence): void {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof evidence.rootPathSha256 !== "string" ||
    !SHA256_HEX_REGEX.test(evidence.rootPathSha256) ||
    typeof evidence.rootRealPath !== "string" ||
    evidence.rootRealPath.length === 0 ||
    !evidence.rootRealPath.startsWith("/") ||
    CONTROL_OR_NUL_REGEX.test(evidence.rootRealPath) ||
    typeof evidence.deviceBoundaryVerified !== "boolean"
  ) {
    throw new RecoveryManifestPlannerError("Invalid source root identity evidence");
  }
  validateIsoTimestamp(evidence.observedAt, "SourceRootIdentityEvidence.observedAt");
}

function validateBookArchiveReceipt(receipt: RecoveryBookSnapshotReceipt): void {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.verified !== true ||
    typeof receipt.archiveSha256 !== "string" ||
    !SHA256_HEX_REGEX.test(receipt.archiveSha256) ||
    !Number.isSafeInteger(receipt.archiveBytes) ||
    receipt.archiveBytes <= 0 ||
    receipt.archiveBytes > MAX_RECOVERY_MANIFEST_FILE_BYTES ||
    !Number.isSafeInteger(receipt.snapshotBytes) ||
    receipt.snapshotBytes <= 0 ||
    !Number.isSafeInteger(receipt.schema) ||
    receipt.schema < 1 ||
    !Number.isSafeInteger(receipt.sourcePages) ||
    receipt.sourcePages < 1 ||
    !Number.isSafeInteger(receipt.sourceLogicalBytes) ||
    receipt.sourceLogicalBytes <= 0 ||
    !Number.isSafeInteger(receipt.sourcePhysicalBytes) ||
    receipt.sourcePhysicalBytes <= 0 ||
    typeof receipt.destination !== "string" ||
    receipt.destination.length === 0
  ) {
    throw new RecoveryManifestPlannerError("Invalid or unverified Book logical snapshot receipt");
  }
  validateIsoTimestamp(receipt.verifiedAt, "BoundedBookArchiveReceipt.verifiedAt");
}

function normalizeKeyEnvelope(
  envelope: PortableKeyEnvelopeInput,
  index: number
): PortableKeyEnvelopeMetadata {
  assertNoSecretPayloads(envelope, `keyEnvelopes[${index}]`);
  if (!envelope || typeof envelope !== "object") {
    throw new RecoveryManifestPlannerError(`Invalid key envelope at index ${index}`);
  }

  const spaceId = (envelope as { spaceId?: unknown }).spaceId;
  const keyId = (envelope as { keyId?: unknown }).keyId;
  const schemaVersion = (envelope as { schemaVersion?: unknown }).schemaVersion;
  const domain = (envelope as { domain?: unknown }).domain;
  const kdf = (envelope as { kdf?: unknown }).kdf;
  const cipher = (envelope as { cipher?: unknown }).cipher;

  if (
    typeof spaceId !== "string" ||
    spaceId.length === 0 ||
    typeof keyId !== "string" ||
    keyId.length === 0 ||
    !Number.isSafeInteger(schemaVersion) ||
    (schemaVersion as number) < 1 ||
    typeof domain !== "string" ||
    domain.length === 0 ||
    typeof kdf !== "string" ||
    kdf.length === 0 ||
    typeof cipher !== "string" ||
    cipher.length === 0
  ) {
    throw new RecoveryManifestPlannerError(`Malformed key envelope attributes at index ${index}`);
  }

  if (Object.hasOwn(envelope, "brokerAttested") && (envelope as { brokerAttested?: unknown }).brokerAttested === true) {
    throw new RecoveryManifestPlannerError(
      `Key envelope at index ${index} claims broker attestation; no trusted portable workspace-key broker exists`
    );
  }

  const envelopeSha256 = (envelope as { envelopeSha256?: unknown }).envelopeSha256;
  if (typeof envelopeSha256 !== "string" || !SHA256_HEX_REGEX.test(envelopeSha256)) {
    throw new RecoveryManifestPlannerError(`Invalid envelopeSha256 at index ${index}`);
  }

  return Object.freeze({
    spaceId,
    keyId,
    envelopeSha256,
    schemaVersion: schemaVersion as number,
    domain,
    kdf,
    cipher,
    brokerAttested: false
  });
}

/**
 * Plans a bounded, strict draft multi-store recovery manifest.
 */
export function planRecoveryManifestDraft(
  options: PlanRecoveryManifestDraftOptions
): RecoveryManifestDraft {
  assertNoSecretPayloads(options, "options");

  if (options.schemaVersion !== undefined) {
    if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1) {
      throw new RecoveryManifestPlannerError(`Invalid schema version: ${options.schemaVersion}`);
    }
    if (options.schemaVersion > RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION) {
      throw new RecoveryManifestPlannerError(
        `Unsupported future schema version: ${options.schemaVersion}. Current supported is ${RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION}`
      );
    }
  }

  validateAppIdentity(options.appIdentity);
  validateSourceRootIdentity(options.sourceRoot);

  if (!options.bookSnapshot) {
    throw new RecoveryManifestPlannerError("Missing Book logical snapshot receipt");
  }
  validateBookArchiveReceipt(options.bookSnapshot);

  if (!options.keyEnvelopes || !Array.isArray(options.keyEnvelopes) || options.keyEnvelopes.length === 0) {
    throw new RecoveryManifestPlannerError(
      "Missing portable key envelope metadata: draft requires unbrokered envelope descriptors from future broker"
    );
  }

  const normalizedEnvelopes: PortableKeyEnvelopeMetadata[] = [];
  const seenEnvelopeKeys = new Set<string>();
  for (let i = 0; i < options.keyEnvelopes.length; i++) {
    const norm = normalizeKeyEnvelope(options.keyEnvelopes[i]!, i);
    const key = `${norm.spaceId}\0${norm.keyId}`;
    if (seenEnvelopeKeys.has(key)) {
      throw new RecoveryManifestPlannerError(
        `Duplicate key envelope detected for space "${norm.spaceId}" and key "${norm.keyId}"`
      );
    }
    seenEnvelopeKeys.add(key);
    normalizedEnvelopes.push(norm);
  }

  const inventory = options.inventory;
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.entries)) {
    throw new RecoveryManifestPlannerError("Invalid native inventory observation structure");
  }

  if (inventory.entries.length > MAX_RECOVERY_MANIFEST_ENTRIES) {
    throw new RecoveryManifestPlannerError(
      `Inventory entry count ${inventory.entries.length} exceeds limit of ${MAX_RECOVERY_MANIFEST_ENTRIES}`
    );
  }

  const seenPaths = new Set<string>();
  const casefoldMap = new Map<string, string>();
  let aggregateBytes = 0;
  let dirCount = 0;
  let fileCount = 0;

  const filesByStore = new Map<OwnedDataStoreId, RecoveryManifestFileEntry[]>();
  const observedStoresWithFiles = new Set<OwnedDataStoreId>();
  const countsByClass: Record<OwnedDataClass, number> = {
    "portable-data": 0,
    "machine-bound": 0,
    regenerable: 0,
    unknown: 0
  };

  for (let i = 0; i < inventory.entries.length; i++) {
    const entry: NativeInventoryEntry = inventory.entries[i]!;
    if (!entry || typeof entry !== "object") {
      throw new RecoveryManifestPlannerError(`Invalid entry object at index ${i}`);
    }

    if (entry.kind !== "file" && entry.kind !== "directory") {
      throw new RecoveryManifestPlannerError(
        `Unsupported entry type or symlink detected at index ${i}: "${(entry as { relativePath?: unknown }).relativePath}" (${(entry as { kind?: unknown }).kind})`
      );
    }

    assertValidPathString(entry.relativePath);

    const pathBytesLength = Buffer.byteLength(entry.relativePath, "utf8");
    if (pathBytesLength > MAX_RECOVERY_MANIFEST_PATH_BYTES) {
      throw new RecoveryManifestPlannerError(
        `Path byte length ${pathBytesLength} exceeds limit of ${MAX_RECOVERY_MANIFEST_PATH_BYTES}: "${entry.relativePath}"`
      );
    }

    if (!Number.isSafeInteger(entry.depth) || entry.depth < 1 || entry.depth > MAX_RECOVERY_MANIFEST_DEPTH) {
      throw new RecoveryManifestPlannerError(
        `Path depth ${entry.depth} exceeds limit of ${MAX_RECOVERY_MANIFEST_DEPTH}: "${entry.relativePath}"`
      );
    }

    if (seenPaths.has(entry.relativePath)) {
      throw new RecoveryManifestPlannerError(`Duplicate path collision detected: "${entry.relativePath}"`);
    }
    seenPaths.add(entry.relativePath);

    const lowerCasePath = entry.relativePath.toLowerCase();
    const existingCase = casefoldMap.get(lowerCasePath);
    if (existingCase !== undefined && existingCase !== entry.relativePath) {
      throw new RecoveryManifestPlannerError(
        `Casefold collision detected between "${existingCase}" and "${entry.relativePath}"`
      );
    }
    casefoldMap.set(lowerCasePath, entry.relativePath);

    if (
      entry.classification === "unknown" ||
      (entry.classification !== "portable-data" &&
        entry.classification !== "machine-bound" &&
        entry.classification !== "regenerable")
    ) {
      throw new RecoveryManifestPlannerError(
        `Unknown or unclassified app-owned path rejected: "${entry.relativePath}"`
      );
    }
    countsByClass[entry.classification]++;

    if (entry.storeId !== null && !KNOWN_STORE_IDS.has(entry.storeId)) {
      throw new RecoveryManifestPlannerError(
        `Unrecognized storeId "${entry.storeId}" for path "${entry.relativePath}"`
      );
    }

    if (entry.kind === "directory") {
      dirCount++;
    } else {
      fileCount++;
      if (entry.storeId === null) {
        throw new RecoveryManifestPlannerError(
          `Unclassified regular file with no store assignment rejected: "${entry.relativePath}"`
        );
      }
      observedStoresWithFiles.add(entry.storeId);

      if (!Number.isSafeInteger(entry.bytes) || entry.bytes === null || entry.bytes < 0) {
        throw new RecoveryManifestPlannerError(
          `Invalid file size for "${entry.relativePath}": ${entry.bytes}`
        );
      }
      if (entry.bytes > MAX_RECOVERY_MANIFEST_FILE_BYTES) {
        throw new RecoveryManifestPlannerError(
          `File size ${entry.bytes} exceeds limit of ${MAX_RECOVERY_MANIFEST_FILE_BYTES}: "${entry.relativePath}"`
        );
      }
      aggregateBytes += entry.bytes;
      if (aggregateBytes > MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES) {
        throw new RecoveryManifestPlannerError(
          `Aggregate file bytes ${aggregateBytes} exceeds limit of ${MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES}`
        );
      }

      const fileSha = entry.fileSha256 ?? entry.sha256;
      if (typeof fileSha !== "string" || !SHA256_HEX_REGEX.test(fileSha)) {
        throw new RecoveryManifestPlannerError(
          `Missing or invalid SHA-256 digest for file: "${entry.relativePath}"`
        );
      }

      const fileEntry: RecoveryManifestFileEntry = Object.freeze({
        relativePath: entry.relativePath,
        pathSha256: entry.pathSha256,
        depth: entry.depth,
        bytes: entry.bytes,
        fileSha256: fileSha
      });

      let storeFiles = filesByStore.get(entry.storeId);
      if (!storeFiles) {
        storeFiles = [];
        filesByStore.set(entry.storeId, storeFiles);
      }
      storeFiles.push(fileEntry);
    }
  }

  const receipts = options.storeReceipts;
  if (!receipts || !Array.isArray(receipts)) {
    throw new RecoveryManifestPlannerError("Missing or invalid store receipts list");
  }

  const receiptByStore = new Map<OwnedDataStoreId, StoreReceipt>();
  for (const receipt of receipts) {
    assertNoSecretPayloads(receipt, `storeReceipts[${receipt.storeId}]`);
    if (!receipt || typeof receipt !== "object" || !KNOWN_STORE_IDS.has(receipt.storeId)) {
      throw new RecoveryManifestPlannerError(
        `Invalid or unrecognized store receipt for store: "${(receipt as { storeId?: unknown })?.storeId}"`
      );
    }
    if (receiptByStore.has(receipt.storeId)) {
      throw new RecoveryManifestPlannerError(
        `Conflicting store receipt: duplicate receipt for store "${receipt.storeId}"`
      );
    }
    if (
      !Number.isSafeInteger(receipt.schemaVersion) ||
      receipt.schemaVersion < 1 ||
      typeof receipt.revision !== "string" ||
      receipt.revision.length === 0 ||
      typeof receipt.contentHash !== "string" ||
      !SHA256_HEX_REGEX.test(receipt.contentHash) ||
      !Number.isSafeInteger(receipt.fileCount) ||
      receipt.fileCount < 0 ||
      !Number.isSafeInteger(receipt.totalBytes) ||
      receipt.totalBytes < 0
    ) {
      throw new RecoveryManifestPlannerError(
        `Malformed store receipt parameters for store "${receipt.storeId}"`
      );
    }
    validateIsoTimestamp(receipt.verifiedAt, `StoreReceipt[${receipt.storeId}].verifiedAt`);
    receiptByStore.set(receipt.storeId, receipt);
  }

  const presentStoresList = inventory.presentStores ?? [];
  const requiredStores = new Set<OwnedDataStoreId>([
    ...presentStoresList,
    ...observedStoresWithFiles
  ]);

  for (const storeId of requiredStores) {
    if (!receiptByStore.has(storeId)) {
      throw new RecoveryManifestPlannerError(
        `Missing store receipt for observed present store: "${storeId}"`
      );
    }
  }

  for (const receipt of receipts) {
    if (!requiredStores.has(receipt.storeId)) {
      throw new RecoveryManifestPlannerError(
        `Conflicting store receipt: store "${receipt.storeId}" was not observed in source inventory`
      );
    }
  }

  const plannedStores: RecoveryManifestStoreEntry[] = [];
  for (const storeId of requiredStores) {
    const receipt = receiptByStore.get(storeId)!;
    const storeFiles = filesByStore.get(storeId) ?? [];
    storeFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    if (receipt.fileCount !== storeFiles.length) {
      throw new RecoveryManifestPlannerError(
        `Mismatched file count for store "${storeId}": receipt specifies ${receipt.fileCount}, inventory observed ${storeFiles.length}`
      );
    }

    const actualBytes = storeFiles.reduce((acc, f) => acc + f.bytes, 0);
    if (receipt.totalBytes !== actualBytes) {
      throw new RecoveryManifestPlannerError(
        `Mismatched total bytes for store "${storeId}": receipt specifies ${receipt.totalBytes}, inventory observed ${actualBytes}`
      );
    }

    const expectedCompositeHash = computeStoreContentHash(storeFiles);
    const singleFileHash = storeFiles.length === 1 ? storeFiles[0]!.fileSha256 : null;
    const hashMatches =
      receipt.contentHash === expectedCompositeHash ||
      (singleFileHash !== null && receipt.contentHash === singleFileHash);

    if (!hashMatches) {
      throw new RecoveryManifestPlannerError(
        `Mismatched store hash for store "${storeId}": receipt contentHash "${receipt.contentHash}" does not match inventory content`
      );
    }

    if (receipt.fileHashes) {
      for (const file of storeFiles) {
        const expected = receipt.fileHashes[file.relativePath];
        if (expected === undefined || expected !== file.fileSha256) {
          throw new RecoveryManifestPlannerError(
            `Mismatched inventory hash for file "${file.relativePath}" in store "${storeId}": expected "${expected ?? "missing"}", observed "${file.fileSha256}"`
          );
        }
      }
      for (const filePath of Object.keys(receipt.fileHashes)) {
        if (!storeFiles.some(f => f.relativePath === filePath)) {
          throw new RecoveryManifestPlannerError(
            `Mismatched inventory hash: receipt specifies file "${filePath}" absent from store "${storeId}"`
          );
        }
      }
    }

    const firstStoreEntry = inventory.entries.find(e => e.storeId === storeId);
    const classification: OwnedDataClass = firstStoreEntry
      ? firstStoreEntry.classification
      : "portable-data";

    plannedStores.push(
      Object.freeze({
        storeId,
        classification,
        schemaVersion: receipt.schemaVersion,
        revision: receipt.revision,
        contentHash: receipt.contentHash,
        fileCount: storeFiles.length,
        totalBytes: actualBytes,
        files: Object.freeze(storeFiles),
        receiptVerifiedAt: receipt.verifiedAt
      })
    );
  }

  plannedStores.sort((a, b) => a.storeId.localeCompare(b.storeId));

  const blockedReasons: string[] = [...DEFAULT_BLOCKED_REASONS];
  if (Array.isArray(inventory.blockers)) {
    for (const b of inventory.blockers) {
      if (typeof b === "string" && !blockedReasons.includes(b)) {
        blockedReasons.push(b);
      }
    }
  }

  const inventorySummary: RecoveryManifestInventorySummary = Object.freeze({
    totalEntries: inventory.entries.length,
    directoryCount: dirCount,
    fileCount,
    totalFileBytes: aggregateBytes,
    presentStores: Object.freeze([...requiredStores].sort()),
    absentStores: Object.freeze(
      OWNED_DATA_STORES.map(s => s.id)
        .filter(id => !requiredStores.has(id))
        .sort()
    ),
    countsByClass: Object.freeze({ ...countsByClass })
  });

  const readiness: RecoveryManifestReadiness = Object.freeze({
    readyForRecovery: false,
    readyForExport: false,
    authenticated: false,
    quiescenceAttested: false,
    brokerAttested: false,
    coherentSnapshotCoordinated: false,
    status: "blocked",
    blockedReasons: Object.freeze(blockedReasons)
  });

  return Object.freeze({
    schemaVersion: RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION,
    domain: RECOVERY_MANIFEST_DRAFT_DOMAIN,
    draftCreatedAt: new Date().toISOString(),
    appIdentity: Object.freeze({ ...options.appIdentity }),
    sourceRoot: Object.freeze({ ...options.sourceRoot }),
    inventorySummary,
    stores: Object.freeze(plannedStores),
    bookSnapshot: Object.freeze({ ...options.bookSnapshot }),
    keyEnvelopes: Object.freeze(normalizedEnvelopes),
    digestNotice: DIGEST_NOTICE,
    snapshotCoordinationNotice: SNAPSHOT_COORDINATION_NOTICE,
    readiness
  });
}

export const buildRecoveryManifestDraft = planRecoveryManifestDraft;

/**
 * Validates an existing RecoveryManifestDraft, ensuring strict invariants.
 */
export function validateRecoveryManifestDraft(draft: unknown): RecoveryManifestDraft {
  assertNoSecretPayloads(draft, "draft");

  if (!draft || typeof draft !== "object") {
    throw new RecoveryManifestPlannerError("Manifest draft must be a non-null object");
  }

  const record = draft as Record<string, unknown>;

  if (record.schemaVersion !== RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION) {
    throw new RecoveryManifestPlannerError(
      `Unsupported schema version ${record.schemaVersion}; expected ${RECOVERY_MANIFEST_DRAFT_SCHEMA_VERSION}`
    );
  }

  if (record.domain !== RECOVERY_MANIFEST_DRAFT_DOMAIN) {
    throw new RecoveryManifestPlannerError(
      `Invalid manifest domain "${record.domain}"; expected "${RECOVERY_MANIFEST_DRAFT_DOMAIN}"`
    );
  }

  validateIsoTimestamp(record.draftCreatedAt, "draftCreatedAt");
  validateAppIdentity(record.appIdentity as AppStorageIdentityEvidence);
  validateSourceRootIdentity(record.sourceRoot as SourceRootIdentityEvidence);
  validateBookArchiveReceipt(record.bookSnapshot as RecoveryBookSnapshotReceipt);

  if (record.digestNotice !== DIGEST_NOTICE) {
    throw new RecoveryManifestPlannerError("Draft digest notice is missing or modified");
  }

  if (record.snapshotCoordinationNotice !== SNAPSHOT_COORDINATION_NOTICE) {
    throw new RecoveryManifestPlannerError("Draft snapshot coordination notice is missing or modified");
  }

  const readiness = record.readiness as RecoveryManifestReadiness | undefined;
  if (!readiness || typeof readiness !== "object") {
    throw new RecoveryManifestPlannerError("Missing manifest readiness section");
  }

  if (
    readiness.readyForRecovery !== false ||
    readiness.readyForExport !== false ||
    readiness.authenticated !== false ||
    readiness.quiescenceAttested !== false ||
    readiness.brokerAttested !== false ||
    readiness.coherentSnapshotCoordinated !== false ||
    readiness.status !== "blocked" ||
    !Array.isArray(readiness.blockedReasons) ||
    readiness.blockedReasons.length === 0
  ) {
    throw new RecoveryManifestPlannerError(
      "Readiness violations detected: draft must remain strictly blocked and unauthenticated"
    );
  }

  const keyEnvelopes = record.keyEnvelopes as readonly PortableKeyEnvelopeMetadata[] | undefined;
  if (!Array.isArray(keyEnvelopes) || keyEnvelopes.length === 0) {
    throw new RecoveryManifestPlannerError("Draft contains empty or invalid key envelopes");
  }
  for (let i = 0; i < keyEnvelopes.length; i++) {
    normalizeKeyEnvelope(keyEnvelopes[i]!, i);
  }

  const stores = record.stores as readonly RecoveryManifestStoreEntry[] | undefined;
  if (!Array.isArray(stores)) {
    throw new RecoveryManifestPlannerError("Draft stores must be an array");
  }

  let totalFileBytes = 0;
  let totalFiles = 0;
  const seenStores = new Set<string>();

  for (const store of stores) {
    if (!store || typeof store !== "object" || !KNOWN_STORE_IDS.has(store.storeId)) {
      throw new RecoveryManifestPlannerError(`Invalid store entry in draft: "${store?.storeId}"`);
    }
    if (seenStores.has(store.storeId)) {
      throw new RecoveryManifestPlannerError(`Duplicate store entry in draft: "${store.storeId}"`);
    }
    seenStores.add(store.storeId);

    if (
      !Number.isSafeInteger(store.schemaVersion) ||
      store.schemaVersion < 1 ||
      typeof store.revision !== "string" ||
      store.revision.length === 0 ||
      typeof store.contentHash !== "string" ||
      !SHA256_HEX_REGEX.test(store.contentHash) ||
      !Array.isArray(store.files)
    ) {
      throw new RecoveryManifestPlannerError(`Malformed store structure for store "${store.storeId}"`);
    }

    validateIsoTimestamp(store.receiptVerifiedAt, `store[${store.storeId}].receiptVerifiedAt`);

    for (const f of store.files) {
      assertValidPathString(f.relativePath);
      if (
        !SHA256_HEX_REGEX.test(f.pathSha256) ||
        !SHA256_HEX_REGEX.test(f.fileSha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0 ||
        f.bytes > MAX_RECOVERY_MANIFEST_FILE_BYTES
      ) {
        throw new RecoveryManifestPlannerError(
          `Invalid file entry "${f.relativePath}" in store "${store.storeId}"`
        );
      }
      totalFileBytes += f.bytes;
      totalFiles++;
    }

    const expectedHash = computeStoreContentHash(store.files);
    const singleHash = store.files.length === 1 ? store.files[0]!.fileSha256 : null;
    const matches =
      store.contentHash === expectedHash ||
      (singleHash !== null && store.contentHash === singleHash);

    if (!matches) {
      throw new RecoveryManifestPlannerError(
        `Draft store hash verification failed for store "${store.storeId}"`
      );
    }
  }

  if (totalFileBytes > MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES) {
    throw new RecoveryManifestPlannerError(
      `Draft aggregate file bytes ${totalFileBytes} exceeds limit of ${MAX_RECOVERY_MANIFEST_AGGREGATE_BYTES}`
    );
  }

  const summary = record.inventorySummary as RecoveryManifestInventorySummary | undefined;
  if (!summary || typeof summary !== "object" || summary.fileCount !== totalFiles) {
    throw new RecoveryManifestPlannerError("Draft inventory summary does not match file counts");
  }

  return draft as RecoveryManifestDraft;
}