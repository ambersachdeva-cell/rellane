/**
 * Opening the book, and moving it forward a version at a time.
 *
 * `node:sqlite` rather than a native module. Verified on 2026-08-31 that
 * Electron 43.2.0 embeds Node 24.18.0 and exposes it with **FTS5** and
 * **VACUUM INTO** — the two features the plan actually depends on, for search
 * and for a consistent backup. That removes `better-sqlite3`, `electron-rebuild`
 * and an ABI that has to match the Electron build, which on an ad-hoc-signed app
 * with no Apple Developer Program is a real reduction in what can go wrong
 * between Amber's Mac and his father's.
 *
 * The rule this file exists to enforce: **a migration never runs without a
 * backup beside it.** Schema changes are the one routine operation that can
 * destroy a business's records, they happen on app update, and an update is
 * already the moment when macOS revokes every folder permission. That is more
 * than enough going wrong at once.
 */

import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LATEST_VERSION, MIGRATIONS, type Migration } from "./schema.js";
import { diagnostics } from "../foundations/diagnostics.js";

/** How many pre-migration backups are kept before the oldest is dropped. */
export const KEPT_MIGRATION_BACKUPS = 5;

export interface OpenResult {
  readonly db: DatabaseSync;
  /** The version the database was at before this open. 0 for a fresh file. */
  readonly from: number;
  readonly to: number;
  /** Where the pre-migration backup went, when one was taken. */
  readonly backup: string | null;
  readonly applied: readonly Migration[];
}

export class SchemaTooNew extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(
      `This book was written by a newer version of Rellane (schema ${found}; this build understands ${supported}). Opening it here could damage it, so it has not been opened. Update Rellane, or restore a backup taken by this version.`
    );
    this.name = "SchemaTooNew";
  }
}

/**
 * Opens the book at `file`, migrating it to the latest schema.
 *
 * Refuses a database from the future rather than trying. A newer build may have
 * added a column this one does not write, and half-populating it is how a
 * record becomes quietly wrong — which for a ledger is worse than not opening.
 */
export async function openBook(file: string): Promise<OpenResult> {
  await mkdir(dirname(file), { recursive: true });

  const existed = await stat(file)
    .then(() => true)
    .catch(() => false);

  const db = new DatabaseSync(file);

  // WAL survives a crash without losing the last committed write, and lets a
  // read run while a write is in flight — which is what makes the backup in
  // `backup.ts` possible without stopping the app.
  db.exec("PRAGMA journal_mode = WAL");
  // FULL rather than NORMAL: NORMAL can lose the most recent transactions on
  // power loss. This is somebody's money, and the cost is a fsync on a write
  // that happens a few times a minute at most.
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const from = currentVersion(db);
  if (from > LATEST_VERSION) {
    db.close();
    throw new SchemaTooNew(from, LATEST_VERSION);
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (left, right) => left.version - right.version
  );

  if (pending.length === 0) {
    return { db, from, to: from, backup: null, applied: [] };
  }

  // Only an existing database is worth backing up. A fresh file has nothing in
  // it, and writing a backup of an empty book would push a real one out of the
  // retention window on first launch.
  //
  // The test is `existed` alone, deliberately. An earlier version also required
  // `from > 0`, which skipped the backup for a database at version 0 — that is,
  // one written before this app kept versions at all. That is the single most
  // dangerous file to migrate without a copy: it is the oldest book on the
  // oldest Mac, it holds real records, and it is the one case where the
  // migration has the least idea what it is looking at.
  let backup: string | null = null;
  if (existed) {
    db.close();
    backup = await backupBeforeMigration(file, from);
    return await reopenAndMigrate(file, from, pending, backup);
  }

  applyAll(db, pending);
  return { db, from, to: LATEST_VERSION, backup: null, applied: pending };
}

/**
 * Reopens after the backup and applies the migrations.
 *
 * The close/copy/reopen dance is deliberate: copying the file while a
 * connection holds it means copying a WAL that may not be checkpointed, and a
 * backup that needs its `-wal` sidecar to be readable is a backup that will be
 * restored wrong by someone in a hurry.
 */
async function reopenAndMigrate(
  file: string,
  from: number,
  pending: readonly Migration[],
  backup: string
): Promise<OpenResult> {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  try {
    applyAll(db, pending);
  } catch (error) {
    db.close();
    // Named rather than swallowed. The backup is the reason this is survivable
    // and the message has to say where it is, because the person reading it is
    // about to need it.
    throw new Error(
      `The book could not be updated to the new format, so nothing was changed. Your records are safe in the backup at ${backup}. (${
        error instanceof Error ? error.message : "unknown error"
      })`
    );
  }

  return { db, from, to: LATEST_VERSION, backup, applied: pending };
}

/**
 * Applies migrations in one transaction each.
 *
 * Per migration rather than one transaction for all of them, so a failure at v3
 * leaves a database honestly at v2 rather than at an unknown point. SQLite
 * commits DDL transactionally, which is what makes this work at all.
 */
function applyAll(db: DatabaseSync, pending: readonly Migration[]): void {
  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      // user_version does not accept a bound parameter; the value is our own
      // integer from a checked-in constant, never anything a person typed.
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
      db.exec("COMMIT");
      diagnostics.info("book", `migrated to v${migration.version}`, {
        summary: migration.summary
      });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}

/** `book.sqlite` → `book.pre-v1.<timestamp>.sqlite`, beside it. */
async function backupBeforeMigration(file: string, from: number): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const destination = `${file}.pre-v${from}.${stamp}.bak`;
  await copyFile(file, destination);
  await pruneMigrationBackups(file);
  diagnostics.info("book", "backed up before migrating", { from });
  return destination;
}

/**
 * Keeps the last few pre-migration backups.
 *
 * They are full copies of the book, so they are not free, and after a dozen
 * updates the oldest is of a schema this build can no longer read anyway. The
 * newest are the ones that matter, because the migration that just went wrong
 * is the one being recovered from.
 */
async function pruneMigrationBackups(file: string): Promise<void> {
  const folder = dirname(file);
  const prefix = `${file.slice(folder.length + 1)}.pre-v`;
  const names = await readdir(folder).catch(() => [] as string[]);

  const backups = names.filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).sort();

  for (const stale of backups.slice(0, Math.max(0, backups.length - KEPT_MIGRATION_BACKUPS))) {
    await rm(join(folder, stale), { force: true }).catch(() => undefined);
  }
}
