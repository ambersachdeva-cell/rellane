/**
 * Saved workstation routines — durable persistence in the shop's book.
 *
 * User-authored routines are saved prompt templates that show up among starter
 * routines in the workstation shell. Selecting a routine merely fills the
 * composer with reviewed instructions and source hints — it never grants
 * autonomous execution authority, schedules background tasks, or bypasses
 * the host's strict outbound review.
 *
 * Each save writes an immutable revision into `workstation_routine_version`
 * and updates `workstation_routine`. Stale updates are detected and refused
 * via optimistic revision checks (`expectedRevision`).
 *
 * Provenance is captured only at creation time from a verified `verbatim`
 * Case turn (never a receipt, summary, or cross-case turn). To ensure DPDP
 * case erasure (`eraseCase`) remains completely unblocked and normal business
 * ledger operations are never hindered, provenance is stored as a non-grant
 * informational pointer rather than a restrictive foreign key.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type WorkstationRoutineSaveInput,
  type WorkstationSavedRoutine,
  WorkstationRoutineSaveInputSchema
} from "@cadrane/contracts";


export function saveWorkstationRoutine(
  db: DatabaseSync,
  input: WorkstationRoutineSaveInput,
  at: number = Date.now()
): WorkstationSavedRoutine {
  const validated = WorkstationRoutineSaveInputSchema.parse(input);

  if (validated.id === undefined) {
    let originCaseId: string | null = null;
    let originTurnId: string | null = null;

    if (validated.originCaseId !== undefined && validated.originTurnId !== undefined) {
      const turnRow = db
        .prepare(`SELECT case_id AS caseId, kind FROM case_turn WHERE id = ?`)
        .get(validated.originTurnId) as Record<string, unknown> | undefined;

      if (turnRow === undefined) {
        throw new Error(`Origin turn '${validated.originTurnId}' does not exist.`);
      }

      if (String(turnRow["caseId"]) !== validated.originCaseId) {
        throw new Error(
          `Origin turn '${validated.originTurnId}' belongs to case '${String(turnRow["caseId"])}', not indicated case '${validated.originCaseId}'.`
        );
      }

      const kind = String(turnRow["kind"]);
      if (kind !== "verbatim") {
        throw new Error(
          `Origin turn must be verbatim to serve as routine provenance (found '${kind}').`
        );
      }

      const caseRow = db
        .prepare(`SELECT id FROM work_case WHERE id = ?`)
        .get(validated.originCaseId) as Record<string, unknown> | undefined;

      if (caseRow === undefined) {
        throw new Error(`Origin case '${validated.originCaseId}' does not exist.`);
      }

      originCaseId = validated.originCaseId;
      originTurnId = validated.originTurnId;
    }

    const id = randomUUID();

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        INSERT INTO workstation_routine (id, created_at, updated_at, current_revision, origin_case_id, origin_turn_id)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(id, at, at, originCaseId, originTurnId);

      db.prepare(`
        INSERT INTO workstation_routine_version (
          routine_id, revision, title, description, prompt, icon, source_hint, output_label, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        validated.title,
        validated.description,
        validated.prompt,
        validated.icon,
        validated.sourceHint,
        validated.outputLabel,
        at
      );

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      id,
      title: validated.title,
      description: validated.description,
      prompt: validated.prompt,
      icon: validated.icon,
      sourceHint: validated.sourceHint,
      outputLabel: validated.outputLabel,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      originCaseId,
      originTurnId
    };
  }

  const routineId = validated.id;
  const expectedRev = validated.expectedRevision;
  if (expectedRev === undefined) {
    throw new Error("expectedRevision is required when updating an existing routine.");
  }

  const existing = db
    .prepare(
      `SELECT id, created_at AS createdAt, updated_at AS updatedAt, current_revision AS currentRevision, origin_case_id AS originCaseId, origin_turn_id AS originTurnId
       FROM workstation_routine WHERE id = ?`
    )
    .get(routineId) as Record<string, unknown> | undefined;

  if (existing === undefined) {
    throw new Error(`Routine '${routineId}' does not exist.`);
  }

  const currentRevision = Number(existing["currentRevision"]);
  if (currentRevision !== expectedRev) {
    throw new Error(
      `Stale revision conflict for routine '${routineId}': expected revision ${expectedRev}, but current revision is ${currentRevision}.`
    );
  }

  const existingOriginCaseId =
    existing["originCaseId"] === null ? null : String(existing["originCaseId"]);
  const existingOriginTurnId =
    existing["originTurnId"] === null ? null : String(existing["originTurnId"]);

  if (validated.originCaseId !== undefined || validated.originTurnId !== undefined) {
    const inputCaseId = validated.originCaseId ?? null;
    const inputTurnId = validated.originTurnId ?? null;
    if (inputCaseId !== existingOriginCaseId || inputTurnId !== existingOriginTurnId) {
      throw new Error(
        "Routine provenance is immutable: cannot replace originating case or turn on subsequent edits."
      );
    }
  }

  const nextRevision = currentRevision + 1;
  const createdAt = Number(existing["createdAt"]);

  db.exec("BEGIN IMMEDIATE");
  try {
    const updateResult = db
      .prepare(
        `UPDATE workstation_routine
         SET current_revision = ?, updated_at = ?
         WHERE id = ? AND current_revision = ?`
      )
      .run(nextRevision, at, routineId, expectedRev);

    if (Number(updateResult.changes) === 0) {
      throw new Error(
        `Stale revision conflict for routine '${routineId}': expected revision ${expectedRev} could not be updated.`
      );
    }

    db.prepare(`
      INSERT INTO workstation_routine_version (
        routine_id, revision, title, description, prompt, icon, source_hint, output_label, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      routineId,
      nextRevision,
      validated.title,
      validated.description,
      validated.prompt,
      validated.icon,
      validated.sourceHint,
      validated.outputLabel,
      at
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    id: routineId,
    title: validated.title,
    description: validated.description,
    prompt: validated.prompt,
    icon: validated.icon,
    sourceHint: validated.sourceHint,
    outputLabel: validated.outputLabel,
    revision: nextRevision,
    createdAt,
    updatedAt: at,
    originCaseId: existingOriginCaseId,
    originTurnId: existingOriginTurnId
  };
}

export function listSavedWorkstationRoutines(
  db: DatabaseSync
): readonly WorkstationSavedRoutine[] {
  const rows = db
    .prepare(
      `SELECT
         r.id AS id,
         v.title AS title,
         v.description AS description,
         v.prompt AS prompt,
         v.icon AS icon,
         v.source_hint AS sourceHint,
         v.output_label AS outputLabel,
         v.revision AS revision,
         r.created_at AS createdAt,
         r.updated_at AS updatedAt,
         r.origin_case_id AS originCaseId,
         r.origin_turn_id AS originTurnId
       FROM workstation_routine r
       JOIN workstation_routine_version v
         ON v.routine_id = r.id AND v.revision = r.current_revision
       ORDER BY r.updated_at DESC, r.id ASC`
    )
    .all() as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row["id"]),
    title: String(row["title"]),
    description: String(row["description"]),
    prompt: String(row["prompt"]),
    icon: String(row["icon"]) as WorkstationSavedRoutine["icon"],
    sourceHint: String(row["sourceHint"]),
    outputLabel: String(row["outputLabel"]),
    revision: Number(row["revision"]),
    createdAt: Number(row["createdAt"]),
    updatedAt: Number(row["updatedAt"]),
    originCaseId: row["originCaseId"] === null ? null : String(row["originCaseId"]),
    originTurnId: row["originTurnId"] === null ? null : String(row["originTurnId"])
  }));
}

export function savedWorkstationRoutineVersions(
  db: DatabaseSync,
  id: string
): readonly WorkstationSavedRoutine[] {
  const rows = db
    .prepare(
      `SELECT
         r.id AS id,
         v.title AS title,
         v.description AS description,
         v.prompt AS prompt,
         v.icon AS icon,
         v.source_hint AS sourceHint,
         v.output_label AS outputLabel,
         v.revision AS revision,
         r.created_at AS createdAt,
         v.created_at AS updatedAt,
         r.origin_case_id AS originCaseId,
         r.origin_turn_id AS originTurnId
       FROM workstation_routine r
       JOIN workstation_routine_version v
         ON v.routine_id = r.id
       WHERE r.id = ?
       ORDER BY v.revision ASC`
    )
    .all(id) as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row["id"]),
    title: String(row["title"]),
    description: String(row["description"]),
    prompt: String(row["prompt"]),
    icon: String(row["icon"]) as WorkstationSavedRoutine["icon"],
    sourceHint: String(row["sourceHint"]),
    outputLabel: String(row["outputLabel"]),
    revision: Number(row["revision"]),
    createdAt: Number(row["createdAt"]),
    updatedAt: Number(row["updatedAt"]),
    originCaseId: row["originCaseId"] === null ? null : String(row["originCaseId"]),
    originTurnId: row["originTurnId"] === null ? null : String(row["originTurnId"])
  }));
}
