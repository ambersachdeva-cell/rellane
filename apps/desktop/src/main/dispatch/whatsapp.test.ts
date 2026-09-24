import { describe, expect, it, vi } from "vitest";
import {
  handoffLink,
  MAX_ENCODED_CHARS,
  MAX_PREFILL_CHARS,
  toWaNumber,
  whatsAppHandoff,
  WhatsAppHandoffError
} from "./whatsapp.js";

describe("the country code", () => {
  it("never second-guesses an explicit one", () => {
    // `+65 1234 5678` is ten digits and Singaporean. Prepending 91 produced a
    // valid-looking Indian number belonging to a stranger.
    expect(toWaNumber("+65 1234 5678")).toBe("6512345678");
    expect(toWaNumber("+47 12345678")).toBe("4712345678");
  });

  it("strips trunk and international prefixes people paste from contacts", () => {
    expect(toWaNumber("09876543210")).toBe("919876543210");
    expect(toWaNumber("00919876543210")).toBe("919876543210");
  });

  it("keeps the number out of the refusal message", () => {
    // Errors reach diagnostics, and a diagnostics bundle is handed to somebody
    // else. This said the opposite of what the module claims about recipients.
    try {
      toWaNumber("12345");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).not.toContain("12345");
    }
  });
});

describe("the number", () => {
  it("keeps a number that already carries its country code", () => {
    expect(toWaNumber("+91 98765 43210")).toBe("919876543210");
    expect(toWaNumber("+1 (415) 555-0123")).toBe("14155550123");
  });

  it("assumes India for a bare ten-digit mobile", () => {
    // A guess, but one the owner sees in the open WhatsApp window before
    // pressing send — which is exactly what a handoff is for.
    expect(toWaNumber("9876543210")).toBe("919876543210");
  });

  it("refuses something that is not a number rather than opening a wrong chat", () => {
    expect(() => toWaNumber("ring the office")).toThrow(WhatsAppHandoffError);
    expect(() => toWaNumber("12345")).toThrow(/country code/u);
  });
});

describe("the link", () => {
  it("escapes everything a real message contains", () => {
    // Newlines, rupees, an ampersand and Devanagari all appear in ordinary
    // messages here, and any one of them unescaped truncates or corrupts.
    const link = handoffLink("9876543210", "₹9,360 balance\nDevgiri & Sons\nनमस्ते");

    expect(link.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(link).not.toContain("\n");
    expect(link).not.toContain(" & ");
    expect(decodeURIComponent(link.split("?text=")[1] ?? "")).toContain("नमस्ते");
  });

  it("refuses an empty message", () => {
    expect(() => handoffLink("9876543210", "   ")).toThrow(/no message/u);
  });

  it("refuses a message WhatsApp would silently cut off", () => {
    // Half a message arriving is worse than none: the recipient acts on it.
    expect(() => handoffLink("9876543210", "x".repeat(MAX_PREFILL_CHARS + 1))).toThrow(
      /half-written/u
    );
    expect(() => handoffLink("9876543210", "x".repeat(MAX_PREFILL_CHARS))).not.toThrow();
  });

  it("also refuses a message that is short but encodes long", () => {
    // Devanagari expands to nine characters each under encodeURIComponent, so a
    // message well inside the character limit can still overflow the URL.
    // Checking only characters missed this; checking only bytes would have made
    // plain ASCII three times more permissive than documented.
    const hindi = "क".repeat(3_000);

    expect(hindi.length).toBeLessThan(MAX_PREFILL_CHARS);
    expect(encodeURIComponent(hindi).length).toBeGreaterThan(MAX_ENCODED_CHARS);
    expect(() => handoffLink("9876543210", hindi)).toThrow(/too long for a WhatsApp link/u);
  });

  it("does not tell somebody to shorten 3,000 characters to 4,000", () => {
    // The two limits were checked together and shared one message, so a Hindi
    // message that overflowed the *link* was told the *character* limit — a
    // number above its own length, which reads as the app being broken.
    const hindi = "क".repeat(3_000);

    expect(() => handoffLink("9876543210", hindi)).not.toThrow(
      new RegExp(String(MAX_PREFILL_CHARS.toLocaleString()), "u")
    );
  });
});

describe("the channel", () => {
  it("declares that it stages rather than sends", () => {
    // The load-bearing field. Everything that reports an outcome reads it, so
    // nothing downstream can record "delivered" for a window that opened.
    expect(whatsAppHandoff(async () => undefined).delivery).toBe("stages");
  });

  it("opens WhatsApp with the message already in it", async () => {
    const opened: string[] = [];
    const channel = whatsAppHandoff(async (url) => void opened.push(url));

    await channel.send("9876543210", "Balance ₹9,360 on the August quote.");

    expect(opened).toHaveLength(1);
    expect(decodeURIComponent(opened[0] ?? "")).toContain("₹9,360");
  });

  it("does not open anything when the message is refused", async () => {
    // The refusal has to come before the window, or the owner gets a WhatsApp
    // chat with a truncated message sitting in it.
    const open = vi.fn(async () => undefined);

    await expect(whatsAppHandoff(open).send("9876543210", "")).rejects.toThrow(
      WhatsAppHandoffError
    );
    expect(open).not.toHaveBeenCalled();
  });
});

describe("a country code, however it was pasted", () => {
  it("does not send a Singapore number to a stranger in India", () => {
    // The failure this module's own comment already named, through two shapes
    // its guard did not cover: the bracket comes before the plus, and the
    // international prefix is digits. Both are ten digits after the code, and
    // both were being given a 91.
    expect(toWaNumber("(+65) 1234 5678")).toBe("6512345678");
    expect(toWaNumber("0065 1234 5678")).toBe("6512345678");
    expect(toWaNumber("+65 1234 5678")).toBe("6512345678");
  });

  it("still assumes India for a bare ten-digit mobile", () => {
    // The overwhelmingly common case, and a guess the owner sees in the open
    // WhatsApp window before pressing send.
    expect(toWaNumber("98765 43210")).toBe("919876543210");
    expect(toWaNumber("09876543210")).toBe("919876543210");
  });

  it("leaves an Indian number written in full alone", () => {
    expect(toWaNumber("+91 98765 43210")).toBe("919876543210");
    expect(toWaNumber("00919876543210")).toBe("919876543210");
  });
});
