import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openBook } from "./database.js";
import { verifyBackup } from "./backup.js";
import {
  backupName,
  intervalMs,
  isDue,
  NO_BACKUPS,
  runBackup,
  whyUnsuitable,
  type BackupState
} from "./schedule.js";

const SECRET = Buffer.alloc(32, 7);

/**
 * Where the app keeps its own records, as a single constant.
 *
 * Two separate literals here got rewritten inconsistently by a tree-wide rename
 * and broke the "is this inside our own storage" check silently — the two paths
 * stopped sharing a prefix, so the test asserted nothing.
 */
const HOME = "/Users/a/Library/Application Support/Cadrane";

let dir: string;
let db: DatabaseSync;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-schedule-"));
  // The real book, not a toy table: `verifyBackup` checks that the restored
  // archive holds an actual Rellane schema, which is the property worth
  // testing. A hand-made table passes VACUUM and fails the check that matters.
  db = (await openBook(join(dir, "book.sqlite"))).db;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const state = (over: Partial<BackupState> = {}): BackupState => ({
  ...NO_BACKUPS,
  cadence: "daily",
  destination: "/Volumes/Backup",
  ...over
});

describe("when a backup is due", () => {
  const NOW = Date.parse("2026-09-01T10:00:00.000Z");

  it("is due immediately when none has ever succeeded", () => {
    expect(isDue(state(), NOW)).toBe(true);
  });

  it("is never due without a destination", () => {
    // Running would mean choosing where to write the owner's business records
    // without asking. That is not a decision software makes quietly.
    expect(isDue(state({ destination: null }), NOW)).toBe(false);
  });

  it("is never due when switched off", () => {
    expect(isDue(state({ cadence: "off" }), NOW)).toBe(false);
    expect(intervalMs("off")).toBe(Number.POSITIVE_INFINITY);
  });

  it("waits out the interval, then fires", () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const old = new Date(NOW - 25 * 60 * 60_000).toISOString();

    expect(isDue(state({ lastSucceededAt: recent }), NOW)).toBe(false);
    expect(isDue(state({ lastSucceededAt: old }), NOW)).toBe(true);
  });

  it("backs up when the record of the last one is unreadable", () => {
    // "We do not know when the last backup was" reads safely as "make one".
    expect(isDue(state({ lastSucceededAt: "not a date" }), NOW)).toBe(true);
  });
});

describe("where it may write", () => {
  it("refuses a folder inside Rellane's own storage", () => {
    // A copy beside the original survives an accidental delete and nothing
    // else — not a failed disk, not a lost laptop, which is what backups are
    // actually for.
    const why = whyUnsuitable(`${HOME}/backups`, HOME);

    expect(why).toContain("lost with everything else");
    expect(why).toContain("external disk");
  });

  it("accepts a folder outside it", () => {
    expect(whyUnsuitable("/Volumes/Backup", HOME)).toBeNull();
    // A sibling whose name merely starts the same way is not inside it.
    expect(whyUnsuitable(`${HOME}-copies`, HOME)).toBeNull();
  });

  it("refuses even when our own path carries a trailing slash", () => {
    // Only the destination was normalised, so a trailing slash on the app's own
    // directory made the comparison fail and the guard fail *open* — allowing
    // backups inside the storage they exist to survive.
    expect(whyUnsuitable(`${HOME}/backups`, `${HOME}/`)).toContain("lost with everything else");
    expect(whyUnsuitable(`${HOME}/backups/`, `${HOME}//`)).toContain("lost with everything else");
  });

  it("refuses a relative path", () => {
    expect(whyUnsuitable("backups", "/Users/a/data")).toContain("not a relative path");
  });
});

