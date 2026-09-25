import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type AuditStatus =
  | "verified-complete"
  | "unverified-claim"
  | "damaged"
  | "missing"
  | "unavailable";

export interface DatabaseAuditResult {
  readonly status: AuditStatus;
  readonly integrityCheckOk: boolean;
  readonly foreignKeyCheckOk: boolean;
  readonly schemaStatus: AuditStatus;
  readonly tableCount: number;
  readonly issues: readonly string[];
}

export interface PreimageSummary {
  readonly totalTargets: number;
  readonly verifiedCompleteCount: number;
  readonly unverifiedClaimCount: number;
  readonly damagedCount: number;
  readonly missingCount: number;
  readonly unavailableCount: number;
  readonly activeClaimCount: number;
  readonly stagingCount: number;
  readonly totalKeptFilesChecked: number;
  readonly totalKeptBytesChecked: number;
}

export interface PreimageItemAudit {
  readonly caseId: string;
  readonly operationId: string;
  readonly status: AuditStatus;
  readonly hasClaim: boolean;
  readonly hasStaging: boolean;
  readonly keptFilesVerified: number;
  readonly totalEntries: number;
  readonly issues: readonly string[];
}

export interface CopiedRootAuditReport {
  readonly status: AuditStatus;
  readonly database: DatabaseAuditResult;
  readonly preimages: PreimageSummary;
  readonly preimageAudits: readonly PreimageItemAudit[];
  readonly issues: readonly string[];
}

export interface CopiedRootAuditOptions {
  readonly db: DatabaseSync;
  readonly changeStoreRoot: string;
  readonly onBeforeFileOpen?: ((filePath: string) => Promise<void> | void) | undefined;
}

export const MAX_KEPT_BYTES = 1_048_576;
export const MAX_KEPT_FILES = 400;

export const MAX_AUDIT_DIRECTORY_ENTRIES = 10_000;
export const MAX_AUDIT_TOTAL_BYTES = 500 * 1024 * 1024;
export const MAX_SNAPSHOT_JSON_BYTES = 10 * 1024 * 1024;

const TARGET_DIR_REGEX = /^([A-Za-z0-9_-]{1,80})__([A-Za-z0-9_-]{1,80})$/;
const CLAIM_FILE_REGEX = /^\.claim_([A-Za-z0-9_-]{1,80})__([A-Za-z0-9_-]{1,80})$/;
const STAGING_DIR_REGEX = /^\.staging_([A-Za-z0-9_-]{1,80})__([A-Za-z0-9_-]{1,80})_([0-9a-fA-F]+)$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const OPEN_NOFOLLOW_FLAGS =
  constants.O_RDONLY |
  constants.O_NONBLOCK |
  (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW);

const REQUIRED_BOOK_TABLES: readonly string[] = [
  "party",
  "document",
  "invoice",
  "invoice_item",
  "payment",
  "payment_allocation"
];

function hashOf(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isSafeRelativePath(relPath: string): boolean {
  if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0")) {
    return false;
  }
  const normalized = path.normalize(relPath);
  if (path.isAbsolute(normalized) || normalized.startsWith("..") || normalized === "..") {
    return false;
  }
  const parts = normalized.split(/[\\/]/);
  return !parts.some((p) => p === "..");
}

interface SafeReadOptions {
  readonly maxBytes: number;
  readonly expectedBytes?: number;
  readonly keepBuffer: boolean;
  readonly onBeforeFileOpen?: ((filePath: string) => Promise<void> | void) | undefined;
}

interface SafeReadResult {
  readonly buffer: Buffer | null;
  readonly hash: string;
  readonly bytes: number;
}

