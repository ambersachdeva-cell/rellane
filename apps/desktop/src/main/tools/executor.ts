/**
 * Runs a plan and produces a receipt.
 *
 * The order here is the whole safety model, so it is worth stating plainly:
 * decide → snapshot → act → record. Nothing is touched before the autonomy gate
 * has allowed it, and nothing is changed before a pre-image exists to undo it.
 *
 * A step that cannot be snapshotted does not run under automatic autonomy. That
 * is a deliberate refusal rather than a degraded mode: offering undo and then
 * not having it is worse than never offering it.
 */

import { takePreimage, restore, discard, SnapshotUnavailable, type Snapshot } from "./preimage.js";
import { toolByName, type ToolContext } from "./registry.js";
import {
  undoableUntil,
  type Plan,
  type PlannedStep,
  type Receipt,
  type Reversal,
  type StepReceipt
} from "./receipt.js";
import { decide, type SkillPolicy } from "./types.js";
import { diagnostics } from "../foundations/diagnostics.js";

export interface ExecuteOptions {
  readonly plan: Plan;
  readonly policy: SkillPolicy;
  readonly context: ToolContext;
  /**
   * Asked whenever the gate says "ask". Returning false records the step as
   * refused; the run continues, because one declined step is not a failed run.
   */
  approve(step: PlannedStep): Promise<boolean>;
  /** Paths to snapshot before the run. Usually the folders the skill will touch. */
  readonly protect?: readonly string[] | undefined;
  readonly now?: () => number;
  readonly signal?: AbortSignal | undefined;
}

export interface ExecutionResult {
  readonly receipt: Receipt;
  /** Held so undo can use them; released by `releaseUndo`. */
  readonly snapshots: readonly Snapshot[];
}

export async function execute(options: ExecuteOptions): Promise<ExecutionResult> {
  const now = options.now ?? (() => Date.now());
  const snapshots: Snapshot[] = [];
  const steps: StepReceipt[] = [];

  // One pre-image per protected root, taken before anything runs. Cheaper and
  // more complete than snapshotting per step: it also captures files a step
  // deletes or moves away.
  const willChange = options.plan.steps.some(
    (step) => step.decision !== "refuse" && step.risk !== "read"
  );
  if (willChange) {
    for (const path of options.protect ?? []) {
      try {
        snapshots.push(await takePreimage(path));
      } catch (error) {
        await releaseUndo(snapshots);
        if (error instanceof SnapshotUnavailable) {
          diagnostics.warn("executor", "refused: no undo available", {
            path,
            reason: error.reason
          });
          // Say so, then run read-only rather than pretending undo exists.
          return {
            receipt: refusedRun(options.plan, now(), error.message),
            snapshots: []
          };
        }
        throw error;
      }
    }
  }

  for (const step of options.plan.steps) {
    if (options.signal?.aborted === true) {
      steps.push(record(step, now(), now(), "refused", "Cancelled.", { kind: "none" }));
      continue;
    }

    const tool = toolByName(step.tool);
    if (tool === null) {
      steps.push(
        record(step, now(), now(), "failed", `No tool called ${step.tool}.`, { kind: "none" })
      );
      continue;
    }

    const gate = decide({ tool: tool.definition, policy: options.policy });
    if (gate.decision === "refuse") {
      steps.push(record(step, now(), now(), "refused", gate.reason, { kind: "none" }));
      continue;
    }
    if (gate.decision === "draft") {
      steps.push(record(step, now(), now(), "drafted", gate.reason, { kind: "none" }));
      continue;
    }
    if (gate.decision === "ask") {
      const allowed = await options.approve(step);
      if (!allowed) {
        steps.push(record(step, now(), now(), "refused", "You declined this step.", { kind: "none" }));
        continue;
      }
    }

    const startedAt = now();
    try {
      await tool.handler(step.args, options.context);
      steps.push(
        record(step, startedAt, now(), "done", undefined, reversalFor(tool.definition.risk, snapshots))
      );
    } catch (error) {
      steps.push(
        record(
          step,
          startedAt,
          now(),
          "failed",
          error instanceof Error ? error.message : "Unknown failure.",
          { kind: "none" }
        )
      );
    }
  }

  const finishedAt = now();
  return {
    receipt: {
      id: options.plan.id,
      planId: options.plan.id,
      skill: options.plan.skill,
      intent: options.plan.intent,
      steps,
      finishedAt: new Date(finishedAt).toISOString(),
      undoableUntil: undoableUntil(steps, finishedAt)
    },
    snapshots
  };
}

/**
 * A step that changed something is reversible through the run's pre-image.
 * Reads change nothing and carry no reversal, so undo is offered only when
 * there is genuinely something to undo.
 */
function reversalFor(risk: string, snapshots: readonly Snapshot[]): Reversal {
  const first = snapshots[0];
  if (risk === "read" || first === undefined) {
    return { kind: "none" };
  }
  return {
    kind: "restore-preimage",
    source: first.source,
    preimage: first.preimage,
    method: first.method
  };
}

function record(
  step: PlannedStep,
  startedAt: number,
  finishedAt: number,
  outcome: StepReceipt["outcome"],
  error: string | undefined,
  reversal: Reversal
): StepReceipt {
  return {
    stepId: step.id,
    tool: step.tool,
    summary: step.summary,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    outcome,
    ...(error === undefined ? {} : { error }),
    reversal
  };
}

function refusedRun(plan: Plan, at: number, reason: string): Receipt {
  return {
    id: plan.id,
    planId: plan.id,
    skill: plan.skill,
    intent: plan.intent,
    steps: plan.steps.map((step) => record(step, at, at, "refused", reason, { kind: "none" })),
    finishedAt: new Date(at).toISOString(),
    undoableUntil: null
  };
}

/** Puts everything back. Restores in reverse so nested paths unwind correctly. */
export async function undo(snapshots: readonly Snapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    await restore(snapshot);
  }
}

/** Releases pre-images once the undo window has closed. */
export async function releaseUndo(snapshots: readonly Snapshot[]): Promise<void> {
  await Promise.all(snapshots.map((snapshot) => discard(snapshot).catch(() => undefined)));
}
