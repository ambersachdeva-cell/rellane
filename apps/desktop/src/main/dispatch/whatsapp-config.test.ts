import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whatsAppConfigStore, type WhatsAppConfig } from "./whatsapp-config.js";
import type { SafeStorage } from "./telegram-token.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-config-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Reversible rather than real, so a test can read what was written. */
function workingKeychain(): SafeStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (cipher) => cipher.toString("utf8").replace(/^enc:/u, "")
  };
}

function refusingKeychain(): SafeStorage {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error("should never be called"); },
    decryptString: () => { throw new Error("should never be called"); }
  };
}

const good: WhatsAppConfig = {
  token: "EAAG".padEnd(64, "x"),
  phoneNumberId: "123456789012345",
  businessAccountId: "987654321098765"
};

describe("whatsAppConfigStore", () => {
  it("keeps what it was given and hands it back", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    store.write(good);
    expect(store.read()).toEqual(good);
  });

  it("is off, not broken, before anything has been saved", () => {
    expect(whatsAppConfigStore(dir, workingKeychain()).read()).toBeNull();
  });

  /**
   * The rule that matters: a Mac that will not encrypt gets no stored token at
   * all, rather than one sitting in plain text beside the theme settings.
   */
  it("refuses to store anything when this Mac will not encrypt", () => {
    const store = whatsAppConfigStore(dir, refusingKeychain());
    expect(() => store.write(good)).toThrow(/plain text/);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("names the short temporary token as the likely mistake", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    expect(() => store.write({ ...good, token: "EAAGshort" })).toThrow(/expires overnight/);
  });

  it("catches a phone number pasted where its id belongs", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    expect(() => store.write({ ...good, phoneNumberId: "+919876543210" })).toThrow(/not the phone number itself/);
  });

  it("keeps the mailbox when it is given one", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    const withMailbox: WhatsAppConfig = {
      ...good,
      mailboxUrl: "https://mailbox.example.workers.dev",
      collectSecret: "s".repeat(32)
    };
    store.write(withMailbox);
    expect(store.read()).toEqual(withMailbox);
  });

  /**
   * Send-only is a complete state, not a half-configured one — it is what works
   * with no public address at all. So the mailbox fields are absent, never
   * present and empty, because the poller decides whether to run by asking.
   */
  it("leaves the mailbox absent rather than empty when there is none", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    store.write(good);
    const read = store.read();
    expect(read).not.toBeNull();
    expect("mailboxUrl" in (read as object)).toBe(false);
    expect("collectSecret" in (read as object)).toBe(false);
  });

  it("refuses a mailbox that would carry a customer's message in clear", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    expect(() =>
      store.write({ ...good, mailboxUrl: "http://mailbox.example.com", collectSecret: "s".repeat(32) })
    ).toThrow(/https/);
  });

  it("refuses a collect secret too short to be one", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    expect(() =>
      store.write({ ...good, mailboxUrl: "https://m.example.workers.dev", collectSecret: "abc" })
    ).toThrow(/openssl rand/);
  });

  /**
   * A file that decrypts to something malformed means the store was tampered
   * with or the key rotated. Either way it is not a credential to hand to a
   * network call.
   */
  it("treats a tampered record as no configuration at all", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    store.write(good);
    fs.writeFileSync(path.join(dir, "whatsapp-config.enc"), Buffer.from('enc:{"token":"x"}', "utf8"));
    expect(store.read()).toBeNull();
  });

  it("forgets everything when told to", () => {
    const store = whatsAppConfigStore(dir, workingKeychain());
    store.write(good);
    store.clear();
    expect(store.read()).toBeNull();
  });
});
