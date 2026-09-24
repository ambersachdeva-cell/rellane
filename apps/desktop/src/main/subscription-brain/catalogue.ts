/**
 * Every engine Rellane can think with, and what each one costs you.
 *
 * The organising idea, and the reason this file exists rather than a dropdown
 * of model strings: **a person choosing a model is not choosing a model.** They
 * are choosing how much judgement they want, how long they are willing to wait,
 * and what it will cost them. Model names are how those three things are
 * spelled, not what they mean.
 *
 * So every entry carries a tier, a speed, and — the part that actually decides
 * it — how you are paying for it.
 *
 * ## Subscription first, and on purpose
 *
 * If you already pay for Claude Pro, you should not then pay per token through
 * an API to use the thing you bought. Rellane drives the CLI you already have,
 * signed in as you, exactly as you would run it by hand. No token is read,
 * copied or forwarded; the vendor's own binary authenticates itself.
 *
 * That is the headline feature and not a fallback. An API key is offered for
 * people who have no subscription, or who want a second seat for the Bench, and
 * it is the *third* way in — after your subscription and after this Mac.
 */

import type { BrainProviderId } from "./types.js";

/**
 * How much judgement a model brings, and what it costs in patience.
 *
 * Ordered deliberately: the array index is the ladder, so "one tier down" is a
 * meaningful operation and the UI can offer it without a lookup table.
 */
export const TIERS = ["frontier", "balanced", "fast", "on-device"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Readonly<Record<Tier, string>> = {
  frontier: "Deepest",
  balanced: "Balanced",
  fast: "Quick",
  "on-device": "On this Mac"
};

/**
 * What each tier is actually for, in the owner's words rather than benchmarks.
 *
 * DESIGN.md §7: the product talks like a competent colleague. "Reasons through
 * a problem you cannot describe cleanly yet" is a sentence somebody can choose
 * from. "SOTA reasoning, 200k context" is a spec sheet.
 */
export const TIER_MEANING: Readonly<Record<Tier, string>> = {
  frontier: "Reasons through a problem you cannot describe cleanly yet. Slowest, and the one to reach for when being wrong would be expensive.",
  balanced: "The everyday setting. Fast enough to stay in a conversation, good enough for real work.",
  fast: "Mechanical work at speed — sorting, extracting, rephrasing. Do not ask it to make a judgement call.",
  "on-device": "Never leaves this Mac and costs nothing. Weaker than the others, and honest about it."
};

/** How you are paying to use an engine — the thing that actually decides. */
export type AccessKind = "subscription" | "on-device" | "api-key";

export const ACCESS_LABELS: Readonly<Record<AccessKind, string>> = {
  subscription: "Your subscription",
  "on-device": "This Mac",
  "api-key": "Pay per use"
};

export interface CatalogueModel {
  /** What is passed to the CLI. An alias where one exists — see providers.ts. */
  readonly id: string;
  /** What a person calls it. */
  readonly label: string;
  readonly tier: Tier;
  /**
   * True when this model is reachable on a plan the user already pays a flat
   * fee for. The Engine Room sorts by this before anything else, because a
   * model that costs nothing more is almost always the right default.
   */
  readonly includedInSubscription: boolean;
  /** A sentence for the picker. Never a benchmark. */
  readonly note: string;
}

export interface CatalogueEngine {
  readonly providerId: BrainProviderId | "local";
  readonly label: string;
  readonly access: AccessKind;
  /**
   * How this engine is reached, said plainly, for the row that explains a red
   * light. "Install Claude Code" is actionable; "provider unavailable" is not.
   */
  readonly reachedBy: string;
  /** What to do when it is not connected. The whole point of a red light. */
  readonly fixHint: string;
  readonly models: readonly CatalogueModel[];
}

/**
 * Claude, through Claude Code.
 *
 * Aliases rather than pinned identifiers, because `--model opus` survives a
 * version bump and `claude-opus-5` becomes a lie the day the next one ships.
 */
const CLAUDE_ENGINE: CatalogueEngine = {
  providerId: "claude",
  label: "Claude",
  access: "subscription",
  reachedBy: "Claude Code, signed in as you",
  fixHint:
    "Install Claude Code and sign in once. Rellane starts it as you and never reads your login.",
  models: [
    {
      id: "opus",
      label: "Opus",
      tier: "frontier",
      includedInSubscription: true,
      note: "The one to use when being wrong would be expensive."
    },
    {
      id: "sonnet",
      label: "Sonnet",
      tier: "balanced",
      includedInSubscription: true,
      note: "The everyday setting for real work."
    },
    {
      id: "haiku",
      label: "Haiku",
      tier: "fast",
      includedInSubscription: true,
      note: "Mechanical work at speed."
    }
  ]
};

/**
 * Gemini, through Antigravity.
 *
 * The suffix on these is reasoning effort rather than a different model, which
 * is why one family spans three tiers — see the note in providers.ts.
 */
const ANTIGRAVITY_ENGINE: CatalogueEngine = {
  providerId: "antigravity",
  label: "Gemini",
  access: "subscription",
  reachedBy: "Antigravity (agy), signed in as you",
  fixHint: "Install the Antigravity CLI and sign in once with your Google account.",
  models: [
    {
      id: "gemini-3.1-pro-high",
      label: "Gemini Pro",
      tier: "frontier",
      includedInSubscription: true,
      note: "Deep reasoning on your Google plan."
    },
    {
      id: "gemini-3.7-flash-high",
      label: "Gemini Flash · careful",
      tier: "balanced",
      includedInSubscription: true,
      note: "Flash, told to think harder before answering."
    },
    {
      id: "gemini-3.7-flash-low",
      label: "Gemini Flash · quick",
      tier: "fast",
      includedInSubscription: true,
      note: "The workhorse for mechanical extraction."
    }
  ]
};

const GEMINI_CLI_ENGINE: CatalogueEngine = {
  providerId: "gemini",
  label: "Gemini CLI",
  access: "subscription",
  reachedBy: "Google's own gemini CLI",
  fixHint: "Install Google's gemini CLI if you would rather use it than Antigravity.",
  models: [
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      tier: "fast",
      includedInSubscription: true,
      note: "Quick work through Google's own CLI."
    }
  ]
};

