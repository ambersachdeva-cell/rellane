/**
 * The Bench, wired to the engines actually on this Mac.
 *
 * `session.ts` knows how an argument is conducted and nothing about where the
 * engines come from — which is why it can be tested without spending a rupee.
 * This file is the other half: it picks the two seats out of the engine room,
 * refuses honestly when there is only one, and flattens a finished session into
 * something the screen can render.
 *
 * ## Two engines, or nothing
 *
 * The feature is two *different* subscriptions arguing. Running Claude against
 * Claude would produce agreement that looks like corroboration and is not: the
 * same model, the same training, the same blind spots, twice. So a Bench with
 * one engine available is refused with the reason, rather than quietly
 * downgraded into an expensive second opinion from the same source.
 *
 * ## Who sits where
 *
 * The proposer gets the strongest tier available, because it is doing the
 * reasoning. The adversary is deliberately *not* required to match it — a
 * cheaper critic that has to reconstruct the argument from the claim alone
 * still catches real fault (D-018), and pairing two frontier models for every
 * question is how a feature like this becomes too expensive to use.
 */

import type { BenchProgress, BenchResult, EngineRoomStatus } from "@cadrane/contracts";
import type { DatabaseSync } from "node:sqlite";
import { askEngine } from "../agents/ask.js";
import { adjudicate } from "./adjudicate.js";
import { readEngineRoom } from "../subscription-brain/engine-room.js";
import { DEFAULT_LIMITS, describeBench, runBench, spendOf } from "./session.js";

/**
 * The wall clock on a whole argument.
 *
 * The round and token ceilings bound the *argument*; neither bounds the
 * *waiting*. Six calls at the per-call timeout is eighteen minutes, and a
 * session observed on 2026-09-01 ran about ten while the screen said "about a
 * minute". Nobody watches a spinner for ten minutes; they conclude it is broken
 * and quit the app, which is the one outcome worse than a slow answer.
 *
 * Four minutes is roughly two unhurried exchanges. Past that the honest thing is
 * to stop and hand back the turns already paid for.
 */
const SESSION_DEADLINE_MS = 240_000;

/** A ready engine and the best model it offers, or null. */
function pick(room: EngineRoomStatus, exclude?: string) {
  const order = ["frontier", "balanced", "fast", "on-device"] as const;
  for (const engine of room.engines) {
    if (engine.state !== "ready" || engine.id === exclude) {
      continue;
    }
    const best = order
      .map((tier) => engine.models.find((model) => model.tier === tier))
      .find((model) => model !== undefined);
    if (best !== undefined) {
      // "Gemini" + "Gemini Pro" reads as "Gemini Gemini Pro". Where the model
      // already carries the maker's name, the maker is redundant.
      const label = best.label.startsWith(engine.label)
        ? best.label
        : `${engine.label} ${best.label}`;
      return { engineId: engine.id, modelId: best.id, label };
    }
  }
  return null;
}

const failed = (problem: string, question: string): BenchResult => ({
  ok: false,
  problem,
  question,
  outcome: null,
  summary: problem,
  answer: "",
  rounds: 0,
  approxTokens: 0,
  // Nothing was spent, and that is a figure worth stating rather than omitting:
  // somebody whose Bench refused should be able to see it cost them nothing.
  spend: { proposerTokens: 0, adversaryTokens: 0, totalTokens: 0, fraction: 0 },
  adjudication: null,
  stoppedBecause: problem,
  seats: null,
  turns: []
});

/** The legacy one-click entry has no payload approval, so the live IPC must refuse it. */
export function declineUnreviewedBench(question: string): BenchResult {
  return failed("Model review needs a verified subscription adapter and an outgoing review for each message. That connection is not ready here. No model was contacted; use a local workroom for now.", question);
}

/**
 * Legacy executor retained for isolated adapter/session tests, not connected to live IPC.
 * Do not reconnect it without exact per-leg payload approval and a verified restricted adapter.
 *
 * Never throws: a failure here is a screen a person reads, not an exception.
 */
export async function runBenchOnThisMac(
  question: string,
  /** Told as each turn lands, so the meter moves while the argument runs. */
  onTurn?: (progress: BenchProgress) => void,
  /** The open book, when there is one. Null means nothing can be adjudicated. */
  book: DatabaseSync | null = null
): Promise<BenchResult> {
  const room = await readEngineRoom();
  const proposer = pick(room);
  if (proposer === null) {
    return failed(
      "No engine is ready, so there is nobody to argue. Open Engines and sign in to at least one.",
      question
    );
  }
  const adversary = pick(room, proposer.engineId);
  if (adversary === null) {
    return failed(
      `Only ${proposer.label} is ready. The Bench needs two different subscriptions — one model arguing with itself agrees with itself. Open Engines and add a second.`,
      question
    );
  }

  // One deadline for the whole session, shared by both seats, so a slow engine
  // spends the argument's time rather than resetting the clock on every turn.
  const deadline = AbortSignal.timeout(SESSION_DEADLINE_MS);
  const seat = (engineId: string, modelId: string) => (prompt: string) =>
    askEngine({
      engineId,
      modelId,
      system: "You are taking part in a recorded argument. Be decisive and brief.",
      prompt,
      signal: deadline
    });

  const session = await runBench(
    question,
    {
      proposer: { label: proposer.label, ask: seat(proposer.engineId, proposer.modelId) },
      adversary: { label: adversary.label, ask: seat(adversary.engineId, adversary.modelId) }
    },
    DEFAULT_LIMITS,
    (turn, spend) =>
      onTurn?.({
        seat: turn.seat,
        engineLabel: turn.engineLabel,
        approxTokens: turn.approxTokens,
        spend
      })
  );

  return {
    ok: true,
    problem: null,
    question,
    outcome: session.outcome,
    summary: describeBench(session),
    answer: session.answer,
    rounds: session.rounds,
    approxTokens: session.approxTokens,
    spend: spendOf(session.turns),
    // Read after the argument, from the records rather than from either engine.
    // Never throws: an adjudicator that failed must not take an answer with it.
    adjudication:
      book === null
        ? null
        : (() => {
            try {
              return adjudicate(book, session.turns);
            } catch {
              return null;
            }
          })(),
    stoppedBecause: session.stoppedBecause,
    seats: { proposer: proposer.label, adversary: adversary.label },
    turns: session.turns.map((turn) => ({
      seat: turn.seat,
      engineLabel: turn.engineLabel,
      verdict: turn.verdict,
      text: turn.text,
      approxTokens: turn.approxTokens
    }))
  };
}
