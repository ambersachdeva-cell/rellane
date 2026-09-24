/**
 * Watching granted folders, without becoming the reason the Mac is slow.
 *
 * `fs.watch(root, { recursive: true })` is FSEvents on macOS, so this needs no
 * dependency — which matters, because the bundle was cut from 9.3 MB to 2.2 MB
 * and a watcher library would have been a third of that back.
 *
 * Three rules keep the cost bounded, and they are separate rules because they
 * fail in different ways:
 *
 *   - **Quiet.** A capture happens once the folder has stopped changing, not
 *     once it starts. Unzipping 50 files is one burst and deserves one capture.
 *   - **A ceiling on waiting.** A folder that never goes quiet — a download in
 *     progress, a build watching itself — would otherwise never be captured at
 *     all, so the wait is capped and a capture happens anyway.
 *   - **A floor between captures.** Even with both of the above, a folder that
 *     changes all day must not be walked all day.
 *
 * And one rule that keeps the *record* honest: a capture that turns out to be
 * identical to the last one is not stored. FSEvents reports plenty that does
 * not change a manifest — an mtime touched and restored, a file written and
 * deleted between two walks — and storing those would fill the retention
 * ceiling with captures that say nothing.
 */

import { watch, type FSWatcher } from "node:fs";
import { captureManifest, diffManifests, isQuiet } from "./manifest.js";
import type { ManifestStore } from "./manifest-store.js";
import { diagnostics } from "../foundations/diagnostics.js";

export interface WatchTiming {
  /** How long a folder must be still before it is captured. */
  readonly quietMs: number;
  /** The longest a busy folder may postpone its capture. */
  readonly maxWaitMs: number;
  /** The shortest gap between two captures of one folder. */
  readonly minGapMs: number;
}

export const DEFAULT_TIMING: WatchTiming = {
  quietMs: 2_000,
  maxWaitMs: 30_000,
  minGapMs: 10_000
};

interface Watched {
  watcher: FSWatcher | null;
  polling: NodeJS.Timeout | null;
  readonly abort: AbortController;
  lastCaptureCostMs: number;
  quiet: NodeJS.Timeout | null;
  /** Set when the first event of a burst arrives; cleared when it is captured. */
  burstStartedAt: number | null;
  lastCapturedAt: number;
  capturing: boolean;
  /** An event arrived while a capture was running; go round again after it. */
  dirty: boolean;
}

export interface WatcherEvents {
  /** Called after a capture is stored. Not called when nothing changed. */
  onCaptured?(root: string, at: number): void;
}