async function safeReadFileBounded(
  canonicalRoot: string,
  enclosingDir: string,
  canonicalEnclosing: string,
  filename: string,
  options: SafeReadOptions
): Promise<SafeReadResult> {
  const filePath = path.join(enclosingDir, filename);

  const initialStat = await fs.lstat(filePath);
  if (initialStat.isSymbolicLink()) {
    throw new Error("File is a symbolic link.");
  }
  if (!initialStat.isFile()) {
    throw new Error("Path is not a regular file.");
  }
  if (initialStat.size > options.maxBytes) {
    throw new Error("File size exceeds bounded limit.");
  }
  if (options.expectedBytes !== undefined && initialStat.size !== options.expectedBytes) {
    throw new Error("File size disagrees with expected bytes.");
  }

  const canonicalFile = await fs.realpath(filePath);
  if (!insideRoot(canonicalRoot, canonicalFile)) {
    throw new Error("File path escapes change store root.");
  }

  if (options.onBeforeFileOpen) {
    await options.onBeforeFileOpen(filePath);
  }

  const handle = await fs.open(canonicalFile, OPEN_NOFOLLOW_FLAGS);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error("Opened descriptor is not a regular file.");
    }
    if (before.size > BigInt(options.maxBytes)) {
      throw new Error("File size exceeds bounded limit.");
    }
    if (options.expectedBytes !== undefined && before.size !== BigInt(options.expectedBytes)) {
      throw new Error("File size disagrees with expected bytes.");
    }

    const targetSize = Number(before.size);
    if (targetSize < 0) {
      throw new Error("Negative file size.");
    }

    const hasher = createHash("sha256");
    const chunks: Buffer[] = [];
    let totalRead = 0;
    const chunkSize = Math.min(64 * 1024, options.maxBytes > 0 ? options.maxBytes : 64 * 1024);
    const chunkBuf = Buffer.alloc(chunkSize);

    while (totalRead < targetSize) {
      const bytesToRead = Math.min(chunkBuf.length, targetSize - totalRead);
      const { bytesRead } = await handle.read(chunkBuf, 0, bytesToRead, totalRead);
      if (bytesRead === 0) {
        break;
      }
      const slice = chunkBuf.subarray(0, bytesRead);
      hasher.update(slice);
      if (options.keepBuffer) {
        chunks.push(Buffer.from(slice));
      }
      totalRead += bytesRead;
    }

    if (totalRead !== targetSize) {
      throw new Error("File size changed during read.");
    }

    const after = await handle.stat({ bigint: true });
    const atPath = await fs.stat(canonicalFile, { bigint: true });
    const atPathLstat = await fs.lstat(filePath);

    if (
      atPathLstat.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== atPath.dev ||
      before.ino !== atPath.ino ||
      before.size !== atPath.size ||
      before.mtimeNs !== atPath.mtimeNs ||
      before.ctimeNs !== atPath.ctimeNs ||
      (await fs.realpath(enclosingDir)) !== canonicalEnclosing ||
      (await fs.realpath(filePath)) !== canonicalFile
    ) {
      throw new Error("File changed or swapped during audit read.");
    }

    const buffer = options.keepBuffer ? Buffer.concat(chunks, totalRead) : null;
    return {
      buffer,
      hash: hasher.digest("hex"),
      bytes: totalRead
    };
  } finally {
    await handle.close();
  }
}

function inspectDatabaseIntegrity(db: DatabaseSync): {
  integrityOk: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (
      rows.length === 1 &&
      typeof rows[0] === "object" &&
      rows[0] !== null &&
      "integrity_check" in rows[0] &&
      (rows[0] as Record<string, unknown>).integrity_check === "ok"
    ) {
      return { integrityOk: true, issues };
    }
    issues.push("Database integrity check reported corruption or errors.");
    return { integrityOk: false, issues };
  } catch {
    issues.push("Database integrity check query execution failed.");
    return { integrityOk:
 false, issues };
  }
}

function inspectForeignKeys(db: DatabaseSync): {
  foreignKeyOk: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  try {
    const fkRows = db.prepare("PRAGMA foreign_key_check").all();
    if (Array.isArray(fkRows) && fkRows.length === 0) {
      return { foreignKeyOk: true, issues };
    }
    issues.push("Database foreign key check reported constraint violations.");
    return { foreignKeyOk: false, issues };
  } catch {
    issues.push("Database foreign key check query execution failed.");
    return { foreignKeyOk: false, issues };
  }
}

function inspectBookSchema(db: DatabaseSync): {
  schemaStatus: AuditStatus;
  tableCount: number;
  issues: string[];
} {
  const issues: string[] = [];
  let tableRows: unknown[];
  try {
    tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
  } catch {
    issues.push("Database schema inspection failed to query sqlite_master.");
    return { schemaStatus: "damaged", tableCount: 0, issues };
  }

  const tableNames = new Set<string>();
  for (const row of tableRows) {
    if (
      typeof row === "object" &&
      row !== null &&
      "name" in row &&
      typeof (row as { name: unknown }).name === "string"
    ) {
      tableNames.add((row as { name: string }).name);
    }
  }

  const tableCount = tableNames.size;
  const presentRequired = REQUIRED_BOOK_TABLES.filter((name) => tableNames.has(name));

  if (presentRequired.length === 0) {
    issues.push("Required Book schema tables are not present.");
    return { schemaStatus: "unavailable", tableCount, issues };
  }

  const missingRequired = REQUIRED_BOOK_TABLES.filter((name) => !tableNames.has(name));
  if (missingRequired.length > 0) {
    issues.push("Incomplete Book schema: one or more required tables are missing.");
    return { schemaStatus: "damaged", tableCount, issues };
  }

  for (const tableName of REQUIRED_BOOK_TABLES) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
      if (!Array.isArray(columns) || columns.length === 0) {
        issues.push("Required Book schema table has no column definitions.");
        return { schemaStatus: "damaged", tableCount, issues };
      }
    } catch {
      issues.push("Failed to read column definitions for required Book table.");
      return { schemaStatus: "damaged", tableCount, issues };
    }
  }

  return { schemaStatus: "verified-complete", tableCount, issues };
}

