/**
 * Owner-declared conflicts keep exact approved memory versions from silently
 * becoming authority together. No text matching or inferred contradiction is
 * performed here: an owner names a pair, then names a winner or retires both.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const Id = z.string().min(1).max(128);
const Reason = z.string().min(1).max(5_000).refine((text) => text.trim().length > 0);
const ActiveRevision = z.number().int().positive();
const MaybeActiveRevision = ActiveRevision.nullable();
export const MAX_PROJECT_MEMORY_CONFLICTS = 100;
export const MAX_PROJECT_MEMORY_CONFLICT_REVISIONS = 100;

const DeclareSchema = z.object({
  projectId: Id,
  firstMemoryId: Id,
  secondMemoryId: Id,
  expectedFirstActiveRevision: ActiveRevision,
  expectedSecondActiveRevision: ActiveRevision,
  expectedConflictRevision: z.number().int().nonnegative(),
  actorId: z.string().min(1).max(256),
  reason: Reason
});

const ResolveSchema = z.object({
  projectId: Id,
  conflictId: Id,
  expectedRevision: ActiveRevision,
  expectedFirstActiveRevision: MaybeActiveRevision,
  expectedSecondActiveRevision: MaybeActiveRevision,
  resolution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("winner"), winnerId: Id }),
    z.object({ kind: z.literal("both_retired") })
  ]),
  actorId: z.string().min(1).max(256),
  reason: Reason
});

export type DeclareProjectMemoryConflictInput = z.infer<typeof DeclareSchema>;
export type ResolveProjectMemoryConflictInput = z.infer<typeof ResolveSchema>;
export type ProjectMemoryConflictResolution = "first_wins" | "second_wins" | "both_retired";

export interface ProjectMemoryConflictRevision {
  readonly revision: number;
  readonly state: "declared" | "resolved";
  readonly firstActiveRevision: number | null;
  readonly secondActiveRevision: number | null;
  readonly resolution: ProjectMemoryConflictResolution | null;
  readonly actorId: string;
  readonly reason: string;
  readonly createdAt: number;
}

export interface ProjectMemoryConflict {
  readonly id: string;
  readonly projectId: string;
  readonly firstMemoryId: string;
  readonly secondMemoryId: string;
  readonly headRevision: number;
  readonly createdAt: number;
  readonly history: readonly ProjectMemoryConflictRevision[];
}

export interface ProjectMemoryConflictExclusion {
  readonly memoryId: string;
  readonly conflictId: string;
  readonly conflictRevision: number;
  readonly reason: string;
  readonly resolution: ProjectMemoryConflictResolution;
  readonly winnerId: string | null;
}

interface MemoryEndpoint {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly activeRevision: number | null;
  readonly state: string | null;
}

function endpoint(db: DatabaseSync, id: string, projectId: string): MemoryEndpoint {
  const row = db.prepare(`SELECT e.id, e.project_id AS projectId, e.kind,
    e.active_revision AS activeRevision, r.state
    FROM workstation_project_memory_entry e
    LEFT JOIN workstation_project_memory_revision r
      ON r.entry_id = e.id AND r.revision = e.active_revision
    WHERE e.id = ?`).get(id) as MemoryEndpoint | undefined;
  if (!row || row.projectId !== projectId) {
    throw new Error(`Memory '${id}' is not in project '${projectId}'.`);
  }
  if (!["instruction", "decision", "exclusion"].includes(row.kind)) {
    throw new Error(`Memory '${id}' is not an approved constraint kind.`);
  }
  if (row.activeRevision !== null && row.state !== "approved") {
    throw new Error(`Memory '${id}' has an invalid active approval.`);
  }
  return row;
}

function assertExpected(actual: number | null, expected: number | null, id: string): void {
  if (actual !== expected) {
    throw new Error(`Memory '${id}' active revision changed. Review the conflict again.`);
  }
}

function bumpEpoch(db: DatabaseSync, projectId: string): void {
  const result = db.prepare(
    "UPDATE workstation_project SET memory_epoch = memory_epoch + 1 WHERE id = ?"
  ).run(projectId);
  if (result.changes !== 1) throw new Error(`Project '${projectId}' does not exist.`);
}

function revisionRows(db: DatabaseSync, id: string): readonly ProjectMemoryConflictRevision[] {
  const rows = db.prepare(`SELECT revision, state,
    first_active_revision AS firstActiveRevision,
    second_active_revision AS secondActiveRevision,
    resolution, actor_id AS actorId, reason, created_at AS createdAt
    FROM workstation_project_memory_conflict_revision
    WHERE conflict_id = ? ORDER BY revision ASC LIMIT ?`)
    .all(id, MAX_PROJECT_MEMORY_CONFLICT_REVISIONS + 1) as unknown as readonly ProjectMemoryConflictRevision[];
  if (rows.length > MAX_PROJECT_MEMORY_CONFLICT_REVISIONS) {
    throw new Error(`Conflict '${id}' exceeds the revision limit. Review cannot continue.`);
  }
  return rows;
}

export function listProjectMemoryConflicts(
  db: DatabaseSync, projectId: string
): readonly ProjectMemoryConflict[] {
  const parsedProjectId = Id.parse(projectId);
  const project = db.prepare("SELECT 1 FROM workstation_project WHERE id = ?").get(parsedProjectId);
  if (!project) throw new Error(`Project '${parsedProjectId}' does not exist.`);
  const rows = db.prepare(`SELECT id, project_id AS projectId,
    first_memory_id AS firstMemoryId, second_memory_id AS secondMemoryId,
    head_revision AS headRevision, created_at AS createdAt
    FROM workstation_project_memory_conflict WHERE project_id = ?
    ORDER BY created_at ASC, id ASC LIMIT ?`).all(parsedProjectId, MAX_PROJECT_MEMORY_CONFLICTS + 1) as unknown as readonly
    Omit<ProjectMemoryConflict, "history">[];
  if (rows.length > MAX_PROJECT_MEMORY_CONFLICTS) {
    throw new Error(`Project '${parsedProjectId}' exceeds the conflict limit. Review cannot continue.`);
  }
  return rows.map((row) => {
    const history = revisionRows(db, row.id);
    if (history.length !== row.headRevision ||
        history.some((revision, index) => revision.revision !== index + 1)) {
      throw new Error(`Conflict '${row.id}' has an incomplete revision history.`);
    }
    return { ...row, history };
  });
}

export function declareProjectMemoryConflict(
  db: DatabaseSync, input: DeclareProjectMemoryConflictInput, at = Date.now()
): ProjectMemoryConflict {
  const parsed = DeclareSchema.parse(input);
  if (parsed.firstMemoryId === parsed.secondMemoryId) {
    throw new Error("A memory entry cannot conflict with itself.");
  }
  const ascending = parsed.firstMemoryId < parsed.secondMemoryId;
  const firstId = ascending ? parsed.firstMemoryId : parsed.secondMemoryId;
  const secondId = ascending ? parsed.secondMemoryId : parsed.firstMemoryId;
  const firstExpected = ascending
    ? parsed.expectedFirstActiveRevision : parsed.expectedSecondActiveRevision;
  const secondExpected = ascending
    ? parsed.expectedSecondActiveRevision : parsed.expectedFirstActiveRevision;

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    assertExpected(endpoint(db, firstId, parsed.projectId).activeRevision, firstExpected, firstId);
    assertExpected(endpoint(db, secondId, parsed.projectId).activeRevision, secondExpected, secondId);
    const old = db.prepare(`SELECT id, head_revision AS headRevision
      FROM workstation_project_memory_conflict
      WHERE project_id = ? AND first_memory_id = ? AND second_memory_id = ?`)
      .get(parsed.projectId, firstId, secondId) as { id: string; headRevision: number } | undefined;
    const previous = old?.headRevision ?? 0;
    if (parsed.expectedConflictRevision !== previous) {
      throw new Error(`Stale conflict revision: expected ${parsed.expectedConflictRevision}, current ${previous}.`);
    }
    if (previous >= MAX_PROJECT_MEMORY_CONFLICT_REVISIONS) {
      throw new Error("Conflict revision limit reached.");
    }
    if (!old) {
      const count = db.prepare(`SELECT COUNT(*) AS total FROM workstation_project_memory_conflict
        WHERE project_id = ?`).get(parsed.projectId) as { total: number };
      if (count.total >= MAX_PROJECT_MEMORY_CONFLICTS) {
        throw new Error("Project conflict limit reached.");
      }
    }
    const id = old?.id ?? randomUUID();
    const revision = previous + 1;
    if (!old) {
      db.prepare(`INSERT INTO workstation_project_memory_conflict
        (id, project_id, first_memory_id, second_memory_id, head_revision, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`).run(id, parsed.projectId, firstId, secondId, at);
    } else {
      db.prepare(`UPDATE workstation_project_memory_conflict SET head_revision = ? WHERE id = ?`)
        .run(revision, id);
    }
    db.prepare(`INSERT INTO workstation_project_memory_conflict_revision
      (conflict_id, revision, state, first_active_revision, second_active_revision,
       resolution, actor_id, reason, created_at)
      VALUES (?, ?, 'declared', ?, ?, NULL, ?, ?, ?)`)
      .run(id, revision, firstExpected, secondExpected, parsed.actorId, parsed.reason, at);
    bumpEpoch(db, parsed.projectId);
    db.exec("COMMIT");
    return listProjectMemoryConflicts(db, parsed.projectId).find((row) => row.id === id)!;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resolveProjectMemoryConflict(
  db: DatabaseSync, input: ResolveProjectMemoryConflictInput, at = Date.now()
): ProjectMemoryConflict {
  const parsed = ResolveSchema.parse(input);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const conflict = db.prepare(`SELECT id, project_id AS projectId,
      first_memory_id AS firstMemoryId, second_memory_id AS secondMemoryId,
      head_revision AS headRevision FROM workstation_project_memory_conflict WHERE id = ?`)
      .get(parsed.conflictId) as Omit<ProjectMemoryConflict, "createdAt" | "history"> | undefined;
    if (!conflict || conflict.projectId !== parsed.projectId) {
      throw new Error(`Conflict '${parsed.conflictId}' is not in project '${parsed.projectId}'.`);
    }
    if (conflict.headRevision !== parsed.expectedRevision) {
      throw new Error(`Stale conflict revision: expected ${parsed.expectedRevision}, current ${conflict.headRevision}.`);
    }
    if (conflict.headRevision >= MAX_PROJECT_MEMORY_CONFLICT_REVISIONS) {
      throw new Error("Conflict revision limit reached.");
    }
    const first = endpoint(db, conflict.firstMemoryId, parsed.projectId);
    const second = endpoint(db, conflict.secondMemoryId, parsed.projectId);
    assertExpected(first.activeRevision, parsed.expectedFirstActiveRevision, first.id);
    assertExpected(second.activeRevision, parsed.expectedSecondActiveRevision, second.id);
    const prior = revisionRows(db, conflict.id).at(-1);
    if (!prior) throw new Error(`Conflict '${conflict.id}' has no revision history.`);
    if (prior.state === "declared" && (
      (first.activeRevision !== prior.firstActiveRevision && first.activeRevision !== null) ||
      (second.activeRevision !== prior.secondActiveRevision && second.activeRevision !== null)
    )) {
      throw new Error("A declared memory version changed. Declare the current pair again.");
    }
    let resolution: ProjectMemoryConflictResolution;
    if (parsed.resolution.kind === "both_retired") resolution = "both_retired";
    else if (parsed.resolution.winnerId === first.id) resolution = "first_wins";
    else if (parsed.resolution.winnerId === second.id) resolution = "second_wins";
    else throw new Error("Winner must be one of the conflict's two memory entries.");
    if ((resolution === "first_wins" && first.activeRevision === null) ||
        (resolution === "second_wins" && second.activeRevision === null)) {
      throw new Error("A forgotten memory cannot be the winner.");
    }
    const revision = conflict.headRevision + 1;
    db.prepare(`INSERT INTO workstation_project_memory_conflict_revision
      (conflict_id, revision, state, first_active_revision, second_active_revision,
       resolution, actor_id, reason, created_at)
      VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, ?)`)
      .run(conflict.id, revision, first.activeRevision, second.activeRevision,
        resolution, parsed.actorId, parsed.reason, at);
    db.prepare(`UPDATE workstation_project_memory_conflict SET head_revision = ? WHERE id = ?`)
      .run(revision, conflict.id);
    bumpEpoch(db, parsed.projectId);
    db.exec("COMMIT");
    return listProjectMemoryConflicts(db, parsed.projectId).find((row) => row.id === conflict.id)!;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Fail closed on unresolved, stale, or mutually inconsistent owner decisions. */
