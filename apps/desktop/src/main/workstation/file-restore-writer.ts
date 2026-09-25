import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

export class SafeRestoreError extends Error {
  readonly stage: "pre-write" | "write";
  override readonly cause?: unknown;

  constructor(message: string, stage: "pre-write" | "write", cause?: unknown) {
    super(message);
    this.name = "SafeRestoreError";
    this.stage = stage;
    this.cause = cause;
  }
}

export class SafeRestorePreWriteError extends SafeRestoreError {
  constructor(message: string, cause?: unknown) {
    super(message, "pre-write", cause);
    this.name = "SafeRestorePreWriteError";
  }
}

export class SafeRestoreWriteError extends SafeRestoreError {
  constructor(message: string, cause?: unknown) {
    super(message, "write", cause);
    this.name = "SafeRestoreWriteError";
  }
}

function getErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedParent, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Safely restores a file into the target workspace folder.
 *
 * Enforces directory confinement and prevents symlink traversal:
 * 1. Checks that the workspace root exists as a directory and resolves its canonical realpath.
 * 2. Refuses absolute paths, traversal components, NUL bytes, and directory trailing slashes.
 * 3. Walks nested intermediate directories one component at a time: existing components are
 *    checked with lstat to refuse symlinks and verify canonical containment. Missing components
 *    are created strictly one at a time and immediately re-lstat'd without following symlinks.
 * 4. Ensures canonical root and canonical target parent remain strictly within the workspace.
 * 5. Refuses existing symlinks at the target leaf, opens the leaf with O_NOFOLLOW to avoid symlink
 *    races on truncation/creation, preserves existing file mode where practical, and writes UTF-8.
 *
 * Node.js filesystem APIs alone lack openat-style parent file descriptor chaining, so this helper
 * does not claim complete atomic protection against an external concurrent adversary racing
 * directory renames during execution. However, it fails closed on all lstat/realpath/mkdir/open errors,
 * never falls back to direct write, and distinguishes pre-write refusal from write failures.
 */
