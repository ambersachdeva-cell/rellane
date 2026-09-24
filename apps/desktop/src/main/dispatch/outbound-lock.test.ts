import { describe, expect, it } from "vitest";
import { normalise, OutboundLock, type Recipient } from "./outbound-lock.js";

const list: readonly Recipient[] = [
  { channel: "whatsapp", address: "+91 98765 43210", label: "Devgiri Traders" },
  { channel: "email", address: "Devgiri@Example.co.in", label: "Devgiri (email)" },
  { channel: "telegram", address: "44551122", label: "Amber's phone" }
];

describe("recognising one person written several ways", () => {
  it("treats every spelling of a number as the same recipient", () => {
    // An allowlist that fails to match a differently-typed number fails open
    // the moment somebody pastes it from a contact card.
    const lock = new OutboundLock(list);

    for (const spelling of ["9876543210", "+919876543210", "+91 98765 43210", "91-98765-43210"]) {
      expect(lock.check("whatsapp", spelling).allowed).toBe(true);
    }
  });

  it("matches an email regardless of case", () => {
    expect(new OutboundLock(list).check("email", "devgiri@example.co.in").allowed).toBe(true);
  });

  it("keeps the channels apart", () => {
    // Being allowed on email is not permission to open a WhatsApp chat.
    expect(new OutboundLock(list).check("whatsapp", "devgiri@example.co.in").allowed).toBe(false);
  });
});

describe("refusing", () => {
  it("refuses a stranger and says what to do, and what it might mean", () => {
    const verdict = new OutboundLock(list).check("whatsapp", "9000000000");

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.why).toContain("not on your whatsapp list");
      expect(verdict.why).toContain("Settings");
      // The sentence that matters: an unexplained outbound attempt is a signal,
      // not just an inconvenience.
      expect(verdict.why).toContain("message a stranger");
    }
  });

  it("separates 'not recognised' from 'not allowed'", () => {
    // Different problems, different fixes. Reporting a typo as a permission
    // failure sends the owner to the wrong screen.
    const verdict = new OutboundLock(list).check("email", "not an address");

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.why).toContain("not a email address Rellane recognises");
    }
  });

  it("refuses everything when the list is empty", () => {
    // The state a fresh install is in. It must be closed, not open.
    const empty = new OutboundLock([]);

    expect(empty.check("whatsapp", "9876543210").allowed).toBe(false);
    expect(empty.check("email", "a@b.com").allowed).toBe(false);
    expect(empty.size()).toBe(0);
  });

  it("drops an unparseable entry from the list rather than storing it as a wildcard", () => {
    // A junk entry that normalised to the same key as everything else would be
    // an allow-all hiding in the data.
    const lock = new OutboundLock([{ channel: "email", address: "junk", label: "junk" }]);

    expect(lock.size()).toBe(0);
    expect(lock.check("email", "junk").allowed).toBe(false);
    expect(lock.check("email", "anyone@example.com").allowed).toBe(false);
  });
});

describe("normalising", () => {
  it("returns null rather than throwing for input a person mistyped", () => {
    expect(normalise("email", "nope")).toBeNull();
    expect(normalise("whatsapp", "call the office")).toBeNull();
  });
});

describe("failing closed", () => {
  /**
   * Found by Gemini 3.7 Flash reviewing this file, and worth keeping as tests
   * rather than as a fixed diff: each one is a path where the gate could have
   * failed *open*, which is the only direction that matters here.
   */

  it("refuses a channel it does not know, rather than letting it through", () => {
    // The switch had no default. TypeScript was satisfied because the union has
    // exactly three members, so at runtime an out-of-union value returned
    // `undefined` — and every caller tests `=== null`. That value reached the
    // map as `channel:undefined`, and `check` then found that key and allowed
    // ANY address on that channel. Unreachable today through the type, the IPC
    // enum and the settings coercion; one refactor from reachable.
    const rogue = "sms" as unknown as Recipient["channel"];

    expect(normalise(rogue, "anything")).toBeNull();
    expect(new OutboundLock([{ channel: rogue, address: "x", label: "x" }]).size()).toBe(0);
    expect(new OutboundLock(list).check(rogue, "9876543210").allowed).toBe(false);
  });

  it("does not let one unreadable contact stop the lock being built", () => {
    // The catch handled only the two handoff errors and rethrew everything
    // else, so anything unexpected aborted the constructor — refusing to build
    // the lock at all rather than refusing one address.
    const built = new OutboundLock([
      { channel: "email", address: null as unknown as string, label: "broken" },
      { channel: "email", address: "good@example.com", label: "fine" }
    ]);

    expect(built.size()).toBe(1);
    expect(built.check("email", "good@example.com").allowed).toBe(true);
  });

  it("treats a Telegram handle as case-insensitive, the way Telegram does", () => {
    // Chat ids are numeric and unaffected. People type @Usernames, and those
    // are case-insensitive — so two spellings would otherwise be two entries
    // and the list would miss one.
    const lock = new OutboundLock([
      { channel: "telegram", address: "@Devgiri", label: "Devgiri" }
    ]);

    expect(lock.check("telegram", "@devgiri").allowed).toBe(true);
    expect(lock.check("telegram", "@DEVGIRI").allowed).toBe(true);
  });
});

describe("what a blank contact does to the list", () => {
  it("does not register an empty telegram handle", () => {
    // Unlike the other two channels, telegram does no validation — so a blank
    // address returned "", which is not null, and was registered under the key
    // `telegram:`. An allowlist entry matching the empty address is not a
    // contact anybody added.
    expect(normalise("telegram", "   ")).toBeNull();
    expect(normalise("telegram", "")).toBeNull();
  });

  it("still accepts a real handle, case-folded", () => {
    expect(normalise("telegram", "  @Devgiri ")).toBe("@devgiri");
  });
});
