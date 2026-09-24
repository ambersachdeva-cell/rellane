import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { Diagnostics, redact, RING_SIZE } from "./diagnostics.js";

const CONTEXT = {
  appVersion: "0.2.3",
  platform: "darwin",
  architecture: "arm64",
  memoryBytes: 16 * 1024 ** 3,
  engine: "bundled llama.cpp",
  grantedRootCount: 1
};

describe("redaction keeps the shape and drops the content", () => {
  it("collapses the home directory, so a username never survives", () => {
    const out = redact(`${homedir()}/Downloads/invoice_38.pdf`);
    expect(out).not.toContain(homedir());
    expect(out).not.toContain("invoice_38");
  });

  it("keeps depth and extension, which is what a reader actually needs", () => {
    // "three levels down, a pdf" explains a bug. The client's name does not.
    const out = redact("/Users/amber/Clients/SharmaPharma/quote_final.pdf");
    expect(out).toMatch(/deep/u);
    expect(out).toContain(".pdf");
    expect(out).not.toContain("SharmaPharma");
    expect(out).not.toContain("quote_final");
  });

  it("removes email addresses", () => {
    expect(redact("sent to demo@example.test ok")).not.toContain("@sachdevadigital");
  });

  it("removes anything token-shaped", () => {
    const out = redact("Authorization: Bearer 8f2c1a9d4b7e6f3a2c5d8b1e4a7f0c3d");
    expect(out).not.toContain("8f2c1a9d4b7e6f3a2c5d8b1e4a7f0c3d");
    expect(out).toContain("…token…");
  });

  it("removes long digit runs like invoice and phone numbers", () => {
    expect(redact("PNR 2458901234 confirmed")).not.toContain("2458901234");
  });

  it("leaves ordinary prose alone", () => {
    const message = "Filed 47 files into 6 folders";
    expect(redact(message)).toBe(message);
  });
});

describe("the ring buffer", () => {
  it("keeps entries in order", () => {
    let clock = 0;
    const log = new Diagnostics(() => ++clock);
    log.info("skills", "one");
    log.warn("skills", "two");
    expect(log.all().map((e) => e.message)).toEqual(["one", "two"]);
  });

  it("drops the oldest rather than growing without bound", () => {
    const log = new Diagnostics(() => 0);
    for (let i = 0; i < RING_SIZE + 50; i += 1) {
      log.info("test", `entry ${i}`);
    }
    const all = log.all();
    expect(all).toHaveLength(RING_SIZE);
    // The recent past is what explains a failure, so that is what is kept.
    expect(all[all.length - 1]?.message).toBe(`entry ${RING_SIZE + 49}`);
    expect(all[0]?.message).toBe("entry 50");
  });

  it("can answer the only question that usually matters", () => {
    const log = new Diagnostics(() => 0);
    log.debug("a", "noise");
    log.info("a", "noise");
    log.warn("a", "something odd");
    log.error("a", "it broke");
    expect(log.problems().map((e) => e.message)).toEqual(["something odd", "it broke"]);
  });
});

describe("the bundle a user reads before sending", () => {
  it("says what it is and that nothing leaves on its own", () => {
    const log = new Diagnostics(() => 0);
    const text = log.bundle(CONTEXT);
    expect(text).toContain("CADRANE DIAGNOSTIC REPORT");
    expect(text).toMatch(/Read\s+it before you send it/u);
    expect(text).toMatch(/nothing leaves this Mac on its own/u);
  });

  it("carries the facts needed to reproduce a problem", () => {
    const text = new Diagnostics(() => 0).bundle(CONTEXT);
    expect(text).toContain("darwin arm64");
    expect(text).toContain("16.0 GB");
    expect(text).toContain("bundled llama.cpp");
  });

  it("redacts the log body, not just the header", () => {
    const log = new Diagnostics(() => 0);
    log.error("skills", `could not move ${homedir()}/Downloads/SharmaPharma_quote.pdf`);
    const text = log.bundle(CONTEXT);
    expect(text).not.toContain("SharmaPharma");
    expect(text).toContain(".pdf");
  });

  it("redacts structured detail too, which is where paths usually hide", () => {
    const log = new Diagnostics(() => 0);
    log.info("librarian", "planned", { from: `${homedir()}/Downloads/secret_client.ai` });
    expect(log.bundle(CONTEXT)).not.toContain("secret_client");
  });

  it("is plain text, because nobody proofreads JSON", () => {
    const log = new Diagnostics(() => 0);
    log.info("a", "hello");
    const text = log.bundle(CONTEXT);
    expect(() => JSON.parse(text)).toThrow();
    expect(text).toMatch(/INFO\s+a\s+hello/u);
  });
});

describe("what must never survive redaction", () => {
  it("removes a folder name that contains a space", () => {
    // The pattern excluded whitespace, so `~/Documents/Patel Hardware/Invoice
    // 12.pdf` kept "Hardware" and "12.pdf" — a customer's name, in a bundle the
    // owner hands to somebody else. macOS paths have spaces constantly; this
    // app's own backup folder is "Cadrane Backups".
    const out = redact(`could not read ${homedir()}/Documents/Patel Hardware/Invoice 12.pdf`);

    expect(out).not.toContain("Patel");
    expect(out).not.toContain("Hardware");
    expect(out).not.toContain(homedir());
  });

  it("removes a phone number written the way people write it", () => {
    // `\d{7,}` required unbroken digits, so it missed every real formatting —
    // which is to say it missed the thing it was written for.
    for (const number of ["+91 98765 43210", "98765-43210", "+91-98765-43210"]) {
      expect(redact(`rang ${number} twice`)).not.toContain("98765");
    }
  });

  it("still leaves ordinary prose readable", () => {
    // Over-redaction is the safe direction, not a licence to redact everything.
    const out = redact("Filing clerk answered after reading 3 files.");

    expect(out).toContain("Filing clerk answered");
  });
});

describe("the identifiers an Indian business is identified by", () => {
  it("removes a GSTIN, which the token rule was too short to catch", () => {
    // Fifteen characters, no long digit run — so it passed both the 24-character
    // token rule and the digit rule, and reached an exportable bundle intact.
    // A GSTIN names a company exactly; that is what it is for.
    expect(redact("supplier 06AABCS1429B1ZP refused")).toBe("supplier …GSTIN… refused");
  });

  it("removes a PAN", () => {
    expect(redact("pan ABCDE1234F on file")).toBe("pan …PAN… on file");
  });

  it("removes a UPI handle", () => {
    expect(redact("paid to sharma.printers@okhdfcbank today")).toBe("paid to …UPI… today");
  });

  it("leaves ordinary words alone", () => {
    // The rules are precise formats rather than guesses, so normal prose and
    // the app's own vocabulary must survive them — a redactor that eats the
    // message is as useless as one that leaks.
    expect(redact("the backup verified and the ledger is unbroken")).toBe(
      "the backup verified and the ledger is unbroken"
    );
  });
});
