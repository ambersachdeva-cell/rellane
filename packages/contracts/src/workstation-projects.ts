/**
 * Workstation Projects and immutable shared briefs — public contracts and strict validation schemas.
 *
 * Governed by D-115 (horizontal workstation as front door) and D-116 (explicit outbound review).
 * Projects represent long-lived context, goals, and reviewed briefs, separate from Cases
 * which represent bounded task rooms that finish with verdicts.
 *
 * All schemas are strict and reject extra keys.
 */

import { z } from "zod";

export interface WorkstationProject {
  readonly id: string;
  readonly title: string;
  readonly brief: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkstationProjectLink {
  readonly caseId: string;
  readonly projectId: string;
}

export interface WorkstationProjectSaveInput {
  readonly id?: string | undefined;
  readonly expectedRevision?: number | undefined;
  readonly title: string;
  readonly brief: string;
}

export interface WorkstationProjectAssignInput {
  readonly caseId: string;
  readonly projectId: string | null;
}

export interface WorkstationProjectCaptureInput {
  readonly caseId: string;
  readonly expectedRevision: number;
}

export const WorkstationProjectIdSchema = z.string().uuid();
export const WorkstationCaseIdSchema = z.string().trim().min(1).max(64);
export const WorkstationProjectTitleSchema = z.string().trim().min(1).max(100);
export const WorkstationProjectBriefSchema = z.string().min(1).max(8000).refine(value => value.trim().length > 0, "The shared brief cannot be blank.");

export const WorkstationProjectSaveInputSchema = z
  .strictObject({
    id: WorkstationProjectIdSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    title: WorkstationProjectTitleSchema,
    brief: WorkstationProjectBriefSchema
  })
  .refine(
    (input) =>
      (input.id === undefined && input.expectedRevision === undefined) ||
      (input.id !== undefined && input.expectedRevision !== undefined),
    {
      message: "Update requires id and expectedRevision together; create requires neither."
    }
  );

export const WorkstationProjectSaveSchema = WorkstationProjectSaveInputSchema;

export const WorkstationProjectAssignInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema,
  projectId: WorkstationProjectIdSchema.nullable()
});

export const WorkstationProjectAssignSchema = WorkstationProjectAssignInputSchema;
export const WorkstationProjectAssignmentSchema = WorkstationProjectAssignInputSchema;

export const WorkstationProjectCaptureInputSchema = z.strictObject({
  caseId: WorkstationCaseIdSchema,
  expectedRevision: z.number().int().positive()
});

export const WorkstationProjectCaptureSchema = WorkstationProjectCaptureInputSchema;
