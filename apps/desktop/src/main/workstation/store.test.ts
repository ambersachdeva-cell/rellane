import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { closeCase, eraseCase, openCase, turnsFor, verbatimFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  isActiveStatus,
  latestSessionReceipt,
  MAX_RECEIPT_ACTIVITY_ITEMS,
  MAX_RECEIPT_TEXT_LENGTH,
  recoverInterruptedSessions,
  saveSessionReceipt,
  validateReceipt,
  WORKSTATION_SESSION_SEAT,
  type WorkstationSessionReceipt,
  type WorkstationSnapshot
} from "./store.js";

function book(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

let db: DatabaseSync;
beforeEach(() => {
  db = book();
});

function makeSnapshot(overrides?: Partial<WorkstationSnapshot>): WorkstationSnapshot {
  return {
    operationId: "op-default-1",
    caseId: "case-default-1",
    providerId: "codex",
    modelId: "gpt-4o",
    sessionId: "sess-default-1",
    status: "running",
    startedAt: 1000,
    updatedAt: 2000,
    text: "Initial model output",
    activity: ["Starting process", "Reading workspace"],
    permission: null,
    detail: "Executing command",
    ...overrides
  };
}

function makeReceipt(
  overrides?: Partial<WorkstationSessionReceipt>,
  snapshotOverrides?: Partial<WorkstationSnapshot>
): WorkstationSessionReceipt {
  const snapshot = makeSnapshot(snapshotOverrides);
  return {
    version: 1,
    event: "checkpoint",
    workspacePath: "/Users/example/project",
    snapshot,
    ...overrides
  };
}

describe("native reported models", () => {
  it("persists an observed model separately and keeps old receipts compatible", () => {
    const caseId = openCase(db, { title: "Model identity", question: "Synthetic" });
    const receipt = makeReceipt({ event: "finish" }, { caseId, providerId: "claude", modelId: "opus", reportedModelId: "claude-opus-5", status: "completed" });
    saveSessionReceipt(db, caseId, receipt);
    expect(latestSessionReceipt(db, caseId)?.snapshot).toMatchObject({ modelId: "opus", reportedModelId: "claude-opus-5" });
    expect(validateReceipt(makeReceipt())?.snapshot.reportedModelId).toBeUndefined();
    expect(validateReceipt(makeReceipt({}, { reportedModelId: "--injected argument" }))).toBeNull();
  });
});

describe("workstation store — provider separation", () => {
  it("preserves independent provider receipts within the same case room", () => {
    const caseId = openCase(db, { title: "Provider separation", question: "compare providers" });

    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "checkpoint" },
        { operationId: "op-codex-1", caseId, providerId: "codex", sessionId: "sess-codex" }
      )
    );

    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "checkpoint" },
        { operationId: "op-claude-1", caseId, providerId: "claude", sessionId: "sess-claude" }
      )
    );

    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "finish" },
        { operationId: "op-gemini-1", caseId, providerId: "gemini1", status: "completed", sessionId: "sess-gemini" }
      )
    );

    const codexReceipt = latestSessionReceipt(db, caseId, "codex");
    expect(codexReceipt?.snapshot.operationId).toBe("op-codex-1");
    expect(codexReceipt?.snapshot.providerId).toBe("codex");
    expect(codexReceipt?.snapshot.sessionId).toBe("sess-codex");

    const claudeReceipt = latestSessionReceipt(db, caseId, "claude");
    expect(claudeReceipt?.snapshot.operationId).toBe("op-claude-1");
    expect(claudeReceipt?.snapshot.providerId).toBe("claude");
    expect(claudeReceipt?.snapshot.sessionId).toBe("sess-claude");

    const geminiReceipt = latestSessionReceipt(db, caseId, "gemini1");
    expect(geminiReceipt?.snapshot.operationId).toBe("op-gemini-1");
    expect(geminiReceipt?.snapshot.providerId).toBe("gemini1");
    expect(geminiReceipt?.snapshot.status).toBe("completed");

    // Unspecified provider returns overall latest
    expect(latestSessionReceipt(db, caseId)?.snapshot.operationId).toBe("op-gemini-1");

    // Updating Codex does not alter Claude or Gemini
    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "checkpoint" },
        { operationId: "op-codex-2", caseId, providerId: "codex", sessionId: "sess-codex" }
      )
    );

    expect(latestSessionReceipt(db, caseId, "codex")?.snapshot.operationId).toBe("op-codex-2");
    expect(latestSessionReceipt(db, caseId, "claude")?.snapshot.operationId).toBe("op-claude-1");
    expect(latestSessionReceipt(db, caseId)?.snapshot.operationId).toBe("op-codex-2");

    // Missing provider returns null
    expect(latestSessionReceipt(db, caseId, "gemini2")).toBeNull();
  });
});

