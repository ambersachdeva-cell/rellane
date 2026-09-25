import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION,
  type AutomationHostReviewDescriptor
} from "@cadrane/contracts";
import { appendTurn, closeCase, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { recordDispatch, recordTerminal, saveIntent } from "./graph-host-correlation-store.js";
import {
  CaseSourceValidationError,
  CaseSourceValidationErrorCode
} from "./graph-host-source-validator.js";
import {
  composeGraphHostReviewPacket,
  GraphHostReviewPacketError,
  GraphHostReviewPacketErrorCode
} from "./graph-host-review-packet.js";

function setupTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const m of MIGRATIONS) db.exec(m.sql);
  return db;
}

const makeSha = (char = "a") => char.repeat(64);
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").toLowerCase();

function createVerifiedFinding(
  db: DatabaseSync,
  caseId: string,
  graphRunId: string,
  nodeId: string,
  attemptId: string,
  body: string
): string {
  const opId = randomUUID();
  saveIntent(db, {
    caseId, graphRunId, nodeId, attemptId,
    descriptorSha256: makeSha("d"), workflowSha256: makeSha("e"), agentSha256: makeSha("a"),
    sourceTurnIds: [randomUUID()], runtimeId: "cadrane-local-loopback", modelId: "local-model"
  });
  recordDispatch(db, { caseId, graphRunId, nodeId, attemptId, operationId: opId });
  const turnId = appendTurn(db, caseId, { seat: "graph-worker", kind: "finding", body });
  recordTerminal(db, {
    caseId, graphRunId, nodeId, attemptId, operationId: opId,
    outcome: "completed", answerTurnId: turnId, resultSha256: sha256Hex(body)
  });
  return turnId;
}

function buildDescriptor(
  caseId: string,
  sourceTurnIds: string[],
  overrides: Partial<AutomationHostReviewDescriptor> = {}
): AutomationHostReviewDescriptor {
  const runId = overrides.runId ?? randomUUID();
  const nodeId = overrides.nodeId ?? randomUUID();
  const attemptId = overrides.attemptId ?? randomUUID();
  const workflowId = overrides.workflowId ?? randomUUID();
  const depOutputs = overrides.dependencyOutputs ?? [];
  return {
    schemaVersion: AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION,
    runId, nodeId, attemptId, workflowId, workflowRevision: 1, workflowSha256: makeSha("1"),
    agentId: randomUUID(), agentRevision: 1, agentSha256: makeSha("2"),
    caseId, sourceTurnIds: [...sourceTurnIds],
    contextPolicy: {
      sourceTurnIds: [...sourceTurnIds], includeSystemPrompt: true, includeInstruction: true,
      includeDependencyOutputs: true, allowGlobalMemory: false, allowApprovedExamples: false
    },
    instruction: "Review the verified ledger balance.",
    systemPrompt: "You are a trusted host review assistant.",
    context: depOutputs.map((d) => `### ${d.title}\n${d.output}`).join("\n\n"),
    dependencyOutputs: [...depOutputs],
    runtimeId: "cadrane-local-loopback", modelId: "cadrane-default-v1",
    routingMode: "fixed", fallbackRoutes: [], temperature: 0.2, maxTokens: 2048,
    provenance: {
      workflowId, workflowRevision: 1, workflowName: "Close-Workflow",
      runId, runCreatedAt: new Date().toISOString(), triggerKind: "manual",
      nodeId, nodeTitle: "Balance Review", dependsOn: depOutputs.map((d) => d.nodeId),
      attempt: 1, attemptId
    },
    ...overrides
  };
}

