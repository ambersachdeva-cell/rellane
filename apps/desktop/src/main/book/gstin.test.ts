/**
 * Checking a GSTIN.
 *
 * The point is not validation for its own sake. The document reader lifts
 * GSTINs off photographs, and OCR confuses 0 with O and 1 with I exactly where a
 * GSTIN mixes digits and letters — so this turns a reading into something that
 * can be checked, for nothing, offline.
 */

import { describe, expect, it } from "vitest";
import { checkCharacter, checkGstin, taxKind } from "./gstin.js";

// Real-shaped GSTINs with correct check characters, built by the same rule the
// GSTN publishes. Computed rather than copied, so the fixtures cannot be wrong
// in the same direction as the code.
const valid = (first14: string) => `${first14}${checkCharacter(first14)}`;
const DELHI = valid("07AABCU9603R1Z");
const PUNJAB = valid("03AABCV1234D1Z");
const MAHARASHTRA = valid("27AAAPL1234C1Z");

describe("a GSTIN that is well-formed", () => {
  it("passes, and gives back the state code", () => {
    const checked = checkGstin(DELHI);

    expect(checked.ok).toBe(true);
    expect(checked.stateCode).toBe("07");
    expect(checked.problem).toBeNull();
  });

  it("is accepted however somebody wrote it down", () => {
    // Spaces and hyphens are how one appears on paper, and how OCR returns one
    // that spanned a table border.
    expect(checkGstin(` ${PUNJAB.toLowerCase()} `).ok).toBe(true);
    expect(checkGstin(`${PUNJAB.slice(0, 2)}-${PUNJAB.slice(2)}`).ok).toBe(true);
  });
});

describe("the mistakes a photograph makes", () => {
  it("catches a 0 read as an O", () => {
    // The single most common OCR error on a GSTIN, and the check character is
    // what makes it findable rather than believable.
    const misread = `${DELHI.slice(0, 1)}7AABCU96O3R1Z${DELHI.slice(14)}`;

    expect(checkGstin(misread).ok).toBe(false);
  });

  it("catches any single wrong character, which is what a checksum is for", () => {
    const wrong = `${DELHI.slice(0, 13)}${DELHI[13] === "Z" ? "Z" : "Z"}${
      DELHI[14] === "0" ? "1" : "0"
    }`;

    expect(checkGstin(wrong).ok).toBe(false);
    expect(checkGstin(wrong).problem).toContain("check character");
  });

  it("names a state code that does not exist", () => {
    // The first two digits decide CGST+SGST against IGST, so a misread here
    // changes the tax rather than just the identifier.
    // 50 is not assigned to anything. 99 used to be the example here and is a
    // real code — Centre Jurisdiction — which is exactly the bug this fixes.
    const checked = checkGstin(`50${DELHI.slice(2)}`);

    expect(checked.ok).toBe(false);
    expect(checked.problem).toContain("state code");
  });

  it("says plainly when it is not a GSTIN at all", () => {
    expect(checkGstin("hello").problem).toContain("15 characters");
    expect(checkGstin("").ok).toBe(false);
    expect(checkGstin(null).ok).toBe(false);
    expect(checkGstin(123).ok).toBe(false);
  });
});

describe("which tax a bill carries", () => {
  it("is split when both are in one state, and integrated when they are not", () => {
    // The rule people get backwards when entering bills quickly, and getting it
    // backwards makes a return not add up.
    expect(taxKind(PUNJAB, valid("03AAFCD5678K1Z"))).toBe("cgst-sgst");
    expect(taxKind(PUNJAB, MAHARASHTRA)).toBe("igst");
  });

  it("refuses to guess from a GSTIN it could not check", () => {
    expect(taxKind(PUNJAB, "nonsense")).toBe("unknown");
  });
});

describe("codes that are and are not real", () => {
  it("accepts Centre Jurisdiction and rejects the export code", () => {
    // 99 is where a foreign supplier of digital services is registered. 96 is a
    // place-of-supply code for exports and is not a GSTIN prefix at all —
    // accepting it waved through numbers that cannot exist.
    expect(checkGstin(valid("99AABCU9603R1Z")).ok).toBe(true);
    expect(checkGstin(valid("96AABCU9603R1Z")).ok).toBe(false);
  });

  it("rejects a zero entity number, which does not exist", () => {
    // The thirteenth character counts registrations under that PAN in that
    // state, from 1. There is no zeroth registration.
    expect(checkGstin(valid("07AABCU96030Z")).ok).toBe(false);
  });

  it("refuses to compute a check character for the wrong length", () => {
    // The weights alternate by position, so a short string is computed against
    // the wrong ones and returns a confident wrong answer. This returned "0".
    expect(checkCharacter("")).toBeNull();
    expect(checkCharacter("07AABCU")).toBeNull();
  });
});

describe("what it will not claim", () => {
  it("says nothing about whether the business is real", () => {
    // Well-formed is the class of error a reading introduces. It is not the
    // class a fraudster introduces, and claiming otherwise would be exactly the
    // confident wrongness this codebase keeps writing rules against.
    const invented = valid("07ZZZZZ9999Z9Z");

    expect(checkGstin(invented).ok).toBe(true);
  });
});
