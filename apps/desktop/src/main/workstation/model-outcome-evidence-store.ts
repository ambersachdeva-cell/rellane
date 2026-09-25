/**
 * SM05 bounded DB loader for measured operation evidence.
 *
 * Reads validated WorkstationSessionReceipt records from case_turn,
 * scopes by case and truthful recorded project,
 * fails closed on corrupt receipts or capacity overflow,
 * and passes bounded receipts to projectModelOutcomeEvidence.
 *
 * Invariants:
 * - Read-only: does not mutate or insert rows.
 * - Project scoping uses receipt.projectId as recorded; legacy rows fall back to link.
 * - No cross-project leakage.
 * - Corrupt receipts (invalid JSON, malformed schema, mismatched caseId) fail closed.
 * - Capacity overflow (rows > maxLimit) fails closed with no partial projection.
 * - No raw body, prompt, or answer text exposed in returned evidence.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ProjectIdSchema } from "./model-project-preferences-store.js";
import { WORKSTATION_SESSION_SEAT, validateReceipt } from "./store.js";
import type { WorkstationSessionReceipt } from "./store.js";
import {
  DEFAULT_MAX_RECEIPTS,
  projectModelOutcomeEvidence
} from "./model-outcome-evidence.js";
import type {
  ModelOutcomeEvidence,
  ModelOutcomeEvidenceOptions
} from "./model-outcome-evidence.js";

export const MAX_MODEL_OUTCOME_RECEIPTS = DEFAULT_MAX_RECEIPTS;
export const MAX_MODEL_OUTCOME_SNAPSHOT_OPERATIONS = 200;

export interface ModelOutcomeReceiptRef {
  readonly caseTurnId: string;
  readonly caseId: string;
  readonly seq: number;
  readonly at: number;
  readonly bodySha256: string;
  readonly linkedProjectId: string | null;
  readonly linkCreatedAt: number | null;
  readonly recordedProjectId: string | null | "legacy_absent";
  readonly effectiveProjectId: string | null;
}

export interface ModelOutcomeEvidenceSnapshot {
  readonly version: 1;
  readonly projectId: string;
  readonly receiptCount: number;
  readonly operationCount: number;
  readonly receiptRefs: readonly ModelOutcomeReceiptRef[];
  readonly outcomes: readonly ModelOutcomeEvidence[];
  readonly sha256: string;
}

export type { ModelOutcomeEvidence, ModelOutcomeEvidenceOptions };

function resolveMaxLimit(options?: ModelOutcomeEvidenceOptions): number {
  if (
    typeof options?.maxReceipts === "number" &&
    Number.isFinite(options.maxReceipts) &&
    options.maxReceipts > 0
  ) {
    return Math.min(Math.floor(options.maxReceipts), MAX_MODEL_OUTCOME_RECEIPTS);
  }
  return MAX_MODEL_OUTCOME_RECEIPTS;
}

/**
 * Loads bounded measured operation evidence from the database.
 * Scopes by case and project truthfully, fails closed on corrupt records or cap overflow,
 * and returns projected evidence without exposing raw body or text data.
 */
