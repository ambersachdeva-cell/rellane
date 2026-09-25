import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_RECEIPTS,
  projectModelOutcomeEvidence,
  type ModelOutcomeEvidence
} from "./model-outcome-evidence.js";
import type {
  WorkstationPermission,
  WorkstationProviderId,
  WorkstationSessionReceipt,
  WorkstationSnapshot,
  WorkstationStatus
} from "./store.js";

function makeReceipt(params: {
  operationId: string;
  caseId?: string;
  projectId?: string | null;
  providerId?: WorkstationProviderId;
  event?: "start" | "checkpoint" | "finish" | "interrupted";
  status?: WorkstationStatus;
  modelId?: string | null;
  reportedModelId?: string;
  startedAt?: number;
  updatedAt?: number;
  detail?: string;
  text?: string;
  permission?: WorkstationPermission | null;
}): WorkstationSessionReceipt {
  return {
    version: 1,
    event: params.event ?? "finish",
    workspacePath: "/test/workspace",
    projectId: params.projectId !== undefined ? params.projectId : "proj-alpha",
    snapshot: {
      operationId: params.operationId,
      caseId: params.caseId ?? "case-1",
      providerId: params.providerId ?? "codex",
      modelId: params.modelId !== undefined ? params.modelId : "model-requested",
      ...(params.reportedModelId !== undefined
        ? { reportedModelId: params.reportedModelId }
        : {}),
      sessionId: "session-1",
      status: params.status ?? "completed",
      startedAt: params.startedAt ?? 1_000,
      updatedAt: params.updatedAt ?? 2_000,
      text: params.text ?? "telemetry text",
      activity: ["activity step"],
      permission: params.permission !== undefined ? params.permission : null,
      detail: params.detail ?? "telemetry detail"
    }
  };
}

