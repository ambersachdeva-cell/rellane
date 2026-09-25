import { z } from "zod";

export const MAX_MEMORY_TEXT_LENGTH = 50_000;
export const MAX_SOURCE_REF_COUNT = 100;
export const MAX_REASON_LENGTH = 5_000;
export const MAX_ID_LENGTH = 128;
export const MAX_FINDING_ROLE_TAGS = 20;
export const ProjectMemoryRoleIdSchema = z.string().regex(
  /^[a-z][a-z0-9-]{0,63}$/u,
  "Use a lowercase role ID (letters, numbers, hyphens)."
);
export const ProjectMemoryRoleTagsSchema = z.array(
  ProjectMemoryRoleIdSchema
).max(MAX_FINDING_ROLE_TAGS).refine((tags) => new Set(tags).size === tags.length, "Role IDs must be unique.");

export type GovernedProjectMemoryKind = "instruction" | "decision" | "exclusion" | "finding";
export type GovernedProjectMemoryState = "proposed" | "approved" | "rejected" | "forgotten";

export interface GovernedProjectMemorySourceRef {
  readonly caseId: string;
  readonly turnId: string;
  readonly sha256: string;
}

export const GovernedProjectMemorySourceRefSchema = z
  .object({
    caseId: z.string().min(1, "caseId must be a non-empty string"),
    turnId: z.string().min(1, "turnId must be a non-empty string"),
    sha256: z
      .string()
      .length(64, "sha256 must be exactly 64 hexadecimal characters")
      .regex(/^[0-9a-fA-F]{64}$/, "sha256 must be hexadecimal")
  })
  .strict();

export interface GovernedProjectMemoryRevision {
  readonly revision: number;
  readonly state: GovernedProjectMemoryState;
  readonly text: string;
  readonly sourceRefs: readonly GovernedProjectMemorySourceRef[];
  /** Empty or absent in older views means general evidence for any task role. */
  readonly roleTags?: readonly string[];
  readonly createdBy: string;
  readonly createdAt: number;
  readonly approverId: string | null;
  readonly approvedAt: string | null;
  readonly reason: string | null;
}

export interface GovernedProjectMemoryItem {
  readonly id: string;
  readonly projectId: string;
  readonly kind: GovernedProjectMemoryKind;
  readonly headRevision: number;
  readonly activeRevision: number | null;
  readonly active: GovernedProjectMemoryRevision | null;
  readonly candidate: GovernedProjectMemoryRevision | null;
  readonly createdAt: number;
}

export interface GovernedProjectMemoryView {
  readonly projectId: string;
  readonly epoch: number;
  readonly items: readonly GovernedProjectMemoryItem[];
}

export const GovernedProjectMemoryReadSchema = z
  .object({
    action: z.literal("read"),
    projectId: z.string().min(1, "projectId must be a non-empty string").max(MAX_ID_LENGTH)
  })
  .strict();

export const GovernedProjectMemoryProposeSchema = z
  .object({
    action: z.literal("propose"),
    projectId: z.string().min(1, "projectId must be a non-empty string").max(MAX_ID_LENGTH),
    id: z.string().min(1, "id must be a non-empty string").max(MAX_ID_LENGTH).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    kind: z.enum(["instruction", "decision", "exclusion", "finding"]),
    text: z
      .string()
      .min(1, "Memory text cannot be empty.")
      .max(MAX_MEMORY_TEXT_LENGTH, `Memory text exceeds maximum size of ${MAX_MEMORY_TEXT_LENGTH} characters.`)
      .refine((val) => val.trim().length > 0, "Memory text cannot be empty or whitespace only."),
    sourceRefs: z.array(GovernedProjectMemorySourceRefSchema).max(MAX_SOURCE_REF_COUNT).optional(),
    roleTags: ProjectMemoryRoleTagsSchema.optional()
  })
  .strict()
  .refine((value) => value.kind === "finding" || value.roleTags === undefined,
    "Only findings may have role tags.");

export const GovernedProjectMemoryReviewSchema = z
  .object({
    action: z.literal("review"),
    projectId: z.string().min(1, "projectId must be a non-empty string").max(MAX_ID_LENGTH),
    id: z.string().min(1, "id must be a non-empty string").max(MAX_ID_LENGTH),
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
    roleTags: ProjectMemoryRoleTagsSchema.optional(),
    reason: z.string().max(MAX_REASON_LENGTH).optional()
  })
  .strict()
  .refine((value) => value.decision === "approve" || value.roleTags === undefined,
    "Role tags can only confirm an approval.");