describe("workstation store — recovery idempotence", () => {
  it("marks previously active operations interrupted and preserves session identity without duplicates", () => {
    const case1 = openCase(db, { title: "Case 1", question: "q1" });
    const case2 = openCase(db, { title: "Case 2", question: "q2" });

    // Case 1: active codex, completed claude
    saveSessionReceipt(
      db,
      case1,
      makeReceipt(
        { event: "checkpoint" },
        { operationId: "op-c1-codex", caseId: case1, providerId: "codex", status: "running", sessionId: "resume-c1" }
      )
    );
    saveSessionReceipt(
      db,
      case1,
      makeReceipt(
        { event: "finish" },
        { operationId: "op-c1-claude", caseId: case1, providerId: "claude", status: "completed", sessionId: "done-claude" }
      )
    );

    // Case 2: active gemini needs-approval, stopped gemini2
    saveSessionReceipt(
      db,
      case2,
      makeReceipt(
        { event: "checkpoint" },
        {
          operationId: "op-c2-gem1",
          caseId: case2,
          providerId: "gemini1",
          status: "needs-approval",
          sessionId: "resume-gem1",
          permission: { id: "perm-1", title: "Run command", detail: "rm -rf build" }
        }
      )
    );
    saveSessionReceipt(
      db,
      case2,
      makeReceipt(
        { event: "finish" },
        { operationId: "op-c2-gem2", caseId: case2, providerId: "gemini2", status: "stopped", sessionId: "stopped-gem2" }
      )
    );

    const turnCountBefore = turnsFor(db, case1).length + turnsFor(db, case2).length;

    // First recovery pass: exactly 2 active operations should be interrupted
    const recovered = recoverInterruptedSessions(db, 5000);
    expect(recovered).toBe(2);

    const codexLatest = latestSessionReceipt(db, case1, "codex");
    expect(codexLatest?.event).toBe("interrupted");
    expect(codexLatest?.snapshot.status).toBe("interrupted");
    expect(codexLatest?.snapshot.sessionId).toBe("resume-c1");
    expect(codexLatest?.snapshot.updatedAt).toBe(5000);

    const claudeLatest = latestSessionReceipt(db, case1, "claude");
    expect(claudeLatest?.snapshot.status).toBe("completed");

    const gem1Latest = latestSessionReceipt(db, case2, "gemini1");
    expect(gem1Latest?.event).toBe("interrupted");
    expect(gem1Latest?.snapshot.status).toBe("interrupted");
    expect(gem1Latest?.snapshot.permission).toBeNull();
    expect(gem1Latest?.snapshot.sessionId).toBe("resume-gem1");

    const gem2Latest = latestSessionReceipt(db, case2, "gemini2");
    expect(gem2Latest?.snapshot.status).toBe("stopped");

    const turnCountAfterFirst = turnsFor(db, case1).length + turnsFor(db, case2).length;
    expect(turnCountAfterFirst).toBe(turnCountBefore + 2);

    // Second recovery pass: completely idempotent, 0 operations interrupted
    const recoveredSecond = recoverInterruptedSessions(db, 6000);
    expect(recoveredSecond).toBe(0);

    const turnCountAfterSecond = turnsFor(db, case1).length + turnsFor(db, case2).length;
    expect(turnCountAfterSecond).toBe(turnCountAfterFirst);
  });
});

