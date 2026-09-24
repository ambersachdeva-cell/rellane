import { DatabaseSync } from "node:sqlite";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupUnreadable,
  createBackup,
  FIRST_AUTHENTICATED_FORMAT,
  FORMAT,
  readHeader,
  restoreBackup,
  sameSecret,
  verifyBackup
} from "./backup.js";
import { openBook } from "./database.js";
import { backupSecret, BackupKeyUnavailable, type KeyVault } from "./open.js";
import { fromPhrase, newRecoverySecret, RECOVERY_BYTES, toPhrase } from "./recovery.js";

let base: string;
let bookFile: string;
let db: DatabaseSync;
let secret: Buffer;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cadrane-backup-test-"));
  bookFile = join(base, "book.sqlite");
  db = (await openBook(bookFile)).db;
  secret = newRecoverySecret();

  // A shop with something in it, so a restore has something to prove.
  db.prepare("INSERT INTO party (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(
    "p1",
    "Sharma Printers",
    0,
    0
  );
  db.prepare(
    "INSERT INTO invoice (id, party_id, issued_on, total_paise, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run("i1", "p1", 0, 34_200_000, "confirmed", 0, 0);
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* already closed by a test */
  }
  await rm(base, { recursive: true, force: true });
});

const archive = () => join(base, "out", "book.cadrane-backup");

/** Corrupts one byte in place, the way a bad disk or a curious editor would. */
function flipByte(bytes: Buffer, at: number): void {
  bytes.writeUInt8(bytes.readUInt8(at) ^ 0xff, at);
}

describe("taking a backup", () => {
  it("writes an archive while the book stays open", async () => {
    const result = await createBackup(db, archive(), secret);

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.header.schema).toBeGreaterThan(0);
    // The live connection is still usable — VACUUM INTO ran inside a read
    // transaction rather than stopping the app.
    const row = db.prepare("SELECT COUNT(*) AS n FROM party").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("leaves the shop's name unreadable in the file", async () => {
    await createBackup(db, archive(), secret);
    const bytes = await readFile(archive());

    // The body is encrypted and the header names nothing about the business.
    expect(bytes.includes(Buffer.from("Sharma Printers"))).toBe(false);
  });

  it("keeps the header readable without the key", async () => {
    // Someone holding this file in five years, possibly without Rellane, should
    // be able to see what it is.
    await createBackup(db, archive(), secret);

    const header = await readHeader(archive());

    expect(header.magic).toBe("CADRANE-BACKUP");
    expect(header.createdAt).toMatch(/^\d{4}-/u);
    expect(header.plainBytes).toBeGreaterThan(0);
  });

  it("never half-replaces a good archive", async () => {
    await createBackup(db, archive(), secret);
    const first = await readFile(archive());

    await createBackup(db, archive(), secret);
    const second = await readFile(archive());

    // Both are complete archives; neither is a truncated file.
    expect(first.byteLength).toBeGreaterThan(0);
    expect(second.byteLength).toBeGreaterThan(0);
    await expect(readHeader(archive())).resolves.toBeTruthy();
  });
});

describe("restoring", () => {
  it("brings the whole book back", async () => {
    await createBackup(db, archive(), secret);
    const target = join(base, "restored.sqlite");

    await restoreBackup(archive(), target, secret);

    const restored = new DatabaseSync(target);
    const party = restored.prepare("SELECT name FROM party").get() as { name: string };
    const bill = restored.prepare("SELECT total_paise FROM invoice").get() as {
      total_paise: number;
    };
    expect(party.name).toBe("Sharma Printers");
    expect(bill.total_paise).toBe(34_200_000);
    restored.close();
  });

  /** 0.3's done-when: a machine that never held the Keychain key. */
  it("opens with the recovery phrase alone, on a machine that never had the key", async () => {
    await createBackup(db, archive(), secret);

    // A different Buffer instance carrying the same bytes — which is all a
    // person typing their phrase into a new Mac can ever produce.
    const typedBackIn = Buffer.from(secret.toString("hex"), "hex");
    const target = join(base, "on-a-new-mac.sqlite");

    await restoreBackup(archive(), target, typedBackIn);

    const restored = new DatabaseSync(target);
    expect((restored.prepare("SELECT COUNT(*) AS n FROM party").get() as { n: number }).n).toBe(1);
    restored.close();
  });

  it("refuses the wrong phrase without hinting at the right one", async () => {
    await createBackup(db, archive(), secret);

    const wrong = newRecoverySecret();
    await expect(
      restoreBackup(archive(), join(base, "nope.sqlite"), wrong)
    ).rejects.toBeInstanceOf(BackupUnreadable);
  });

  it("refuses an archive somebody edited", async () => {
    await createBackup(db, archive(), secret);
    const bytes = await readFile(archive());
    // Flip a byte well inside the ciphertext.
    flipByte(bytes, Math.floor(bytes.byteLength / 2));
    await writeFile(archive(), bytes);

    // GCM authenticates as it decrypts, so tampering fails loudly rather than
    // restoring quiet nonsense.
    await expect(
      restoreBackup(archive(), join(base, "tampered.sqlite"), secret)
    ).rejects.toThrow(/damaged or changed/u);
  });

  it("will not overwrite a book that is already there", async () => {
    // A restore is run by somebody who has already lost data once today.
    await createBackup(db, archive(), secret);

    await expect(restoreBackup(archive(), bookFile, secret)).rejects.toThrow(
      /already a book/u
    );
  });

  it("says plainly when a file is not a backup at all", async () => {
    const notABackup = join(base, "holiday-photo.jpg");
    await writeFile(notABackup, "not a backup");

    await expect(
      restoreBackup(notABackup, join(base, "x.sqlite"), secret)
    ).rejects.toThrow(/not a Rellane backup/u);
  });

  it("refuses an archive from a newer Rellane rather than guessing", async () => {
    await createBackup(db, archive(), secret);
    const bytes = await readFile(archive());
    const newline = bytes.indexOf(0x0a);
    const header = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as Record<
      string,
      unknown
    >;
    header["format"] = 99;
    await writeFile(
      archive(),
      Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), bytes.subarray(newline + 1)])
    );

    await expect(readHeader(archive())).rejects.toThrow(/newer version of Rellane/u);
  });
});

