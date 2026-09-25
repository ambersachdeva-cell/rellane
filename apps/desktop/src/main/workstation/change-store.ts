/**
 * What a folder looked like before a session touched it.
 *
 * File history can only answer "what changed" if somebody wrote down the
 * "before" while it was still true. Nothing did: the panel asked, the answer
 * was always null, and every session reported an unknown prior state. This is
 * the half that records it — once, as the run starts — so the question has an
 * answer afterwards.
 *
 * Text files are kept whole, because putting one back is the point of keeping
 * it. Everything else is kept by hash alone: enough to say a file changed,
 * never enough to restore it, and the panel says so rather than offering an
 * undo it cannot perform.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listWorkspace } from "./workspace-files.js";

export interface SnapshotEntry {
  readonly relativePath: string;
  readonly hash: string;
  readonly bytes: number;
  readonly modifiedAt: number;
}

/** Version 2 records exactly which inventory entries have restorable bytes. */
export interface KeptSnapshotFile {
  readonly relativePath: string;
  readonly blobName: string;
  readonly hash: string;
  readonly bytes: number;
}

/**
 * Past this a file is recorded by hash only. A folder of large files would
 * otherwise double on disk every time a session opened it.
 */
export const MAX_KEPT_BYTES = 1_048_576;

/** How many files one session's snapshot will keep contents for. */
export const MAX_KEPT_FILES = 400;

