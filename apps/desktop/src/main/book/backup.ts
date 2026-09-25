/**
 * Backups — the answer to the only question that matters about local-first.
 *
 * Keeping a business's records on one Mac is the right architecture and it has
 * exactly one liability: nobody else is keeping a copy. A cloud product gets
 * durability by accident, because a provider is quietly replicating the
 * database whether or not anyone thought about it. We have to do it on purpose.
 *
 * Four properties, and each one is a decision rather than a default:
 *
 *   **Consistent.** `VACUUM INTO` writes a whole, self-contained database from
 *   inside a read transaction. Copying the file instead would capture a WAL
 *   mid-checkpoint and produce an archive that needs its sidecars to be read —
 *   which is to say, an archive somebody restores wrongly in a hurry.
 *
 *   **Encrypted.** AES-256-GCM. The archive will end up on a pendrive, in a
 *   Drive folder, on a shop's shared disk. Encryption is what makes it safe to
 *   put it somewhere it will actually survive.
 *
 *   **Verified.** GCM authenticates as it decrypts, so a corrupted or edited
 *   archive fails loudly instead of restoring quiet nonsense. `verifyBackup`
 *   goes further and restores into a temp directory to prove the thing opens.
 *
 *   **Openable without this Mac.** The key derives from a secret that is also
 *   printed as a recovery phrase. See `recovery.ts` for why that is not
 *   optional.
 *
 * The header is deliberately plaintext. Someone holding this file in five years,
 * possibly without Rellane, should be able to see what it is and what opens it.
 */

import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { diagnostics } from "../foundations/diagnostics.js";

export const MAGIC = "CADRANE-BACKUP";
/**
 * The archive format.
 *
 * **v2 authenticates the header.** v1 encrypted the body and left the header —
 * which carries `schema`, the number that decides which migrations run on
 * restore — outside the AES-GCM tag entirely. Editing it in a hex editor
 * produced an archive that still decrypted cleanly and then told Rellane to
 * migrate somebody's ledger to a version it was never at.
 *
 * v1 archives are still readable: the AAD is applied only from v2 onward, so
 * nothing already written becomes undecryptable by this change.
 */
export const FORMAT = 2;

/** The first format whose header is covered by the authentication tag. */
export const FIRST_AUTHENTICATED_FORMAT = 2;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;

/**
 * Everything needed to identify and open the archive, in the clear.
 *
 * It names no party, no amount and no file path — only what this is, when it
 * was made, and the parameters required to derive the key. A header that
 * leaked the shop's name would undo the point of encrypting the body.
 */
export interface BackupHeader {
  readonly magic: typeof MAGIC;
  readonly format: number;
  readonly createdAt: string;
  /** The book's schema version, so a restore can refuse a future format early. */
  readonly schema: number;
  readonly salt: string;
  readonly nonce: string;
  /** Size of the database inside, before compression. For the UI, not for logic. */
  readonly plainBytes: number;
}

export interface BackupResult {
  readonly path: string;
  readonly header: BackupHeader;
  readonly bytes: number;
  readonly tookMs: number;
}

export class BackupUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupUnreadable";
  }
}

/** Optional caps for the isolated R24 path; absent caps retain scheduled-backup behavior. */
export interface BackupByteLimits {
  readonly maxSnapshotBytes: number;
  readonly maxArchiveBytes: number;
}

/**
 * Derives the archive key from the recovery secret.
 *
 * HKDF rather than using the secret directly, so the stored secret and the
 * encryption key are not the same bytes, and so a future archive format can
 * derive a different key from the same phrase by changing `info` alone.
 */
/**
 * The key for one archive.
 *
 * `format` is taken from the archive being opened, not from this module's
 * current constant. Hardcoding `FORMAT` meant that the day the format is
 * incremented, every existing v1 archive would derive a different key and become
 * undecryptable with the correct recovery phrase — the backups would be lost by
 * a version bump, which is the one moment they most need to still work.
 */
function deriveKey(secret: Buffer, salt: Buffer, format: number = FORMAT): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, `${MAGIC}/v${format}`, KEY_BYTES));
}

/**
 * Writes an encrypted, self-contained copy of the book to `destination`.
 *
 * The snapshot is taken through the live connection: `VACUUM INTO` runs inside
 * a read transaction, so the app carries on working while it happens. That is
 * the whole reason WAL mode was chosen when the book is opened.
 */