export function compileProjectMemoryConflictSelection(
  db: DatabaseSync, projectId: string
): ReadonlyMap<string, readonly ProjectMemoryConflictExclusion[]> {
  const excluded = new Map<string, ProjectMemoryConflictExclusion[]>();
  const winners = new Set<string>();
  for (const conflict of listProjectMemoryConflicts(db, projectId)) {
    const head = conflict.history.at(-1);
    if (!head || head.revision !== conflict.headRevision) {
      throw new Error(`Conflict '${conflict.id}' has an incomplete revision history.`);
    }
    if (head.state === "declared") {
      throw new Error(`Project memory conflict '${conflict.id}' is unresolved. Review it before preparing context.`);
    }
    const first = endpoint(db, conflict.firstMemoryId, projectId);
    const second = endpoint(db, conflict.secondMemoryId, projectId);
    if (first.activeRevision !== head.firstActiveRevision ||
        second.activeRevision !== head.secondActiveRevision) {
      throw new Error(`Project memory conflict '${conflict.id}' resolution is stale. Review it again.`);
    }
    if (head.resolution === null) {
      throw new Error(`Project memory conflict '${conflict.id}' has no resolution.`);
    }
    const winnerId = head.resolution === "first_wins" ? first.id
      : head.resolution === "second_wins" ? second.id : null;
    if (winnerId !== null) {
      const winner = winnerId === first.id ? first : second;
      if (winner.activeRevision === null) {
        throw new Error(`Project memory conflict '${conflict.id}' winner was forgotten. Review it again.`);
      }
      winners.add(winnerId);
    }
    for (const id of [first.id, second.id]) {
      if (id === winnerId) continue;
      const row: ProjectMemoryConflictExclusion = {
        memoryId: id, conflictId: conflict.id, conflictRevision: head.revision,
        reason: head.reason, resolution: head.resolution, winnerId
      };
      excluded.set(id, [...(excluded.get(id) ?? []), row]);
    }
  }
  for (const id of winners) {
    if (excluded.has(id)) {
      throw new Error(`Project memory '${id}' is both a conflict winner and retired by another conflict. Review the resolutions.`);
    }
  }
  return excluded;
}

/** Called inside the memory-forget transaction so free-text rulings cannot retain erased content. */
export function redactProjectMemoryConflictReasonsForMemory(
  db: DatabaseSync, projectId: string, memoryId: string
): void {
  db.prepare(`UPDATE workstation_project_memory_conflict_revision
    SET reason = '[redacted by project memory forgetting]'
    WHERE conflict_id IN (
      SELECT id FROM workstation_project_memory_conflict
      WHERE project_id = ? AND (first_memory_id = ? OR second_memory_id = ?)
    )`).run(projectId, memoryId, memoryId);
}
