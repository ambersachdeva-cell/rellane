import { describe, expect, it } from "vitest";
import { describeConnection, type ConnectionFamily } from "./connection-readiness.js";

describe("describeConnection", () => {
  const families: readonly ConnectionFamily[] = ["codex", "claude", "gemini"];
  const forbiddenPatterns = [/\bcli\b/i, /\bpath\b/i, /\bbinary\b/i, /\bexecutable\b/i, /\bterminal\b/i, /\//];

  it("describes each family when executable is null", () => {
    const productNames: Record<ConnectionFamily, string> = {
      codex: "ChatGPT",
      claude: "Claude",
      gemini: "Gemini"
    };

    for (const family of families) {
      const result = describeConnection({ family, executable: null });

      expect(result.headline).toContain(productNames[family]);
      expect(result.headline).toContain("was not found on this Mac");
      expect(result.nextStep).toMatch(/^Install /u);
      expect(result.nextStep).toContain(productNames[family]);
      expect(result.nextStep).toContain("sign in");

      for (const pattern of forbiddenPatterns) {
        expect(result.headline).not.toMatch(pattern);
        expect(result.nextStep).not.toMatch(pattern);
      }

      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.detail).toBe(`${result.headline} ${result.nextStep} ${result.evidence}`);
      expect(result.detail).not.toContain("\n");
    }
  });

  it("describes each family when an executable is found", () => {
    for (const family of families) {
      const fakePath = `/usr/local/bin/mock-${family}`;
      const result = describeConnection({ family, executable: fakePath });

      expect(result.headline).toContain("is on this Mac");
      expect(result.headline).toContain("start a session");
      expect(result.nextStep).toContain("Signing in stays inside");
      expect(result.nextStep).toMatch(/Rellane does not check it/u);
      expect(result.evidence).toBe(fakePath);

      for (const pattern of forbiddenPatterns) {
        expect(result.headline).not.toMatch(pattern);
        expect(result.nextStep).not.toMatch(pattern);
      }

      expect(result.detail).toBe(`${result.headline} ${result.nextStep} ${result.evidence}`);
      expect(result.detail).not.toContain("\n");
    }
  });

  it("explains first-time setup for Gemini when profile is not ready", () => {
    const fakePath = "/Users/example/.local/bin/agy";
    const result = describeConnection({
      family: "gemini",
      executable: fakePath,
      profileReady: false,
      profileKey: "config2"
    });

    expect(result.headline).toContain("Gemini is on this Mac");
    expect(result.nextStep).toContain("first session");
    expect(result.nextStep).toContain("sign in");
    expect(result.evidence).toContain(fakePath);
    expect(result.evidence).toContain("config2");

    for (const pattern of forbiddenPatterns) {
      expect(result.headline).not.toMatch(pattern);
      expect(result.nextStep).not.toMatch(pattern);
    }

    expect(result.detail).toBe(`${result.headline} ${result.nextStep} ${result.evidence}`);
  });

  it("does not mention first-time setup when Gemini profile is ready", () => {
    const fakePath = "/Users/example/.local/bin/agy";
    const result = describeConnection({
      family: "gemini",
      executable: fakePath,
      profileReady: true,
      profileKey: "config1"
    });

    expect(result.nextStep).not.toContain("first session");
    expect(result.nextStep).not.toContain("first use");
    expect(result.nextStep).not.toContain("set it up");
    expect(result.nextStep).toMatch(/Rellane does not check it/u);
    expect(result.evidence).toBe(fakePath);
  });

  it("never claims an account was verified or that the owner is signed in", () => {
    const cases = [
      describeConnection({ family: "codex", executable: null }),
      describeConnection({ family: "codex", executable: "/Applications/ChatGPT.app/Contents/Resources/codex" }),
      describeConnection({ family: "claude", executable: null }),
      describeConnection({ family: "claude", executable: "/mock/claude" }),
      describeConnection({ family: "gemini", executable: null }),
      describeConnection({ family: "gemini", executable: "/mock/agy", profileReady: false, profileKey: "config1" }),
      describeConnection({ family: "gemini", executable: "/mock/agy", profileReady: true, profileKey: "config2" })
    ];

    for (const result of cases) {
      expect(result.detail.toLowerCase()).not.toContain("signed in as");
      expect(result.detail.toLowerCase()).not.toContain("account verified");
      expect(result.detail.toLowerCase()).not.toContain("subscription verified");
    }
  });

  it("joins parts with single spaces and no newlines", () => {
    const missing = describeConnection({ family: "codex", executable: null });
    expect(missing.detail).toBe(`${missing.headline} ${missing.nextStep} ${missing.evidence}`);
    expect(missing.detail).not.toContain("\n");

    const found = describeConnection({ family: "claude", executable: "/bin/claude" });
    expect(found.detail).toBe(`${found.headline} ${found.nextStep} ${found.evidence}`);
    expect(found.detail).not.toContain("\n");
  });
});
