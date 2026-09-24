/**
 * What this flow would have done last month.
 *
 * Arming a folder-triggered flow is a bet on how often a folder moves, and
 * nobody knows that about their own Downloads. The guess is always the same —
 * *"a few times a day"* — and the answer is regularly four hundred, because a
 * sync client touches it, or a browser writes partial files, or a backup runs.
 *
 * Rellane already knows the truth: the timeline has been capturing that folder
 * since it was granted. So rather than asking somebody to guess, this replays
 * their own history and says what would have happened.
 *
 * ## It uses the runtime's own rule
 *
 * `tripsLoopGuard` is imported from contracts and is the same function the
 * runtime calls to switch a looping flow off. A backtest that predicted "this
 * would have been fine" using a different threshold from the one that later
 * pauses the flow is worse than no backtest — it is a promise the product then
 * breaks.
 *
 * ## What it cannot tell you
 *
 * Whether the *answers* would have been right. That needs the models, the money
 * and the files as they were, and none of those are recoverable. This answers
 * the one question history can actually settle: **how often, and would it have
 * run away.** Said plainly, so nobody reads more into it.
 */

import { LOOP_WINDOW_MS, tripsLoopGuard, type AutomationWorkflow } from "@cadrane/contracts";

export interface Backtest {
  readonly workflowId: string;
  /** How far back the history goes. Null when there is none. */
  readonly since: string | null;
  /** Times it would have started over that period. */
  readonly starts: number;
  /** Times it would have switched itself off as a loop. */
  readonly trips: number;
  /** The busiest run of starts inside one guard window. */
  readonly worstBurst: number;
  /** Whether this is worth arming, as far as history can say. */
  readonly ok: boolean;
  readonly said: string;
}

const DAY_MS = 86_400_000;

/**
 * Replays a flow against a folder's capture history.
 *
 * `capturedAtMs` is every moment the watcher recorded a settled change in the
 * trigger folder — which is exactly when the flow would have started, because
 * that is the same signal the trigger fires on.
 */
export function backtest(
  workflow: AutomationWorkflow,
  capturedAtMs: readonly number[],
  now: number = Date.now()
): Backtest {
  const base = { workflowId: workflow.id, trips: 0, worstBurst: 0 };

  if (workflow.trigger.kind !== "folder") {
    return {
      ...base,
      since: null,
      starts: 0,
      ok: true,
      said:
        workflow.trigger.kind === "manual"
          ? "This flow only runs when you run it, so there is nothing to replay."
          : `This flow runs every ${workflow.trigger.everyMinutes} minutes whatever happens, so there is nothing to replay.`
    };
  }

  const moments = [...capturedAtMs].sort((a, b) => a - b);
  const first = moments[0];
  if (first === undefined) {
    return {
      ...base,
      since: null,
      starts: 0,
      ok: true,
      said:
        "There is no history for that folder yet, so this cannot be replayed. Rellane starts recording a folder the moment you grant it."
    };
  }

  // Replayed in order, carrying the starts as the runtime would: a trip pauses
  // the flow, so the starts that follow are the ones that would have happened
  // after somebody turned it back on. Counting them all is the honest reading —
  // it is what the folder did, not what a paused flow did.
  const starts: number[] = [];
  let trips = 0;
  let worstBurst = 0;
  for (const at of moments) {
    // Measured *before* the reset, not after.
    //
    // Counting the burst once the window had been cleared made `worstBurst`
    // reset to 1 on exactly the moments that mattered, so it could never report
    // more than the guard's own threshold — and the sentence built from it said
    // "4 of them within two minutes" for a folder that had moved forty times.
    const burst = starts.filter((start) => start >= at - LOOP_WINDOW_MS).length + 1;
    worstBurst = Math.max(worstBurst, burst);

    if (tripsLoopGuard(starts, at)) {
      trips += 1;
      starts.length = 0;
    }
    starts.push(at);
    // Old starts are dropped as we go. Without this, `starts` grows for the
    // whole history and every iteration re-scans all of it — a year of captures
    // turns a replay into an O(n²) walk on the main process.
    while (starts.length > 0 && (starts[0] ?? 0) < at - LOOP_WINDOW_MS) {
      starts.shift();
    }
  }

  const days = Math.max(1, Math.round((now - first) / DAY_MS));
  const perDay = moments.length / days;
  const folder = workflow.trigger.root.split("/").filter(Boolean).pop() ?? "that folder";

  return {
    workflowId: workflow.id,
    since: new Date(first).toISOString(),
    starts: moments.length,
    trips,
    worstBurst,
    ok: trips === 0,
    said:
      trips > 0
        ? `Over the last ${days} ${days === 1 ? "day" : "days"} this would have started ${moments.length} times — ${worstBurst} of them within two minutes. It would have switched itself off ${trips} ${trips === 1 ? "time" : "times"}. ${folder} changes too often for a flow to watch it; narrow what triggers it before arming this.`
        : `Over the last ${days} ${days === 1 ? "day" : "days"} this would have started ${moments.length} ${moments.length === 1 ? "time" : "times"} — about ${perDay < 1 ? "less than one" : Math.round(perDay)} a day. It would not have run away.`
  };
}
