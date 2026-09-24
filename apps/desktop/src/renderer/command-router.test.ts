import { describe, expect, it } from "vitest";
import {
  evaluateArithmetic,
  formatNumber,
  isArithmetic,
  route,
  type RouteContext
} from "./command-router";

const SKILLS = [
  { id: "librarian", name: "Desktop Librarian", description: "Tidy your downloads", triggers: ["organise", "tidy", "downloads"] },
  { id: "paper", name: "Paper Trail", description: "Pull rows out of a PDF", triggers: ["pdf", "invoice"] },
  { id: "shortcuts", name: "Shortcuts Builder", description: "Turn a sentence into a macOS Shortcut", triggers: ["automate"] }
];

const ctx: RouteContext = { skills: SKILLS, engineLabel: "Qwen3.5-9B" };

describe("arithmetic answers without waking an engine", () => {
  it("recognises expressions, not bare numbers or prose", () => {
    expect(isArithmetic("2000 * 68")).toBe(true);
    expect(isArithmetic("(120 + 30) / 2")).toBe(true);
    expect(isArithmetic("2000")).toBe(false);
    expect(isArithmetic("organise downloads")).toBe(false);
    expect(isArithmetic("")).toBe(false);
  });

  it("respects precedence and parentheses", () => {
    expect(evaluateArithmetic("2 + 3 * 4")).toBe(14);
    expect(evaluateArithmetic("(2 + 3) * 4")).toBe(20);
    expect(evaluateArithmetic("2 ^ 10")).toBe(1024);
    expect(evaluateArithmetic("2000 * 68")).toBe(136000);
  });

  it("refuses rather than throwing on nonsense", () => {
    expect(evaluateArithmetic("2 +")).toBeNull();
    expect(evaluateArithmetic("(2 + 3")).toBeNull();
    expect(evaluateArithmetic("2 + 3)")).toBeNull();
    expect(evaluateArithmetic("1 / 0")).toBeNull();
  });

  it("evaluates without eval, so a hostile hotkey cannot execute anything", () => {
    // Any process can drive a global hotkey. These must be inert.
    expect(evaluateArithmetic("process.exit(1)")).toBeNull();
    expect(evaluateArithmetic("require('fs')")).toBeNull();
    expect(evaluateArithmetic("1;globalThis.x=1")).toBeNull();
  });

  it("formats the way an Indian business reads numbers", () => {
    expect(formatNumber(136000)).toBe("1,36,000");
    expect(formatNumber(1.5)).toBe("1.5");
  });
});

describe("routing", () => {
  it("offers the skills themselves before anything is typed", () => {
    const actions = route("", ctx);
    expect(actions.every((a) => a.kind === "skill")).toBe(true);
    expect(actions[0]?.title).toBe("Desktop Librarian");
  });

  it("puts an instant answer above everything else", () => {
    const actions = route("2000 * 68", ctx);
    expect(actions[0]?.kind).toBe("compute");
    expect(actions[0]?.title).toBe("1,36,000");
  });

  it("finds a skill by name", () => {
    expect(route("librarian", ctx)[0]?.id).toBe("skill:librarian");
  });

  it("finds a skill by what you actually typed, not just its name", () => {
    const ids = route("organise", ctx).map((a) => a.id);
    expect(ids).toContain("skill:librarian");
  });

  it("ranks a name match above a description match", () => {
    const actions = route("paper", ctx);
    expect(actions[0]?.id).toBe("skill:paper");
  });

  it("always offers search and ask as a floor", () => {
    const kinds = route("something nothing matches", ctx).map((a) => a.kind);
    expect(kinds).toContain("search");
    expect(kinds).toContain("ask");
  });

  it("names the engine that will answer", () => {
    const ask = route("what is a dieline", ctx).find((a) => a.kind === "ask");
    expect(ask?.badge).toBe("Qwen3.5-9B");
  });

  it("says what happens rather than claiming nothing is connected", () => {
    // The overlay is the only caller that passes null and it cannot see engine
    // state: the main process refuses it, correctly. So "not connected" was a
    // statement about something nobody had looked at, shown whether or not an
    // engine was docked.
    const ask = route("hello", { ...ctx, engineLabel: null }).find((a) => a.kind === "ask");
    expect(ask?.detail).toMatch(/Opens Rellane/u);
    expect(ask?.detail).not.toMatch(/not connected|No engine/iu);
    expect(ask?.badge).not.toMatch(/not connected/iu);
  });
});
