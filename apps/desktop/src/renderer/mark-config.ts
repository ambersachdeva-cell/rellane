/**
 * Mark — the agent that lives in the owner's messaging app.
 *
 * Mark is configuration over a shared engine, not code per customer. A tenant
 * changes his name, language and working hours; what he is *allowed to do* is
 * governed separately, and the platform owner sets the ceiling.
 *
 * Autonomy is graduated on purpose. A model's first unreviewed message must
 * never be a price, so every outward capability starts at "draft" and is earned
 * upward per tenant. `off` < `draft` < `confirm` < `auto`.
 */

export type Autonomy = "off" | "draft" | "confirm" | "auto";

export const AUTONOMY_ORDER: readonly Autonomy[] = ["off", "draft", "confirm", "auto"];

export function autonomyRank(level: Autonomy): number {
  return AUTONOMY_ORDER.indexOf(level);
}

/** Never above the platform ceiling, whatever the tenant asked for. */
export function effectiveAutonomy(requested: Autonomy, ceiling: Autonomy): Autonomy {
  return autonomyRank(requested) <= autonomyRank(ceiling) ? requested : ceiling;
}

export interface MarkAbility {
  readonly id: string;
  readonly name: string;
  /** What the owner sees happen. Never mentions a model. */
  readonly why: string;
  /** True when this can reach someone outside the business. */
  readonly outward: boolean;
}

export const MARK_ABILITIES: readonly MarkAbility[] = Object.freeze([
  {
    id: "digest",
    name: "Morning digest",
    why: "What came in overnight, what is overdue, what is worth chasing first",
    outward: false
  },
  {
    id: "hot-alert",
    name: "Hot enquiry alert",
    why: "Messages you within seconds when a lead matches a rule you set",
    outward: false
  },
  {
    id: "followup",
    name: "Follow-up reminders",
    why: "Reminds you before a promise comes due, and again if it slips",
    outward: false
  },
  {
    id: "deadman",
    name: "Tell you when it goes quiet",
    why: "If nothing arrives for hours, Mark says so. Silence never looks like calm.",
    outward: false
  },
  {
    id: "reply-parse",
    name: "Understand your replies",
    why: 'You type "done" or "call kal 4 baje" and the lead updates itself',
    outward: false
  },
  {
    id: "draft-quote",
    name: "Prepare quotations",
    why: "Prices from your rate card, then writes it up for you to check",
    outward: true
  },
  {
    id: "buyer-reply",
    name: "Reply to buyers",
    why: "Answers enquiries directly in your voice",
    outward: true
  }
]);

export interface MarkConfig {
  readonly name: string;
  readonly language: "hinglish" | "english" | "hindi";
  readonly channel: "telegram" | "whatsapp" | "email";
  /** Local 24h hours. Mark stays silent outside these except for hot alerts. */
  readonly quietFrom: number;
  readonly quietTo: number;
  /** Hours of silence before the dead-man's switch fires. */
  readonly silenceAlarmHours: number;
  readonly abilities: Readonly<Record<string, Autonomy>>;
}

export const DEFAULT_MARK: MarkConfig = Object.freeze({
  name: "Mark",
  language: "hinglish",
  channel: "telegram",
  quietFrom: 9,
  quietTo: 21,
  silenceAlarmHours: 6,
  abilities: Object.freeze({
    digest: "auto",
    "hot-alert": "auto",
    followup: "auto",
    deadman: "auto",
    "reply-parse": "auto",
    // Everything that can reach a buyer starts as a draft, always.
    "draft-quote": "draft",
    "buyer-reply": "off"
  })
});

/**
 * The ceiling the platform owner sets. A tenant can never exceed it, and an
 * outward ability is capped harder than an internal one by default.
 */
export interface PlatformPolicy {
  readonly outwardCeiling: Autonomy;
  readonly inwardCeiling: Autonomy;
}

export const DEFAULT_POLICY: PlatformPolicy = Object.freeze({
  outwardCeiling: "confirm",
  inwardCeiling: "auto"
});

export function ceilingFor(ability: MarkAbility, policy: PlatformPolicy): Autonomy {
  return ability.outward ? policy.outwardCeiling : policy.inwardCeiling;
}

/** What Mark will actually do, after the platform ceiling is applied. */
export function resolveAbilities(
  config: MarkConfig,
  policy: PlatformPolicy
): Readonly<Record<string, Autonomy>> {
  const resolved: Record<string, Autonomy> = {};
  for (const ability of MARK_ABILITIES) {
    const requested = config.abilities[ability.id] ?? "off";
    resolved[ability.id] = effectiveAutonomy(requested, ceilingFor(ability, policy));
  }
  return resolved;
}

export function describeAutonomy(level: Autonomy): string {
  switch (level) {
    case "off":
      return "Never";
    case "draft":
      return "Prepare it, wait for me";
    case "confirm":
      return "Ask me, then send";
    case "auto":
      return "Just do it";
  }
}