export function auditDatabaseSync(db: DatabaseSync): DatabaseAuditResult {
  const issues: string[] = [];
  const integrity = inspectDatabaseIntegrity(db);
  const foreignKeys = inspectForeignKeys(db);
  const schema = inspectBookSchema(db);

  issues.push(...integrity.issues, ...foreignKeys.issues, ...schema.issues);

  let status: AuditStatus = "verified-complete";
  if (!integrity.integrityOk || !foreignKeys.foreignKeyOk || schema.schemaStatus === "damaged") {
    status = "damaged";
  } else if (schema.schemaStatus === "unavailable") {
    status = "unavailable";
  }

  return {
    status,
    integrityCheckOk: integrity.integrityOk,
    foreignKeyCheckOk: foreignKeys.foreignKeyOk,
    schemaStatus: schema.schemaStatus,
    tableCount: schema.tableCount,
    issues
  };
}

interface PreimageGroup {
  readonly caseId: string;
  readonly operationId: string;
  targetExists: boolean;
  hasClaim: boolean;
  stagingCount: number;
}

interface RawSnapshotEntry {
  readonly relativePath: string;
  readonly hash: string;
  readonly bytes: number;
  readonly modifiedAt: number;
}

interface RawKeptSnapshotFile {
  readonly relativePath: string;
  readonly blobName: string;
  readonly hash: string;
  readonly bytes: number;
}

interface TargetAuditOutcome {
  readonly status: AuditStatus;
  readonly keptFilesVerified: number;
  readonly totalEntries: number;
  readonly issues: readonly string[];
  readonly bytesAudited: number;
}

