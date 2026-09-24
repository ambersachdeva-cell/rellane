/**
 * Manifests: what was in a folder, cheap enough to record continuously.
 *
 * W1.2 originally said "continuous snapshots of granted roots" and meant
 * clones. Measured on this machine (M1 Pro, APFS, 2026-08-30), `clonefile(2)`
 * runs once per file at ~0.135 ms, so a 50,000-file folder is a 6.8-second
 * disk-thrash — and `du` cannot even report what the result costs, because it
 * prints logical size while the volume's free space moves by a twelfth of it.
 * A capture that expensive and that unmeasurable cannot run all day.
 *
 * A manifest is the same question answered by `stat`: path, size, mtime, inode,
 * one row per file. Measured on the same machine, 50,000 files walk in 700 ms
 * and store in 535 KB gzipped — 10× cheaper to take, and unlike a clone its
 * cost is known at the moment it is written, which is the only way the retention
 * ceiling in W1.3 can be honest.
 *
 * Clones did not go away; they moved to where someone is waiting for one — the
 * pre-image before a run, and the named checkpoints in W1.4.
 *
 * `docs/research/manifest-cost-bench.mjs` reproduces the numbers above.
 */

import { opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * One file, as a diff needs to compare it.
 *
 * `ino` is here for one reason and it is worth the byte: a file that appears in
 * one capture and vanishes from another is a deletion, unless the same inode
 * turns up under a new path, in which case it is a move. That distinction is
 * the whole difference between "Librarian deleted 47 files" and "Librarian
 * filed 47 files", and inode identity gives it away for free.
 */
export interface ManifestRow {
  /**
   * Relative to the manifest's root, always with forward slashes.
   *
   * Relative rather than absolute because DESIGN.md §8 forbids handing the
   * renderer a path it could replay. "Clients/2026/quote.pdf" is legible to the
   * person who granted the folder and useless to anything that does not already
   * hold the root.
   */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export interface Manifest {
  /** Absolute. Stays in the main process; never crosses to the renderer. */
  readonly root: string;
  readonly at: string;
  /** Sorted by path, so two captures of one folder diff without re-sorting. */
  readonly rows: readonly ManifestRow[];
  /**
   * True when the walk stopped at `MAX_ROWS` rather than reaching the end.
   *
   * A truncated manifest is still useful and must never be presented as
   * complete: a diff against one would report every unwalked file as deleted.
   */
  readonly truncated: boolean;
}

/**
 * The ceiling on one capture.
 *
 * At 0.014 ms per file this is about 3.5 seconds of walking, which is already
 * more than a background task should spend on a folder nobody asked about. A
 * root bigger than this is a signal the person granted their home directory,
 * and the honest response is to say so rather than to walk it every time
 * something changes.
 */
export const MAX_ROWS = 250_000;

/**
 * Directories never walked.
 *
 * Not a tidiness preference. These hold thousands of files that churn for
 * reasons unrelated to the owner's work, so including them makes every diff
 * noisy and every capture slow, while telling nobody anything. `node_modules`
 * alone can be half the row budget of an otherwise small folder.
 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".Trash",
  ".Spotlight-V100",
  ".fseventsd",
  ".DocumentRevisions-V100",
  ".TemporaryItems"
]);

/** Files never recorded, for the same reason. */
const SKIP_FILES = new Set([".DS_Store", ".localized"]);

export interface CaptureResult {
  readonly manifest: Manifest;
  readonly tookMs: number;
}

/**
 * Walks `root` and records what is in it. Reads only; changes nothing.
 *
 * Symlinks are recorded as absent rather than followed. Following them would
 * let a link inside a granted folder pull the walk onto a volume the owner
 * never granted, and would make a cycle a hang.
 */
export async function captureManifest(root: string, now = Date.now(), signal?: AbortSignal): Promise<CaptureResult> {
  const started = Date.now();
  const rows: ManifestRow[] = [];
  signal?.throwIfAborted();
  const truncated = await walk(root, root, rows, signal);
  signal?.throwIfAborted();

  // Sorted once, here, so every consumer can assume it and diffing is a
  // two-pointer walk rather than a pair of hash tables over 250,000 rows.
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return {
    manifest: { root, at: new Date(now).toISOString(), rows, truncated },
    tookMs: Date.now() - started
  };
}

/** Returns true when the row ceiling stopped the walk. */
async function walk(root: string, dir: string, rows: ManifestRow[], signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    // An unreadable subfolder is skipped rather than failing the capture. A
    // manifest missing one folder is worth more than no manifest at all, and
    // the permission that caused it is already reported elsewhere.
    return false;
  }

  const subdirectories: string[] = [];
  try {
    for await (const entry of handle) {
      signal?.throwIfAborted();
      if (rows.length >= MAX_ROWS) {
        return true;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          subdirectories.push(join(dir, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) {
        continue;
      }

      const full = join(dir, entry.name);
      signal?.throwIfAborted();
      const info = await stat(full).catch(() => null);
      signal?.throwIfAborted();
      if (info === null) {
        // Written and removed between the readdir and the stat. Ordinary in a
        // folder someone is working in, and not worth failing over.
        continue;
      }
      rows.push({
        path: toPosix(relative(root, full)),
        size: info.size,
        mtimeMs: Math.round(info.mtimeMs),
        ino: info.ino
      });
    }
  } catch {
    signal?.throwIfAborted();
    return false;
  }

  // Depth-first, but after this directory's own files, so a ceiling-truncated
  // manifest is broad rather than one deep spike down the first subfolder.
  for (const subdirectory of subdirectories) {
    if (rows.length >= MAX_ROWS) {
      return true;
    }
    if (await walk(root, subdirectory, rows, signal)) {
      return true;
    }
  }
  return false;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** A file that is in both captures but not identical. */
export interface ChangedRow {
  readonly path: string;
  readonly before: ManifestRow;
  readonly after: ManifestRow;
}

/** A file that is in both captures under two different names. */
export interface MovedRow {
  readonly from: string;
  readonly to: string;
}

export interface ManifestDiff {
  readonly added: readonly ManifestRow[];
  readonly removed: readonly ManifestRow[];
  readonly changed: readonly ChangedRow[];
  readonly moved: readonly MovedRow[];
  /**
   * True when either side was truncated, so the counts are a floor rather than
   * a total. A diff that cannot say this would report a row ceiling as a mass
   * deletion.
   */
  readonly partial: boolean;
}

/**
 * What changed between two captures of one folder.
 *
 * Moves are resolved before deletions are reported: a file whose inode appears
 * on both sides under different names moved, and appears in `moved` rather than
 * as a removal plus an addition. Anything else would describe every run of the
 * Librarian — a skill whose entire job is moving files — as destruction.
 */
export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const added: ManifestRow[] = [];
  const removed: ManifestRow[] = [];
  const changed: ChangedRow[] = [];

  // Both sides arrive sorted by path, so this is one pass rather than two maps.
  let left = 0;
  let right = 0;
  while (left < before.rows.length || right < after.rows.length) {
    const b = before.rows[left];
    const a = after.rows[right];

    if (b === undefined) {
      added.push(a as ManifestRow);
      right += 1;
      continue;
    }
    if (a === undefined) {
      removed.push(b);
      left += 1;
      continue;
    }
    if (b.path === a.path) {
      // mtime alone would miss a file rewritten within the same millisecond;
      // size alone would miss an edit that kept the length. Both, together,
      // are what "changed" can mean without hashing every file on every diff.
      if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
        changed.push({ path: a.path, before: b, after: a });
      }
      left += 1;
      right += 1;
      continue;
    }
    if (b.path < a.path) {
      removed.push(b);
      left += 1;
    } else {
      added.push(a);
      right += 1;
    }
  }

  const moved = extractMoves(removed, added);

  return {
    added,
    removed,
    changed,
    moved,
    partial: before.truncated || after.truncated
  };
}

/**
 * Pulls moves out of the removed/added pairs, in place.
 *
 * An inode is unique per volume but reused after a file is deleted, so a match
 * is only treated as a move when the size matches too. Getting this wrong in
 * the safe direction — reporting a move as a delete-plus-add — is merely noisy;
 * getting it wrong the other way would claim a deleted file still exists.
 */
function extractMoves(removed: ManifestRow[], added: ManifestRow[]): readonly MovedRow[] {
  if (removed.length === 0 || added.length === 0) {
    return [];
  }

  const byInode = new Map<number, ManifestRow[]>();
  for (const row of added) {
    const bucket = byInode.get(row.ino);
    if (bucket === undefined) {
      byInode.set(row.ino, [row]);
    } else {
      bucket.push(row);
    }
  }

  const moved: MovedRow[] = [];
  const movedAway = new Set<ManifestRow>();
  const arrivedAs = new Set<ManifestRow>();

  for (const row of removed) {
    const candidates = byInode.get(row.ino);
    const match = candidates?.find(
      (candidate) => candidate.size === row.size && !arrivedAs.has(candidate)
    );
    if (match !== undefined) {
      moved.push({ from: row.path, to: match.path });
      movedAway.add(row);
      arrivedAs.add(match);
    }
  }

  if (moved.length > 0) {
    prune(removed, movedAway);
    prune(added, arrivedAs);
  }
  return moved;
}

function prune(rows: ManifestRow[], drop: ReadonlySet<ManifestRow>): void {
  let kept = 0;
  for (const row of rows) {
    if (!drop.has(row)) {
      rows[kept] = row;
      kept += 1;
    }
  }
  rows.length = kept;
}

/** True when nothing at all changed between two captures. */
export function isQuiet(diff: ManifestDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    diff.moved.length === 0
  );
}
