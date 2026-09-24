/**
 * A brief you can hand to somebody.
 *
 * The plan's done-when is *"a brief is a thing you own"*, and ownership that
 * ends at the app boundary is not ownership — it is a tenancy. An agent you
 * wrote should leave with you: readable, diffable, and openable without this
 * product.
 *
 * ## What a shared brief must not carry
 *
 * This is the whole design problem, and it has exactly one rule: **a brief
 * carries what an agent is for, never what it may touch.**
 *
 * - **No folder paths.** `/Users/amber/Clients` is both a permission and a
 *   disclosure. A brief that arrived carrying folders would, at best, name
 *   somebody's customers in a file they meant to share; at worst it would look
 *   like a grant, and an import that quietly restored one would let a file
 *   decide what an app may read. Folders are granted in Finder, by a person,
 *   and there is no other route (D-036).
 * - **No credentials, and nothing engine-specific that implies one.** A pinned
 *   engine is kept as a *preference*, because it tells the receiver what the
 *   author found worked; it grants nothing, since the Engine Room decides what
 *   is actually available on the Mac it lands on.
 * - **No capability that the receiving Mac has not itself allowed.** The
 *   capability list travels, because it is part of what the agent is. It is not
 *   filtered *here* — reading a brief grants nothing, because reading one does
 *   not save it. The clamp happens where every brief is resolved, so an imported
 *   brief and a typed one meet exactly the same ceiling and neither can widen
 *   it.
 *
 * The result is a document that describes an intention and confers no power.
 * Importing one is never a security decision, which is the property that makes
 * it safe to accept a brief from a stranger and read it afterwards.
 */

import type { AgentBrief, ContextSource, EngineTier, OutboundPolicy } from "@cadrane/contracts";

export const BRIEF_FILE_VERSION = 1;
export const BRIEF_KIND = "cadrane-brief";

export interface SharedBrief {
  readonly kind: typeof BRIEF_KIND;
  readonly version: number;
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
  /** What it draws on. Never *which* folders — only that it reads folders. */
  readonly reads: readonly ContextSource[];
  readonly capabilities: readonly string[];
  readonly tier: EngineTier;
  /** A preference, not a grant. The receiving Engine Room still decides. */
  readonly prefersEngineId: string | null;
  readonly limits: { readonly maxSteps: number; readonly maxMinutes: number };
  readonly outbound: OutboundPolicy;
  /**
   * Said in the file, because the file outlives any explanation given beside it.
   */
  readonly note: string;
}

const NOTE =
  "Written by Rellane. This describes what an agent is for. It carries no folders, no keys and no permissions — whoever opens it grants their own, on their own Mac.";

/** Everything about an agent except what it may touch. */
export function toShared(brief: AgentBrief): SharedBrief {
  return {
    kind: BRIEF_KIND,
    version: BRIEF_FILE_VERSION,
    name: brief.name,
    purpose: brief.purpose,
    instructions: brief.instructions,
    reads: [...brief.workspace.reads],
    capabilities: [...brief.capabilities],
    tier: brief.engine.tier,
    prefersEngineId: brief.engine.pinnedEngineId,
    limits: { ...brief.limits },
    outbound: brief.outbound,
    note: NOTE
  };
}

/** The bytes written to disk: pretty-printed, so a diff is line by line. */
export function toFile(brief: AgentBrief): string {
  return `${JSON.stringify(toShared(brief), null, 2)}\n`;
}

export interface ImportedBrief {
  readonly ok: boolean;
  readonly brief: SharedBrief | null;
  /** What happened, in the owner's words. Always set. */
  readonly said: string;
}

const READS: readonly ContextSource[] = ["folders", "timeline", "book", "vault", "glossary"];
const TIERS: readonly EngineTier[] = ["frontier", "balanced", "fast", "on-device"];
const OUTBOUND: readonly OutboundPolicy[] = ["never", "ask"];

function strings(value: unknown, allowed: readonly string[]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && allowed.includes(entry))
    : [];
}

/**
 * Reads a brief somebody sent.
 *
 * Every unknown field is **dropped, never carried**, and every known one is
 * clamped to a value this build understands. A brief is a document from
 * somewhere else, and the only safe way to read one is to rebuild it out of
 * parts you recognise rather than to trust the shape that arrived.
 *
 * Never throws: a file that is not a brief is an answer, not an exception.
 */
export function fromFile(text: string): ImportedBrief {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, brief: null, said: "That file is not readable as a brief." };
  }
  if (typeof raw !== "object" || raw === null || raw["kind"] !== BRIEF_KIND) {
    return { ok: false, brief: null, said: "That is not a Rellane brief." };
  }
  if (raw["version"] !== BRIEF_FILE_VERSION) {
    // Refused rather than half-understood. A brief that half-loaded would run
    // with limits or permissions nobody chose, which is worse than one that did
    // not load at all.
    return {
      ok: false,
      brief: null,
      said: "That brief was written by a different version of Rellane and cannot be read safely."
    };
  }

  const text_ = (key: string, max: number): string =>
    typeof raw[key] === "string" ? (raw[key] as string).trim().slice(0, max) : "";
  const name = text_("name", 80);
  const purpose = text_("purpose", 400);
  if (name.length === 0 || purpose.length === 0) {
    return { ok: false, brief: null, said: "That brief has no name or no purpose." };
  }

  const limits = (raw["limits"] ?? {}) as Record<string, unknown>;
  const whole = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "number" && Number.isInteger(value) ? value : fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  return {
    ok: true,
    brief: {
      kind: BRIEF_KIND,
      version: BRIEF_FILE_VERSION,
      name,
      purpose,
      instructions: text_("instructions", 4_000),
      reads: strings(raw["reads"], READS) as ContextSource[],
      // Not filtered against a ceiling here: what this Mac allows is decided
      // where every other brief is resolved, so an imported one and a
      // hand-written one are clamped by exactly the same code.
      capabilities: strings(raw["capabilities"], [
        "list_folder",
        "read_text",
        "move_file",
        "write_text"
      ]),
      tier: TIERS.includes(raw["tier"] as EngineTier) ? (raw["tier"] as EngineTier) : "balanced",
      prefersEngineId:
        typeof raw["prefersEngineId"] === "string" ? raw["prefersEngineId"].slice(0, 80) : null,
      limits: {
        maxSteps: whole(limits["maxSteps"], 20, 1, 200),
        maxMinutes: whole(limits["maxMinutes"], 5, 1, 120)
      },
      // Anything but the exact string "ask" means never. An unreadable value
      // must not become permission to prepare a message.
      outbound: OUTBOUND.includes(raw["outbound"] as OutboundPolicy)
        ? (raw["outbound"] as OutboundPolicy)
        : "never",
      note: NOTE
    },
    said: `${name} — read it before you save it. It brought no folders and no permissions; you grant those yourself.`
  };
}
