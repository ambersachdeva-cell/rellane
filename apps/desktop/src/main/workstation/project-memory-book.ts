/**
 * Canonical minimum project memory repository primitive backed by Book SQLite.
 *
 * Governed by W02 specification: immutable approved memory revisions, explicit
 * proposal and review lifecycle, atomic disclosure epoch increment, exact turn
 * source-hash attribution, and transactional revision checks.
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AcceptedConstraint, AcceptedFinding, ApprovedConstraintKind } from "./context.js";
import { MAX_FINDING_COUNT } from "./context.js";
import { redactContextSnapshotsForMemory } from "./context-snapshot-store.js";
import {
  compileProjectMemoryConflictSelection,
  redactProjectMemoryConflictReasonsForMemory,
  type ProjectMemoryConflictExclusion
} from "./project-memory-conflict-store.js";

export type ProjectMemoryKind = "instruction" | "decision" | "exclusion" | "finding";
export type ProjectMemoryState = "proposed" | "approved" | "rejected" | "forgotten";

export interface ProjectMemorySourceRef {
  readonly caseId: string;
  readonly turnId: string;
  readonly sha256: string;
}

export const ProjectMemorySourceRefSchema = z.object({
  caseId: z.string().min(1, "caseId must be a non-empty string"),
  turnId: z.string().min(1, "turnId must be a non-empty string"),
  sha256: z
    .string()
    .length(64, "sha256 must be exactly 64 hexadecimal characters")
    .regex(/^[0-9a-fA-F]{64}$/, "sha256 must be hexadecimal")
});

export const MAX_MEMORY_TEXT_LENGTH = 50_000;
export const MAX_SOURCE_REF_COUNT = 100;
export const MAX_REASON_LENGTH = 5_000;
export const MAX_ACTOR_ID_LENGTH = 256;
export const MAX_ID_LENGTH = 128;
export const MAX_FINDING_ROLE_TAGS = 20;
const RoleTagsSchema = z.array(
  z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u, "Use a lowercase role ID (letters, numbers, hyphens).")
).max(MAX_FINDING_ROLE_TAGS).refine((tags) => new Set(tags).size === tags.length, "Role IDs must be unique.");

function readRoleTags(json: string): readonly string[] {
  return RoleTagsSchema.parse(JSON.parse(json)) as readonly string[];
}

export interface ProposeProjectMemoryInput {
  readonly projectId: string;
  readonly id?: string;
  readonly expectedRevision?: number;
  readonly kind: ProjectMemoryKind;
  readonly text: string;
  readonly sourceRefs?: readonly ProjectMemorySourceRef[];
  /** Explicit owner-assigned finding audience; empty means general evidence. */
  readonly roleTags?: readonly string[];
  readonly actorId: string;
}

export interface ReviewProjectMemoryInput {
  readonly projectId: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly decision: "approve" | "reject";
  readonly actorId: string;
  /** Must match a tagged finding proposal exactly before it can be approved. */
  readonly roleTags?: readonly string[];
  readonly reason?: string;
}

export interface ForgetProjectMemoryInput {
  readonly projectId: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly reason?: string;
}

export interface ProjectMemoryMutationResult {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly state: ProjectMemoryState;
  readonly epoch: number;
  readonly activeRevision: number | null;
}

export interface ProjectMemoryRevisionView {
  readonly revision: number;
  readonly state: ProjectMemoryState;
  readonly text: string;
  readonly sourceRefs: readonly ProjectMemorySourceRef[];
  readonly roleTags: readonly string[];
  readonly createdBy: string;
  readonly createdAt: number;
  readonly approverId: string | null;
  readonly approvedAt: string | null;
  readonly reason: string | null;
}

export interface ProjectMemoryItem {
  readonly id: string;
  readonly projectId: string;
  readonly kind: ProjectMemoryKind;
  readonly headRevision: number;
  readonly activeRevision: number | null;
  readonly active: ProjectMemoryRevisionView | null;
  readonly candidate: ProjectMemoryRevisionView | null;
  readonly createdAt: number;
}

