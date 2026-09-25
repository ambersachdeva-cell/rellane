/**
 * Whole-workspace recovery backend coordinator.
 *
 * Implements:
 * 1. Product-wide quiescence lease integration through RecoveryQuiescenceCoordinator.
 * 2. Preflight directory accessibility and strict non-symlink verification.
 *    (Note: Node.js path operations do not continuously pin directory descriptors
 *    against concurrent parent swaps; recovery manifests remain fail-closed with status: 'blocked').
 * 3. Coherent multi-store capture under the lease (SQLite Book WAL + auxiliary stores).
 * 4. Portable workspace-key envelope protection without Keychain dependencies.
 * 5. Bounded, authenticated archive packaging and atomic no-clobber publication.
 * 6. Safe isolated staged import with rollback and prior-root preservation.
 * 7. Offline workspace reopen verification with strict zero model effects replay.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type RecoveryQuiescenceCoordinator,
  RecoveryQuiescenceError
} from "./recovery-quiescence.js";
import {
  type OwnedDataStoreId,
  OWNED_DATA_STORES,
  classifyOwnedPath
} from "./owned-data-inventory.js";
import {
  type PortableWorkspaceKeyEnvelope,
  type PortableWorkspaceKeyReference,
  withPortableWorkspaceKey,
  wrapPortableWorkspaceKey
} from "../r24-portable-workspace-key-envelope.js";
import {
  type WorkspaceRecoveryManifest,
  type RecoveryManifestFileEntry,
  createRecoveryManifest,
  validateRecoveryManifest,
  isSafeRecoveryRelativePath,
  MAX_RECOVERY_FILE_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  RECOVERY_APP_IDENTITY
} from "./workspace-recovery-manifest.js";
import {
  type WorkspaceArchiveHeader,
  type WorkspaceArchiveLimits,
  DEFAULT_RECOVERY_LIMITS,
  WorkspaceArchiveError,
  packWorkspaceArchive,
  unpackWorkspaceArchive
} from "./workspace-recovery-archive.js";
import { AmbiguousPublicationError, defaultSyncDirectory } from "../book/bounded-archive.js";
import type { NativeInventoryObservation } from "./r24-native-inventory/manifest-parser.js";

const CURRENT_MAX_BOOK_SCHEMA = 100;
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const OPEN_NOFOLLOW_FLAGS =
  constants.O_RDONLY |
  constants.O_NONBLOCK |
  (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW);

export class WorkspaceRecoveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "WorkspaceRecoveryError";
  }
}

export interface CaptureWorkspaceOptions {
  readonly quiescenceCoordinator: RecoveryQuiescenceCoordinator;
  readonly sourceRoot: string;
  readonly destinationDirectory: string;
  readonly destinationArchiveName: string;
  readonly recoverySecret: Buffer;
  readonly sourceIdentity: string;
  readonly db?: DatabaseSync | undefined;
  readonly workspaceKey?: {
    readonly reference: PortableWorkspaceKeyReference;
    readonly keyMaterial: Uint8Array;
    readonly recoveryPhrase: string;
  } | undefined;
  readonly limits?: WorkspaceArchiveLimits | undefined;
  readonly syncDirectory?: ((dir: string) => Promise<void>) | undefined;
  readonly onAfterFreeze?: (() => Promise<void> | void) | undefined;
  readonly nativeInventoryObservation?: NativeInventoryObservation | undefined;
  /**
   * Whole-root recovery capture is disabled for production integration until native
   * descriptor-held directory traversal and live WorkstationHost writer integration are established.
   * This flag enables execution strictly within synthetic test fixture harnesses.
   */
  readonly allowSyntheticPrerequisite?: boolean | undefined;
}

export interface CaptureWorkspaceReceipt {
  readonly destinationPath: string;
  readonly manifest: WorkspaceRecoveryManifest;
  readonly archiveHeader: WorkspaceArchiveHeader;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly capturedStores: readonly OwnedDataStoreId[];
  readonly excludedStores: readonly string[];
  readonly verifiedAt: string;
}

export interface ImportWorkspaceOptions {
  readonly archivePath: string;
  readonly destinationRoot: string;
  readonly recoverySecret: Buffer;
  readonly recoveryPhrase?: string | undefined;
  readonly limits?: WorkspaceArchiveLimits | undefined;
  readonly syncDirectory?: ((dir: string) => Promise<void>) | undefined;
  /**
   * Whole-root recovery import is disabled for production integration until native
   * descriptor-held directory traversal is established.
   * This flag enables execution strictly within synthetic test fixture harnesses.
   */
  readonly allowSyntheticPrerequisite?: boolean | undefined;
}

