import { describe, expect, it, vi } from "vitest";
import {
  checkAddress,
  emailHandoff,
  EmailHandoffError,
  mailtoLink,
  MAX_BODY_CHARS,
  splitSubject
} from "./email.js";

describe("the address", () => {
  it("accepts an ordinary one", () => {
    expect(checkAddress("  devgiri@example.co.in ")).toBe("devgiri@example.co.in");
  });

  it("refuses anything that could add a second recipient", () => {
    // The whole point. A message approved for one person must not be able to
    // acquire another between approval and the compose window.
    expect(() => checkAddress("a@b.com,c@d.com")).toThrow(EmailHandoffError);
    expect(() => checkAddress("a@b.com;c@d.com")).toThrow(EmailHandoffError);
    expect(() => checkAddress("a@b.com\nbcc:c@d.com")).toThrow(EmailHandoffError);
    expect(() => checkAddress("a@b.com>, <c@d.com")).toThrow(EmailHandoffError);
  });

  it("refuses something that is not an address at all", () => {
    expect(() => checkAddress("the office")).toThrow(/One address/u);
  });
});

describe("the link", () => {
  it("encodes a subject that would otherwise introduce a header", () => {
    // A newline in a subject is how a Bcc gets added in the naive version.
    const link = mailtoLink("a@b.com", "Quote\nBcc: attacker@evil.com", "Body here");

    expect(link).not.toContain("\n");
    expect(link).not.toContain("Bcc:");
    expect(link).toContain("%0A");
  });

  it("uses %20 for spaces rather than a plus", () => {
    // URLSearchParams gives "+", which some mail clients render literally.
    const link = mailtoLink("a@b.com", "August quote", "Balance due");

    expect(link).toContain("August%20quote");
    expect(link).not.toContain("+");
  });

  it("carries rupees and Devanagari through intact", () => {
    const link = mailtoLink("a@b.com", "", "₹9,360 बकाया");

    expect(decodeURIComponent(link)).toContain("₹9,360 बकाया");
  });

  it("refuses an empty body, and one long enough to be truncated", () => {
    expect(() => mailtoLink("a@b.com", "s", "  ")).toThrow(/no message/u);
    expect(() => mailtoLink("a@b.com", "s", "x".repeat(MAX_BODY_CHARS + 1))).toThrow(
      /half-written/u
    );
  });
});

describe("finding a subject", () => {
  it("takes a short first line followed by a blank one", () => {
    expect(splitSubject("August quote\n\nBalance is ₹9,360.")).toEqual({
      subject: "August quote",
      body: "Balance is ₹9,360."
    });
  });

  it("takes no subject rather than a wrong one", () => {
    // An absent subject is noticed. A subject that is merely the first sentence
    // repeated is not, and goes out that way.
    expect(splitSubject("Hello, about the August quote — the balance is ₹9,360.")).toEqual({
      subject: "",
      body: "Hello, about the August quote — the balance is ₹9,360."
    });
    expect(splitSubject(`${"x".repeat(100)}\n\nbody`).subject).toBe("");
  });
});

describe("the channel", () => {
  it("declares that it stages rather than sends", () => {
    expect(emailHandoff(async () => undefined).delivery).toBe("stages");
  });

  it("opens the mail client with the message in it", async () => {
    const opened: string[] = [];

    await emailHandoff(async (url) => void opened.push(url)).send(
      "devgiri@example.co.in",
      "August quote\n\nBalance ₹9,360."
    );

    expect(decodeURIComponent(opened[0] ?? "")).toContain("Balance ₹9,360.");
    // A literal @, per RFC 6068. This asserted `%40`, which some mail clients
    // fail to parse into a recipient at all.
    expect(opened[0]).toContain("mailto:devgiri@example.co.in");
  });

  it("opens nothing when the address is refused", async () => {
    const open = vi.fn(async () => undefined);

    await expect(emailHandoff(open).send("a@b.com,c@d.com", "hi")).rejects.toThrow(
      EmailHandoffError
    );
    expect(open).not.toHaveBeenCalled();
  });
});