const ProposeSchema = z.object({
  projectId: z.string().min(1).max(MAX_ID_LENGTH),
  id: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  kind: z.enum(["instruction", "decision", "exclusion", "finding"]),
  text: z
    .string()
    .min(1, "Memory text cannot be empty.")
    .max(MAX_MEMORY_TEXT_LENGTH, `Memory text exceeds maximum size of ${MAX_MEMORY_TEXT_LENGTH} characters.`)
    .refine((val) => val.trim().length > 0, "Memory text cannot be empty or whitespace only."),
  sourceRefs: z.array(ProjectMemorySourceRefSchema).max(MAX_SOURCE_REF_COUNT).optional(),
  roleTags: RoleTagsSchema.optional(),
  actorId: z.string().min(1).max(MAX_ACTOR_ID_LENGTH)
}).refine((input) => input.kind === "finding" || input.roleTags === undefined,
  "Only findings may have role tags.");

const ReviewSchema = z.object({
  projectId: z.string().min(1).max(MAX_ID_LENGTH),
  id: z.string().min(1).max(MAX_ID_LENGTH),
  expectedRevision: z.number().int().positive(),
  decision: z.enum(["approve", "reject"]),
  actorId: z.string().min(1).max(MAX_ACTOR_ID_LENGTH),
  roleTags: RoleTagsSchema.optional(),
  reason: z.string().max(MAX_REASON_LENGTH).optional()
}).refine((input) => input.decision === "approve" || input.roleTags === undefined,
  "Role tags can only confirm an approval.");

const ForgetSchema = z.object({
  projectId: z.string().min(1).max(MAX_ID_LENGTH),
  id: z.string().min(1).max(MAX_ID_LENGTH),
  expectedRevision: z.number().int().positive(),
  actorId: z.string().min(1).max(MAX_ACTOR_ID_LENGTH),
  reason: z.string().max(MAX_REASON_LENGTH).optional()
});

function ensureProjectExists(db: DatabaseSync, projectId: string): void {
  const row = db
    .prepare(`SELECT id FROM workstation_project WHERE id = ?`)
    .get(projectId);
  if (!row) {
    throw new Error(`Project '${projectId}' does not exist.`);
  }
}

function validateSourceRefs(
  db: DatabaseSync,
  projectId: string,
  sourceRefs: readonly ProjectMemorySourceRef[]
): void {
  for (const ref of sourceRefs) {
    const linkRow = db
      .prepare(
        `SELECT 1 FROM workstation_project_link WHERE case_id = ? AND project_id = ?`
      )
      .get(ref.caseId, projectId);
    if (!linkRow) {
      throw new Error(
        `Source ref case '${ref.caseId}' is not linked to project '${projectId}'.`
      );
    }

    const turnRow = db
      .prepare(`SELECT body FROM case_turn WHERE id = ? AND case_id = ?`)
      .get(ref.turnId, ref.caseId) as { body: string } | undefined;
    if (!turnRow) {
      throw new Error(
        `Source ref turn '${ref.turnId}' does not belong to case '${ref.caseId}'.`
      );
    }

    const hash = createHash("sha256").update(turnRow.body, "utf8").digest("hex");
    if (hash.toLowerCase() !== ref.sha256.toLowerCase()) {
      throw new Error(
        `Source ref turn '${ref.turnId}' sha256 mismatch: expected ${ref.sha256.toLowerCase()}, computed ${hash.toLowerCase()}.`
      );
    }
  }
}

export function projectMemoryEpoch(db: DatabaseSync, projectId: string): number {
  if (!projectId || typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new TypeError("projectId must be a non-empty string");
  }
  const row = db
    .prepare(`SELECT memory_epoch AS memoryEpoch FROM workstation_project WHERE id = ?`)
    .get(projectId) as { memoryEpoch: number | bigint } | undefined;
  if (!row) {
    throw new Error(`Project '${projectId}' does not exist.`);
  }
  return Number(row.memoryEpoch);
}