function hashOf(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// On macOS this rejects symlinks in every path component during open. Other
// platforms still get realpath and version checks, without that kernel guard.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

async function readSnapshotFile(folder: string, relativePath: string): Promise<Buffer> {
  const canonicalRoot = await fs.realpath(folder);
  const spelling = path.join(folder, relativePath);
  const canonicalFile = await fs.realpath(spelling);
  if (!insideRoot(canonicalRoot, canonicalFile))
    throw new Error("A listed file now links outside the workspace.");

  const flags = constants.O_RDONLY | constants.O_NONBLOCK |
    (process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW);
  const handle = await fs.open(canonicalFile, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("A listed file is no longer regular.");
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const atPath = await fs.stat(canonicalFile, { bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        before.dev !== atPath.dev || before.ino !== atPath.ino ||
        before.size !== atPath.size || before.mtimeNs !== atPath.mtimeNs || before.ctimeNs !== atPath.ctimeNs ||
        await fs.realpath(folder) !== canonicalRoot || await fs.realpath(spelling) !== canonicalFile)
      throw new Error("A listed file changed while its preimage was read.");
    return contents;
  } finally {
    await handle.close();
  }
}

/**
 * The run folder is named from the two ids rather than nested, so one
 * traversal check covers both. A caseId or operationId is a uuid everywhere it
 * is generated, and anything that is not is refused rather than sanitised —
 * quietly rewriting a bad id into a good one is how a path escapes.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function runFolder(root: string, caseId: string, operationId: string): string | null {
  if (!SAFE_ID.test(caseId) || !SAFE_ID.test(operationId)) {
    return null;
  }
  return path.join(root, `${caseId}__${operationId}`);
}

/** Every file in the folder now, with a hash. */
export async function snapshotFolder(folder: string): Promise<readonly SnapshotEntry[]> {
  const listing = await listWorkspace(folder);
  const entries: SnapshotEntry[] = [];

  for (const entry of listing.entries) {
    if (entry.kind !== "file") {
      continue;
    }
    let contents: Buffer;
    try {
      contents = await readSnapshotFile(folder, entry.relativePath);
    } catch {
      // A file that cannot be read now cannot be compared later either.
      continue;
    }
    entries.push({
      relativePath: entry.relativePath,
      hash: hashOf(contents),
      bytes: contents.length,
      modifiedAt: entry.modifiedAt
    });
  }

  return entries;
}

async function syncFile(targetPath: string, data: Buffer | string): Promise<void> {
  const handle = await fs.open(targetPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDir(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

/** Only ENOENT proves absence; permissions and I/O failures are uncertainty. */
async function pathIsAbsent(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return false;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

async function claimBlocksRead(claimPath: string): Promise<boolean> {
  try {
    return !(await pathIsAbsent(claimPath));
  } catch {
    return true;
  }
}

/**
 * Writes down the folder as it stands, and the text of the files small enough
 * to put back. Returns false unless its metadata, kept content and directory
 * entries were flushed and the exclusive operation claim was removed. The
 * host treats false as a launch blocker. This does not guarantee atomic disk
 * behavior against hardware failure or external mutation of the folder.
 */
export async function saveBefore(
  root: string,
  caseId: string,
  operationId: string,
  folder: string
): Promise<boolean> {
  const target = runFolder(root, caseId, operationId);
  if (target === null) return false;

  // Do not overwrite an existing immutable operation snapshot silently.
  try {
    if (!(await pathIsAbsent(target))) return false;
  } catch {
    return false;
  }

  try {
    const folderStat = await fs.stat(folder);
    if (!folderStat.isDirectory()) return false;
  } catch {
    return false;
  }

  let listing: Awaited<ReturnType<typeof listWorkspace>>;
  try {
    listing = await listWorkspace(folder);
  } catch {
    return false;
  }
  // The inventory is deliberately bounded. A truncated inventory cannot be
  // presented as a saved preimage for a broad native folder grant.
  if (listing.truncated) return false;

  try {
    await fs.mkdir(root, { recursive: true });
  } catch {
    return false;
  }

  const claimPath = path.join(root, `.claim_${caseId}__${operationId}`);
  let claimHandle: fs.FileHandle;
  try {
    claimHandle = await fs.open(claimPath, "wx");
  } catch {
    // A concurrent attempt is running, or a prior crashed claim conservatively blocks.
    return false;
  }

  const nonce = randomBytes(8).toString("hex");
  const staging = path.join(root, `.staging_${caseId}__${operationId}_${nonce}`);
  const stagingFiles = path.join(staging, "files");
  let stagingCreated = false;
  let targetPublished = false;
  let claimOpen = true;
  let claimPresent = true;

  const closeClaim = async (): Promise<boolean> => {
    if (!claimOpen) return true;
    try {
      await claimHandle.close();
      claimOpen = false;
      return true;
    } catch {
      return false;
    }
  };

  const releaseClaim = async (): Promise<boolean> => {
    if (!claimPresent) return true;
    if (!(await closeClaim())) return false;
    try {
      await fs.unlink(claimPath);
      claimPresent = false;
      return true;
    } catch {
      return false;
    }
  };

  const cleanupThisAttempt = async (): Promise<void> => {
    let targetInvalidated = true;
    if (targetPublished) {
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch {
        try {
          await fs.unlink(path.join(target, "snapshot.json"));
        } catch (error) {
          // ENOENT also proves that metadata is already unreadable. Any other
          // failure must retain the claim over the uncertain published target.
          targetInvalidated = isMissing(error);
        }
      }
    } else {
      try {
        targetInvalidated = await pathIsAbsent(target);
      } catch {
        targetInvalidated = false;
      }
    }
    if (stagingCreated) {
      try {
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        // A hidden staging folder is not a published snapshot.
      }
    }
    if (targetInvalidated) await releaseClaim();
    else await closeClaim();
  };

  try {
    // A duplicate might have appeared between the first check and claiming.
    if (!(await pathIsAbsent(target))) {
      await releaseClaim();
      return false;
    }

    await fs.mkdir(stagingFiles, { recursive: true });
    stagingCreated = true;

    const entries: SnapshotEntry[] = [];
    const keptFiles: KeptSnapshotFile[] = [];
    let kept = 0;

    for (const item of listing.entries) {
      if (item.kind !== "file") {
        continue;
      }

      let contents: Buffer;
      try {
        contents = await readSnapshotFile(folder, item.relativePath);
      } catch {
        // Any unreadable file prevents creating a coherent preimage.
        throw new Error(`Could not read ${item.relativePath} for its preimage.`);
      }

      const hash = hashOf(contents);
      const bytes = contents.length;
      const modifiedAt = item.modifiedAt;

      entries.push({
        relativePath: item.relativePath,
        hash,
        bytes,
        modifiedAt
      });

      // Content is kept only for textual files within count and size limits.
      if (kept < MAX_KEPT_FILES && bytes <= MAX_KEPT_BYTES && item.textual !== false) {
        const blobName = hashOf(item.relativePath);
        const dest = path.join(stagingFiles, blobName);
        try {
          await syncFile(dest, contents);
          keptFiles.push({ relativePath: item.relativePath, blobName, hash, bytes });
          kept += 1;
        } catch {
          throw new Error(`Could not save ${item.relativePath} in the preimage.`);
        }
      }
    }

    await syncDir(stagingFiles);

    // Publish complete snapshot metadata last in staging.
    const snapshotJson = JSON.stringify({
      snapshotFormatVersion: 2,
      takenAt: Date.now(),
      folder,
      entries,
      keptFiles
    });
    await syncFile(path.join(staging, "snapshot.json"), snapshotJson);
    await syncDir(staging);

    // Only a proven ENOENT permits publication; an uncertain path never does.
    if (!(await pathIsAbsent(target))) {
      await cleanupThisAttempt();
      return false;
    }

    await fs.rename(staging, target);
    stagingCreated = false;
    targetPublished = true;

    // Flush parent directory so directory entry is durable.
    await syncDir(root);

    if (!(await releaseClaim())) {
      await cleanupThisAttempt();
      return false;
    }
    return true;
  } catch {
    await cleanupThisAttempt();
    return false;
  }
}

/** The snapshot taken before a session ran, or null when none was taken. */
export async function readBefore(
  root: string,
  caseId: string,
  operationId: string
): Promise<readonly { readonly relativePath: string; readonly hash: string }[] | null> {
  const target = runFolder(root, caseId, operationId);
  if (target === null) {
    return null;
  }
  const claimPath = path.join(root, `.claim_${caseId}__${operationId}`);
  if (await claimBlocksRead(claimPath)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(target, "snapshot.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
      return null;
    }
    const entries = (parsed as { readonly entries: unknown }).entries;
    if (!Array.isArray(entries)) {
      return null;
    }
    const out: { readonly relativePath: string; readonly hash: string }[] = [];
    for (const item of entries) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as { relativePath?: unknown }).relativePath === "string" &&
        typeof (item as { hash?: unknown }).hash === "string"
      ) {
        out.push({
          relativePath: (item as { relativePath: string }).relativePath,
          hash: (item as { hash: string }).hash
        });
      }
    }
    return (await claimBlocksRead(claimPath)) ? null : out;
  } catch {
    return null;
  }
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

/** The saved text of one file as it was before, or null when it was not kept. */
export async function readContentBefore(
  root: string,
  caseId: string,
  operationId: string,
  relativePath: string
): Promise<string | null> {
  if (!isSafeRelativePath(relativePath)) {
    return null;
  }
  const target = runFolder(root, caseId, operationId);
  if (target === null) {
    return null;
  }
  const claimPath = path.join(root, `.claim_${caseId}__${operationId}`);
  if (await claimBlocksRead(claimPath)) return null;

  let rawMeta: string;
  try {
    rawMeta = await fs.readFile(path.join(target, "snapshot.json"), "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMeta);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
    return null;
  }
  const entries = (parsed as { readonly entries: unknown }).entries;
  if (!Array.isArray(entries)) {
    return null;
  }

  const normalized = path.normalize(relativePath).split(/[\\/]/).join("/");
  const entry = entries.find(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      ((e as { relativePath?: unknown }).relativePath === relativePath ||
        (e as { relativePath?: unknown }).relativePath === normalized)
  ) as { relativePath: string; hash: string } | undefined;

  if (!entry || typeof entry.hash !== "string") {
    return null;
  }

  let content: string;
  try {
    content = await fs.readFile(path.join(target, "files", hashOf(entry.relativePath)), "utf8");
  } catch {
    return null;
  }

  if (hashOf(content) !== entry.hash) {
    return null;
  }

  return (await claimBlocksRead(claimPath)) ? null : content;
}
