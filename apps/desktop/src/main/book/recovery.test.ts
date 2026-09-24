import { describe, expect, it } from "vitest";
import {
  BadRecoveryPhrase,
  fromPhrase,
  newRecoverySecret,
  phraseMatches,
  RECOVERY_BYTES,
  toPhrase
} from "./recovery.js";

describe("the recovery phrase", () => {
  it("round-trips a secret", () => {
    const secret = newRecoverySecret();

    expect(fromPhrase(toPhrase(secret))).toEqual(secret);
  });

  it("is 32 characters in groups of four", () => {
    // Grouped because an unbroken 32-character string is transcribed wrongly,
    // and this gets read aloud down a phone line.
    const phrase = toPhrase(newRecoverySecret());

    expect(phrase).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/u);
    expect(phrase.replace(/-/gu, "")).toHaveLength(32);
  });

  it("never contains the characters people confuse", () => {
    // Crockford's alphabet drops I, L, O and U so there is no 1/I and no 0/O.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(toPhrase(newRecoverySecret())).not.toMatch(/[ILOU]/u);
    }
  });

  it("accepts it back the way a person actually types it", () => {
    const secret = newRecoverySecret();
    const phrase = toPhrase(secret);

    expect(fromPhrase(phrase.toLowerCase())).toEqual(secret);
    expect(fromPhrase(phrase.replace(/-/gu, ""))).toEqual(secret);
    expect(fromPhrase(phrase.replace(/-/gu, " "))).toEqual(secret);
    expect(fromPhrase(`  ${phrase}  `)).toEqual(secret);
  });

  it("forgives the classic mistypings", () => {
    const secret = Buffer.alloc(RECOVERY_BYTES, 0);
    const phrase = toPhrase(secret); // all zeroes → all "0"

    // Someone reading it off paper writes O for 0. Someone reading a 1 writes I
    // or l. The day this is typed is not the day to be strict about it.
    expect(fromPhrase(phrase.replace(/0/gu, "O"))).toEqual(secret);
    expect(fromPhrase(phrase.replace(/0/gu, "o"))).toEqual(secret);
  });

  it("says what is wrong rather than failing silently", () => {
    // Every caller is about to decrypt a business with the result, so a null
    // would become a confusing decryption failure three layers away.
    expect(() => fromPhrase("too-short")).toThrow(BadRecoveryPhrase);
    expect(() => fromPhrase("too-short")).toThrow(/32 characters/u);
  });

  it("names the character it could not read", () => {
    const phrase = toPhrase(newRecoverySecret());
    const broken = `${phrase.slice(0, -1)}!`;

    expect(() => fromPhrase(broken)).toThrow(/"!" is not part of a recovery phrase/u);
  });

  it("refuses to print a phrase for a secret of the wrong size", () => {
    expect(() => toPhrase(Buffer.alloc(4))).toThrow(BadRecoveryPhrase);
  });

  it("confirms a phrase the owner typed back", () => {
    const secret = newRecoverySecret();

    expect(phraseMatches(toPhrase(secret), secret)).toBe(true);
    expect(phraseMatches(toPhrase(newRecoverySecret()), secret)).toBe(false);
    // A wrong phrase is answered, not thrown at the screen.
    expect(phraseMatches("nonsense", secret)).toBe(false);
  });

  it("gives a different secret every time", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      seen.add(newRecoverySecret().toString("hex"));
    }
    expect(seen.size).toBe(500);
  });
});
