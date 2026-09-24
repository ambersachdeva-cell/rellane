/**
 * Where manifests live, and how they stop accumulating.
 *
 * One directory per granted root, named by a hash of its absolute path rather
 * than by the path itself: a folder called "Sharma Printers — GST disputes"
 * should not be legible to anything that can list `~/Library/Application
 * Support`, and hashing also sidesteps every filename-length and character
 * question in one move.
 *
 * Captures are stored as gzipped newline-delimited JSON, rows as arrays under a
 * declared column order. Measured on this machine, 50,000 files is 7.0 MB raw
 * and 535 KB gzipped, which is what makes the byte ceiling in `retention.ts` a
 * number rather than an aspiration.
 *
 * The index is a convenience, never the truth: it is rebuilt by reading the
 * directory whenever it is missing or unparseable, so a corrupted index costs a
 * slow first listing rather than the timeline.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Manifest, ManifestRow } from "./manifest.js";
import { thin, totalBytes, type RetentionPlan, type StoredCapture } from "./retention.js";
import { diagnostics } from "../foundations/diagnostics.js";

/** Bumped when the on-disk shape changes in a way a reader must notice. */
const FORMAT = 1;

const CAPTURE_SUFFIX = ".mfst.gz";
const INDEX_FILE = "index.json";

interface CaptureHeader {
  readonly format: number;
  readonly root: string;
  readonly at: string;
  readonly truncated: boolean;
  readonly checkpoint: string | null;
  /** Declared so a future column can be added without guessing at read time. */
  readonly columns: readonly ["path", "size", "mtimeMs", "ino"];
}

export interface StoredManifest {
  readonly manifest: Manifest;
  readonly checkpoint: string | null;
}

export class ManifestStore {
  constructor(private readonly directory: string) {}

  /**
   * Writes a capture and returns what it cost.
   *
   * The byte count is the compressed size on disk, which is the number
   * retention has to reason about — not the row count, and not the logical size
   * of the folder it describes.
   */
  async write(
    manifest: Manifest,
    checkpoint: string | null = null
  ): Promise<StoredCapture> {
    const folder = this.folderFor(manifest.root);
    await mkdir(folder, { recursive: true });

    const header: CaptureHeader = {
      format: FORMAT,
      root: manifest.root,
      at: manifest.at,
      truncated: manifest.truncated,
      checkpoint,
      columns: ["path", "size", "mtimeMs", "ino"]
    };
    const body = [
      JSON.stringify(header),
      ...manifest.rows.map((row) => JSON.stringify([row.path, row.size, row.mtimeMs, row.ino]))
    ].join("\n");
    const packed = gzipSync(Buffer.from(body), { level: 6 });

    const at = Date.parse(manifest.at);
    const destination = join(folder, `${at}${CAPTURE_SUFFIX}`);
    // Written aside and renamed, so a capture interrupted halfway leaves the
    // previous timeline intact rather than a truncated file that gunzips to
    // half a folder.
    const staging = `${destination}.writing`;
    await writeFile(staging, packed);
    await rename(staging, destination);

    const capture: StoredCapture = { at, bytes: packed.byteLength, checkpoint };
    await this.rewriteIndex(manifest.root, [
      ...(await this.list(manifest.root)).filter((existing) => existing.at !== at),
      capture
    ]);
    return capture;
  }

  /** Every capture held for a root, newest first. */
  async list(root: string): Promise<readonly StoredCapture[]> {
    const folder = this.folderFor(root);
    const fromIndex = await this.readIndex(folder);
    if (fromIndex !== null) {
      return fromIndex;
    }
    const rebuilt = await this.rebuildIndex(folder);
    await this.rewriteIndex(root, rebuilt);
    return rebuilt;
  }

  /** Reads one capture back. */
  async read(root: string, at: number): Promise<StoredManifest | null> {
    const file = join(this.folderFor(root), `${at}${CAPTURE_SUFFIX}`);
    const packed = await readFile(file).catch(() => null);
    if (packed === null) {
      return null;
    }
    return decode(packed);
  }

  /** The most recent capture, which is what a new one is diffed against. */
  async newest(root: string): Promise<StoredManifest | null> {
    const captures = await this.list(root);
    const first = captures[0];
    return first === undefined ? null : this.read(root, first.at);
  }