describe("composeGraphHostReviewPacket", () => {
  it("successfully composes packet with valid owner source and dependency finding", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Audit", question: "Discrepancies" });
    const ownerTurnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Owner note" });
    const runId = randomUUID();
    const depNodeId = randomUUID();
    const depOutput = "Verified balance 42000";
    const findingTurnId = createVerifiedFinding(db, caseId, runId, depNodeId, randomUUID(), depOutput);

    const descriptor = buildDescriptor(caseId, [ownerTurnId, findingTurnId], {
      runId,
      dependencyOutputs: [{ nodeId: depNodeId, title: "Math", output: depOutput, outputSha256: sha256Hex(depOutput) }],
      temperature: 0.3, maxTokens: 1024
    });

    const opId = randomUUID();
    const result = composeGraphHostReviewPacket(db, descriptor, opId);
    expect(result.request.operationId).toBe(opId);
    expect(result.request.runtimeId).toBe("cadrane-local-loopback");
    expect(result.request.temperature).toBe(0.3);
    expect(result.request.maxTokens).toBe(1024);
    expect(result.request.messages).toHaveLength(2);
    expect(result.request.messages[0]!.content).toBe(descriptor.systemPrompt);

    const payload = JSON.parse(result.request.messages[1]!.content);
    expect(payload.graph.runId).toBe(runId);
    expect(payload.dependencyOutputs[0].output).toBe(depOutput);
    expect(payload.sources).toHaveLength(2);
    expect(payload.sources[1].turnId).toBe(findingTurnId);
    expect(payload.sources[1].provenance.nodeId).toBe(depNodeId);

    expect(result.descriptorSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceBindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.requestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview).toContain("=== Graph Host Review Packet Preview ===");
    expect(result.preview).toContain(caseId);
    expect(result.preview).toContain(descriptor.systemPrompt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.request)).toBe(true);
  });

  it("preserves exact order of mixed owner references and imported files", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Order", question: "Preserve" });
    const fId = appendTurn(db, caseId, { seat: `${CASE_SOURCE_SEAT_PREFIX}c.txt`, kind: "verbatim", body: "Text" });
    const oId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Note" });
    const result = composeGraphHostReviewPacket(db, buildDescriptor(caseId, [fId, oId]), randomUUID());
    const payload = JSON.parse(result.request.messages[1]!.content);
    expect(payload.sources[0].turnId).toBe(fId);
    expect(payload.sources[1].turnId).toBe(oId);
  });

  it("rejects non-existent, closed, and cross-case source turns", () => {
    const db = setupTestDb();
    const caseA = openCase(db, { title: "A", question: "QA" });
    const caseB = openCase(db, { title: "B", question: "QB" });
    const turnB = appendTurn(db, caseB, { seat: "owner", kind: "verbatim", body: "B turn" });

    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseA, [randomUUID()]), randomUUID()))
      .toThrow(CaseSourceValidationError);

    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseA, [turnB]), randomUUID()))
      .toThrow(CaseSourceValidationError);

    const turnA = appendTurn(db, caseA, { seat: "owner", kind: "verbatim", body: "A turn" });
    closeCase(db, caseA, { closedAs: "settled", verdict: "Done" });
    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseA, [turnA]), randomUUID()))
      .toThrow(CaseSourceValidationError);
  });

  it("rejects dependency output when declared SHA-256 does not match", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Hash", question: "Q" });
    const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Turn" });
    const descriptor = buildDescriptor(caseId, [turnId], {
      dependencyOutputs: [{ nodeId: randomUUID(), title: "Corrupt", output: "abc", outputSha256: makeSha("f") }]
    });
    expect(() => composeGraphHostReviewPacket(db, descriptor, randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.DEPENDENCY_HASH_MISMATCH }));
  });

  it("rejects daemon-only dependency text and extra graph findings", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Mismatch", question: "Q" });
    const ownerTurnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Turn" });
    const depNodeId = randomUUID();
    const out = "Unreceipted text";
    const descMissing = buildDescriptor(caseId, [ownerTurnId], {
      dependencyOutputs: [{ nodeId: depNodeId, title: "Daemon", output: out, outputSha256: sha256Hex(out) }]
    });
    expect(() => composeGraphHostReviewPacket(db, descMissing, randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.DEPENDENCY_SOURCE_MISMATCH }));

    const runId = randomUUID();
    const f1 = createVerifiedFinding(db, caseId, runId, depNodeId, randomUUID(), out);
    const f2 = createVerifiedFinding(db, caseId, runId, randomUUID(), randomUUID(), "Extra finding");
    const descExtra = buildDescriptor(caseId, [f1, f2], {
      runId,
      dependencyOutputs: [{ nodeId: depNodeId, title: "Node", output: out, outputSha256: sha256Hex(out) }]
    });
    expect(() => composeGraphHostReviewPacket(db, descExtra, randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.DEPENDENCY_SOURCE_MISMATCH }));
  });

  it("rejects dependency output when finding exists but correlation outcome is not completed", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Failed Dep", question: "Terminal failed" });
    const runId = randomUUID();
    const depNodeId = randomUUID();
    const depAttemptId = randomUUID();
    const depOutput = "Failed calculation output";

    saveIntent(db, {
      caseId, graphRunId: runId, nodeId: depNodeId, attemptId: depAttemptId,
      descriptorSha256: makeSha("d"), workflowSha256: makeSha("e"), agentSha256: makeSha("a"),
      sourceTurnIds: [randomUUID()], runtimeId: "cadrane-local-loopback", modelId: "local-model"
    });
    const failOpId = randomUUID();
    recordDispatch(db, { caseId, graphRunId: runId, nodeId: depNodeId, attemptId: depAttemptId, operationId: failOpId });
    const findingTurnId = appendTurn(db, caseId, { seat: "graph-worker", kind: "finding", body: depOutput });
    recordTerminal(db, {
      caseId, graphRunId: runId, nodeId: depNodeId, attemptId: depAttemptId,
      operationId: failOpId, outcome: "failed", answerTurnId: null, resultSha256: null
    });

    const descriptor = buildDescriptor(caseId, [findingTurnId], {
      runId,
      dependencyOutputs: [{ nodeId: depNodeId, title: "Failed Node", output: depOutput, outputSha256: sha256Hex(depOutput) }]
    });
    expect(() => composeGraphHostReviewPacket(db, descriptor, randomUUID())).toThrow(CaseSourceValidationError);
  });

  it("rejects total message characters exceeding 24,000 limit", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Size", question: "Q" });
    const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "X".repeat(24_500) });
    const descriptor = buildDescriptor(caseId, [turnId]);
    expect(() => composeGraphHostReviewPacket(db, descriptor, randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.PACKET_SIZE_EXCEEDED }));
  });

  it("enforces trusted runtime constraints and rejects unsupported options", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Trust", question: "Q" });
    const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Turn" });

    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseId, [turnId], { runtimeId: "remote" }), randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.INVALID_RUNTIME }));

    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseId, [turnId], { routingMode: "fallback" }), randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.INVALID_ROUTING_MODE }));

    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseId, [turnId], {
      fallbackRoutes: [{ modelId: "m", runtimeId: "cadrane-local-loopback" }]
    }), randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.NONEMPTY_FALLBACK_ROUTES }));

    expect(() => composeGraphHostReviewPacket(db, { ...buildDescriptor(caseId, [turnId]), tools: [{ name: "t" }] }, randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.UNSUPPORTED_OPTIONS }));
  });

  it("rejects empty operationId and whitespace prompts", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Empty", question: "Q" });
    const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Turn" });
    const desc = buildDescriptor(caseId, [turnId]);

    expect(() => composeGraphHostReviewPacket(db, desc, ""))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.INVALID_OPERATION_ID }));
    expect(() => composeGraphHostReviewPacket(db, desc, "   "))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.INVALID_OPERATION_ID }));

    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseId, [turnId], { systemPrompt: "  " }), randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.DESCRIPTOR_PARSE_FAILED }));
    expect(() => composeGraphHostReviewPacket(db, buildDescriptor(caseId, [turnId], { instruction: "  " }), randomUUID()))
      .toThrowError(expect.objectContaining({ code: GraphHostReviewPacketErrorCode.DESCRIPTOR_PARSE_FAILED }));
  });
});
