/**
 * SM05 bounded measured evidence projection.
 *
 * Pure read-only projection over validated WorkstationSessionReceipt records.
 * Groups each exact operation once with case/project, provider, requested model,
 * native-reported model, attempted/terminal state, and credible measured duration.
 *
 * Invariants:
 * - Pure read-only: does not persist, mutate, or alter receipts.
 * - Start or checkpoint receipts alone yield unknown, never completed.
 * - Contradictory terminal receipts yield unknown, never completed.
 * - Stopped, failed, interrupted, denied, and unknown never count as completed.
 * - Completed state represents solely observed completion; it makes no claim
 *   regarding quality, correctness, owner preference, quota, ranking, or routing.
 * - Negative or non-credible timestamps yield no measured duration.
 * - Input receipts are bounded and output order is deterministic.
 */

import type {
  WorkstationProviderId,
  WorkstationSessionReceipt,
  WorkstationSnapshot,
  WorkstationStatus
} from "./store.js";

export const DEFAULT_MAX_RECEIPTS = 5_000;

export type ModelOperationAttemptState =
  | "admitted"
  | "attempted"
  | "unknown";

export type ModelOperationTerminalState =
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted"
  | "denied"
  | "unknown";

export interface ModelOutcomeEvidence {
  readonly operationId: string;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly providerId: WorkstationProviderId;
  readonly requestedModelId: string | null;
  readonly reportedModelId: string | null;
  readonly attemptState: ModelOperationAttemptState;
  readonly terminalState: ModelOperationTerminalState;
  readonly observedCompleted: boolean;
  readonly durationMs: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly reasons: readonly string[];
}

export interface ModelOutcomeEvidenceOptions {
  readonly projectId?: string | null;
  readonly caseId?: string;
  readonly maxReceipts?: number;
}

function isTerminalStatus(status: WorkstationStatus): boolean {
  return (
    status === "completed" ||
    status === "stopped" ||
    status === "failed" ||
    status === "interrupted"
  );
}

function isTerminalEvent(event: WorkstationSessionReceipt["event"]): boolean {
  return event === "finish" || event === "interrupted";
}

function isTerminalReceipt(receipt: WorkstationSessionReceipt): boolean {
  if (receipt.event === "start" || receipt.event === "checkpoint") {
    return false;
  }
  return isTerminalEvent(receipt.event) || isTerminalStatus(receipt.snapshot.status);
}

function hasNativeAttemptEvidence(receipt: WorkstationSessionReceipt): boolean {
  const status = receipt.snapshot.status;
  if (status === "running" || status === "needs-approval" || status === "stopping") {
    return true;
  }
  const reportedModelId = receipt.snapshot.reportedModelId;
  if (typeof reportedModelId === "string" && reportedModelId.trim().length > 0) {
    return true;
  }
  if (isTerminalReceipt(receipt) && status === "completed") {
    return true;
  }
  return false;
}

function resolveReceiptTerminalState(
  receipt: WorkstationSessionReceipt
): ModelOperationTerminalState {
  const snap = receipt.snapshot;
  if (snap.status === "completed") {
    return "completed";
  }
  if (snap.status === "stopped") {
    return "stopped";
  }
  if (snap.status === "failed") {
    return "failed";
  }
  if (snap.status === "interrupted" || receipt.event === "interrupted") {
    return "interrupted";
  }
  return "unknown";
}

