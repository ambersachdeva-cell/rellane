/**
 * Agent briefs — telling an agent what it is working in.
 *
 * An agent here is a **declaration**, never code. It names what it is for,
 * which folders it may see, what it may do, who thinks for it, and what it may
 * send. That choice is the whole point: a brief can be read before it runs,
 * diffed in review, replayed against history, written by a person or generated
 * by a model, and — the part that matters most — *shown to the owner in one
 * sentence they can check.*
 *
 * An agent whose operating context lives inside a prompt string is one nobody
 * can audit, including the person who wrote it.
 *
 * Two rules are enforced by the type system rather than by a check somewhere
 * that could be forgotten:
 *
 *   - **There is no automatic outbound.** `OutboundPolicy` has two members and
 *     "auto" is not one of them, so an agent that sends without asking cannot be
 *     expressed, let alone saved.
 *   - **A brief is resolved against the ceiling before anyone sees it.** What
 *     the UI renders is what the agent will actually get, with everything
 *     withheld named and explained — DESIGN.md principle 2.
 */

import type {
  AgentBrief,
  ContextSource,
  EngineTier,
  ResolvedBrief
} from "@cadrane/contracts";
import { basename } from "node:path";
import type { StoredBrief } from "./roster.js";
import { list, plural } from "../../shared/copy.js";

/**
 * Ceilings a brief cannot exceed, whatever it asks for.
 *
 * These are not tuning knobs. An agent that can take 500 steps is one that can
 * spend an afternoon and a subscription before anybody notices, and the owner
 * who wrote "be thorough" in the instructions did not agree to that.
 */
export const MAX_STEPS_CEILING = 60;
export const MAX_MINUTES_CEILING = 30;

/** What the platform will allow this install to grant, right now. */
export interface Ceiling {
  /** Folders the owner has actually granted, and that still open. */
  readonly grantedFolders: readonly string[];
  /** Capability ids that exist and loaded cleanly. */
  readonly availableCapabilities: readonly string[];
  /**
   * Briefs the owner wrote, as stored.
   *
   * Required rather than optional so the typechecker finds every caller. An
   * optional field here would let a new call site silently resolve only the
   * three shipped agents — and the failure would be "my agent disappeared",
   * which reads as data loss rather than as a missing argument.
   */
  readonly storedAgents: readonly StoredBrief[];
}

