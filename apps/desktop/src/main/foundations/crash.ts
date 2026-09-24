/**
 * What Rellane keeps when it falls over.
 *
 * The Settings screen has carried a **Crash reports** toggle saying *"If Rellane
 * crashes, we get the stack trace and nothing else."* Every word of that was
 * untrue: `crashReporter` was never started, nothing was captured, and there is
 * no "we" — this product has no server and is not going to grow one (D-037). A
 * consent toggle for a thing that does not happen is worse than no toggle,
 * because it teaches the owner that the switches on that screen are decoration.
 *
 * So the feature is built the way a local-first product can actually keep:
 *
 *   - A crash writes a **redacted report to this Mac**, and nowhere else.
 *   - The owner can read the exact text before deciding to hand it to anybody.
 *   - Sending is a thing a person does, by attaching a file they have read. No
 *     upload, no endpoint, no consent dialog pretending otherwise.
 *
 * That is the honest version of the same value: when something breaks, there is
 * evidence, and it does not cost the owner their privacy to have it.
 *
 * ## What is removed
 *
 * Reports go through `redact()`, the same function the diagnostics bundle uses:
 * the home directory collapses to `~`, every path becomes its depth and
 * extension, and emails, long tokens and long digit runs are replaced. A stack
 * trace is mostly file paths, and this owner's paths are named after his
 * clients.
 *
 * ## What is kept
 *
 * A cap, and the newest few. An unbounded crash directory on a machine that
 * crashes in a loop is its own outage, and nobody reads the fortieth copy of
 * the same trace.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./diagnostics.js";

/** How many reports are kept. Newest first; the rest are deleted. */
export const KEEP_REPORTS = 5;

/** A trace longer than this is truncated rather than stored whole. */
export const MAX_TRACE_CHARS = 20_000;

export const CRASH_DIR = "crashes";

export interface CrashReport {
  readonly id: string;
  readonly at: string;
  /** Where it happened, in the owner's words. */
  readonly what: string;
  /** Already redacted. This is the exact text that would be shared. */
  readonly text: string;
}

/** The filename for one report. Sortable, so "newest" needs no metadata. */
export function reportName(at: Date): string {
  return `crash-${at.toISOString().replace(/[:.]/gu, "-")}.txt`;
}

/**
 * Writes one crash to disk, redacted.
 *
 * Never throws. This runs while the app is already failing, and a crash handler
 * that itself throws replaces a legible report with nothing at all.
 */
export async function recordCrash(
  dataDir: string,
  what: string,
  error: unknown,
  at: Date = new Date()
): Promise<string | null> {
  try {
    const dir = join(dataDir, CRASH_DIR);
    await mkdir(dir, { recursive: true });

    const raw =
      error instanceof Error
        ? `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`
        : String(error);

    const body = [
      `what: ${what}`,
      `when: ${at.toISOString()}`,
      `version: ${process.env["npm_package_version"] ?? "unknown"}`,
      `platform: ${process.platform} ${process.arch}`,
      "",
      // Redacted before it is written, not before it is shared. A file sitting
      // on disk with the owner's client names in it is already a leak — a
      // backup picks it up, a screen-share shows it.
      redact(raw).slice(0, MAX_TRACE_CHARS)
    ].join("\n");

    const path = join(dir, reportName(at));
    await writeFile(path, body, { mode: 0o600 });
    await prune(dir);
    return path;
  } catch {
    // Already failing. Losing the report is bad; taking the process down while
    // trying to describe why it went down is worse.
    return null;
  }
}

/** Deletes all but the newest few. */
async function prune(dir: string): Promise<void> {
  const names = (await readdir(dir).catch(() => []))
    .filter((name) => name.startsWith("crash-"))
    .sort()
    .reverse();
  for (const stale of names.slice(KEEP_REPORTS)) {
    await rm(join(dir, stale), { force: true }).catch(() => undefined);
  }
}

/**
 * Every kept report, newest first.
 *
 * The text is returned in full because the whole point is that the owner reads
 * exactly what they would be handing over. A summary here would defeat it.
 */
export async function readCrashes(dataDir: string): Promise<readonly CrashReport[]> {
  const dir = join(dataDir, CRASH_DIR);
  const names = (await readdir(dir).catch(() => []))
    .filter((name) => name.startsWith("crash-"))
    .sort()
    .reverse()
    .slice(0, KEEP_REPORTS);

  const reports: CrashReport[] = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    if (text === null) {
      continue;
    }
    reports.push({
      id: name,
      at: text.match(/^when: (.+)$/mu)?.[1] ?? "",
      what: text.match(/^what: (.+)$/mu)?.[1] ?? "Something failed",
      text
    });
  }
  return reports;
}

/** Removes every report. The owner's copy, so the owner may delete it. */
export async function forgetCrashes(dataDir: string): Promise<void> {
  await rm(join(dataDir, CRASH_DIR), { recursive: true, force: true });
}