/**
 * This Mac.
 *
 * Listed as an engine rather than as a fallback, because it is the only one
 * that works on a train and the only one where the files genuinely never leave.
 * Its model list is filled in at runtime from what is actually installed — this
 * entry describes the engine, not its contents.
 */
const LOCAL_ENGINE: CatalogueEngine = {
  providerId: "local",
  label: "On this Mac",
  access: "on-device",
  reachedBy: "A model running on your own machine",
  fixHint: "Install a local model to work offline and keep everything on this Mac.",
  models: []
};

/**
 * Every engine, in the order the Engine Room shows them.
 *
 * Subscriptions first because they are what the owner already pays for, then
 * this Mac. An engine's position here is a default and never a policy: a pinned
 * choice in settings beats it.
 */
export const CATALOGUE: readonly CatalogueEngine[] = Object.freeze([
  CLAUDE_ENGINE,
  ANTIGRAVITY_ENGINE,
  GEMINI_CLI_ENGINE,
  LOCAL_ENGINE
]);

export function engineFor(providerId: BrainProviderId | "local"): CatalogueEngine | null {
  return CATALOGUE.find((engine) => engine.providerId === providerId) ?? null;
}

/**
 * Every model at a tier, across engines, subscription-included first.
 *
 * This is what makes "use the quick one" a thing a person can ask for without
 * knowing which engine is connected today.
 */
export function modelsAtTier(tier: Tier): readonly (CatalogueModel & {
  readonly providerId: BrainProviderId | "local";
})[] {
  return CATALOGUE.flatMap((engine) =>
    engine.models
      .filter((model) => model.tier === tier)
      .map((model) => ({ ...model, providerId: engine.providerId }))
  ).sort((left, right) => Number(right.includedInSubscription) - Number(left.includedInSubscription));
}

/** One tier down. Returns null at the bottom rather than wrapping. */
export function cheaperTier(tier: Tier): Tier | null {
  const index = TIERS.indexOf(tier);
  return index === -1 || index === TIERS.length - 1 ? null : (TIERS[index + 1] as Tier);
}
