/**
 * Every agent on this Mac: the three that ship, and the ones the owner wrote.
 *
 * Until now `builtInAgents()` was called directly from four places, which was
 * fine while the answer was a constant and wrong the moment it stopped being
 * one. Four call sites resolving an agent independently is four chances for the
 * screen to show a brief and the runtime to act on a different one — and the
 * whole trust model here is that the sentence you read is the brief that runs.
 *
 * So there is one resolver, and everything goes through it.
 *
 * ## A stored brief is untrusted
 *
 * Settings are a JSON file on disk. It is the owner's own file, but it is still
 * a file — editable by hand, restorable from an old backup, and syncable to a
 * machine where the folders it names do not exist. So a stored brief is put back
 * through `newBrief()` rather than used as written: the same clamping, the same
 * ceilings, the same defaults that a brief built in code gets.
 *
 * That matters for one field in particular. A hand-edited `maxSteps: 100000`
 * must not become a hundred thousand model calls because it arrived as data
 * instead of as an argument.
 */

import type { AgentBrief } from "@cadrane/contracts";
import { newBrief } from "./brief.js";
import { builtInAgents } from "./defaults.js";

/** A brief as it is stored. Deliberately the loose shape, not `AgentBrief`. */
export interface StoredBrief {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly instructions?: string;
  readonly folders?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly tier?: string;
  readonly maxSteps?: number;
  readonly maxMinutes?: number;
  readonly outbound?: string;
}

/** Ids reserved by the agents that ship, so a custom one cannot shadow them. */
export const SHIPPED_IDS: readonly string[] = ["filing-clerk", "what-changed", "drafts"];

/**
 * Rebuilds one stored brief through the same constructor code uses.
 *
 * Every field is re-validated rather than trusted. A value that does not make
 * sense falls back to the default instead of failing the whole roster — one
 * corrupt brief must not hide the other nine.
 */
export function rehydrate(stored: StoredBrief): AgentBrief | null {
  // Guards the shape itself, not just its fields: this is reachable from a JSON
  // file, so an array holding `null` or a string must not throw on property
  // access and take the whole roster with it.
  if (typeof stored !== "object" || stored === null) {
    return null;
  }
  if (typeof stored.id !== "string" || stored.id.length === 0) {
    return null;
  }
  if (typeof stored.name !== "string" || stored.name.trim().length === 0) {
    return null;
  }
  const tier =
    stored.tier === "frontier" || stored.tier === "balanced" || stored.tier === "fast" || stored.tier === "on-device"
      ? stored.tier
      : "fast";
  const outbound = stored.outbound === "ask" ? "ask" : "never";

  return newBrief({
    id: stored.id,
    name: stored.name.trim().slice(0, 60),
    // `?? ""` catches only null and undefined. A hand-edited file with a number
    // here reached `.trim()` and threw — during startup, from a file the owner
    // can edit, taking the window with it.
    purpose:
      (typeof stored.purpose === "string" ? stored.purpose : "").trim().slice(0, 200) ||
      "No purpose written yet",
    ...(typeof stored.instructions === "string"
      ? { instructions: stored.instructions.slice(0, 4_000) }
      : {}),
    folders: Array.isArray(stored.folders)
      ? stored.folders.filter((f): f is string => typeof f === "string")
      : [],
    capabilities: Array.isArray(stored.capabilities)
      ? stored.capabilities.filter((c): c is string => typeof c === "string")
      : [],
    tier,
    // Clamped here, not trusted. A hand-edited settings file saying 100000 must
    // not buy a hundred thousand model calls, and `newBrief` clamps against the
    // ceiling but only for values it can read as numbers.
    maxSteps: sane(stored.maxSteps, 12, 1, 60),
    maxMinutes: sane(stored.maxMinutes, 3, 1, 60),
    outbound
  });
}

function sane(value: unknown, fallback: number, low: number, high: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.round(value)))
    : fallback;
}

/**
 * Every agent, shipped first.
 *
 * A stored brief carrying a shipped id is dropped rather than merged: allowing
 * it would let a hand-edited file redefine "Filing clerk" as something with a
 * different folder and a different outbound policy, under a name the owner
 * trusts because they recognise it.
 */
export function allAgents(
  grantedFolders: readonly string[],
  stored: readonly StoredBrief[]
): readonly AgentBrief[] {
  const shipped = builtInAgents(grantedFolders);
  // Seeded from the declared reserved ids as well as what was actually built.
  // Deriving it only from `builtInAgents` meant that if a shipped agent were
  // ever omitted — conditionally, or by a future edit — its id would stop being
  // reserved and a stored brief could claim the name the owner trusts.
  const seen = new Set([...SHIPPED_IDS, ...shipped.map((brief) => brief.id)]);

  const custom: AgentBrief[] = [];
  for (const entry of stored) {
    if (typeof entry !== "object" || entry === null || seen.has(entry.id)) {
      continue;
    }
    const brief = rehydrate(entry);
    if (brief !== null) {
      seen.add(brief.id);
      custom.push(brief);
    }
  }
  return [...shipped, ...custom];
}

/** Finds one agent by id, through the same resolution everything else uses. */
export function findAgent(
  grantedFolders: readonly string[],
  stored: readonly StoredBrief[],
  id: string
): AgentBrief | undefined {
  return allAgents(grantedFolders, stored).find((brief) => brief.id === id);
}