async function auditSingleTarget(
  targetDir: string,
  canonicalRoot: string,
  currentTotalBytes: number,
  onBeforeFileOpen?: (filePath: string) => Promise<void> | void
): Promise<TargetAuditOutcome> {
  let targetStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    targetStat = await fs.lstat(targetDir);
  } catch {
    return {
      status: "missing",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["Target directory is missing or unreadable."],
      bytesAudited: 0
    };
  }

  if (targetStat.isSymbolicLink()) {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["Target directory is a symbolic link."],
      bytesAudited: 0
    };
  }
  if (!targetStat.isDirectory()) {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["Target path is not a directory."],
      bytesAudited: 0
    };
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await fs.realpath(targetDir);
    if (!insideRoot(canonicalRoot, canonicalTarget)) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: 0,
        issues: ["Target canonical path escapes change store root."],
        bytesAudited: 0
      };
    }
  } catch {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["Failed to verify target canonical realpath confinement."],
      bytesAudited: 0
    };
  }

  const snapshotJsonPath = path.join(targetDir, "snapshot.json");
  let snapshotStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    snapshotStat = await fs.lstat(snapshotJsonPath);
  } catch {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["snapshot.json metadata file is missing."],
      bytesAudited: 0
    };
  }

  if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile()) {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["snapshot.json is not a regular file or is a symbolic link."],
      bytesAudited: 0
    };
  }
  if (snapshotStat.size > MAX_SNAPSHOT_JSON_BYTES) {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["snapshot.json exceeds allowed metadata size bound."],
      bytesAudited: 0
    };
  }

  let snapshotResult: SafeReadResult;
  try {
    snapshotResult = await safeReadFileBounded(
      canonicalRoot,
      targetDir,
      canonicalTarget,
      "snapshot.json",
      {
        maxBytes: MAX_SNAPSHOT_JSON_BYTES,
        keepBuffer: true,
        onBeforeFileOpen
      }
    );
  } catch {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["Failed to read snapshot.json metadata."],
      bytesAudited: 0
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotResult.buffer?.toString("utf8") ?? "");
  } catch {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["snapshot.json contains malformed JSON."],
      bytesAudited: 0
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !("takenAt" in parsed) ||
    !("folder" in parsed)
  ) {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["snapshot.json does not conform to required snapshot schema."],
      bytesAudited: 0
    };
  }

  const rawEntries = (parsed as { readonly entries: unknown }).entries;
  if (!Array.isArray(rawEntries)) {
    return {
      status: "damaged",
      keptFilesVerified: 0,
      totalEntries: 0,
      issues: ["snapshot.json entries field is not an array."],
      bytesAudited: 0
    };
  }
  if (rawEntries.length > MAX_AUDIT_DIRECTORY_ENTRIES) {
    return {
      status: "unavailable",
      keptFilesVerified: 0,
      totalEntries: rawEntries.length,
      issues: ["Snapshot entry count exceeds bounded audit capacity."],
      bytesAudited: 0
    };
  }

  const validatedEntries: RawSnapshotEntry[] = [];
  const entriesByPathHash = new Map<string, RawSnapshotEntry>();

  for (const item of rawEntries) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { relativePath?: unknown }).relativePath !== "string" ||
      typeof (item as { hash?: unknown }).hash !== "string" ||
      typeof (item as { bytes?: unknown }).bytes !== "number" ||
      typeof (item as { modifiedAt?: unknown }).modifiedAt !== "number"
    ) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: 0,
        issues: ["snapshot.json contains an entry with invalid field types."],
        bytesAudited: 0
      };
    }

    const cast = item as RawSnapshotEntry;
    if (!isSafeRelativePath(cast.relativePath)) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: 0,
        issues: ["snapshot.json entry relative path is not safe."],
        bytesAudited: 0
      };
    }
    if (!SHA256_HEX_REGEX.test(cast.hash)) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: 0,
        issues: ["snapshot.json entry hash is not a valid 64-character sha256 hex digest."],
        bytesAudited: 0
      };
    }
    if (!Number.isInteger(cast.bytes) || cast.bytes < 0) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: 0,
        issues: ["snapshot.json entry bytes is negative or non-integer."],
        bytesAudited: 0
      };
    }

    validatedEntries.push(cast);
    if (entriesByPathHash.has(hashOf(cast.relativePath))) {
      return { status: "damaged", keptFilesVerified: 0, totalEntries: validatedEntries.length,
        issues: ["Snapshot lists one relative path more than once."], bytesAudited: 0 };
    }
    entriesByPathHash.set(hashOf(cast.relativePath), cast);
  }

  // Version 2 identifies the exact subset for which the writer saved bytes.
  // Legacy metadata has no such list, so its partial restores remain unknown.
  const metadata = parsed as Record<string, unknown>;
  const formatVersion = metadata["snapshotFormatVersion"];
  const rawKeptFiles = metadata["keptFiles"];
  let manifestByBlob: Map<string, RawKeptSnapshotFile> | null = null;
  if (formatVersion !== undefined || rawKeptFiles !== undefined) {
    if (formatVersion !== 2) {
      return { status: typeof formatVersion === "number" && Number.isInteger(formatVersion) &&
        formatVersion > 2 ? "unavailable" : "damaged",
        keptFilesVerified: 0, totalEntries: validatedEntries.length,
        issues: ["Snapshot kept-file manifest has an unsupported format version."], bytesAudited: 0 };
    }
    if (!Array.isArray(rawKeptFiles) || rawKeptFiles.length > MAX_KEPT_FILES) {
      return { status: "damaged", keptFilesVerified: 0, totalEntries: validatedEntries.length,
        issues: ["Snapshot kept-file manifest is missing or exceeds the writer's maximum."], bytesAudited: 0 };
    }
    manifestByBlob = new Map();
    for (const item of rawKeptFiles) {
      if (typeof item !== "object" || item === null ||
          typeof (item as { relativePath?: unknown }).relativePath !== "string" ||
          typeof (item as { blobName?: unknown }).blobName !== "string" ||
          typeof (item as { hash?: unknown }).hash !== "string" ||
          typeof (item as { bytes?: unknown }).bytes !== "number") {
        return { status: "damaged", keptFilesVerified: 0, totalEntries: validatedEntries.length,
          issues: ["Snapshot kept-file manifest has invalid field types."], bytesAudited: 0 };
      }
      const kept = item as RawKeptSnapshotFile;
      const entry = entriesByPathHash.get(hashOf(kept.relativePath));
      if (!isSafeRelativePath(kept.relativePath) || !SHA256_HEX_REGEX.test(kept.blobName) ||
          !SHA256_HEX_REGEX.test(kept.hash) || !Number.isInteger(kept.bytes) ||
          kept.bytes < 0 || kept.bytes > MAX_KEPT_BYTES ||
          kept.blobName !== hashOf(kept.relativePath) ||
          !entry || entry.relativePath !== kept.relativePath ||
          entry.hash !== kept.hash || entry.bytes !== kept.bytes ||
          manifestByBlob.has(kept.blobName)) {
        return { status: "damaged", keptFilesVerified: 0, totalEntries: validatedEntries.length,
          issues: ["Snapshot kept-file manifest disagrees with its inventory or writer bounds."], bytesAudited: 0 };
      }
      manifestByBlob.set(kept.blobName, kept);
    }
  }

  const filesDir = path.join(targetDir, "files");
  let filesStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    filesStat = await fs.lstat(filesDir);
  } catch {
    filesStat = null;
  }

  if (filesStat === null) {
    return { status: "missing", keptFilesVerified: 0, totalEntries: validatedEntries.length,
      issues: ["Published snapshot files directory is missing."], bytesAudited: 0 };
  }

  let keptFilesVerified = 0;
  let bytesAudited = 0;

  if (filesStat !== null) {
    if (filesStat.isSymbolicLink() || !filesStat.isDirectory()) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: validatedEntries.length,
        issues: ["Target files storage is not a regular directory or is a symbolic link."],
        bytesAudited: 0
      };
    }

    let canonicalFiles: string;
    try {
      canonicalFiles = await fs.realpath(filesDir);
      if (!insideRoot(canonicalRoot, canonicalFiles)) {
        return {
          status: "damaged",
          keptFilesVerified: 0,
          totalEntries: validatedEntries.length,
          issues: ["Target files directory canonical realpath escapes change store root."],
          bytesAudited: 0
        };
      }
    } catch {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: validatedEntries.length,
        issues: ["Failed to verify target files directory realpath confinement."],
        bytesAudited: 0
      };
    }

    let fileEntries: string[];
    try {
      fileEntries = await fs.readdir(filesDir);
    } catch {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: validatedEntries.length,
        issues: ["Failed to list target files directory."],
        bytesAudited: 0
      };
    }

    const keptEntries = fileEntries.filter((name) => name !== ".DS_Store");
    if (keptEntries.length > MAX_KEPT_FILES) {
      return {
        status: "damaged",
        keptFilesVerified: 0,
        totalEntries: validatedEntries.length,
        issues: ["Kept file count exceeds the writer's maximum."],
        bytesAudited: 0
      };
    }

    if (manifestByBlob !== null) {
      const actualBlobs = new Set(keptEntries);
      if ([...manifestByBlob.keys()].some(name => !actualBlobs.has(name))) {
        return { status: "missing", keptFilesVerified: 0, totalEntries: validatedEntries.length,
          issues: ["A blob named by the kept-file manifest is missing."], bytesAudited: 0 };
      }
      if (keptEntries.some(name => !manifestByBlob.has(name))) {
        return { status: "damaged", keptFilesVerified: 0, totalEntries: validatedEntries.length,
          issues: ["Snapshot contains a blob absent from the kept-file manifest."], bytesAudited: 0 };
      }
    }

    for (const blobName of keptEntries) {
      const blobPath = path.join(filesDir, blobName);
      let blobStat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        blobStat = await fs.lstat(blobPath);
      } catch {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Kept blob cannot be statted."],
          bytesAudited
        };
      }

      if (blobStat.isSymbolicLink() || !blobStat.isFile()) {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Kept blob is not a regular file or is a symbolic link."],
          bytesAudited
        };
      }

      try {
        const canonicalBlob = await fs.realpath(blobPath);
        if (!insideRoot(canonicalRoot, canonicalBlob)) {
          return {
            status: "damaged",
            keptFilesVerified,
            totalEntries: validatedEntries.length,
            issues: ["Kept blob canonical realpath escapes change store root."],
            bytesAudited
          };
        }
      } catch {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Failed to verify kept blob realpath confinement."],
          bytesAudited
        };
      }

      if (!SHA256_HEX_REGEX.test(blobName)) {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Kept blob filename is not a valid 64-character sha256 hex digest."],
          bytesAudited
        };
      }

      const matchingEntry = entriesByPathHash.get(blobName);
      if (!matchingEntry) {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Kept blob does not correspond to any relative path in snapshot metadata."],
          bytesAudited
        };
      }

      if (blobStat.size !== matchingEntry.bytes) {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Kept blob size on disk disagrees with snapshot metadata bytes."],
          bytesAudited
        };
      }

      if (currentTotalBytes + bytesAudited + blobStat.size > MAX_AUDIT_TOTAL_BYTES) {
        return {
          status: "unavailable",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Total audited bytes exceeds safe bounded capacity; remaining content is unverified."],
          bytesAudited
        };
      }

      let blobResult: SafeReadResult;
      try {
        blobResult = await safeReadFileBounded(
          canonicalRoot,
          filesDir,
          canonicalFiles,
          blobName,
          {
            maxBytes: MAX_KEPT_BYTES,
            expectedBytes: matchingEntry.bytes,
            keepBuffer: false,
            onBeforeFileOpen
          }
        );
      } catch {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Failed to read kept blob bytes."],
          bytesAudited
        };
      }

      bytesAudited += blobResult.bytes;

      if (blobResult.hash !== matchingEntry.hash) {
        return {
          status: "damaged",
          keptFilesVerified,
          totalEntries: validatedEntries.length,
          issues: ["Kept blob sha256 hash disagrees with snapshot metadata hash."],
          bytesAudited
        };
      }

      keptFilesVerified += 1;
    }
  }

  return {
    status: manifestByBlob !== null || keptFilesVerified === validatedEntries.length ? "verified-complete" : "unavailable",
    keptFilesVerified,
    totalEntries: validatedEntries.length,
    issues: manifestByBlob !== null || keptFilesVerified === validatedEntries.length ? [] :
      ["Legacy metadata does not identify the intended kept-file set; copied blob completeness cannot be proved."],
    bytesAudited
  };
}

