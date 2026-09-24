/**
 * The recovery phrase — the way back in when the Mac is gone.
 *
 * Backups are encrypted, and the key lives in the Keychain so that a scheduled
 * backup can run without asking anybody for anything. But a Keychain key is
 * bound to *this* Mac, and the day the backup matters most is the day this Mac
 * is at the bottom of a drain. A backup that can only be opened by the machine
 * that made it is not a backup; it is a second copy of a single point of
 * failure.
 *
 * So the archive key is derived from a 160-bit secret that is *also* printed as
 * a phrase the owner keeps on paper. Either half opens a backup: the Keychain,
 * silently, on this machine; the phrase, by hand, on any machine.
 *
 * The encoding is Crockford's base32, which exists precisely for things humans
 * copy off paper: no I, L, O or U, so there is no 1/I and no 0/O confusion, and
 * nothing accidentally spells a word. Decoding is deliberately forgiving —
 * lowercase, spaces, hyphens and the classic mistypings are all accepted,
 * because the person typing it is having the worst day of their business year.
 */

import { randomBytes } from "node:crypto";

/** 160 bits: far beyond brute force, and exactly 32 characters to write down. */
export const RECOVERY_BYTES = 20;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * What a person types back, forgivingly mapped.
 *
 * O → 0 and I/L → 1 are Crockford's own rules. U is excluded from the alphabet
 * so it cannot appear in a real phrase; anyone typing one has misread a V.
 */
const FORGIVE: Readonly<Record<string, string>> = {
  O: "0",
  I: "1",
  L: "1",
  U: "V"
};

export class BadRecoveryPhrase extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRecoveryPhrase";
  }
}

/** A fresh secret. The only place backup keys are born. */
export function newRecoverySecret(): Buffer {
  return randomBytes(RECOVERY_BYTES);
}

/**
 * Groups of four, hyphenated: `CDRN-8ZQ4-...`
 *
 * Grouped because an unbroken 32-character string is transcribed wrongly and
 * checked wrongly, and this is read aloud down a phone line more often than
 * anyone would like.
 */
export function toPhrase(secret: Buffer): string {
  if (secret.byteLength !== RECOVERY_BYTES) {
    throw new BadRecoveryPhrase(
      `A recovery secret is ${RECOVERY_BYTES} bytes; this one is ${secret.byteLength}.`
    );
  }

  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 160 bits divides by 5 exactly, so there is never a remainder to pad.

  return (out.match(/.{1,4}/gu) ?? []).join("-");
}

/**
 * Reads a phrase back, accepting how it was actually written down.
 *
 * Throws rather than returning null: every caller here is about to decrypt
 * somebody's business with the result, and a silent null would become a
 * confusing decryption failure three layers away from the typo that caused it.
 */
export function fromPhrase(phrase: string): Buffer {
  const cleaned = phrase
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .split("")
    .map((character) => FORGIVE[character] ?? character)
    .join("");

  const expected = (RECOVERY_BYTES * 8) / 5;
  if (cleaned.length !== expected) {
    throw new BadRecoveryPhrase(
      `A recovery phrase has ${expected} characters, not counting the hyphens. This one has ${cleaned.length}.`
    );
  }

  const out = Buffer.alloc(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let written = 0;

  for (const character of cleaned) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) {
      throw new BadRecoveryPhrase(
        `"${character}" is not part of a recovery phrase. Check for a mistyped character.`
      );
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out[written] = (value >>> (bits - 8)) & 0xff;
      written += 1;
      bits -= 8;
    }
  }

  return out;
}

/** True when a phrase reads back as itself. Used to make the owner confirm it. */
export function phraseMatches(phrase: string, secret: Buffer): boolean {
  try {
    return fromPhrase(phrase).equals(secret);
  } catch {
    return false;
  }
}