export const GovernedProjectMemoryForgetSchema = z
  .object({
    action: z.literal("forget"),
    projectId: z.string().min(1, "projectId must be a non-empty string").max(MAX_ID_LENGTH),
    id: z.string().min(1, "id must be a non-empty string").max(MAX_ID_LENGTH),
    expectedRevision: z.number().int().positive(),
    reason: z.string().max(MAX_REASON_LENGTH).optional()
  })
  .strict();

export const GovernedProjectMemoryCommandSchema = z.discriminatedUnion("action", [
  GovernedProjectMemoryReadSchema,
  GovernedProjectMemoryProposeSchema,
  GovernedProjectMemoryReviewSchema,
  GovernedProjectMemoryForgetSchema
]);

export type GovernedProjectMemoryCommand = z.infer<typeof GovernedProjectMemoryCommandSchema>;

/** A separate owner ruling channel keeps the existing memory read shape stable. */
export const GovernedProjectMemoryConflictCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    projectId: z.string().min(1).max(MAX_ID_LENGTH)
  }).strict(),
  z.object({
    action: z.literal("declare"),
    projectId: z.string().min(1).max(MAX_ID_LENGTH),
    firstMemoryId: z.string().min(1).max(MAX_ID_LENGTH),
    secondMemoryId: z.string().min(1).max(MAX_ID_LENGTH),
    expectedFirstActiveRevision: z.number().int().positive(),
    expectedSecondActiveRevision: z.number().int().positive(),
    expectedConflictRevision: z.number().int().nonnegative(),
    reason: z.string().min(1).max(MAX_REASON_LENGTH).refine((text) => text.trim().length > 0)
  }).strict(),
  z.object({
    action: z.literal("resolve"),
    projectId: z.string().min(1).max(MAX_ID_LENGTH),
    conflictId: z.string().min(1).max(MAX_ID_LENGTH),
    expectedRevision: z.number().int().positive(),
    expectedFirstActiveRevision: z.number().int().positive().nullable(),
    expectedSecondActiveRevision: z.number().int().positive().nullable(),
    resolution: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("winner"), winnerId: z.string().min(1).max(MAX_ID_LENGTH) }).strict(),
      z.object({ kind: z.literal("both_retired") }).strict()
    ]),
    reason: z.string().min(1).max(MAX_REASON_LENGTH).refine((text) => text.trim().length > 0)
  }).strict()
]);

export type GovernedProjectMemoryConflictCommand = z.infer<typeof GovernedProjectMemoryConflictCommandSchema>;

export interface GovernedProjectMemoryConflictRevision {
  readonly revision: number;
  readonly state: "declared" | "resolved";
  readonly firstActiveRevision: number | null;
  readonly secondActiveRevision: number | null;
  readonly resolution: "first_wins" | "second_wins" | "both_retired" | null;
  readonly actorId: string;
  readonly reason: string;
  readonly createdAt: number;
}

export interface GovernedProjectMemoryConflict {
  readonly id: string;
  readonly projectId: string;
  readonly firstMemoryId: string;
  readonly secondMemoryId: string;
  readonly headRevision: number;
  readonly createdAt: number;
  readonly history: readonly GovernedProjectMemoryConflictRevision[];
}

export interface GovernedProjectConstraint {
  readonly id: string;
  readonly revision: number;
  readonly kind: "instruction" | "decision" | "exclusion";
  readonly text: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface GovernedProjectConflictExclusion {
  readonly memoryId: string;
  readonly conflictId: string;
  readonly conflictRevision: number;
  readonly reason: string;
  readonly resolution: "first_wins" | "second_wins" | "both_retired";
  readonly winnerId: string | null;
}

export interface GovernedProjectMemoryConflictView {
  readonly projectId: string;
  readonly epoch: number;
  readonly conflicts: readonly GovernedProjectMemoryConflict[];
  readonly authority:
    | { readonly status: "ready";
        readonly included: readonly GovernedProjectConstraint[];
        readonly excluded: readonly {
          readonly constraint: GovernedProjectConstraint;
          readonly conflicts: readonly GovernedProjectConflictExclusion[];
        }[] }
    | { readonly status: "blocked"; readonly reason: string };
}
