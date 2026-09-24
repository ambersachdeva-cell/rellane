/**
 * Reusable owner-edited routines and their versioned persistence contracts.
 *
 * A routine is prompt material for the workstation composer — never an execution
 * authority, autonomous background worker, or ambient permission grant. It
 * captures a proven, human-reviewed procedure so that an operator does not have
 * to retype multi-step briefs from scratch.
 *
 * Provenance to an originating Case and verbatim turn is optional and purely
 * informational: it points back to where an idea first succeeded without
 * coupling the routine's lifecycle to the lifetime of the case.
 */

import { z } from "zod";
import type { WorkstationRoutine } from "./workstation.js";

export const WORKSTATION_ROUTINE_ICONS = [
  "write",
  "research",
  "build",
  "review",
  "data"
] as const;

export const WorkstationRoutineIconSchema = z.enum(WORKSTATION_ROUTINE_ICONS);
export type WorkstationRoutineIcon = z.infer<typeof WorkstationRoutineIconSchema>;

export interface WorkstationSavedRoutine extends WorkstationRoutine {
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly originCaseId: string | null;
  readonly originTurnId: string | null;
}

export interface WorkstationRoutineSaveInput {
  readonly id?: string | undefined;
  readonly expectedRevision?: number | undefined;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly sourceHint: string;
  readonly outputLabel: string;
  readonly icon: WorkstationRoutine["icon"];
  readonly originCaseId?: string | undefined;
  readonly originTurnId?: string | undefined;
}

export const WorkstationRoutineSaveInputSchema = z
  .strictObject({
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().min(1).optional(),
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    prompt: z.string().min(1).max(8000).refine(value => value.trim().length > 0, "Instructions cannot be blank."),
    sourceHint: z.string().trim().min(1).max(500),
    outputLabel: z.string().trim().min(1).max(100),
    icon: WorkstationRoutineIconSchema,
    originCaseId: z.string().trim().min(1).max(64).optional(),
    originTurnId: z.string().uuid().optional()
  })
  .refine(
    (input) => (input.id === undefined) === (input.expectedRevision === undefined),
    {
      message: "id and expectedRevision must be supplied together for routine updates.",
      path: ["expectedRevision"]
    }
  )
  .refine(
    (input) => (input.originCaseId === undefined) === (input.originTurnId === undefined),
    {
      message: "originCaseId and originTurnId must be supplied together.",
      path: ["originTurnId"]
    }
  );

export const WorkstationSavedRoutineSchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  prompt: z.string().min(1).max(8000).refine(value => value.trim().length > 0, "Instructions cannot be blank."),
  icon: WorkstationRoutineIconSchema,
  sourceHint: z.string().trim().min(1).max(500),
  outputLabel: z.string().trim().min(1).max(100),
  revision: z.number().int().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  originCaseId: z.string().trim().min(1).max(64).nullable(),
  originTurnId: z.string().uuid().nullable()
});