describe("workstation store — corrupt records safe handling", () => {
  it("safely skips malformed JSON and invalid schema records without throwing", () => {
    const caseId = openCase(db, { title: "Corrupt records", question: "q" });

    // Initial valid codex turn
    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "start" },
        { operationId: "op-valid-codex", caseId, providerId: "codex", status: "starting" }
      )
    );

    // Insert broken JSON turn
    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, ?, ?, ?)`
    ).run("corrupt-turn-1", caseId, caseId, WORKSTATION_SESSION_SEAT, "receipt", "{ broken json ...", 2000);

    // Insert invalid receipt schema turn (wrong version)
    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, ?, ?, ?)`
    ).run(
      "corrupt-turn-2",
      caseId,
      caseId,
      WORKSTATION_SESSION_SEAT,
      "receipt",
      JSON.stringify({ version: 99, event: "checkpoint" }),
      2100
    );

    // Insert another valid claude turn
    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "checkpoint" },
        { operationId: "op-valid-claude", caseId, providerId: "claude", status: "running" }
      )
    );

    // Reading codex skips the two newer corrupt records and finds the valid codex turn
    expect(latestSessionReceipt(db, caseId, "codex")?.snapshot.operationId).toBe("op-valid-codex");
    // Reading claude returns the newest valid claude turn
    expect(latestSessionReceipt(db, caseId, "claude")?.snapshot.operationId).toBe("op-valid-claude");
    // Overall latest returns claude
    expect(latestSessionReceipt(db, caseId)?.snapshot.operationId).toBe("op-valid-claude");

    // Case containing only corrupt records safely returns null
    const emptyCorruptCase = openCase(db, { title: "only corrupt", question: "q" });
    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, ?, ?, ?)`
    ).run("corrupt-only", emptyCorruptCase, emptyCorruptCase, WORKSTATION_SESSION_SEAT, "receipt", "not-json", 3000);

    expect(latestSessionReceipt(db, emptyCorruptCase)).toBeNull();
  });
});

describe("workstation store — missing or closed cases", () => {
  it("rejects writes to non-existent, erased, and closed cases without recreating them", () => {
    const receipt = makeReceipt({}, { caseId: "missing-id" });

    expect(() => saveSessionReceipt(db, "missing-id", receipt)).toThrow(/does not exist/iu);
    expect(latestSessionReceipt(db, "missing-id")).toBeNull();

    // Closed case refuses new receipts
    const caseId = openCase(db, { title: "Closing case", question: "q" });
    saveSessionReceipt(db, caseId, makeReceipt({}, { caseId }));
    expect(latestSessionReceipt(db, caseId)).not.toBeNull();

    closeCase(db, caseId, { closedAs: "settled", verdict: "Finished work" });
    expect(() => saveSessionReceipt(db, caseId, makeReceipt({}, { caseId }))).toThrow(/closed/iu);

    // Reading closed case remains permitted
    expect(latestSessionReceipt(db, caseId)).not.toBeNull();

    // Erased case cleans up and rejects writes
    const toErase = openCase(db, { title: "To erase", question: "q" });
    saveSessionReceipt(db, toErase, makeReceipt({}, { caseId: toErase }));
    eraseCase(db, toErase);
    expect(latestSessionReceipt(db, toErase)).toBeNull();
    expect(() => saveSessionReceipt(db, toErase, makeReceipt({}, { caseId: toErase }))).toThrow(
      /does not exist/iu
    );
  });

  it("does not modify active sessions inside closed cases during recovery sweep", () => {
    const caseId = openCase(db, { title: "Case to close with active session", question: "q" });
    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "checkpoint" },
        { operationId: "op-active-closed", caseId, providerId: "codex", status: "running" }
      )
    );
    closeCase(db, caseId, { closedAs: "abandoned", verdict: "User abandoned case" });

    // Recovery sweep ignores closed cases (closed cases must not grow)
    const count = recoverInterruptedSessions(db, 7000);
    expect(count).toBe(0);
    expect(latestSessionReceipt(db, caseId, "codex")?.snapshot.status).toBe("running");
  });
});

describe("workstation store — size bounding and consistency", () => {
  it("bounds snapshot text and activity lengths without silent loss of case history", () => {
    const caseId = openCase(db, { title: "Bounded receipt", question: "q" });
    const hugeText = "X".repeat(MAX_RECEIPT_TEXT_LENGTH + 20_000);
    const manyActivities = Array.from({ length: 150 }, (_, i) => `Activity log line ${i}`);

    saveSessionReceipt(
      db,
      caseId,
      makeReceipt(
        { event: "checkpoint" },
        {
          operationId: "op-bounded",
          caseId,
          providerId: "gemini2",
          text: hugeText,
          activity: manyActivities
        }
      )
    );

    const read = latestSessionReceipt(db, caseId, "gemini2");
    expect(read).not.toBeNull();
    expect(read?.snapshot.text.length).toBe(MAX_RECEIPT_TEXT_LENGTH);
    expect(read?.snapshot.activity.length).toBe(MAX_RECEIPT_ACTIVITY_ITEMS);
    // Keeps the most recent activity lines
    expect(read?.snapshot.activity[read.snapshot.activity.length - 1]).toBe("Activity log line 149");
  });

  it("rejects inconsistent case IDs between argument and snapshot payload", () => {
    const caseA = openCase(db, { title: "Case A", question: "qA" });
    const caseB = openCase(db, { title: "Case B", question: "qB" });

    const mismatched = makeReceipt({}, { caseId: caseA });
    expect(() => saveSessionReceipt(db, caseB, mismatched)).toThrow(/inconsistent case id/iu);
  });

  it("keeps workstation session receipts out of compactor verbatim input", () => {
    const caseId = openCase(db, { title: "Compactor isolation", question: "q" });
    saveSessionReceipt(db, caseId, makeReceipt({}, { caseId }));

    const visibleToCompactor = verbatimFor(db, caseId, 0);
    expect(visibleToCompactor).toHaveLength(0);

    const turns = turnsFor(db, caseId);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.seat).toBe(WORKSTATION_SESSION_SEAT);
    expect(turns[0]?.kind).toBe("receipt");
  });
});

describe("workstation store — validator and active status helpers", () => {
  it("recognizes active statuses accurately", () => {
    expect(isActiveStatus("starting")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("needs-approval")).toBe(true);
    expect(isActiveStatus("stopping")).toBe(true);

    expect(isActiveStatus("completed")).toBe(false);
    expect(isActiveStatus("stopped")).toBe(false);
    expect(isActiveStatus("failed")).toBe(false);
    expect(isActiveStatus("interrupted")).toBe(false);
  });

  it("validates valid receipt objects and rejects invalid structures", () => {
    const valid = makeReceipt();
    expect(validateReceipt(valid)).not.toBeNull();

    expect(validateReceipt(null)).toBeNull();
    expect(validateReceipt("string")).toBeNull();
    expect(validateReceipt({ ...valid, version: 2 })).toBeNull();
    expect(validateReceipt({ ...valid, event: "delta" })).toBeNull();
    expect(validateReceipt({ ...valid, workspacePath: "" })).toBeNull();
    expect(validateReceipt({ ...valid, snapshot: { ...valid.snapshot, providerId: "unknown" } })).toBeNull();
    expect(validateReceipt({ ...valid, snapshot: { ...valid.snapshot, status: "unknown" } })).toBeNull();
    expect(validateReceipt({ ...valid, snapshot: { ...valid.snapshot, startedAt: Number.NaN } })).toBeNull();
  });
});