export function newBrief(input: {
  id: string;
  name: string;
  purpose: string;
  instructions?: string;
  folders?: readonly string[];
  reads?: readonly ContextSource[];
  capabilities?: readonly string[];
  tier?: EngineTier;
  pinnedEngineId?: string | null;
  maxSteps?: number;
  maxMinutes?: number;
  outbound?: AgentBrief["outbound"];
}): AgentBrief {
  return {
    id: input.id,
    name: input.name,
    purpose: input.purpose,
    instructions: input.instructions ?? "",
    workspace: {
      // Empty by default, and deliberately. An agent that can read every folder
      // you ever granted is one you cannot reason about, and the safe default
      // for a thing that touches files is nothing.
      folders: input.folders ?? [],
      reads: input.reads ?? ["folders"]
    },
    capabilities: input.capabilities ?? [],
    engine: {
      tier: input.tier ?? "balanced",
      pinnedEngineId: input.pinnedEngineId ?? null
    },
    limits: {
      maxSteps: clamp(input.maxSteps ?? 20, 1, MAX_STEPS_CEILING),
      maxMinutes: clamp(input.maxMinutes ?? 10, 1, MAX_MINUTES_CEILING)
    },
    // "ask" rather than "never" as the default, because an agent that can never
    // send anything is a fine safe default but a useless one, and "ask" is
    // already the strongest guarantee the product makes.
    outbound: input.outbound ?? "ask"
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low;
  }
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

/**
 * Applies the ceiling and produces what the owner will actually be shown.
 *
 * Anything asked for and not available is *named*, never dropped. A brief that
 * silently loses a folder is how somebody comes to believe an agent is watching
 * something it has not looked at in a month.
 */
export function resolveBrief(brief: AgentBrief, ceiling: Ceiling): ResolvedBrief {
  const withheld: { what: string; why: string }[] = [];

  const folders = brief.workspace.folders.filter((folder) => {
    if (ceiling.grantedFolders.includes(folder)) {
      return true;
    }
    withheld.push({
      what: basename(folder),
      // The ordinary cause first, per DESIGN.md §7. On an ad-hoc-signed app a
      // withdrawn grant after an update is the normal case, not an alarm.
      why: "That folder is not granted right now. This usually means the grant was withdrawn when Rellane last updated, rather than that anything is wrong."
    });
    return false;
  });

  const capabilities = brief.capabilities.filter((capability) => {
    if (ceiling.availableCapabilities.includes(capability)) {
      return true;
    }
    withheld.push({
      what: capability,
      why: "No skill by that name is installed, so this agent cannot use it."
    });
    return false;
  });

  const resolved = {
    brief,
    folders,
    capabilities,
    withheld,
    /**
     * Inert is about usefulness, not validity: **no folder, or no tool.**
     *
     * The comment here used to say "no folder *and* no capability" while the
     * code said "or" — a real contradiction, and the code is the right half.
     * A brief with no folder has an empty sandbox, so every call is refused and
     * every answer invented. A brief with no tool can only restate the folder
     * listing it was handed, which is not work anybody wanted done; the shipped
     * "What changed" agent is the narrowest useful one and it still holds
     * `list_folder`.
     *
     * Both are well-formed and neither will do anything, and saying so on the
     * screen beats letting somebody arm it and wonder.
     */
    inert: folders.length === 0 || capabilities.length === 0
  };

  return { ...resolved, sentence: describeBrief(resolved) };
}

/**
 * The whole brief as one sentence a person can check at a glance.
 *
 * This is the actual product idea. A permission list is a thing people tick
 * through; a sentence is a thing they either recognise as what they wanted or
 * do not. "Filing clerk works in Downloads, may move and rename files, asks
 * before anything leaves this Mac, thinks with the balanced tier, and stops
 * after 40 steps."
 */
export function describeBrief(resolved: Omit<ResolvedBrief, "sentence">): string {
  const { brief, folders, capabilities } = resolved;

  const where =
    folders.length === 0
      ? "has no folder to work in"
      : `works in ${list(folders.map((folder) => basename(folder)))}`;

  const what =
    capabilities.length === 0
      ? "has nothing it can do"
      : `may use ${list([...capabilities])}`;

  const sends =
    brief.outbound === "never"
      ? "never sends anything"
      : "asks before anything leaves this Mac";

  const thinks = `thinks with the ${tierWord(brief.engine.tier)}${
    // `== null` catches undefined too. `newBrief` normalises to null, so this is
    // unreachable through it — but a brief arriving from JSON without the key
    // would otherwise render "thinks with the everyday model on undefined".
    brief.engine.pinnedEngineId == null ? "" : ` on ${brief.engine.pinnedEngineId}`
  }`;

  const stops = `stops after ${plural(brief.limits.maxSteps, "step")} or ${plural(
    brief.limits.maxMinutes,
    "minute"
  )}`;

  return `${brief.name} ${where}, ${what}, ${sends}, ${thinks}, and ${stops}.`;
}

/**
 * The tier in the middle of a sentence.
 *
 * Lower-case and read as a phrase, because "thinks with the Deepest tier" reads
 * like a product name and "thinks with the deepest model available" reads like
 * a person describing what they set up.
 */
function tierWord(tier: EngineTier): string {
  switch (tier) {
    case "frontier":
      return "deepest model available";
    case "balanced":
      return "everyday model";
    case "fast":
      return "quickest model";
    case "on-device":
      return "model on this Mac";
  }
}

/**
 * What an agent is allowed to read.
 *
 * Two phrasings, because the same list is read by two different people. The
 * owner reads *about* the agent — "may draw on its folders, your records" — and
 * the agent is addressed *directly* — "you may draw on those folders, the
 * owner's records". One set of labels used for both produced "You may draw on
 * the files in its folders", which is the agent being told about some third
 * party's folders. Caught by reading the real output, not by a test.
 *
 * Named in the product's nouns rather than the code's either way: somebody
 * deciding whether to trust this does not know what "book" means.
 */
export type Voice = "owner" | "agent";

const CONTEXT_LABELS: Readonly<Record<Voice, Readonly<Record<ContextSource, string>>>> = {
  owner: {
    folders: "the files in its folders",
    timeline: "what has changed in those folders",
    book: "your records",
    vault: "your notes",
    glossary: "the names and terms it has learned"
  },
  agent: {
    folders: "the files in those folders",
    timeline: "what has changed in them",
    book: "the owner's records",
    vault: "the owner's notes",
    glossary: "the names and terms Rellane has learned"
  }
};

export function describeReads(reads: readonly ContextSource[], voice: Voice = "owner"): string {
  if (reads.length === 0) {
    return voice === "owner"
      ? "nothing but what you give it directly"
      : "nothing but what the owner gives you directly";
  }
  return list(reads.map((source) => CONTEXT_LABELS[voice][source]));
}

/**
 * Today, in the owner's own timezone.
 *
 * `toISOString()` is UTC, which in IST is yesterday's date for five and a half
 * hours every night — so an agent reasoning about "recent" would be a day out,
 * nightly, and nobody would notice until a follow-up fired on the wrong day.
 */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The folders one worker may actually reach.
 *
 * The intersection of what it asked for and what the owner has granted — never
 * the ceiling itself, which is the union of every folder ever granted and is
 * therefore far wider than any single worker's business.
 *
 * ## Why this is a function and not two copies of a filter
 *
 * It was two copies for about an hour. `agents/service.ts` had this inline and
 * correct, carrying the scar of a bug it had already fixed; the crew then grew
 * its own `narrowReach` doing character-for-character the same thing, and a
 * reviewing model caught it by citing the line number of the original.
 *
 * Two copies of a security filter is the shape where one of them gets fixed. The
 * inline version's own comment records exactly that happening once already — it
 * used to test what a brief *asked for* rather than what was *granted*, so an
 * agent naming three revoked folders got a sandbox bounding nothing. A second
 * copy is a second chance to make that mistake, in a place nobody would think to
 * look after fixing the first.
 */
export function reachableFolders(
  granted: readonly string[],
  wanted: readonly string[]
): readonly string[] {
  return wanted.filter((folder) => granted.includes(folder));
}
