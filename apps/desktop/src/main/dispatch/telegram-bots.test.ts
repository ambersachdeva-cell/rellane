import { describe, expect, it } from "vitest";
import { BOTS, botFor, whatIsMissing } from "./telegram-bots.js";

const BANNED_WORDS = [
  "token",
  "api",
  "agent",
  "llm",
  "async",
  "ipc",
  "vector",
  "prompt",
  "model"
] as const;

describe("BOTS catalog configuration", () => {
  it("contains exactly the five expected distinct bots", () => {
    expect(BOTS.length).toBe(5);
    const ids = BOTS.map((bot) => bot.id);
    expect(ids).toEqual([
      "research",
      "catch-up",
      "check-this",
      "draft",
      "second-opinion"
    ]);
  });

  it("contains no banned implementation words in any name, line, or askFor copy", () => {
    for (const bot of BOTS) {
      for (const banned of BANNED_WORDS) {
        const regex = new RegExp(`\\b${banned}\\b`, "i");
        expect(bot.name).not.toMatch(regex);
        expect(bot.line).not.toMatch(regex);
        expect(bot.needs.askFor).not.toMatch(regex);
      }
    }
  });

  it("keeps every line under 70 characters", () => {
    for (const bot of BOTS) {
      expect(bot.line.length).toBeLessThan(70);
    }
  });

  it("formats names as one to three words without exclamation marks", () => {
    for (const bot of BOTS) {
      const words = bot.name.trim().split(/\s+/);
      expect(words.length).toBeGreaterThanOrEqual(1);
      expect(words.length).toBeLessThanOrEqual(3);
      expect(bot.name).not.toContain("!");
    }
  });

  it("ensures every askFor is a calm sentence ending in a full stop without exclamation marks", () => {
    for (const bot of BOTS) {
      expect(bot.needs.askFor.endsWith(".")).toBe(true);
      expect(bot.needs.askFor).not.toContain("!");
    }
  });

  it("accurately declares subscription counts and slow execution flags", () => {
    const research = BOTS.find((b) => b.id === "research");
    const catchUp = BOTS.find((b) => b.id === "catch-up");
    const checkThis = BOTS.find((b) => b.id === "check-this");
    const draft = BOTS.find((b) => b.id === "draft");
    const secondOpinion = BOTS.find((b) => b.id === "second-opinion");

    expect(research?.slow).toBe(true);
    expect(research?.usesSubscriptions).toBeGreaterThanOrEqual(3);

    expect(catchUp?.slow).toBe(false);
    expect(catchUp?.usesSubscriptions).toBe(1);

    expect(checkThis?.slow).toBe(false);
    expect(checkThis?.usesSubscriptions).toBe(1);

    expect(draft?.slow).toBe(false);
    expect(draft?.usesSubscriptions).toBe(1);

    expect(secondOpinion?.slow).toBe(false);
    expect(secondOpinion?.usesSubscriptions).toBe(2);
  });
});

describe("botFor intent resolution", () => {
  it("resolves explicit slash commands deterministically", () => {
    expect(botFor("/research")?.id).toBe("research");
    expect(botFor("/research What are our quarterly VAT liabilities?")?.id).toBe("research");
    expect(botFor("/catch-up")?.id).toBe("catch-up");
    expect(botFor("/catchup")?.id).toBe("catch-up");
    expect(botFor("/check-this")?.id).toBe("check-this");
    expect(botFor("/check")?.id).toBe("check-this");
    expect(botFor("/draft")?.id).toBe("draft");
    expect(botFor("/draft reply to client")?.id).toBe("draft");
    expect(botFor("/second-opinion")?.id).toBe("second-opinion");
    expect(botFor("/secondopinion")?.id).toBe("second-opinion");
  });

  it("resolves bare URLs to check-this", () => {
    expect(botFor("https://example.com")?.id).toBe("check-this");
    expect(botFor("http://news.bbc.co.uk/sport")?.id).toBe("check-this");
    expect(botFor("https://github.com/microsoft/typescript")?.id).toBe("check-this");
    expect(botFor("www.gov.uk/vat-rates")?.id).toBe("check-this");
  });

  it("resolves questions with a question mark and more than six words to research", () => {
    expect(
      botFor("What are the main changes to UK capital gains tax?")?.id
    ).toBe("research");
    expect(
      botFor("How do small businesses register for relief on energy bills?")?.id
    ).toBe("research");
  });

  it("does not classify short questions as research", () => {
    expect(botFor("What is this?")).toBeNull();
    expect(botFor("Why?")).toBeNull();
    expect(botFor("Can you help me?")).toBeNull();
  });

  it("resolves catch-up phrasing deterministically", () => {
    expect(botFor("what's new")?.id).toBe("catch-up");
    expect(botFor("whats new")?.id).toBe("catch-up");
    expect(botFor("catch me up")?.id).toBe("catch-up");
    expect(botFor("what's new?")?.id).toBe("catch-up");
  });

  it("resolves draft phrasing deterministically", () => {
    expect(botFor("write me an invoice follow-up letter")?.id).toBe("draft");
    expect(botFor("draft a response to the tenant")?.id).toBe("draft");
    expect(botFor("draft")?.id).toBe("draft");
  });

  it("resolves second-opinion queries deterministically", () => {
    expect(botFor("are you sure")?.id).toBe("second-opinion");
    expect(botFor("are you sure?")?.id).toBe("second-opinion");
    expect(botFor("check that")?.id).toBe("second-opinion");
    expect(botFor("second opinion")?.id).toBe("second-opinion");
    expect(botFor("Are you sure about that calculation from yesterday?")?.id).toBe("second-opinion");
  });

  it("returns null for greetings or ambiguous input to display options", () => {
    expect(botFor("hello")).toBeNull();
    expect(botFor("hi")).toBeNull();
    expect(botFor("good morning")).toBeNull();
    expect(botFor("thanks")).toBeNull();
    expect(botFor("")).toBeNull();
    expect(botFor("   ")).toBeNull();
  });
});

