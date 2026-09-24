import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";

export interface WorkspaceEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "file" | "folder";
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly textual: boolean;
  readonly depth: number;
}

export interface WorkspaceListing {
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
  readonly totalBytes: number;
}

export type PreviewOutcome =
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean; readonly bytes: number }
  | { readonly status: "unavailable"; readonly reason: string };

export const MAX_ENTRIES = 500;
export const MAX_DEPTH = 4;
export const MAX_PREVIEW_BYTES = 262_144;

function isInsideRoot(candidate: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function trimIncompleteUtf8(buf: Buffer): Buffer {
  const len = buf.length;
  if (len === 0) {
    return buf;
  }

  const b0 = buf[len - 1]!;
  if ((b0 & 0x80) === 0) {
    return buf;
  }
  if ((b0 & 0xc0) === 0xc0) {
    return buf.subarray(0, len - 1);
  }

  if (len >= 2) {
    const b1 = buf[len - 2]!;
    if ((b1 & 0xe0) === 0xe0) {
      return buf.subarray(0, len - 2);
    }
  }

  if (len >= 3) {
    const b2 = buf[len - 3]!;
    if ((b2 & 0xf0) === 0xf0) {
      return buf.subarray(0, len - 3);
    }
  }

  return buf;
}

function isTextualBuffer(buf: Buffer, isTruncated: boolean): boolean {
  if (buf.includes(0)) {
    return false;
  }
  const toTest = isTruncated ? trimIncompleteUtf8(buf) : buf;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(toTest);
    return true;
  } catch {
    return false;
  }
}

async function isTextualFile(filePath: string, size: number): Promise<boolean> {
  if (size === 0) {
    return true;
  }
  const sampleSize = Math.min(size, 1024);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(sampleSize);
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0);
    const slice = buffer.subarray(0, bytesRead);
    return isTextualBuffer(slice, bytesRead < size);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1;
  }
  const nameComparison = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (nameComparison !== 0) {
    return nameComparison;
  }
  const exactNameComparison = a.name.localeCompare(b.name);
  if (exactNameComparison !== 0) {
    return exactNameComparison;
  }
  return a.relativePath.localeCompare(b.relativePath);
}

export async function listWorkspace(root: string): Promise<WorkspaceListing> {
  const resolvedRoot = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch {
    return {
      entries: [],
      truncated: false,
      totalBytes: 0
    };
  }

  try {
    const rootStat = await fs.stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      return {
        entries: [],
        truncated: false,
        totalBytes: 0
      };
    }
  } catch {
    return {
      entries: [],
      truncated: false,
      totalBytes: 0
    };
  }

  let truncated = false;
  const entries: WorkspaceEntry[] = [];
  const visitedDirs = new Set<string>([canonicalRoot]);
  const queue: { readonly dirPath: string; readonly depth: number }[] = [
    { dirPath: canonicalRoot, depth: 1 }
  ];

  while (queue.length > 0) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }

    const current = queue.shift();
    if (!current) {
      break;
    }

    // `readdir` is overloaded and its inferred return is the Buffer-named
    // variant; the string form is what `withFileTypes` actually yields here.
    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(current.dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    // Sort directory items to prioritise folders and alphabetical names when capping entries
    dirEntries.sort((a, b) => {
      const aIsFolder = a.isDirectory() ? 0 : 1;
      const bIsFolder = b.isDirectory() ? 0 : 1;
      if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    for (const dirent of dirEntries) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") {
        // Dotfiles and dependencies are skipped to keep workspace listings focused on user content
        continue;
      }

      const fullPath = path.join(current.dirPath, dirent.name);
      let realPath: string;
      try {
        realPath = dirent.isSymbolicLink() ? await fs.realpath(fullPath) : fullPath;
      } catch {
        continue;
      }

      if (!isInsideRoot(realPath, canonicalRoot)) {
        // Symlinks targeting locations outside root are skipped to prevent directory escape
        continue;
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(realPath);
      } catch {
        continue;
      }

      const isDir = stat.isDirectory();
      const isFile = stat.isFile();
      if (!isDir && !isFile) {
        continue;
      }

      if (current.depth > MAX_DEPTH) {
        truncated = true;
        continue;
      }

      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }

      const relativePath = path.relative(canonicalRoot, fullPath).split(path.sep).join("/");

      if (isDir) {
        entries.push({
          name: dirent.name,
          relativePath,
          kind: "folder",
          bytes: 0,
          modifiedAt: Math.round(stat.mtimeMs),
          textual: false,
          depth: current.depth
        });

        if (current.depth < MAX_DEPTH) {
          if (!visitedDirs.has(realPath)) {
            visitedDirs.add(realPath);
            queue.push({ dirPath: fullPath, depth: current.depth + 1 });
          }
        } else {
          // Check whether the folder at max depth contains children that would be omitted
          try {
            const children = await fs.readdir(realPath, { withFileTypes: true });
            for (const child of children) {
              if (!child.name.startsWith(".") && child.name !== "node_modules") {
                truncated = true;
                break;
              }
            }
          } catch {
            // Unreadable subdirectories do not affect truncation state
          }
        }
      } else {
        const textual = await isTextualFile(realPath, stat.size);
        entries.push({
          name: dirent.name,
          relativePath,
          kind: "file",
          bytes: stat.size,
          modifiedAt: Math.round(stat.mtimeMs),
          textual,
          depth: current.depth
        });
      }
    }
  }

  entries.sort(compareEntries);
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);

  return {
    entries,
    truncated,
    totalBytes
  };
}

