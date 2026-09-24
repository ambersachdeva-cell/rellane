/**
 * Pre-image snapshots: undo that costs nothing.
 *
 * Before a skill touches anything, Rellane takes an APFS clone of the target.
 * Clones are copy-on-write, so the snapshot is effectively free until something
 * diverges — which means undo can be offered for every run rather than being
 * rationed by disk.
 *
 * Measured on this machine (M1 Pro, APFS), 2026-08-21:
 *   64 MB clone      28 ms, free space delta -312 KB (i.e. noise)
 *   64 MB real copy  65,588 KB
 * and writing into the clone left the original byte-identical, so divergence
 * behaves as documented.
 *
 * The fallback matters as much as the fast path: on a non-APFS volume, or an
 * external drive, `cp -c` fails and we fall back to a real copy with a size
 * ceiling. Undo is either genuinely available or honestly refused — never
 * promised and then missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { UndoOutlook } from "@cadrane/contracts";

const run = promisify(execFile);

/** Above this, a non-clone fallback is refused rather than silently slow. */
export const FALLBACK_MAX_BYTES = 256 * 1024 * 1024;

const CLONE_TIMEOUT_MS = 30_000;

/** Every snapshot holder starts with this, which is what `discard` checks. */
const PREFIX = "cadrane-preimage-";

export type SnapshotMethod = "apfs-clone" | "copy";

export interface Snapshot {
  /** What was snapshotted. */
  readonly source: string;
  /** Where the pre-image lives. Outside the sandbox, in a temp dir we own. */
  readonly preimage: string;
  /**
   * The temp directory made for this snapshot, recorded rather than derived.
   *
   * `discard` used to delete `join(preimage, "..")` — walking *up* from a path
   * to find what to `rm -rf`. That arithmetic is only ever as safe as the
   * assumption that `preimage` sits one level inside the holder, and it turns
   * any control over `preimage` into control over an arbitrary recursive
   * delete: a `preimage` of `/tmp/x/..` makes the target `/`.
   *
   * Nothing reachable today supplies such a value — snapshots are made here and
   * never cross the IPC boundary — but the cost of removing the class entirely
   * is one field, and the cost of being wrong about reachability once is the
   * owner's disk.
   */
  readonly holder: string;
  readonly method: SnapshotMethod;
  readonly bytes: number;
  readonly tookMs: number;
}

export class SnapshotUnavailable extends Error {
  constructor(
    readonly reason: "too-large" | "unsupported" | "missing",
    message: string
  ) {
    super(message);
    this.name = "SnapshotUnavailable";
  }
}

async function sizeOf(target: string): Promise<number> {
  const info = await stat(target).catch(() => null);
  if (info === null) {
    throw new SnapshotUnavailable("missing", `${target} does not exist, so it cannot be snapshotted.`);
  }
  if (info.isFile()) {
    return info.size;
  }
  // Directory: ask the filesystem rather than walking it ourselves.
  const { stdout } = await run("/usr/bin/du", ["-sk", target], { timeout: CLONE_TIMEOUT_MS });
  return Number(stdout.trim().split(/\s+/u)[0] ?? 0) * 1024;
}

/**
 * Snapshots `target` before it is modified.
 *
 * Tries the APFS clone first; falls back to a real copy only when the file is
 * small enough that the copy is not itself a problem.
 */
