/**
 * Opening the book, once, when the app starts.
 *
 * Everything under `book/` — the schema, the migration runner, integer-paise
 * money, FTS5 search, the encrypted archive, the recovery phrase, the restore
 * rehearsal — was written, tested and **never called**. `openBook` had no
 * callers outside its own tests. The foundation the whole product describes
 * itself as sitting on had never opened a database.
 *
 * That is the same failure as the automation engine and the model catalogue,
 * and it is the most consequential instance of it: a plan can tick "SQLite book,
 * schema v1, migration runner" on the strength of the code existing, and the
 * shipped app still has nowhere to put an invoice.
 *
 * ## The key
 *
 * A backup is encrypted with a key of Rellane's own, which is **wrapped by the
 * macOS Keychain** through Electron's `safeStorage` and written to
 * `backup.key` beside the book. Two properties matter and are easy to lose:
 *
 *   - **The key is never at rest in plaintext.** The file holds ciphertext; the
 *     thing that unwraps it lives in the Keychain and never in the file. So the
 *     file sitting next to `book.sqlite` is worth nothing on its own — which is
 *     the property, and it is not the same as the file being kept elsewhere.
 *     (An earlier version of this note claimed the key was "never written
 *     beside the data it protects", which is plainly untrue of a file in the
 *     same directory and gave a reader the wrong model of where the risk is.)
 *   - **A machine without Keychain encryption is told, not silently downgraded.**
 *     Writing an unencrypted archive under the same file extension would be the
 *     worst possible outcome: the owner would believe their records were
 *     protected because the app said "backed up".
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { openBook } from "./database.js";
import { RECOVERY_BYTES } from "./recovery.js";
import { diagnostics } from "../foundations/diagnostics.js";

/** What `safeStorage` gives us, narrowed so this is testable without Electron. */
export interface KeyVault {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export class BackupKeyUnavailable extends Error {}

/**
 * The key backups are encrypted with, created once and kept wrapped.
 *
 * Refuses rather than falling back. An unencrypted archive that looks exactly
 * like an encrypted one is worse than no backup at all, because the owner acts
 * on the belief that it is safe.
 */
export async function backupSecret(dataDir: string, vault: KeyVault): Promise<Buffer> {
  if (!vault.isEncryptionAvailable()) {
    throw new BackupKeyUnavailable(
      "This Mac cannot give Rellane a Keychain key, so backups would not be encrypted. Rellane will not write an unencrypted copy of your records."
    );
  }

  const file = join(dataDir, "backup.key");
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    // Same reasoning as the settings store: a transient read failure must not
    // look like "no key yet", because the next write would replace the key and
    // orphan every backup taken with the old one.
    throw error;
  });

  if (existing !== null) {
    try {
      return Buffer.from(vault.decryptString(Buffer.from(existing, "base64")), "hex");
    } catch {
      /**
       * The key is there and will not open. **Do not quietly mint a new one.**
       *
       * `safeStorage` ties its Keychain entry to the app's identity, so renaming
       * or re-signing the app makes existing ciphertext undecryptable — observed
       * on 2026-09-02 after the `@switchboard/*` → `@cadrane/*` rename. Every
       * archive already written was encrypted with the old key.
       *
       * Minting a replacement would make the app look fixed while silently
       * orphaning every existing backup: the owner would carry on with a folder
       * full of files that can never be restored, and find out only when they
       * needed one. Refusing keeps the old key file exactly where it is, so a
       * future version can still recover it.
       */
      throw new BackupKeyUnavailable(
        "The key your existing backups were encrypted with can no longer be opened, which happens when the app is renamed or re-signed. Rellane will not quietly start a new key, because that would leave every backup you already have unreadable. The old key is still on this Mac at backup.key — keep it. Move your existing backups somewhere safe, then delete backup.key to start a new one."
      );
    }
  }

  const secret = randomBytes(RECOVERY_BYTES);
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, vault.encryptString(secret.toString("hex")).toString("base64"), {
    mode: 0o600
  });
  // Said accurately: the key was made here and written wrapped. The Keychain
  // holds what unwraps it, not the key itself, and a log that blurs the two
  // teaches whoever reads it the wrong thing about where the secret lives.
  diagnostics.info("book", "created a backup key, wrapped by the Keychain", {});
  return secret;
}

export interface OpenedBook {
  readonly db: DatabaseSync;
  /** Set when the schema moved, so the owner can be told what happened. */
  readonly migrated: { readonly from: number; readonly to: number; readonly backup: string | null } | null;
}

/**
 * Opens the book at its usual place, running migrations.
 *
 * The pre-migration backup is taken by `openBook` itself and its path is
 * carried out here rather than swallowed: a migration that quietly took a
 * safety copy the owner cannot find is a safety copy that does not exist.
 */
export async function openTheBook(dataDir: string): Promise<OpenedBook> {
  const result = await openBook(join(dataDir, "book.sqlite"));

  if (result.from !== result.to) {
    diagnostics.info("book", "schema migrated", {
      from: result.from,
      to: result.to,
      // The path, not just "a backup was taken" — the whole point is that it
      // can be found afterwards.
      backup: result.backup ?? "none needed"
    });
  }

  return {
    db: result.db,
    migrated:
      result.from === result.to
        ? null
        : { from: result.from, to: result.to, backup: result.backup }
  };
}