export interface WorkspaceRecoveryPreflight {
  readonly readyForRecovery: false;
  readonly readyForExport: false;
  readonly status: "blocked";
  readonly quiescenceCoverageComplete: boolean;
  readonly quiescenceCoverageTrusted: boolean;
  readonly nativeDescriptorBoundaryEstablished: false;
  readonly hostWriterIntegrationEstablished: false;
  readonly keyBrokerEstablished: false;
  readonly soundPrerequisites: readonly string[];
  readonly blockedReasons: readonly string[];
}

export interface ImportWorkspaceReceipt {
  readonly destinationRoot: string;
  readonly manifest: WorkspaceRecoveryManifest;
  readonly restoredFilesCount: number;
  readonly restoredPlainBytes: number;
  readonly bookSchema: number;
  readonly importedStores: readonly OwnedDataStoreId[];
  readonly verifiedAt: string;
}

export interface ReopenedWorkspaceReport {
  readonly reopened: true;
  readonly rootPath: string;
  readonly appIdentity: string;
  readonly bookSchema: number;
  readonly partiesCount: number;
  readonly invoicesCount: number;
  readonly casesCount: number;
  readonly turnsCount: number;
  readonly receiptsCount: number;
  readonly sessionReceiptsCount: number;
  readonly interruptedRunsCount: number;
  readonly modelEffectsReplayed: false;
  readonly portableStores: readonly OwnedDataStoreId[];
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

interface PinnedDirectoryBoundary {
  readonly canonicalPath: string;
  readonly verifyStillPinned: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Opens and pins a directory descriptor with nofollow flags and verifies device/inode
 * stability across capture phases. Note: Node path operations still do not expose
 * native openat/fdopendir traversal, so whole-root recovery manifests remain
 * fail-closed with status: 'blocked'.
 */
async function pinDirectoryDescriptor(targetPath: string): Promise<PinnedDirectoryBoundary> {
  const resolved = path.resolve(targetPath);
  let initialStat;
  try {
    initialStat = await lstat(resolved, { bigint: true });
  } catch (error) {
    throw new WorkspaceRecoveryError(`Path "${resolved}" is inaccessible or missing.`, error);
  }

  if (initialStat.isSymbolicLink()) {
    throw new WorkspaceRecoveryError(`Path "${resolved}" is a symbolic link.`);
  }
  if (!initialStat.isDirectory()) {
    throw new WorkspaceRecoveryError(`Path "${resolved}" is not a directory.`);
  }

  const real = await fsRealpath(resolved);
  const handle = await open(real, OPEN_NOFOLLOW_FLAGS);
  const verifyStillPinned = async (): Promise<void> => {
    const statAfter = await handle.stat({ bigint: true });
    if (!statAfter.isDirectory()) {
      throw new WorkspaceRecoveryError(`Opened descriptor for "${resolved}" is not a directory.`);
    }
    const resolvedStat = await lstat(resolved, { bigint: true });
    const realStat = await lstat(real, { bigint: true });
    if (
      resolvedStat.isSymbolicLink() ||
      realStat.isSymbolicLink() ||
      BigInt(statAfter.dev) !== BigInt(initialStat.dev) ||
      BigInt(statAfter.ino) !== BigInt(initialStat.ino) ||
      BigInt(statAfter.dev) !== BigInt(resolvedStat.dev) ||
      BigInt(statAfter.ino) !== BigInt(resolvedStat.ino) ||
      BigInt(statAfter.dev) !== BigInt(realStat.dev) ||
      BigInt(statAfter.ino) !== BigInt(realStat.ino)
    ) {
      throw new WorkspaceRecoveryError(`Concurrent swap detected on directory "${resolved}".`);
    }
  };

  try {
    await verifyStillPinned();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }

  return {
    canonicalPath: real,
    verifyStillPinned,
    close: () => handle.close().catch(() => undefined)
  };
}

/**
 * Reads a single regular file safely using an opened file descriptor with nofollow flags,
 * checking size and device/inode stability before and after read to defeat concurrent swaps.
 */
async function safeReadFileWithDescriptor(
  baseDir: string,
  relativePath: string,
  maxBytes: number
): Promise<Buffer> {
  const fullPath = path.join(baseDir, relativePath);
  const initialStat = await lstat(fullPath, { bigint: true });
  if (initialStat.isSymbolicLink()) {
    throw new WorkspaceRecoveryError(`File "${relativePath}" is a symbolic link.`);
  }
  if (!initialStat.isFile()) {
    throw new WorkspaceRecoveryError(`File "${relativePath}" is not a regular file.`);
  }
  if (Number(initialStat.size) > maxBytes) {
    throw new WorkspaceRecoveryError(`File "${relativePath}" size exceeds maximum byte limit.`);
  }

  const handle = await open(fullPath, OPEN_NOFOLLOW_FLAGS);
  try {
    const beforeStat = await handle.stat({ bigint: true });
    if (!beforeStat.isFile()) {
      throw new WorkspaceRecoveryError(`Descriptor for "${relativePath}" is not a regular file.`);
    }
    const targetSize = Number(beforeStat.size);
    if (targetSize > maxBytes) {
      throw new WorkspaceRecoveryError(`File "${relativePath}" size exceeds limit.`);
    }

    const buffer = Buffer.alloc(targetSize);
    let totalRead = 0;
    while (totalRead < targetSize) {
      const { bytesRead } = await handle.read(buffer, totalRead, targetSize - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    if (totalRead !== targetSize) {
      throw new WorkspaceRecoveryError(`File "${relativePath}" size changed during read.`);
    }

    const afterStat = await handle.stat({ bigint: true });
    const atPathStat = await lstat(fullPath, { bigint: true });
    if (
      beforeStat.dev !== afterStat.dev ||
      beforeStat.ino !== afterStat.ino ||
      beforeStat.dev !== atPathStat.dev ||
      beforeStat.ino !== atPathStat.ino
    ) {
      throw new WorkspaceRecoveryError(`Concurrent file swap detected during read: "${relativePath}".`);
    }

    return buffer;
  } finally {
    await handle.close();
  }
}

async function fsRealpath(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p);
}

async function assertAbsentDestination(dest: string): Promise<void> {
  let exists = true;
  try {
    await lstat(dest);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      exists = false;
    }
  }
  if (exists) {
    throw new WorkspaceRecoveryError(`Destination "${dest}" already exists; refusing to overwrite.`);
  }

  const parent = path.dirname(dest);
  let parentStat;
  try {
    parentStat = await lstat(parent);
  } catch (err) {
    throw new WorkspaceRecoveryError(`Destination parent "${parent}" does not exist.`, err);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new WorkspaceRecoveryError(`Destination parent "${parent}" is not a trusted directory.`);
  }
}

/**
 * Sound whole-workspace recovery preflight prerequisite.
 * Explicitly audits quiescence coverage and informs callers that whole-root
 * recovery is disabled and blocked pending native descriptor-held directory traversal
 * and live WorkstationHost writer integration.
 */
export function preflightWorkspaceRecovery(
  quiescenceCoordinator?: RecoveryQuiescenceCoordinator
): WorkspaceRecoveryPreflight {
  const qPreflight = quiescenceCoordinator ? quiescenceCoordinator.preflightQuiescence() : null;
  const isComplete = qPreflight ? qPreflight.missingWriters.length === 0 : false;
  const isTrusted = qPreflight ? qPreflight.coverageComplete : false;

  return {
    readyForRecovery: false,
    readyForExport: false,
    status: "blocked",
    quiescenceCoverageComplete: isComplete,
    quiescenceCoverageTrusted: isTrusted,
    nativeDescriptorBoundaryEstablished: false,
    hostWriterIntegrationEstablished: false,
    keyBrokerEstablished: false,
    soundPrerequisites: [
      "RecoveryQuiescenceCoordinator: writer registration, permit accounting, and freeze lease coordination (apps/desktop/src/main/workstation/recovery-quiescence.ts)",
      "Bounded Book SQLite Archive: descriptor-held single-store WAL-aware quiesced export and atomic publication (apps/desktop/src/main/book/bounded-archive.ts)",
      "Multi-Store Manifest Authority: bounded inventory observation and draft manifest planning (apps/desktop/src/main/workstation/r24-recovery-manifest.ts)",
      "Portable Workspace Key Envelope: HKDF/AES-256-GCM recovery phrase envelope wrapping without Keychain dependencies (apps/desktop/src/main/r24-portable-workspace-key-envelope.ts)"
    ],
    blockedReasons: [
      "Native descriptor-held directory boundary is not yet available in Node runtime (requires native openat/fdopendir helper to eliminate parent directory swap windows).",
      "WorkstationHost writer permits are not yet wired into production service.ts (patch proposal ready in WORKER-OUTPUT/SHARED-HOST-WIRING.patch).",
      "Production runtime key broker is not yet wired to supply portable key envelope metadata.",
      "Whole-workspace capture and import entrypoints are explicitly disabled in production."
    ]
  };
}

/**
 * Capture a complete, consistent whole-workspace recovery archive under a product quiescence lease.
 */
export async function captureWorkspace(
  options: CaptureWorkspaceOptions
): Promise<CaptureWorkspaceReceipt> {
  // Explicitly disable dangerous whole-root capture entrypoint unless running under explicit synthetic prerequisite harness
  if (!options.allowSyntheticPrerequisite) {
    throw new WorkspaceRecoveryError(
      "Whole-workspace recovery capture is disabled: native descriptor-held directory boundary and live WorkstationHost writer integration are not yet established in production. Whole-root recovery remains fail-closed."
    );
  }

  const {
    quiescenceCoordinator,
    sourceRoot,
    destinationDirectory,
    destinationArchiveName,
    recoverySecret,
    sourceIdentity,
    limits = DEFAULT_RECOVERY_LIMITS
  } = options;

  if (!destinationArchiveName || destinationArchiveName === "." || destinationArchiveName === ".." || destinationArchiveName.includes("/")) {
    throw new WorkspaceRecoveryError(`Invalid destination archive name: ${destinationArchiveName}`);
  }

  // 1. Acquire product quiescence lease synchronously FIRST
  // Throws RecoveryQuiescenceError if coverage incomplete, untrusted, or writes in flight
  const lease = quiescenceCoordinator.acquireFreeze("whole-workspace-recovery-capture");

  let stageDir: string | null = null;
  let pinnedSource: PinnedDirectoryBoundary | null = null;
  let pinnedDest: PinnedDirectoryBoundary | null = null;

  try {
    // 2. Pin directory descriptors and verify boundaries
    pinnedSource = await pinDirectoryDescriptor(sourceRoot);
    pinnedDest = await pinDirectoryDescriptor(destinationDirectory);
    const canonicalSource = pinnedSource.canonicalPath;
    const canonicalDestDir = pinnedDest.canonicalPath;

    if (inside(canonicalSource, canonicalDestDir) || inside(canonicalDestDir, canonicalSource)) {
      throw new WorkspaceRecoveryError("Source root and destination directory cannot be nested.");
    }

    const destinationPath = path.join(destinationDirectory, destinationArchiveName);
    const canonicalDestinationPath = path.join(canonicalDestDir, destinationArchiveName);
    await assertAbsentDestination(destinationPath);
    if (destinationPath !== canonicalDestinationPath) {
      await assertAbsentDestination(canonicalDestinationPath);
    }

    stageDir = await mkdtemp(path.join(canonicalDestDir, ".r24-recovery-stage-"));

    if (options.onAfterFreeze) {
      await options.onAfterFreeze();
    }

    await pinnedSource.verifyStillPinned();
    await pinnedDest.verifyStillPinned();

    // 3. Capture SQLite Book logical snapshot under the lease
    // Must capture committed WAL state without raw file copying
    const bookSqlitePath = path.join(canonicalSource, "book.sqlite");
    let externalDb = options.db;
    let ownDb: DatabaseSync | null = null;

    if (!externalDb) {
      try {
        await lstat(bookSqlitePath);
        ownDb = new DatabaseSync(bookSqlitePath);
        externalDb = ownDb;
      } catch (err) {
        throw new WorkspaceRecoveryError(`Failed to open Book database at ${bookSqlitePath}`, err);
      }
    }

    const stagedBookSnapshot = path.join(stageDir, "book.sqlite");
    try {
      externalDb.exec(`VACUUM INTO '${stagedBookSnapshot.replace(/'/gu, "''")}'`);
    } catch (err) {
      throw new WorkspaceRecoveryError("Failed to capture consistent SQLite Book snapshot.", err);
    } finally {
      if (ownDb) {
        ownDb.close();
      }
    }

    // Verify snapshot integrity and schema
    const checkDb = new DatabaseSync(stagedBookSnapshot);
    let bookSchema = 0;
    try {
      const integrity = checkDb.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      if (integrity?.integrity_check !== "ok") {
        throw new WorkspaceRecoveryError(`Captured Book snapshot reported corruption: ${integrity?.integrity_check}`);
      }
      const schemaRow = checkDb.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      bookSchema = schemaRow?.user_version ?? 0;
      if (bookSchema < 1 || bookSchema > CURRENT_MAX_BOOK_SCHEMA) {
        throw new WorkspaceRecoveryError(`Captured Book snapshot has unsupported schema version: ${bookSchema}`);
      }
    } finally {
      checkDb.close();
    }

    const bookBytes = await safeReadFileWithDescriptor(stageDir, "book.sqlite", limits.maxFileBytes);
    const bookSha256 = createHash("sha256").update(bookBytes).digest("hex");

    // 4. Capture auxiliary portable stores
    const filesMap = new Map<string, Buffer>();
    filesMap.set("book.sqlite", bookBytes);

    const manifestFiles: RecoveryManifestFileEntry[] = [
      {
        relativePath: "book.sqlite",
        storeId: "book",
        kind: "file",
        bytes: bookBytes.byteLength,
        sha256: bookSha256
      }
    ];

    const exclusions: string[] = [];
    const capturedStores = new Set<OwnedDataStoreId>(["book"]);

    // Scan source directory for auxiliary stores
    const pendingDirs = [""];
    while (pendingDirs.length > 0) {
      const relDir = pendingDirs.pop()!;
      const fullDir = path.join(canonicalSource, relDir);

      const dirStat = await lstat(fullDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        continue;
      }

      const dirEntries = await readdir(fullDir, { withFileTypes: true });
      for (const ent of dirEntries) {
        const itemRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        const itemFull = path.join(canonicalSource, itemRel);

        if (itemRel === "book.sqlite" || itemRel.startsWith(".r24-")) {
          continue;
        }

        const itemLstat = await lstat(itemFull);
        if (itemLstat.isSymbolicLink()) {
          exclusions.push(`Symbolic link excluded: ${itemRel}`);
          continue;
        }

        const parts = itemRel.split("/");
        const kind = itemLstat.isDirectory() ? "directory" : itemLstat.isFile() ? "file" : "other";
        const decision = classifyOwnedPath(parts, kind);

        if (decision.classification === "portable-data") {
          if (kind === "file") {
            if (decision.storeId === null) {
              exclusions.push(`Portable file without store assignment excluded: ${itemRel}`);
              continue;
            }
            if (itemLstat.size > limits.maxFileBytes) {
              throw new WorkspaceRecoveryError(`Auxiliary file ${itemRel} exceeds maximum file size bound.`);
            }
            const fileData = await safeReadFileWithDescriptor(canonicalSource, itemRel, limits.maxFileBytes);
            const sha = createHash("sha256").update(fileData).digest("hex");
            filesMap.set(itemRel, fileData);
            manifestFiles.push({
              relativePath: itemRel,
              storeId: decision.storeId,
              kind: "file",
              bytes: fileData.byteLength,
              sha256: sha
            });
            capturedStores.add(decision.storeId);
          } else if (kind === "directory") {
            if (decision.storeId !== null) {
              manifestFiles.push({
                relativePath: itemRel,
                storeId: decision.storeId,
                kind: "directory",
                bytes: 0,
                sha256: ""
              });
              capturedStores.add(decision.storeId);
            }
            // Always recurse into portable directory hierarchies (including "workstation" which has storeId: null)
            pendingDirs.push(itemRel);
          }
        } else {
          // Machine-bound, regenerable, or unknown stores are excluded
          if (kind === "file") {
            exclusions.push(`${decision.classification} store excluded: ${itemRel}`);
          } else if (kind === "directory") {
            exclusions.push(`${decision.classification} directory excluded: ${itemRel}`);
          }
        }
      }
    }

    await pinnedSource.verifyStillPinned();
    await pinnedDest.verifyStillPinned();

    if (options.nativeInventoryObservation) {
      const nativeAuxMap = new Map<string, (typeof options.nativeInventoryObservation.entries)[number]>();
      for (const entry of options.nativeInventoryObservation.entries) {
        if (
          entry.classification === "portable-data" &&
          entry.storeId !== null &&
          entry.storeId !== "book"
        ) {
          nativeAuxMap.set(entry.relativePath, entry);
        }
      }

      const auxManifestFiles = manifestFiles.filter((file) => file.storeId !== "book");

      if (nativeAuxMap.size !== auxManifestFiles.length) {
        throw new WorkspaceRecoveryError(
          `Native inventory portable store count mismatch: expected ${nativeAuxMap.size}, captured ${auxManifestFiles.length}`
        );
      }

      for (const manifestFile of auxManifestFiles) {
        const nativeEntry = nativeAuxMap.get(manifestFile.relativePath);
        if (!nativeEntry) {
          throw new WorkspaceRecoveryError(
            `Captured portable file ${manifestFile.relativePath} was not observed in native inventory`
          );
        }

        if (nativeEntry.kind !== manifestFile.kind) {
          throw new WorkspaceRecoveryError(
            `Kind mismatch for ${manifestFile.relativePath}: native inventory reported ${nativeEntry.kind}, manifest has ${manifestFile.kind}`
          );
        }

        if (nativeEntry.kind === "file") {
          if (nativeEntry.bytes !== manifestFile.bytes) {
            throw new WorkspaceRecoveryError(
              `Byte count mismatch for ${manifestFile.relativePath}: native inventory reported ${nativeEntry.bytes}, manifest has ${manifestFile.bytes}`
            );
          }

          const nativeSha = nativeEntry.fileSha256 ?? nativeEntry.sha256;
          if (nativeSha !== manifestFile.sha256) {
            throw new WorkspaceRecoveryError(
              `SHA-256 mismatch for ${manifestFile.relativePath}: native inventory reported ${nativeSha}, manifest has ${manifestFile.sha256}`
            );
          }
        }
      }
    }

    // 5. Portable workspace key envelope (if provided)
    let keyEnvelope: PortableWorkspaceKeyEnvelope | null = null;
    if (options.workspaceKey) {
      keyEnvelope = wrapPortableWorkspaceKey(
        options.workspaceKey.reference,
        options.workspaceKey.recoveryPhrase,
        options.workspaceKey.keyMaterial
      );
    }

    // 6. Create versioned manifest with fail-closed readiness
    const manifest = createRecoveryManifest({
      sourceIdentity,
      bookSchema,
      files: manifestFiles,
      keyEnvelope,
      exclusions
    });

    // 7. Pack and encrypt into archive with atomic no-clobber publication
    const packReceipt = await packWorkspaceArchive({
      manifest,
      files: filesMap,
      secret: recoverySecret,
      destination: destinationPath,
      limits,
      ...(options.syncDirectory !== undefined ? { syncDirectory: options.syncDirectory } : {})
    });

    await pinnedSource.verifyStillPinned();
    await pinnedDest.verifyStillPinned();

    return {
      destinationPath,
      manifest,
      archiveHeader: packReceipt.header,
      archiveBytes: packReceipt.archiveBytes,
      archiveSha256: packReceipt.archiveSha256,
      capturedStores: [...capturedStores].sort(),
      excludedStores: exclusions,
      verifiedAt: new Date().toISOString()
    };
  } finally {
    // Durable cleanup of staging directory and pinned directory descriptors
    if (stageDir) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (pinnedDest) {
      await pinnedDest.close();
    }
    if (pinnedSource) {
      await pinnedSource.close();
    }
    lease.release();
  }
}

/**
 * Safely import a workspace recovery archive to a fresh, isolated destination root.
 */
export async function importWorkspace(
  options: ImportWorkspaceOptions
): Promise<ImportWorkspaceReceipt> {
  // Explicitly disable dangerous whole-root import entrypoint unless running under explicit synthetic prerequisite harness
  if (!options.allowSyntheticPrerequisite) {
    throw new WorkspaceRecoveryError(
      "Whole-workspace recovery import is disabled: native descriptor-held directory boundary is not yet established in production. Whole-root import remains fail-closed."
    );
  }

  const {
    archivePath,
    destinationRoot,
    recoverySecret,
    recoveryPhrase,
    limits = DEFAULT_RECOVERY_LIMITS,
    syncDirectory = defaultSyncDirectory
  } = options;

  const resolvedArchive = path.resolve(archivePath);
  const resolvedDest = path.resolve(destinationRoot);

  await assertAbsentDestination(resolvedDest);

  const archiveStat = await lstat(resolvedArchive);
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
    throw new WorkspaceRecoveryError(`Archive at "${resolvedArchive}" is not a regular file.`);
  }

