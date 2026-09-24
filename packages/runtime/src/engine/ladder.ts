/**
 * The Ladder — which engine answers which task.
 *
 * Not one model but a tier: a small local model for the frequent cheap work, a
 * larger one for real reasoning, and the docked CLI for what neither can do.
 * Routing is by task class, not by a dropdown, because the person asking for a
 * folder to be tidied has no reason to know or care.
 *
 * Two rules the routing must never break:
 *   - the deterministic path never touches a model at all, so the product keeps
 *     working when every engine is down;
 *   - a task is only sent to the frontier tier when the local tier genuinely
 *     cannot do it, because that tier costs money and quota.
 */

export type Tier =
  /** No model. Rules, arithmetic, file operations. */
  | "none"
  /** Small local model. Classification, extraction, short drafting. */
  | "local-small"
  /** Larger local model. Reasoning over a document, longer drafting. */
  | "local-large"
  /** The docked CLI. Whole-folder context, schema-guaranteed bulk work. */
  | "frontier";

export type TaskClass =
  | "classify"
  | "extract"
  | "draft-short"
  | "summarise"
  | "reason"
  | "whole-folder"
  | "write-skill"
  | "deterministic";

/**
 * Where each kind of work belongs.
 *
 * `whole-folder` and `write-skill` are frontier-only on purpose: a million-token
 * context and a reliably-schema'd bulk pass are things a 9B on 12 GB cannot
 * approach, and pretending otherwise produces a worse answer slowly.
 */
const HOME: Readonly<Record<TaskClass, Tier>> = Object.freeze({
  deterministic: "none",
  classify: "local-small",
  extract: "local-small",
  "draft-short": "local-small",
  summarise: "local-large",
  reason: "local-large",
  "whole-folder": "frontier",
  "write-skill": "frontier"
});

export interface TierAvailability {
  readonly localSmall: boolean;
  readonly localLarge: boolean;
  readonly frontier: boolean;
}

export interface Routing {
  readonly tier: Tier;
  /** Plain sentence, shown when the answer arrives, naming who answered. */
  readonly reason: string;
  /** True when the preferred tier was unavailable and this is second choice. */
  readonly degraded: boolean;
}

function has(tier: Tier, available: TierAvailability): boolean {
  switch (tier) {
    case "none":
      return true;
    case "local-small":
      return available.localSmall;
    case "local-large":
      return available.localLarge;
    case "frontier":
      return available.frontier;
  }
}

/**
 * Routes one task.
 *
 * Falls *upward* when the preferred tier is missing — a small model being
 * absent should not stop work a larger one can do. It never falls downward into
 * the frontier tier for work that belongs locally, because that would spend
 * someone's quota to save them a download.
 */
export function route(task: TaskClass, available: TierAvailability): Routing | null {
  const preferred = HOME[task];
  if (has(preferred, available)) {
    return { tier: preferred, reason: describe(preferred), degraded: false };
  }

  const upward: readonly Tier[] =
    preferred === "local-small"
      ? ["local-large", "frontier"]
      : preferred === "local-large"
        ? ["frontier"]
        : [];

  for (const fallback of upward) {
    if (has(fallback, available)) {
      return {
        tier: fallback,
        reason: `${describe(fallback)} — the smaller one is not installed.`,
        degraded: true
      };
    }
  }

  return null;
}

function describe(tier: Tier): string {
  switch (tier) {
    case "none":
      return "Answered without a model.";
    case "local-small":
      return "Answered by the small local model.";
    case "local-large":
      return "Answered by the local model.";
    case "frontier":
      return "Answered by your connected tool.";
  }
}

/**
 * What to tell someone when nothing can do the task.
 *
 * Names the specific thing that would fix it rather than saying "unavailable",
 * because "unavailable" gives a person nothing to act on.
 */
export function explainUnavailable(task: TaskClass): string {
  const home = HOME[task];
  if (home === "frontier") {
    return "This needs a connected tool — open the Engine drawer and connect one.";
  }
  return "This needs a local model — install one from the Engine drawer.";
}

/** Whether the product still works with no engine at all. */
export function worksWithoutAnyEngine(task: TaskClass): boolean {
  return HOME[task] === "none";
}
