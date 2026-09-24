/**
 * Checking a GSTIN, which turns a reading into a fact.
 *
 * Every Indian GSTIN carries a check character. Fifteen characters: two for the
 * state, ten for the PAN, one for the entity number, a literal `Z`, and a
 * checksum over the first fourteen. So a GSTIN that came off a photograph can
 * be **verified rather than believed** — for nothing, offline, in twenty lines.
 *
 * That matters more here than it looks. The document reader (D-088) lifts
 * GSTINs off photographs, and OCR confuses `0` with `O` and `1` with `I`
 * exactly where a GSTIN mixes digits and letters. A wrong GSTIN on a bill is not
 * a typo — it is the field the tax department matches on, and a mismatch is how
 * an input-tax credit gets refused months later.
 *
 * ## What it does not do
 *
 * It does not say the business exists, or that the number belongs to whoever is
 * on the letterhead. It says the number is *well-formed* — which is precisely
 * the class of error a reading introduces, and not the class a fraudster does.
 * Saying more than that would be the confident wrongness this codebase keeps
 * writing rules against.
 */

/** The alphabet the checksum is computed in: 0–9 then A–Z, base 36. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * State codes that actually exist.
 *
 * 01–38 are the states and union territories. 97 is "Other Territory" and 99 is
 * Centre Jurisdiction, which is where a foreign supplier of digital services is
 * registered. **96 is not a GSTIN prefix at all** — it is a place-of-supply code
 * for exports, and accepting it here meant waving through a number that cannot
 * exist while rejecting the 99s that do.
 *
 * Worth catching because the first two characters decide whether a bill carries
 * CGST+SGST or IGST — the one place a wrong digit changes the tax rather than
 * just the identifier.
 */
function knownState(code: string): boolean {
  const n = Number.parseInt(code, 10);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

/**
 * The shape of a GSTIN.
 *
 * The thirteenth character is the entity number — how many registrations that
 * PAN holds in that state — and it counts `1`–`9` then `A`–`Z`. **Zero is never
 * one**, so accepting it let through a number that cannot exist.
 */
export const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/u;

export interface GstinCheck {
  readonly ok: boolean;
  /** Normalised: upper case, spaces removed. Empty when unusable. */
  readonly gstin: string;
  /** The state code, when the shape was right. */
  readonly stateCode: string | null;
  /** What is wrong, in the owner's words. Null when nothing is. */
  readonly problem: string | null;
}

/**
 * The check character for the first fourteen, by the GSTN's own rule.
 *
 * Each character's value is multiplied by 1 or 2 alternately; each product is
 * folded by dividing by 36 and adding the remainder; the sum's complement to
 * the next multiple of 36 is the check character. It is Luhn, in base 36.
 */
export function checkCharacter(first14: string): string | null {
  // The weights alternate by position, so a string of the wrong length is not
  // merely unusual — it is computed against the wrong weights and returns a
  // confident wrong answer. `""` returned `"0"`.
  if (first14.length !== 14) {
    return null;
  }
  let sum = 0;
  for (let index = 0; index < first14.length; index += 1) {
    const value = ALPHABET.indexOf(first14[index] ?? "");
    if (value === -1) {
      return null;
    }
    const weighted = value * (index % 2 === 0 ? 1 : 2);
    // Folded rather than carried: a product over 35 contributes its quotient
    // and its remainder, which is what makes this base 36 rather than base 10.
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36] ?? null;
}

/**
 * Checks one GSTIN.
 *
 * Never throws, and never claims more than arithmetic supports: a `true` here
 * means the number is well-formed, not that the business is real.
 */
export function checkGstin(raw: unknown): GstinCheck {
  if (typeof raw !== "string") {
    return { ok: false, gstin: "", stateCode: null, problem: "That is not a GSTIN." };
  }
  // Spaces and hyphens are how people write one on paper, and how OCR returns
  // one that spanned a table border.
  const gstin = raw.replace(/[\s-]/gu, "").toUpperCase();

  if (gstin.length !== 15) {
    return {
      ok: false,
      gstin,
      stateCode: null,
      problem: `A GSTIN is 15 characters; that is ${gstin.length}.`
    };
  }
  if (!GSTIN_SHAPE.test(gstin)) {
    return {
      ok: false,
      gstin,
      stateCode: null,
      // Named, because on a photographed bill this is almost always a letter
      // read as a digit and somebody can fix it by looking again.
      problem:
        "That is not the shape of a GSTIN — two digits, five letters, four digits, a letter, one character, a Z, then one more. Check it against the bill."
    };
  }

  const stateCode = gstin.slice(0, 2);
  if (!knownState(stateCode)) {
    return {
      ok: false,
      gstin,
      stateCode,
      problem: `${stateCode} is not a state code. The first two digits decide whether a bill is CGST and SGST or IGST, so this one is worth a second look.`
    };
  }

  const expected = checkCharacter(gstin.slice(0, 14));
  if (expected === null || expected !== gstin[14]) {
    return {
      ok: false,
      gstin,
      stateCode,
      problem:
        "The check character does not match, so at least one character is wrong. This is usually a 0 read as an O, or a 1 read as an I."
    };
  }

  return { ok: true, gstin, stateCode, problem: null };
}

/**
 * Whether a bill between these two is CGST+SGST or IGST.
 *
 * The one rule the state code exists for, and the one a person gets wrong when
 * they are entering bills quickly: same state is split into central and state
 * tax, different states is a single integrated tax. Getting it backwards makes a
 * return not add up.
 */
export function taxKind(seller: string, buyer: string): "cgst-sgst" | "igst" | "unknown" {
  const a = checkGstin(seller);
  const b = checkGstin(buyer);
  if (!a.ok || !b.ok) {
    return "unknown";
  }
  return a.stateCode === b.stateCode ? "cgst-sgst" : "igst";
}