function loadScopedReceipts(
  db: DatabaseSync,
  options?: ModelOutcomeEvidenceOptions
): { readonly receipts: readonly WorkstationSessionReceipt[]; readonly refs: readonly ModelOutcomeReceiptRef[] } {
  const maxLimit = resolveMaxLimit(options);
  if (maxLimit <= 0) {
    return { receipts: [], refs: [] };
  }

  const conditions: string[] = [
    "ct.seat = ?",
    "ct.kind = 'receipt'"
  ];
  const params: (string | number | null)[] = [WORKSTATION_SESSION_SEAT];

  if (options?.caseId !== undefined) {
    if (typeof options.caseId !== "string" || options.caseId.trim().length === 0) {
      return { receipts: [], refs: [] };
    }
    conditions.push("ct.case_id = ?");
    params.push(options.caseId.trim());
  }

  if (options?.projectId !== undefined) {
    const targetProjectId = options.projectId === null ? null : options.projectId.trim();
    if (targetProjectId === "") return { receipts: [], refs: [] };
    // A recorded project takes precedence over a case's current link. Legacy
    // receipts have no projectId and use that link; explicit null stays null.
    // Invalid JSON cannot expose recorded scope, so a linked row is charged to
    // its link and an unlinked row remains ambiguous and fails closed for any
    // project. The same rule applies to a non-string recorded projectId.
    conditions.push(`(
      CASE
        WHEN json_valid(ct.body) = 0 THEN l.project_id IS ? OR l.project_id IS NULL
        WHEN json_type(ct.body) != 'object' THEN l.project_id IS ? OR l.project_id IS NULL
        WHEN json_type(ct.body, '$.projectId') = 'text'
          THEN trim(json_extract(ct.body, '$.projectId')) IS ?
        WHEN json_type(ct.body, '$.projectId') = 'null' THEN ? IS NULL
        WHEN json_type(ct.body, '$.projectId') IS NULL THEN l.project_id IS ?
        ELSE l.project_id IS ? OR l.project_id IS NULL
      END
    )`);
    params.push(
      targetProjectId, targetProjectId, targetProjectId,
      targetProjectId, targetProjectId, targetProjectId
    );
  }

  const sql = `
    SELECT
      ct.id AS turnId,
      ct.case_id AS caseId,
      ct.seq AS seq,
      ct.body AS body,
      ct.at AS at,
      l.project_id AS linkedProjectId,
      l.created_at AS linkCreatedAt
    FROM case_turn ct
    LEFT JOIN workstation_project_link l ON l.case_id = ct.case_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY ct.case_id ASC, ct.seq ASC
    LIMIT ?
  `;

  // Read maxLimit + 1 to detect overflow deterministically
  params.push(maxLimit + 1);

  const rows = db.prepare(sql).all(...params) as readonly Record<string, unknown>[];

  if (rows.length > maxLimit) {
    throw new Error(
      `Model outcome evidence limit exceeded: scope contains more than ${maxLimit} receipts`
    );
  }

  const receipts: WorkstationSessionReceipt[] = [];
  const refs: ModelOutcomeReceiptRef[] = [];

  for (const row of rows) {
    const rowCaseId = typeof row["caseId"] === "string" ? row["caseId"] : null;
    const bodyRaw = row["body"];
    if (!rowCaseId || typeof bodyRaw !== "string") {
      throw new Error(`Corrupt receipt record: invalid caseId or body in case_turn row`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyRaw);
    } catch {
      throw new Error(`Corrupt receipt in case ${rowCaseId}: unparseable JSON body`);
    }

    const validated = validateReceipt(parsed);
    if (validated === null) {
      throw new Error(`Corrupt receipt in case ${rowCaseId}: schema validation failed`);
    }

    if (validated.snapshot.caseId !== rowCaseId) {
      throw new Error(
        `Mismatched receipt caseId: snapshot claims ${validated.snapshot.caseId} but turn belongs to ${rowCaseId}`
      );
    }

    const turnId = row["turnId"];
    const seq = row["seq"];
    const at = row["at"];
    const linkedRaw = row["linkedProjectId"];
    const linkCreatedRaw = row["linkCreatedAt"];
    if (typeof turnId !== "string" || turnId.length === 0 ||
        typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 ||
        typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 ||
        (linkedRaw !== null && (typeof linkedRaw !== "string" || linkedRaw.trim().length === 0)) ||
        (linkCreatedRaw !== null && (typeof linkCreatedRaw !== "number" ||
          !Number.isSafeInteger(linkCreatedRaw) || linkCreatedRaw < 0))) {
      throw new Error(`Corrupt receipt row identity in case ${rowCaseId}`);
    }

    const linkedProjectId =
      typeof row["linkedProjectId"] === "string" && row["linkedProjectId"].trim().length > 0
        ? row["linkedProjectId"].trim()
        : null;

    const parsedRecord =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    const hasRecordedProjectId =
      (parsedRecord !== null && "projectId" in parsedRecord && parsedRecord["projectId"] !== undefined) ||
      validated.projectId !== undefined;

    const recordedProjectId = hasRecordedProjectId
      ? typeof validated.projectId === "string" && validated.projectId.trim().length > 0
        ? validated.projectId.trim()
        : null
      : undefined;

    // Truthful project scope: use receipt.projectId as recorded;
    // explicit null is unscoped historical truth;
    // fallback to current linkedProjectId only for legacy rows without recorded projectId.
    const effectiveProjectId =
      recordedProjectId !== undefined ? recordedProjectId : linkedProjectId;

    if (options?.projectId !== undefined) {
      const targetProjectId =
        options.projectId === null
          ? null
          : typeof options.projectId === "string" && options.projectId.trim().length > 0
            ? options.projectId.trim()
            : undefined;

      if (effectiveProjectId !== targetProjectId) {
        continue;
      }
    }

    refs.push({
      caseTurnId: turnId,
      caseId: rowCaseId,
      seq,
      at,
      bodySha256: createHash("sha256").update(bodyRaw, "utf8").digest("hex"),
      linkedProjectId,
      linkCreatedAt: linkCreatedRaw,
      recordedProjectId: recordedProjectId === undefined ? "legacy_absent" : recordedProjectId,
      effectiveProjectId
    });

    // Protect memory use by releasing large raw prompt/detail/activity strings before projecting
    const sanitized: WorkstationSessionReceipt = {
      version: 1,
      event: validated.event,
      workspacePath: validated.workspacePath,
      ...(validated.contextSnapshotId ? { contextSnapshotId: validated.contextSnapshotId } : {}),
      projectId: effectiveProjectId,
      snapshot: {
        operationId: validated.snapshot.operationId,
        caseId: validated.snapshot.caseId,
        providerId: validated.snapshot.providerId,
        modelId: validated.snapshot.modelId,
        ...(validated.snapshot.reportedModelId
          ? { reportedModelId: validated.snapshot.reportedModelId }
          : {}),
        sessionId: validated.snapshot.sessionId,
        status: validated.snapshot.status,
        startedAt: validated.snapshot.startedAt,
        updatedAt: validated.snapshot.updatedAt,
        text: "",
        activity: [],
        permission: null,
        detail: ""
      }
    };

    receipts.push(sanitized);
  }

  return { receipts, refs };
}