function aggregateOperationEvidence(
  operationId: string,
  receipts: readonly WorkstationSessionReceipt[]
): ModelOutcomeEvidence {
  const reasons: string[] = [];
  let isContradictory = false;

  const first = receipts[0];
  if (!first) {
    return {
      operationId,
      caseId: "",
      projectId: null,
      providerId: "codex",
      requestedModelId: null,
      reportedModelId: null,
      attemptState: "unknown",
      terminalState: "unknown",
      observedCompleted: false,
      durationMs: null,
      startedAt: null,
      endedAt: null,
      reasons: ["No receipts available for operation"]
    };
  }

  const caseId = first.snapshot.caseId;
  const projectId = first.projectId ?? null;
  const providerId = first.snapshot.providerId;

  for (let i = 1; i < receipts.length; i += 1) {
    const r = receipts[i];
    if (!r) {
      continue;
    }
    if (r.snapshot.caseId !== caseId) {
      reasons.push("Contradictory case identifiers across receipts");
      isContradictory = true;
    }
    if ((r.projectId ?? null) !== projectId) {
      reasons.push("Contradictory project identifiers across receipts");
      isContradictory = true;
    }
    if (r.snapshot.providerId !== providerId) {
      reasons.push("Contradictory provider identifiers across receipts");
      isContradictory = true;
    }
  }

  const requestedModels = new Set<string>();
  for (const r of receipts) {
    const m = r.snapshot.modelId;
    if (typeof m === "string" && m.trim().length > 0) {
      requestedModels.add(m.trim());
    }
  }
  let requestedModelId: string | null = null;
  if (requestedModels.size > 1) {
    reasons.push("Contradictory requested models across receipts");
    isContradictory = true;
  } else if (requestedModels.size === 1) {
    requestedModelId = requestedModels.values().next().value ?? null;
  }

  const reportedModels = new Set<string>();
  for (const r of receipts) {
    const rm = r.snapshot.reportedModelId;
    if (typeof rm === "string" && rm.trim().length > 0) {
      reportedModels.add(rm.trim());
    }
  }
  let reportedModelId: string | null = null;
  if (reportedModels.size > 1) {
    reasons.push("Contradictory reported models across receipts");
    isContradictory = true;
  } else if (reportedModels.size === 1) {
    reportedModelId = reportedModels.values().next().value ?? null;
  }

  const terminalReceipts = receipts.filter(isTerminalReceipt);

  let terminalState: ModelOperationTerminalState = "unknown";

  if (terminalReceipts.length === 0) {
    terminalState = "unknown";
    reasons.push("Start or checkpoint receipts alone without terminal receipt");
  } else {
    const observedStates = new Set<ModelOperationTerminalState>();
    for (const tr of terminalReceipts) {
      observedStates.add(resolveReceiptTerminalState(tr));
    }

    if (observedStates.size > 1) {
      terminalState = "unknown";
      reasons.push("Contradictory terminal states across terminal receipts");
      isContradictory = true;
    } else {
      const resolved = observedStates.values().next().value ?? "unknown";
      if (isContradictory) {
        terminalState = "unknown";
      } else {
        terminalState = resolved;
      }
    }
  }

  let hasProviderAttempt = false;
  let hasLocalAdmission = false;

  for (const r of receipts) {
    if (r.event === "start") {
      hasLocalAdmission = true;
    }
    if (hasNativeAttemptEvidence(r)) {
      hasProviderAttempt = true;
    }
  }

  let attemptState: ModelOperationAttemptState = "unknown";
  if (isContradictory) {
    attemptState = "unknown";
  } else if (hasProviderAttempt) {
    attemptState = "attempted";
  } else if (hasLocalAdmission) {
    attemptState = "admitted";
  } else {
    attemptState = "unknown";
  }

  const observedCompleted = terminalState === "completed";

  const validStarts = receipts
    .map((r) => r.snapshot.startedAt)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0);
  const startedAt = validStarts.length > 0 ? Math.min(...validStarts) : null;

  const validEnds = terminalReceipts
    .map((r) => r.snapshot.updatedAt)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0);
  const endedAt = validEnds.length > 0 ? Math.max(...validEnds) : null;

  let durationMs: number | null = null;
  if (terminalReceipts.length === 0) {
    reasons.push("Non-terminal operation lacks terminal duration");
  } else if (isContradictory) {
    reasons.push("Contradictory receipts invalidate measured duration");
  } else if (startedAt === null || endedAt === null) {
    reasons.push("Missing or non-positive timestamp; duration not credible");
  } else if (endedAt < startedAt) {
    reasons.push(
      `Negative duration detected (startedAt: ${startedAt}, endedAt: ${endedAt}); duration not credible`
    );
  } else {
    durationMs = endedAt - startedAt;
  }

  return {
    operationId,
    caseId,
    projectId,
    providerId,
    requestedModelId,
    reportedModelId,
    attemptState,
    terminalState,
    observedCompleted,
    durationMs,
    startedAt,
    endedAt,
    reasons
  };
}

export function projectModelOutcomeEvidence(
  receipts: Iterable<WorkstationSessionReceipt>,
  options?: ModelOutcomeEvidenceOptions
): readonly ModelOutcomeEvidence[] {
  const maxLimit =
    typeof options?.maxReceipts === "number" &&
    Number.isFinite(options.maxReceipts) &&
    options.maxReceipts > 0
      ? Math.min(options.maxReceipts, DEFAULT_MAX_RECEIPTS)
      : DEFAULT_MAX_RECEIPTS;

  const groups = new Map<string, WorkstationSessionReceipt[]>();
  let examinedCount = 0;

  for (const receipt of receipts) {
    if (examinedCount >= maxLimit) {
      break;
    }
    examinedCount += 1;

    if (options?.caseId !== undefined && receipt.snapshot.caseId !== options.caseId) {
      continue;
    }

    if (options?.projectId !== undefined) {
      const rProject = receipt.projectId ?? null;
      if (rProject !== options.projectId) {
        continue;
      }
    }

    const opId = receipt.snapshot.operationId;
    if (typeof opId !== "string" || opId.trim().length === 0) {
      continue;
    }

    const existing = groups.get(opId);
    if (existing) {
      existing.push(receipt);
    } else {
      groups.set(opId, [receipt]);
    }
  }

  const projected: ModelOutcomeEvidence[] = [];

  for (const [operationId, opReceipts] of groups) {
    projected.push(aggregateOperationEvidence(operationId, opReceipts));
  }

  projected.sort((a, b) => {
    const cCase = a.caseId.localeCompare(b.caseId);
    if (cCase !== 0) {
      return cCase;
    }
    const pA = a.projectId ?? "";
    const pB = b.projectId ?? "";
    const cProj = pA.localeCompare(pB);
    if (cProj !== 0) {
      return cProj;
    }
    return a.operationId.localeCompare(b.operationId);
  });

  return projected;
}