export async function auditPreimages(
  changeStoreRoot: string,
  options?: { readonly onBeforeFileOpen?: ((filePath: string) => Promise<void> | void) | undefined }
): Promise<{
  status: AuditStatus;
  summary: PreimageSummary;
  audits: readonly PreimageItemAudit[];
  issues: readonly string[];
}> {
  const topIssues: string[] = [];

  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(changeStoreRoot);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      topIssues.push("Change store root path does not exist.");
      return {
        status: "missing",
        summary: {
          totalTargets: 0,
          verifiedCompleteCount: 0,
          unverifiedClaimCount: 0,
          damagedCount: 0,
          missingCount: 1,
          unavailableCount: 0,
          activeClaimCount: 0,
          stagingCount: 0,
          totalKeptFilesChecked: 0,
          totalKeptBytesChecked: 0
        },
        audits: [],
        issues: topIssues
      };
    }
    topIssues.push("Change store root path is inaccessible.");
    return {
      status: "unavailable",
      summary: {
        totalTargets: 0,
        verifiedCompleteCount: 0,
        unverifiedClaimCount: 0,
        damagedCount: 0,
        missingCount: 0,
        unavailableCount: 1,
        activeClaimCount: 0,
        stagingCount: 0,
        totalKeptFilesChecked: 0,
        totalKeptBytesChecked: 0
      },
      audits: [],
      issues: topIssues
    };
  }

  if (rootStat.isSymbolicLink()) {
    topIssues.push("Change store root is a symbolic link.");
    return {
      status: "damaged",
      summary: {
        totalTargets: 0,
        verifiedCompleteCount: 0,
        unverifiedClaimCount: 0,
        damagedCount: 1,
        missingCount: 0,
        unavailableCount: 0,
        activeClaimCount: 0,
        stagingCount: 0,
        totalKeptFilesChecked: 0,
        totalKeptBytesChecked: 0
      },
      audits: [],
      issues: topIssues
    };
  }

  if (!rootStat.isDirectory()) {
    topIssues.push("Change store root is not a directory.");
    return {
      status: "damaged",
      summary: {
        totalTargets: 0,
        verifiedCompleteCount: 0,
        unverifiedClaimCount: 0,
        damagedCount: 1,
        missingCount: 0,
        unavailableCount: 0,
        activeClaimCount: 0,
        stagingCount: 0,
        totalKeptFilesChecked: 0,
        totalKeptBytesChecked: 0
      },
      audits: [],
      issues: topIssues
    };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(changeStoreRoot);
  } catch {
    topIssues.push("Failed to resolve canonical realpath of change store root.");
    return {
      status: "damaged",
      summary: {
        totalTargets: 0,
        verifiedCompleteCount: 0,
        unverifiedClaimCount: 0,
        damagedCount: 1,
        missingCount: 0,
        unavailableCount: 0,
        activeClaimCount: 0,
        stagingCount: 0,
        totalKeptFilesChecked: 0,
        totalKeptBytesChecked: 0
      },
      audits: [],
      issues: topIssues
    };
  }

  let rootEntries: string[];
  try {
    rootEntries = await fs.readdir(changeStoreRoot);
  } catch {
    topIssues.push("Failed to read change store root directory.");
    return {
      status: "damaged",
      summary: {
        totalTargets: 0,
        verifiedCompleteCount: 0,
        unverifiedClaimCount: 0,
        damagedCount: 1,
        missingCount: 0,
        unavailableCount: 0,
        activeClaimCount: 0,
        stagingCount: 0,
        totalKeptFilesChecked: 0,
        totalKeptBytesChecked: 0
      },
      audits: [],
      issues: topIssues
    };
  }

  if (rootEntries.length > MAX_AUDIT_DIRECTORY_ENTRIES) {
    topIssues.push("Change store root entry count exceeds bounded audit limit.");
    return {
      status: "damaged",
      summary: {
        totalTargets: 0,
        verifiedCompleteCount: 0,
        unverifiedClaimCount: 0,
        damagedCount: 1,
        missingCount: 0,
        unavailableCount: 0,
        activeClaimCount: 0,
        stagingCount: 0,
        totalKeptFilesChecked: 0,
        totalKeptBytesChecked: 0
      },
      audits: [],
      issues: topIssues
    };
  }

  const groups = new Map<string, PreimageGroup>();
  let hasSymlinkDamage = false;
  let hasUnrecognizedEntry = false;

  for (const entryName of rootEntries) {
    const entryPath = path.join(changeStoreRoot, entryName);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(entryPath);
    } catch {
      topIssues.push("A change store entry could not be statted.");
      hasSymlinkDamage = true;
      continue;
    }

    if (stat.isSymbolicLink()) {
      topIssues.push("Symbolic link detected in change store root.");
      hasSymlinkDamage = true;
      continue;
    }

    try {
      const canonicalEntry = await fs.realpath(entryPath);
      if (!insideRoot(canonicalRoot, canonicalEntry)) {
        topIssues.push("Change store entry canonical realpath escapes root.");
        hasSymlinkDamage = true;
        continue;
      }
    } catch {
      topIssues.push("Failed to resolve entry realpath confinement.");
      hasSymlinkDamage = true;
      continue;
    }

    if (entryName !== ".DS_Store" && entryName.split("__").length > 2) {
      topIssues.push("Ambiguous change store entry name; its owner cannot be established.");
      hasUnrecognizedEntry = true;
      continue;
    }

    const targetMatch = TARGET_DIR_REGEX.exec(entryName);
    if (targetMatch) {
      const caseId = targetMatch[1]!;
      const opId = targetMatch[2]!;
      const key = `${caseId}__${opId}`;
      let g = groups.get(key);
      if (!g) {
        g = { caseId, operationId: opId, targetExists: false, hasClaim: false, stagingCount: 0 };
        groups.set(key, g);
      }
      g.targetExists = true;
      continue;
    }

    const claimMatch = CLAIM_FILE_REGEX.exec(entryName);
    if (claimMatch) {
      const caseId = claimMatch[1]!;
      const opId = claimMatch[2]!;
      const key = `${caseId}__${opId}`;
      let g = groups.get(key);
      if (!g) {
        g = { caseId, operationId: opId, targetExists: false, hasClaim: false, stagingCount: 0 };
        groups.set(key, g);
      }
      g.hasClaim = true;
      continue;
    }

    const stagingMatch = STAGING_DIR_REGEX.exec(entryName);
    if (stagingMatch) {
      const caseId = stagingMatch[1]!;
      const opId = stagingMatch[2]!;
      const key = `${caseId}__${opId}`;
      let g = groups.get(key);
      if (!g) {
        g = { caseId, operationId: opId, targetExists: false, hasClaim: false, stagingCount: 0 };
        groups.set(key, g);
      }
      g.stagingCount += 1;
      continue;
    }
    if (entryName !== ".DS_Store") {
      topIssues.push("Unrecognized change store entry; copy completeness cannot be proved.");
      hasUnrecognizedEntry = true;
    }
  }

  const audits: PreimageItemAudit[] = [];
  let totalTargets = 0;
  let verifiedCompleteCount = 0;
  let unverifiedClaimCount = 0;
  let damagedCount = hasSymlinkDamage ? 1 : 0;
  let missingCount = 0;
  let unavailableCount = 0;
  let activeClaimCount = 0;
  let stagingCount = 0;
  let totalKeptFilesChecked = 0;
  let totalKeptBytesChecked = 0;

  for (const group of groups.values()) {
    if (group.targetExists) totalTargets += 1;
    if (group.hasClaim) activeClaimCount += 1;
    stagingCount += group.stagingCount;

    if (group.hasClaim) {
      unverifiedClaimCount += 1;
      const issues = group.targetExists
        ? ["Active claim file present with target; publication or crash state is unverified."]
        : [
            "Active claim file present without target; prior write state is unknown and cannot be treated as untouched."
          ];
      topIssues.push(...issues);
      audits.push({
        caseId: group.caseId,
        operationId: group.operationId,
        status: "unverified-claim",
        hasClaim: true,
        hasStaging: group.stagingCount > 0,
        keptFilesVerified: 0,
        totalEntries: 0,
        issues
      });
      continue;
    }

    if (group.stagingCount > 0 && !group.targetExists) {
      unverifiedClaimCount += 1;
      const issues = ["Incomplete staging directory present without published target."];
      topIssues.push(...issues);
      audits.push({
        caseId: group.caseId,
        operationId: group.operationId,
        status: "unverified-claim",
        hasClaim: false,
        hasStaging: true,
        keptFilesVerified: 0,
        totalEntries: 0,
        issues
      });
      continue;
    }

    if (group.stagingCount > 0 && group.targetExists) {
      unverifiedClaimCount += 1;
      const issues = ["Staging directory present alongside published target; publication state is uncertain."];
      topIssues.push(...issues);
      audits.push({
        caseId: group.caseId,
        operationId: group.operationId,
        status: "unverified-claim",
        hasClaim: false,
        hasStaging: true,
        keptFilesVerified: 0,
        totalEntries: 0,
        issues
      });
      continue;
    }

    if (group.targetExists) {
      const targetDir = path.join(changeStoreRoot, `${group.caseId}__${group.operationId}`);
      let outcome = await auditSingleTarget(
        targetDir,
        canonicalRoot,
        totalKeptBytesChecked,
        options?.onBeforeFileOpen
      );
      const claimPath = path.join(changeStoreRoot, `.claim_${group.caseId}__${group.operationId}`);
      try {
        await fs.lstat(claimPath);
        outcome = { ...outcome, status: "unverified-claim",
          issues: [...outcome.issues, "Claim appeared during audit; publication state is uncertain."] };
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error &&
          (error as { code?: unknown }).code === "ENOENT")) {
          outcome = { ...outcome, status: "unavailable",
            issues: [...outcome.issues, "Claim state could not be rechecked."] };
        }
      }

      totalKeptFilesChecked += outcome.keptFilesVerified;
      totalKeptBytesChecked += outcome.bytesAudited;

      if (outcome.status === "verified-complete") {
        verifiedCompleteCount += 1;
      } else if (outcome.status === "damaged") {
        damagedCount += 1;
      } else if (outcome.status === "unverified-claim") {
        unverifiedClaimCount += 1;
      } else if (outcome.status === "missing") {
        missingCount += 1;
      } else if (outcome.status === "unavailable") {
        unavailableCount += 1;
      }

      if (outcome.issues.length > 0) {
        topIssues.push(...outcome.issues);
      }

      audits.push({
        caseId: group.caseId,
        operationId: group.operationId,
        status: outcome.status,
        hasClaim: false,
        hasStaging: false,
        keptFilesVerified: outcome.keptFilesVerified,
        totalEntries: outcome.totalEntries,
        issues: outcome.issues
      });
    }
  }

  let finalStatus: AuditStatus = "verified-complete";
  if (damagedCount > 0 || hasSymlinkDamage) {
    finalStatus = "damaged";
  } else if (unverifiedClaimCount > 0) {
    finalStatus = "unverified-claim";
  } else if (unavailableCount > 0 || hasUnrecognizedEntry || totalTargets === 0) {
    finalStatus = "unavailable";
    if (totalTargets === 0) topIssues.push("No preimage targets were found; copy completeness cannot be proved.");
  } else if (missingCount > 0) {
    finalStatus = "missing";
  }

  const summary: PreimageSummary = {
    totalTargets,
    verifiedCompleteCount,
    unverifiedClaimCount,
    damagedCount,
    missingCount,
    unavailableCount,
    activeClaimCount,
    stagingCount,
    totalKeptFilesChecked,
    totalKeptBytesChecked
  };

  return {
    status: finalStatus,
    summary,
    audits,
    issues: topIssues
  };
}

