/**
 * Secrets. Bot tokens, connector credentials, licence entitlements.
 *
 * The bar Amber set is the right one: not unbreakable, but expensive enough
 * that it takes a real attacker rather than someone poking around. So:
 *
 *   1. Nothing sensitive is ever written to a file we control in plaintext.
 *      Encryption happens through Electron `safeStorage`, which on macOS is
 *      backed by the Keychain and an OS-held key. Reading it requires code
 *      running as that user on that machine — not a copied file.
 *
 *   2. Ciphertext is never stored next to anything that hints at its content,
 *      and never in localStorage. The renderer cannot read secrets at all;
 *      only the main process can, and it hands out capabilities rather than
 *      values.
 *
 *   3. When the OS cannot encrypt, we refuse to store rather than falling back
 *      to plaintext. A silent downgrade is how "encrypted" becomes a lie —
 *      the previous build derived its "military-grade" key from a constant
 *      compiled into the bundle, which is exactly that failure.
 *
 * What this does NOT defend against, stated plainly so nobody is surprised:
 * an attacker already running code as this user can ask the Keychain for the
 * same values we can. That is true of every application on the machine.
 */

import { safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class SecretsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsUnavailable";
  }
}

export interface SecretStoreOptions {
  /** Directory for the encrypted blob. Normally app.getPath("userData"). */
  readonly directory: string;
  /** Injectable so the store can be tested without an Electron runtime. */
  readonly crypto?: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(cipher: Buffer): string;
  };
}

interface Envelope {
  readonly version: 1;
  /** base64 of the OS-encrypted payload. */
  readonly payload: string;
}

/**
 * A small encrypted key–value store.
 *
 * Everything lives in one blob rather than a file per secret: a directory
 * listing that reveals *which* services a user has connected is itself
 * information worth not leaking.
 */
export class SecretStore {
  private readonly file: string;
  private readonly crypto: NonNullable<SecretStoreOptions["crypto"]>;
  private cache: Record<string, string> | null = null;
  private unreadable = false;

  constructor(options: SecretStoreOptions) {
    this.file = join(options.directory, "secrets.bin");
    this.crypto = options.crypto ?? {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    };
  }

  /** True when the OS will give us a key. False means we refuse to store. */
  available(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  async get(key: string): Promise<string | null> {
    const all = await this.load();
    // `Object.hasOwn`, not a bare index. The cache is an ordinary object, so
    // `get("toString")` returned a *function* — typed as `string | null` and
    // handed to whatever asked for a secret.
    return Object.hasOwn(all, key) ? (all[key] ?? null) : null;
  }

  /** History verification must distinguish a missing key from unreadable storage.
   * This reads only the named value and never initializes or repairs the store. */
  async getForVerification(key: string): Promise<string | null> {
    const all = await this.load();
    this.assertReadable();
    if (!Object.hasOwn(all, key)) return null;
    const value = all[key];
    if (typeof value !== "string") {
      throw new SecretsUnavailable("A stored verification value is invalid. The original store has been kept.");
    }
    return value;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertAvailable();
    const all = await this.load();
    // Written to a copy, and the cache is only replaced once the disk write has
    // succeeded. Mutating in place first left the in-memory store holding a
    // secret that was never persisted — so `get` returned it until the next
    // launch, and then it was gone.
    const next = { ...all, [key]: value };
    await this.persist(next);
    this.cache = next;
  }

  async delete(key: string): Promise<void> {
    const all = await this.load();
    if (!Object.hasOwn(all, key)) {
      // Nothing here to remove, but the file may still hold it: when the store
      // could not be decrypted, `load` hands back an empty object and every key
      // looks absent. Reporting success then would say "deleted" about a secret
      // still on disk.
      this.assertReadable();
      return;
    }
    const next = { ...all };
    delete next[key];
    await this.persist(next);
    this.cache = next;
  }

  /** Refuses to claim anything about a store that would not open. */
  private assertReadable(): void {
    if (this.unreadable) {
      throw new SecretsUnavailable(
        "The stored secrets could not be read on this Mac, so Rellane cannot say what is in them or change them. Nothing has been deleted."
      );
    }
  }

  /**
   * Names only — never values.
   *
   * This is what the settings screen renders. There is deliberately no method
   * that returns every secret at once, because nothing in the product needs
   * one and its existence is a liability.
   */
  async names(): Promise<readonly string[]> {
    return Object.keys(await this.load()).sort();
  }

  /** Forgets everything. Used by "delete my data". */
  async wipe(): Promise<void> {
    this.cache = {};
    this.unreadable = false;
    await rm(this.file, { force: true });
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new SecretsUnavailable(
        "This Mac will not provide an encryption key right now, so Rellane will not store the secret at all. It never falls back to writing it in plain text."
      );
    }
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache !== null) {
      return this.cache;
    }
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
        this.unreadable = false;
        return this.cache;
      }
      throw error;
    }
    try {
      const envelope = JSON.parse(raw) as Envelope;
      if (envelope.version !== 1 || typeof envelope.payload !== "string") {
        throw new Error("unrecognised envelope");
      }
      const plain = this.crypto.decryptString(Buffer.from(envelope.payload, "base64"));
      const parsed: unknown = JSON.parse(plain);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("unrecognised protected store");
      }
      this.cache = parsed as Record<string, string>;
      this.unreadable = false;
    } catch {
      // A blob we cannot decrypt is treated as absent rather than deleted.
      // It usually means a restored backup from another machine, and throwing
      // the user's file away because we could not read it is not our call.
      this.cache = {};
      this.unreadable = true;
    }
    return this.cache;
  }

  private async persist(all: Record<string, string>): Promise<void> {
    this.assertAvailable();
    if (this.unreadable) {
      throw new SecretsUnavailable(
        "Existing secrets on this Mac cannot be decrypted. Rellane will not overwrite them."
      );
    }
    await mkdir(dirname(this.file), { recursive: true });
    const cipher = this.crypto.encryptString(JSON.stringify(all));
    const envelope: Envelope = { version: 1, payload: cipher.toString("base64") };
    await writeFile(this.file, JSON.stringify(envelope), { mode: 0o600 });
    this.cache = all;
  }
}

/** Stable names, so a typo cannot silently create a second empty secret. */
export const SECRET_KEYS = Object.freeze({
  telegramBotToken: "channel.telegram.botToken",
  telegramOwnerChatId: "channel.telegram.ownerChatId",
  licenceToken: "licence.entitlement"
});