  /**
   * Applies the retention policy and deletes what it drops.
   *
   * Deletion failures are logged and swallowed: a file that will not delete is
   * a reason to keep going and try again next time, not a reason to fail the
   * capture that triggered the prune.
   */
  async prune(root: string, now = Date.now()): Promise<RetentionPlan> {
    const plan = thin(await this.list(root), now);
    if (plan.drop.length === 0) {
      return plan;
    }

    const folder = this.folderFor(root);
    for (const capture of plan.drop) {
      await rm(join(folder, `${capture.at}${CAPTURE_SUFFIX}`), { force: true }).catch((error) => {
        diagnostics.warn("timeline", "could not delete a thinned capture", {
          at: capture.at,
          error: error instanceof Error ? error.message : "unknown"
        });
      });
    }
    await this.rewriteIndex(root, plan.keep);

    diagnostics.info("timeline", "thinned the record", {
      kept: plan.keep.length,
      dropped: plan.drop.length,
      bytes: totalBytes(plan.keep),
      hitCeiling: plan.hitCeiling
    });
    return plan;
  }

  /** Forgets a root entirely. Used when a grant is revoked. */
  async forget(root: string): Promise<void> {
    await rm(this.folderFor(root), { recursive: true, force: true });
  }

  /**
   * A root's directory name.
   *
   * SHA-256 of the absolute path, truncated to 32 hex characters. Not a secret
   * and not pretending to be one — it is a stable name that does not spell out
   * a client's folder to anyone listing Application Support.
   */
  private folderFor(root: string): string {
    return join(this.directory, createHash("sha256").update(root).digest("hex").slice(0, 32));
  }

  private async readIndex(folder: string): Promise<readonly StoredCapture[] | null> {
    const raw = await readFile(join(folder, INDEX_FILE), "utf8").catch(() => null);
    if (raw === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return null;
      }
      return parsed
        .filter(
          (entry): entry is StoredCapture =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as StoredCapture).at === "number" &&
            typeof (entry as StoredCapture).bytes === "number"
        )
        .sort((left, right) => right.at - left.at);
    } catch {
      // Unparseable is the same as missing: rebuild rather than lose the record.
      return null;
    }
  }

  /** Reads the directory itself, which is the actual truth. */
  private async rebuildIndex(folder: string): Promise<readonly StoredCapture[]> {
    const names = await readdir(folder).catch(() => [] as string[]);
    const captures: StoredCapture[] = [];

    for (const name of names) {
      if (!name.endsWith(CAPTURE_SUFFIX)) {
        continue;
      }
      const at = Number(name.slice(0, -CAPTURE_SUFFIX.length));
      if (!Number.isFinite(at)) {
        continue;
      }
      const file = join(folder, name);
      const info = await stat(file).catch(() => null);
      if (info === null) {
        continue;
      }
      // The checkpoint lives in the capture's own header, so a rebuilt index
      // cannot forget that someone named this moment.
      const decoded = await readFile(file)
        .then((packed) => decode(packed))
        .catch(() => null);
      captures.push({ at, bytes: info.size, checkpoint: decoded?.checkpoint ?? null });
    }

    return captures.sort((left, right) => right.at - left.at);
  }

  private async rewriteIndex(root: string, captures: readonly StoredCapture[]): Promise<void> {
    const folder = this.folderFor(root);
    const ordered = [...captures].sort((left, right) => right.at - left.at);
    const destination = join(folder, INDEX_FILE);
    const staging = `${destination}.writing`;
    await mkdir(folder, { recursive: true });
    await writeFile(staging, JSON.stringify(ordered));
    await rename(staging, destination);
  }
}

/** Turns a stored capture back into a manifest. */
function decode(packed: Buffer): StoredManifest | null {
  const text = gunzipSync(packed).toString("utf8");
  const newline = text.indexOf("\n");
  const headerText = newline === -1 ? text : text.slice(0, newline);

  let header: CaptureHeader;
  try {
    header = JSON.parse(headerText) as CaptureHeader;
  } catch {
    return null;
  }
  if (header.format !== FORMAT) {
    // A capture from a format this build does not understand is skipped rather
    // than guessed at. Guessing would produce a diff, and a wrong diff about
    // someone's folder is worse than an absent one.
    diagnostics.warn("timeline", "skipped a capture from another format", {
      format: header.format
    });
    return null;
  }

  const rows: ManifestRow[] = [];
  if (newline !== -1) {
    for (const line of text.slice(newline + 1).split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        const [path, size, mtimeMs, ino] = JSON.parse(line) as [string, number, number, number];
        rows.push({ path, size, mtimeMs, ino });
      } catch {
        continue;
      }
    }
  }

  return {
    manifest: { root: header.root, at: header.at, rows, truncated: header.truncated },
    checkpoint: header.checkpoint
  };
}