export class FolderWatcher {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly store: ManifestStore,
    private readonly timing: WatchTiming = DEFAULT_TIMING,
    private readonly events: WatcherEvents = {}
  ) {}

  /**
   * Starts watching a granted root, and captures it once immediately.
   *
   * The immediate capture is the baseline every later diff is measured from.
   * Without it the first thing that changes in the folder would have nothing to
   * be compared against, and the timeline would begin by claiming the folder
   * had just been created.
   */
  async start(root: string): Promise<void> {
    if (this.watched.has(root)) {
      return;
    }

    let watcher: FSWatcher | null = null;
    let usePolling = false;
    try {
      watcher = watch(root, { recursive: true, persistent: false });
    } catch (error) {
      if (canUsePolling(error)) usePolling = true;
      else {
        diagnostics.warn("timeline", "could not watch a granted folder", { error: error instanceof Error ? error.message : "unknown" });
        return;
      }
    }

    const entry: Watched = {
      watcher,
      polling: null,
      abort: new AbortController(),
      lastCaptureCostMs: 0,
      quiet: null,
      burstStartedAt: null,
      lastCapturedAt: 0,
      capturing: false,
      dirty: false
    };
    this.watched.set(root, entry);

    watcher?.on("error", (error) => {
      if (this.watched.get(root) !== entry) return;
      if (canUsePolling(error)) {
        entry.watcher?.close();
        entry.watcher = null;
        diagnostics.warn("timeline", "native notifications are unavailable; using paced folder checks");
        this.poll(root, entry);
      } else {
        diagnostics.warn("timeline", "folder notifications stopped; access needs checking", { error: error.message });
        this.stop(root);
      }
    });
    watcher?.on("change", () => this.touched(root));
    if (usePolling) {
      diagnostics.warn("timeline", "native notifications are unavailable; using paced folder checks");
      this.poll(root, entry);
    }

    await this.capture(root);
  }

  /** Stops watching, leaving everything already captured in place. */
  stop(root: string): void {
    const entry = this.watched.get(root);
    if (entry === undefined) {
      return;
    }
    if (entry.quiet !== null) {
      clearTimeout(entry.quiet);
    }
    if (entry.polling !== null) clearTimeout(entry.polling);
    entry.abort.abort();
    entry.watcher?.close();
    this.watched.delete(root);
  }

  stopAll(): void {
    for (const root of [...this.watched.keys()]) {
      this.stop(root);
    }
  }

  watching(): readonly string[] {
    return [...this.watched.keys()];
  }

  /** Notification capacity can be exhausted independently of read permission.
   * Fall back to paced snapshots, with no overlapping walks and a duty budget
   * based on the last capture's cost. Revocation stops both paths. */
  private poll(root: string, entry: Watched): void {
    if (this.watched.get(root) !== entry || entry.polling !== null) return;
    const wait = Math.max(this.timing.maxWaitMs, this.timing.minGapMs, entry.lastCaptureCostMs * 50);
    entry.polling = setTimeout(() => {
      entry.polling = null;
      if (this.watched.get(root) !== entry) return;
      void this.capture(root).finally(() => this.poll(root, entry));
    }, wait);
    entry.polling.unref?.();
  }

  /** An FSEvents notification arrived. Restart the quiet timer. */
  private touched(root: string): void {
    const entry = this.watched.get(root);
    if (entry === undefined) {
      return;
    }
    if (entry.capturing) {
      entry.dirty = true;
      return;
    }

    const now = Date.now();
    entry.burstStartedAt ??= now;

    if (entry.quiet !== null) {
      clearTimeout(entry.quiet);
    }

    // The burst has been going long enough; stop postponing and capture.
    if (now - entry.burstStartedAt >= this.timing.maxWaitMs) {
      void this.capture(root);
      return;
    }

    // Never sooner than the floor allows, even once the folder is quiet.
    const sinceLast = now - entry.lastCapturedAt;
    const wait = Math.max(this.timing.quietMs, this.timing.minGapMs - sinceLast);
    entry.quiet = setTimeout(() => void this.capture(root), wait);
    entry.quiet.unref?.();
  }

  /**
   * Walks the folder, and stores the result only if it differs from the last.
   *
   * Prunes afterwards rather than before, so the capture that pushes the
   * timeline over its ceiling is the one that pays to bring it back under.
   */
  private async capture(root: string): Promise<void> {
    const entry = this.watched.get(root);
    if (entry === undefined || entry.capturing) {
      return;
    }
    entry.capturing = true;
    entry.burstStartedAt = null;
    if (entry.quiet !== null) {
      clearTimeout(entry.quiet);
      entry.quiet = null;
    }

    try {
      const { manifest, tookMs } = await captureManifest(root, Date.now(), entry.abort.signal);
      entry.lastCaptureCostMs = Math.max(1, tookMs);
      if (this.watched.get(root) !== entry) return;
      const previous = await this.store.newest(root);
      if (this.watched.get(root) !== entry) return;

      if (previous !== null && isQuiet(diffManifests(previous.manifest, manifest))) {
        // FSEvents fired but nothing a manifest can see actually changed.
        // Storing this would spend the retention ceiling on a capture that
        // says nothing.
        return;
      }

      const stored = await this.store.write(manifest);
      entry.lastCapturedAt = Date.now();
      await this.store.prune(root);

      diagnostics.info("timeline", "captured a folder", {
        rows: manifest.rows.length,
        truncated: manifest.truncated,
        tookMs,
        bytes: stored.bytes
      });
      this.events.onCaptured?.(root, stored.at);
    } catch (error) {
      if (entry.abort.signal.aborted) return;
      diagnostics.warn("timeline", "a capture failed", {
        error: error instanceof Error ? error.message : "unknown"
      });
    } finally {
      entry.capturing = false;
      if (entry.dirty) {
        entry.dirty = false;
        this.touched(root);
      }
    }
  }

  /**
   * Captures on demand and names the moment — W1.4's checkpoints.
   *
   * Unlike the automatic path this always stores, even when nothing changed: a
   * person who asked for a checkpoint is entitled to have one, and "nothing had
   * changed since the last capture" is not a reason to refuse them a marker
   * they will later look for.
   */
  async checkpoint(root: string, reason: string): Promise<number> {
    const { manifest } = await captureManifest(root);
    const stored = await this.store.write(manifest, reason);
    await this.store.prune(root);
    diagnostics.info("timeline", "named a checkpoint", { rows: manifest.rows.length });
    this.events.onCaptured?.(root, stored.at);
    return stored.at;
  }
}

/** Capacity and unsupported notification backends permit read-only fallback.
 * Permission and path failures do not: polling must never undo a withdrawal. */
export function canUsePolling(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EMFILE" || error.code === "ENFILE" || error.code === "ENOSPC" || error.code === "ENOSYS";
}
