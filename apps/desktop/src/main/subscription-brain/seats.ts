/**
 * Who can answer, and which of them are worth asking.
 *
 * The Engine Room lists *engines*. This lists **seats** — an account and a model
 * together — because that is the thing that actually answers a question, and
 * because two accounts of one provider are two seats rather than one green
 * light.
 *
 * ## Ordering is a spending decision
 *
 * Seats come back cheapest-capable first, and the default is
 * `gemini-3.8-flash-high`: it is the level that traces a defect through to its
 * consequence, and on this session's evidence it found every real one. Opus is
 * *overflow*, not a better first choice — it costs a different pool, and that
 * pool is the one worth still having when the cheap one runs out.
 *
 * ## Exhaustion belongs to a pool
 *
 * Claude and Gemini bill separately inside one Antigravity account, so a spent
 * quota is `(account, family)` — six budgets across three accounts, not three.
 * `spentPools` is what a caller passes in after a refusal, and the next seat
 * comes from a pool that has not been touched.
 */

import type { EngineRoomStatus } from "@cadrane/contracts";
import { familyOf, poolOf, type ModelFamily, type Seat, type SeatAccount } from "./accounts.js";

/**
 * The model each family is asked first.
 *
 * One per family rather than a long list, because a roster showing thirteen
 * models per account is a roster nobody reads. The others stay reachable by
 * name; these are what "ask the room" means.
 */
export const PREFERRED: Readonly<Record<ModelFamily, string>> = Object.freeze({
  gemini: "gemini-3.8-flash-high",
  claude: "claude-opus-4-6-thinking",
  open: "gpt-oss-120b-medium"
});

/** Order families are offered in. Cheapest pool first; Amber's call (D-091). */
const FAMILY_ORDER: readonly ModelFamily[] = ["gemini", "claude", "open"];

export interface SeatRoster {
  readonly seats: readonly Seat[];
  /** True when every seat's pool is spent — a real state, said plainly. */
  readonly allSpent: boolean;
}

/**
 * Every seat that could answer right now.
 *
 * Takes the room so a signed-out account contributes nothing, and the accounts
 * so one provider can appear more than once. An account whose provider is not
 * ready is simply absent — never listed as a seat that would fail if asked.
 */
export function roster(
  room: EngineRoomStatus,
  accounts: readonly SeatAccount[],
  spentPools: ReadonlySet<string> = new Set()
): SeatRoster {
  const seats: Seat[] = [];

  for (const account of accounts) {
    const engine = room.engines.find(
      (candidate) => candidate.id === account.providerId && candidate.state === "ready"
    );
    if (engine === undefined) {
      continue;
    }
    for (const family of FAMILY_ORDER) {
      const modelId = PREFERRED[family];
      // Only a model this engine actually offers. A seat naming a model the
      // provider does not have is a seat that fails when it is asked, which is
      // worse than one that was never offered.
      if (!engine.models.some((model) => model.id === modelId)) {
        continue;
      }
      seats.push({
        accountId: account.id,
        providerId: account.providerId,
        modelId,
        family,
        // The model first, the account second. Somebody scanning a column of
        // answers is looking for which model said it; which of their own
        // accounts it ran on is the detail that settles a tie.
        label: `${shortModel(modelId)} · ${account.label}`
      });
    }
  }

  const usable = seats.filter((seat) => !spentPools.has(poolOf(seat)));
  return {
    seats: usable,
    // Distinct from "no seats configured": one means the owner has not added an
    // account, the other means they have and every budget is gone. The screen
    // says different things about those and must be able to tell them apart.
    allSpent: seats.length > 0 && usable.length === 0
  };
}

/** The cheapest seat that can answer, or null. */
export function firstSeat(
  room: EngineRoomStatus,
  accounts: readonly SeatAccount[],
  spentPools: ReadonlySet<string> = new Set()
): Seat | null {
  return roster(room, accounts, spentPools).seats[0] ?? null;
}

/**
 * One seat per account, so "ask the room" is several opinions rather than one
 * opinion three times.
 *
 * Asking the same model on three accounts costs three calls to hear the same
 * answer with different quota attached. What is worth paying for is *different
 * models* — so this takes the first usable seat from each account, and only
 * then fills out with other families.
 */
export function roomSeats(
  room: EngineRoomStatus,
  accounts: readonly SeatAccount[],
  spentPools: ReadonlySet<string> = new Set(),
  limit = 4
): readonly Seat[] {
  const all = roster(room, accounts, spentPools).seats;
  const picked: Seat[] = [];
  const seenModel = new Set<string>();

  // A different model each, first.
  for (const seat of all) {
    if (!seenModel.has(seat.modelId)) {
      seenModel.add(seat.modelId);
      picked.push(seat);
    }
    if (picked.length >= limit) {
      return picked;
    }
  }
  // Then repeats on other accounts, which at least spend a different pool.
  for (const seat of all) {
    if (!picked.includes(seat)) {
      picked.push(seat);
    }
    if (picked.length >= limit) {
      break;
    }
  }
  return picked;
}

/**
 * Finds a seat the owner named — "ask Opus", "Gemini, what do you think".
 *
 * Matches the **family word** as well as the full short name, because nobody
 * says "Gemini 3.8" out loud. They say "gemini", and a matcher that needed the
 * version would silently fan out to the whole room instead of asking the one
 * they meant.
 *
 * The full name is tried first, so "ask Gemini 3.8" beats a bare "gemini" when
 * both would match — a person who named the version meant that version.
 */
export function seatNamed(seats: readonly Seat[], said: string): Seat | null {
  const text = said.toLowerCase();
  // Word-bounded, so "opus" does not match inside "opuscule" and a seat is
  // never chosen by accident — the same rule the party matcher follows.
  const mentions = (word: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, "u").test(text);

  for (const seat of seats) {
    if (mentions(shortModel(seat.modelId).toLowerCase())) {
      return seat;
    }
  }
  for (const seat of seats) {
    const family = seat.family === "open" ? "gpt" : seat.family;
    if (mentions(family)) {
      return seat;
    }
  }
  return null;
}

/** `gemini-3.8-flash-high` → `Gemini 3.8`. What a person would say out loud. */
export function shortModel(modelId: string): string {
  const family = familyOf(modelId);
  const version = /(\d+\.\d+)/u.exec(modelId)?.[1];
  if (family === "gemini") {
    return version === undefined ? "Gemini" : `Gemini ${version}`;
  }
  if (family === "claude") {
    return modelId.includes("opus") ? "Opus" : "Sonnet";
  }
  return "GPT-OSS";
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
