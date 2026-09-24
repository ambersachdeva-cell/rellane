import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestStore } from "./manifest-store.js";
import { FolderWatcher } from "./watcher.js";
import { MAX_LISTED_CHANGES, TimelineService, describeDiff } from "./timeline-service.js";
import { createSandbox } from "../tools/sandbox.js";
import type { ManifestDiff } from "./manifest.js";

let base: string;
let granted: string;
let store: ManifestStore;
let watcher: FolderWatcher;
let service: TimelineService;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-tlsvc-test-"));
  granted = join(base, "Clients");
  await mkdir(granted);
  store = new ManifestStore(join(base, "store"));
  watcher = new FolderWatcher(store, { quietMs: 50, maxWaitMs: 500, minGapMs: 0 });
  const sandbox = await createSandbox([granted]);
  service = new TimelineService(store, watcher, () => sandbox);
});

afterEach(async () => {
  watcher.stopAll();
  await rm(base, { recursive: true, force: true });
});

describe("what the timeline offers the screen", () => {
  it("lists captures newest first, with their file counts", async () => {
    await writeFile(join(granted, "a.txt"), "one");
    await watcher.checkpoint(granted, "first");
    await writeFile(join(granted, "b.txt"), "two");
    await watcher.checkpoint(granted, "second");

    const captures = await service.captures(granted);

    expect(captures).toHaveLength(2);
    expect(captures[0]?.checkpoint).toBe("second");
    expect(captures[0]?.files).toBe(2);
    expect(captures[1]?.files).toBe(1);
  });

  it("answers what changed since a moment", async () => {
    await writeFile(join(granted, "quote.pdf"), "x".repeat(100));
    const before = await service.checkpoint(granted, "before filing");

    await mkdir(join(granted, "2026"));
    await rename(join(granted, "quote.pdf"), join(granted, "2026", "quote.pdf"));
    await writeFile(join(granted, "new.txt"), "note");
    const after = await service.checkpoint(granted, "after filing");

    const diff = await service.diff(granted, before.at, after.at);

    expect(diff.counts.moved).toBe(1);
    expect(diff.counts.added).toBe(1);
    expect(diff.summary).toBe("1 file filed, 1 file added.");
    expect(diff.changes.find((c) => c.kind === "moved")?.movedTo).toBe("2026/quote.pdf");
  });

  it("says plainly when a moment has been let go rather than returning nothing", async () => {
    await writeFile(join(granted, "a.txt"), "one");
    const only = await service.checkpoint(granted, "only");

    await expect(
      service.diff(granted, "2020-01-01T00:00:00.000Z", only.at)
    ).rejects.toThrow(/no longer held/u);
  });

  it("refuses a folder that was never granted", async () => {
    // Not defending against the UI, which already holds the granted roots, but
    // against every future caller — including a skill passing a path derived
    // from something a model wrote.
    await expect(service.captures("/etc")).rejects.toThrow(/not been granted/u);
    await expect(service.hash("/etc", "passwd")).rejects.toThrow(/not been granted/u);
  });

  it("refuses to hash its way out of the granted folder", async () => {
    await expect(service.hash(granted, "../../../etc/passwd")).rejects.toThrow(/not a path inside/u);
    await expect(service.hash(granted, "/etc/passwd")).rejects.toThrow(/not a path inside/u);
  });

  it.runIf(process.platform === "darwin")("hashes a file that is there", async () => {
    await writeFile(join(granted, "invoice.pdf"), "₹68 per piece");

    const digest = await service.hash(granted, "invoice.pdf");

    expect(digest.problem).toBeNull();
    expect(digest.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.runIf(process.platform === "darwin")("says a file is gone rather than returning a digest of nothing", async () => {
    const digest = await service.hash(granted, "never-existed.pdf");

    expect(digest.digest).toBeNull();
    expect(digest.problem).toBe("That file is not there any more.");
  });

  it("needs a reason before it will mark a moment", async () => {
    // A checkpoint without a reason is a tick nobody can identify a fortnight
    // later, which is exactly when it matters.
    await expect(service.checkpoint(granted, "   ")).rejects.toThrow(/needs a reason/u);
  });

  it("keeps the reason, trimmed", async () => {
    await writeFile(join(granted, "a.txt"), "one");

    const capture = await service.checkpoint(granted, "  before the GST filing  ");

    expect(capture.checkpoint).toBe("before the GST filing");
  });

  it("caps the listed changes while keeping the counts complete", async () => {
    const many = MAX_LISTED_CHANGES + 40;
    const before = await service.checkpoint(granted, "empty");
    for (let n = 0; n < many; n += 1) {
      await writeFile(join(granted, `file-${n}.txt`), `${n}`);
    }
    const after = await service.checkpoint(granted, "full");

    const diff = await service.diff(granted, before.at, after.at);

    // Telling someone "540 files added" and showing 500 rows is honest.
    // Showing 500 rows and letting them assume that is all of it is not.
    expect(diff.counts.added).toBe(many);
    expect(diff.changes).toHaveLength(MAX_LISTED_CHANGES);
    expect(diff.capped).toBe(true);
  });
});

describe("the sentence a diff gets", () => {
  const empty: ManifestDiff = {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    partial: false
  };
  const row = (path: string) => ({ path, size: 1, mtimeMs: 1, ino: 1 });

  it("says nothing changed when nothing did", () => {
    expect(describeDiff(empty)).toBe("Nothing changed.");
  });

  it("counts singulars as singular", () => {
    expect(describeDiff({ ...empty, added: [row("a.txt")] })).toBe("1 file added.");
  });

  it("calls a deletion a deletion", () => {
    // A tool that says "3 files tidied" when it means deleted is one you stop
    // trusting the first time you check.
    expect(describeDiff({ ...empty, removed: [row("a"), row("b")] })).toBe("2 files deleted.");
  });

  it("puts filing first, because that is what the reader is looking for", () => {
    const diff: ManifestDiff = {
      ...empty,
      moved: [{ from: "a", to: "b" }],
      added: [row("c")],
      removed: [row("d")]
    };

    expect(describeDiff(diff)).toBe("1 file filed, 1 file added, 1 file deleted.");
  });

  it("admits when the reading stopped early", () => {
    const diff: ManifestDiff = { ...empty, added: [row("a")], partial: true };

    expect(describeDiff(diff)).toMatch(/there may be more/u);
  });
});
