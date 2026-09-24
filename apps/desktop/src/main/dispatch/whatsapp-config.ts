/**
 * Where the WhatsApp credentials live, and what happens when they cannot live
 * anywhere.
 *
 * Five values rather than Telegram's one, and they are not equally dangerous.
 * The access token is the credential: anyone holding it can send as the business
 * to any number, which for an agency is the ability to say anything to every
 * customer it has. The rest are addresses. They are kept together anyway,
 * encrypted as one record, because a half-configured WhatsApp is a send that
 * fails at the worst moment rather than one that never started.
 *
 * Same refusal as the bot token: when the OS will not give us an encryption key
 * we store nothing rather than falling back to plain text. A token sitting
 * unencrypted beside the theme settings is how "encrypted" becomes a lie the
 * owner has no way to detect.
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SafeStorage } from "./telegram-token.js";

export interface WhatsAppConfig {
  /** The System User token. Never the 24-hour one from the dashboard. */
  readonly token: string;
  /** Numeric id of the registered number. Not the phone number itself. */
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  /**
   * Where inbound messages wait. Absent means send-only, which is a complete
   * and useful state — it is what works without any public address at all.
   */
  readonly mailboxUrl?: string;
  /** Proves to the mailbox that this Mac is the one collecting. */
  readonly collectSecret?: string;
}

export interface WhatsAppConfigStore {
  read(): WhatsAppConfig | null;
  /** Throws when the OS cannot encrypt, or when a value is obviously not one. */
  write(config: WhatsAppConfig): void;
  clear(): void;
}

/**
 * Meta's System User tokens are long opaque strings. Checked only for the shape
 * of a paste that went wrong — a newline, surrounding quotes, an empty field —
 * rather than re-implementing Meta's issuing rules, which are undocumented and
 * change. A malformed token that slips through gets a clear refusal from the
 * Graph API on first use; a valid one rejected here is a dead end nobody can
 * debug.
 */
export function looksLikeToken(candidate: string): boolean {
  const trimmed = candidate.trim();
  return trimmed.length >= 40 && !/\s/u.test(trimmed);
}

/** Meta's ids are numeric strings, long enough that a truncated paste shows. */
export function looksLikeMetaId(candidate: string): boolean {
  return /^\d{10,25}$/u.test(candidate.trim());
}

/**
 * The mailbox has to be HTTPS and it has to be somewhere. A plain-http address
 * would carry a customer's message and the collect secret in clear.
 */
export function looksLikeMailboxUrl(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    return new URL(trimmed).protocol === "https:";
  } catch {
    return false;
  }
}

function readable(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function whatsAppConfigStore(
  userDataDir: string,
  storage: SafeStorage
): WhatsAppConfigStore {
  const file = join(userDataDir, "whatsapp-config.enc");

  return {
    read(): WhatsAppConfig | null {
      try {
        // Inside the try: isEncryptionAvailable reaches the OS keychain and can
        // throw when its daemon is unreachable, and this runs at startup where
        // nothing may block the window.
        if (!storage.isEncryptionAvailable()) {
          return null;
        }
        const parsed: unknown = JSON.parse(storage.decryptString(readFileSync(file)));
        if (typeof parsed !== "object" || parsed === null) {
          return null;
        }
        const record = parsed as Record<string, unknown>;
        const token = readable(record["token"]);
        const phoneNumberId = readable(record["phoneNumberId"]);
        const businessAccountId = readable(record["businessAccountId"]);
        // A record that decrypts to something malformed means the store was
        // tampered with or the key rotated. Either way it is not a credential to
        // hand to a network call.
        if (!looksLikeToken(token) || !looksLikeMetaId(phoneNumberId)) {
          return null;
        }
        const mailboxUrl = readable(record["mailboxUrl"]);
        const collectSecret = readable(record["collectSecret"]);
        return {
          token,
          phoneNumberId,
          businessAccountId,
          // Absent, never present-and-empty: the poller decides whether to run
          // at all by asking whether these exist.
          ...(looksLikeMailboxUrl(mailboxUrl) && collectSecret.length > 0
            ? { mailboxUrl, collectSecret }
            : {})
        };
      } catch {
        // No file yet, or it will not decrypt. Both mean WhatsApp is off, which
        // is a state the screen can explain and the owner can fix.
        return null;
      }
    },

    write(config: WhatsAppConfig): void {
      if (!looksLikeToken(config.token)) {
        throw new Error(
          "That does not look like an access token. Meta gives you a long one from Business Settings — not the short temporary one on the app dashboard, which expires overnight."
        );
      }
      if (!looksLikeMetaId(config.phoneNumberId)) {
        throw new Error(
          "The phone number ID is the long number from the API Setup page, not the phone number itself."
        );
      }
      if (config.businessAccountId.trim().length > 0 && !looksLikeMetaId(config.businessAccountId)) {
        throw new Error("The WhatsApp business account ID should be a long number.");
      }
      const wantsMailbox =
        config.mailboxUrl !== undefined || config.collectSecret !== undefined;
      if (wantsMailbox) {
        if (!looksLikeMailboxUrl(config.mailboxUrl ?? "")) {
          throw new Error("The mailbox address has to start with https://.");
        }
        if ((config.collectSecret ?? "").trim().length < 16) {
          throw new Error(
            "The collect secret is too short to be one. Generate it with: openssl rand -hex 32"
          );
        }
      }
      if (!storage.isEncryptionAvailable()) {
        throw new Error(
          "This Mac will not give Rellane an encryption key, so the token cannot be stored safely. WhatsApp stays off rather than keeping it in plain text."
        );
      }

      const record: Record<string, string> = {
        token: config.token.trim(),
        phoneNumberId: config.phoneNumberId.trim(),
        businessAccountId: config.businessAccountId.trim()
      };
      if (wantsMailbox) {
        record["mailboxUrl"] = (config.mailboxUrl ?? "").trim();
        record["collectSecret"] = (config.collectSecret ?? "").trim();
      }

      // Temporary file then rename: writeFileSync truncates its target the
      // moment it opens it, so a crash partway through would leave a zero-byte
      // file where a working token was, and the way back is regenerating it in
      // Meta's dashboard. Rename is atomic on one filesystem.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, storage.encryptString(JSON.stringify(record)), { mode: 0o600 });
      // mode on writeFileSync only applies when the file is created, so an
      // existing one keeps whatever permissions it had. Set it explicitly or a
      // credential sits at 0644 for every local user.
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    },

    clear(): void {
      rmSync(file, { force: true });
    }
  };
}
