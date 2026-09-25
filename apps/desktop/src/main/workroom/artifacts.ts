/** Finished work needs a version people can review, edit and accept independently
 * of the conversation. Versions are append-only; acceptance is a separate act. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CaseArtifactSaveSchema,
  type CaseArtifactVersion,
  type CaseArtifactSave
} from "@cadrane/contracts";
import { appendTurn, readCase, turnsFor } from "../book/cases.js";

export interface ArtifactLineageSource {
  readonly id: string;
  readonly seat: string;
  readonly kind: "verbatim" | "finding" | "receipt" | "compacted";
}

export type ArtifactLineageStatus = "verified" | "unverified";

export interface ArtifactLineageEntry {
  readonly id: string;
  readonly versionId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly previousVersionId: string | null;
  readonly sourceTurnId: string | null;
  readonly sourceSeat: string | null;
  readonly sourceKind: ("verbatim" | "finding" | "receipt" | "compacted") | null;
  readonly source: ArtifactLineageSource | null;
  readonly acceptedAt: number | null;
  readonly status: ArtifactLineageStatus;
  readonly reason: string | null;
}

export function artifactVersions(
  db: DatabaseSync,
  caseId: string
): readonly CaseArtifactVersion[] {
  return db
    .prepare(
      `SELECT id, revision, source_turn_id AS sourceTurnId, body,
    created_at AS createdAt, accepted_at AS acceptedAt FROM case_artifact_version
    WHERE case_id = ? ORDER BY revision DESC`
    )
    .all(caseId)
    .map((row) => ({
      id: String(row["id"]),
      revision: Number(row["revision"]),
      sourceTurnId:
        row["sourceTurnId"] === null ? null : String(row["sourceTurnId"]),
      body: String(row["body"]),
      createdAt: Number(row["createdAt"]),
      acceptedAt: row["acceptedAt"] === null ? null : Number(row["acceptedAt"])
    }));
}

export function artifactLineage(
  db: DatabaseSync,
  caseId: string
): readonly ArtifactLineageEntry[] {
  const versionRows = (
    db
      .prepare(
        `SELECT id, revision, source_turn_id AS sourceTurnId, body, accepted_at AS acceptedAt
        FROM case_artifact_version
        WHERE case_id = ?
        ORDER BY revision DESC`
      )
      .all(caseId) as readonly Record<string, unknown>[]
  ).map((row) => ({
    id: String(row["id"]),
    revision: Number(row["revision"]),
    sourceTurnId:
      row["sourceTurnId"] === null ? null : String(row["sourceTurnId"]),
    body: String(row["body"]),
    acceptedAt: row["acceptedAt"] === null ? null : Number(row["acceptedAt"])
  }));

  const turnRows = (
    db
      .prepare(`SELECT id, seat, kind FROM case_turn WHERE case_id = ?`)
      .all(caseId) as readonly Record<string, unknown>[]
  ).map((row) => ({
    id: String(row["id"]),
    seat: String(row["seat"]),
    kind: String(row["kind"]) as "verbatim" | "finding" | "receipt" | "compacted"
  }));

  const revisionToId = new Map<number, string>();
  for (const v of versionRows) {
    revisionToId.set(v.revision, v.id);
  }

  const turnMap = new Map<
    string,
    { id: string; seat: string; kind: "verbatim" | "finding" | "receipt" | "compacted" }
  >();
  for (const t of turnRows) {
    turnMap.set(t.id, t);
  }

  return versionRows.map((v) => {
    const issues: string[] = [];

    let previousVersionId: string | null = null;
    if (v.revision > 1) {
      const prevId = revisionToId.get(v.revision - 1) ?? null;
      previousVersionId = prevId;
      if (prevId === null) {
        issues.push(`Missing predecessor revision ${v.revision - 1}`);
      }
    }

    let source: ArtifactLineageSource | null = null;
    let sourceSeat: string | null = null;
    let sourceKind: ("verbatim" | "finding" | "receipt" | "compacted") | null = null;

    if (v.sourceTurnId !== null) {
      const turn = turnMap.get(v.sourceTurnId);
      if (!turn) {
        issues.push(`Source turn ${v.sourceTurnId} not found in this workroom`);
      } else if (turn.kind !== "verbatim") {
        issues.push(`Source turn ${v.sourceTurnId} is not verbatim in this workroom`);
      } else {
        source = { id: turn.id, seat: turn.seat, kind: turn.kind };
        sourceSeat = turn.seat;
        sourceKind = turn.kind;
      }
    }

    const sha256 = createHash("sha256").update(v.body).digest("hex");
    const isVerified = issues.length === 0;
    const status: ArtifactLineageStatus = isVerified ? "verified" : "unverified";
    const reason: string | null = isVerified ? null : issues.join("; ");

    return {
      id: v.id,
      versionId: v.id,
      revision: v.revision,
      sha256,
      previousVersionId,
      sourceTurnId: v.sourceTurnId,
      sourceSeat,
      sourceKind,
      source,
      acceptedAt: v.acceptedAt,
      status,
      reason
    };
  });
}

function requireOpen(db: DatabaseSync, id: string): void {
  const room = readCase(db, id);
  if (!room || room.closedAt !== null)
    throw new Error("Open this workroom before changing its output.");
}

export function saveArtifact(
  db: DatabaseSync,
  raw: CaseArtifactSave
): CaseArtifactVersion {
  const input = CaseArtifactSaveSchema.parse(raw);
  db.exec("BEGIN IMMEDIATE");
  try {
    requireOpen(db, input.id);
    const versions = artifactVersions(db, input.id);
    const latest = versions[0];
    if ((latest?.id ?? null) !== input.baseVersionId)
      throw new Error(
        "A newer output version exists. Reload it before saving your changes."
      );
    if (versions.length >= 100)
      throw new Error(
        "This output has 100 saved versions. Start a new workroom to continue; existing versions are preserved."
      );
    const source =
      input.sourceTurnId === null
        ? null
        : turnsFor(db, input.id).find(
            (turn) => turn.id === input.sourceTurnId && turn.kind === "verbatim"
          );
    if (input.sourceTurnId !== null && !source)
      throw new Error("The source draft is not in this workroom.");
    const result: CaseArtifactVersion = {
      id: randomUUID(),
      revision: (latest?.revision ?? 0) + 1,
      sourceTurnId: input.sourceTurnId,
      body: input.body,
      createdAt: Date.now(),
      acceptedAt: null
    };
    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      result.id,
      input.id,
      result.revision,
      result.sourceTurnId,
      result.body,
      result.createdAt
    );
    appendTurn(db, input.id, {
      seat: "workroom",
      kind: "receipt",
      body: `Output version ${result.revision} saved by you. Version: ${result.id}. ${source ? `Based on draft ${source.id} by ${source.seat}.` : "Written by you."} Review is pending.`
    });
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function acceptArtifact(
  db: DatabaseSync,
  caseId: string,
  versionId: string
): CaseArtifactVersion {
  db.exec("BEGIN IMMEDIATE");
  try {
    requireOpen(db, caseId);
    const version = artifactVersions(db, caseId)[0];
    if (!version || version.id !== versionId)
      throw new Error(
        "Only the latest saved version in this workroom can be accepted. Reload the output."
      );
    if (version.acceptedAt !== null) {
      db.exec("COMMIT");
      return version;
    }
    const acceptedAt = Date.now();
    db.prepare(
      "UPDATE case_artifact_version SET accepted_at = ? WHERE id = ? AND case_id = ?"
    ).run(acceptedAt, versionId, caseId);
    appendTurn(db, caseId, {
      seat: "workroom",
      kind: "receipt",
      body: `Output version ${version.revision} accepted by you. Version: ${version.id}. Nothing was sent or published.`
    });
    db.exec("COMMIT");
    return { ...version, acceptedAt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
