/**
 * Tools, risk, and the autonomy rules that govern them.
 *
 * A tool is a JSON-schema function a model may call. `llama-server` already
 * speaks this protocol, so the interesting part is not invocation — it is
 * deciding what a given skill is permitted to do without asking, and making
 * every action leave something the user can inspect and undo.
 */

/**
 * What a tool can do, worst case. Ordered: each class contains the ones before it.
 *
 * `outbound` is deliberately separate from `network`. Fetching a public price
 * list and messaging a customer are both "network", but only one of them can
 * embarrass you in front of a buyer, and only one of them can never be undone.
 */
export type RiskClass = "read" | "write" | "network" | "outbound" | "shell";

export const RISK_ORDER: readonly RiskClass[] = ["read", "write", "network", "outbound", "shell"];

/** Which engine a tool needs. Drives what lights up when a subscription is docked. */
export type EngineTier =
  /** Runs on the local model. Works offline, costs nothing. */
  | "local"
  /**
   * Needs the docked CLI. Reserved for what a local model genuinely cannot do:
   * million-token context over a whole folder, schema-guaranteed bulk
   * extraction, writing a new skill. Not "the same thing but better".
   */
  | "docked"
  /** Pure code. No model involved. */
  | "none";

export interface ToolDefinition {
  readonly name: string;
  /** Shown to the model. Precise, because a vague description produces vague calls. */
  readonly description: string;
  /** JSON Schema for the arguments, passed to llama-server verbatim. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly risk: RiskClass;
  readonly engine: EngineTier;
  /**
   * Whether the effect can be undone. An action that cannot produce an undo
   * can never run under "act freely" autonomy, whatever a skill requests.
   */
  readonly reversible: boolean;
  /** One line, in the owner's words, for the approval sheet. */
  readonly summarise: (args: Readonly<Record<string, unknown>>) => string;
}

/** `off` < `draft` < `confirm` < `auto`. Matches the Mark model already shipped. */
export type Autonomy = "off" | "draft" | "confirm" | "auto";

export const AUTONOMY_ORDER: readonly Autonomy[] = ["off", "draft", "confirm", "auto"];

export function autonomyRank(level: Autonomy): number {
  return AUTONOMY_ORDER.indexOf(level);
}

export interface SkillPolicy {
  /** What this skill asks for, per risk class. */
  readonly byRisk: Readonly<Partial<Record<RiskClass, Autonomy>>>;
}

/**
 * The ceiling nothing may exceed.
 *
 * Amber's decision, recorded here as code rather than as a default: anything
 * that leaves the machine always asks, and that cannot be turned off. `shell`
 * is capped the same way because a shell command is an unbounded outbound
 * action wearing a different hat.
 */
export const HARD_CEILING: Readonly<Record<RiskClass, Autonomy>> = Object.freeze({
  read: "auto",
  write: "auto",
  network: "auto",
  outbound: "confirm",
  shell: "confirm"
});

/** Risk classes whose ceiling is locked and must render as non-editable. */
export const LOCKED_RISKS: ReadonlySet<RiskClass> = new Set<RiskClass>(["outbound", "shell"]);

export type Decision = "run" | "ask" | "draft" | "refuse";

/**
 * What happens when this skill calls this tool.
 *
 * Three gates in order: the skill's own setting, the hard ceiling, and
 * reversibility. The last one is why this is not a simple min() — a skill can
 * ask for `auto` on a destructive tool and still be forced to confirm, because
 * "act freely" is only safe when there is a way back.
 */
export function decide(input: {
  readonly tool: ToolDefinition;
  readonly policy: SkillPolicy;
}): { decision: Decision; reason: string } {
  const requested = input.policy.byRisk[input.tool.risk] ?? "off";
  if (requested === "off") {
    return { decision: "refuse", reason: `This skill is not allowed to ${input.tool.risk}.` };
  }

  const ceiling = HARD_CEILING[input.tool.risk];
  const effective =
    autonomyRank(requested) <= autonomyRank(ceiling) ? requested : ceiling;

  if (effective === "draft") {
    return { decision: "draft", reason: "Prepared for you to review." };
  }

  if (effective === "auto" && !input.tool.reversible) {
    return {
      decision: "ask",
      reason: "This cannot be undone, so it asks first even on automatic."
    };
  }

  if (effective === "auto") {
    return { decision: "run", reason: "Runs automatically; you can undo it." };
  }

  return {
    decision: "ask",
    reason: LOCKED_RISKS.has(input.tool.risk)
      ? "Anything that leaves this machine always asks."
      : "Waiting for your approval."
  };
}

/** Sensible starting point for a new skill: look freely, change nothing. */
export const READ_ONLY_POLICY: SkillPolicy = Object.freeze({
  byRisk: Object.freeze({ read: "auto" as const })
});
