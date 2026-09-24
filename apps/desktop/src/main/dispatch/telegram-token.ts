/**
 * Where Mark's bot token lives, and what happens when it cannot live anywhere.
 *
 * A bot token is a credential: anyone holding it can read every message sent to
 * the bot and post as it. So it goes through `safeStorage`, which is the OS
 * keychain, and never into `settings.json` beside the theme and the hotkeys.
 *
 * When the OS will not give us an encryption key we **refuse to store it at
 * all** rather than falling back to plaintext (DESIGN.md principle 5). A silent
 * fallback is how "encrypted" becomes a lie, and the owner would have no way of
 * knowing which of the two they got. Telegram then stays switched off, which is
 * a visible, recoverable state — unlike a token sitting unencrypted on disk.
 *
 * `SafeStorage` is injected rather than imported from electron so this is
 * testable off the main process and so a machine without encryption can be
 * exercised deliberately instead of only encountered.
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export interface TelegramTokenStore {
  /** The token, or null when there is none or it cannot be read. */
  read(): string | null;
  /** Throws when the OS cannot encrypt, or when the token is not one. */
  write(token: string): void;
  clear(): void;
}

/**
 * Telegram issues `<bot id>:<url-safe secret>`.
 *
 * Checked because the common failure is a paste that picked up a newline or the
 * surrounding quotes, and a token rejected now is a sentence the owner can act
 * on. A token rejected later is a bot that silently never answers.
 *
 * Deliberately looser than the format Telegram issues today. Bot ids are 64-bit
 * and have been growing, so a 12-digit ceiling would start rejecting real tokens
 * at some point nobody would predict; the secret is bounded rather than pinned
 * to exactly 35 characters for the same reason. This check exists to catch a bad
 * paste, not to re-implement Telegram's issuing rules — a malformed token that
 * slips through gets a clear refusal from the API on first use, while a valid
 * one rejected here is a dead end the owner cannot debug.
 */
const TOKEN_SHAPE = /^\d{6,19}:[A-Za-z0-9_-]{30,60}$/;

export function isTelegramToken(candidate: string): boolean {
  return TOKEN_SHAPE.test(candidate.trim());
}

export function telegramTokenStore(userDataDir: string, storage: SafeStorage): TelegramTokenStore {
  const file = join(userDataDir, "telegram-token.enc");

  return {
    read(): string | null {
      try {
        // Inside the try on purpose. `isEncryptionAvailable` reaches the OS
        // keychain and can throw when its daemon is unreachable; this runs on
        // the startup path, where nothing may block the window.
        if (!storage.isEncryptionAvailable()) {
          return null;
        }
        const plain = storage.decryptString(readFileSync(file));
        // A file that decrypts to something that is not a token means the store
        // has been tampered with or the key has rotated. Either way it is not a
        // credential we should hand to a network call.
        return isTelegramToken(plain) ? plain.trim() : null;
      } catch {
        // No file yet, or it will not decrypt. Both mean "Telegram is off",
        // which is a state the settings screen can explain and the owner can fix.
        return null;
      }
    },

    write(token: string): void {
      const trimmed = token.trim();
      if (!isTelegramToken(trimmed)) {
        throw new Error("That is not a Telegram bot token. BotFather gives you one like 1234567890:AA…");
      }
      if (!storage.isEncryptionAvailable()) {
        throw new Error(
          "This Mac will not give Rellane an encryption key, so the token cannot be stored safely. Telegram stays off rather than keeping it in plain text."
        );
      }
      // Written to a temporary file and renamed, because `writeFileSync`
      // truncates its target the moment it opens it: a crash or a full disk
      // partway through would leave a zero-byte file where a working token was,
      // and the owner would have no way back but BotFather. Rename is atomic on
      // the same filesystem, so the token is either the old one or the new one.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, storage.encryptString(trimmed), { mode: 0o600 });
      // `mode` on writeFileSync only applies when the file is created, so an
      // existing file keeps whatever permissions it already had. Set it
      // explicitly or a credential can sit at 0644 for every local user.
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    },

    clear(): void {
      rmSync(file, { force: true });
    }
  };
}
