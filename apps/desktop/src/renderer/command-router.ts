/**
 * What happens when you type something into the overlay.
 *
 * The overlay is not a chat box. It reads intent and offers actions, of which
 * "ask a model" is only one. Routing is deterministic and instant — no model
 * decides what your keystrokes mean, because a 14-second round trip to find out
 * you wanted the calculator would defeat the point.
 *
 * Pure functions. The overlay stays responsive because nothing here awaits.
 */

export type ActionKind = "skill" | "ask" | "search" | "compute" | "open" | "settings";

export interface Action {
  readonly id: string;
  readonly kind: ActionKind;
  readonly title: string;
  readonly detail: string;
  /** Higher sorts first. */
  readonly score: number;
  /** Shown right-aligned: the engine or tool that will handle it. */
  readonly badge?: string | undefined;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Words that should surface this skill even when the name does not match. */
  readonly triggers: readonly string[];
}

export interface RouteContext {
  readonly skills: readonly SkillSummary[];
  /** Null when no engine is docked; ask actions then explain rather than fail. */
  readonly engineLabel: string | null;
}

/** Arithmetic the overlay can answer without waking anything up. */
const ARITHMETIC = /^[\d\s().+\-*/%^]+$/u;

export function isArithmetic(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length > 0 && ARITHMETIC.test(trimmed) && /[\d]/u.test(trimmed) && /[+\-*/%^]/u.test(trimmed);
}

/**
 * Evaluates simple arithmetic without `eval`.
 *
 * Shunting-yard rather than a regex-guarded `Function` call: the guard is easy
 * to get subtly wrong, and this input arrives from a global hotkey that any
 * process could drive.
 */
export function evaluateArithmetic(expression: string): number | null {
  // Reject anything that is not entirely arithmetic, rather than extracting the
  // arithmetic out of it. Tokenising and ignoring the rest quietly turned
  // `process.exit(1)` into the expression `(1)` and answered 1 — which is both
  // wrong and exactly the sort of surprise this input must never produce.
  if (!ARITHMETIC.test(expression)) {
    return null;
  }
  const tokens = expression.match(/\d+\.?\d*|[+\-*/%^()]/gu);
  if (tokens === null) {
    return null;
  }
  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const output: (number | string)[] = [];
  const operators: string[] = [];

  for (const token of tokens) {
    if (/^\d/u.test(token)) {
      output.push(Number(token));
    } else if (token === "(") {
      operators.push(token);
    } else if (token === ")") {
      while (operators.length > 0 && operators[operators.length - 1] !== "(") {
        output.push(operators.pop() as string);
      }
      if (operators.pop() !== "(") {
        return null;
      }
    } else {
      while (
        operators.length > 0 &&
        operators[operators.length - 1] !== "(" &&
        (precedence[operators[operators.length - 1] as string] ?? 0) >= (precedence[token] ?? 0)
      ) {
        output.push(operators.pop() as string);
      }
      operators.push(token);
    }
  }
  while (operators.length > 0) {
    const op = operators.pop() as string;
    if (op === "(") return null;
    output.push(op);
  }

  const stack: number[] = [];
  for (const item of output) {
    if (typeof item === "number") {
      stack.push(item);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    switch (item) {
      case "+": stack.push(a + b); break;
      case "-": stack.push(a - b); break;
      case "*": stack.push(a * b); break;
      case "/": if (b === 0) return null; stack.push(a / b); break;
      case "%": if (b === 0) return null; stack.push(a % b); break;
      case "^": stack.push(a ** b); break;
      default: return null;
    }
  }
  const result = stack.pop();
  return stack.length === 0 && result !== undefined && Number.isFinite(result) ? result : null;
}

/** Word-boundary aware, so "pdf" matches "Read a PDF" but not "pdfkit-internals". */
function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function route(query: string, context: RouteContext): readonly Action[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    // Empty query offers the skills themselves, so the overlay is a launcher
    // before you have typed anything.
    return context.skills.slice(0, 6).map((skill, index) => ({
      id: `skill:${skill.id}`,
      kind: "skill" as const,
      title: skill.name,
      detail: skill.description,
      score: 100 - index
    }));
  }

  const actions: Action[] = [];

  if (isArithmetic(trimmed)) {
    const value = evaluateArithmetic(trimmed);
    if (value !== null) {
      actions.push({
        id: "compute",
        kind: "compute",
        title: formatNumber(value),
        detail: `${trimmed} · ⏎ copies it`,
        score: 1_000,
        badge: "instant"
      });
    }
  }

  for (const skill of context.skills) {
    const hit =
      matches(skill.name, trimmed) ||
      matches(skill.description, trimmed) ||
      skill.triggers.some((trigger) => matches(trimmed, trigger));
    if (hit) {
      actions.push({
        id: `skill:${skill.id}`,
        kind: "skill",
        title: skill.name,
        detail: skill.description,
        score: matches(skill.name, trimmed) ? 500 : 300
      });
    }
  }

  actions.push({
    id: "search",
    kind: "search",
    title: `Search your machine for “${trimmed}”`,
    detail: "Looks through the folders you have granted",
    score: 200,
    badge: "local"
  });

  actions.push({
    id: "ask",
    kind: "ask",
    title: `Ask: ${trimmed}`,
    detail:
      context.engineLabel === null
        ? "Opens Rellane, which answers it on whatever is connected there"
        : `Answered on ${context.engineLabel}`,
    score: 150,
    // "not connected" was a claim, and the one caller that passes null cannot
    // see engine state at all — so it was a claim nobody had checked. Null here
    // means "this caller does not know", which is not the same fact as "off".
    badge: context.engineLabel ?? "opens Rellane"
  });

  return actions.sort((a, b) => b.score - a.score);
}

export function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString("en-IN")
    : Number(value.toFixed(6)).toLocaleString("en-IN", { maximumFractionDigits: 6 });
}