export async function createBackup(
  db: DatabaseSync,
  destination: string,
  secret: Buffer,
  limits?: BackupByteLimits
): Promise<BackupResult> {
  const started = Date.now();
  await mkdir(dirname(destination), { recursive: true });

  const staging = await mkdtemp(join(tmpdir(), "cadrane-backup-"));
  const snapshot = join(staging, "book.sqlite");

  try {
    // Single-quoted SQL literal with quotes escaped: VACUUM INTO takes no bound
    // parameter, and the path is one we generated rather than one a person typed.
    db.exec(`VACUUM INTO '${snapshot.replace(/'/gu, "''")}'`);

    if (limits !== undefined) {
      const detail = await stat(snapshot);
      if (!detail.isFile() || detail.size <= 0 || detail.size > limits.maxSnapshotBytes) {
        throw new BackupUnreadable("The Book snapshot exceeds the bounded archive limit.");
      }
    }

    const plain = await readFile(snapshot);
    if (limits !== undefined && plain.byteLength > limits.maxSnapshotBytes)
      throw new BackupUnreadable("The Book snapshot exceeds the bounded archive limit.");
    const schema = schemaVersionOf(snapshot);

    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const key = deriveKey(secret, salt);

    // Compressed before encryption: ciphertext does not compress, and a book is
    // mostly repeated text. Safe here because the archive is one fixed blob —
    // the compression-oracle attacks that make this dangerous need an attacker
    // who can inject chosen plaintext and watch the length change repeatedly.
    const packed = gzipSync(plain, {
      level: 6,
      ...(limits === undefined ? {} : { maxOutputLength: limits.maxArchiveBytes })
    });

    // The header is built *before* encryption now, so it can be fed to the
    // cipher as additional authenticated data. Built after, it could only ever
    // be a label on the outside of a sealed box.
    const header: BackupHeader = {
      magic: MAGIC,
      format: FORMAT,
      createdAt: new Date().toISOString(),
      schema,
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      plainBytes: plain.byteLength
    };
    const headerLine = `${JSON.stringify(header)}\n`;
    const headerBytes = Buffer.from(headerLine, "utf8");
    if (limits !== undefined &&
        headerBytes.byteLength + packed.byteLength + TAG_BYTES > limits.maxArchiveBytes)
      throw new BackupUnreadable("The Book archive exceeds the bounded output limit.");

    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    // Authenticated, not encrypted: the header stays readable, and any edit to
    // it now fails the tag rather than silently steering the restore.
    cipher.setAAD(headerBytes);
    const body = Buffer.concat([cipher.update(packed), cipher.final()]);
    const tag = cipher.getAuthTag();

    const archive = Buffer.concat([
      headerBytes,
      body,
      tag
    ]);
    if (limits !== undefined && archive.byteLength > limits.maxArchiveBytes)
      throw new BackupUnreadable("The Book archive exceeds the bounded output limit.");

    // Written aside and renamed, so an interrupted backup never replaces a good
    // archive with half a file. The moment a backup is being taken is not the
    // moment to destroy the previous one.
    const partial = `${destination}.writing`;
    await writeFile(partial, archive);
    await rename(partial, destination);

    diagnostics.info("backup", "wrote an encrypted copy of the book", {
      bytes: archive.byteLength,
      schema,
      tookMs: Date.now() - started
    });

    return {
      path: destination,
      header,
      bytes: archive.byteLength,
      tookMs: Date.now() - started
    };
  } finally {
    if (limits === undefined) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    } else {
      // A bounded portable path must not report success while its temporary
      // plaintext SQLite snapshot remains at rest after a cleanup failure.
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/** Reads the plaintext header without needing the key. */
export async function readHeader(path: string): Promise<BackupHeader> {
  const file = await readFile(path).catch(() => null);
  if (file === null) {
    throw new BackupUnreadable(`There is no backup at ${path}.`);
  }
  return parseHeader(file).header;
}

function parseHeader(file: Buffer): {
  header: BackupHeader;
  body: Buffer;
  /** The exact bytes the tag covers, including the newline. Never re-serialised. */
  headerLine: Buffer;
} {
  const newline = file.indexOf(0x0a);
  if (newline === -1) {
    throw new BackupUnreadable("That file is not a Rellane backup.");
  }

  let header: BackupHeader;
  try {
    header = JSON.parse(file.subarray(0, newline).toString("utf8")) as BackupHeader;
  } catch {
    throw new BackupUnreadable("That file is not a Rellane backup.");
  }
  // `JSON.parse("null")` succeeds and returns null, and `typeof null` is
  // "object" — so a file beginning with `null` got past the parse and threw a
  // TypeError on the next line instead of the readable refusal below.
  if (typeof header !== "object" || header === null) {
    throw new BackupUnreadable("That file does not begin like a Rellane backup.");
  }
  if (header.magic !== MAGIC) {
    throw new BackupUnreadable("That file is not a Rellane backup.");
  }
  if (header.format > FORMAT) {
    throw new BackupUnreadable(
      `That backup was written by a newer version of Rellane (format ${header.format}; this build reads ${FORMAT}). Update Rellane and try again.`
    );
  }

  // The raw bytes, not a re-serialisation. JSON.stringify does not guarantee
  // byte-identical output for a parsed object — key order, spacing and number
  // formatting can all differ — and an AAD that differs by one byte fails the
  // tag on an archive that is perfectly fine.
  return {
    header,
    body: file.subarray(newline + 1),
    headerLine: file.subarray(0, newline + 1)
  };
}

/**
 * Decrypts an archive back into a database file at `destination`.
 *
 * Refuses to overwrite. A restore is run by someone who has already lost data
 * once today, and silently replacing a book that turns out to have been the
 * good one is not a mistake worth making twice.
 */
export async function restoreBackup(
  path: string,
  destination: string,
  secret: Buffer,
  limits?: BackupByteLimits
): Promise<BackupHeader> {
  if (limits !== undefined) {
    const detail = await stat(path);
    if (!detail.isFile() || detail.size <= 0 || detail.size > limits.maxArchiveBytes)
      throw new BackupUnreadable("The Book archive exceeds the bounded verification limit.");
  }
  const file = await readFile(path).catch(() => null);
  if (file === null) {
    throw new BackupUnreadable(`There is no backup at ${path}.`);
  }
  if (limits !== undefined && file.byteLength > limits.maxArchiveBytes)
    throw new BackupUnreadable("The Book archive exceeds the bounded verification limit.");

  /**
   * The sidecars count too.
   *
   * Only `book.sqlite` was checked. An owner following the message below moves
   * that file aside and leaves `book.sqlite-wal` behind — and SQLite replays
   * those stale frames over the freshly restored database on first open,
   * corrupting the ledger they just recovered. The restore appears to succeed
   * and the damage shows up later.
   */
  for (const path of [destination, `${destination}-wal`, `${destination}-shm`]) {
    const exists = await stat(path)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new BackupUnreadable(
        `There is already a book at ${destination}. Move it aside — along with any ${destination}-wal and ${destination}-shm beside it, which SQLite would otherwise replay over the restored copy — so nothing is lost either way.`
      );
    }
  }

  const { header, body, headerLine } = parseHeader(file);
  if (limits !== undefined) assertBoundedHeader(header, headerLine, limits);
  if (body.byteLength <= TAG_BYTES) {
    throw new BackupUnreadable("That backup is incomplete — it holds no data.");
  }

  const key = deriveKey(secret, Buffer.from(header.salt, "base64"), header.format);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
  if (header.format >= FIRST_AUTHENTICATED_FORMAT) {
    // v1 archives were written without this, so applying it to them would fail
    // the tag on a file that is perfectly good.
    decipher.setAAD(headerLine);
  }
  decipher.setAuthTag(body.subarray(body.byteLength - TAG_BYTES));

  let packed: Buffer;
  try {
    packed = Buffer.concat([
      decipher.update(body.subarray(0, body.byteLength - TAG_BYTES)),
      // Throws when the tag does not match, which covers both a wrong key and
      // an edited archive. There is no way to tell those apart, and the honest
      // message says both rather than guessing at one.
      decipher.final()
    ]);
  } catch {
    throw new BackupUnreadable(
      "This backup could not be opened. Either the recovery phrase is wrong, or the file has been damaged or changed since it was written."
    );
  }

  const plain = gunzipSync(packed,
    limits === undefined ? undefined : { maxOutputLength: limits.maxSnapshotBytes });
  if (limits !== undefined && plain.byteLength !== header.plainBytes)
    throw new BackupUnreadable("The Book archive size does not match its authenticated header.");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, plain);

  diagnostics.info("backup", "restored a book from an encrypted copy", {
    schema: header.schema,
    bytes: plain.byteLength
  });
  return header;
}

