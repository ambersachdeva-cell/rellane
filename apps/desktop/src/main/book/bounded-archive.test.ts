import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import {
  AmbiguousPublicationError,
  createBoundedBookArchive,
  type BoundedBookArchiveLimits
} from "./bounded-archive.js";
import { openBook } from "./database.js";
import { newRecoverySecret } from "./recovery.js";

let directory: string;
let source: string;
let db: DatabaseSync;
let secret: Buffer;

const limits: BoundedBookArchiveLimits = {
  maxSourcePages: 4096,
  maxSourceBytes: 16 * 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxArchiveBytes: 16 * 1024 * 1024
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "r24-book-archive-"));
  source = path.join(directory, "book.sqlite");
  db = (await openBook(source)).db;
  secret = newRecoverySecret();
});

afterEach(async () => {
  db.close();
  secret.fill(0);
  await rm(directory, { recursive: true, force: true });
});

describe("bounded synthetic Book archive", () => {
  it("includes a committed uncheckpointed WAL row, verifies, and reopens the encrypted archive", async () => {
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.prepare("INSERT INTO party (id, name, created_at, updated_at) VALUES (?,?,?,?)")
      .run("p1", "Synthetic party", 0, 0);
    const reader = new DatabaseSync(source);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) AS n FROM party").get();
      expect((reader.prepare("SELECT COUNT(*) AS n FROM invoice").get() as { n: number }).n)
        .toBe(0);
      db.prepare("INSERT INTO invoice (id, party_id, issued_on, total_paise, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run("i1", "p1", 0, 123, "confirmed", 0, 0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM invoice").get() as { n: number }).n)
        .toBe(1);
      expect((await stat(`${source}-wal`)).size).toBeGreaterThan(0);

      const receipt = await createBoundedBookArchive({
        db, destinationDirectory: directory, destinationName: "book.portable", secret, limits
      });
      expect(receipt).toMatchObject({ verified: true, schema: expect.any(Number) });
      expect(receipt.sourcePages).toBeGreaterThan(0);
      const bytes = await readFile(receipt.destination);
      expect(receipt.archiveBytes).toBe(bytes.byteLength);
      expect(receipt.archiveSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(bytes.includes(Buffer.from("Synthetic party"))).toBe(false);
      expect((await verifyBackup(receipt.destination, secret, limits)).ok).toBe(true);

      const restoredPath = path.join(directory, "restored.sqlite");
      await restoreBackup(receipt.destination, restoredPath, secret, limits);
      const reopened = new DatabaseSync(restoredPath);
      try {
        expect((reopened.prepare("SELECT total_paise FROM invoice WHERE id = 'i1'").get() as
          { total_paise: number }).total_paise).toBe(123);
      } finally {
        reopened.close();
      }
      expect(await stageNames()).toEqual([]);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  });

  it("refuses existing file and symlink targets without changing either", async () => {
    const destination = path.join(directory, "book.portable");
    await writeFile(destination, "original", "utf8");
    await expect(createBoundedBookArchive({
      db, destinationDirectory: directory, destinationName: "book.portable", secret, limits
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await stageNames()).toEqual([]);

    await rm(destination);
    const outside = path.join(directory, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, destination);
    await expect(createBoundedBookArchive({
      db, destinationDirectory: directory, destinationName: "book.portable", secret, limits
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await stageNames()).toEqual([]);
  });

  it("durably publishes archive syncing staged archive and destination directory", async () => {
    let syncedDir: string | undefined;
    const receipt = await createBoundedBookArchive({
      db,
      destinationDirectory: directory,
      destinationName: "book.durable",
      secret,
      limits,
      syncDirectory: async (dir) => {
        syncedDir = dir;
        const handle = await open(dir, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    });
    expect(receipt).toMatchObject({ verified: true, schema: expect.any(Number) });
    expect(receipt.destination).toBe(path.join(directory, "book.durable"));
    expect(syncedDir).toBe(directory);
    expect(await stageNames()).toEqual([]);
    expect((await verifyBackup(receipt.destination, secret, limits)).ok).toBe(true);
  });

  it("reports ambiguous publication on injected sync failure and preserves published link without overwrite", async () => {
    const destinationName = "book.ambiguous";
    const destination = path.join(directory, destinationName);
    const syncError = new Error("injected directory sync failure");

    let thrown: unknown;
    try {
      await createBoundedBookArchive({
        db,
        destinationDirectory: directory,
        destinationName,
        secret,
        limits,
        syncDirectory: async () => {
          throw syncError;
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AmbiguousPublicationError);
    const ambiguous = thrown as AmbiguousPublicationError;
    expect(ambiguous.destination).toBe(destination);
    expect(ambiguous.cause).toBe(syncError);
    expect(ambiguous.message).toContain(destination);

    const publishedStat = await lstat(destination);
    expect(publishedStat.isFile()).toBe(true);
    expect(publishedStat.size).toBeGreaterThan(0);
    expect((await verifyBackup(destination, secret, limits)).ok).toBe(true);

    expect(await stageNames()).toEqual([]);

    const bytesBefore = await readFile(destination);
    await expect(createBoundedBookArchive({
      db,
      destinationDirectory: directory,
      destinationName,
      secret,
      limits
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination)).toEqual(bytesBefore);
  });

  it("rejects source pages, source bytes, snapshot bytes, and archive bytes with cleanup", async () => {
    for (const changed of [
      { maxSourcePages: 1 },
      { maxSourceBytes: 512 },
      { maxSnapshotBytes: 512 },
      { maxArchiveBytes: 128 }
    ]) {
      await expect(createBoundedBookArchive({
        db, destinationDirectory: directory, destinationName: "book.portable",
        secret, limits: { ...limits, ...changed }
      })).rejects.toThrow();
      expect(await stageNames()).toEqual([]);
      await expect(lstat(path.join(directory, "book.portable"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("bounded verification rejects a corrupt archive and oversized declared output", async () => {
    const archive = path.join(directory, "candidate.backup");
    await createBackup(db, archive, secret, limits);
    const intact = await readFile(archive);
    const corrupt = Buffer.from(intact);
    corrupt[corrupt.length - 20] = corrupt[corrupt.length - 20]! ^ 1;
    await writeFile(archive, corrupt);
    expect((await verifyBackup(archive, secret, limits)).ok).toBe(false);
    await writeFile(archive, intact);
    expect((await verifyBackup(archive, secret, {
      maxSnapshotBytes: 512, maxArchiveBytes: limits.maxArchiveBytes
    })).ok).toBe(false);
  });
});

async function stageNames(): Promise<string[]> {
  return (await readdir(directory)).filter(name => name.startsWith(".r24-book-stage-"));
}
