/**
 * Durable native session recovery — G5.
 *
 * Persists native session metadata as validated JSON receipts in existing
 * Case turns (seat "workstation-session", kind "receipt").
 *
 * Reuses main/book/cases.ts and DatabaseSync without schema migrations,
 * side channel transcripts, or competing databases.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  WorkstationPermission,
  WorkstationProviderId,
  WorkstationSnapshot,
  WorkstationStatus
} from "@cadrane/contracts";
import { appendTurn, openCases, readCase } from "../book/cases.js";

export interface WorkstationSessionReceipt {
  readonly version: 1;
  readonly event: "start" | "checkpoint" | "finish" | "interrupted";
  readonly snapshot: WorkstationSnapshot;
  readonly workspacePath: string;
}

export type {
  WorkstationPermission,
  WorkstationProviderId,
  WorkstationSnapshot,
  WorkstationStatus
};

export const WORKSTATION_SESSION_SEAT = "workstation-session";

export const MAX_RECEIPT_TEXT_LENGTH = 100_000;
export const MAX_RECEIPT_ACTIVITY_ITEMS = 100;
export const MAX_RECEIPT_ACTIVITY_ITEM_LENGTH = 1_000;
export const MAX_RECEIPT_DETAIL_LENGTH = 5_000;
export const MAX_WORKSPACE_PATH_LENGTH = 4_096;

export const WORKSTATION_PROVIDER_IDS: readonly WorkstationProviderId[] = [
  "codex",
  "claude",
  "gemini1",
  "gemini2",
  "gemini3"
] as const;

export const VALID_RECEIPT_EVENTS = new Set<string>([
  "start",
  "checkpoint",
  "finish",
  "interrupted"
]);

export const VALID_PROVIDER_IDS = new Set<string>(WORKSTATION_PROVIDER_IDS);

export const VALID_STATUSES = new Set<string>([
  "starting",
  "running",
  "needs-approval",
  "stopping",
  "completed",
  "stopped",
  "failed",
  "interrupted"
]);

export function isActiveStatus(status: WorkstationStatus): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "needs-approval" ||
    status === "stopping"
  );
}

export function validateReceipt(input: unknown): WorkstationSessionReceipt | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;

  if (record["version"] !== 1) {
    return null;
  }

  const eventRaw = record["event"];
  if (typeof eventRaw !== "string" || !VALID_RECEIPT_EVENTS.has(eventRaw)) {
    return null;
  }
  const event = eventRaw as WorkstationSessionReceipt["event"];

  const workspacePathRaw = record["workspacePath"];
  if (typeof workspacePathRaw !== "string" || workspacePathRaw.trim().length === 0) {
    return null;
  }

  const snapRaw = record["snapshot"];
  if (typeof snapRaw !== "object" || snapRaw === null || Array.isArray(snapRaw)) {
    return null;
  }

  const snap = snapRaw as Record<string, unknown>;

  const operationId = snap["operationId"];
  if (typeof operationId !== "string" || operationId.trim().length === 0) {
    return null;
  }

  const caseId = snap["caseId"];
  if (typeof caseId !== "string" || caseId.trim().length === 0) {
    return null;
  }

  const providerIdRaw = snap["providerId"];
  if (typeof providerIdRaw !== "string" || !VALID_PROVIDER_IDS.has(providerIdRaw)) {
    return null;
  }
  const providerId = providerIdRaw as WorkstationProviderId;

  const modelIdRaw = snap["modelId"];
  if (modelIdRaw !== null && typeof modelIdRaw !== "string") {
    return null;
  }
  const modelId = modelIdRaw as string | null;

  const reportedModelId = snap["reportedModelId"];
  if (reportedModelId !== undefined && (typeof reportedModelId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(reportedModelId))) return null;

  const sessionIdRaw = snap["sessionId"];
  if (sessionIdRaw !== null && typeof sessionIdRaw !== "string") {
    return null;
  }
  const sessionId = sessionIdRaw as string | null;

  const statusRaw = snap["status"];
  if (typeof statusRaw !== "string" || !VALID_STATUSES.has(statusRaw)) {
    return null;
  }
  const status = statusRaw as WorkstationStatus;

  const startedAt = snap["startedAt"];
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return null;
  }

  const updatedAt = snap["updatedAt"];
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return null;
  }

  const text = snap["text"];
  if (typeof text !== "string") {
    return null;
  }

  const activityRaw = snap["activity"];
  if (!Array.isArray(activityRaw)) {
    return null;
  }
  const activity: string[] = [];
  for (const item of activityRaw) {
    if (typeof item !== "string") {
      return null;
    }
    activity.push(item);
  }

  let permission: WorkstationPermission | null = null;
  const permissionRaw = snap["permission"];
  if (permissionRaw !== null) {
    if (
      typeof permissionRaw !== "object" ||
      permissionRaw === null ||
      Array.isArray(permissionRaw)
    ) {
      return null;
    }
    const perm = permissionRaw as Record<string, unknown>;
    if (
      typeof perm["id"] !== "string" ||
      typeof perm["title"] !== "string" ||
      typeof perm["detail"] !== "string"
    ) {
      return null;
    }
    permission = {
      id: perm["id"],
      title: perm["title"],
      detail: perm["detail"]
    };
  }

  const detail = snap["detail"];
  if (typeof detail !== "string") {
    return null;
  }

  return {
    version: 1,
    event,
    workspacePath: workspacePathRaw,
    snapshot: {
      operationId,
      caseId,
      providerId,
      modelId,
      ...(typeof reportedModelId === "string" ? { reportedModelId } : {}),
      sessionId,
      status,
      startedAt,
      updatedAt,
      text,
      activity,
      permission,
      detail
    }
  };
}

function boundReceipt(receipt: WorkstationSessionReceipt): WorkstationSessionReceipt {
  const snap = receipt.snapshot;
  const boundedText =
    snap.text.length > MAX_RECEIPT_TEXT_LENGTH
      ? snap.text.slice(0, MAX_RECEIPT_TEXT_LENGTH)
      : snap.text;

  const boundedActivity = snap.activity
    .slice(-MAX_RECEIPT_ACTIVITY_ITEMS)
    .map((item) =>
      item.length > MAX_RECEIPT_ACTIVITY_ITEM_LENGTH
        ? item.slice(0, MAX_RECEIPT_ACTIVITY_ITEM_LENGTH)
        : item
    );

  const boundedDetail =
    snap.detail.length > MAX_RECEIPT_DETAIL_LENGTH
      ? snap.detail.slice(0, MAX_RECEIPT_DETAIL_LENGTH)
      : snap.detail;

  const boundedPermission = snap.permission
    ? {
        id: snap.permission.id.slice(0, 256),
        title: snap.permission.title.slice(0, 512),
        detail: snap.permission.detail.slice(0, 2048)
      }
    : null;

  return {
    version: 1,
    event: receipt.event,
    workspacePath: receipt.workspacePath.slice(0, MAX_WORKSPACE_PATH_LENGTH),
    snapshot: {
      operationId: snap.operationId,
      caseId: snap.caseId,
      providerId: snap.providerId,
      modelId: snap.modelId,
      ...(snap.reportedModelId ? { reportedModelId: snap.reportedModelId } : {}),
      sessionId: snap.sessionId,
      status: snap.status,
      startedAt: snap.startedAt,
      updatedAt: snap.updatedAt,
      text: boundedText,
      activity: boundedActivity,
      permission: boundedPermission,
      detail: boundedDetail
    }
  };
}

/**
 * Persists a workstation session metadata receipt into the given case's room turns.
 *
 * Writes to seat 'workstation-session' with kind 'receipt'. Rejects writes to
 * erased or closed cases, and rejects mismatched case IDs.
 */