describe("making one", () => {
  it("writes an archive and proves it can be read back", async () => {
    const into = join(dir, "dest");
    const outcome = await runBackup(db, into, SECRET);

    expect(outcome.ok).toBe(true);
    expect(outcome.said).toContain("restored into a temporary copy and opened");
    expect((await readdir(into)).some((name) => name.endsWith(".cadranebackup"))).toBe(true);
  });

  it("writes something that is genuinely verifiable, and only with the right key", async () => {
    // The property the whole feature rests on. An archive nobody has opened is
    // a promise, not a copy — and it is discovered unreadable on the day it is
    // needed.
    const into = join(dir, "dest");
    await runBackup(db, into, SECRET);
    const [name = ""] = (await readdir(into)).filter((f) => f.endsWith(".cadranebackup"));

    expect((await verifyBackup(join(into, name), SECRET)).ok).toBe(true);
    expect((await verifyBackup(join(into, name), Buffer.alloc(32, 9))).ok).toBe(false);
  });

  it("refuses to count an archive that cannot be read back", async () => {
    // Corrupted after writing: the run must not report success for a file that
    // will not open, and must say plainly that it is not being counted.
    const into = join(dir, "dest");
    await runBackup(db, into, SECRET);
    const [name = ""] = (await readdir(into)).filter((f) => f.endsWith(".cadranebackup"));
    await writeFile(join(into, name), "not an archive");

    const check = await verifyBackup(join(into, name), SECRET);
    expect(check.ok).toBe(false);
  });

  it("names a missing folder as something to plug in, not as an errno", async () => {
    const outcome = await runBackup(db, "/Volumes/NotPluggedIn/backups", SECRET);

    expect(outcome.ok).toBe(false);
    expect(outcome.said).toMatch(/plug it in|not allowed|not there/u);
    expect(outcome.said).not.toContain("ENOENT");
  });

  it("never throws, whatever went wrong", async () => {
    // A failed backup is a sentence on a screen. An exception becomes a toast
    // with no history, on the one subject where history matters most.
    await expect(runBackup(db, "/dev/null/nope", SECRET)).resolves.toMatchObject({ ok: false });
  });
});

describe("the filename", () => {
  it("sorts chronologically and reads at a glance", () => {
    const name = backupName(new Date("2026-09-01T14:05:00"));

    expect(name).toBe("cadrane-2026-09-01-1405.cadranebackup");
    expect(backupName(new Date("2026-01-02T03:04:00")) < name).toBe(true);
  });
});

describe("two spellings of one path", () => {
  // This guard has failed open twice for the same reason: comparing paths as
  // strings. Each case below names one directory in two ways, and each one used
  // to be allowed as a backup destination inside the storage backups exist to
  // survive.
  const APP = "/Users/amber/Library/Application Support/Cadrane";

  it("refuses a path that walks back into the app directory", () => {
    expect(whyUnsuitable(`${APP}/../Cadrane/Backups`, APP)).not.toBeNull();
  });

  it("refuses a path that differs only in case, because macOS is case-insensitive", () => {
    expect(whyUnsuitable("/users/amber/library/application support/cadrane/x", APP)).not.toBeNull();
  });

  it("refuses a path in a different Unicode form", () => {
    // A path typed by a person is NFC; one read back from the filesystem is NFD.
    const app = "/Users/amber/Library/Application Support/Cadrané";
    expect(whyUnsuitable(`${app}/Backups`.normalize("NFD"), app.normalize("NFC"))).not.toBeNull();
  });

  it("still allows an ordinary external disk", () => {
    // The guard must not become a reason nothing can be chosen.
    expect(whyUnsuitable("/Volumes/Backup Disk/Cadrane Backups", APP)).toBeNull();
  });

  it("does not refuse a sibling whose name merely starts the same way", () => {
    // `startsWith` on the bare string would call this one inside the app dir.
    expect(whyUnsuitable("/Users/amber/Library/Application Support/Cadrane Backups", APP)).toBeNull();
  });
});

describe("a destination that is there but empty", () => {
  it("is not due, because an empty string is not a folder anybody picked", () => {
    // `=== null` was not the same question as "is there a destination": an empty
    // string passed it and reached runBackup, which resolves it against the
    // process's working directory.
    expect(isDue({ ...NO_BACKUPS, cadence: "daily", destination: "" }, Date.now())).toBe(false);
    expect(isDue({ ...NO_BACKUPS, cadence: "daily", destination: "   " }, Date.now())).toBe(false);
  });

  it("is still due when a real destination is set", () => {
    expect(isDue({ ...NO_BACKUPS, cadence: "daily", destination: "/Volumes/D" }, Date.now())).toBe(true);
  });
});