export async function auditCopiedRoot(
  db: DatabaseSync,
  changeStoreRoot: string
): Promise<CopiedRootAuditReport>;
export async function auditCopiedRoot(
  options: CopiedRootAuditOptions
): Promise<CopiedRootAuditReport>;
export async function auditCopiedRoot(
  dbOrOptions: DatabaseSync | CopiedRootAuditOptions,
  maybeRoot?: string
): Promise<CopiedRootAuditReport> {
  let db: DatabaseSync;
  let changeStoreRoot: string;
  let onBeforeFileOpen: ((filePath: string) => Promise<void> | void) | undefined;

  if (typeof maybeRoot === "string") {
    db = dbOrOptions as DatabaseSync;
    changeStoreRoot = maybeRoot;
  } else {
    const opts = dbOrOptions as CopiedRootAuditOptions;
    db = opts.db;
    changeStoreRoot = opts.changeStoreRoot;
    onBeforeFileOpen = opts.onBeforeFileOpen;
  }

  const dbAudit = auditDatabaseSync(db);
  const preimageAudit = await auditPreimages(changeStoreRoot, { onBeforeFileOpen });

  const combinedIssues: string[] = [];
  if (dbAudit.issues.length > 0) {
    combinedIssues.push(...dbAudit.issues);
  }
  if (preimageAudit.issues.length > 0) {
    combinedIssues.push(...preimageAudit.issues);
  }

  let overallStatus: AuditStatus = "verified-complete";
  if (dbAudit.status === "damaged" || preimageAudit.status === "damaged") {
    overallStatus = "damaged";
  } else if (dbAudit.status === "unverified-claim" || preimageAudit.status === "unverified-claim") {
    overallStatus = "unverified-claim";
  } else if (dbAudit.status === "unavailable" || preimageAudit.status === "unavailable") {
    overallStatus = "unavailable";
  } else if (dbAudit.status === "missing" || preimageAudit.status === "missing") {
    overallStatus = "missing";
  } else {
    overallStatus = "verified-complete";
  }

  return {
    status: overallStatus,
    database: dbAudit,
    preimages: preimageAudit.summary,
    preimageAudits: preimageAudit.audits,
    issues: combinedIssues
  };
}