export async function takePreimage(target: string): Promise<Snapshot> {
  /**
   * Checked here rather than trusted from the caller.
   *
   * `basename` is the whole snapshot path: `basename("..")` is `".."`, so a
   * target of `..` would put the pre-image at the holder's own parent — `/tmp` —
   * and then `cp -R` and `rm -rf` would work on that instead. Today the only
   * caller passes a realpathed directory that `resolveInSandbox` already
   * validated, so it cannot happen; that is a property of one call site, and
   * this is the function that shells out to `/bin/cp` and deletes recursively.
   */
  if (!isAbsolute(target)) {
    throw new SnapshotUnavailable("missing", `${target} is not an absolute path.`);
  }
  const name = basename(target);
  if (name === "" || name === "." || name === "..") {
    throw new SnapshotUnavailable("missing", `${target} does not name something that can be snapshotted.`);
  }
  const bytes = await sizeOf(target);
  const holder = await mkdtemp(join(tmpdir(), PREFIX));
  const preimage = join(holder, name);
  const startedAt = Date.now();

  try {
    // -c requests a clone; it fails outright rather than silently copying,
    // which is what makes the method reported here trustworthy.
    await run("/bin/cp", ["-c", "-R", target, preimage], { timeout: CLONE_TIMEOUT_MS });
    return {
      source: target,
      preimage,
      holder,
      method: "apfs-clone",
      bytes,
      tookMs: Date.now() - startedAt
    };
  } catch {
    if (bytes > FALLBACK_MAX_BYTES) {
      await rm(holder, { recursive: true, force: true });
      throw new SnapshotUnavailable(
        "too-large",
        `${target} is ${Math.round(bytes / 1024 / 1024)} MB and this volume does not support instant snapshots, so undo cannot be offered.`
      );
    }
    try {
      // Same reason as in `restore`: the failed clone may have created
      // `preimage`, and `cp -R` into an existing directory nests rather than
      // replaces — which would corrupt the snapshot before it was ever needed.
      await rm(preimage, { recursive: true, force: true });
      await run("/bin/cp", ["-R", target, preimage], { timeout: CLONE_TIMEOUT_MS });
      return {
        source: target,
        preimage,
        holder,
        method: "copy",
        bytes,
        tookMs: Date.now() - startedAt
      };
    } catch (error) {
      await rm(holder, { recursive: true, force: true });
      throw new SnapshotUnavailable(
        "unsupported",
        `Could not snapshot ${target}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }
}

/**
 * Puts the pre-image back, replacing whatever is there now.
 *
 * The new state is moved aside first rather than deleted, so a restore that
 * fails halfway leaves both versions on disk instead of neither.
 */
export async function restore(snapshot: Snapshot): Promise<void> {
  const quarantine = `${snapshot.source}.cadrane-undo-${Date.now()}`;
  const displaced = await stat(snapshot.source)
    .then(() => true)
    .catch(() => false);

  if (displaced) {
    await run("/bin/mv", [snapshot.source, quarantine], { timeout: CLONE_TIMEOUT_MS });
  }
  try {
    await run("/bin/cp", ["-c", "-R", snapshot.preimage, snapshot.source], {
      timeout: CLONE_TIMEOUT_MS
    }).catch(async () => {
      /**
       * Clear whatever the failed clone left behind, first.
       *
       * `cp -c -R src dest` creates `dest` and *then* discovers the volume
       * cannot clone — so `dest` exists when the fallback runs, and BSD `cp -R`
       * given an existing directory copies **into** it. The restored tree ended
       * up at `source/<basename>`, the copy reported success, and the quarantine
       * — the only remaining copy of the original — was deleted immediately
       * afterwards. An undo that destroys what it was undoing.
       */
      await rm(snapshot.source, { recursive: true, force: true });
      await run("/bin/cp", ["-R", snapshot.preimage, snapshot.source], {
        timeout: CLONE_TIMEOUT_MS
      });
    });
  } catch (error) {
    // Restore failed: put back what was there so nothing is lost.
    if (displaced) {
      await run("/bin/mv", [quarantine, snapshot.source], { timeout: CLONE_TIMEOUT_MS }).catch(
        () => undefined
      );
    }
    throw error;
  }
  if (displaced) {
    /**
     * The quarantine is the last copy of what was there. It goes only once the
     * restore is *observed* to have landed — the same rule backups follow, and
     * for the same reason: deleting on the strength of "the command exited
     * zero" is how a silent partial restore becomes permanent.
     */
    const landed = await stat(snapshot.source)
      .then(() => true)
      .catch(() => false);
    if (!landed) {
      await run("/bin/mv", [quarantine, snapshot.source], { timeout: CLONE_TIMEOUT_MS }).catch(
        () => undefined
      );
      throw new SnapshotUnavailable(
        "missing",
        "The restore did not put anything back, so what was there has been left exactly as it was."
      );
    }
    await rm(quarantine, { recursive: true, force: true });
  }
}

/** Releases a pre-image once its undo window has closed. */
export async function discard(snapshot: Snapshot): Promise<void> {
  // The recorded holder, never `join(preimage, "..")`. See `Snapshot.holder`.
  if (!isAbsolute(snapshot.holder) || !snapshot.holder.startsWith(join(tmpdir(), PREFIX))) {
    // A holder outside our own temp prefix is not one we made, and this is the
    // line that deletes recursively. Refusing costs a stale temp directory;
    // proceeding costs whatever the path actually names.
    throw new SnapshotUnavailable(
      "missing",
      `${snapshot.holder} is not a snapshot directory Rellane created, so it will not be deleted.`
    );
  }
  await rm(snapshot.holder, { recursive: true, force: true });
}

/**
 * How deep to look for a file to test the clone against.
 *
 * A folder whose first three levels hold nothing but directories is rare enough
 * that giving up and testing the directory itself is cheaper than walking a
 * tree at preview time.
 */
const PROBE_MAX_DEPTH = 3;

/**
 * Works out whether this folder could be put back, without putting anything at
 * risk to find out.
 *
 * The question is not "does Rellane support undo" — it always does — but "does
 * *this* volume support the mechanism undo is built on". `clonefile(2)` needs
 * the source and the destination on one volume, and the destination is always
 * Rellane's own temp directory. So an external disk, a network share and a FAT
 * stick all fail it no matter how new the Mac is.
 *
 * It is answered by measurement rather than by inspecting the filesystem type:
 * cloning one small file the folder already contains runs the exact syscall the
 * real snapshot will run, which is the only check that cannot be right about
 * APFS and wrong about this path. Nothing in the owner's folder is written to
 * or moved — one file is read, its clone lands in a temp directory we own, and
 * that directory is removed before this returns.
 */
export async function probeUndo(target: string): Promise<UndoOutlook> {
  let bytes: number;
  try {
    bytes = await sizeOf(target);
  } catch (error) {
    if (error instanceof SnapshotUnavailable) {
      return { kind: "unavailable", bytes: 0, reason: error.message };
    }
    throw error;
  }
  return outlookFrom(target, bytes, await cloneWorksFrom(target));
}

/**
 * The verdict, given the two things that were measured.
 *
 * Separated from the measuring so the branches can be tested on the machine
 * that has them — this one is APFS throughout, so a suite that could only reach
 * `instant` would be asserting one third of the behaviour and reporting it as
 * whole. The non-clone paths are exactly the ones a customer with an external
 * drive meets first, and they are the ones nobody here can reproduce by hand.
 */
export function outlookFrom(target: string, bytes: number, clonable: boolean): UndoOutlook {
  if (clonable) {
    return { kind: "instant", bytes };
  }
  if (bytes <= FALLBACK_MAX_BYTES) {
    return { kind: "copied", bytes };
  }
  return {
    kind: "unavailable",
    bytes,
    reason: `This volume cannot take instant snapshots, and ${basename(target)} is ${Math.round(
      bytes / 1024 / 1024
    )} MB — too much to copy first. Nothing here can be put back afterwards.`
  };
}

/** Runs the real clone syscall against one file the folder already holds. */
async function cloneWorksFrom(target: string): Promise<boolean> {
  const sample = await sampleFile(target);
  if (sample === null) {
    // Nothing to test with, and nothing to lose either: an empty tree snapshots
    // for free whichever mechanism is used.
    return true;
  }

  const holder = await mkdtemp(join(tmpdir(), "cadrane-undo-probe-"));
  try {
    // -c clones or fails; it never quietly falls back to copying bytes, which
    // is what makes a success here mean what it says.
    await run("/bin/cp", ["-c", sample, join(holder, "probe")], { timeout: CLONE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  } finally {
    await rm(holder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The first regular file at or under `target`, breadth-first and depth-capped.
 *
 * Symlinks are skipped: `Dirent.isFile()` is false for them, and cloning one
 * would test the volume the link points at rather than the one the folder is on.
 */
async function sampleFile(target: string, depth = 0): Promise<string | null> {
  const info = await stat(target).catch(() => null);
  if (info === null) {
    return null;
  }
  if (info.isFile()) {
    return target;
  }
  if (depth >= PROBE_MAX_DEPTH) {
    return null;
  }

  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile()) {
      return join(target, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await sampleFile(join(target, entry.name), depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Human sentence for the receipt. */
export function describeSnapshot(snapshot: Snapshot): string {
  const mb = snapshot.bytes / 1024 / 1024;
  const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(snapshot.bytes / 1024)} KB`;
  return snapshot.method === "apfs-clone"
    ? `Snapshotted ${size} in ${snapshot.tookMs} ms, using no extra disk.`
    : `Copied ${size} in ${snapshot.tookMs} ms so this can be undone.`;
}
