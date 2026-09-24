import { describe, expect, it } from "vitest";
import { checkBudgets } from "./usage-budget.js";
import type { BudgetRule } from "./usage-budget.js";

describe("checkBudgets", () => {
  it("marks a limit of zero as no-limit and never fine", () => {
    const report = checkBudgets({
      rules: [{ providerId: "codex", askedPerDay: 0 }],
      askedToday: [{ providerId: "codex", label: "Codex", asked: 5 }],
      usableProviderIds: ["codex"],
      now: 1000,
    });

    expect(report.checks.length).toBe(1);
    const check = report.checks[0]!;
    expect(check.state).toBe("no-limit");
    expect(check.limit).toBe(0);
    expect(check.askedToday).toBe(5);
  });

  it("marks 8 of 10 as close and 10 of 10 as over", () => {
    const report = checkBudgets({
      rules: [
        { providerId: "claude", askedPerDay: 10 },
        { providerId: "codex", askedPerDay: 10 },
        { providerId: "gemini", askedPerDay: 10 },
      ],
      askedToday: [
        { providerId: "claude", label: "Claude", asked: 7 },
        { providerId: "codex", label: "Codex", asked: 8 },
        { providerId: "gemini", label: "Gemini", asked: 10 },
      ],
      usableProviderIds: ["claude", "codex", "gemini"],
      now: 1000,
    });

    expect(report.checks.length).toBe(3);
    const claudeCheck = report.checks[0]!;
    const codexCheck = report.checks[1]!;
    const geminiCheck = report.checks[2]!;

    expect(claudeCheck.state).toBe("fine");
    expect(codexCheck.state).toBe("close");
    expect(geminiCheck.state).toBe("over");
  });

  it("suggests an alternative usable subscription with fewer asks when one is close", () => {
    const report = checkBudgets({
      rules: [
        { providerId: "claude", askedPerDay: 10 },
        { providerId: "gemini", askedPerDay: 20 },
      ],
      askedToday: [
        { providerId: "claude", label: "Claude", asked: 8 },
        { providerId: "gemini", label: "Gemini", asked: 2 },
      ],
      usableProviderIds: ["claude", "gemini"],
      now: 1000,
    });

    expect(report.suggestInstead).toBe("gemini");
  });

  it("never suggests a subscription that is itself close or over", () => {
    const report = checkBudgets({
      rules: [
        { providerId: "claude", askedPerDay: 10 },
        { providerId: "gemini", askedPerDay: 5 },
      ],
      askedToday: [
        { providerId: "claude", label: "Claude", asked: 8 },
        { providerId: "gemini", label: "Gemini", asked: 4 },
      ],
      usableProviderIds: ["claude", "gemini"],
      now: 1000,
    });

    expect(report.suggestInstead).toBeNull();
  });

  it("never suggests a subscription that is not in usableProviderIds", () => {
    const report = checkBudgets({
      rules: [{ providerId: "claude", askedPerDay: 10 }],
      askedToday: [
        { providerId: "claude", label: "Claude", asked: 9 },
        { providerId: "gemini", label: "Gemini", asked: 1 },
      ],
      usableProviderIds: ["claude"],
      now: 1000,
    });

    expect(report.suggestInstead).toBeNull();
  });

  it("returns null for suggestInstead when all subscriptions are fine", () => {
    const report = checkBudgets({
      rules: [
        { providerId: "claude", askedPerDay: 10 },
        { providerId: "gemini", askedPerDay: 10 },
      ],
      askedToday: [
        { providerId: "claude", label: "Claude", asked: 2 },
        { providerId: "gemini", label: "Gemini", asked: 1 },
      ],
      usableProviderIds: ["claude", "gemini"],
      now: 1000,
    });

    expect(report.suggestInstead).toBeNull();
  });

  it("always includes the note clarifying limits are his own and not the provider's", () => {
    const report = checkBudgets({
      rules: [],
      askedToday: [],
      usableProviderIds: [],
      now: 1000,
    });

    expect(report.note).toContain("counts what Rellane asked");
    expect(report.note).toContain("your own limit, not the provider's");
    expect(report.note).toContain("cannot see");
  });

  it("handles messy cases: duplicate rules, negative limits, limit of 1, and missing asks", () => {
    const rules: readonly BudgetRule[] = [
      { providerId: "alpha", askedPerDay: 10 },
      { providerId: "alpha", askedPerDay: 4 },
      { providerId: "beta", askedPerDay: -10 },
      { providerId: "gamma", askedPerDay: 1 },
      { providerId: "delta", askedPerDay: 5 },
    ];

    const report = checkBudgets({
      rules,
      askedToday: [
        { providerId: "alpha", label: "Alpha", asked: 4 },
        { providerId: "beta", label: "Beta", asked: 3 },
        { providerId: "gamma", label: "Gamma", asked: 0 },
      ],
      usableProviderIds: ["alpha", "beta", "gamma", "delta"],
      now: 1000,
    });

    expect(report.checks.length).toBe(4);

    const alpha = report.checks.find((c) => c.providerId === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.limit).toBe(4);
    expect(alpha!.state).toBe("over");

    const beta = report.checks.find((c) => c.providerId === "beta");
    expect(beta).toBeDefined();
    expect(beta!.limit).toBe(0);
    expect(beta!.state).toBe("no-limit");

    const gamma = report.checks.find((c) => c.providerId === "gamma");
    expect(gamma).toBeDefined();
    expect(gamma!.limit).toBe(1);
    expect(gamma!.state).toBe("fine");

    const delta = report.checks.find((c) => c.providerId === "delta");
    expect(delta).toBeDefined();
    expect(delta!.askedToday).toBe(0);
    expect(delta!.limit).toBe(5);
    expect(delta!.state).toBe("fine");
  });

  it("handles empty rules by setting all checks to no-limit and headline saying no limits set", () => {
    const report = checkBudgets({
      rules: [],
      askedToday: [{ providerId: "codex", label: "Codex", asked: 12 }],
      usableProviderIds: ["codex"],
      now: 1000,
    });

    expect(report.headline).toBe("No daily limits are set.");
    expect(report.checks.length).toBe(1);
    expect(report.checks[0]!.state).toBe("no-limit");
  });
});