export function proposeProjectMemory(
  db: DatabaseSync,
  input: ProposeProjectMemoryInput,
  at: number = Date.now()
): ProjectMemoryMutationResult {
  const parsed = ProposeSchema.parse(input);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureProjectExists(db, parsed.projectId);

    const entryId = parsed.id ?? randomUUID();

    const existingEntry = db
      .prepare(
        `SELECT id, project_id AS projectId, kind, head_revision AS headRevision, active_revision AS activeRevision
         FROM workstation_project_memory_entry WHERE id = ?`
      )
      .get(entryId) as {
        id: string;
        projectId: string;
        kind: ProjectMemoryKind;
        headRevision: number;
        activeRevision: number | null;
      } | undefined;

    let targetRevision: number;
    let activeRevision: number | null;
    let sourceRefs: readonly ProjectMemorySourceRef[];
    let roleTags: readonly string[];

    if (!existingEntry) {
      if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== 0) {
        throw new Error(
          `Stale memory revision: expected revision ${parsed.expectedRevision}, but entry does not exist.`
        );
      }

      sourceRefs = parsed.sourceRefs ?? [];
      roleTags = [...(parsed.roleTags ?? [])].sort();
      validateSourceRefs(db, parsed.projectId, sourceRefs);

      targetRevision = 1;
      activeRevision = null;

      db.prepare(
        `INSERT INTO workstation_project_memory_entry (id, project_id, kind, head_revision, active_revision, created_at)
         VALUES (?, ?, ?, 1, NULL, ?)`
      ).run(entryId, parsed.projectId, parsed.kind, at);

      db.prepare(
        `INSERT INTO workstation_project_memory_revision (entry_id, revision, state, body, source_refs_json, role_tags_json, created_by, created_at, approver_id, approved_at, reason)
         VALUES (?, 1, 'proposed', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      ).run(entryId, parsed.text, JSON.stringify(sourceRefs), JSON.stringify(roleTags), parsed.actorId, at);
    } else {
      if (existingEntry.projectId !== parsed.projectId) {
        throw new Error(
          `Cannot propose memory for entry '${entryId}': project mismatch ('${existingEntry.projectId}' vs '${parsed.projectId}').`
        );
      }

      if (existingEntry.kind !== parsed.kind) {
        throw new Error(
          `Cannot change kind of existing memory entry '${entryId}' from '${existingEntry.kind}' to '${parsed.kind}'.`
        );
      }

      const headRevRow = db
        .prepare(
          `SELECT state, source_refs_json AS sourceRefsJson, role_tags_json AS roleTagsJson FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = ?`
        )
        .get(entryId, existingEntry.headRevision) as {
          state: ProjectMemoryState;
          sourceRefsJson: string;
          roleTagsJson: string;
        } | undefined;

      if (headRevRow?.state === "forgotten") {
        throw new Error(
          `Memory entry '${entryId}' was forgotten and cannot be updated. Create a new entry.`
        );
      }

      if (parsed.expectedRevision === undefined) {
        throw new Error(
          `expectedRevision is required when updating existing memory entry '${entryId}'.`
        );
      }

      if (parsed.expectedRevision !== existingEntry.headRevision) {
        throw new Error(
          `Stale memory revision: expected revision ${parsed.expectedRevision}, but current head revision is ${existingEntry.headRevision}.`
        );
      }

      sourceRefs =
        parsed.sourceRefs !== undefined
          ? parsed.sourceRefs
          : headRevRow
            ? (JSON.parse(headRevRow.sourceRefsJson) as readonly ProjectMemorySourceRef[])
            : [];
      const approvedRoleTags = existingEntry.activeRevision === null ? [] : (() => {
        const row = db.prepare(`SELECT role_tags_json AS roleTagsJson
          FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = ? AND state = 'approved'`)
          .get(entryId, existingEntry.activeRevision) as { roleTagsJson: string } | undefined;
        if (!row) throw new Error(`Approved memory '${entryId}' is unavailable.`);
        return readRoleTags(row.roleTagsJson);
      })();
      roleTags = parsed.roleTags !== undefined ? [...parsed.roleTags].sort() : approvedRoleTags;

      validateSourceRefs(db, parsed.projectId, sourceRefs);

      targetRevision = existingEntry.headRevision + 1;
      activeRevision = existingEntry.activeRevision;

      db.prepare(
        `INSERT INTO workstation_project_memory_revision (entry_id, revision, state, body, source_refs_json, role_tags_json, created_by, created_at, approver_id, approved_at, reason)
         VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      ).run(entryId, targetRevision, parsed.text, JSON.stringify(sourceRefs), JSON.stringify(roleTags), parsed.actorId, at);

      db.prepare(
        `UPDATE workstation_project_memory_entry SET head_revision = ? WHERE id = ?`
      ).run(targetRevision, entryId);
    }

    db.prepare(
      `UPDATE workstation_project SET memory_epoch = memory_epoch + 1 WHERE id = ?`
    ).run(parsed.projectId);

    const epochRow = db
      .prepare(`SELECT memory_epoch AS memoryEpoch FROM workstation_project WHERE id = ?`)
      .get(parsed.projectId) as { memoryEpoch: number | bigint };

    db.exec("COMMIT");

    return {
      id: entryId,
      projectId: parsed.projectId,
      revision: targetRevision,
      state: "proposed",
      epoch: Number(epochRow.memoryEpoch),
      activeRevision
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function reviewProjectMemory(
  db: DatabaseSync,
  input: ReviewProjectMemoryInput,
  at: number = Date.now()
): ProjectMemoryMutationResult {
  const parsed = ReviewSchema.parse(input);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureProjectExists(db, parsed.projectId);

    const entry = db
      .prepare(
        `SELECT id, project_id AS projectId, kind, head_revision AS headRevision, active_revision AS activeRevision
         FROM workstation_project_memory_entry WHERE id = ?`
      )
      .get(parsed.id) as {
        id: string;
        projectId: string;
        kind: ProjectMemoryKind;
        headRevision: number;
        activeRevision: number | null;
      } | undefined;

    if (!entry) {
      throw new Error(`Memory entry '${parsed.id}' does not exist.`);
    }

    if (entry.projectId !== parsed.projectId) {
      throw new Error(
        `Cannot review memory entry '${parsed.id}': project mismatch ('${entry.projectId}' vs '${parsed.projectId}').`
      );
    }

    if (parsed.expectedRevision !== entry.headRevision) {
      throw new Error(
        `Stale memory revision: expected revision ${parsed.expectedRevision}, but current head revision is ${entry.headRevision}.`
      );
    }

    const headRev = db
      .prepare(
        `SELECT revision, state, body, source_refs_json AS sourceRefsJson, role_tags_json AS roleTagsJson, created_by AS createdBy, created_at AS createdAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = ?`
      )
      .get(parsed.id, entry.headRevision) as {
        revision: number;
        state: ProjectMemoryState;
        body: string;
        sourceRefsJson: string;
        roleTagsJson: string;
        createdBy: string;
        createdAt: number;
      } | undefined;

    if (!headRev) {
      throw new Error(
        `Memory entry '${parsed.id}' has no revision record for head revision ${entry.headRevision}.`
      );
    }

    if (headRev.state === "forgotten") {
      throw new Error(
        `Memory entry '${parsed.id}' was forgotten and cannot be reviewed.`
      );
    }

    if (headRev.state !== "proposed") {
      throw new Error(
        `Cannot review memory entry '${parsed.id}': head revision ${entry.headRevision} is '${headRev.state}', expected 'proposed'.`
      );
    }

    const proposedTags = readRoleTags(headRev.roleTagsJson);
    if (entry.kind !== "finding" && (proposedTags.length > 0 || parsed.roleTags !== undefined))
      throw new Error("Only findings may have role tags.");
    if (parsed.decision === "approve" && entry.kind === "finding") {
      if (proposedTags.length > 0 && parsed.roleTags === undefined)
        throw new Error("Confirm the finding's exact role tags before approval.");
      if (parsed.roleTags !== undefined &&
          JSON.stringify([...parsed.roleTags].sort()) !== JSON.stringify(proposedTags))
        throw new Error("Reviewed finding role tags do not match the proposed revision.");
    }

    // A proposed citation may have changed or been unlinked while it waited
    // for approval. Recheck it before promoting the exact head to authority.
    if (parsed.decision === "approve") {
      const refs = z.array(ProjectMemorySourceRefSchema).max(MAX_SOURCE_REF_COUNT)
        .parse(JSON.parse(headRev.sourceRefsJson));
      validateSourceRefs(db, parsed.projectId, refs);
    }

    const nextRevision = entry.headRevision + 1;
    const isApproved = parsed.decision === "approve";
    const newState: ProjectMemoryState = isApproved ? "approved" : "rejected";
    const approverId = isApproved ? parsed.actorId : null;
    const approvedAt = isApproved ? at : null;

    db.prepare(
      `INSERT INTO workstation_project_memory_revision (entry_id, revision, state, body, source_refs_json, role_tags_json, created_by, created_at, approver_id, approved_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      parsed.id,
      nextRevision,
      newState,
      headRev.body,
      headRev.sourceRefsJson,
      headRev.roleTagsJson,
      parsed.actorId,
      at,
      approverId,
      approvedAt,
      parsed.reason ?? null
    );

    let nextActiveRevision = entry.activeRevision;
    if (parsed.decision === "approve") {
      nextActiveRevision = nextRevision;
      db.prepare(
        `UPDATE workstation_project_memory_entry SET head_revision = ?, active_revision = ? WHERE id = ?`
      ).run(nextRevision, nextRevision, parsed.id);
    } else {
      db.prepare(
        `UPDATE workstation_project_memory_entry SET head_revision = ? WHERE id = ?`
      ).run(nextRevision, parsed.id);
    }

    db.prepare(
      `UPDATE workstation_project SET memory_epoch = memory_epoch + 1 WHERE id = ?`
    ).run(parsed.projectId);

    const epochRow = db
      .prepare(`SELECT memory_epoch AS memoryEpoch FROM workstation_project WHERE id = ?`)
      .get(parsed.projectId) as { memoryEpoch: number | bigint };

    db.exec("COMMIT");

    return {
      id: parsed.id,
      projectId: parsed.projectId,
      revision: nextRevision,
      state: newState,
      epoch: Number(epochRow.memoryEpoch),
      activeRevision: nextActiveRevision
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function forgetProjectMemory(
  db: DatabaseSync,
  input: ForgetProjectMemoryInput,
  at: number = Date.now()
): ProjectMemoryMutationResult {
  const parsed = ForgetSchema.parse(input);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureProjectExists(db, parsed.projectId);

    const entry = db
      .prepare(
        `SELECT id, project_id AS projectId, kind, head_revision AS headRevision, active_revision AS activeRevision
         FROM workstation_project_memory_entry WHERE id = ?`
      )
      .get(parsed.id) as {
        id: string;
        projectId: string;
        kind: ProjectMemoryKind;
        headRevision: number;
        activeRevision: number | null;
      } | undefined;

    if (!entry) {
      throw new Error(`Memory entry '${parsed.id}' does not exist.`);
    }

    if (entry.projectId !== parsed.projectId) {
      throw new Error(
        `Cannot forget memory entry '${parsed.id}': project mismatch ('${entry.projectId}' vs '${parsed.projectId}').`
      );
    }

    if (parsed.expectedRevision !== entry.headRevision) {
      throw new Error(
        `Stale memory revision: expected revision ${parsed.expectedRevision}, but current head revision is ${entry.headRevision}.`
      );
    }

    const headRev = db
      .prepare(
        `SELECT state FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = ?`
      )
      .get(parsed.id, entry.headRevision) as { state: ProjectMemoryState } | undefined;

    if (headRev?.state === "forgotten") {
      throw new Error(`Memory entry '${parsed.id}' is already forgotten.`);
    }

    const nextRevision = entry.headRevision + 1;

    db.prepare(
      `INSERT INTO workstation_project_memory_revision (entry_id, revision, state, body, source_refs_json, role_tags_json, created_by, created_at, approver_id, approved_at, reason)
       VALUES (?, ?, 'forgotten', '', '[]', '[]', ?, ?, NULL, NULL, ?)`
    ).run(parsed.id, nextRevision, parsed.actorId, at, parsed.reason ?? null);

    db.prepare(
      `UPDATE workstation_project_memory_revision
       SET body = '', source_refs_json = '[]', role_tags_json = '[]', reason = CASE WHEN revision = ? THEN reason ELSE NULL END
       WHERE entry_id = ?`
    ).run(nextRevision, parsed.id);

    // One Book transaction: a forgotten instruction cannot survive in a
    // previously reviewed packet if the memory row itself is erased.
    redactContextSnapshotsForMemory(db, parsed.projectId, parsed.id, at);
    redactProjectMemoryConflictReasonsForMemory(db, parsed.projectId, parsed.id);

    db.prepare(
      `UPDATE workstation_project_memory_entry SET head_revision = ?, active_revision = NULL WHERE id = ?`
    ).run(nextRevision, parsed.id);

    db.prepare(
      `UPDATE workstation_project SET memory_epoch = memory_epoch + 1 WHERE id = ?`
    ).run(parsed.projectId);

    const epochRow = db
      .prepare(`SELECT memory_epoch AS memoryEpoch FROM workstation_project WHERE id = ?`)
      .get(parsed.projectId) as { memoryEpoch: number | bigint };

    db.exec("COMMIT");

    return {
      id: parsed.id,
      projectId: parsed.projectId,
      revision: nextRevision,
      state: "forgotten",
      epoch: Number(epochRow.memoryEpoch),
      activeRevision: null
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listProjectMemory(
  db: DatabaseSync,
  projectId: string
): readonly ProjectMemoryItem[] {
  if (!projectId || typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new TypeError("projectId must be a non-empty string");
  }

  ensureProjectExists(db, projectId);

  const entryRows = db
    .prepare(
      `SELECT
         e.id AS id,
         e.project_id AS projectId,
         e.kind AS kind,
         e.head_revision AS headRevision,
         e.active_revision AS activeRevision,
         e.created_at AS createdAt
       FROM workstation_project_memory_entry e
       WHERE e.project_id = ?
       ORDER BY e.created_at ASC, e.id ASC`
    )
    .all(projectId) as unknown as readonly {
      id: string;
      projectId: string;
      kind: ProjectMemoryKind;
      headRevision: number;
      activeRevision: number | null;
      createdAt: number;
    }[];

  const items: ProjectMemoryItem[] = [];

  for (const entry of entryRows) {
    const headRevRow = db
      .prepare(
        `SELECT
           revision, state, body, source_refs_json AS sourceRefsJson, role_tags_json AS roleTagsJson,
           created_by AS createdBy, created_at AS createdAt,
           approver_id AS approverId, approved_at AS approvedAt, reason
         FROM workstation_project_memory_revision
         WHERE entry_id = ? AND revision = ?`
      )
      .get(entry.id, entry.headRevision) as {
        revision: number;
        state: ProjectMemoryState;
        body: string;
        sourceRefsJson: string;
        roleTagsJson: string;
        createdBy: string;
        createdAt: number;
        approverId: string | null;
        approvedAt: number | null;
        reason: string | null;
      } | undefined;

    if (!headRevRow || headRevRow.state === "forgotten") {
      continue;
    }

    let activeView: ProjectMemoryRevisionView | null = null;
    if (entry.activeRevision !== null) {
      const activeRevRow = db
        .prepare(
          `SELECT
             revision, state, body, source_refs_json AS sourceRefsJson, role_tags_json AS roleTagsJson,
             created_by AS createdBy, created_at AS createdAt,
             approver_id AS approverId, approved_at AS approvedAt, reason
           FROM workstation_project_memory_revision
           WHERE entry_id = ? AND revision = ?`
        )
        .get(entry.id, entry.activeRevision) as {
          revision: number;
          state: ProjectMemoryState;
          body: string;
          sourceRefsJson: string;
          roleTagsJson: string;
          createdBy: string;
          createdAt: number;
          approverId: string | null;
          approvedAt: number | null;
          reason: string | null;
        } | undefined;

      if (activeRevRow && activeRevRow.state === "approved") {
        activeView = {
          revision: activeRevRow.revision,
          state: activeRevRow.state,
          text: activeRevRow.body,
          sourceRefs: JSON.parse(activeRevRow.sourceRefsJson) as readonly ProjectMemorySourceRef[],
          roleTags: readRoleTags(activeRevRow.roleTagsJson),
          createdBy: activeRevRow.createdBy,
          createdAt: activeRevRow.createdAt,
          approverId: activeRevRow.approverId,
          approvedAt: activeRevRow.approvedAt !== null ? new Date(activeRevRow.approvedAt).toISOString() : null,
          reason: activeRevRow.reason
        };
      }
    }

    let candidateView: ProjectMemoryRevisionView | null = null;
    if (headRevRow.state === "proposed") {
      candidateView = {
        revision: headRevRow.revision,
        state: headRevRow.state,
        text: headRevRow.body,
        sourceRefs: JSON.parse(headRevRow.sourceRefsJson) as readonly ProjectMemorySourceRef[],
        roleTags: readRoleTags(headRevRow.roleTagsJson),
        createdBy: headRevRow.createdBy,
        createdAt: headRevRow.createdAt,
        approverId: headRevRow.approverId,
        approvedAt: headRevRow.approvedAt !== null ? new Date(headRevRow.approvedAt).toISOString() : null,
        reason: headRevRow.reason
      };
    }

    if (!activeView && !candidateView) {
      continue;
    }

    items.push({
      id: entry.id,
      projectId: entry.projectId,
      kind: entry.kind,
      headRevision: entry.headRevision,
      activeRevision: entry.activeRevision,
      active: activeView,
      candidate: candidateView,
      createdAt: entry.createdAt
    });
  }

  return items;
}

export interface ApprovedConstraintSelection {
  readonly included: readonly AcceptedConstraint[];
  readonly excluded: readonly {
    readonly constraint: AcceptedConstraint;
    readonly conflicts: readonly ProjectMemoryConflictExclusion[];
  }[];
}

/** Exact authority decision with reasons for every resolved exclusion. */
export function explainApprovedProjectConstraints(
  db: DatabaseSync,
  projectId: string
): ApprovedConstraintSelection {
  if (!projectId || typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new TypeError("projectId must be a non-empty string");
  }

  ensureProjectExists(db, projectId);
  const epochBefore = projectMemoryEpoch(db, projectId);
  const exclusions = compileProjectMemoryConflictSelection(db, projectId);

  const rows = db
    .prepare(
      `SELECT
         e.id AS id,
         r.revision AS revision,
         e.kind AS kind,
         r.body AS text,
         r.approver_id AS approverId,
         r.approved_at AS approvedAt
       FROM workstation_project_memory_entry e
       JOIN workstation_project_memory_revision r
         ON r.entry_id = e.id AND r.revision = e.active_revision
       WHERE e.project_id = ?
         AND e.active_revision IS NOT NULL
         AND e.kind IN ('instruction', 'decision', 'exclusion')
         AND r.state = 'approved'
       ORDER BY e.created_at ASC, e.id ASC`
    )
    .all(projectId) as unknown as readonly {
      id: string;
      revision: number;
      kind: string;
      text: string;
      approverId: string | null;
      approvedAt: number | null;
    }[];

  const included: AcceptedConstraint[] = [];
  const excluded: {
    constraint: AcceptedConstraint;
    conflicts: readonly ProjectMemoryConflictExclusion[];
  }[] = [];
  for (const row of rows) {
    if (row.approverId === null || row.approvedAt === null)
      throw new Error(`Approved memory '${row.id}' has no approval receipt.`);
    const constraint: AcceptedConstraint = {
      id: row.id,
      revision: row.revision,
      kind: row.kind as ApprovedConstraintKind,
      text: row.text,
      approvedBy: row.approverId,
      approvedAt: new Date(row.approvedAt).toISOString()
    };
    const reasons = exclusions.get(row.id);
    if (reasons) excluded.push({ constraint, conflicts: reasons });
    else included.push(constraint);
  }
  if (projectMemoryEpoch(db, projectId) !== epochBefore) {
    throw new Error("Project memory changed while compiling constraints. Review again.");
  }
  return { included, excluded };
}

/** The production Prepare path consumes only conflict-cleared authority. */
export function approvedProjectConstraints(
  db: DatabaseSync,
  projectId: string
): readonly AcceptedConstraint[] {
  return explainApprovedProjectConstraints(db, projectId).included;
}

/** Approved findings are attributed evidence candidates, never authority. */
export function approvedProjectFindings(
  db: DatabaseSync, projectId: string
): readonly AcceptedFinding[] {
  if (!projectId || typeof projectId !== "string" || projectId.trim().length === 0)
    throw new TypeError("projectId must be a non-empty string");
  ensureProjectExists(db, projectId);
  const epochBefore = projectMemoryEpoch(db, projectId);
  // A contradictory authority pair stops the whole reviewed packet before any
  // model sees its findings, even when every finding itself is source-backed.
  compileProjectMemoryConflictSelection(db, projectId);
  const rows = db.prepare(`SELECT e.id, r.revision, r.body AS text,
    r.source_refs_json AS sourceRefsJson, r.role_tags_json AS roleTagsJson, r.approver_id AS approvedBy,
    r.approved_at AS approvedAt
    FROM workstation_project_memory_entry e
    JOIN workstation_project_memory_revision r
      ON r.entry_id = e.id AND r.revision = e.active_revision
    WHERE e.project_id = ? AND e.kind = 'finding' AND r.state = 'approved'
    ORDER BY e.created_at ASC, e.id ASC LIMIT ?`)
    .all(projectId, MAX_FINDING_COUNT + 1) as unknown as readonly {
      id: string; revision: number; text: string; sourceRefsJson: string; roleTagsJson: string;
      approvedBy: string | null; approvedAt: number | null;
    }[];
  if (rows.length > MAX_FINDING_COUNT)
    throw new Error(`Project has more than ${MAX_FINDING_COUNT} approved findings. Review the memory set.`);
  const findings = rows.map((row): AcceptedFinding => {
    if (row.approvedBy === null || row.approvedAt === null)
      throw new Error(`Approved finding '${row.id}' has no approval receipt.`);
    const sourceRefs = z.array(ProjectMemorySourceRefSchema).max(MAX_SOURCE_REF_COUNT)
      .parse(JSON.parse(row.sourceRefsJson)) as readonly ProjectMemorySourceRef[];
    const roleTags = readRoleTags(row.roleTagsJson);
    let provenance: AcceptedFinding["provenance"] = "unattributed";
    if (sourceRefs.length > 0) {
      try {
        validateSourceRefs(db, projectId, sourceRefs);
        provenance = "verified";
      } catch {
        provenance = "stale";
      }
    }
    return {
      id: row.id, revision: row.revision, text: row.text,
      approvedBy: row.approvedBy, approvedAt: new Date(row.approvedAt).toISOString(),
      sourceRefs, roleTags, provenance
    };
  });
  if (projectMemoryEpoch(db, projectId) !== epochBefore)
    throw new Error("Project memory changed while reading findings. Review again.");
  return findings;
}
