/**
 * Backups that actually happen.
 *
 * `createBackup` and `verifyBackup` were written, tested and shipped, and had
 * **no callers at all**. The archive format, the encryption, the recovery
 * phrase, the restore rehearsal — all of it correct, and none of it had ever run
 * outside a test. A backup system that has never made a backup is worse than an
 * absent one, because everything around it says the data is safe.
 *
 * This is the part that runs it.
 *
 * ## Every backup is verified before it counts
 *
 * `verifyBackup` restores the archive into a temp directory, opens it, and runs
 * SQLite's own integrity check. That takes seconds and it is the difference
 * between having a backup and believing you have one — an unverified archive is
 * a file somebody will one day discover is unreadable, on the day they need it.
 *
 * So a backup that cannot be verified is **not recorded as a success**, and the
 * screen says so. The house rule is that a green light carries its probe.
 *
 * ## Where it may write
 *
 * Not inside the app's own data directory. A copy beside the original survives
 * an accidental delete and nothing else — not a failed disk, not a lost laptop,
 * which are the cases people actually keep backups for. The destination is
 * picked by the owner through a Finder dialog, so it can be an external disk or
 * a synced folder, and the refusal explains why when it is not.
 *
 * ## Timing
 *
 * Checked on a modest interval rather than scheduled to a wall-clock time. A
 * laptop is asleep at 3am, and a schedule that silently does not fire is the
 * same failure as having none — so this asks "has it been long enough" whenever
 * it gets the chance, which survives sleep, restarts and a machine that is only
 * open during the working day.
 */

import type { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { createBackup, verifyBackup } from "./backup.js";
import { diagnostics } from "../foundations/diagnostics.js";

export type BackupCadence = "off" | "daily" | "weekly";

export interface BackupState {
  readonly cadence: BackupCadence;
  /** Where the owner chose. Null until they pick one. */
  readonly destination: string | null;
  /** When one last succeeded *and verified*. Null if never. */
  readonly lastSucceededAt: string | null;
  /** What went wrong last time, if it did. Null when the last attempt worked. */
  readonly lastProblem: string | null;
}

export const NO_BACKUPS: BackupState = Object.freeze({
  cadence: "off",
  destination: null,
  lastSucceededAt: null,
  lastProblem: null
});

/** How long a cadence allows between backups. */
export function intervalMs(cadence: BackupCadence): number {
  switch (cadence) {
    case "daily":
      return 24 * 60 * 60_000;
    case "weekly":
      return 7 * 24 * 60 * 60_000;
    case "off":
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * Whether one is due.
 *
 * Never due when there is no destination: running would mean choosing a place
 * to write the owner's business records without asking, which is not a decision
 * software gets to make quietly.
 */
export function isDue(state: BackupState, now: number): boolean {
  // `=== null` was not the same question as "is there a destination". An empty
  // string is not null, so it passed here and reached `runBackup`, which
  // resolves it against the process's working directory — writing the owner's
  // business records somewhere nobody chose, which is the exact decision the
  // paragraph above says software does not get to make quietly.
  if (state.cadence === "off" || state.destination === null || state.destination.trim() === "") {
    return false;
  }
  if (state.lastSucceededAt === null) {
    return true;
  }
  const last = Date.parse(state.lastSucceededAt);
  // An unparseable timestamp means the record is damaged. Backing up is the
  // safe reading of "we do not know when the last one was".
  return Number.isNaN(last) ? true : now - last >= intervalMs(state.cadence);
}

/**
 * Refuses a destination that would not survive the thing backups are for.
 *
 * Returns null when the path is fine.
 */
export function whyUnsuitable(destination: string, appDataDir: string): string | null {
  if (!destination.trim().startsWith("/")) {
    return "Pick a folder, not a relative path.";
  }
  /**
   * Compared the way the filesystem compares them, not the way strings compare.
   *
   * This guard has now failed open twice for the same reason — comparing two
   * spellings of one path. The first was a trailing slash on `appDataDir`. The
   * three below are all still live on a stock Mac, and each one lets a backup be
   * written inside the storage it exists to survive:
   *
   *   - **`..` segments.** `…/Rellane/../Rellane` does not start with `…/Rellane`
   *     as a string, and names exactly it as a path.
   *   - **Case.** macOS is case-insensitive by default, so `/users/…` and
   *     `/Users/…` are one directory and two strings.
   *   - **Unicode form.** A path typed by a person is NFC; one read back from
   *     the filesystem is NFD. `ॐ` in a folder name is enough, and the two
   *     spellings are byte-different and identical on disk.
   *
   * `resolve` handles the first, `normalize("NFC")` the second, and lowercasing
   * the third. Lowercasing is wrong on a case-*sensitive* volume — it would
   * refuse a legitimate destination whose name differs only in case from the app
   * directory — and that is the direction to be wrong in here.
   */
  const canonical = (path: string): string =>
    resolve(path.trim()).normalize("NFC").replace(/\/+$/u, "").toLowerCase();
  const normalised = canonical(destination);
  const home = canonical(appDataDir);
  if (normalised === home || normalised.startsWith(`${home}/`)) {
    return "That folder is inside Rellane's own storage, so a backup there would be lost with everything else. Pick somewhere outside it — an external disk or a synced folder is best.";
  }
  return null;
}

/** The filename for one backup. Sortable, and readable at a glance. */
export function backupName(now: Date): string {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}`;
  return `cadrane-${stamp}.cadranebackup`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export interface RunOutcome {
  readonly ok: boolean;
  /** What happened, in the owner's words. Always set. */
  readonly said: string;
  readonly at: string;
  /** Where it was written, when it worked. */
  readonly path: string | null;
}

/**
 * Makes one backup and proves it can be read back.
 *
 * Never throws. A failed backup is a sentence on a screen and a line in the
 * record; an exception here would surface as a toast with no history, on the
 * one subject where the owner most needs a history.
 */
export async function runBackup(
  db: DatabaseSync,
  destinationDir: string,
  secret: Buffer,
  now: Date = new Date()
): Promise<RunOutcome> {
  const at = now.toISOString();
  const path = join(destinationDir, backupName(now));

  try {
    const written = await createBackup(db, path, secret);

    // The step that makes it a backup rather than a file. An archive nobody has
    // opened is a promise, not a copy.
    const check = await verifyBackup(path, secret);
    if (!check.ok) {
      diagnostics.warn("backup", "an archive was written but could not be read back", {
        summary: check.summary
      });
      return {
        ok: false,
        at,
        path: null,
        said: `A backup was written but could not be read back, so it is not being counted. ${check.summary}`
      };
    }

    diagnostics.info("backup", "backup written and verified", { bytes: written.bytes });
    return {
      ok: true,
      at,
      path,
      said: `Backed up and checked. ${describeSize(written.bytes)} written, restored into a temporary copy and opened, so it is known to work.`
    };
  } catch (error) {
    const said = error instanceof Error ? error.message : "The backup failed.";
    diagnostics.warn("backup", "backup failed", { error: said });
    return {
      ok: false,
      at,
      path: null,
      // The failure people actually hit, named rather than left as an errno.
      said: /ENOENT|ENOTDIR/u.test(said)
        ? "That folder is not there any more. If it is on an external disk, plug it in — or pick a new folder."
        : /EACCES|EPERM/u.test(said)
          ? "Rellane is not allowed to write to that folder. Pick another one."
          : /ENOSPC/u.test(said)
            ? "There is not enough room on that disk for a backup."
            : said
    };
  }
}

function describeSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
