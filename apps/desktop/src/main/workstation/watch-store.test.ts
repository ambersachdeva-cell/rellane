import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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

  it("refuses invalid watch id on lastSeen, remember, and forgetSeen rather than pretending success", async () => {
    const invalidId = "../escape";
    await expect(remember(folder, invalidId, "should not be written")).rejects.toThrow("Invalid watchId");
    await expect(lastSeen(folder, invalidId)).rejects.toThrow("Invalid watchId");
    await expect(forgetSeen(folder, invalidId)).rejects.toThrow("Invalid watchId");

    const seenFolder = path.join(folder, "seen");
    const written = await fs.readdir(seenFolder).catch(() => []);
    expect(written).toHaveLength(0);
  });

  it("throws bounded error and preserves bytes on malformed JSON", async () => {
    const watchesFile = path.join(folder, "watches.json");
    const malformed = "{not json";
    await fs.writeFile(watchesFile, malformed, "utf8");

    await expect(loadWatches(folder)).rejects.toThrow("Failed to parse watches");
    expect(await fs.readFile(watchesFile, "utf8")).toBe(malformed);
  });

  it("throws bounded error and preserves bytes when JSON is not an array", async () => {
    const watchesFile = path.join(folder, "watches.json");
    const notAnArray = JSON.stringify({ id: "watch-one" });
    await fs.writeFile(watchesFile, notAnArray, "utf8");

    await expect(loadWatches(folder)).rejects.toThrow("expected an array");
    expect(await fs.readFile(watchesFile, "utf8")).toBe(notAnArray);
  });

  it("throws bounded error and preserves bytes when an item has invalid shape", async () => {
    const watchesFile = path.join(folder, "watches.json");
    const invalidWatches = [
      aWatch,
      {
        id: "watch-bad",
        target: { kind: "unknown-kind", label: "Bad" },
        cadence: "daily",
        tellMeWhen: "numbers-change",
        quietHours: true,
        lastCheckedAt: null,
        lastChangedAt: null,
        paused: false,
      },
    ];
    const raw = JSON.stringify(invalidWatches);
    await fs.writeFile(watchesFile, raw, "utf8");

    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 1");
    expect(await fs.readFile(watchesFile, "utf8")).toBe(raw);
  });

  it("rejects watches with invalid cadence, tellMeWhen, or target properties", async () => {
    const watchesFile = path.join(folder, "watches.json");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, cadence: "monthly" }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, tellMeWhen: "invalid" }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(
      watchesFile,
      JSON.stringify([{ ...aWatch, target: { kind: "folder", label: "Folder without path" } }]),
      "utf8",
    );
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");
  });

  it("distinguishes missing watches.json from unreadable watches.json and preserves bytes", async () => {
    expect(await loadWatches(folder)).toEqual([]);

    const watchesFile = path.join(folder, "watches.json");
    await fs.writeFile(watchesFile, JSON.stringify([aWatch]), "utf8");

    const error = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const spy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);

    await expect(loadWatches(folder)).rejects.toThrow("Failed to read watches");
    spy.mockRestore();

    const loaded = await loadWatches(folder);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("watch-one");
  });

  it("distinguishes missing seen file from unreadable seen file", async () => {
    expect(await lastSeen(folder, "watch-one")).toBeNull();

    await remember(folder, "watch-one", "baseline text");

    const error = Object.assign(new Error("I/O error"), { code: "EIO" });
    const spy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);

    await expect(lastSeen(folder, "watch-one")).rejects.toThrow("Failed to read last seen for watch");
    spy.mockRestore();

    expect(await lastSeen(folder, "watch-one")).toBe("baseline text");
  });

  it("cleans up owned temp file on rename failure and propagates error", async () => {
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Simulated rename failure"));

    await expect(saveWatches(folder, [aWatch])).rejects.toThrow("Simulated rename failure");
    renameSpy.mockRestore();

    const entries = await fs.readdir(folder);
    const tempFiles = entries.filter((name) => name.endsWith(".tmp"));
    expect(tempFiles).toEqual([]);
  });

  it("cleans up owned temp file on file sync failure and propagates error", async () => {
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (targetPath, flags, mode) => {
      const handle = await originalOpen(targetPath, flags, mode);
      if (typeof targetPath === "string" && targetPath.includes(".tmp")) {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("File sync failed"));
      }
      return handle;
    });

    try {
      await expect(saveWatches(folder, [aWatch])).rejects.toThrow("File sync failed");
    } finally {
      openSpy.mockRestore();
    }

    const entries = await fs.readdir(folder);
    const tempFiles = entries.filter((name) => name.endsWith(".tmp"));
    expect(tempFiles).toEqual([]);
  });

  it("reports directory sync failure documenting uncertain durability without claiming rollback", async () => {
    const originalOpen = fs.open;
    const sensitiveError = "SECRET_PATH_OR_TOKEN";
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (targetPath, flags, mode) => {
      const handle = await originalOpen(targetPath, flags, mode);
      if (typeof targetPath === "string" && targetPath === folder && flags === "r") {
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error(sensitiveError));
      }
      return handle;
    });

    try {
      await expect(saveWatches(folder, [aWatch])).rejects.toThrowError(
        new Error("Directory sync failed; durability is uncertain"),
      );
    } finally {
      openSpy.mockRestore();
    }

    const written = await fs.readFile(path.join(folder, "watches.json"), "utf8");
    expect(JSON.parse(written)).toEqual([aWatch]);
  });

  it("preserves saved store bytes when invalid or duplicate payload is supplied to saveWatches", async () => {
    await saveWatches(folder, [aWatch]);
    const watchesFile = path.join(folder, "watches.json");
    const originalBytes = await fs.readFile(watchesFile, "utf8");

    const invalidWatch = { ...aWatch, id: "../bad-id" };
    await expect(saveWatches(folder, [invalidWatch])).rejects.toThrow("Invalid watch at index 0");
    expect(await fs.readFile(watchesFile, "utf8")).toBe(originalBytes);

    await expect(saveWatches(folder, [aWatch, aWatch])).rejects.toThrow("Duplicate watch ID");
    expect(await fs.readFile(watchesFile, "utf8")).toBe(originalBytes);

    await expect(saveWatches(folder, null as unknown as readonly Watch[])).rejects.toThrow("expected an array");
    expect(await fs.readFile(watchesFile, "utf8")).toBe(originalBytes);
  });

  it("validates input before creating directory in saveWatches and remember", async () => {
    const nonExistentDir = path.join(folder, "non-existent-store");

    const invalidWatch = { ...aWatch, id: "invalid id with spaces" };
    await expect(saveWatches(nonExistentDir, [invalidWatch])).rejects.toThrow("Invalid watch at index 0");
    expect(await fs.stat(nonExistentDir).then(() => true, () => false)).toBe(false);

    await expect(saveWatches(nonExistentDir, [aWatch, aWatch])).rejects.toThrow("Duplicate watch ID");
    expect(await fs.stat(nonExistentDir).then(() => true, () => false)).toBe(false);

    await expect(remember(nonExistentDir, "../bad-id", "data")).rejects.toThrow("Invalid watchId");
    expect(await fs.stat(nonExistentDir).then(() => true, () => false)).toBe(false);
  });

  it("returns generic error message without leaking secret content or file paths", async () => {
    const secret = "SUPER_SECRET_TOKEN_DO_NOT_REVEAL";
    const malformed = `{"secret": "${secret}", broken json`;
    const watchesFile = path.join(folder, "watches.json");
    await fs.writeFile(watchesFile, malformed, "utf8");

    let parseError: Error | null = null;
    try {
      await loadWatches(folder);
    } catch (error) {
      parseError = error as Error;
    }

    expect(parseError).not.toBeNull();
    expect(parseError!.message).toBe("Failed to parse watches store: invalid JSON");
    expect(parseError!.message).not.toContain(secret);
    expect(parseError!.message).not.toContain(folder);
    expect(parseError!.message).not.toContain("watches.json");
  });

  it("returns generic message on named deterministic EIO read failure for loadWatches and lastSeen", async () => {
    const watchesFile = path.join(folder, "watches.json");
    await fs.writeFile(watchesFile, JSON.stringify([aWatch]), "utf8");

    const eioError = Object.assign(new Error("Disk hardware failure"), { code: "EIO" });
    const spy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eioError);

    let loadError: Error | null = null;
    try {
      await loadWatches(folder);
    } catch (error) {
      loadError = error as Error;
    }

    expect(loadError).not.toBeNull();
    expect(loadError!.message).toBe("Failed to read watches store");
    expect(loadError!.message).not.toContain("Disk hardware failure");
    expect(loadError!.message).not.toContain(folder);
    spy.mockRestore();

    await remember(folder, "watch-one", "baseline text");
    const seenSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(eioError);

    let seenError: Error | null = null;
    try {
      await lastSeen(folder, "watch-one");
    } catch (error) {
      seenError = error as Error;
    }

    expect(seenError).not.toBeNull();
    expect(seenError!.message).toBe("Failed to read last seen for watch");
    expect(seenError!.message).not.toContain("Disk hardware failure");
    expect(seenError!.message).not.toContain("watch-one");
    expect(seenError!.message).not.toContain(folder);
    seenSpy.mockRestore();
  });

  it("rejects watch ID violating SAFE_ID in isWatch", async () => {
    const watchesFile = path.join(folder, "watches.json");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, id: "" }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, id: "has space" }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, id: "a".repeat(81) }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");
  });

  it("requires label, url, path, and routineId to be non-empty trimmed strings without changing original bytes", async () => {
    const watchesFile = path.join(folder, "watches.json");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, target: { ...aWatch.target, label: "" } }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, target: { ...aWatch.target, label: "   " } }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(
      watchesFile,
      JSON.stringify([{ ...aWatch, target: { kind: "page", label: "Valid", url: "   " } }]),
      "utf8",
    );
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(
      watchesFile,
      JSON.stringify([{ ...aWatch, target: { kind: "folder", label: "Valid", path: "   " } }]),
      "utf8",
    );
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(
      watchesFile,
      JSON.stringify([{ ...aWatch, target: { kind: "routine", label: "Valid", routineId: "   " } }]),
      "utf8",
    );
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    const routineWatch: Watch = {
      ...aWatch,
      id: "routine-watch",
      target: { kind: "routine", label: " Routine with spaces ", routineId: " routine-123 " },
    };
    await saveWatches(folder, [routineWatch]);
    const loaded = await loadWatches(folder);
    expect(loaded[0]?.target).toEqual({
      kind: "routine",
      label: " Routine with spaces ",
      routineId: " routine-123 ",
    });
  });

  it("requires timestamps to be finite nonnegative numbers or null", async () => {
    const watchesFile = path.join(folder, "watches.json");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, lastCheckedAt: -1 }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    await fs.writeFile(watchesFile, JSON.stringify([{ ...aWatch, lastChangedAt: -50 }]), "utf8");
    await expect(loadWatches(folder)).rejects.toThrow("Invalid watch at index 0");

    const zeroWatch: Watch = { ...aWatch, id: "zero-watch", lastCheckedAt: 0, lastChangedAt: 0 };
    await saveWatches(folder, [zeroWatch]);
    const loaded = await loadWatches(folder);
    expect(loaded[0]?.lastCheckedAt).toBe(0);
    expect(loaded[0]?.lastChangedAt).toBe(0);
  });

  it("rejects duplicate watch IDs in loadWatches", async () => {
    const watchesFile = path.join(folder, "watches.json");
    const duplicatePayload = [aWatch, { ...aWatch, target: { kind: "page", url: "https://example.com/2", label: "Two" } }];
    await fs.writeFile(watchesFile, JSON.stringify(duplicatePayload), "utf8");

    await expect(loadWatches(folder)).rejects.toThrow("Duplicate watch ID");
  });

  it("preserves exact UTF-8 content across roundtrip", async () => {
    const unicodeWatch: Watch = {
      id: "watch-unicode-1",
      target: {
        kind: "page",
        url: "https://example.com/spécial?q=日本語#標籤",
        label: "Über Prîcë 🚀 €50 → ₹4,500",
      },
      cadence: "hourly",
      tellMeWhen: "numbers-change",
      quietHours: false,
      lastCheckedAt: 1700000000000,
      lastChangedAt: 1700000500000,
      paused: true,
    };

    await saveWatches(folder, [unicodeWatch]);
    const loaded = await loadWatches(folder);
    expect(loaded).toEqual([unicodeWatch]);

    const unicodeSeen = "Unicode payload: 測試 ☕️ 𝄞 \n Emojis: 🌟🎉 and symbols £ € ₹";
    await remember(folder, "watch-unicode-1", unicodeSeen);
    const seenBack = await lastSeen(folder, "watch-unicode-1");
    expect(seenBack).toBe(unicodeSeen);
  });

  it("prevents torn concurrent saves at singlefile boundary", async () => {
    const watchA: Watch = { ...aWatch, id: "watch-a" };
    const watchB: Watch = { ...aWatch, id: "watch-b" };

    await Promise.all([
      saveWatches(folder, [watchA]),
      saveWatches(folder, [watchB]),
    ]);

    const loaded = await loadWatches(folder);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id === "watch-a" || loaded[0]?.id === "watch-b").toBe(true);
  });
});
