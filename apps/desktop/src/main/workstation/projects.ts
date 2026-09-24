/**
 * Durable persistence for long-lived workstation projects and immutable shared briefs.
 *
 * Governed by D-115 (horizontal workstation as front door) and D-116 (explicit outbound review).
 * Projects represent long-lived context, goals, and reviewed briefs, while Cases represent
 * bounded task rooms that finish with verdicts.
 *
 * Every edit appends an immutable project revision; stale revisions are rejected.
 * Brief capture into a case turn is verbatim, source-attributed, and idempotent.
 * Multi-write operations are atomic using BEGIN IMMEDIATE/COMMIT with rollback on error.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  WorkstationProject,
  WorkstationProjectAssignInput,
  WorkstationProjectCaptureInput,
  WorkstationProjectLink,
  WorkstationProjectSaveInput
} from "@cadrane/contracts";
import {
  WorkstationProjectAssignInputSchema,
  WorkstationProjectCaptureInputSchema,
  WorkstationProjectSaveInputSchema
} from "@cadrane/contracts";
import { appendTurn } from "../book/cases.js";

export type {
  WorkstationProject,
  WorkstationProjectAssignInput,
  WorkstationProjectCaptureInput,
  WorkstationProjectLink,
  WorkstationProjectSaveInput
};


export function listWorkstationProjects(
  db: DatabaseSync
): readonly WorkstationProject[] {
  const rows = db
    .prepare(
      `SELECT
         p.id AS id,
         r.title AS title,
         r.brief AS brief,
         r.revision AS revision,
         p.created_at AS createdAt,
         r.created_at AS updatedAt
       FROM workstation_project p
       JOIN workstation_project_revision r ON r.project_id = p.id
       WHERE r.revision = (
         SELECT MAX(r2.revision)
         FROM workstation_project_revision r2
         WHERE r2.project_id = p.id
       )
       ORDER BY r.created_at DESC, p.created_at DESC`
    )
    .all() as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row["id"]),
    title: String(row["title"]),
    brief: String(row["brief"]),
    revision: Number(row["revision"]),
    createdAt: Number(row["createdAt"]),
    updatedAt: Number(row["updatedAt"])
  }));
}

export function saveWorkstationProject(
  db: DatabaseSync,
  input: WorkstationProjectSaveInput,
  at: number = Date.now()
): WorkstationProject {
  const parsed = WorkstationProjectSaveInputSchema.parse(input);

  db.exec("PRAGMA foreign_keys = ON");

  if (parsed.id === undefined) {
    const projectId = randomUUID();
    const revisionId = randomUUID();

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO workstation_project (id, created_at) VALUES (?, ?)`
      ).run(projectId, at);

      db.prepare(
        `INSERT INTO workstation_project_revision (id, project_id, revision, title, brief, created_at)
         VALUES (?, ?, 1, ?, ?, ?)`
      ).run(revisionId, projectId, parsed.title, parsed.brief, at);

      db.exec("COMMIT");

      return {
        id: projectId,
        title: parsed.title,
        brief: parsed.brief,
        revision: 1,
        createdAt: at,
        updatedAt: at
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const projectId = parsed.id;
  const expectedRevision = parsed.expectedRevision!;

  db.exec("BEGIN IMMEDIATE");
  try {
    const projectRow = db
      .prepare(`SELECT id, created_at AS createdAt FROM workstation_project WHERE id = ?`)
      .get(projectId) as Record<string, unknown> | undefined;

    if (projectRow === undefined) {
      throw new Error(`Cannot update project: project '${projectId}' does not exist.`);
    }

    const revRow = db
      .prepare(
        `SELECT MAX(revision) AS currentRevision
         FROM workstation_project_revision
         WHERE project_id = ?`
      )
      .get(projectId) as Record<string, unknown> | undefined;

    const currentRevision = revRow?.["currentRevision"];
    if (currentRevision === null || currentRevision === undefined) {
      throw new Error(`Cannot update project: project '${projectId}' has no recorded revisions.`);
    }

    const currentRevNum = Number(currentRevision);
    if (currentRevNum !== expectedRevision) {
      throw new Error(
        `Stale project revision: expected revision ${expectedRevision}, but current revision is ${currentRevNum}.`
      );
    }

    const nextRevision = currentRevNum + 1;
    const revisionId = randomUUID();

    db.prepare(
      `INSERT INTO workstation_project_revision (id, project_id, revision, title, brief, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(revisionId, projectId, nextRevision, parsed.title, parsed.brief, at);

    db.exec("COMMIT");

    return {
      id: projectId,
      title: parsed.title,
      brief: parsed.brief,
      revision: nextRevision,
      createdAt: Number(projectRow["createdAt"]),
      updatedAt: at
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listWorkstationProjectLinks(
  db: DatabaseSync
): readonly WorkstationProjectLink[] {
  const rows = db
    .prepare(
      `SELECT case_id AS caseId, project_id AS projectId
       FROM workstation_project_link
       ORDER BY created_at ASC, case_id ASC`
    )
    .all() as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    caseId: String(row["caseId"]),
    projectId: String(row["projectId"])
  }));
}

export function assignWorkstationProject(
  db: DatabaseSync,
  input: { readonly caseId: string; readonly projectId: string | null }
): void {
  const parsed = WorkstationProjectAssignInputSchema.parse(input);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare(`SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?`)
      .get(parsed.caseId) as Record<string, unknown> | undefined;

    if (caseRow === undefined) {
      throw new Error(`Cannot assign project: case '${parsed.caseId}' does not exist.`);
    }

    if (caseRow["closedAt"] !== null) {
      throw new Error(`Cannot assign project: case '${parsed.caseId}' is closed.`);
    }

    if (parsed.projectId === null) {
      db.prepare(`DELETE FROM workstation_project_link WHERE case_id = ?`).run(parsed.caseId);
    } else {
      const projectRow = db
        .prepare(`SELECT id FROM workstation_project WHERE id = ?`)
        .get(parsed.projectId) as Record<string, unknown> | undefined;

      if (projectRow === undefined) {
        throw new Error(`Cannot assign project: project '${parsed.projectId}' does not exist.`);
      }

      db.prepare(`DELETE FROM workstation_project_link WHERE case_id = ?`).run(parsed.caseId);
      db.prepare(
        `INSERT INTO workstation_project_link (case_id, project_id, created_at)
         VALUES (?, ?, ?)`
      ).run(parsed.caseId, parsed.projectId, Date.now());
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function projectForWork(
  db: DatabaseSync,
  caseId: string
): WorkstationProject | null {
  if (!caseId || typeof caseId !== "string" || caseId.trim().length === 0) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT
         p.id AS id,
         r.title AS title,
         r.brief AS brief,
         r.revision AS revision,
         p.created_at AS createdAt,
         r.created_at AS updatedAt
       FROM workstation_project_link l
       JOIN workstation_project p ON p.id = l.project_id
       JOIN workstation_project_revision r ON r.project_id = p.id
       WHERE l.case_id = ? AND r.revision = (
         SELECT MAX(r2.revision)
         FROM workstation_project_revision r2
         WHERE r2.project_id = p.id
       )`
    )
    .get(caseId.trim()) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return {
    id: String(row["id"]),
    title: String(row["title"]),
    brief: String(row["brief"]),
    revision: Number(row["revision"]),
    createdAt: Number(row["createdAt"]),
    updatedAt: Number(row["updatedAt"])
  };
}

export function captureProjectBrief(
  db: DatabaseSync,
  input: { readonly caseId: string; readonly expectedRevision: number },
  at: number = Date.now()
): { readonly sourceTurnId: string; readonly project: WorkstationProject } {
  const parsed = WorkstationProjectCaptureInputSchema.parse(input);

  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare(`SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?`)
      .get(parsed.caseId) as Record<string, unknown> | undefined;

    if (caseRow === undefined) {
      throw new Error(`Cannot capture brief: case '${parsed.caseId}' does not exist.`);
    }

    if (caseRow["closedAt"] !== null) {
      throw new Error(`Cannot capture brief: case '${parsed.caseId}' is closed.`);
    }

    const linkRow = db
      .prepare(`SELECT project_id AS projectId FROM workstation_project_link WHERE case_id = ?`)
      .get(parsed.caseId) as Record<string, unknown> | undefined;

    if (linkRow === undefined) {
      throw new Error(`Cannot capture brief: case '${parsed.caseId}' has no assigned project.`);
    }

    const projectId = String(linkRow["projectId"]);

    const projRow = db
      .prepare(
        `SELECT
           p.id AS id,
           r.title AS title,
           r.brief AS brief,
           r.revision AS revision,
           p.created_at AS createdAt,
           r.created_at AS updatedAt
         FROM workstation_project p
         JOIN workstation_project_revision r ON r.project_id = p.id
         WHERE p.id = ? AND r.revision = (
           SELECT MAX(r2.revision)
           FROM workstation_project_revision r2
           WHERE r2.project_id = p.id
         )`
      )
      .get(projectId) as Record<string, unknown> | undefined;

    if (projRow === undefined) {
      throw new Error(`Cannot capture brief: assigned project '${projectId}' not found.`);
    }

    const project: WorkstationProject = {
      id: String(projRow["id"]),
      title: String(projRow["title"]),
      brief: String(projRow["brief"]),
      revision: Number(projRow["revision"]),
      createdAt: Number(projRow["createdAt"]),
      updatedAt: Number(projRow["updatedAt"])
    };

    if (project.revision !== parsed.expectedRevision) {
      throw new Error(
        `Cannot capture brief: expected revision ${parsed.expectedRevision}, but current revision is ${project.revision}.`
      );
    }

    // Repeat capture of the same case/project/revision returns the same still-existing sourceTurnId
    const existingCapture = db
      .prepare(
        `SELECT s.source_turn_id AS sourceTurnId
         FROM workstation_project_source s
         JOIN case_turn t ON t.id = s.source_turn_id
         WHERE s.case_id = ? AND s.project_id = ? AND s.revision = ?`
      )
      .get(parsed.caseId, project.id, project.revision) as Record<string, unknown> | undefined;

    if (existingCapture !== undefined) {
      db.exec("COMMIT");
      return {
        sourceTurnId: String(existingCapture["sourceTurnId"]),
        project
      };
    }

    const seat = `Source · Project brief · ${project.title} · v${project.revision}`;
    const sourceTurnId = appendTurn(
      db,
      parsed.caseId,
      {
        seat,
        kind: "verbatim",
        body: project.brief
      },
      at
    );

    const sourceRecordId = randomUUID();
    db.prepare(
      `INSERT INTO workstation_project_source (id, case_id, project_id, revision, source_turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sourceRecordId, parsed.caseId, project.id, project.revision, sourceTurnId, at);

    db.exec("COMMIT");

    return {
      sourceTurnId,
      project
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