export function saveSessionReceipt(
  db: DatabaseSync,
  caseId: string,
  receipt: WorkstationSessionReceipt
): void {
  if (!caseId || typeof caseId !== "string" || caseId.trim().length === 0) {
    throw new Error("Cannot save session receipt: caseId must be a non-empty string.");
  }

  const validated = validateReceipt(receipt);
  if (validated === null) {
    throw new Error("Cannot save session receipt: malformed receipt shape.");
  }

  if (validated.snapshot.caseId !== caseId) {
    throw new Error(
      `Inconsistent case ID: receipt snapshot caseId '${validated.snapshot.caseId}' does not match target caseId '${caseId}'.`
    );
  }

  const caseRow = readCase(db, caseId);
  if (caseRow === null) {
    throw new Error(`Cannot save session receipt: case '${caseId}' does not exist.`);
  }
  if (caseRow.closedAt !== null) {
    throw new Error(`Cannot save session receipt: case '${caseId}' is closed.`);
  }

  const bounded = boundReceipt(validated);

  appendTurn(
    db,
    caseId,
    {
      seat: WORKSTATION_SESSION_SEAT,
      kind: "receipt",
      body: JSON.stringify(bounded)
    },
    bounded.snapshot.updatedAt > 0 ? bounded.snapshot.updatedAt : Date.now()
  );
}

