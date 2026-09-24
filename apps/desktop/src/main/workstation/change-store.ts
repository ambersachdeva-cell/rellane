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
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listWorkspace } from "./workspace-files.js";

export interface SnapshotEntry {
  readonly relativePath: string;
  readonly hash: string;
  readonly bytes: number;
  readonly modifiedAt: number;
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
      contents = await fs.readFile(path.join(folder, entry.relativePath));
    } catch {
      // A file that cannot be read now cannot be compared later either.
      continue;
    }
    entries.push({
      relativePath: entry.relativePath,
      hash: hashOf(contents),
      bytes: entry.bytes,
      modifiedAt: entry.modifiedAt
    });
  }

  return entries;
}

/**
 * Writes down the folder as it stands, and the text of the files small enough
 * to put back. Returns false when it could not, which the caller treats as "no
 * before is known" rather than as an error worth stopping work for.
 */
export async function saveBefore(
  root: string,
  caseId: string,
  operationId: string,
  folder: string
): Promise<boolean> {
  const target = runFolder(root, caseId, operationId);
  if (target === null) {
    return false;
  }

  let entries: readonly SnapshotEntry[];
  try {
    entries = await snapshotFolder(folder);
  } catch {
    return false;
  }

  try {
    await fs.mkdir(path.join(target, "files"), { recursive: true });
  } catch {
    return false;
  }

  let kept = 0;
  for (const entry of entries) {
    if (kept >= MAX_KEPT_FILES || entry.bytes > MAX_KEPT_BYTES) {
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(path.join(folder, entry.relativePath), "utf8");
    } catch {
      continue;
    }
    // Named by the hash of its path, so a nested file needs no nested folders
    // and no path of the owner's ever reaches this directory listing.
    try {
      await fs.writeFile(path.join(target, "files", hashOf(entry.relativePath)), text, "utf8");
      kept += 1;
    } catch {
      continue;
    }
  }

  try {
    await fs.writeFile(
      path.join(target, "snapshot.json"),
      JSON.stringify({ takenAt: Date.now(), folder, entries }),
      "utf8"
    );
  } catch {
    return false;
  }

  return true;
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
    return out;
  } catch {
    return null;
  }
}

/** The saved text of one file as it was before, or null when it was not kept. */
export async function readContentBefore(
  root: string,
  caseId: string,
  operationId: string,
  relativePath: string
): Promise<string | null> {
  const target = runFolder(root, caseId, operationId);
  if (target === null) {
    return null;
  }
  try {
    return await fs.readFile(path.join(target, "files", hashOf(relativePath)), "utf8");
  } catch {
    return null;
  }
}
