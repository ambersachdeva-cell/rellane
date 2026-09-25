/**
 * Isolated R24 Book export: one trusted, quiesced SQLite connection becomes a
 * verified v2 archive, then a no-clobber name. This is not a whole-root export.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createBackup, verifyBackup, type BackupByteLimits } from "./backup.js";
import { RECOVERY_BYTES } from "./recovery.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 65_536;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export interface BoundedBookArchiveLimits extends BackupByteLimits {
  readonly maxSourcePages: number;
  readonly maxSourceBytes: number;
}

export interface BoundedBookArchiveOptions {
  /** Caller attests an open, quiesced Book connection and no concurrent writer. */
  readonly db: DatabaseSync;
  /** Existing, trusted private destination parent; this module creates a child stage. */
  readonly destinationDirectory: string;
  readonly destinationName: string;
  /** An explicit 160-bit Book recovery secret. Caller retains ownership. */
  readonly secret: Buffer;
  readonly limits: BoundedBookArchiveLimits;
  /** Optional directory sync boundary for durability testing or platform specialization. */
  readonly syncDirectory?: (directory: string) => Promise<void>;
}

export class AmbiguousPublicationError extends Error {
  readonly destination: string;
  override readonly cause?: unknown;

  constructor(destination: string, cause?: unknown) {
    super(
      `Bounded Book archive publication is ambiguous: hard link was created at "${destination}", but syncing the destination directory failed. The archive may exist on disk but cannot be confirmed durable.`,
      cause !== undefined ? { cause } : undefined
    );
    this.name = "AmbiguousPublicationError";
    this.destination = destination;
    if (cause !== undefined && this.cause === undefined) {
      this.cause = cause;
    }
  }
}

export async function defaultSyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface BoundedBookArchiveReceipt {
  readonly destination: string;
  readonly sourcePages: number;
  readonly sourceLogicalBytes: number;
  readonly sourcePhysicalBytes: number;
  readonly snapshotBytes: number;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly schema: number;
  readonly verified: true;
  readonly verifiedAt: string;
}

/**
 * The source and destination parents are trust preconditions. A fresh private
 * child stage isolates `createBackup`'s replace-by-rename behavior from the
 * final destination. The hard link followed by durably syncing the destination
 * directory are the final publication steps.
 */
