/**
 * Verified durable receipts for graph Host attempt correlation.
 *
 * Exercises one exact intent, duplicate rejection, crash recovery with
 * uncertain status across reopen, terminal exactly once, isolation across
 * Cases, rejection of cross-Case binding and operation reuse, corrupt evidence
 * fail closed behavior, and Case deletion cascading.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendTurn, closeCase, eraseCase, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  CorruptCorrelationRecordError,
  GRAPH_HOST_CORRELATION_PREFIX,
  GRAPH_HOST_CORRELATION_SEAT,
  MAX_RECORD_JSON_LENGTH,
  lookup,
  recordDispatch,
  recordTerminal,
  recordTerminalInExistingTransaction,
  saveIntent,
  type SaveIntentInput
} from "./graph-host-correlation-store.js";

function setupTestDb(file?: string): DatabaseSync {
  const db = new DatabaseSync(file ?? ":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

function makeSha256(seedChar = "a"): string {
  return seedChar.repeat(64);
}

describe("Graph Host Correlation Store", () => {
  it("refuses more than three matching receipts before parsing them", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Bounded history", question: "Check receipt bound" });
    const key = { caseId, graphRunId: randomUUID(), nodeId: randomUUID(), attemptId: randomUUID() };
    const prefix = `${GRAPH_HOST_CORRELATION_PREFIX}${key.graphRunId}:${key.nodeId}:${key.attemptId}:`;
    for (let index = 0; index < 4; index += 1)
      appendTurn(db, caseId, { seat: GRAPH_HOST_CORRELATION_SEAT, kind: "receipt", body: `${prefix}{` });
    expect(() => lookup(db, key)).toThrow("Too many matching graph Host correlation receipts");
    db.close();
  });

  it("commits exactly one immutable intent before dispatch and looks it up as reserved", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Workflow Case",
      question: "Run graph v2 task node"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();

    const intentInput: SaveIntentInput = {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1", "turn-2"],
      runtimeId: "runtime-node-v2",
      modelId: "model-claude-3-7-sonnet",
      createdAt: 1000
    };

    const turnId = saveIntent(db, intentInput);
    expect(typeof turnId).toBe("string");
    expect(turnId.length).toBeGreaterThan(0);

    const record = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(record).not.toBeNull();
    expect(record?.caseId).toBe(caseId);
    expect(record?.graphRunId).toBe(graphRunId);
    expect(record?.nodeId).toBe(nodeId);
    expect(record?.attemptId).toBe(attemptId);
    expect(record?.status).toBe("reserved");
    expect(record?.eventStatus).toBe("reserved");
    expect(record?.uncertain).toBe(false);
    expect(record?.isTerminal).toBe(false);
    expect(record?.done).toBe(false);
    expect(record?.operationId).toBeUndefined();
    expect(record?.dispatch).toBeUndefined();
    expect(record?.terminal).toBeUndefined();

    expect(record?.intent.descriptorSha256).toBe(makeSha256("1"));
    expect(record?.intent.workflowSha256).toBe(makeSha256("2"));
    expect(record?.intent.agentSha256).toBe(makeSha256("3"));
    expect(record?.intent.sourceTurnIds).toEqual(["turn-1", "turn-2"]);
    expect(record?.intent.runtimeId).toBe("runtime-node-v2");
    expect(record?.intent.modelId).toBe("model-claude-3-7-sonnet");
    expect(record?.intent.createdAt).toBe(1000);
  });

  it("rejects duplicate intent even if identical", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Workflow Case",
      question: "Reject duplicate intent test"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();

    const intentInput: SaveIntentInput = {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("a"),
      workflowSha256: makeSha256("b"),
      agentSha256: makeSha256("c"),
      sourceTurnIds: ["turn-src-1"],
      runtimeId: "runtime-standard",
      modelId: "model-gemini-2.5-pro",
      createdAt: 2000
    };

    saveIntent(db, intentInput);

    expect(() => saveIntent(db, intentInput)).toThrow(/Duplicate intent/u);
  });

  it("requires Case to exist and be open for saveIntent", () => {
    const db = setupTestDb();
    const nonExistentCaseId = randomUUID();

    const intentInput: SaveIntentInput = {
      caseId: nonExistentCaseId,
      graphRunId: randomUUID(),
      nodeId: randomUUID(),
      attemptId: randomUUID(),
      descriptorSha256: makeSha256("d"),
      workflowSha256: makeSha256("e"),
      agentSha256: makeSha256("f"),
      sourceTurnIds: ["turn-open-1"],
      runtimeId: "runtime-standard",
      modelId: "model-claude-3-7-sonnet"
    };

    expect(() => saveIntent(db, intentInput)).toThrow(/does not exist/u);

    const openCaseId = openCase(db, {
      title: "To be closed",
      question: "Close me"
    });
    closeCase(db, openCaseId, { closedAs: "settled", verdict: "Closed" });

    expect(() =>
      saveIntent(db, {
        ...intentInput,
        caseId: openCaseId
      })
    ).toThrow(/is closed/u);
  });

  it("refuses records outside bounded field sizes or violating validation rules", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Bounds check",
      question: "Check field limits"
    });

    // Empty sourceTurnIds
    expect(() =>
      saveIntent(db, {
        caseId,
        graphRunId: randomUUID(),
        nodeId: randomUUID(),
        attemptId: randomUUID(),
        descriptorSha256: makeSha256("a"),
        workflowSha256: makeSha256("b"),
        agentSha256: makeSha256("c"),
        sourceTurnIds: [],
        runtimeId: "rt",
        modelId: "mod"
      })
    ).toThrow();

    // Duplicate sourceTurnIds
    expect(() =>
      saveIntent(db, {
        caseId,
        graphRunId: randomUUID(),
        nodeId: randomUUID(),
        attemptId: randomUUID(),
        descriptorSha256: makeSha256("a"),
        workflowSha256: makeSha256("b"),
        agentSha256: makeSha256("c"),
        sourceTurnIds: ["turn-dup", "turn-dup"],
        runtimeId: "rt",
        modelId: "mod"
      })
    ).toThrow(/unique/u);

    // Invalid SHA-256 length
    expect(() =>
      saveIntent(db, {
        caseId,
        graphRunId: randomUUID(),
        nodeId: randomUUID(),
        attemptId: randomUUID(),
        descriptorSha256: "not-a-sha256",
        workflowSha256: makeSha256("b"),
        agentSha256: makeSha256("c"),
        sourceTurnIds: ["turn-1"],
        runtimeId: "rt",
        modelId: "mod"
      })
    ).toThrow();
  });

  it("persists dispatch before terminal and stays explicitly uncertain on reopen", () => {
    const folder = mkdtempSync(join(tmpdir(), "correlation-reopen-test-"));
    const file = join(folder, "book.db");
    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = `op-${randomUUID()}`;
    let caseId = "";
    let db: DatabaseSync | null = null;

    try {
      db = setupTestDb(file);
      caseId = openCase(db, {
        title: "Crash Recovery Case",
        question: "Does dispatch stay uncertain across reboot?"
      });

      saveIntent(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        descriptorSha256: makeSha256("4"),
        workflowSha256: makeSha256("5"),
        agentSha256: makeSha256("6"),
        sourceTurnIds: ["turn-crash-1"],
        runtimeId: "runtime-node-v2",
        modelId: "model-gemini-2.5-pro",
        createdAt: 3000
      });

      recordDispatch(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId,
        dispatchedAt: 3100
      });

      db.close();

      db = new DatabaseSync(file);
      db.exec("PRAGMA foreign_keys = ON;");

      const recovered = lookup(db, { caseId, graphRunId, nodeId, attemptId });
      expect(recovered).not.toBeNull();
      expect(recovered?.status).toBe("dispatched");
      expect(recovered?.eventStatus).toBe("dispatched");
      expect(recovered?.uncertain).toBe(true);
      expect(recovered?.isTerminal).toBe(false);
      expect(recovered?.done).toBe(false);
      expect(recovered?.operationId).toBe(operationId);
      expect(recovered?.dispatch?.operationId).toBe(operationId);
      expect(recovered?.dispatch?.dispatchedAt).toBe(3100);
      expect(recovered?.terminal).toBeUndefined();
      expect(recovered?.outcome).toBeUndefined();
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("records terminal event exactly once with matching operationId and validated facts", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Terminal Test",
      question: "Ensure terminal runs once"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = `op-${randomUUID()}`;
    const resultSha256 = makeSha256("9");

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("7"),
      workflowSha256: makeSha256("8"),
      agentSha256: makeSha256("9"),
      sourceTurnIds: ["turn-term-1"],
      runtimeId: "runtime-node-v2",
      modelId: "model-claude-3-7-sonnet"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId
    });

    recordTerminal(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId,
      outcome: "completed",
      answerTurnId: "turn-answer-42",
      resultSha256,
      terminalAt: 4000
    });

    const terminalView = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(terminalView).not.toBeNull();
    expect(terminalView?.status).toBe("terminal");
    expect(terminalView?.eventStatus).toBe("terminal");
    expect(terminalView?.uncertain).toBe(false);
    expect(terminalView?.isTerminal).toBe(true);
    expect(terminalView?.done).toBe(true);
    expect(terminalView?.operationId).toBe(operationId);
    expect(terminalView?.outcome).toBe("completed");
    expect(terminalView?.terminalOutcome).toBe("completed");
    expect(terminalView?.answerTurnId).toBe("turn-answer-42");
    expect(terminalView?.resultSha256).toBe(resultSha256);
    expect(terminalView?.terminal?.terminalAt).toBe(4000);

    // Reject second terminal
    expect(() =>
      recordTerminal(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId,
        outcome: "completed",
        answerTurnId: "turn-answer-42",
        resultSha256
      })
    ).toThrow(/already has a terminal record/u);
  });

  it("rejects terminal without dispatch or with mismatched operationId", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Mismatch Check",
      question: "Check terminal errors"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const validOp = `op-valid-${randomUUID()}`;
    const wrongOp = `op-wrong-${randomUUID()}`;

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    // Terminal before dispatch
    expect(() =>
      recordTerminal(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: validOp,
        outcome: "completed",
        answerTurnId: "ans-1",
        resultSha256: makeSha256("f")
      })
    ).toThrow(/has not been dispatched/u);

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId: validOp
    });

    // Terminal with wrong operationId
    expect(() =>
      recordTerminal(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: wrongOp,
        outcome: "completed",
        answerTurnId: "ans-1",
        resultSha256: makeSha256("f")
      })
    ).toThrow(/Operation ID mismatch/u);
  });

  it("requires exact answerTurnId and resultSha256 when completed, and rejects them when not completed", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Terminal Output Requirements",
      question: "Validate completed vs non-completed outcomes"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const op = `op-${randomUUID()}`;

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId: op
    });

    // Completed missing answerTurnId
    expect(() =>
      recordTerminal(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: op,
        outcome: "completed",
        answerTurnId: null,
        resultSha256: makeSha256("a")
      })
    ).toThrow(/answerTurnId is required/u);

    // Completed missing resultSha256
    expect(() =>
      recordTerminal(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: op,
        outcome: "completed",
        answerTurnId: "ans-1",
        resultSha256: null
      })
    ).toThrow(/resultSha256 is required/u);

    // Non-completed providing answerTurnId
    expect(() =>
      recordTerminal(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: op,
        outcome: "failed",
        answerTurnId: "ans-illegal",
        resultSha256: null
      })
    ).toThrow(/answerTurnId must be null/u);
  });

  it("supports non-completed terminal outcomes (failed, stopped, interrupted)", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Interrupted outcome",
      question: "Can an attempt fail cleanly?"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const op = `op-${randomUUID()}`;

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId: op
    });

    recordTerminal(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId: op,
      outcome: "interrupted"
    });

    const record = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(record?.status).toBe("terminal");
    expect(record?.outcome).toBe("interrupted");
    expect(record?.answerTurnId).toBeNull();
    expect(record?.resultSha256).toBeNull();
    expect(record?.uncertain).toBe(false);
  });

  it("rejects cross-Case dispatch and cross-Case terminal", () => {
    const db = setupTestDb();
    const caseA = openCase(db, { title: "Case A", question: "Room A" });
    const caseB = openCase(db, { title: "Case B", question: "Room B" });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const op = `op-${randomUUID()}`;

    saveIntent(db, {
      caseId: caseA,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    // Attempting to dispatch from caseB
    expect(() =>
      recordDispatch(db, {
        caseId: caseB,
        graphRunId,
        nodeId,
        attemptId,
        operationId: op
      })
    ).toThrow(/Cross-case correlation mismatch/u);

    recordDispatch(db, {
      caseId: caseA,
      graphRunId,
      nodeId,
      attemptId,
      operationId: op
    });

    // Attempting to record terminal from caseB
    expect(() =>
      recordTerminal(db, {
        caseId: caseB,
        graphRunId,
        nodeId,
        attemptId,
        operationId: op,
        outcome: "stopped"
      })
    ).toThrow(/Cross-case correlation mismatch/u);
  });

  it("rejects reuse of an operationId for another attempt", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Shared Op Test",
      question: "Reject operation ID collision"
    });

    const sharedOp = `shared-op-${randomUUID()}`;

    const runId1 = randomUUID();
    const nodeId1 = randomUUID();
    const attemptId1 = randomUUID();

    const runId2 = randomUUID();
    const nodeId2 = randomUUID();
    const attemptId2 = randomUUID();

    saveIntent(db, {
      caseId,
      graphRunId: runId1,
      nodeId: nodeId1,
      attemptId: attemptId1,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    saveIntent(db, {
      caseId,
      graphRunId: runId2,
      nodeId: nodeId2,
      attemptId: attemptId2,
      descriptorSha256: makeSha256("4"),
      workflowSha256: makeSha256("5"),
      agentSha256: makeSha256("6"),
      sourceTurnIds: ["turn-2"],
      runtimeId: "rt",
      modelId: "mod"
    });

    recordDispatch(db, {
      caseId,
      graphRunId: runId1,
      nodeId: nodeId1,
      attemptId: attemptId1,
      operationId: sharedOp
    });

    expect(() =>
      recordDispatch(db, {
        caseId,
        graphRunId: runId2,
        nodeId: nodeId2,
        attemptId: attemptId2,
        operationId: sharedOp
      })
    ).toThrow(/already bound to another attempt/u);
  });

  it("fails closed on malformed row, invalid JSON, or out-of-order stored records", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Corrupt Case",
      question: "Test fail-closed behavior"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const prefix = `${GRAPH_HOST_CORRELATION_PREFIX}${graphRunId}:${nodeId}:${attemptId}:`;

    // 1. Non-JSON body
    appendTurn(db, caseId, {
      seat: GRAPH_HOST_CORRELATION_SEAT,
      kind: "receipt",
      body: `${prefix}{not-valid-json`
    });

    expect(() => lookup(db, { caseId, graphRunId, nodeId, attemptId })).toThrow(
      CorruptCorrelationRecordError
    );

    // 2. Corrupt schema row in a fresh attempt
    const run2 = randomUUID();
    const node2 = randomUUID();
    const attempt2 = randomUUID();
    const prefix2 = `${GRAPH_HOST_CORRELATION_PREFIX}${run2}:${node2}:${attempt2}:`;

    appendTurn(db, caseId, {
      seat: GRAPH_HOST_CORRELATION_SEAT,
      kind: "receipt",
      body: `${prefix2}${JSON.stringify({ event: "intent", caseId: "invalid-uuid" })}`
    });

    expect(() => lookup(db, { caseId, graphRunId: run2, nodeId: node2, attemptId: attempt2 })).toThrow(
      CorruptCorrelationRecordError
    );

    // 3. Out-of-order dispatch without intent
    const run3 = randomUUID();
    const node3 = randomUUID();
    const attempt3 = randomUUID();
    const prefix3 = `${GRAPH_HOST_CORRELATION_PREFIX}${run3}:${node3}:${attempt3}:`;

    appendTurn(db, caseId, {
      seat: GRAPH_HOST_CORRELATION_SEAT,
      kind: "receipt",
      body: `${prefix3}${JSON.stringify({
        event: "dispatch",
        caseId,
        graphRunId: run3,
        nodeId: node3,
        attemptId: attempt3,
        operationId: "op-1",
        dispatchedAt: 100
      })}`
    });

    expect(() => lookup(db, { caseId, graphRunId: run3, nodeId: node3, attemptId: attempt3 })).toThrow(
      CorruptCorrelationRecordError
    );
  });

  it("keeps a second Case isolated and undisturbed", () => {
    const db = setupTestDb();
    const caseA = openCase(db, { title: "Isolated A", question: "Room A" });
    const caseB = openCase(db, { title: "Isolated B", question: "Room B" });

    const runA = randomUUID();
    const nodeA = randomUUID();
    const attemptA = randomUUID();

    const runB = randomUUID();
    const nodeB = randomUUID();
    const attemptB = randomUUID();

    saveIntent(db, {
      caseId: caseA,
      graphRunId: runA,
      nodeId: nodeA,
      attemptId: attemptA,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-a"],
      runtimeId: "rt-a",
      modelId: "mod-a"
    });

    saveIntent(db, {
      caseId: caseB,
      graphRunId: runB,
      nodeId: nodeB,
      attemptId: attemptB,
      descriptorSha256: makeSha256("4"),
      workflowSha256: makeSha256("5"),
      agentSha256: makeSha256("6"),
      sourceTurnIds: ["turn-b"],
      runtimeId: "rt-b",
      modelId: "mod-b"
    });

    // Lookup across cases returns null
    expect(lookup(db, { caseId: caseB, graphRunId: runA, nodeId: nodeA, attemptId: attemptA })).toBeNull();
    expect(lookup(db, { caseId: caseA, graphRunId: runB, nodeId: nodeB, attemptId: attemptB })).toBeNull();

    // Respective lookups resolve correctly
    const recA = lookup(db, { caseId: caseA, graphRunId: runA, nodeId: nodeA, attemptId: attemptA });
    const recB = lookup(db, { caseId: caseB, graphRunId: runB, nodeId: nodeB, attemptId: attemptB });

    expect(recA?.intent.runtimeId).toBe("rt-a");
    expect(recB?.intent.runtimeId).toBe("rt-b");
  });

  it("cascades deletion on eraseCase removing only that Case's attempt receipts", () => {
    const db = setupTestDb();
    const case1 = openCase(db, { title: "To Erase", question: "Erased" });
    const case2 = openCase(db, { title: "To Keep", question: "Stay open" });

    const run1 = randomUUID();
    const node1 = randomUUID();
    const attempt1 = randomUUID();

    const run2 = randomUUID();
    const node2 = randomUUID();
    const attempt2 = randomUUID();

    saveIntent(db, {
      caseId: case1,
      graphRunId: run1,
      nodeId: node1,
      attemptId: attempt1,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    saveIntent(db, {
      caseId: case2,
      graphRunId: run2,
      nodeId: node2,
      attemptId: attempt2,
      descriptorSha256: makeSha256("4"),
      workflowSha256: makeSha256("5"),
      agentSha256: makeSha256("6"),
      sourceTurnIds: ["turn-2"],
      runtimeId: "rt",
      modelId: "mod"
    });

    eraseCase(db, case1);

    expect(
      lookup(db, { caseId: case1, graphRunId: run1, nodeId: node1, attemptId: attempt1 })
    ).toBeNull();

    const turnsCase1 = db
      .prepare("SELECT COUNT(*) AS count FROM case_turn WHERE case_id = ?")
      .get(case1) as { readonly count: number };
    expect(turnsCase1.count).toBe(0);

    const recordCase2 = lookup(db, {
      caseId: case2,
      graphRunId: run2,
      nodeId: node2,
      attemptId: attempt2
    });
    expect(recordCase2).not.toBeNull();
    expect(recordCase2?.caseId).toBe(case2);
    expect(recordCase2?.intent.sourceTurnIds).toEqual(["turn-2"]);
  });

  it("enforces exact operationId uniqueness for IDs containing quotes, backslashes, percent, and underscores", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Metacharacter Test",
      question: "Ensure exact operationId matching with quotes and wildcards"
    });

    const opaqueOp = 'op-"quoted"\\%_and_more';

    const runId1 = randomUUID();
    const nodeId1 = randomUUID();
    const attemptId1 = randomUUID();

    const runId2 = randomUUID();
    const nodeId2 = randomUUID();
    const attemptId2 = randomUUID();

    const runId3 = randomUUID();
    const nodeId3 = randomUUID();
    const attemptId3 = randomUUID();

    saveIntent(db, {
      caseId,
      graphRunId: runId1,
      nodeId: nodeId1,
      attemptId: attemptId1,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    saveIntent(db, {
      caseId,
      graphRunId: runId2,
      nodeId: nodeId2,
      attemptId: attemptId2,
      descriptorSha256: makeSha256("4"),
      workflowSha256: makeSha256("5"),
      agentSha256: makeSha256("6"),
      sourceTurnIds: ["turn-2"],
      runtimeId: "rt",
      modelId: "mod"
    });

    saveIntent(db, {
      caseId,
      graphRunId: runId3,
      nodeId: nodeId3,
      attemptId: attemptId3,
      descriptorSha256: makeSha256("7"),
      workflowSha256: makeSha256("8"),
      agentSha256: makeSha256("9"),
      sourceTurnIds: ["turn-3"],
      runtimeId: "rt",
      modelId: "mod"
    });

    recordDispatch(db, {
      caseId,
      graphRunId: runId1,
      nodeId: nodeId1,
      attemptId: attemptId1,
      operationId: opaqueOp
    });

    expect(() =>
      recordDispatch(db, {
        caseId,
        graphRunId: runId2,
        nodeId: nodeId2,
        attemptId: attemptId2,
        operationId: opaqueOp
      })
    ).toThrow(/already bound to another attempt/u);

    const similarOp = 'op-"quoted"X%_and_more';
    recordDispatch(db, {
      caseId,
      graphRunId: runId3,
      nodeId: nodeId3,
      attemptId: attemptId3,
      operationId: similarOp
    });

    const rec1 = lookup(db, { caseId, graphRunId: runId1, nodeId: nodeId1, attemptId: attemptId1 });
    expect(rec1?.operationId).toBe(opaqueOp);

    const rec3 = lookup(db, { caseId, graphRunId: runId3, nodeId: nodeId3, attemptId: attemptId3 });
    expect(rec3?.operationId).toBe(similarOp);
  });

  it("rejects an oversized valid-looking intent exceeding MAX_RECORD_JSON_LENGTH on write", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Payload Bound Case",
      question: "Reject oversized write payload"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();

    const longSourceTurnIds = Array.from({ length: 500 }, (_, i) =>
      `turn-${String(i).padStart(4, "0")}-${"x".repeat(140)}`
    );

    const oversizedIntent: SaveIntentInput = {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: longSourceTurnIds,
      runtimeId: "runtime-node-v2",
      modelId: "model-claude-3-7-sonnet"
    };

    expect(() => saveIntent(db, oversizedIntent)).toThrow();
    expect(lookup(db, { caseId, graphRunId, nodeId, attemptId })).toBeNull();
  });

  it("fails closed on corrupt receipts during dispatch uniqueness scan instead of unsafe rebind", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Corrupt Scan Case",
      question: "Ensure malformed receipts abort dispatch"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    appendTurn(db, caseId, {
      seat: GRAPH_HOST_CORRELATION_SEAT,
      kind: "receipt",
      body: "GraphHostCorrelationV1:corrupted-header-without-uuids"
    });

    expect(() =>
      recordDispatch(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: "op-test-1"
      })
    ).toThrow(CorruptCorrelationRecordError);
  });

  it("fails closed in lookup when cross-Case correlation history exists for an attempt", () => {
    const db = setupTestDb();
    const caseA = openCase(db, { title: "Case A", question: "Room A" });
    const caseB = openCase(db, { title: "Case B", question: "Room B" });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();

    saveIntent(db, {
      caseId: caseA,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt",
      modelId: "mod"
    });

    const prefix = `${GRAPH_HOST_CORRELATION_PREFIX}${graphRunId}:${nodeId}:${attemptId}:`;
    appendTurn(db, caseB, {
      seat: GRAPH_HOST_CORRELATION_SEAT,
      kind: "receipt",
      body: `${prefix}${JSON.stringify({
        event: "dispatch",
        caseId: caseB,
        graphRunId,
        nodeId,
        attemptId,
        operationId: "op-cross",
        dispatchedAt: 1000
      })}`
    });

    expect(() => lookup(db, { caseId: caseA, graphRunId, nodeId, attemptId })).toThrow(
      CorruptCorrelationRecordError
    );
    expect(() => lookup(db, { caseId: caseB, graphRunId, nodeId, attemptId })).toThrow(
      CorruptCorrelationRecordError
    );
  });

  it("preserves standalone recordTerminal behavior committing terminal independently", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Standalone Terminal Test",
      question: "Verify existing recordTerminal behavior"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = `op-${randomUUID()}`;
    const resultSha256 = makeSha256("1");

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("a"),
      workflowSha256: makeSha256("b"),
      agentSha256: makeSha256("c"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt-1",
      modelId: "mod-1"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId
    });

    const turnId = recordTerminal(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId,
      outcome: "completed",
      answerTurnId: "turn-answer-1",
      resultSha256,
      terminalAt: 5000
    });

    expect(typeof turnId).toBe("string");
    expect(turnId.length).toBeGreaterThan(0);

    const rec = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(rec?.status).toBe("terminal");
    expect(rec?.eventStatus).toBe("terminal");
    expect(rec?.isTerminal).toBe(true);
    expect(rec?.done).toBe(true);
    expect(rec?.operationId).toBe(operationId);
    expect(rec?.outcome).toBe("completed");
    expect(rec?.answerTurnId).toBe("turn-answer-1");
    expect(rec?.resultSha256).toBe(resultSha256);
  });

  it("rolls back both finding turn and terminal correlation receipt when an external transaction aborts", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Rollback Test",
      question: "Atomic rollback of finding and terminal receipt"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = `op-${randomUUID()}`;
    const answer = "Generated finding to be rolled back";
    const resultSha256 = createHash("sha256").update(answer).digest("hex");

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("a"),
      workflowSha256: makeSha256("b"),
      agentSha256: makeSha256("c"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt-1",
      modelId: "mod-1"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId
    });

    expect(db.isTransaction).toBe(false);

    expect(() => {
      db.exec("BEGIN IMMEDIATE");
      expect(db.isTransaction).toBe(true);

      const findingTurnId = appendTurn(db, caseId, {
        seat: "graph:bundled-local",
        kind: "finding",
        body: answer
      });

      recordTerminalInExistingTransaction(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId,
        outcome: "completed",
        answerTurnId: findingTurnId,
        resultSha256,
        terminalAt: 6000
      });

      throw new Error("Simulated external failure before commit");
    }).toThrow("Simulated external failure before commit");

    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(db.isTransaction).toBe(false);

    const findingTurns = db
      .prepare("SELECT COUNT(*) AS count FROM case_turn WHERE kind = 'finding'")
      .get() as { readonly count: number };
    expect(findingTurns.count).toBe(0);

    const rec = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(rec?.status).toBe("dispatched");
    expect(rec?.uncertain).toBe(true);
    expect(rec?.isTerminal).toBe(false);
    expect(rec?.terminal).toBeUndefined();
  });

  it("atomically commits finding turn and terminal correlation receipt in an external transaction", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Atomic Commit Test",
      question: "Commit finding and terminal together"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = `op-${randomUUID()}`;
    const answer = "Generated finding turn";
    const resultSha256 = createHash("sha256").update(answer).digest("hex");

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("a"),
      workflowSha256: makeSha256("b"),
      agentSha256: makeSha256("c"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt-1",
      modelId: "mod-1"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId
    });

    db.exec("BEGIN IMMEDIATE");
    expect(db.isTransaction).toBe(true);

    const findingTurnId = appendTurn(db, caseId, {
      seat: "graph:bundled-local",
      kind: "finding",
      body: answer
    });

    const terminalTurnId = recordTerminalInExistingTransaction(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId,
      outcome: "completed",
      answerTurnId: findingTurnId,
      resultSha256,
      terminalAt: 7000
    });

    db.exec("COMMIT");
    expect(db.isTransaction).toBe(false);

    expect(typeof findingTurnId).toBe("string");
    expect(typeof terminalTurnId).toBe("string");

    const findingRow = db
      .prepare("SELECT id, body FROM case_turn WHERE id = ?")
      .get(findingTurnId) as { readonly id: string; readonly body: string } | undefined;
    expect(findingRow).toBeDefined();
    expect(findingRow?.body).toContain("Generated finding turn");

    const rec = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(rec?.status).toBe("terminal");
    expect(rec?.eventStatus).toBe("terminal");
    expect(rec?.uncertain).toBe(false);
    expect(rec?.isTerminal).toBe(true);
    expect(rec?.done).toBe(true);
    expect(rec?.operationId).toBe(operationId);
    expect(rec?.outcome).toBe("completed");
    expect(rec?.answerTurnId).toBe(findingTurnId);
    expect(rec?.resultSha256).toBe(resultSha256);
    expect(rec?.terminal?.terminalAt).toBe(7000);
  });

  it("refuses recordTerminalInExistingTransaction without an open transaction and performs no writes", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "No Transaction Refusal Test",
      question: "Refuse when db.isTransaction is false"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = `op-${randomUUID()}`;

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("a"),
      workflowSha256: makeSha256("b"),
      agentSha256: makeSha256("c"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt-1",
      modelId: "mod-1"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId
    });

    const turnsBefore = db
      .prepare("SELECT COUNT(*) AS count FROM case_turn")
      .get() as { readonly count: number };

    expect(db.isTransaction).toBe(false);

    expect(() =>
      recordTerminalInExistingTransaction(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId,
        outcome: "completed",
        answerTurnId: "turn-ans",
        resultSha256: makeSha256("5")
      })
    ).toThrow(/transaction/i);

    const turnsAfter = db
      .prepare("SELECT COUNT(*) AS count FROM case_turn")
      .get() as { readonly count: number };
    expect(turnsAfter.count).toBe(turnsBefore.count);

    const rec = lookup(db, { caseId, graphRunId, nodeId, attemptId });
    expect(rec?.status).toBe("dispatched");
    expect(rec?.isTerminal).toBe(false);
  });

  it("refuses wrong operationId or duplicate terminal in recordTerminalInExistingTransaction", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Validation In Transaction Test",
      question: "Refuse wrong op and duplicate within external transaction"
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const validOp = `op-valid-${randomUUID()}`;
    const wrongOp = `op-wrong-${randomUUID()}`;

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("a"),
      workflowSha256: makeSha256("b"),
      agentSha256: makeSha256("c"),
      sourceTurnIds: ["turn-1"],
      runtimeId: "rt-1",
      modelId: "mod-1"
    });

    recordDispatch(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId: validOp
    });

    // 1. Wrong operation ID
    db.exec("BEGIN IMMEDIATE");
    expect(() =>
      recordTerminalInExistingTransaction(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: wrongOp,
        outcome: "completed",
        answerTurnId: "turn-ans",
        resultSha256: makeSha256("6")
      })
    ).toThrow(/Operation ID mismatch/u);
    db.exec("ROLLBACK");

    // 2. First terminal succeeds
    db.exec("BEGIN IMMEDIATE");
    recordTerminalInExistingTransaction(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      operationId: validOp,
      outcome: "completed",
      answerTurnId: "turn-ans",
      resultSha256: makeSha256("6")
    });
    db.exec("COMMIT");

    // 3. Duplicate terminal refuses
    db.exec("BEGIN IMMEDIATE");
    expect(() =>
      recordTerminalInExistingTransaction(db, {
        caseId,
        graphRunId,
        nodeId,
        attemptId,
        operationId: validOp,
        outcome: "completed",
        answerTurnId: "turn-ans-dup",
        resultSha256: makeSha256("6")
      })
    ).toThrow(/already has a terminal record/u);
    db.exec("ROLLBACK");
  });
});
