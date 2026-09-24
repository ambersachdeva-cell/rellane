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
import { createHash } from "node:crypto";
import type { Watch } from "./watch-plan.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

async function writeAtomic(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temporary, contents, "utf8");
  await fs.rename(temporary, target);
}

function isWatch(value: unknown): value is Watch {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const target = candidate["target"];
  if (typeof candidate["id"] !== "string" || typeof target !== "object" || target === null) {
    return false;
  }
  const kind = (target as Record<string, unknown>)["kind"];
  return kind === "page" || kind === "folder" || kind === "routine";
}

export async function loadWatches(folder: string): Promise<readonly Watch[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(folder, "watches.json"), "utf8");
  } catch {
    // No file yet is not an error; it is a Mac that has never been asked to watch anything.
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isWatch);
  } catch {
    return [];
  }
}

export async function saveWatches(folder: string, watches: readonly Watch[]): Promise<void> {
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
    return null;
  }
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
}

export async function remember(folder: string, watchId: string, text: string): Promise<void> {
  const target = seenPath(folder, watchId);
  if (target === null) {
    return;
  }
  await fs.mkdir(path.join(folder, "seen"), { recursive: true });
  await writeAtomic(target, text);
}

/** Drops what a removed watch had seen, so nothing outlives the watch itself. */
export async function forgetSeen(folder: string, watchId: string): Promise<void> {
  const target = seenPath(folder, watchId);
  if (target === null) {
    return;
  }
  try {
    await fs.rm(target, { force: true });
  } catch {
    // Already gone is the outcome this wanted.
  }
}