export function readModelOutcomeEvidence(
  db: DatabaseSync,
  options?: ModelOutcomeEvidenceOptions
): readonly ModelOutcomeEvidence[] {
  return projectModelOutcomeEvidence(loadScopedReceipts(db, options).receipts, options);
}

/** Exact, read-only source identity for a project's observed operation outcomes. */
export function readModelOutcomeEvidenceSnapshot(
  db: DatabaseSync,
  projectId: string,
  maxReceipts: number = MAX_MODEL_OUTCOME_RECEIPTS
): ModelOutcomeEvidenceSnapshot {
  const validProjectId = ProjectIdSchema.parse(projectId);
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 ||
      maxReceipts > MAX_MODEL_OUTCOME_RECEIPTS) {
    throw new Error("Invalid model outcome snapshot receipt bound.");
  }
  db.exec("SAVEPOINT model_outcome_snapshot");
  try {
    if (!db.prepare("SELECT id FROM workstation_project WHERE id = ?").get(validProjectId)) {
      throw new Error("Model outcome snapshot project does not exist or was forgotten.");
    }
    const { receipts, refs } = loadScopedReceipts(db, {
      projectId: validProjectId, maxReceipts
    });
    const outcomes = projectModelOutcomeEvidence(receipts, { projectId: validProjectId, maxReceipts });
    if (outcomes.length > MAX_MODEL_OUTCOME_SNAPSHOT_OPERATIONS) {
      throw new Error("Model outcome snapshot operation bound exceeded; no evidence may be omitted.");
    }
    if (refs.some((ref) => ref.effectiveProjectId !== validProjectId)) {
      throw new Error("Cross-project model outcome snapshot receipt refused.");
    }
    const identity = JSON.stringify({ version: 1, projectId: validProjectId, receiptRefs: refs, outcomes });
    const snapshot: ModelOutcomeEvidenceSnapshot = {
      version: 1,
      projectId: validProjectId,
      receiptCount: refs.length,
      operationCount: outcomes.length,
      receiptRefs: refs,
      outcomes,
      sha256: createHash("sha256").update(identity, "utf8").digest("hex")
    };
    db.exec("RELEASE SAVEPOINT model_outcome_snapshot");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT model_outcome_snapshot");
    db.exec("RELEASE SAVEPOINT model_outcome_snapshot");
    throw error;
  }
}

/** Re-read exact source rows; changed, removed, or relinked receipts invalidate the snapshot. */
export function assertModelOutcomeEvidenceSnapshotCurrent(
  db: DatabaseSync,
  expected: Pick<ModelOutcomeEvidenceSnapshot, "projectId" | "receiptCount" | "operationCount" | "sha256">
): ModelOutcomeEvidenceSnapshot {
  if (!expected || !Number.isSafeInteger(expected.receiptCount) ||
      !Number.isSafeInteger(expected.operationCount) ||
      expected.receiptCount < 0 || expected.operationCount < 0 ||
      !/^[a-f0-9]{64}$/u.test(expected.sha256)) {
    throw new Error("Invalid model outcome snapshot identity.");
  }
  const current = readModelOutcomeEvidenceSnapshot(db, expected.projectId);
  if (current.sha256 !== expected.sha256 || current.receiptCount !== expected.receiptCount ||
      current.operationCount !== expected.operationCount) {
    throw new Error("Stale model outcome snapshot: source receipts or project links changed.");
  }
  return current;
}