export async function previewFile(root: string, relativePath: string): Promise<PreviewOutcome> {
  const resolvedRoot = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch {
    return {
      status: "unavailable",
      reason: "Workspace folder could not be found."
    };
  }

  const cleanRelative = relativePath.replace(/^[/\\]+/, "");
  const targetPath = path.resolve(canonicalRoot, cleanRelative);
  if (!isInsideRoot(targetPath, canonicalRoot)) {
    return {
      status: "unavailable",
      reason: "The requested path is outside the workspace."
    };
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(targetPath);
  } catch {
    return {
      status: "unavailable",
      reason: "The requested file does not exist."
    };
  }

  if (!isInsideRoot(realTarget, canonicalRoot)) {
    return {
      status: "unavailable",
      reason: "The requested file links outside the workspace."
    };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(realTarget);
  } catch {
    return {
      status: "unavailable",
      reason: "The requested file could not be read."
    };
  }

  if (stat.isDirectory()) {
    return {
      status: "unavailable",
      reason: "The requested path is a folder, not a file."
    };
  }

  if (!stat.isFile()) {
    return {
      status: "unavailable",
      reason: "The requested path is not a regular file."
    };
  }

  const readLimit = Math.min(stat.size, MAX_PREVIEW_BYTES);
  const buffer = Buffer.alloc(readLimit);
  let handle: fs.FileHandle | null = null;
  let bytesRead = 0;

  try {
    handle = await fs.open(realTarget, "r");
    const result = await handle.read(buffer, 0, readLimit, 0);
    bytesRead = result.bytesRead;
  } catch {
    return {
      status: "unavailable",
      reason: "The file could not be opened for reading."
    };
  } finally {
    await handle?.close().catch(() => {});
  }

  const slice = buffer.subarray(0, bytesRead);
  const isTruncated = stat.size > MAX_PREVIEW_BYTES;

  if (slice.includes(0)) {
    return {
      status: "unavailable",
      reason: "The file is binary and cannot be previewed as text."
    };
  }

  const textBuffer = isTruncated ? trimIncompleteUtf8(slice) : slice;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(textBuffer);
    return {
      status: "text",
      text,
      truncated: isTruncated,
      bytes: stat.size
    };
  } catch {
    return {
      status: "unavailable",
      reason: "The file is binary and cannot be previewed as text."
    };
  }
}
