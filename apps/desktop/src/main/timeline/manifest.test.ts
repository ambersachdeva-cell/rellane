import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureManifest,
  diffManifests,
  isQuiet,
  type Manifest,
  type ManifestRow
} from "./manifest.js";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-manifest-test-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A manifest built by hand, for diff tests that should not touch a disk. */
function manifest(rows: readonly Omit<ManifestRow, "ino">[], truncated = false): Manifest {
  return {
    root: "/granted",
    at: "2026-08-30T00:00:00.000Z",
    rows: rows
      .map((row, index) => ({ ...row, ino: index + 1 }))
      .sort((left, right) => (left.path < right.path ? -1 : 1)),
    truncated
  };
}

describe("capturing what is in a folder", () => {
  it("records every file, relative to the root, sorted", async () => {
    await mkdir(join(base, "2026"), { recursive: true });
    await writeFile(join(base, "b.txt"), "two");
    await writeFile(join(base, "a.txt"), "one");
    await writeFile(join(base, "2026", "quote.pdf"), "x".repeat(100));

    const { manifest: captured } = await captureManifest(base);

    expect(captured.rows.map((row) => row.path)).toEqual(["2026/quote.pdf", "a.txt", "b.txt"]);
    expect(captured.truncated).toBe(false);
  });

  it("records size and mtime, because that is what a diff compares", async () => {
    await writeFile(join(base, "invoice.pdf"), "x".repeat(2048));

    const { manifest: captured } = await captureManifest(base);
    const row = captured.rows[0];

    expect(row?.size).toBe(2048);
    expect(row?.mtimeMs).toBeGreaterThan(0);
    expect(row?.ino).toBeGreaterThan(0);
  });

  it("never hands out a path the renderer could replay", async () => {
    await writeFile(join(base, "a.txt"), "one");

    const { manifest: captured } = await captureManifest(base);

    // Relative to the granted root, per DESIGN.md §8. Legible to the person who
    // granted the folder, useless to anything that does not hold the root.
    expect(captured.rows[0]?.path).toBe("a.txt");
    expect(captured.rows[0]?.path).not.toContain(base);
  });

  it("does not follow a symlink out of the granted folder", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cadrane-outside-"));
    await writeFile(join(outside, "secret.txt"), "not yours");
    await symlink(outside, join(base, "escape"));
    await writeFile(join(base, "mine.txt"), "ok");

    const { manifest: captured } = await captureManifest(base);

    expect(captured.rows.map((row) => row.path)).toEqual(["mine.txt"]);
    await rm(outside, { recursive: true, force: true });
  });

  it("skips the folders that churn for reasons nobody asked about", async () => {
    await mkdir(join(base, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(base, "node_modules", "left-pad", "index.js"), "module.exports=1");
    await mkdir(join(base, ".git"), { recursive: true });
    await writeFile(join(base, ".git", "HEAD"), "ref: refs/heads/master");
    await writeFile(join(base, ".DS_Store"), "\0");
    await writeFile(join(base, "real.txt"), "work");

    const { manifest: captured } = await captureManifest(base);

    expect(captured.rows.map((row) => row.path)).toEqual(["real.txt"]);
  });

  it("survives a folder it cannot read rather than failing the whole capture", async () => {
    await writeFile(join(base, "readable.txt"), "fine");
    const locked = join(base, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "inside.txt"), "hidden");
    const { chmod } = await import("node:fs/promises");
    await chmod(locked, 0o000);

    const { manifest: captured } = await captureManifest(base);

    expect(captured.rows.map((row) => row.path)).toContain("readable.txt");
    await chmod(locked, 0o755);
  });
});