export async function safeRestoreFile(
  folder: string,
  relativePath: string,
  contents: string
): Promise<void> {
  if (typeof folder !== "string" || folder.length === 0) {
    throw new SafeRestorePreWriteError("Workspace folder must be a non-empty string");
  }
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new SafeRestorePreWriteError("Relative path must be a non-empty string");
  }
  if (typeof contents !== "string") {
    throw new SafeRestorePreWriteError("Contents must be a string");
  }

  if (folder.includes("\0") || relativePath.includes("\0")) {
    throw new SafeRestorePreWriteError("Path must not contain NUL bytes");
  }

  if (
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\")
  ) {
    throw new SafeRestorePreWriteError(`Relative path must not be absolute: ${relativePath}`);
  }

  if (relativePath.endsWith("/") || relativePath.endsWith("\\")) {
    throw new SafeRestorePreWriteError(`Target path must refer to a file, not a directory: ${relativePath}`);
  }

  const rawSegments = relativePath.split(/[/\\]+/);
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new SafeRestorePreWriteError(`Relative path contains invalid or traversal segment: ${relativePath}`);
    }
    segments.push(seg);
  }

  if (segments.length === 0) {
    throw new SafeRestorePreWriteError(`Relative path cannot be empty: ${relativePath}`);
  }

  const normalizedFolder = path.resolve(folder);

  let rootStat: Stats;
  try {
    rootStat = await stat(normalizedFolder);
  } catch (err: unknown) {
    throw new SafeRestorePreWriteError(`Root folder cannot be accessed: ${folder}`, err);
  }

  if (!rootStat.isDirectory()) {
    throw new SafeRestorePreWriteError(`Root folder is not a directory: ${folder}`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(normalizedFolder);
  } catch (err: unknown) {
    throw new SafeRestorePreWriteError(`Failed to resolve canonical path for root folder: ${folder}`, err);
  }

  const parentSegments = segments.slice(0, -1);
  const leafName = segments[segments.length - 1]!;

  let currentPath = normalizedFolder;
  for (const seg of parentSegments) {
    currentPath = path.join(currentPath, seg);

    let segStat: Stats;
    try {
      segStat = await lstat(currentPath);
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code === "ENOENT") {
        try {
          await mkdir(currentPath);
        } catch (mkdirErr: unknown) {
          throw new SafeRestorePreWriteError(`Failed to create directory component: ${currentPath}`, mkdirErr);
        }

        try {
          segStat = await lstat(currentPath);
        } catch (reStatErr: unknown) {
          throw new SafeRestorePreWriteError(
            `Failed to re-lstat created directory component: ${currentPath}`,
            reStatErr
          );
        }
      } else {
        throw new SafeRestorePreWriteError(`Failed to inspect path component: ${currentPath}`, err);
      }
    }

    if (segStat.isSymbolicLink()) {
      throw new SafeRestorePreWriteError(`Symlink detected in nested parent directory: ${currentPath}`);
    }

    if (!segStat.isDirectory()) {
      throw new SafeRestorePreWriteError(`Path component is not a directory: ${currentPath}`);
    }

    let canonicalCurrent: string;
    try {
      canonicalCurrent = await realpath(currentPath);
    } catch (rpErr: unknown) {
      throw new SafeRestorePreWriteError(
        `Failed to resolve canonical path for component: ${currentPath}`,
        rpErr
      );
    }

    if (!isInsideOrEqual(canonicalRoot, canonicalCurrent)) {
      throw new SafeRestorePreWriteError(
        `Nested parent directory escaped root: ${currentPath} -> ${canonicalCurrent}`
      );
    }
  }

  let canonicalParent: string;
  try {
    canonicalParent = await realpath(currentPath);
  } catch (rpErr: unknown) {
    throw new SafeRestorePreWriteError(`Failed to resolve canonical path for target parent: ${currentPath}`, rpErr);
  }

  if (!isInsideOrEqual(canonicalRoot, canonicalParent)) {
    throw new SafeRestorePreWriteError(
      `Target parent escaped canonical root: ${canonicalParent} not within ${canonicalRoot}`
    );
  }

  const targetPath = path.join(currentPath, leafName);

  let existingMode: number | undefined;
  try {
    const targetStat = await lstat(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new SafeRestorePreWriteError(`Target leaf is a symlink: ${targetPath}`);
    }
    if (targetStat.isDirectory()) {
      throw new SafeRestorePreWriteError(`Target leaf is a directory: ${targetPath}`);
    }
    if (!targetStat.isFile()) {
      throw new SafeRestorePreWriteError(`Target leaf is not a regular file: ${targetPath}`);
    }
    existingMode = targetStat.mode;

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(targetPath);
    } catch (rpErr: unknown) {
      throw new SafeRestorePreWriteError(`Failed to resolve canonical path for target file: ${targetPath}`, rpErr);
    }

    if (!isInsideOrEqual(canonicalRoot, canonicalTarget)) {
      throw new SafeRestorePreWriteError(
        `Target file canonical path escaped root: ${targetPath} -> ${canonicalTarget}`
      );
    }
  } catch (err: unknown) {
    if (err instanceof SafeRestoreError) {
      throw err;
    }
    const code = getErrorCode(err);
    if (code === "ENOENT") {
      // Leaf does not exist yet; target parent containment was already verified
    } else {
      throw new SafeRestorePreWriteError(`Failed to inspect target file: ${targetPath}`, err);
    }
  }

  const noFollowFlag = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag;
  const fileMode = existingMode !== undefined ? (existingMode & 0o777) : 0o666;

  let fileHandle: FileHandle;
  try {
    fileHandle = await open(targetPath, flags, fileMode);
  } catch (openErr: unknown) {
    throw new SafeRestorePreWriteError(
      `Failed to open target file safely without following symlinks: ${targetPath}`,
      openErr
    );
  }

  try {
    await fileHandle.writeFile(contents, "utf8");
    if (existingMode !== undefined) {
      try {
        await fileHandle.chmod(existingMode & 0o777);
      } catch {
        // Mode preservation is best-effort where practical
      }
    }
  } catch (writeErr: unknown) {
    throw new SafeRestoreWriteError(`Failed to write contents to target file: ${targetPath}`, writeErr);
  } finally {
    try {
      await fileHandle.close();
    } catch {
      // Best-effort close
    }
  }
}
