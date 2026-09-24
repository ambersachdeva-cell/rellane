import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestStore } from "./manifest-store.js";
import type { Manifest } from "./manifest.js";

let base: string;
let store: ManifestStore;

const ROOT = "/Users/someone/Clients/Sharma Printers — GST disputes";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-store-test-"));
  store = new ManifestStore(base);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function manifest(at: string, paths: readonly string[], truncated = false): Manifest {
  return {
    root: ROOT,
    at,
    truncated,
    rows: paths.map((path, index) => ({
      path,
      size: 100 + index,
      mtimeMs: 1_000 + index,
      ino: index + 1
    }))
  };
}

describe("storing captures", () => {
  it("writes one and reads it back unchanged", async () => {
    const original = manifest("2026-08-30T09:00:00.000Z", ["a.txt", "2026/quote.pdf"]);

    const stored = await store.write(original);
    const back = await store.read(ROOT, stored.at);

    expect(back?.manifest.rows).toEqual(original.rows);
    expect(back?.manifest.root).toBe(ROOT);
    expect(back?.manifest.truncated).toBe(false);
  });

  it("reports the compressed size, which is what the ceiling counts", async () => {
    const stored = await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));

    expect(stored.bytes).toBeGreaterThan(0);
    const folder = (await readdir(base))[0] as string;
    const onDisk = await readFile(join(base, folder, `${stored.at}.mfst.gz`));
    expect(stored.bytes).toBe(onDisk.byteLength);
  });

  it("does not spell the folder's name out on disk", async () => {
    // A directory called "Sharma Printers — GST disputes" should not be legible
    // to anything that can list Application Support.
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));

    const names = await readdir(base);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{32}$/u);
    expect(names[0]).not.toContain("Sharma");
  });

  it("keeps a checkpoint's reason with the capture", async () => {
    const stored = await store.write(
      manifest("2026-08-30T09:00:00.000Z", ["a.txt"]),
      "before the GST filing"
    );

    expect((await store.read(ROOT, stored.at))?.checkpoint).toBe("before the GST filing");
    expect((await store.list(ROOT))[0]?.checkpoint).toBe("before the GST filing");
  });

  it("lists captures newest first", async () => {
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));
    await store.write(manifest("2026-08-30T11:00:00.000Z", ["a.txt", "b.txt"]));
    await store.write(manifest("2026-08-30T10:00:00.000Z", ["a.txt"]));

    const listed = await store.list(ROOT);

    expect(listed.map((c) => new Date(c.at).toISOString())).toEqual([
      "2026-08-30T11:00:00.000Z",
      "2026-08-30T10:00:00.000Z",
      "2026-08-30T09:00:00.000Z"
    ]);
  });

  it("returns the newest capture, which is what a new one is diffed against", async () => {
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));
    await store.write(manifest("2026-08-30T11:00:00.000Z", ["a.txt", "b.txt"]));

    expect((await store.newest(ROOT))?.manifest.rows).toHaveLength(2);
  });

  it("says nothing rather than guessing when a root has no captures", async () => {
    expect(await store.newest(ROOT)).toBeNull();
    expect(await store.list(ROOT)).toEqual([]);
    expect(await store.read(ROOT, 123)).toBeNull();
  });

  it("carries a truncated capture's truncation through storage", async () => {
    // A truncated manifest read back as complete would report every unwalked
    // file as a mass deletion the next time it was diffed.
    const stored = await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"], true));

    expect((await store.read(ROOT, stored.at))?.manifest.truncated).toBe(true);
  });

  it("survives ten thousand rows", async () => {
    const paths = Array.from({ length: 10_000 }, (_, n) => `d${Math.floor(n / 250)}/file-${n}.bin`);
    const stored = await store.write(manifest("2026-08-30T09:00:00.000Z", paths));

    expect((await store.read(ROOT, stored.at))?.manifest.rows).toHaveLength(10_000);
    // The compression claim the recut argued from, asserted rather than quoted.
    expect(stored.bytes).toBeLessThan(400_000);
  });
});

describe("when the index is wrong", () => {
  it("rebuilds it from the directory rather than losing the record", async () => {
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]), "before the audit");
    await store.write(manifest("2026-08-30T10:00:00.000Z", ["a.txt", "b.txt"]));
    const folder = join(base, (await readdir(base))[0] as string);

    await writeFile(join(folder, "index.json"), "{ this is not json");
    const listed = await store.list(ROOT);

    expect(listed).toHaveLength(2);
    // And the checkpoint survives, because it lives in the capture's own
    // header rather than only in the index.
    expect(listed.find((c) => c.checkpoint !== null)?.checkpoint).toBe("before the audit");
  });

  it("rebuilds it when it is missing entirely", async () => {
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));
    const folder = join(base, (await readdir(base))[0] as string);
    await rm(join(folder, "index.json"));

    expect(await store.list(ROOT)).toHaveLength(1);
  });

  it("ignores files that are not captures", async () => {
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));
    const folder = join(base, (await readdir(base))[0] as string);
    await rm(join(folder, "index.json"));
    await writeFile(join(folder, "notes.txt"), "stray");
    await writeFile(join(folder, "9999.mfst.gz.writing"), "interrupted");

    expect(await store.list(ROOT)).toHaveLength(1);
  });
});

describe("pruning", () => {
  it("deletes what retention drops, and says what it kept", async () => {
    const hour = 3_600_000;
    const now = Date.parse("2026-08-30T12:00:00.000Z");
    // Six captures inside one hour, six hours ago: the hourly tier keeps one.
    for (let n = 0; n < 6; n += 1) {
      await store.write(manifest(new Date(now - 6 * hour + n * 60_000).toISOString(), ["a.txt"]));
    }
    await store.write(manifest(new Date(now - 60_000).toISOString(), ["a.txt"]));

    const plan = await store.prune(ROOT, now);

    expect(plan.drop).toHaveLength(5);
    expect(await store.list(ROOT)).toHaveLength(2);

    const folder = join(base, (await readdir(base))[0] as string);
    const remaining = (await readdir(folder)).filter((name) => name.endsWith(".mfst.gz"));
    expect(remaining).toHaveLength(2);
  });

  it("leaves a young timeline alone", async () => {
    const now = Date.parse("2026-08-30T12:00:00.000Z");
    await store.write(manifest(new Date(now - 60_000).toISOString(), ["a.txt"]));

    const plan = await store.prune(ROOT, now);

    expect(plan.drop).toHaveLength(0);
    expect(plan.hitCeiling).toBe(false);
  });

  it("forgets a root completely when its grant is revoked", async () => {
    await store.write(manifest("2026-08-30T09:00:00.000Z", ["a.txt"]));

    await store.forget(ROOT);

    expect(await readdir(base)).toEqual([]);
    expect(await store.list(ROOT)).toEqual([]);
  });
});