describe("diffing two captures", () => {
  it("finds nothing between a folder and itself", () => {
    const one = manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }]);

    expect(isQuiet(diffManifests(one, one))).toBe(true);
  });

  it("reports an added file", () => {
    const diff = diffManifests(
      manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }]),
      manifest([
        { path: "a.txt", size: 3, mtimeMs: 100 },
        { path: "b.txt", size: 5, mtimeMs: 200 }
      ])
    );

    expect(diff.added.map((row) => row.path)).toEqual(["b.txt"]);
    expect(diff.removed).toHaveLength(0);
  });

  it("reports a removed file", () => {
    const diff = diffManifests(
      manifest([
        { path: "a.txt", size: 3, mtimeMs: 100 },
        { path: "b.txt", size: 5, mtimeMs: 200 }
      ]),
      manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }])
    );

    expect(diff.removed.map((row) => row.path)).toEqual(["b.txt"]);
  });

  it("notices an edit that changed the length", () => {
    const diff = diffManifests(
      manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }]),
      manifest([{ path: "a.txt", size: 9, mtimeMs: 100 }])
    );

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.path).toBe("a.txt");
  });

  it("notices an edit that kept the length but moved the clock", () => {
    // Size alone would miss this, which is the ordinary case for a correction.
    const diff = diffManifests(
      manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }]),
      manifest([{ path: "a.txt", size: 3, mtimeMs: 900 }])
    );

    expect(diff.changed).toHaveLength(1);
  });

  it("calls a file that kept its inode a move, not a deletion and a birth", () => {
    // This is the whole reason `ino` is on the row. Without it, every run of a
    // skill whose job is moving files reads as destruction.
    const before: Manifest = {
      root: "/granted",
      at: "2026-08-30T00:00:00.000Z",
      truncated: false,
      rows: [{ path: "quote.pdf", size: 2048, mtimeMs: 100, ino: 77 }]
    };
    const after: Manifest = {
      root: "/granted",
      at: "2026-08-30T00:01:00.000Z",
      truncated: false,
      rows: [{ path: "2026/quote.pdf", size: 2048, mtimeMs: 100, ino: 77 }]
    };

    const diff = diffManifests(before, after);

    expect(diff.moved).toEqual([{ from: "quote.pdf", to: "2026/quote.pdf" }]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("does not call it a move when the inode was reused by a different file", () => {
    // Inodes are recycled after a delete. Reporting this as a move would claim
    // a deleted file still exists, which is the one error worth avoiding here.
    const before: Manifest = {
      root: "/granted",
      at: "2026-08-30T00:00:00.000Z",
      truncated: false,
      rows: [{ path: "old.pdf", size: 2048, mtimeMs: 100, ino: 77 }]
    };
    const after: Manifest = {
      root: "/granted",
      at: "2026-08-30T00:01:00.000Z",
      truncated: false,
      rows: [{ path: "new.txt", size: 12, mtimeMs: 900, ino: 77 }]
    };

    const diff = diffManifests(before, after);

    expect(diff.moved).toHaveLength(0);
    expect(diff.removed.map((row) => row.path)).toEqual(["old.pdf"]);
    expect(diff.added.map((row) => row.path)).toEqual(["new.txt"]);
  });

  it("survives a real move on disk", async () => {
    await writeFile(join(base, "quote.pdf"), "x".repeat(2048));
    const before = (await captureManifest(base)).manifest;

    await mkdir(join(base, "2026"));
    await rename(join(base, "quote.pdf"), join(base, "2026", "quote.pdf"));
    const after = (await captureManifest(base)).manifest;

    const diff = diffManifests(before, after);

    expect(diff.moved).toEqual([{ from: "quote.pdf", to: "2026/quote.pdf" }]);
  });

  it("survives a real delete on disk", async () => {
    await writeFile(join(base, "gone.txt"), "bye");
    const before = (await captureManifest(base)).manifest;

    await unlink(join(base, "gone.txt"));
    const after = (await captureManifest(base)).manifest;

    expect(diffManifests(before, after).removed.map((row) => row.path)).toEqual(["gone.txt"]);
  });

  it("marks the diff partial when either capture hit the row ceiling", () => {
    // A truncated manifest diffed as if it were complete would report every
    // unwalked file as a mass deletion.
    const diff = diffManifests(
      manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }], true),
      manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }])
    );

    expect(diff.partial).toBe(true);
  });

  it("handles one side being empty in both directions", () => {
    const empty = manifest([]);
    const one = manifest([{ path: "a.txt", size: 3, mtimeMs: 100 }]);

    expect(diffManifests(empty, one).added).toHaveLength(1);
    expect(diffManifests(one, empty).removed).toHaveLength(1);
  });
});
