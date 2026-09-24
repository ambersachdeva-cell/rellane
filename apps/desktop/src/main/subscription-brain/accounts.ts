/**
 * Several subscriptions, several seats.
 *
 * ## The observation this is built on
 *
 * Amber has three Google AI Pro accounts. Set up as three isolated profiles they
 * run at once without colliding, and each one fronts Gemini *and* Claude *and*
 * an open-weight model — on **separate quotas**. So one person's subscriptions
 * are worth several times what any single client extracts from them, and the
 * product whose pitch is *"plug in the subscription you already pay for"* should
 * be the thing that notices.
 *
 * ## A seat is an account plus a model, not a provider
 *
 * That is the whole design. The Engine Room used to have one row per provider,
 * which cannot express *"Gemini on the work account is ready, Gemini on the
 * personal one is signed out"* — and cannot express two accounts answering at
 * once at all.
 *
 * ## Rellane never holds a credential
 *
 * A vendor CLI reads its token out of `$HOME`. So an account here is **a
 * directory path and a label** — nothing else. Rellane sets `HOME` and starts
 * the vendor's own binary; the token stays in that directory, unread, unmoved,
 * never logged and never in a diagnostics bundle. D-022 and D-038 are unchanged
 * by this, and it is what keeps the whole idea on the right side of D-073.
 *
 * ## Quota is per family, not per account
 *
 * Claude and Gemini bill separately inside one Antigravity account. Three
 * accounts are therefore **six independent budgets**, and a spent pool is
 * `(account, family)`. Marking a whole account spent when its Gemini ran out
 * would throw away an untouched Opus quota sitting right beside it.
 */

import { isAbsolute, resolve } from "node:path";
import type { BrainProviderId } from "./types.js";

/** One subscription the owner has, as a place on disk. */
export interface SeatAccount {
  readonly id: string;
  /** Which CLI this account signs into. */
  readonly providerId: BrainProviderId;
  /** What the owner calls it — "work", "personal". Theirs, not ours. */
  readonly label: string;
  /**
   * The `HOME` this CLI runs with. Chosen in a picker, never typed by anything
   * but a person — the same rule a granted folder follows (D-036).
   */
  readonly profileDir: string;
}

/**
 * Which family a model bills against.
 *
 * The one distinction that matters for exhaustion. Antigravity fronts three
 * families on one subscription and they do not share a pool, so a router that
 * treated "the account is spent" as one fact would strand two thirds of what
 * was paid for.
 */
export type ModelFamily = "gemini" | "claude" | "open";

export function familyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) {
    return "claude";
  }
  if (id.startsWith("gemini")) {
    return "gemini";
  }
  return "open";
}

/** A seat: one account, one model. What actually answers a question. */
export interface Seat {
  readonly accountId: string;
  readonly providerId: BrainProviderId;
  readonly modelId: string;
  readonly family: ModelFamily;
  /** What a person reads — "Gemini 3.8 Flash · work". */
  readonly label: string;
}

/** The key a spent quota is remembered under. Never the whole account. */
export function poolOf(seat: Pick<Seat, "accountId" | "family">): string {
  return `${seat.accountId}:${seat.family}`;
}

export interface AccountProblem {
  readonly ok: false;
  readonly problem: string;
}

/**
 * Checks an account before it is stored.
 *
 * A profile directory is a path Rellane will hand to a subprocess as its `HOME`,
 * so it is checked the way a granted folder is: absolute, and refused if it is
 * the owner's real home. Pointing a seat at `~` would mean every account was the
 * same account, silently, and the owner would see three green lights for one
 * subscription.
 */
export function checkAccount(
  account: Pick<SeatAccount, "label" | "profileDir">,
  home: string
): { readonly ok: true } | AccountProblem {
  const label = account.label.trim();
  if (label.length === 0) {
    return { ok: false, problem: "Give the account a name you will recognise — “work”, “personal”." };
  }
  if (!isAbsolute(account.profileDir)) {
    return { ok: false, problem: "An account needs a full path to its own folder." };
  }
  if (resolve(account.profileDir) === resolve(home)) {
    return {
      ok: false,
      problem:
        "That is your own home folder, which is where the first account already signs in. A second account needs a folder of its own, or both seats would be the same subscription wearing two names."
    };
  }
  return { ok: true };
}

/**
 * Reads the accounts out of stored settings, dropping anything malformed.
 *
 * Same discipline as contacts and connectors: a half-understood entry is
 * dropped rather than repaired. This list decides which subscription gets
 * spent, and a guess there is somebody's quota.
 */
export function accountsFrom(raw: unknown): readonly SeatAccount[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry): SeatAccount[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    const id = candidate["id"];
    const providerId = candidate["providerId"];
    const label = candidate["label"];
    const profileDir = candidate["profileDir"];
    if (
      typeof id !== "string" ||
      typeof providerId !== "string" ||
      typeof label !== "string" ||
      typeof profileDir !== "string" ||
      !isAbsolute(profileDir)
    ) {
      return [];
    }
    return [
      {
        id,
        providerId: providerId as BrainProviderId,
        label: label.slice(0, 40),
        profileDir
      }
    ];
  });
}