describe("model-outcome-evidence", () => {
  it("groups duplicate events into a single operation outcome", () => {
    const r1 = makeReceipt({
      operationId: "op-dup",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const r2 = makeReceipt({
      operationId: "op-dup",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const r3 = makeReceipt({
      operationId: "op-dup",
      event: "finish",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_500
    });
    const r4 = makeReceipt({
      operationId: "op-dup",
      event: "finish",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_500
    });

    const results = projectModelOutcomeEvidence([r1, r2, r3, r4]);

    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }
    expect(item.operationId).toBe("op-dup");
    expect(item.attemptState).toBe("attempted");
    expect(item.terminalState).toBe("completed");
    expect(item.observedCompleted).toBe(true);
    expect(item.durationMs).toBe(1_500);
    expect(item.reasons).toEqual([]);
  });

  it("transparently preserves requested versus native-reported model drift", () => {
    const receipt = makeReceipt({
      operationId: "op-drift",
      modelId: "gemini-1.5-pro",
      reportedModelId: "gemini-1.5-pro-002",
      status: "completed",
      startedAt: 100,
      updatedAt: 400
    });

    const results = projectModelOutcomeEvidence([receipt]);

    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }
    expect(item.requestedModelId).toBe("gemini-1.5-pro");
    expect(item.reportedModelId).toBe("gemini-1.5-pro-002");
    expect(item.requestedModelId).not.toBe(item.reportedModelId);
    expect(item.attemptState).toBe("attempted");
  });

  it("handles absent native-reported model without fabricating values", () => {
    const receipt = makeReceipt({
      operationId: "op-no-reported",
      modelId: "claude-3-5-sonnet",
      status: "completed"
    });

    const results = projectModelOutcomeEvidence([receipt]);

    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }
    expect(item.requestedModelId).toBe("claude-3-5-sonnet");
    expect(item.reportedModelId).toBeNull();
  });

  it("classifies failed, interrupted, stopped, and unknown states without completion", () => {
    const failedReceipt = makeReceipt({
      operationId: "op-failed",
      status: "failed",
      detail: "Process crashed"
    });
    const failedDetailReceipt = makeReceipt({
      operationId: "op-failed-detail",
      status: "failed",
      detail: "Permission denied by host policy"
    });
    const interruptedReceipt = makeReceipt({
      operationId: "op-interrupted",
      event: "interrupted",
      status: "interrupted"
    });
    const stoppedReceipt = makeReceipt({
      operationId: "op-stopped",
      status: "stopped"
    });
    const startAloneReceipt = makeReceipt({
      operationId: "op-start-alone",
      event: "start",
      status: "starting"
    });
    const checkpointAloneReceipt = makeReceipt({
      operationId: "op-check-alone",
      event: "checkpoint",
      status: "running"
    });

    const results = projectModelOutcomeEvidence([
      failedReceipt,
      failedDetailReceipt,
      interruptedReceipt,
      stoppedReceipt,
      startAloneReceipt,
      checkpointAloneReceipt
    ]);

    const byId = new Map(results.map((r) => [r.operationId, r]));

    expect(byId.get("op-failed")?.terminalState).toBe("failed");
    expect(byId.get("op-failed")?.observedCompleted).toBe(false);
    expect(byId.get("op-failed")?.attemptState).toBe("unknown");

    expect(byId.get("op-failed-detail")?.terminalState).toBe("failed");
    expect(byId.get("op-failed-detail")?.terminalState).not.toBe("denied");
    expect(byId.get("op-failed-detail")?.observedCompleted).toBe(false);
    expect(byId.get("op-failed-detail")?.attemptState).toBe("unknown");

    expect(byId.get("op-interrupted")?.terminalState).toBe("interrupted");
    expect(byId.get("op-interrupted")?.observedCompleted).toBe(false);
    expect(byId.get("op-interrupted")?.attemptState).toBe("unknown");

    expect(byId.get("op-stopped")?.terminalState).toBe("stopped");
    expect(byId.get("op-stopped")?.observedCompleted).toBe(false);
    expect(byId.get("op-stopped")?.attemptState).toBe("unknown");

    expect(byId.get("op-start-alone")?.terminalState).toBe("unknown");
    expect(byId.get("op-start-alone")?.observedCompleted).toBe(false);
    expect(byId.get("op-start-alone")?.attemptState).toBe("admitted");
    expect(byId.get("op-start-alone")?.durationMs).toBeNull();

    expect(byId.get("op-check-alone")?.terminalState).toBe("unknown");
    expect(byId.get("op-check-alone")?.observedCompleted).toBe(false);
    expect(byId.get("op-check-alone")?.attemptState).toBe("attempted");
    expect(byId.get("op-check-alone")?.durationMs).toBeNull();
  });

  it("yields unknown when contradictory terminal receipts are observed", () => {
    const finishCompleted = makeReceipt({
      operationId: "op-conflict",
      event: "finish",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_000
    });
    const finishFailed = makeReceipt({
      operationId: "op-conflict",
      event: "finish",
      status: "failed",
      startedAt: 1_000,
      updatedAt: 2_100
    });

    const results = projectModelOutcomeEvidence([finishCompleted, finishFailed]);

    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }
    expect(item.terminalState).toBe("unknown");
    expect(item.observedCompleted).toBe(false);
    expect(item.attemptState).toBe("unknown");
    expect(item.durationMs).toBeNull();
    expect(
      item.reasons.some((reason) =>
        reason.includes("Contradictory terminal states")
      )
    ).toBe(true);
  });

  it("rejects negative timing and non-positive timestamps from measured duration", () => {
    const negativeTimeReceipt = makeReceipt({
      operationId: "op-neg",
      startedAt: 5_000,
      updatedAt: 2_000,
      status: "completed"
    });
    const nonPositiveReceipt = makeReceipt({
      operationId: "op-zero",
      startedAt: 0,
      updatedAt: 2_000,
      status: "completed"
    });
    const credibleReceipt = makeReceipt({
      operationId: "op-credible",
      startedAt: 1_000,
      updatedAt: 4_200,
      status: "completed"
    });

    const results = projectModelOutcomeEvidence([
      negativeTimeReceipt,
      nonPositiveReceipt,
      credibleReceipt
    ]);

    const byId = new Map(results.map((r) => [r.operationId, r]));

    expect(byId.get("op-neg")?.durationMs).toBeNull();
    expect(
      byId.get("op-neg")?.reasons.some((reason) => reason.includes("Negative duration"))
    ).toBe(true);

    expect(byId.get("op-zero")?.durationMs).toBeNull();
    expect(
      byId.get("op-zero")?.reasons.some((reason) => reason.includes("non-positive"))
    ).toBe(true);

    expect(byId.get("op-credible")?.durationMs).toBe(3_200);
  });

  it("enforces strict cross-project and cross-case isolation", () => {
    const projA = makeReceipt({
      operationId: "op-a",
      caseId: "case-1",
      projectId: "proj-a"
    });
    const projB = makeReceipt({
      operationId: "op-b",
      caseId: "case-2",
      projectId: "proj-b"
    });
    const projNull = makeReceipt({
      operationId: "op-null",
      caseId: "case-3",
      projectId: null
    });

    const all = projectModelOutcomeEvidence([projA, projB, projNull]);
    expect(all).toHaveLength(3);

    const filteredA = projectModelOutcomeEvidence([projA, projB, projNull], {
      projectId: "proj-a"
    });
    expect(filteredA).toHaveLength(1);
    const itemA = filteredA[0];
    if (!itemA) {
      throw new Error("Expected itemA");
    }
    expect(itemA.operationId).toBe("op-a");
    expect(itemA.projectId).toBe("proj-a");

    const filteredNull = projectModelOutcomeEvidence([projA, projB, projNull], {
      projectId: null
    });
    expect(filteredNull).toHaveLength(1);
    const itemNull = filteredNull[0];
    if (!itemNull) {
      throw new Error("Expected itemNull");
    }
    expect(itemNull.operationId).toBe("op-null");
    expect(itemNull.projectId).toBeNull();

    const filteredCase2 = projectModelOutcomeEvidence([projA, projB, projNull], {
      caseId: "case-2"
    });
    expect(filteredCase2).toHaveLength(1);
    const itemCase2 = filteredCase2[0];
    if (!itemCase2) {
      throw new Error("Expected itemCase2");
    }
    expect(itemCase2.operationId).toBe("op-b");
  });

  it("does not infer quality, readiness, quota, cost, ranking, or routing recommendations", () => {
    const receipt = makeReceipt({
      operationId: "op-quality-check",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_000
    });

    const results = projectModelOutcomeEvidence([receipt]);
    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }

    const record = item as unknown as Record<string, unknown>;

    expect(record["observedCompleted"]).toBe(true);
    expect(record["quality"]).toBeUndefined();
    expect(record["score"]).toBeUndefined();
    expect(record["ranking"]).toBeUndefined();
    expect(record["readiness"]).toBeUndefined();
    expect(record["quota"]).toBeUndefined();
    expect(record["cost"]).toBeUndefined();
    expect(record["routing"]).toBeUndefined();
    expect(record["recommendation"]).toBeUndefined();
    expect(record["success"]).toBeUndefined();
  });

  it("guarantees bounded input and deterministic ordering", () => {
    const receipts: WorkstationSessionReceipt[] = [];
    for (let i = 0; i < 20; i += 1) {
      receipts.push(
        makeReceipt({
          operationId: `op-${String(i).padStart(2, "0")}`,
          caseId: i % 2 === 0 ? "case-b" : "case-a",
          projectId: "proj-fixed"
        })
      );
    }

    const capped = projectModelOutcomeEvidence(receipts, { maxReceipts: 5 });
    expect(capped.length).toBeLessThanOrEqual(5);

    const rA = makeReceipt({ operationId: "op-z", caseId: "case-2" });
    const rB = makeReceipt({ operationId: "op-a", caseId: "case-2" });
    const rC = makeReceipt({ operationId: "op-m", caseId: "case-1" });

    const ordered = projectModelOutcomeEvidence([rA, rB, rC]);
    expect(ordered.map((o) => `${o.caseId}/${o.operationId}`)).toEqual([
      "case-1/op-m",
      "case-2/op-a",
      "case-2/op-z"
    ]);
  });

  it("treats terminal status on start or checkpoint receipt as non-terminal", () => {
    const startCompleted = makeReceipt({
      operationId: "op-start-completed",
      event: "start",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_000
    });
    const checkpointCompleted = makeReceipt({
      operationId: "op-check-completed",
      event: "checkpoint",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_000
    });
    const checkpointFailed = makeReceipt({
      operationId: "op-check-failed",
      event: "checkpoint",
      status: "failed",
      startedAt: 1_000,
      updatedAt: 2_000
    });

    const results = projectModelOutcomeEvidence([
      startCompleted,
      checkpointCompleted,
      checkpointFailed
    ]);

    const byId = new Map(results.map((r) => [r.operationId, r]));

    const sc = byId.get("op-start-completed");
    expect(sc?.terminalState).toBe("unknown");
    expect(sc?.observedCompleted).toBe(false);
    expect(sc?.durationMs).toBeNull();
    expect(sc?.attemptState).toBe("admitted");

    const cc = byId.get("op-check-completed");
    expect(cc?.terminalState).toBe("unknown");
    expect(cc?.observedCompleted).toBe(false);
    expect(cc?.durationMs).toBeNull();
    expect(cc?.attemptState).toBe("unknown");

    const cf = byId.get("op-check-failed");
    expect(cf?.terminalState).toBe("unknown");
    expect(cf?.observedCompleted).toBe(false);
    expect(cf?.durationMs).toBeNull();
    expect(cf?.attemptState).toBe("unknown");
  });

  it("preserves contradictory provider and project identifiers as unknown attempt and terminal state", () => {
    const rCodex = makeReceipt({
      operationId: "op-provider-clash",
      providerId: "codex",
      event: "start",
      status: "starting"
    });
    const rClaude = makeReceipt({
      operationId: "op-provider-clash",
      providerId: "claude",
      event: "finish",
      status: "completed"
    });

    const results = projectModelOutcomeEvidence([rCodex, rClaude]);
    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected item");
    }
    expect(item.attemptState).toBe("unknown");
    expect(item.terminalState).toBe("unknown");
    expect(item.observedCompleted).toBe(false);
    expect(item.durationMs).toBeNull();
    expect(
      item.reasons.some((reason) =>
        reason.includes("Contradictory provider identifiers")
      )
    ).toBe(true);
  });

  it("does not convert failed or unknown operation to denied based on arbitrary detail text", () => {
    const failedWithDeniedText = makeReceipt({
      operationId: "op-detail-denied",
      event: "finish",
      status: "failed",
      detail: "User denied permission when prompted"
    });
    const failedWithDeclinedText = makeReceipt({
      operationId: "op-detail-declined",
      event: "finish",
      status: "failed",
      detail: "permission request declined by policy"
    });

    const results = projectModelOutcomeEvidence([
      failedWithDeniedText,
      failedWithDeclinedText
    ]);

    const byId = new Map(results.map((r) => [r.operationId, r]));

    const itemDenied = byId.get("op-detail-denied");
    expect(itemDenied?.terminalState).toBe("failed");
    expect(itemDenied?.terminalState).not.toBe("denied");

    const itemDeclined = byId.get("op-detail-declined");
    expect(itemDeclined?.terminalState).toBe("failed");
    expect(itemDeclined?.terminalState).not.toBe("denied");
  });

  it("truthfully distinguishes local start receipt from native provider attempt", () => {
    const localStartOnly = makeReceipt({
      operationId: "op-local-only",
      event: "start",
      status: "starting"
    });
    const nativeAttempted = makeReceipt({
      operationId: "op-native-attempted",
      event: "start",
      status: "starting",
      reportedModelId: "gemini-2.0-flash"
    });

    const results = projectModelOutcomeEvidence([localStartOnly, nativeAttempted]);
    const byId = new Map(results.map((r) => [r.operationId, r]));

    expect(byId.get("op-local-only")?.attemptState).toBe("admitted");
    expect(byId.get("op-native-attempted")?.attemptState).toBe("attempted");
  });

  it("classifies start followed by failure, stop, or interruption before worker.run as admitted", () => {
    const startPreFail = makeReceipt({
      operationId: "op-pre-fail",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const finishPreFail = makeReceipt({
      operationId: "op-pre-fail",
      event: "finish",
      status: "failed",
      startedAt: 1_000,
      updatedAt: 1_200,
      detail: "Could not cover this workspace with a saved preimage. Nothing was sent."
    });

    const startPreStop = makeReceipt({
      operationId: "op-pre-stop",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const finishPreStop = makeReceipt({
      operationId: "op-pre-stop",
      event: "finish",
      status: "stopped",
      startedAt: 1_000,
      updatedAt: 1_150,
      detail: "Stopped before the provider was asked."
    });

    const startPreInterrupt = makeReceipt({
      operationId: "op-pre-interrupt",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const interruptPreReceipt = makeReceipt({
      operationId: "op-pre-interrupt",
      event: "interrupted",
      status: "interrupted",
      startedAt: 1_000,
      updatedAt: 1_100,
      detail: "Session marked interrupted by host recovery"
    });

    const results = projectModelOutcomeEvidence([
      startPreFail,
      finishPreFail,
      startPreStop,
      finishPreStop,
      startPreInterrupt,
      interruptPreReceipt
    ]);

    const byId = new Map(results.map((r) => [r.operationId, r]));

    const preFail = byId.get("op-pre-fail");
    expect(preFail?.attemptState).toBe("admitted");
    expect(preFail?.terminalState).toBe("failed");
    expect(preFail?.observedCompleted).toBe(false);
    expect(preFail?.durationMs).toBe(200);

    const preStop = byId.get("op-pre-stop");
    expect(preStop?.attemptState).toBe("admitted");
    expect(preStop?.terminalState).toBe("stopped");
    expect(preStop?.observedCompleted).toBe(false);
    expect(preStop?.durationMs).toBe(150);

    const preInterrupt = byId.get("op-pre-interrupt");
    expect(preInterrupt?.attemptState).toBe("admitted");
    expect(preInterrupt?.terminalState).toBe("interrupted");
    expect(preInterrupt?.observedCompleted).toBe(false);
    expect(preInterrupt?.durationMs).toBe(100);
  });

  it("classifies completed operation as observed native attempt", () => {
    const start = makeReceipt({
      operationId: "op-completed-native",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const finish = makeReceipt({
      operationId: "op-completed-native",
      event: "finish",
      status: "completed",
      startedAt: 1_000,
      updatedAt: 2_200
    });

    const results = projectModelOutcomeEvidence([start, finish]);
    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }
    expect(item.attemptState).toBe("attempted");
    expect(item.terminalState).toBe("completed");
    expect(item.observedCompleted).toBe(true);
    expect(item.durationMs).toBe(1_200);
  });

  it("classifies checkpoint following worker event as native attempt", () => {
    const start = makeReceipt({
      operationId: "op-worker-event-checkpoint",
      event: "start",
      status: "starting",
      startedAt: 1_000,
      updatedAt: 1_000
    });
    const checkpoint = makeReceipt({
      operationId: "op-worker-event-checkpoint",
      event: "checkpoint",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_400
    });
    const finishFailed = makeReceipt({
      operationId: "op-worker-event-checkpoint",
      event: "finish",
      status: "failed",
      startedAt: 1_000,
      updatedAt: 1_800,
      detail: "Process crashed while running"
    });

    const results = projectModelOutcomeEvidence([start, checkpoint, finishFailed]);
    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected result item");
    }
    expect(item.attemptState).toBe("attempted");
    expect(item.terminalState).toBe("failed");
    expect(item.observedCompleted).toBe(false);
    expect(item.durationMs).toBe(800);
  });

  it("classifies contradictory requested models as unknown attempt and terminal state", () => {
    const r1 = makeReceipt({
      operationId: "op-model-clash",
      modelId: "gpt-4o",
      event: "start",
      status: "starting"
    });
    const r2 = makeReceipt({
      operationId: "op-model-clash",
      modelId: "claude-3-opus",
      event: "finish",
      status: "completed"
    });

    const results = projectModelOutcomeEvidence([r1, r2]);
    expect(results).toHaveLength(1);
    const item = results[0];
    if (!item) {
      throw new Error("Expected item");
    }
    expect(item.attemptState).toBe("unknown");
    expect(item.terminalState).toBe("unknown");
    expect(item.observedCompleted).toBe(false);
    expect(item.durationMs).toBeNull();
    expect(
      item.reasons.some((reason) =>
        reason.includes("Contradictory requested models")
      )
    ).toBe(true);
  });
});
