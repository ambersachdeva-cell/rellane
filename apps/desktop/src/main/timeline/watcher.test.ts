import { mkdtemp, mkdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestStore } from "./manifest-store.js";
import { FolderWatcher, canUsePolling, type WatchTiming } from "./watcher.js";

/**
 * Short enough that the suite stays inside the budget a shared CI runner can
 * meet, long enough that FSEvents — which is not instant — reliably delivers.
 */
const FAST: WatchTiming = { quietMs: 120, maxWaitMs: 2_000, minGapMs: 0 };

let base: string;
let store: ManifestStore;
let watcher: FolderWatcher;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-watch-test-"));
  store = new ManifestStore(join(base, "store"));
  await mkdir(join(base, "granted"));
});

afterEach(async () => {
  watcher?.stopAll();
  await rm(base, { recursive: true, force: true });
});

const granted = () => join(base, "granted");

/** Waits until `check` holds, or gives up. Polling beats a fixed sleep here. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const captureCount = async () => (await store.list(granted())).length;

describe("watching a granted folder", () => {
  it("captures a baseline the moment it starts", async () => {
    await writeFile(join(granted(), "a.txt"), "one");
    watcher = new FolderWatcher(store, FAST);

    await watcher.start(granted());

    // Without this baseline the first change would have nothing to be
    // compared against, and the timeline would open by claiming the folder had
    // just been created.
    expect(await captureCount()).toBe(1);
    expect((await store.newest(granted()))?.manifest.rows).toHaveLength(1);
  });

  /** W1.2's done-when, as written. */
  it("turns a burst of 50 files into one capture, not 50", async () => {
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());
    const baseline = await captureCount();

    for (let n = 0; n < 50; n += 1) {
      await writeFile(join(granted(), `file-${n}.txt`), `contents ${n}`);
    }

    const settled = await until(async () => (await captureCount()) > baseline);
    expect(settled).toBe(true);

    // Let any further captures the burst might have triggered arrive before
    // asserting there were none.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(await captureCount()).toBe(baseline + 1);
    expect((await store.newest(granted()))?.manifest.rows).toHaveLength(50);
  });

  it("does not store a capture when nothing a manifest can see changed", async () => {
    // FSEvents reports plenty that leaves a manifest identical. Storing those
    // would spend the retention ceiling on captures that say nothing.
    await writeFile(join(granted(), "a.txt"), "one");
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());
    const baseline = await captureCount();

    const when = new Date(1_700_000_000_000);
    await utimes(join(granted(), "a.txt"), when, when);
    await utimes(join(granted(), "a.txt"), when, when);

    await new Promise((resolve) => setTimeout(resolve, 600));

    const after = await captureCount();
    // One capture is permitted — the first utimes genuinely changed the mtime.
    // What must not happen is a capture per event.
    expect(after).toBeLessThanOrEqual(baseline + 1);
  });

  it("captures a deletion", async () => {
    await writeFile(join(granted(), "gone.txt"), "bye");
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());

    await unlink(join(granted(), "gone.txt"));

    const emptied = await until(async () => {
      const newest = await store.newest(granted());
      return newest !== null && newest.manifest.rows.length === 0;
    });
    expect(emptied).toBe(true);
  });

  it("stops watching without losing what it already captured", async () => {
    await writeFile(join(granted(), "a.txt"), "one");
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());
    const before = await captureCount();

    watcher.stop(granted());
    await writeFile(join(granted(), "b.txt"), "two");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(watcher.watching()).toEqual([]);
    expect(await captureCount()).toBe(before);
  });

  it("starting twice watches once", async () => {
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());
    await watcher.start(granted());

    expect(watcher.watching()).toHaveLength(1);
  });

  it("reports a folder it cannot watch instead of failing to start", async () => {
    watcher = new FolderWatcher(store, FAST);

    await expect(watcher.start(join(base, "not-there"))).resolves.toBeUndefined();

    expect(watcher.watching()).toEqual([]);
  });

  it("tells the caller when a capture landed", async () => {
    const seen: string[] = [];
    watcher = new FolderWatcher(store, FAST, { onCaptured: (root) => seen.push(root) });

    await watcher.start(granted());

    expect(seen).toEqual([granted()]);
  });
});

describe("when native notifications fail", () => {
  it("allows capacity fallback but never retries a permission withdrawal", () => {
    expect(canUsePolling({ code: "EMFILE" })).toBe(true);
    expect(canUsePolling({ code: "ENOSYS" })).toBe(true);
    expect(canUsePolling({ code: "EACCES" })).toBe(false);
    expect(canUsePolling({ code: "EPERM" })).toBe(false);
    expect(canUsePolling({ code: "ENOENT" })).toBe(false);
  });
  it("does not commit an in-flight capture after its folder is withdrawn", async () => {
    await writeFile(join(granted(), "private.txt"), "private");
    watcher = new FolderWatcher(store, FAST);
    const original = store.newest.bind(store);
    let reachedStore = false;
    store.newest = async root => { reachedStore = true; watcher.stop(root); return original(root); };
    await watcher.start(granted());
    expect(reachedStore).toBe(true);
    expect(watcher.watching()).toEqual([]);
    expect(await captureCount()).toBe(0);
  });
});

describe("named checkpoints", () => {
  it("stores one with the reason a person gave", async () => {
    await writeFile(join(granted(), "ledger.xlsx"), "rows");
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());

    const at = await watcher.checkpoint(granted(), "before the GST filing");

    expect((await store.read(granted(), at))?.checkpoint).toBe("before the GST filing");
  });

  it("stores one even when nothing has changed since the last capture", async () => {
    // A person who asked for a checkpoint is entitled to have one. "Nothing had
    // changed" is not a reason to refuse them a marker they will look for later.
    await writeFile(join(granted(), "a.txt"), "one");
    watcher = new FolderWatcher(store, FAST);
    await watcher.start(granted());
    const before = await captureCount();

    await watcher.checkpoint(granted(), "before the audit");

    expect(await captureCount()).toBe(before + 1);
  });
});