  const archiveBuffer = await readFile(resolvedArchive);

  // Authenticate before decompression (GCM verification happens inside unpackWorkspaceArchive)
  const unpacked = unpackWorkspaceArchive(archiveBuffer, recoverySecret, limits);
  const { header, manifest, files } = unpacked;

  if (manifest.bookSchema > CURRENT_MAX_BOOK_SCHEMA) {
    throw new WorkspaceRecoveryError(
      `Archive schema version ${manifest.bookSchema} is newer than maximum supported (${CURRENT_MAX_BOOK_SCHEMA}). Update software.`
    );
  }

  // If a key envelope is present and phrase supplied, verify it opens
  if (manifest.keyEnvelope && recoveryPhrase) {
    let unwrappedKeyChecked = false;
    await withPortableWorkspaceKey(
      manifest.keyEnvelope,
      { spaceId: manifest.keyEnvelope.spaceId, keyId: manifest.keyEnvelope.keyId },
      recoveryPhrase,
      key => {
        if (key.byteLength === 32) {
          unwrappedKeyChecked = true;
        }
      }
    );
    if (!unwrappedKeyChecked) {
      throw new WorkspaceRecoveryError("Failed to unwrap portable workspace key envelope with provided phrase.");
    }
  }

  // Create isolated staging directory in destination parent
  const parentDir = path.dirname(resolvedDest);
  const stageDir = await mkdtemp(path.join(parentDir, ".r24-import-stage-"));