describe("whatIsMissing missing input diagnostics", () => {
  const getBot = (id: (typeof BOTS)[number]["id"]) => {
    const found = BOTS.find((b) => b.id === id);
    if (!found) {
      throw new Error(`Missing test bot ${id}`);
    }
    return found;
  };

  it("never flags missing input for catch-up", () => {
    const catchUp = getBot("catch-up");
    expect(whatIsMissing(catchUp, "")).toBeNull();
    expect(whatIsMissing(catchUp, "/catch-up")).toBeNull();
    expect(whatIsMissing(catchUp, "what's new")).toBeNull();
  });

  it("detects when check-this lacks an address or file", () => {
    const checkThis = getBot("check-this");
    expect(whatIsMissing(checkThis, "")).toBe("Send me the address and I will read it.");
    expect(whatIsMissing(checkThis, "/check-this")).toBe("Send me the address and I will read it.");
    expect(whatIsMissing(checkThis, "check this")).toBe("Send me the address and I will read it.");
    expect(whatIsMissing(checkThis, "https://example.com")).toBeNull();
    expect(whatIsMissing(checkThis, "/check-this https://example.com")).toBeNull();
    expect(whatIsMissing(checkThis, "/Users/amber/report.pdf")).toBeNull();
  });

  it("detects when research lacks a question payload", () => {
    const research = getBot("research");
    expect(whatIsMissing(research, "")).toBe("Send your question and I will look into it.");
    expect(whatIsMissing(research, "/research")).toBe("Send your question and I will look into it.");
    expect(whatIsMissing(research, "/research   ")).toBe("Send your question and I will look into it.");
    expect(whatIsMissing(research, "/research What are the VAT rates?")).toBeNull();
    expect(whatIsMissing(research, "What are the rules for small companies?")).toBeNull();
  });

  it("detects when draft lacks a subject or description", () => {
    const draft = getBot("draft");
    expect(whatIsMissing(draft, "")).toBe("Tell me what to write and I will draft it for you.");
    expect(whatIsMissing(draft, "/draft")).toBe("Tell me what to write and I will draft it for you.");
    expect(whatIsMissing(draft, "draft")).toBe("Tell me what to write and I will draft it for you.");
    expect(whatIsMissing(draft, "write me")).toBe("Tell me what to write and I will draft it for you.");
    expect(whatIsMissing(draft, "/draft a polite decline to Acme")).toBeNull();
    expect(whatIsMissing(draft, "draft a reminder email")).toBeNull();
    expect(whatIsMissing(draft, "write me a formal proposal")).toBeNull();
  });

  it("detects when second-opinion lacks input", () => {
    const secondOpinion = getBot("second-opinion");
    expect(whatIsMissing(secondOpinion, "")).toBe("Send me the answer you want reviewed and I will challenge it.");
    expect(whatIsMissing(secondOpinion, "are you sure")).toBeNull();
    expect(whatIsMissing(secondOpinion, "/second-opinion")).toBeNull();
  });
});
