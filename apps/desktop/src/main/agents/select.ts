/**
 * Choosing who thinks for an agent.
 *
 * A brief asks for a *tier* — how much judgement it needs — rather than a
 * model, because the model that serves a tier depends on what is connected
 * today. So this is where "the everyday model" becomes an actual engine and an
 * actual model id.
 *
 * The interesting decision is what to do when the tier a brief asked for is not
 * available. Two rules, and they point in opposite directions on purpose:
 *
 *   - **Falling *down* is allowed.** An agent that wanted the deepest model can
 *     do useful work on the everyday one, and refusing to run at all because
 *     the best engine is offline is worse than running slightly less well and
 *     saying so.
 *   - **Falling *up* is not.** An agent asked for the quickest model, and
 *     silently spending frontier tokens on it — repeatedly, in the background —
 *     is how somebody's subscription disappears into filing. A cheap tier is a
 *     budget as much as a capability.
 *
 * Every substitution is reported. An agent that ran on something other than
 * what its brief said must say so, because the brief is the thing the owner
 * read and agreed to.
 */

import type { AgentBrief, EngineRoomStatus, EngineTier } from "@cadrane/contracts";
import { cheaperTier } from "../subscription-brain/catalogue.js";

export interface Selection {
  readonly engineId: string;
  readonly engineLabel: string;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly tier: EngineTier;
  /**
   * Set when this is not what the brief asked for, phrased for the owner.
   * Null when the brief got exactly what it wanted.
   */
  readonly substituted: string | null;
}

export type SelectionResult =
  | { readonly ok: true; readonly selection: Selection }
  | { readonly ok: false; readonly reason: string };

/**
 * Picks the engine and model an agent will actually run on.
 *
 * A pinned engine wins outright when it is ready — the owner named it, and
 * quietly using something else would make the pin decorative. When the pinned
 * engine is not ready, that is reported rather than worked around, because
 * "use Claude" and "use whatever" are different instructions.
 */
/**
 * The best model at or below `wanted`, within one engine.
 *
 * Shared by both paths so they cannot disagree about which direction is safe.
 */
function walkDown(
  engine: EngineRoomStatus["engines"][number],
  wanted: EngineTier
): EngineRoomStatus["engines"][number]["models"][number] | undefined {
  let tier: EngineTier | null = wanted;
  while (tier !== null) {
    const found = engine.models.find((candidate) => candidate.tier === tier);
    if (found !== undefined) {
      return found;
    }
    tier = cheaperTier(tier);
  }
  return undefined;
}

export function selectEngine(room: EngineRoomStatus, brief: AgentBrief): SelectionResult {
  const ready = room.engines.filter((engine) => engine.state === "ready");
  if (ready.length === 0) {
    return {
      ok: false,
      reason: "Nothing is connected to think with. Open the Engine Room to see what each engine needs."
    };
  }

  const pinned = brief.engine.pinnedEngineId;
  if (pinned !== null) {
    const engine = room.engines.find((candidate) => candidate.id === pinned);
    if (engine === undefined) {
      return { ok: false, reason: `This agent is pinned to ${pinned}, which is not an engine Rellane knows.` };
    }
    if (engine.state !== "ready") {
      // Not worked around. "Use Claude" and "use whatever is up" are different
      // instructions, and honouring the second when told the first is how a pin
      // becomes decoration.
      return {
        ok: false,
        reason: `This agent is pinned to ${engine.label}, which is not connected. ${engine.fixHint ?? ""}`.trim()
      };
    }
    /**
     * Down from the asked-for tier, never up — the same rule the unpinned path
     * follows, and it was missing here.
     *
     * This was `?? engine.models[0]`, so a brief asking for the quickest model
     * on a pinned engine with no quick model got whatever that engine happened
     * to list first. On an engine that lists its frontier model first, a
     * background filing job silently ran on frontier tokens. A cheap tier is a
     * budget as much as a capability, and the comment fifteen lines below says
     * exactly that.
     */
    const model = walkDown(engine, brief.engine.tier);
    if (model === undefined) {
      return { ok: false, reason: `${engine.label} offers no models to run on.` };
    }
    return {
      ok: true,
      selection: {
        engineId: engine.id,
        engineLabel: engine.label,
        modelId: model.id,
        modelLabel: model.label,
        tier: model.tier,
        substituted:
          model.tier === brief.engine.tier
            ? null
            : `${engine.label} had no ${brief.engine.tier} model, so this ran on ${model.label}.`
      }
    };
  }

  // No pin: walk down the ladder from what was asked for. Down only — an agent
  // that asked for the quickest model must never be quietly promoted onto
  // frontier tokens, because a cheap tier is a budget as well as a capability.
  let tier: EngineTier | null = brief.engine.tier;
  while (tier !== null) {
    for (const engine of ready) {
      const model = engine.models.find((candidate) => candidate.tier === tier);
      if (model !== undefined) {
        return {
          ok: true,
          selection: {
            engineId: engine.id,
            engineLabel: engine.label,
            modelId: model.id,
            modelLabel: model.label,
            tier: model.tier,
            substituted:
              model.tier === brief.engine.tier
                ? null
                : // Names the tier it actually landed on. "One tier down" was
                  // hardcoded while this loop can walk several, so a run that
                  // dropped from frontier to fast told the owner it had dropped
                  // to balanced — on the one line that exists to record exactly
                  // this substitution.
                  `No ${brief.engine.tier} model was connected, so this ran on the ${model.tierLabel.toLowerCase()} model instead: ${engine.label} ${model.label}.`
          }
        };
      }
    }
    tier = cheaperTier(tier);
  }

  return {
    ok: false,
    reason: `Nothing connected offers a ${brief.engine.tier} model or anything below it.`
  };
}
