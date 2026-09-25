/**
 * Where watches live between launches, and what each one last saw.
 *
 * Two separate things on purpose. The list of watches is small, is edited from
 * a screen, and is worth rewriting whole. What a page last looked like is up to
 * a quarter of a megabyte each and is rewritten on every check, so each lives
 * in its own file and one large page cannot make saving a watch slow.
 *
 * Written to a temporary name and renamed into place, because the alternative
 * is a half-written list of watches after a crash, which reads as "he had no
 * watches" and would quietly stop watching everything.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Watch, WatchTarget, Cadence } from "./watch-plan.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

const fileWriteQueues = new Map<string, Promise<void>>();

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

async function performWriteAtomic(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target);
  const tempName = `.${path.basename(target)}.${randomBytes(16).toString("hex")}.tmp`;
  const temporary = path.join(dir, tempName);

  let handle: fs.FileHandle | null = null;
  let ownedTempCreated = false;
  let renamed = false;

  try {
    handle = await fs.open(temporary, "wx", 0o600);
    ownedTempCreated = true;

    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await fs.rename(temporary, target);
    ownedTempCreated = false;
    renamed = true;

    let dirHandle: fs.FileHandle | null = null;
    try {
      dirHandle = await fs.open(dir, "r");
      await dirHandle.sync();
    } finally {
      if (dirHandle !== null) {
        await dirHandle.close();
      }
    }
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Ignore secondary error while cleaning file handle.
      }
    }
    if (ownedTempCreated) {
      try {
        await fs.unlink(temporary);
      } catch {
        // Ignore secondary error while cleaning temporary file.
      }
    }
    if (renamed) {
      throw new Error("Directory sync failed; durability is uncertain");
    }
    throw error;
  }
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  const resolvedTarget = path.resolve(target);
  const prev = fileWriteQueues.get(resolvedTarget) ?? Promise.resolve();

  const next = prev.catch(() => {}).then(() => performWriteAtomic(resolvedTarget, contents));
  fileWriteQueues.set(resolvedTarget, next);

  try {
    await next;
  } finally {
    if (fileWriteQueues.get(resolvedTarget) === next) {
      fileWriteQueues.delete(resolvedTarget);
    }
  }
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWatchTarget(value: unknown): value is WatchTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyTrimmedString(candidate["label"])) {
    return false;
  }
  const kind = candidate["kind"];
  if (kind === "page") {
    return isNonEmptyTrimmedString(candidate["url"]);
  }
  if (kind === "folder") {
    return isNonEmptyTrimmedString(candidate["path"]);
  }
  if (kind === "routine") {
    return isNonEmptyTrimmedString(candidate["routineId"]);
  }
  return false;
}

function isCadence(value: unknown): value is Cadence {
  return value === "hourly" || value === "daily" || value === "weekly";
}

function isTellMeWhen(value: unknown): value is Watch["tellMeWhen"] {
  return (
    value === "anything-changes" ||
    value === "numbers-change" ||
    value === "something-new-appears"
  );
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isWatch(value: unknown): value is Watch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    SAFE_ID.test(candidate["id"]) &&
    isWatchTarget(candidate["target"]) &&
    isCadence(candidate["cadence"]) &&
    isTellMeWhen(candidate["tellMeWhen"]) &&
    typeof candidate["quietHours"] === "boolean" &&
    isNullableTimestamp(candidate["lastCheckedAt"]) &&
    isNullableTimestamp(candidate["lastChangedAt"]) &&
    typeof candidate["paused"] === "boolean"
  );
}

function validateWatches(watches: unknown): readonly Watch[] {
  if (!Array.isArray(watches)) {
    throw new Error("Invalid watches store: expected an array");
  }
  const seenIds = new Set<string>();
  const validated: Watch[] = [];
  for (let i = 0; i < watches.length; i++) {
    const item = watches[i];
    if (!isWatch(item)) {
      throw new Error(`Invalid watch at index ${i}`);
    }
    if (seenIds.has(item.id)) {
      throw new Error("Duplicate watch ID detected");
    }
    seenIds.add(item.id);
    validated.push(item);
  }
  return validated;
}

export async function loadWatches(folder: string): Promise<readonly Watch[]> {
  const filePath = path.join(folder, "watches.json");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      // No file yet is not an error; it is a Mac that has never been asked to watch anything.
      return [];
    }
    throw new Error("Failed to read watches store");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse watches store: invalid JSON");
  }

  return validateWatches(parsed);
}

export async function saveWatches(folder: string, watches: readonly Watch[]): Promise<void> {
  validateWatches(watches);
  await fs.mkdir(folder, { recursive: true });
  await writeAtomic(path.join(folder, "watches.json"), JSON.stringify(watches));
}

function seenPath(folder: string, watchId: string): string | null {
  if (!SAFE_ID.test(watchId)) {
    return null;
  }
  return path.join(folder, "seen", `${createHash("sha256").update(watchId).digest("hex")}.txt`);
}

export async function lastSeen(folder: string, watchId: string): Promise<string | null> {
  const target = seenPath(folder, watchId);
  if (target === null) {
    throw new Error("Invalid watchId");
  }
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw new Error("Failed to read last seen for watch");
  }
}

export async function remember(folder: string, watchId: string, text: string): Promise<void> {
  const target = seenPath(folder, watchId);
  if (target === null) {
    throw new Error("Invalid watchId");
  }
  await fs.mkdir(path.join(folder, "seen"), { recursive: true });
  await writeAtomic(target, text);
}

/** Drops what a removed watch had seen, so nothing outlives the watch itself. */
export async function forgetSeen(folder: string, watchId: string): Promise<void> {
  const target = seenPath(folder, watchId);
  if (target === null) {
    throw new Error("Invalid watchId");
  }
  try {
    await fs.rm(target, { force: true });
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
}