  try {
    let totalRestoredBytes = 0;
    const restoredStores = new Set<OwnedDataStoreId>();

    // 1. Write all manifest directories first
    for (const entry of manifest.files) {
      if (entry.kind === "directory") {
        const destPath = path.join(stageDir, entry.relativePath);
        await mkdir(destPath, { recursive: true });
        restoredStores.add(entry.storeId);
      }
    }

    // 2. Write and verify all manifest files
    for (const entry of manifest.files) {
      if (entry.kind === "file") {
        const data = files.get(entry.relativePath);
        if (!data) {
          throw new WorkspaceRecoveryError(`Missing data for file entry ${entry.relativePath}`);
        }
        if (data.byteLength !== entry.bytes) {
          throw new WorkspaceRecoveryError(`Byte length mismatch for restored file ${entry.relativePath}`);
        }
        const sha = createHash("sha256").update(data).digest("hex");
        if (sha !== entry.sha256) {
          throw new WorkspaceRecoveryError(`Digest mismatch for restored file ${entry.relativePath}`);
        }

        const targetFile = path.join(stageDir, entry.relativePath);
        await mkdir(path.dirname(targetFile), { recursive: true });
        await writeFile(targetFile, data);

        totalRestoredBytes += data.byteLength;
        restoredStores.add(entry.storeId);
      }
    }

    // 3. Verify SQLite integrity and schema on restored book.sqlite
    const stagedBook = path.join(stageDir, "book.sqlite");
    const testDb = new DatabaseSync(stagedBook);
    try {
      const integrity = testDb.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      if (integrity?.integrity_check !== "ok") {
        throw new WorkspaceRecoveryError(`Restored database failed integrity check: ${integrity?.integrity_check}`);
      }
      const fk = testDb.prepare("PRAGMA foreign_key_check").all();
      if (fk.length > 0) {
        throw new WorkspaceRecoveryError("Restored database has foreign key violations.");
      }
    } finally {
      testDb.close();
    }

    // 4. Staged verification complete -> atomic publication to destination root
    await rename(stageDir, resolvedDest);
    await syncDirectory(parentDir);

    return {
      destinationRoot: resolvedDest,
      manifest,
      restoredFilesCount: manifest.totalFiles,
      restoredPlainBytes: totalRestoredBytes,
      bookSchema: manifest.bookSchema,
      importedStores: [...restoredStores].sort(),
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    // Failure cleanup: clean ONLY the staging directory; destination root and prior roots are untouched
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Reopen a recovered workspace root in isolation and attest that no model effects
 * are replayed, interrupted runs remain truthfully interrupted, and schema/IDs are intact.
 */
export async function reopenRecoveredWorkspace(
  workspaceRoot: string
): Promise<ReopenedWorkspaceReport> {
  const resolved = path.resolve(workspaceRoot);
  const bookPath = path.join(resolved, "book.sqlite");

  const fileStat = await lstat(bookPath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new WorkspaceRecoveryError(`Restored book.sqlite at "${bookPath}" is missing or invalid.`);
  }

  const db = new DatabaseSync(bookPath);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new WorkspaceRecoveryError(`Reopened workspace failed SQLite integrity check: ${integrity?.integrity_check}`);
    }

    const schemaRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const bookSchema = schemaRow?.user_version ?? 0;

    const hasTable = (name: string): boolean => {
      const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      return row !== undefined;
    };

    if (!hasTable("party") || !hasTable("invoice")) {
      throw new WorkspaceRecoveryError("Reopened workspace Book database is missing essential ledger tables.");
    }

    // Read counts from canonical schema tables
    const partiesCount = (db.prepare("SELECT COUNT(*) AS n FROM party").get() as { n: number }).n;
    const invoicesCount = (db.prepare("SELECT COUNT(*) AS n FROM invoice").get() as { n: number }).n;

    // Check canonical case/turn tables (created in migration V4: work_case, case_turn)
    let casesCount = 0;
    if (hasTable("work_case")) {
      casesCount = (db.prepare("SELECT COUNT(*) AS n FROM work_case").get() as { n: number }).n;
    }

    let turnsCount = 0;
    let receiptsCount = 0;
    let interruptedRunsCount = 0;
    let modelEffectsReplayed = false;

    if (hasTable("case_turn")) {
      turnsCount = (db.prepare("SELECT COUNT(*) AS n FROM case_turn").get() as { n: number }).n;
      receiptsCount = (db.prepare("SELECT COUNT(*) AS n FROM case_turn WHERE kind = 'receipt'").get() as { n: number }).n;

      // Inspect case_turn receipts to verify truthful interrupted states and audit replay
      const receiptRows = db.prepare(`
        SELECT id, case_id, seq, seat, body, at
        FROM case_turn
        WHERE kind = 'receipt'
        ORDER BY seq ASC
      `).all() as unknown as readonly { id: string; case_id: string; seq: number; seat: string; body: string; at: number }[];

      for (const row of receiptRows) {
        let isInterrupted = false;
        let isActive = false;

        try {
          const parsed = JSON.parse(row.body);
          if (typeof parsed === "object" && parsed !== null) {
            const ev = (parsed as Record<string, unknown>)["event"];
            const snap = (parsed as Record<string, unknown>)["snapshot"] as Record<string, unknown> | undefined;
            const status = snap ? snap["status"] : undefined;

            if (ev === "interrupted" || status === "interrupted" || status === "failed" || status === "stopped") {
              isInterrupted = true;
            } else if (
              ev === "start" ||
              ev === "checkpoint" ||
              status === "starting" ||
              status === "running" ||
              status === "needs-approval" ||
              status === "stopping"
            ) {
              isActive = true;
            }
          }
        } catch {
          // Plain text receipt format
          if (row.body.includes("interrupted") || row.body.includes("failed") || row.body.includes("stopped")) {
            isInterrupted = true;
          }
        }

        if (isInterrupted) {
          interruptedRunsCount += 1;

          // Check for illegal model replay: an interrupted run must NOT have trailing assistant turns
          // appended to the same case after the interrupted receipt
          const trailingTurns = db.prepare(`
            SELECT COUNT(*) AS n FROM case_turn
            WHERE case_id = ? AND seq > ? AND seat NOT IN ('owner', 'workstation', 'workstation-session')
          `).get(row.case_id, row.seq) as { n: number };

          if (trailingTurns.n > 0) {
            modelEffectsReplayed = true;
          }
        }

        if (isActive) {
          // If a session receipt was left in an active state and no subsequent terminal receipt exists,
          // it represents an unquiesced/resumed active state
          const laterTerminal = db.prepare(`
            SELECT COUNT(*) AS n FROM case_turn
            WHERE case_id = ? AND seq > ? AND kind = 'receipt'
          `).get(row.case_id, row.seq) as { n: number };
          if (laterTerminal.n === 0) {
            modelEffectsReplayed = true;
          }
        }
      }
    }

    if (hasTable("workstation_local_brief_receipt")) {
      const briefReceipts = db.prepare(`
        SELECT attempt_id, sequence, event, at
        FROM workstation_local_brief_receipt
        ORDER BY sequence ASC
      `).all() as unknown as readonly { attempt_id: string; sequence: number; event: string; at: number }[];

      for (const row of briefReceipts) {
        receiptsCount += 1;
        if (row.event === "interrupted" || row.event === "failed") {
          interruptedRunsCount += 1;
        } else if (row.event === "admitted" || row.event === "dispatch_attempt") {
          const later = db.prepare(`
            SELECT COUNT(*) AS n FROM workstation_local_brief_receipt
            WHERE attempt_id = ? AND sequence > ?
          `).get(row.attempt_id, row.sequence) as { n: number };
          if (later.n === 0) {
            modelEffectsReplayed = true;
          }
        }
      }
    }

    if (modelEffectsReplayed) {
      throw new WorkspaceRecoveryError("Model effects were illegally replayed following workspace recovery reopen.");
    }

    // Inspect stores present in workspace directory hierarchy
    const presentStores = new Set<OwnedDataStoreId>();
    const pendingScan = [""];
    while (pendingScan.length > 0) {
      const rel = pendingScan.pop()!;
      const full = path.join(resolved, rel);
      const entries = await readdir(full, { withFileTypes: true });
      for (const ent of entries) {
        const itemRel = rel ? `${rel}/${ent.name}` : ent.name;
        const decision = classifyOwnedPath(itemRel.split("/"), ent.isDirectory() ? "directory" : "file");
        if (decision.storeId) {
          presentStores.add(decision.storeId);
        }
        if (ent.isDirectory() && decision.classification === "portable-data") {
          pendingScan.push(itemRel);
        }
      }
    }

    return {
      reopened: true,
      rootPath: resolved,
      appIdentity: RECOVERY_APP_IDENTITY,
      bookSchema,
      partiesCount,
      invoicesCount,
      casesCount,
      turnsCount,
      receiptsCount,
      sessionReceiptsCount: receiptsCount,
      interruptedRunsCount,
      modelEffectsReplayed: false,
      portableStores: [...presentStores].sort()
    };
  } finally {
    db.close();
  }
}
