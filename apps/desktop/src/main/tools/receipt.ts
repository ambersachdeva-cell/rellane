/**
 * Plans, receipts, and undo.
 *
 * The rule the whole autonomy model rests on: an action that cannot produce a
 * receipt does not run. A receipt is not a log line — it records enough to
 * reverse the action, so "undo" is a real operation rather than a promise.
 *
 * Undo is time-boxed on purpose. Holding reversal state forever means holding
 * copies of the user's files forever, which is its own problem.
 */

import { randomUUID } from "node:crypto";
import type { Decision, RiskClass } from "./types.js";

export const UNDO_WINDOW_MS = 10 * 60_000;

/** One intended action, before it happens. */
export interface PlannedStep {
  readonly id: string;
  readonly tool: string;
  readonly risk: RiskClass;
  /** Plain sentence for the approval sheet. */
  readonly summary: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly decision: Decision;
  readonly reason: string;
}

export interface Plan {
  readonly id: string;
  readonly skill: string;
  readonly intent: string;
  readonly steps: readonly PlannedStep[];
  readonly createdAt: string;
}

/**
 * How to reverse a completed step. `none` means it changed nothing.
 *
 * `restore-preimage` is the one that matters: an APFS clone taken before the
 * step ran. It is preferred over every other kind because it is free to take
 * and restores the whole target at once, including files the step deleted.
 */
export type Reversal =
  | { readonly kind: "none" }
  | {
      readonly kind: "restore-preimage";
      readonly source: string;
      readonly preimage: string;
      readonly method: "apfs-clone" | "copy";
    }
  | { readonly kind: "restore-path"; readonly from: string; readonly to: string }
  | { readonly kind: "delete-created"; readonly path: string }
  | { readonly kind: "restore-bytes"; readonly path: string; readonly backup: string };

export interface StepReceipt {
  readonly stepId: string;
  readonly tool: string;
  readonly summary: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome: "done" | "refused" | "failed" | "drafted";
  /** Present only when the step failed or was refused. */
  readonly error?: string | undefined;
  readonly reversal: Reversal;
}

export interface Receipt {
  readonly id: string;
  readonly planId: string;
  readonly skill: string;
  readonly intent: string;
  readonly steps: readonly StepReceipt[];
  readonly finishedAt: string;
  /** When undo stops being offered. Null when there is nothing to undo. */
  readonly undoableUntil: string | null;
}

export function newPlan(input: {
  skill: string;
  intent: string;
  steps: readonly Omit<PlannedStep, "id">[];
  now: number;
}): Plan {
  return {
    id: randomUUID(),
    skill: input.skill,
    intent: input.intent,
    createdAt: new Date(input.now).toISOString(),
    steps: input.steps.map((step) => ({ ...step, id: randomUUID() }))
  };
}

export function isReversible(receipt: Receipt): boolean {
  return receipt.steps.some((step) => step.reversal.kind !== "none");
}

export function undoableUntil(steps: readonly StepReceipt[], now: number): string | null {
  return steps.some((step) => step.reversal.kind !== "none")
    ? new Date(now + UNDO_WINDOW_MS).toISOString()
    : null;
}

export function canUndo(receipt: Receipt, now: number): boolean {
  if (receipt.undoableUntil === null) {
    return false;
  }
  return now <= Date.parse(receipt.undoableUntil);
}

/**
 * What the user is told after a run.
 *
 * Counts what happened rather than asserting success, because a plan where
 * three steps ran and two were refused is not "done" and should not read as it.
 */
export function summarise(receipt: Receipt): string {
  const tally = { done: 0, refused: 0, failed: 0, drafted: 0 };
  for (const step of receipt.steps) {
    tally[step.outcome] += 1;
  }

  const parts: string[] = [];
  if (tally.done > 0) parts.push(`${tally.done} done`);
  if (tally.drafted > 0) parts.push(`${tally.drafted} prepared for you`);
  if (tally.refused > 0) parts.push(`${tally.refused} not allowed`);
  if (tally.failed > 0) parts.push(`${tally.failed} failed`);

  return parts.length === 0 ? "Nothing to do." : parts.join(" · ");
}