export async function createBoundedBookArchive(
  options: BoundedBookArchiveOptions
): Promise<BoundedBookArchiveReceipt> {
  const { db, destinationDirectory, destinationName, secret, limits, syncDirectory } = options;
  assertLimits(limits);
  if (!Buffer.isBuffer(secret) || secret.byteLength !== RECOVERY_BYTES ||
      typeof destinationDirectory !== "string" ||
      typeof destinationName !== "string" || !NAME.test(destinationName) ||
      destinationName === "." || destinationName === ".." ||
      (syncDirectory !== undefined && typeof syncDirectory !== "function"))
    throw new Error("Bounded Book archive inputs are invalid.");
  const parent = await lstat(destinationDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("The Book archive destination parent is not a trusted directory.");

  const sourceBefore = await sourceFootprint(db, limits);
  const stage = await mkdtemp(path.join(destinationDirectory, ".r24-book-stage-"));
  const stagedArchive = path.join(stage, "book.cadrane-backup");
  const destination = path.join(destinationDirectory, destinationName);
  try {
    const made = await createBackup(db, stagedArchive, secret, limits);
    const sourceAfter = await sourceFootprint(db, limits);
    if (sourceAfter.pages !== sourceBefore.pages ||
        sourceAfter.logicalBytes !== sourceBefore.logicalBytes ||
        sourceAfter.physicalBytes !== sourceBefore.physicalBytes)
      throw new Error("The Book source changed during the bounded snapshot.");
    if (made.header.plainBytes <= 0 || made.header.plainBytes > limits.maxSnapshotBytes ||
        made.bytes <= 0 || made.bytes > limits.maxArchiveBytes ||
        made.header.schema !== sourceBefore.schema)
      throw new Error("The Book snapshot exceeded its bound or changed schema.");

    const verified = await verifyBackup(stagedArchive, secret, limits);
    if (!verified.ok || verified.header === null ||
        verified.header.schema !== sourceBefore.schema ||
        verified.header.plainBytes !== made.header.plainBytes)
      throw new Error("The bounded Book archive did not reopen and verify.");
    const archive = await lstat(stagedArchive);
    if (!archive.isFile() || archive.isSymbolicLink() || archive.size !== made.bytes ||
        archive.size > limits.maxArchiveBytes)
      throw new Error("The bounded Book archive changed before publication.");
    const archiveSha256 = await sha256(stagedArchive);
    const handle = await open(stagedArchive, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `link` fails with EEXIST for files and symlinks; no stat-then-rename race.
    await link(stagedArchive, destination);
    try {
      await (syncDirectory ?? defaultSyncDirectory)(destinationDirectory);
    } catch (error) {
      throw new AmbiguousPublicationError(destination, error);
    }
    return {
      destination,
      sourcePages: sourceBefore.pages,
      sourceLogicalBytes: sourceBefore.logicalBytes,
      sourcePhysicalBytes: sourceBefore.physicalBytes,
      snapshotBytes: made.header.plainBytes,
      archiveBytes: made.bytes,
      archiveSha256,
      schema: made.header.schema,
      verified: true,
      verifiedAt: verified.at
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function assertLimits(value: BoundedBookArchiveLimits): void {
  if (value === null || typeof value !== "object" ||
      !Number.isSafeInteger(value.maxSourcePages) || value.maxSourcePages < 1 ||
      value.maxSourcePages > MAX_PAGES ||
      ![value.maxSourceBytes, value.maxSnapshotBytes, value.maxArchiveBytes]
        .every(n => Number.isSafeInteger(n) && n > 0 && n <= MAX_BYTES))
    throw new Error("Bounded Book archive limits are invalid.");
}

interface SourceFootprint {
  readonly pages: number;
  readonly logicalBytes: number;
  readonly physicalBytes: number;
  readonly schema: number;
}

async function sourceFootprint(
  db: DatabaseSync,
  limits: BoundedBookArchiveLimits
): Promise<SourceFootprint> {
  const pages = pragmaNumber(db, "page_count");
  const pageSize = pragmaNumber(db, "page_size");
  const schema = pragmaNumber(db, "user_version");
  const journal = db.prepare("PRAGMA journal_mode").get() as
    | { journal_mode?: unknown } | undefined;
  const logicalBytes = pages * pageSize;
  if (pages < 1 || pages > limits.maxSourcePages ||
      pageSize < 512 || pageSize > 65_536 ||
      !Number.isSafeInteger(logicalBytes) || logicalBytes > limits.maxSourceBytes ||
      schema < 1 || journal?.journal_mode !== "wal")
    throw new Error("The Book source exceeds its page or byte bound.");
  const databases = db.prepare("PRAGMA database_list").all() as Array<{
    name: string; file: string;
  }>;
  const main = databases.find(item => item.name === "main");
  if (main === undefined || typeof main.file !== "string" || main.file.length === 0 ||
      databases.some(item => item.name !== "main" && item.name !== "temp"))
    throw new Error("The bounded Book source must be one file-backed database.");
  let physicalBytes = 0;
  for (const file of [main.file, `${main.file}-wal`, `${main.file}-shm`]) {
    let detail;
    try {
      detail = await lstat(file);
    } catch (error) {
      if (file !== main.file && isMissing(error)) continue;
      throw error;
    }
    if (!detail.isFile() || detail.isSymbolicLink() || detail.nlink !== 1 ||
        !Number.isSafeInteger(detail.size) || detail.size < 0)
      throw new Error("The Book source has an unsupported file entry.");
    physicalBytes += detail.size;
    if (!Number.isSafeInteger(physicalBytes) || physicalBytes > limits.maxSourceBytes)
      throw new Error("The Book source exceeds its physical byte bound.");
  }
  return { pages, logicalBytes, physicalBytes, schema };
}

function pragmaNumber(db: DatabaseSync, name: "page_count" | "page_size" | "user_version"): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("The Book source has invalid SQLite metadata.");
  return value;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
