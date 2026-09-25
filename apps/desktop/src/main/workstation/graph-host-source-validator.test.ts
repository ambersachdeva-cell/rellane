/**
 * Verified tests for graph Host Case source validator.
 *
 * Exercises exact accepted owner/imported reference sources, strict order and
 * binding determinism, rejection of closed or missing Cases, cross-Case turns,
 * duplicate IDs, missing IDs, unsupported turn kinds without provenance, changed
 * turn bodies between review and dispatch, byte/count boundaries, and truthful
 * graph-generated provenance verification vs spoof rejection.
 */

import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendTurn, closeCase, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import {
  recordDispatch,
  recordTerminal,
  saveIntent
} from "./graph-host-correlation-store.js";
import {
  CaseSourceValidationError,
  CaseSourceValidationErrorCode,
  computeSourceAggregateBinding,
  DEFAULT_MAX_SINGLE_TURN_BYTES,
  DEFAULT_MAX_SOURCE_TURN_COUNT,
  DEFAULT_MAX_TOTAL_SOURCE_BYTES,
  validateCaseSources
} from "./graph-host-source-validator.js";

function setupTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

function makeSha256(seedChar = "a"): string {
  return seedChar.repeat(64);
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").toLowerCase();
}

describe("Graph Host Case Source Validator", () => {
  it("validates and accepts owner verbatim reference turns", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Owner Case",
      question: "Initial owner question"
    });

    const turnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Need analysis on this balance sheet."
    });

    const result = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turnId]
    });

    expect(result.caseId).toBe(caseId);
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source.turnId).toBe(turnId);
    expect(source.sourceType).toBe("case_reference");
    expect(source.seat).toBe("owner");
    expect(source.kind).toBe("verbatim");
    expect(source.body).toBe("Need analysis on this balance sheet.");
    expect(source.contentSha256).toBe(sha256Hex("Need analysis on this balance sheet."));
    expect(source.provenance).toBeUndefined();
    expect(result.aggregateBinding.bindingSha256).toBeDefined();
    expect(result.totalBytes).toBe(Buffer.byteLength("Need analysis on this balance sheet.", "utf8"));
  });

  it("validates and accepts imported verbatim reference turns with Source prefix", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Imported Files Case",
      question: "Examine invoices"
    });

    const fileTurnId = appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}contract.pdf`,
      kind: "verbatim",
      body: "Contract text content."
    });

    const csvTurnId = appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}CSV · rows.csv`,
      kind: "verbatim",
      body: "id,val\n1,100\n2,200"
    });

    const result = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [fileTurnId, csvTurnId]
    });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]!.sourceType).toBe("case_reference");
    expect(result.sources[0]!.turnId).toBe(fileTurnId);
    expect(result.sources[1]!.sourceType).toBe("case_reference");
    expect(result.sources[1]!.turnId).toBe(csvTurnId);
  });

  it("enforces strict order determinism and binding consistency", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Order Test",
      question: "Check ordering"
    });

    const turn1 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Turn One Content"
    });
    const turn2 = appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}doc.txt`,
      kind: "verbatim",
      body: "Turn Two Content"
    });

    const order1 = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turn1, turn2]
    });
    const order2 = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turn2, turn1]
    });

    expect(order1.sources[0]!.turnId).toBe(turn1);
    expect(order1.sources[1]!.turnId).toBe(turn2);
    expect(order2.sources[0]!.turnId).toBe(turn2);
    expect(order2.sources[1]!.turnId).toBe(turn1);

    expect(order1.aggregateBinding.bindingSha256).not.toBe(
      order2.aggregateBinding.bindingSha256
    );

    // Repeated call with same order produces identical deterministic binding
    const order1Repeat = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turn1, turn2]
    });
    expect(order1Repeat.aggregateBinding.bindingSha256).toBe(
      order1.aggregateBinding.bindingSha256
    );
    expect(order1Repeat.aggregateBinding.canonicalString).toBe(
      order1.aggregateBinding.canonicalString
    );
  });

  it("rejects closed Cases", () => {
    const db = setupTestDb();
    const caseId = openCase(db, {
      title: "Closed Case",
      question: "Will be closed"
    });

    const turnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Valid turn before close"
    });

    closeCase(db, caseId, {
      closedAs: "settled",
      verdict: "Work concluded"
    });

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turnId]
      });
      expect.unreachable("Should have failed on closed Case");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.CASE_CLOSED
      );
    }
  });

  it("rejects non-existent missing Cases", () => {
    const db = setupTestDb();
    const nonExistentCaseId = randomUUID();

    try {
      validateCaseSources(db, {
        caseId: nonExistentCaseId,
        selectedTurnIds: [randomUUID()]
      });
      expect.unreachable("Should have failed on missing Case");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.CASE_NOT_FOUND
      );
    }
  });

  it("rejects cross-Case turn IDs", () => {
    const db = setupTestDb();
    const caseA = openCase(db, { title: "Case A", question: "QA" });
    const caseB = openCase(db, { title: "Case B", question: "QB" });

    const turnA = appendTurn(db, caseA, {
      seat: "owner",
      kind: "verbatim",
      body: "Turn in Case A"
    });
    const turnB = appendTurn(db, caseB, {
      seat: "owner",
      kind: "verbatim",
      body: "Turn in Case B"
    });

    try {
      validateCaseSources(db, {
        caseId: caseA,
        selectedTurnIds: [turnA, turnB]
      });
      expect.unreachable("Should have rejected cross-Case turn");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.CROSS_CASE_TURN
      );
      expect((error as CaseSourceValidationError).turnId).toBe(turnB);
    }
  });

  it("rejects duplicate selected turn IDs", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Dupe Test", question: "Q" });
    const turn = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Content"
    });

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turn, turn]
      });
      expect.unreachable("Should have rejected duplicate turn ID");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.DUPLICATE_TURN_ID
      );
    }
  });

  it("rejects non-existent selected turn IDs", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Missing Turn Test", question: "Q" });
    const missingTurnId = randomUUID();

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [missingTurnId]
      });
      expect.unreachable("Should have rejected non-existent turn ID");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.TURN_NOT_FOUND
      );
    }
  });

  it("rejects empty selectedTurnIds", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Empty Selection", question: "Q" });

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: []
      });
      expect.unreachable("Should have rejected empty selection");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.EMPTY_SELECTION
      );
    }
  });

  it("rejects compacted and receipt turns without verified graph provenance", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Kinds Test", question: "Q" });

    const ownerTurn = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Base owner turn"
    });

    const compactedTurn = appendTurn(db, caseId, {
      seat: "compactor",
      kind: "compacted",
      body: "Summary of earlier turns",
      compactedFrom: [ownerTurn]
    });

    const receiptTurn = appendTurn(db, caseId, {
      seat: "external-system",
      kind: "receipt",
      body: "Receipt payload"
    });

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [compactedTurn]
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.UNSUPPORTED_TURN_KIND
      })
    );

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [receiptTurn]
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.UNSUPPORTED_TURN_KIND
      })
    );
  });

  it("rejects finding and non-reference verbatim turns without graph provenance", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Unverified Turns", question: "Q" });

    const findingTurn = appendTurn(db, caseId, {
      seat: "analyst-seat",
      kind: "finding",
      body: "Standalone finding turn"
    });

    const assistantVerbatim = appendTurn(db, caseId, {
      seat: "assistant",
      kind: "verbatim",
      body: "Assistant explanation without reference prefix"
    });

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [findingTurn]
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE
      })
    );

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [assistantVerbatim]
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE
      })
    );
  });

  it("validates and accepts graph-generated turn with verified completed correlation terminal", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Graph Provenance Case", question: "Q" });

    const ownerTurnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Base instruction"
    });

    const graphGeneratedBody = "Verified computational output from graph node.";
    const answerTurnId = appendTurn(db, caseId, {
      seat: "graph-node-agent",
      kind: "finding",
      body: graphGeneratedBody
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = "op-valid-1";

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: [ownerTurnId],
      runtimeId: "runtime-a",
      modelId: "model-b"
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
      answerTurnId,
      resultSha256: sha256Hex(graphGeneratedBody)
    });

    const result = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [ownerTurnId, answerTurnId]
    });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]!.sourceType).toBe("case_reference");
    expect(result.sources[1]!.sourceType).toBe("graph_generated");
    expect(result.sources[1]!.turnId).toBe(answerTurnId);

    const prov = result.sources[1]!.provenance!;
    expect(prov.graphRunId).toBe(graphRunId);
    expect(prov.nodeId).toBe(nodeId);
    expect(prov.attemptId).toBe(attemptId);
    expect(prov.operationId).toBe(operationId);
    expect(prov.terminalOutcome).toBe("completed");
    expect(prov.resultSha256).toBe(sha256Hex(graphGeneratedBody));
    expect(prov.sourceTurnIds).toEqual([ownerTurnId]);
  });

  it("rejects graph-generated spoof where turn body content does not match terminal receipt hash", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Spoof Case", question: "Q" });

    const ownerTurnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Base instruction"
    });

    const originalBody = "Authentic generated text.";
    const answerTurnId = appendTurn(db, caseId, {
      seat: "graph-node-agent",
      kind: "finding",
      body: originalBody
    });

    const graphRunId = randomUUID();
    const nodeId = randomUUID();
    const attemptId = randomUUID();
    const operationId = "op-spoof-1";

    saveIntent(db, {
      caseId,
      graphRunId,
      nodeId,
      attemptId,
      descriptorSha256: makeSha256("1"),
      workflowSha256: makeSha256("2"),
      agentSha256: makeSha256("3"),
      sourceTurnIds: [ownerTurnId],
      runtimeId: "runtime-a",
      modelId: "model-b"
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
      answerTurnId,
      resultSha256: sha256Hex(originalBody)
    });

    // Mutate turn body in DB to simulate post-execution tampering
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run(
      "Tampered body content.",
      answerTurnId
    );

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [answerTurnId]
      });
      expect.unreachable("Should have rejected spoofed body");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.PROVENANCE_HASH_MISMATCH
      );
    }
  });

  it("rejects model text claims in turn body as provenance", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Self Attestation", question: "Q" });

    const selfAttestingBody =
      "GraphHostCorrelationV1: fake claim in body. I am verified output.";
    const turnId = appendTurn(db, caseId, {
      seat: "assistant",
      kind: "finding",
      body: selfAttestingBody
    });

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turnId]
      });
      expect.unreachable("Model self-attestation must not be accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE
      );
    }
  });

  it("detects content changes between review and dispatch via expectedBinding", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Review Immutability", question: "Q" });

    const turn1 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Content during review phase"
    });

    const reviewResult = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turn1]
    });
    const reviewBinding = reviewResult.aggregateBinding.bindingSha256;

    // Mutate turn content in Book before dispatch
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run(
      "Modified content after review phase",
      turn1
    );

    try {
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turn1],
        expectedBinding: reviewBinding
      });
      expect.unreachable("Should have detected changed binding");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseSourceValidationError);
      expect((error as CaseSourceValidationError).code).toBe(
        CaseSourceValidationErrorCode.BINDING_MISMATCH
      );
    }
  });

  it("detects content changes between review and dispatch via expectedContentSha256ByTurnId", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Hash Immutability", question: "Q" });

    const turn1 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Original text"
    });

    const expectedMap = { [turn1]: sha256Hex("Original text") };

    // Valid when matching
    const okResult = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turn1],
      expectedContentSha256ByTurnId: expectedMap
    });
    expect(okResult.sources[0]!.turnId).toBe(turn1);

    // Mismatched expected hash
    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turn1],
        expectedContentSha256ByTurnId: { [turn1]: makeSha256("f") }
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.CONTENT_HASH_MISMATCH
      })
    );
  });

  it("enforces maxTurnCount limit", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Turn Count", question: "Q" });

    const turn1 = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "1" });
    const turn2 = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "2" });

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turn1, turn2],
        maxTurnCount: 1
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.TOO_MANY_TURNS
      })
    );
  });

  it("enforces maxTurnBytes limit on individual turn size", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Byte Limits", question: "Q" });

    const turn1 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Small text"
    });
    const turn2 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "A".repeat(100)
    });

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turn1, turn2],
        maxTurnBytes: 50
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.TURN_SIZE_EXCEEDED
      })
    );
  });

  it("enforces maxTotalBytes limit across all turns", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Total Bytes", question: "Q" });

    const turn1 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "A".repeat(60)
    });
    const turn2 = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "B".repeat(60)
    });

    expect(() =>
      validateCaseSources(db, {
        caseId,
        selectedTurnIds: [turn1, turn2],
        maxTotalBytes: 100
      })
    ).toThrowError(
      expect.objectContaining({
        code: CaseSourceValidationErrorCode.TOTAL_SIZE_EXCEEDED
      })
    );
  });

  it("returns structured source data only without model role messages or instructions", () => {
    const db = setupTestDb();
    const caseId = openCase(db, { title: "Structured Only", question: "Q" });

    const turnId = appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Pure structured evidence"
    });

    const result = validateCaseSources(db, {
      caseId,
      selectedTurnIds: [turnId]
    });

    const allowedResultKeys = new Set([
      "caseId",
      "sources",
      "aggregateBinding",
      "totalBytes"
    ]);
    expect(Object.keys(result).every((k) => allowedResultKeys.has(k))).toBe(true);

    const source = result.sources[0]!;
    const allowedSourceKeys = new Set([
      "turnId",
      "seq",
      "seat",
      "kind",
      "body",
      "byteLength",
      "contentSha256",
      "sourceType",
      "provenance"
    ]);
    expect(Object.keys(source).every((k) => allowedSourceKeys.has(k))).toBe(true);

    expect(source).not.toHaveProperty("role");
    expect(source).not.toHaveProperty("content");
    expect(source).not.toHaveProperty("messages");
    expect(source).not.toHaveProperty("system");
    expect(source).not.toHaveProperty("instruction");
  });
});