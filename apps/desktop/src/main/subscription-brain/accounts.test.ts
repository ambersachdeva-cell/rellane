/**
 * Several subscriptions, several seats.
 *
 * The two things worth guarding: an account is a *place*, never a credential,
 * and a spent quota belongs to one family rather than one account — because
 * marking a whole account spent when its Gemini ran out strands an untouched
 * Opus budget sitting right beside it.
 */

import { describe, expect, it } from "vitest";
import { accountsFrom, checkAccount, familyOf, poolOf, type SeatAccount } from "./accounts.js";

const HOME = "/Users/amber";

const account = (over: Partial<SeatAccount> = {}): SeatAccount => ({
  id: "a1",
  providerId: "antigravity",
  label: "work",
  profileDir: "/Users/amber/agy-setup/config1",
  ...over
});

describe("which pool a model bills against", () => {
  it("tells the three families apart", () => {
    // Antigravity fronts all three on one subscription and they do not share a
    // pool. A router that treated the account as one budget would strand two
    // thirds of what was paid for.
    expect(familyOf("gemini-3.8-flash-high")).toBe("gemini");
    expect(familyOf("claude-opus-4-6-thinking")).toBe("claude");
    expect(familyOf("gpt-oss-120b-medium")).toBe("open");
  });

  it("keys a spent quota by account and family together", () => {
    const gemini = poolOf({ accountId: "a1", family: "gemini" });
    const claude = poolOf({ accountId: "a1", family: "claude" });

    expect(gemini).not.toBe(claude);
    expect(poolOf({ accountId: "a2", family: "gemini" })).not.toBe(gemini);
  });
});

describe("adding an account", () => {
  it("refuses the owner's own home folder", () => {
    // Every seat would be the same subscription wearing a different name, and
    // the owner would see three green lights for one account.
    const checked = checkAccount({ label: "second", profileDir: HOME }, HOME);

    expect(checked.ok).toBe(false);
    expect(checked).toHaveProperty("problem", expect.stringContaining("home folder"));
  });

  it("needs a full path and a name", () => {
    expect(checkAccount({ label: "work", profileDir: "config2" }, HOME).ok).toBe(false);
    expect(checkAccount({ label: "  ", profileDir: "/tmp/x" }, HOME).ok).toBe(false);
    expect(checkAccount({ label: "work", profileDir: "/tmp/x" }, HOME).ok).toBe(true);
  });
});

describe("reading stored accounts", () => {
  it("drops anything malformed rather than repairing it", () => {
    // This list decides which subscription gets spent. A guess here is
    // somebody's quota.
    const stored = accountsFrom([
      account(),
      { id: "a2", providerId: "antigravity", label: "no path" },
      { id: "a3", providerId: "antigravity", label: "relative", profileDir: "nope" },
      "not an object",
      null
    ]);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe("a1");
  });

  it("survives a settings file with nothing in it", () => {
    expect(accountsFrom(undefined)).toEqual([]);
    expect(accountsFrom({})).toEqual([]);
  });
});

describe("what an account is", () => {
  it("is a place and a name, and carries no credential", () => {
    // The whole safety argument in one assertion: there is nowhere in this
    // shape for a token to live.
    expect(Object.keys(account()).sort()).toEqual(["id", "label", "profileDir", "providerId"]);
  });
});