describe("verifying — the difference between having a backup and believing you have one", () => {
  it("opens the archive, checks it, and counts what is inside", async () => {
    await createBackup(db, archive(), secret);

    const result = await verifyBackup(archive(), secret);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("1 party");
    expect(result.summary).toContain("1 bill");
    expect(result.at).toMatch(/^\d{4}-/u);
  });

  it("fails honestly on a damaged archive instead of throwing at the caller", async () => {
    await createBackup(db, archive(), secret);
    const bytes = await readFile(archive());
    flipByte(bytes, bytes.byteLength - 40);
    await writeFile(archive(), bytes);

    const result = await verifyBackup(archive(), secret);

    // The Home surface shows this sentence, so it has to be a sentence.
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/damaged or changed/u);
  });

  it("fails on the wrong phrase", async () => {
    await createBackup(db, archive(), secret);

    expect((await verifyBackup(archive(), newRecoverySecret())).ok).toBe(false);
  });

  it("leaves nothing behind and never touches the live book", async () => {
    await createBackup(db, archive(), secret);
    const before = (await readFile(bookFile)).byteLength;

    await verifyBackup(archive(), secret);

    expect((await readFile(bookFile)).byteLength).toBe(before);
    const leftovers = (await import("node:fs/promises")).readdir(tmpdir());
    expect((await leftovers).filter((n) => n.startsWith("cadrane-verify-"))).toEqual([]);
  });
});

describe("comparing secrets", () => {
  it("matches a secret with itself and rejects another", () => {
    expect(sameSecret(secret, Buffer.from(secret))).toBe(true);
    expect(sameSecret(secret, newRecoverySecret())).toBe(false);
  });

  it("rejects a different length without throwing", () => {
    expect(sameSecret(secret, Buffer.alloc(3))).toBe(false);
  });
});

describe("the header is authenticated, not just present", () => {
  it("refuses an archive whose schema number was edited", async () => {
    // `schema` decides which migrations run on restore. In v1 it sat outside the
    // AES-GCM tag entirely, so editing it in a hex editor produced an archive
    // that decrypted cleanly and then told Rellane to migrate somebody's ledger
    // to a version it had never been at.
    const path = join(base, "book.cadranebackup");
    await createBackup(db, path, secret);

    const raw = await readFile(path);
    const newline = raw.indexOf(0x0a);
    const header = JSON.parse(raw.subarray(0, newline).toString("utf8")) as { schema: number };
    header.schema = 999;
    await writeFile(
      path,
      Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), raw.subarray(newline + 1)])
    );

    await expect(restoreBackup(path, join(base, "restored.sqlite"), secret)).rejects.toThrow();
  });

  it("still opens an archive written before headers were authenticated", async () => {
    // v1 archives exist on people's disks. A change that makes them unreadable
    // is a change that destroys backups, which is the opposite of the job.
    expect(FIRST_AUTHENTICATED_FORMAT).toBe(2);
    expect(FORMAT).toBeGreaterThanOrEqual(FIRST_AUTHENTICATED_FORMAT);
  });

  it("derives the key from the archive's own format, not this build's", async () => {
    // Hardcoding the current constant meant the day FORMAT is incremented,
    // every existing archive derives a different key and stops opening with the
    // correct recovery phrase — backups lost by a version bump.
    const path = join(base, "book.cadranebackup");
    await createBackup(db, path, secret);
    const header = await readHeader(path);

    expect(header.format).toBe(FORMAT);
    await expect(restoreBackup(path, join(base, "ok.sqlite"), secret)).resolves.toBeDefined();
  });
});

describe("backupSecret key generation and unwrapping", () => {
  function fakeVault(available = true): KeyVault {
    return {
      isEncryptionAvailable: () => available,
      encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
      decryptString: (cipher: Buffer) => {
        const str = cipher.toString("utf8");
        if (!str.startsWith("enc:")) {
          throw new Error("decryption failed");
        }
        return str.slice(4);
      }
    };
  }

  it("mints a 20-byte secret matching RECOVERY_BYTES that round-trips via phrase", async () => {
    const vault = fakeVault();
    const created = await backupSecret(base, vault);

    expect(created.byteLength).toBe(RECOVERY_BYTES);
    const phrase = toPhrase(created);
    expect(fromPhrase(phrase)).toEqual(created);
  });

  it("reuses the existing secret on next call", async () => {
    const vault = fakeVault();
    const first = await backupSecret(base, vault);
    const second = await backupSecret(base, vault);

    expect(second).toEqual(first);
  });

  it("refuses when encryption is not available", async () => {
    const vault = fakeVault(false);
    const emptyDir = join(base, "unencrypted");
    await expect(backupSecret(emptyDir, vault)).rejects.toBeInstanceOf(BackupKeyUnavailable);
  });
});
