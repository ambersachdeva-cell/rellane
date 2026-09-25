import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { closeCase, openCase } from "../book/cases.js";
import {
  cancelOccurrence,
  claimOccurrence,
  enqueueOccurrence,
  getOccurrence,
  listDueOccurrences,
  MAX_SCAN_ROWS,
  recoverCrashedOccurrences,
  recoverOccurrence,
  SCHEDULED_OCCURRENCE_PREFIX,
  SCHEDULED_OCCURRENCE_SEAT,
  settleOccurrence
} from "./scheduled-occurrence-store.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE work_case (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      closed_as TEXT CHECK (closed_as IN ('settled', 'abandoned', 'dropped')),
      verdict TEXT,
      CHECK ((closed_at IS NULL) = (closed_as IS NULL))
    );

    CREATE TABLE case_turn (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      seat TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('verbatim', 'finding', 'receipt', 'compacted')),
      body TEXT NOT NULL,
      at INTEGER NOT NULL,
      compacted_from TEXT,
      UNIQUE (case_id, seq),
      CHECK ((kind = 'compacted') = (compacted_from IS NOT NULL))
    );

    CREATE TABLE workstation_project (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE workstation_project_revision (
      project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, revision)
    );

    CREATE TABLE workstation_project_link (
      case_id TEXT PRIMARY KEY REFERENCES work_case (id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function linkCaseToProject(
  db: DatabaseSync,
  caseId: string,
  projectId: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workstation_project (id, created_at) VALUES (?, ?)`
  ).run(projectId, Date.now());

  db.prepare(
    `INSERT OR IGNORE INTO workstation_project_revision (project_id, revision, title, brief, created_at)
     VALUES (?, 1, ?, ?, ?)`
  ).run(projectId, `Project ${projectId}`, `Brief for ${projectId}`, Date.now());

  db.prepare(`DELETE FROM workstation_project_link WHERE case_id = ?`).run(caseId);
  db.prepare(
    `INSERT INTO workstation_project_link (case_id, project_id, created_at)
     VALUES (?, ?, ?)`
  ).run(caseId, projectId, Date.now());
}

describe("ScheduledOccurrenceStore", () => {
  it("atomically enqueues an occurrence idempotently and rejects changed spec/scope", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Billing audit", question: "Check late fees" });
    linkCaseToProject(db, caseId, "proj-alpha");

    const spec = {
      scheduleId: "daily-sync",
      definitionRevision: 1,
      occurrenceId: "occ-100",
      caseId,
      projectId: "proj-alpha",
      dueAt: 1000,
      reviewedGrantRef: "grant-ref-alpha",
      instructionHash: "hash-001",
      enqueuedAt: 500
    };

    const first = enqueueOccurrence(db, spec);
    expect(first.enqueued).toBe(true);
    expect(first.occurrenceId).toBe("occ-100");
    expect(first.status).toBe("queued");
    expect(first.terminal).toBe(false);

    const duplicateExact = enqueueOccurrence(db, spec);
    expect(duplicateExact.enqueued).toBe(false);
    expect(duplicateExact.occurrenceId).toBe("occ-100");
    expect(duplicateExact.status).toBe("queued");

    expect(() =>
      enqueueOccurrence(db, {
        ...spec,
        dueAt: 1001
      })
    ).toThrow(/Occurrence collision/);

    expect(() =>
      enqueueOccurrence(db, {
        ...spec,
        projectId: "proj-beta"
      })
    ).toThrow(/Project mismatch/);

    expect(() =>
      enqueueOccurrence(db, {
        ...spec,
        instructionHash: "hash-differing"
      })
    ).toThrow(/Occurrence collision/);
  });

  it("prevents duplicate claims and enforces due date admission", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Operations", question: "Dispatch inventory" });

    enqueueOccurrence(db, {
      scheduleId: "sched-1",
      definitionRevision: 1,
      occurrenceId: "occ-due",
      caseId,
      projectId: null,
      dueAt: 2000,
      reviewedGrantRef: "grant-ops",
      instructionHash: "hash-ops",
      enqueuedAt: 1000
    });

    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-due",
        asOf: 1999,
        claimedAt: 1999
      })
    ).toThrow(/is not due yet/);

    const claim = claimOccurrence(db, {
      occurrenceId: "occ-due",
      asOf: 2000,
      claimedAt: 2000
    });
    expect(claim.claimId.length).toBeGreaterThan(0);
    expect(claim.status).toBe("claimed");
    expect(claim.terminal).toBe(false);

    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-due",
        asOf: 2500,
        claimedAt: 2500
      })
    ).toThrow(/Duplicate claims rejected/);
  });

  it("recovers crashed unsettled claims as uncertain and does not auto replay", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Data ETL", question: "Process batch" });
    linkCaseToProject(db, caseId, "proj-etl");

    enqueueOccurrence(db, {
      scheduleId: "etl-hourly",
      definitionRevision: 2,
      occurrenceId: "occ-crash",
      caseId,
      projectId: "proj-etl",
      dueAt: 3000,
      reviewedGrantRef: "grant-etl",
      instructionHash: "hash-etl",
      enqueuedAt: 2000
    });

    const claim = claimOccurrence(db, {
      occurrenceId: "occ-crash",
      asOf: 3000,
      claimedAt: 3000
    });
    expect(claim.status).toBe("claimed");

    const dueWhileClaimed = listDueOccurrences(db, { asOf: 5000 });
    expect(dueWhileClaimed.length).toBe(0);

    const recovered = recoverOccurrence(db, "occ-crash", {
      at: 4000,
      detail: "Process terminated unexpectedly"
    });
    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe("uncertain");
    expect(recovered?.outcome).toBe("uncertain");
    expect(recovered?.terminal).toBe(true);
    expect(recovered?.settledAt).toBe(4000);
    expect(recovered?.detail).toBe("Process terminated unexpectedly");

    const dueAfterRecovery = listDueOccurrences(db, { asOf: 5000 });
    expect(dueAfterRecovery.length).toBe(0);

    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-crash",
        asOf: 5000,
        claimedAt: 5000
      })
    ).toThrow(/already terminal/);
  });

  it("supports batch crashed claim recovery across occurrences", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Telemetry", question: "Recover batch" });
    linkCaseToProject(db, caseId, "proj-batch");

    enqueueOccurrence(db, {
      scheduleId: "cron-1",
      definitionRevision: 1,
      occurrenceId: "occ-batch-1",
      caseId,
      projectId: "proj-batch",
      dueAt: 1000,
      reviewedGrantRef: "ref-1",
      instructionHash: "hash-1"
    });

    enqueueOccurrence(db, {
      scheduleId: "cron-2",
      definitionRevision: 1,
      occurrenceId: "occ-batch-2",
      caseId,
      projectId: "proj-batch",
      dueAt: 1000,
      reviewedGrantRef: "ref-2",
      instructionHash: "hash-2"
    });

    claimOccurrence(db, { occurrenceId: "occ-batch-1", asOf: 1000 });
    claimOccurrence(db, { occurrenceId: "occ-batch-2", asOf: 1000 });

    const recoveredList = recoverCrashedOccurrences(db, {
      projectId: "proj-batch",
      at: 2000
    });

    expect(recoveredList.length).toBe(2);
    expect(recoveredList.every((r) => r.status === "uncertain")).toBe(true);
    expect(recoveredList.every((r) => r.terminal === true)).toBe(true);

    const due = listDueOccurrences(db, { asOf: 5000 });
    expect(due.length).toBe(0);
  });

  it("handles cancellation of queued occurrences and settles with stopped", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Order processing", question: "Cancel stale orders" });

    enqueueOccurrence(db, {
      scheduleId: "order-sweep",
      definitionRevision: 1,
      occurrenceId: "occ-cancel",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "grant-order",
      instructionHash: "hash-order"
    });

    const cancelRes = cancelOccurrence(db, {
      occurrenceId: "occ-cancel",
      cancelledAt: 1050,
      reason: "Owner requested cancellation"
    });
    expect(cancelRes.cancelled).toBe(true);
    expect(cancelRes.status).toBe("cancelled");
    expect(cancelRes.terminal).toBe(true);
    expect(cancelRes.cancelReason).toBe("Owner requested cancellation");

    const cancelRepeat = cancelOccurrence(db, { occurrenceId: "occ-cancel" });
    expect(cancelRepeat.cancelled).toBe(false);
    expect(cancelRepeat.alreadyCancelled).toBe(true);

    const due = listDueOccurrences(db, { asOf: 2000 });
    expect(due.length).toBe(0);

    expect(() => claimOccurrence(db, { occurrenceId: "occ-cancel", asOf: 2000 })).toThrow(
      /is cancelled/
    );

    enqueueOccurrence(db, {
      scheduleId: "order-sweep",
      definitionRevision: 1,
      occurrenceId: "occ-stop",
      caseId,
      projectId: null,
      dueAt: 1200,
      reviewedGrantRef: "grant-order",
      instructionHash: "hash-order"
    });

    const claimStop = claimOccurrence(db, { occurrenceId: "occ-stop", asOf: 1200 });
    expect(() => cancelOccurrence(db, { occurrenceId: "occ-stop" })).toThrow(
      /only queued occurrences may be cancelled/
    );

    const stopRes = settleOccurrence(db, {
      occurrenceId: "occ-stop",
      claimId: claimStop.claimId,
      outcome: "stopped",
      settledAt: 1300,
      detail: "Gracefully stopped before effect execution"
    });
    expect(stopRes.status).toBe("stopped");
    expect(stopRes.terminal).toBe(true);
    expect(stopRes.outcome).toBe("stopped");

    expect(listDueOccurrences(db, { asOf: 2000 }).length).toBe(0);
  });

  it("settles explicit completed, failed, and uncertain terminal receipts keyed by claimId", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Settlements", question: "Verify settlement outcomes" });
    linkCaseToProject(db, caseId, "proj-1");

    enqueueOccurrence(db, {
      scheduleId: "sched-work",
      definitionRevision: 1,
      occurrenceId: "occ-comp",
      caseId,
      projectId: "proj-1",
      dueAt: 1000,
      reviewedGrantRef: "ref-c",
      instructionHash: "hash-c"
    });

    const claimComp = claimOccurrence(db, { occurrenceId: "occ-comp", asOf: 1000 });

    expect(() =>
      settleOccurrence(db, {
        occurrenceId: "occ-comp",
        claimId: randomUUID(),
        outcome: "completed"
      })
    ).toThrow(/claimId mismatch/);

    const settledComp = settleOccurrence(db, {
      occurrenceId: "occ-comp",
      claimId: claimComp.claimId,
      outcome: "completed",
      settledAt: 1100,
      detail: "Generated report"
    });
    expect(settledComp.status).toBe("completed");
    expect(settledComp.terminal).toBe(true);

    expect(() =>
      settleOccurrence(db, {
        occurrenceId: "occ-comp",
        claimId: claimComp.claimId,
        outcome: "completed"
      })
    ).toThrow(/already settled/);

    enqueueOccurrence(db, {
      scheduleId: "sched-work",
      definitionRevision: 1,
      occurrenceId: "occ-fail",
      caseId,
      projectId: "proj-1",
      dueAt: 1000,
      reviewedGrantRef: "ref-f",
      instructionHash: "hash-f"
    });

    const claimFail = claimOccurrence(db, { occurrenceId: "occ-fail", asOf: 1000 });
    const settledFail = settleOccurrence(db, {
      occurrenceId: "occ-fail",
      claimId: claimFail.claimId,
      outcome: "failed",
      settledAt: 1150,
      detail: "Network connection timeout"
    });
    expect(settledFail.status).toBe("failed");
    expect(settledFail.terminal).toBe(true);

    enqueueOccurrence(db, {
      scheduleId: "sched-work",
      definitionRevision: 1,
      occurrenceId: "occ-unc",
      caseId,
      projectId: "proj-1",
      dueAt: 1000,
      reviewedGrantRef: "ref-u",
      instructionHash: "hash-u"
    });

    const claimUnc = claimOccurrence(db, { occurrenceId: "occ-unc", asOf: 1000 });
    const settledUnc = settleOccurrence(db, {
      occurrenceId: "occ-unc",
      claimId: claimUnc.claimId,
      outcome: "uncertain",
      settledAt: 1200,
      detail: "Host dropped acknowledgment"
    });
    expect(settledUnc.status).toBe("uncertain");
    expect(settledUnc.terminal).toBe(true);

    const due = listDueOccurrences(db, { asOf: 5000 });
    expect(due.length).toBe(0);
  });

  it("orders due occurrences deterministically and respects bounds and limits", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Queue priority", question: "Order due items" });

    enqueueOccurrence(db, {
      scheduleId: "order-test",
      definitionRevision: 1,
      occurrenceId: "occ-c",
      caseId,
      projectId: null,
      dueAt: 300,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 50
    });

    enqueueOccurrence(db, {
      scheduleId: "order-test",
      definitionRevision: 1,
      occurrenceId: "occ-a",
      caseId,
      projectId: null,
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 50
    });

    enqueueOccurrence(db, {
      scheduleId: "order-test",
      definitionRevision: 1,
      occurrenceId: "occ-b2",
      caseId,
      projectId: null,
      dueAt: 200,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 70
    });

    enqueueOccurrence(db, {
      scheduleId: "order-test",
      definitionRevision: 1,
      occurrenceId: "occ-b1",
      caseId,
      projectId: null,
      dueAt: 200,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 60
    });

    enqueueOccurrence(db, {
      scheduleId: "order-test",
      definitionRevision: 1,
      occurrenceId: "occ-future",
      caseId,
      projectId: null,
      dueAt: 500,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 50
    });

    const dueUntil250 = listDueOccurrences(db, { asOf: 250 });
    expect(dueUntil250.map((o) => o.occurrenceId)).toEqual(["occ-a", "occ-b1", "occ-b2"]);

    const limited = listDueOccurrences(db, { asOf: 400, limit: 2 });
    expect(limited.map((o) => o.occurrenceId)).toEqual(["occ-a", "occ-b1"]);
  });

  it("enforces strict project and case isolation without leakage", () => {
    const db = createTestDb();
    const case1 = openCase(db, { title: "Case One", question: "Work in case 1" });
    const case2 = openCase(db, { title: "Case Two", question: "Work in case 2" });
    const case3 = openCase(db, { title: "Case Three", question: "Work in case 3" });
    const case4 = openCase(db, { title: "Case Four", question: "Work in case 4" });

    linkCaseToProject(db, case1, "proj-1");
    linkCaseToProject(db, case2, "proj-2");
    linkCaseToProject(db, case4, "proj-1");

    enqueueOccurrence(db, {
      scheduleId: "sched-iso",
      definitionRevision: 1,
      occurrenceId: "occ-p1-c1",
      caseId: case1,
      projectId: "proj-1",
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    enqueueOccurrence(db, {
      scheduleId: "sched-iso",
      definitionRevision: 1,
      occurrenceId: "occ-p2-c2",
      caseId: case2,
      projectId: "proj-2",
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    enqueueOccurrence(db, {
      scheduleId: "sched-iso",
      definitionRevision: 1,
      occurrenceId: "occ-null-c3",
      caseId: case3,
      projectId: null,
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    enqueueOccurrence(db, {
      scheduleId: "sched-iso",
      definitionRevision: 1,
      occurrenceId: "occ-p1-c4",
      caseId: case4,
      projectId: "proj-1",
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    const proj1Occurrences = listDueOccurrences(db, { asOf: 200, projectId: "proj-1" });
    expect(proj1Occurrences.map((o) => o.occurrenceId)).toEqual(["occ-p1-c1", "occ-p1-c4"]);

    const proj1Case1Only = listDueOccurrences(db, {
      asOf: 200,
      caseId: case1,
      projectId: "proj-1"
    });
    expect(proj1Case1Only.map((o) => o.occurrenceId)).toEqual(["occ-p1-c1"]);

    const nullProjectOnly = listDueOccurrences(db, { asOf: 200, projectId: null });
    expect(nullProjectOnly.map((o) => o.occurrenceId)).toEqual(["occ-null-c3"]);
  });

  it("respects SQLite transaction nesting without double BEGIN failures", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Nesting", question: "Test savepoints" });
    linkCaseToProject(db, caseId, "proj-nest");

    db.exec("BEGIN IMMEDIATE");

    const enqueued = enqueueOccurrence(db, {
      scheduleId: "sched-nest",
      definitionRevision: 1,
      occurrenceId: "occ-nested",
      caseId,
      projectId: "proj-nest",
      dueAt: 1000,
      reviewedGrantRef: "ref-nest",
      instructionHash: "hash-nest"
    });
    expect(enqueued.occurrenceId).toBe("occ-nested");

    const claim = claimOccurrence(db, {
      occurrenceId: "occ-nested",
      asOf: 1000
    });
    expect(claim.claimId.length).toBeGreaterThan(0);

    db.exec("COMMIT");

    const stored = getOccurrence(db, "occ-nested");
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("claimed");

    const caseId2 = openCase(db, { title: "Rollback case", question: "Test rollback" });
    db.exec("BEGIN IMMEDIATE");
    enqueueOccurrence(db, {
      scheduleId: "sched-nest",
      definitionRevision: 1,
      occurrenceId: "occ-rollback",
      caseId: caseId2,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref-rb",
      instructionHash: "hash-rb"
    });
    db.exec("ROLLBACK");

    expect(getOccurrence(db, "occ-rollback")).toBeNull();
  });

  it("refuses operations on closed cases and persists only safe metadata", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Lifecycle", question: "Close behavior" });
    linkCaseToProject(db, caseId, "proj-safe");

    enqueueOccurrence(db, {
      scheduleId: "sched-safe",
      definitionRevision: 1,
      occurrenceId: "occ-safe",
      caseId,
      projectId: "proj-safe",
      dueAt: 1000,
      reviewedGrantRef: "reviewed-grant-id-998",
      instructionHash: "hash-instruction-abc"
    });

    const rows = db
      .prepare(`SELECT body FROM case_turn WHERE seat = ? AND body LIKE ?`)
      .all(SCHEDULED_OCCURRENCE_SEAT, "%occ-safe%") as unknown as readonly { readonly body: string }[];

    expect(rows.length).toBe(1);
    expect(rows[0]!.body.includes("reviewed-grant-id-998")).toBe(true);
    expect(rows[0]!.body.includes("hash-instruction-abc")).toBe(true);
    expect(rows[0]!.body.includes("secret")).toBe(false);
    expect(rows[0]!.body.includes("password")).toBe(false);
    expect(rows[0]!.body.includes("Bearer")).toBe(false);

    closeCase(db, caseId, { closedAs: "settled", verdict: "Task complete" });

    expect(() =>
      enqueueOccurrence(db, {
        scheduleId: "sched-safe",
        definitionRevision: 1,
        occurrenceId: "occ-new-in-closed",
        caseId,
        projectId: null,
        dueAt: 2000,
        reviewedGrantRef: "ref",
        instructionHash: "hash"
      })
    ).toThrow(/is closed/);

    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-safe",
        asOf: 1000
      })
    ).toThrow(/closed case/);

    const dueInClosed = listDueOccurrences(db, { asOf: 2000 });
    expect(dueInClosed.length).toBe(0);
  });

  it("fails closed on malformed matching receipt/event and rejects duplicate corruption", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Corruption", question: "Fail closed on corruption" });

    enqueueOccurrence(db, {
      scheduleId: "sched-corrupt",
      definitionRevision: 1,
      occurrenceId: "occ-corrupt",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref-corrupt",
      instructionHash: "hash-corrupt"
    });

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-corrupt:{"invalid_json":`,
      2000
    );

    expect(() =>
      enqueueOccurrence(db, {
        scheduleId: "sched-corrupt",
        definitionRevision: 1,
        occurrenceId: "occ-corrupt",
        caseId,
        projectId: null,
        dueAt: 1000,
        reviewedGrantRef: "ref-corrupt",
        instructionHash: "hash-corrupt"
      })
    ).toThrow(/Corrupted occurrence event/);

    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-corrupt",
        asOf: 3000
      })
    ).toThrow(/Corrupted occurrence event/);

    expect(() => getOccurrence(db, "occ-corrupt")).toThrow(/Corrupted occurrence event/);
    expect(() => listDueOccurrences(db, { asOf: 5000 })).toThrow(/Corrupted occurrence event/);

    const case2 = openCase(db, { title: "Schema corruption", question: "Schema mismatch turn" });
    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, 1, ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      case2,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-bad-schema:{"version":1,"event":"unknown_event"}`,
      1000
    );

    expect(() => getOccurrence(db, "occ-bad-schema")).toThrow(/Corrupted occurrence event/);
  });

  it("rejects an occurrence-seat receipt with a damaged prefix during the global queue scan", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Damaged queue", question: "Check receipts" });
    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, 1, ?, 'receipt', ?, ?)`
    ).run(randomUUID(), caseId, SCHEDULED_OCCURRENCE_SEAT, "DamagedOccurrence:occ-one:{}", 1000);

    expect(() => listDueOccurrences(db, { asOf: 2000 })).toThrow(/unexpected body prefix/);
    expect(() => recoverCrashedOccurrences(db, { at: 2000 })).toThrow(/unexpected body prefix/);
  });

  it("rejects schedule and occurrence IDs containing wildcards, colons, or invalid characters", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "ID Validation", question: "Validate identifier characters" });

    const baseSpec = {
      scheduleId: "valid-sched",
      definitionRevision: 1,
      occurrenceId: "valid-occ",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    };

    expect(() =>
      enqueueOccurrence(db, {
        ...baseSpec,
        occurrenceId: "occ%wildcard"
      })
    ).toThrow();

    expect(() =>
      enqueueOccurrence(db, {
        ...baseSpec,
        occurrenceId: "occ_wildcard"
      })
    ).toThrow();

    expect(() =>
      enqueueOccurrence(db, {
        ...baseSpec,
        occurrenceId: "occ:colon"
      })
    ).toThrow();

    expect(() =>
      enqueueOccurrence(db, {
        ...baseSpec,
        scheduleId: "sched%wildcard"
      })
    ).toThrow();

    expect(() =>
      enqueueOccurrence(db, {
        ...baseSpec,
        scheduleId: "sched_wildcard"
      })
    ).toThrow();

    expect(() =>
      enqueueOccurrence(db, {
        ...baseSpec,
        scheduleId: "sched:colon"
      })
    ).toThrow();

    expect(() => claimOccurrence(db, { occurrenceId: "occ%wildcard" })).toThrow();
    expect(() =>
      settleOccurrence(db, {
        occurrenceId: "occ_wildcard",
        claimId: randomUUID(),
        outcome: "completed"
      })
    ).toThrow();
    expect(() => cancelOccurrence(db, { occurrenceId: "occ:colon" })).toThrow();
    expect(() => getOccurrence(db, "occ%wildcard")).toThrow();
    expect(() => recoverOccurrence(db, "occ:colon")).toThrow();
  });

  it("streams more than 1,000 terminal receipts while recovering only active claims", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Long history", question: "Keep the queue live" });

    const insert = db.prepare(
        `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
         VALUES (?, ?, ?, ?, 'receipt', ?, ?)`
      );
    for (let i = 0; i < MAX_SCAN_ROWS + 1; i++) {
      const id = `occ-fill-${i}`;
      for (const [index, payload] of [
        { version: 1, event: "enqueued", occurrenceId: id, scheduleId: "sched",
          definitionRevision: 1, caseId, projectId: null, dueAt: 1000,
          reviewedGrantRef: "r", instructionHash: "h", enqueuedAt: 500 },
        { version: 1, event: "cancelled", occurrenceId: id, cancelledAt: 1100 }
      ].entries()) {
        insert.run(randomUUID(), caseId, 2 * i + index + 1, SCHEDULED_OCCURRENCE_SEAT,
          `${SCHEDULED_OCCURRENCE_PREFIX}${id}:${JSON.stringify(payload)}`, 1000 + i);
      }
    }
    enqueueOccurrence(db, { scheduleId: "sched", definitionRevision: 1,
      occurrenceId: "occ-queued", caseId, projectId: null, dueAt: 1000,
      reviewedGrantRef: "r", instructionHash: "h" });
    enqueueOccurrence(db, { scheduleId: "sched", definitionRevision: 1,
      occurrenceId: "occ-claimed", caseId, projectId: null, dueAt: 1000,
      reviewedGrantRef: "r", instructionHash: "h" });
    claimOccurrence(db, { occurrenceId: "occ-claimed", asOf: 2000 });
    expect(listDueOccurrences(db, { asOf: 5000 })).toMatchObject([{ occurrenceId: "occ-queued" }]);
    insert.run(randomUUID(), caseId, 3000, SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-zzzz:{"version":1,"event":"cancelled","occurrenceId":"wrong-id","cancelledAt":5002}`,
      5002);
    expect(() => listDueOccurrences(db, { asOf: 5002, limit: 1 })).toThrow(/does not match receipt/);
    expect(() => recoverCrashedOccurrences(db, { at: 5002 })).toThrow(/does not match receipt/);
    expect(getOccurrence(db, "occ-claimed")?.status).toBe("claimed");
    db.prepare("DELETE FROM case_turn WHERE seat = ? AND seq = ?")
      .run(SCHEDULED_OCCURRENCE_SEAT, 3000);
    expect(recoverCrashedOccurrences(db, { at: 5000 })).toMatchObject([
      { occurrenceId: "occ-claimed", status: "uncertain" }
    ]);
    expect(recoverCrashedOccurrences(db, { at: 5001 })).toHaveLength(0);

    const freshDb = createTestDb();
    const freshCase = openCase(freshDb, { title: "Small scan", question: "Test limit visibility" });

    enqueueOccurrence(freshDb, {
      scheduleId: "sched",
      definitionRevision: 1,
      occurrenceId: "occ-earlier",
      caseId: freshCase,
      projectId: null,
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    enqueueOccurrence(freshDb, {
      scheduleId: "sched",
      definitionRevision: 1,
      occurrenceId: "occ-later",
      caseId: freshCase,
      projectId: null,
      dueAt: 200,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    cancelOccurrence(freshDb, { occurrenceId: "occ-earlier" });

    const dueList = listDueOccurrences(freshDb, { asOf: 300, limit: 1 });
    expect(dueList.length).toBe(1);
    expect(dueList[0]!.occurrenceId).toBe("occ-later");
  });

  it("retains a per-occurrence hard bound even while global history streams", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "One huge history", question: "Bound one ID" });
    const payload = { version: 1, event: "enqueued", occurrenceId: "occ-huge",
      scheduleId: "sched", definitionRevision: 1, caseId, projectId: null,
      dueAt: 1000, reviewedGrantRef: "r", instructionHash: "h", enqueuedAt: 500 };
    const insert = db.prepare(`INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
      VALUES (?, ?, ?, ?, 'receipt', ?, ?)`);
    for (let index = 0; index <= MAX_SCAN_ROWS; index += 1) {
      insert.run(randomUUID(), caseId, index + 1, SCHEDULED_OCCURRENCE_SEAT,
        `${SCHEDULED_OCCURRENCE_PREFIX}occ-huge:${JSON.stringify(payload)}`, 1000 + index);
    }
    expect(() => getOccurrence(db, "occ-huge")).toThrow(/Occurrence scan exceeded hard cap/);
    expect(() => listDueOccurrences(db, { asOf: 5000 })).toThrow(/Occurrence scan exceeded hard cap/);
    expect(() => recoverCrashedOccurrences(db, { at: 5000 })).toThrow(/Occurrence scan exceeded hard cap/);
  });

  it("validates projectId against current projectForWork and rejects mismatches", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Project Validation", question: "Validate project bindings" });
    linkCaseToProject(db, caseId, "proj-assigned");

    expect(() =>
      enqueueOccurrence(db, {
        scheduleId: "sched-p",
        definitionRevision: 1,
        occurrenceId: "occ-p-mismatch",
        caseId,
        projectId: "proj-other",
        dueAt: 1000,
        reviewedGrantRef: "ref",
        instructionHash: "hash"
      })
    ).toThrow(/Project mismatch/);

    expect(() =>
      enqueueOccurrence(db, {
        scheduleId: "sched-p",
        definitionRevision: 1,
        occurrenceId: "occ-p-null",
        caseId,
        projectId: null,
        dueAt: 1000,
        reviewedGrantRef: "ref",
        instructionHash: "hash"
      })
    ).toThrow(/Project mismatch/);

    const enqueued = enqueueOccurrence(db, {
      scheduleId: "sched-p",
      definitionRevision: 1,
      occurrenceId: "occ-p-assigned",
      caseId,
      projectId: "proj-assigned",
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });
    expect(enqueued.enqueued).toBe(true);

    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-p-assigned",
        projectId: "proj-other",
        asOf: 1000
      })
    ).toThrow(/Cannot claim occurrence/);

    linkCaseToProject(db, caseId, "proj-changed");
    expect(() =>
      claimOccurrence(db, {
        occurrenceId: "occ-p-assigned",
        asOf: 1000
      })
    ).toThrow(/Cannot claim occurrence/);
  });

  it("ensures crash recovery produces uncertain terminal outcome with idempotent no-replay", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Recovery", question: "Crash recovery idempotency" });

    enqueueOccurrence(db, {
      scheduleId: "sched-rec",
      definitionRevision: 1,
      occurrenceId: "occ-rec-test",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    const claimed = claimOccurrence(db, { occurrenceId: "occ-rec-test", asOf: 1000 });
    expect(claimed.status).toBe("claimed");

    const firstRecovery = recoverOccurrence(db, "occ-rec-test", {
      at: 1500,
      detail: "Unexpected process kill"
    });
    expect(firstRecovery).not.toBeNull();
    expect(firstRecovery?.status).toBe("uncertain");
    expect(firstRecovery?.terminal).toBe(true);

    const secondRecovery = recoverOccurrence(db, "occ-rec-test", { at: 2000 });
    expect(secondRecovery?.status).toBe("uncertain");
    expect(secondRecovery?.settledAt).toBe(1500);

    const batchRecovered = recoverCrashedOccurrences(db);
    expect(batchRecovered.length).toBe(0);

    const due = listDueOccurrences(db, { asOf: 5000 });
    expect(due.length).toBe(0);

    expect(() =>
      claimOccurrence(db, { occurrenceId: "occ-rec-test", asOf: 5000 })
    ).toThrow(/already terminal/);

    expect(() =>
      settleOccurrence(db, {
        occurrenceId: "occ-rec-test",
        claimId: claimed.claimId,
        outcome: "completed"
      })
    ).toThrow(/already settled/);
  });

  it("rejects corrupted history where occurrence is settled without a claim", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Settlement Without Claim", question: "Fail closed" });

    enqueueOccurrence(db, {
      scheduleId: "sched-no-claim",
      definitionRevision: 1,
      occurrenceId: "occ-no-claim",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    const settledPayload = {
      version: 1,
      event: "settled",
      occurrenceId: "occ-no-claim",
      claimId: randomUUID(),
      outcome: "completed",
      settledAt: 2000
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-no-claim:${JSON.stringify(settledPayload)}`,
      2000
    );

    expect(() => getOccurrence(db, "occ-no-claim")).toThrow(/settlement without claim/i);
    expect(() => listDueOccurrences(db, { asOf: 5000 })).toThrow(/settlement without claim/i);
  });

  it("rejects corrupted history with settlement claimId mismatch", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Claim ID Mismatch", question: "Fail closed" });

    enqueueOccurrence(db, {
      scheduleId: "sched-mismatch",
      definitionRevision: 1,
      occurrenceId: "occ-mismatch",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    claimOccurrence(db, { occurrenceId: "occ-mismatch", asOf: 1000 });

    const mismatchedSettledPayload = {
      version: 1,
      event: "settled",
      occurrenceId: "occ-mismatch",
      claimId: randomUUID(),
      outcome: "completed",
      settledAt: 2000
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-mismatch:${JSON.stringify(mismatchedSettledPayload)}`,
      2000
    );

    expect(() => getOccurrence(db, "occ-mismatch")).toThrow(/claimId mismatch/i);
    expect(() => listDueOccurrences(db, { asOf: 5000 })).toThrow(/claimId mismatch/i);
  });

  it("rejects contradictory history having cancelled with claimed or settled receipts", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Contradictory Cancel", question: "Fail closed" });

    enqueueOccurrence(db, {
      scheduleId: "sched-contra-claim",
      definitionRevision: 1,
      occurrenceId: "occ-contra-claim",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    claimOccurrence(db, { occurrenceId: "occ-contra-claim", asOf: 1000 });

    const cancelPayload = {
      version: 1,
      event: "cancelled",
      occurrenceId: "occ-contra-claim",
      cancelledAt: 1500,
      reason: "Contradictory cancellation"
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-contra-claim:${JSON.stringify(cancelPayload)}`,
      1500
    );

    expect(() => getOccurrence(db, "occ-contra-claim")).toThrow(/contradictory/i);
    expect(() => listDueOccurrences(db, { asOf: 5000 })).toThrow(/contradictory/i);

    enqueueOccurrence(db, {
      scheduleId: "sched-contra-settle",
      definitionRevision: 1,
      occurrenceId: "occ-contra-settle",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    const claimed = claimOccurrence(db, { occurrenceId: "occ-contra-settle", asOf: 1000 });
    settleOccurrence(db, {
      occurrenceId: "occ-contra-settle",
      claimId: claimed.claimId,
      outcome: "completed"
    });

    const cancelSettlePayload = {
      version: 1,
      event: "cancelled",
      occurrenceId: "occ-contra-settle",
      cancelledAt: 2500
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-contra-settle:${JSON.stringify(cancelSettlePayload)}`,
      2500
    );

    expect(() => getOccurrence(db, "occ-contra-settle")).toThrow(/contradictory/i);
  });

  it("rejects conflicting duplicate cancellations but preserves idempotent repeated equal cancellations", () => {
    const db = createTestDb();
    const caseId = openCase(db, { title: "Duplicate Cancellations", question: "Fail closed on conflict" });

    enqueueOccurrence(db, {
      scheduleId: "sched-dup-cancel",
      definitionRevision: 1,
      occurrenceId: "occ-dup-cancel",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    cancelOccurrence(db, {
      occurrenceId: "occ-dup-cancel",
      cancelledAt: 1050,
      reason: "Initial cancel"
    });

    const conflictingCancelPayload = {
      version: 1,
      event: "cancelled",
      occurrenceId: "occ-dup-cancel",
      cancelledAt: 1050,
      reason: "Different conflicting cancel reason"
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-dup-cancel:${JSON.stringify(conflictingCancelPayload)}`,
      1050
    );

    expect(() => getOccurrence(db, "occ-dup-cancel")).toThrow(/conflicting cancellations/i);

    enqueueOccurrence(db, {
      scheduleId: "sched-equal-cancel",
      definitionRevision: 1,
      occurrenceId: "occ-equal-cancel",
      caseId,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    cancelOccurrence(db, {
      occurrenceId: "occ-equal-cancel",
      cancelledAt: 1050,
      reason: "Idempotent reason"
    });

    const identicalCancelPayload = {
      version: 1,
      event: "cancelled",
      occurrenceId: "occ-equal-cancel",
      cancelledAt: 1050,
      reason: "Idempotent reason"
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      caseId,
      caseId,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-equal-cancel:${JSON.stringify(identicalCancelPayload)}`,
      1050
    );

    const record = getOccurrence(db, "occ-equal-cancel");
    expect(record).not.toBeNull();
    expect(record?.status).toBe("cancelled");
    expect(record?.cancelReason).toBe("Idempotent reason");
  });

  it("fails closed on cross-case receipt attribution and validates case linkage regardless of physical order", () => {
    const db = createTestDb();
    const case1 = openCase(db, { title: "Case 1", question: "Work 1" });
    const case2 = openCase(db, { title: "Case 2", question: "Work 2" });

    enqueueOccurrence(db, {
      scheduleId: "sched-cross",
      definitionRevision: 1,
      occurrenceId: "occ-cross",
      caseId: case1,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash"
    });

    const claimInCase2Payload = {
      version: 1,
      event: "claimed",
      occurrenceId: "occ-cross",
      claimId: randomUUID(),
      claimedAt: 1100
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      case2,
      case2,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-cross:${JSON.stringify(claimInCase2Payload)}`,
      1100
    );

    expect(() => getOccurrence(db, "occ-cross")).toThrow(/cross-case/i);
    expect(() => listDueOccurrences(db, { asOf: 5000 })).toThrow(/cross-case/i);

    const badPayload = {
      version: 1,
      event: "enqueued",
      occurrenceId: "occ-payload-mismatch",
      scheduleId: "sched-cross",
      definitionRevision: 1,
      caseId: case2,
      projectId: null,
      dueAt: 1000,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 500
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      case1,
      case1,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-payload-mismatch:${JSON.stringify(badPayload)}`,
      500
    );

    expect(() => getOccurrence(db, "occ-payload-mismatch")).toThrow(/cross-case/i);

    const claimEarlyPayload = {
      version: 1,
      event: "claimed",
      occurrenceId: "occ-reorder",
      claimId: randomUUID(),
      claimedAt: 200
    };

    const enqueuedLatePayload = {
      version: 1,
      event: "enqueued",
      occurrenceId: "occ-reorder",
      scheduleId: "sched-cross",
      definitionRevision: 1,
      caseId: case1,
      projectId: null,
      dueAt: 100,
      reviewedGrantRef: "ref",
      instructionHash: "hash",
      enqueuedAt: 300
    };

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      case1,
      case1,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-reorder:${JSON.stringify(claimEarlyPayload)}`,
      200
    );

    db.prepare(
      `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
       VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`
    ).run(
      randomUUID(),
      case1,
      case1,
      SCHEDULED_OCCURRENCE_SEAT,
      `${SCHEDULED_OCCURRENCE_PREFIX}occ-reorder:${JSON.stringify(enqueuedLatePayload)}`,
      300
    );

    const reorderedRecord = getOccurrence(db, "occ-reorder");
    expect(reorderedRecord).not.toBeNull();
    expect(reorderedRecord?.status).toBe("claimed");
    expect(reorderedRecord?.caseId).toBe(case1);
  });
});