/**
 * Reads the latest valid workstation session receipt for the case, optionally scoped
 * to a single native provider.
 *
 * Evaluates receipts in reverse chronological order. Malformed or corrupt records
 * are safely skipped.
 */
export function latestSessionReceipt(
  db: DatabaseSync,
  caseId: string,
  providerId?: WorkstationProviderId
): WorkstationSessionReceipt | null {
  if (!caseId || typeof caseId !== "string" || caseId.trim().length === 0) {
    return null;
  }

  const rows = db
    .prepare(
      `SELECT body FROM case_turn
       WHERE case_id = ? AND seat = ? AND kind = 'receipt'
       ORDER BY seq DESC`
    )
    .all(caseId, WORKSTATION_SESSION_SEAT) as readonly Record<string, unknown>[];

  for (const row of rows) {
    const bodyRaw = row["body"];
    if (typeof bodyRaw !== "string") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyRaw);
    } catch {
      // Corrupt JSON string: safely ignore
      continue;
    }

    const receipt = validateReceipt(parsed);
    if (receipt === null) {
      // Malformed receipt schema: safely ignore
      continue;
    }

    if (providerId !== undefined) {
      if (receipt.snapshot.providerId === providerId) {
        return receipt;
      }
    } else {
      return receipt;
    }
  }

  return null;
}

/**
 * Scans all open cases on host startup/recovery and transitions any previously
 * active native operations ("starting" | "running" | "needs-approval" | "stopping")
 * to "interrupted".
 *
 * Idempotent: subsequent recovery calls write zero turns. Preserves native sessionId
 * for explicit user-directed resume.
 */
export function recoverInterruptedSessions(
  db: DatabaseSync,
  at: number = Date.now()
): number {
  const cases = openCases(db);
  let interruptedCount = 0;

  for (const c of cases) {
    for (const providerId of WORKSTATION_PROVIDER_IDS) {
      const receipt = latestSessionReceipt(db, c.id, providerId);
      if (receipt !== null && isActiveStatus(receipt.snapshot.status)) {
        const interruptedReceipt: WorkstationSessionReceipt = {
          version: 1,
          event: "interrupted",
          workspacePath: receipt.workspacePath,
          snapshot: {
            operationId: receipt.snapshot.operationId,
            caseId: receipt.snapshot.caseId,
            providerId: receipt.snapshot.providerId,
            modelId: receipt.snapshot.modelId,
            sessionId: receipt.snapshot.sessionId,
            status: "interrupted",
            startedAt: receipt.snapshot.startedAt,
            updatedAt: at,
            text: receipt.snapshot.text,
            activity: [
              ...receipt.snapshot.activity,
              "Session marked interrupted by host recovery"
            ],
            permission: null,
            detail: receipt.snapshot.detail
              ? `${receipt.snapshot.detail} (Interrupted by host recovery)`
              : "Session marked interrupted by host recovery"
          }
        };
        saveSessionReceipt(db, c.id, interruptedReceipt);
        interruptedCount += 1;
      }
    }
  }

  return interruptedCount;
}