function assertBoundedHeader(
  header: BackupHeader,
  headerLine: Buffer,
  limits: BackupByteLimits
): void {
  if (headerLine.byteLength > 1024 || header.format !== FORMAT ||
      !Number.isSafeInteger(header.schema) || header.schema < 1 ||
      !Number.isSafeInteger(header.plainBytes) || header.plainBytes <= 0 ||
      header.plainBytes > limits.maxSnapshotBytes ||
      typeof header.createdAt !== "string" || header.createdAt.length > 64 ||
      !canonicalBase64(header.salt, SALT_BYTES) ||
      !canonicalBase64(header.nonce, NONCE_BYTES))
    throw new BackupUnreadable("The bounded Book archive header is invalid or oversized.");
}

function canonicalBase64(value: unknown, expectedBytes: number): boolean {
  if (typeof value !== "string" || value.length > 64 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === expectedBytes && decoded.toString("base64") === value;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly at: string;
  /** What was checked, in the owner's words. */
  readonly summary: string;
  readonly header: BackupHeader | null;
}

/**
 * Restores the archive into a temp directory and opens it — task 0.4.
 *
 * This is the difference between having a backup and believing you have one. It
 * proves four things in order: the file parses, the key opens it, the bytes
 * inside are a real SQLite database that passes its own integrity check, and the
 * book inside actually holds records.
 *
 * Nothing here touches the live book, and the temp copy is destroyed before it
 * returns.
 */
export async function verifyBackup(
  path: string,
  secret: Buffer,
  limits?: BackupByteLimits
): Promise<VerifyResult> {
  const at = new Date().toISOString();
  const staging = await mkdtemp(join(tmpdir(), "cadrane-verify-"));
  const restored = join(staging, "book.sqlite");

  try {
    const header = await restoreBackup(path, restored, secret, limits);

    const db = new DatabaseSync(restored);
    try {
      const check = db.prepare("PRAGMA integrity_check").get() as
        | { integrity_check?: string }
        | undefined;
      if (check?.integrity_check !== "ok") {
        return {
          ok: false,
          at,
          header,
          summary: `The copy opened but SQLite reported a problem inside it: ${check?.integrity_check ?? "unknown"}.`
        };
      }

      const parties = db.prepare("SELECT COUNT(*) AS n FROM party").get() as { n: number };
      const bills = db.prepare("SELECT COUNT(*) AS n FROM invoice").get() as { n: number };

      /**
       * An empty archive is *reported*, not failed.
       *
       * This used to say counting the parties "distinguishes" a real backup
       * from one that restored to nothing — and then returned `ok: true` and
       * printed "read 0 parties" as though that were a clean pass. A verifier
       * whose reassuring sentence covers the case it was written to catch is
       * worse than one that does not check at all.
       *
       * It cannot be a failure, because a book that is genuinely empty — a new
       * install, nothing entered yet — has a perfectly good backup, and telling
       * that owner their archive is broken would be a lie in the other
       * direction. What it can do is stop calling it ordinary.
       */
      const empty = parties.n === 0 && bills.n === 0;
      return {
        ok: true,
        at,
        header,
        summary: empty
          ? "The backup opened and passed its integrity check, but there is nothing in it — no customers and no bills. That is correct only if your book was empty when this was taken. If it was not, keep this file and do not overwrite it."
          : `Opened the backup and read ${parties.n} ${
              parties.n === 1 ? "party" : "parties"
            } and ${bills.n} ${bills.n === 1 ? "bill" : "bills"} out of it.`
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      at,
      header: null,
      summary:
        error instanceof Error ? error.message : "The backup could not be opened."
    };
  } finally {
    if (limits === undefined) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Confirms two secrets are the same without leaking where they differ.
 *
 * Used when the owner types their phrase back to prove they wrote it down.
 * Constant-time out of habit rather than necessity — the comparison is local
 * and unhurried, but a security primitive that is sometimes constant-time is
 * one somebody will copy into a place where it matters.
 */
export function sameSecret(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function schemaVersionOf(file: string): number {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : 0;
  } finally {
    db.close();
  }
}
