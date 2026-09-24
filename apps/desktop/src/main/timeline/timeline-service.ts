/**
 * The timeline, shaped for the screen.
 *
 * The store and the watcher deal in manifests; this turns them into the four
 * questions the interface actually asks — what states do you have, what changed
 * between two of them, remember this moment, and is this file really what it
 * says it is.
 *
 * Two rules run through all of it. Counts are always complete even when the
 * list of changes is capped, because telling someone "47 files moved" and then
 * showing 200 rows is honest while showing 200 rows and letting them assume
 * that is all of it is not. And a truncated capture is carried through every
 * layer, because a diff that hid it would report a row ceiling as a mass
 * deletion.
 */

import { normalize } from "node:path";
import type { Sandbox } from "../tools/sandbox.js";
import { hashGrantedFile } from "./hash-file.js";
export { MAX_HASH_BYTES } from "./hash-file.js";
import type {
  ContentDigest,
  FolderChange,
  FolderDiff,
  TimelineCapture
} from "@cadrane/contracts";
import { captureManifest, diffManifests, type ManifestDiff } from "./manifest.js";
import type { ManifestStore } from "./manifest-store.js";
import type { FolderWatcher } from "./watcher.js";
import { plural } from "../../shared/copy.js";

/**
 * The most changes sent to the renderer in one diff.
 *
 * A folder reorganisation can move tens of thousands of files, and neither the
 * IPC boundary nor a scrolling list is improved by carrying all of them. The
 * counts stay complete; this caps only what is listed.
 */
export const MAX_LISTED_CHANGES = 500;

export class TimelineService {
  constructor(
    private readonly store: ManifestStore,
    private readonly watcher: FolderWatcher,
    /** Decides whether a folder is one the owner actually granted. */
    private readonly grantedSandbox: () => Sandbox | null
  ) {}

  async captures(folder: string): Promise<readonly TimelineCapture[]> {
    const root = this.requireGranted(folder);
    const stored = await this.store.list(root);

    // The listing needs each capture's file count, which lives inside the
    // capture. Reading them all is a gunzip per entry; retention keeps that
    // number in the dozens rather than the thousands, which is what makes this
    // affordable rather than clever.
    const captures: TimelineCapture[] = [];
    for (const entry of stored) {
      const read = await this.store.read(root, entry.at);
      if (read === null) {
        continue;
      }
      captures.push({
        at: read.manifest.at,
        checkpoint: read.checkpoint,
        files: read.manifest.rows.length,
        truncated: read.manifest.truncated
      });
    }
    return captures;
  }

  async diff(folder: string, from: string, to: string): Promise<FolderDiff> {
    const root = this.requireGranted(folder);
    const before = await this.store.read(root, Date.parse(from));
    const after = await this.store.read(root, Date.parse(to));

    if (before === null || after === null) {
      throw new Error(
        "One of those two moments is no longer held. The record thins as it ages, so an older comparison may have been let go."
      );
    }

    const diff = diffManifests(before.manifest, after.manifest);
    return {
      from: before.manifest.at,
      to: after.manifest.at,
      summary: describeDiff(diff),
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        moved: diff.moved.length
      },
      changes: listChanges(diff),
      capped: totalChanges(diff) > MAX_LISTED_CHANGES,
      partial: diff.partial
    };
  }

  async checkpoint(folder: string, reason: string): Promise<TimelineCapture> {
    const root = this.requireGranted(folder);
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new Error("A checkpoint needs a reason, so it can be recognised later.");
    }

    const at = await this.watcher.checkpoint(root, trimmed);
    const read = await this.store.read(root, at);
    const { manifest } = read ?? (await captureManifest(root));

    return {
      at: manifest.at,
      checkpoint: trimmed,
      files: manifest.rows.length,
      truncated: manifest.truncated
    };
  }

  /**
   * Hashes one file as it stands now.
   *
   * Streamed rather than read whole: a 2 GB video should not become 2 GB of
   * heap in the main process because someone clicked "check contents".
   */
  async hash(folder: string, path: string): Promise<ContentDigest> {
    const root = this.requireGranted(folder);
    return hashGrantedFile(root, path, this.grantedSandbox);
  }

  /**
   * Refuses a folder the owner has not granted.
   *
   * The renderer already holds the granted roots, so this is not defending
   * against the UI — it is defending against every future caller, including a
   * skill, that might pass a path derived from something a model wrote.
   */
  private requireGranted(folder: string): string {
    const normalised = normalize(folder);
    const root = (this.grantedSandbox()?.spelledRoots ?? []).find((granted) => normalize(granted) === normalised);
    if (root === undefined) {
      throw new Error("That folder has not been granted to Rellane.");
    }
    return root;
  }

}

function totalChanges(diff: ManifestDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length + diff.moved.length;
}

/**
 * The listed subset.
 *
 * Moves first, then edits, then additions, then removals — roughly the order
 * of how much a reader cares. Someone scanning a capped list is looking for
 * "what happened to my files", and a move is a stronger answer than a new
 * temporary file appearing.
 */
function listChanges(diff: ManifestDiff): readonly FolderChange[] {
  const changes: FolderChange[] = [];

  for (const moved of diff.moved) {
    changes.push({ kind: "moved", path: moved.from, movedTo: moved.to, bytes: 0, bytesDelta: null });
  }
  for (const changed of diff.changed) {
    changes.push({
      kind: "changed",
      path: changed.path,
      movedTo: null,
      bytes: changed.after.size,
      bytesDelta: changed.after.size - changed.before.size
    });
  }
  for (const added of diff.added) {
    changes.push({ kind: "added", path: added.path, movedTo: null, bytes: added.size, bytesDelta: null });
  }
  for (const removed of diff.removed) {
    changes.push({
      kind: "removed",
      path: removed.path,
      movedTo: null,
      bytes: removed.size,
      bytesDelta: null
    });
  }

  return changes.slice(0, MAX_LISTED_CHANGES);
}

/**
 * One sentence for the whole diff, in the owner's nouns.
 *
 * "filed" rather than "moved" is deliberate: moving is what the filesystem did,
 * filing is what the person recognises. Removals are named plainly rather than
 * softened — a tool that says "3 files tidied" when it means deleted is one you
 * stop trusting the first time you check.
 */
export function describeDiff(diff: ManifestDiff): string {
  const parts: string[] = [];
  if (diff.moved.length > 0) parts.push(`${plural(diff.moved.length, "file")} filed`);
  if (diff.changed.length > 0) parts.push(`${plural(diff.changed.length, "file")} edited`);
  if (diff.added.length > 0) parts.push(`${plural(diff.added.length, "file")} added`);
  if (diff.removed.length > 0) parts.push(`${plural(diff.removed.length, "file")} deleted`);

  if (parts.length === 0) {
    return "Nothing changed.";
  }

  const sentence = `${parts.join(", ")}.`;
  return diff.partial
    ? `${sentence} At least — one of these two readings stopped early, so there may be more.`
    : sentence;
}
