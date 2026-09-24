/** Local relevance suggestions prepare a selection; they never dispatch or rewrite evidence. */
import { z } from "zod";

export const WorkstationContextSuggestionInputSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(64),
  handle: z.uuid(),
  question: z.string().trim().min(1).max(2_000),
  sourceTurnIds: z.array(z.uuid()).min(1).max(20)
    .refine(ids => new Set(ids).size === ids.length, "Consider each file once.")
});
export type WorkstationContextSuggestionInput = z.infer<typeof WorkstationContextSuggestionInputSchema>;
export interface WorkstationContextSuggestion {
  readonly sourceTurnIds: readonly string[];
  readonly consideredIds: readonly string[];
  readonly omittedIds: readonly string[];
  readonly excerptedIds: readonly string[];
  readonly modelId: string;
  readonly durationMs: number;
  readonly sourceHash: string;
}
