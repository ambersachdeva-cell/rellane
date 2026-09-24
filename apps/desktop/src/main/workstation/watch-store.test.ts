import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { forgetSeen, lastSeen, loadWatches, remember, saveWatches } from "./watch-store.js";
import type { Watch } from "./watch-plan.js";

let folder: string;

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "watch-store-"));
});

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

const aWatch: Watch = {
  id: "watch-one",
  target: { kind: "page", url: "https://example.com/prices", label: "Prices" },
  cadence: "daily",
  tellMeWhen: "numbers-change",
  quietHours: true,
  lastCheckedAt: null,
  lastChangedAt: null,
  paused: false
};

describe("watch-store", () => {
  it("returns no watches for a Mac that has never been asked to watch anything", async () => {
    expect(await loadWatches(folder)).toEqual([]);
  });

  it("saves and reads back a watch", async () => {
    await saveWatches(folder, [aWatch]);
    const loaded = await loadWatches(folder);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.target.label).toBe("Prices");
  });

  it("keeps what each watch last saw apart from the others", async () => {
    await remember(folder, "watch-one", "first page text");
    await remember(folder, "watch-two", "second page text");

    expect(await lastSeen(folder, "watch-one")).toBe("first page text");
    expect(await lastSeen(folder, "watch-two")).toBe("second page text");
    expect(await lastSeen(folder, "watch-three")).toBeNull();
  });

  it("forgets what a removed watch saw", async () => {
    await remember(folder, "watch-one", "text");
    await forgetSeen(folder, "watch-one");
    expect(await lastSeen(folder, "watch-one")).toBeNull();
  });

  it("refuses a watch id that is not an id rather than building a path from it", async () => {
    await remember(folder, "../escape", "should not be written");
    expect(await lastSeen(folder, "../escape")).toBeNull();
    const seenFolder = path.join(folder, "seen");
    const written = await fs.readdir(seenFolder).catch(() => []);
    expect(written).toHaveLength(0);
  });

  it("treats a corrupt list as no watches rather than throwing on open", async () => {
    await fs.writeFile(path.join(folder, "watches.json"), "{not json", "utf8");
    expect(await loadWatches(folder)).toEqual([]);
  });
});
