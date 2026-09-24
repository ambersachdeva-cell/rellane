import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isTelegramToken,
  telegramTokenStore,
  type SafeStorage
} from "./telegram-token.js";

const REAL = "1234567890:AAHfSmartLookingTokenThatIsLongEnough_x";

/** A keychain that works, and records nothing in the clear. */
function working(): SafeStorage {
  return {
    isEncryptionAvailable: () => true,
    // Obviously not real encryption, but it must not leave the plaintext
    // readable in the file — otherwise the test below asserts nothing.
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8"),
    decryptString: (cipher) => {
      const text = cipher.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    }
  };
}

/** A Mac that will not hand out an encryption key. */
function refusing(): SafeStorage {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("should never be called");
    },
    decryptString: () => {
      throw new Error("should never be called");
    }
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cadrane-tgtoken-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("what counts as a token", () => {
  it("accepts what BotFather actually gives you", () => {
    expect(isTelegramToken(REAL)).toBe(true);
  });

  it("survives a paste that brought whitespace with it", () => {
    expect(isTelegramToken(`  ${REAL}\n`)).toBe(true);
  });

  it("refuses the shapes a paste usually goes wrong as", () => {
    expect(isTelegramToken("")).toBe(false);
    expect(isTelegramToken("hunter2")).toBe(false);
    expect(isTelegramToken(`"${REAL}"`)).toBe(false);
    expect(isTelegramToken("1234567890:short")).toBe(false);
  });
});

describe("storing it", () => {
  it("round-trips through the keychain and never writes it in the clear", () => {
    const store = telegramTokenStore(dir, working());
    store.write(`  ${REAL}  `);
    expect(store.read()).toBe(REAL);

    // The credential itself must not be findable in the file.
    const onDisk = readFileSync(join(dir, "telegram-token.enc"), "utf8");
    expect(onDisk).not.toContain("AAHfSmartLookingToken");
  });

  it("refuses rather than falling back to plain text", () => {
    // DESIGN.md principle 5. A silent fallback is how "encrypted" becomes a lie,
    // and the owner would have no way to tell which of the two they got.
    const store = telegramTokenStore(dir, refusing());
    expect(() => store.write(REAL)).toThrow(/plain text/);
    expect(existsSync(join(dir, "telegram-token.enc"))).toBe(false);
  });

  it("reads as off when the OS will not decrypt, rather than throwing at startup", () => {
    // Nothing at startup may block the window. A machine that lost its key comes
    // back as "Telegram is off", which a settings screen can explain.
    telegramTokenStore(dir, working()).write(REAL);
    expect(telegramTokenStore(dir, refusing()).read()).toBeNull();
  });

  it("is off before anything has been saved", () => {
    expect(telegramTokenStore(dir, working()).read()).toBeNull();
  });

  it("refuses a token that is not one, before it reaches the keychain", () => {
    const store = telegramTokenStore(dir, working());
    expect(() => store.write("not-a-token")).toThrow(/not a Telegram bot token/);
    expect(store.read()).toBeNull();
  });

  it("treats a tampered file as no token at all", () => {
    // Decrypting to something that is not a token means the store was edited or
    // the key rotated. Either way it is not a credential to hand to the network.
    writeFileSync(
      join(dir, "telegram-token.enc"),
      Buffer.from(`enc:${Buffer.from("garbage", "utf8").toString("base64")}`, "utf8")
    );
    expect(telegramTokenStore(dir, working()).read()).toBeNull();
  });

  it("forgets it when asked, and forgetting twice is not an error", () => {
    const store = telegramTokenStore(dir, working());
    store.write(REAL);
    store.clear();
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });
});


describe("not losing a token that already worked", () => {
  it("keeps the old one when encrypting the new one fails", () => {
    // writeFileSync truncates the moment it opens its target, so writing in
    // place meant a crash partway through left a zero-byte file where a working
    // credential had been — and the only way back is BotFather.
    const good = working();
    const store = telegramTokenStore(dir, good);
    store.write(REAL);

    const breaks: SafeStorage = {
      ...good,
      encryptString: () => {
        throw new Error("disk went away");
      }
    };
    const other = "9876543210:BBSomeOtherTokenLongEnoughToPassTheCheck";
    expect(() => telegramTokenStore(dir, breaks).write(other)).toThrow(/disk went away/);

    // The token that worked before still works.
    expect(telegramTokenStore(dir, good).read()).toBe(REAL);
  });

  it("leaves no temporary file behind on success", () => {
    telegramTokenStore(dir, working()).write(REAL);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("is readable only by its owner even when the file already existed", () => {
    // `mode` on writeFileSync applies only when the file is created. An existing
    // file kept whatever permissions it had, which could be 0644 — a credential
    // legible to every local user.
    const file = join(dir, "telegram-token.enc");
    writeFileSync(file, Buffer.from("enc:old", "utf8"), { mode: 0o644 });
    telegramTokenStore(dir, working()).write(REAL);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("what the shape check lets through", () => {
  it("accepts a bot id longer than twelve digits", () => {
    // Telegram ids are 64-bit and have been growing. A ceiling picked from
    // today's ids would start rejecting real tokens on a date nobody predicted.
    expect(isTelegramToken("1234567890123456789:AAHfSmartLookingTokenThatIsLongEnough")).toBe(true);
  });

  it("still refuses a secret that is obviously too long to be one", () => {
    expect(isTelegramToken(`1234567890:${"A".repeat(80)}`)).toBe(false);
  });
});
