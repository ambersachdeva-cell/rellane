import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendTurn, closeCase, openCase } from "../book/cases.js";
import {
  grantScheduleAdmission,
  listScheduleDefinitions,
  MAX_SCHEDULE_HISTORY_ROWS,
  revokeScheduleAdmission,
  saveScheduleDefinition,
  scanScheduleDefinitions,
  SCHEDULE_DEFINITION_PREFIX,
  SCHEDULE_DEFINITION_SEAT
} from "./schedule-definition-store.js";
import { createScheduleQueuePump } from "./schedule-queue-pump.js";
import { claimOccurrence, enqueueOccurrence, getOccurrence, SCHEDULED_OCCURRENCE_SEAT } from "./scheduled-occurrence-store.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE work_case (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, question TEXT NOT NULL,
      opened_at INTEGER NOT NULL, closed_at INTEGER,
      closed_as TEXT CHECK (closed_as IN ('settled', 'abandoned', 'dropped')),
      verdict TEXT, CHECK ((closed_at IS NULL) = (closed_as IS NULL))
    );
    CREATE TABLE case_turn (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, seat TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('verbatim', 'finding', 'receipt', 'compacted')),
      body TEXT NOT NULL, at INTEGER NOT NULL, compacted_from TEXT,
      UNIQUE (case_id, seq), CHECK ((kind = 'compacted') = (compacted_from IS NOT NULL))
    );
    CREATE TABLE workstation_project (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE workstation_project_revision (
      project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (project_id, revision)
    );
    CREATE TABLE workstation_project_link (
      case_id TEXT PRIMARY KEY REFERENCES work_case (id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

const eight = Date.parse("2026-09-24T08:00:00.000Z");
const nine = Date.parse("2026-09-24T09:00:00.000Z");
function save(db: DatabaseSync, caseId: string, scheduleId: string, hour = 9) {
  return saveScheduleDefinition(db, {
    scheduleId, caseId, projectId: null, expectedRevision: 0,
    instruction: `Draft ${scheduleId}.`, expression: `0 0 ${hour} * * *`, timezone: "UTC",
    providerId: "gemini1", modelId: "gemini-3.8-flash-high", maxLatenessMs: 10 * 60_000, at: eight
  });
}
function grant(db: DatabaseSync, scheduleId: string, expiresAt = eight + 24 * 60 * 60_000) {
  return grantScheduleAdmission(db, {
    scheduleId, expectedRevision: 1, ownerActionId: randomUUID(), expiresAt, at: eight
  });
}
function receiptCount(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM case_turn WHERE seat = ?")
    .get(SCHEDULED_OCCURRENCE_SEAT) as { n: number }).n);
}

describe("app-alive schedule queue pump", () => {
  it("recovers orphan claims before admitting recently due work, skips old due times, and never claims", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily", question: "What changed?" });
    save(db, caseId, "recent"); grant(db, "recent");
    save(db, caseId, "old", 7); grant(db, "old");
    enqueueOccurrence(db, { scheduleId: "prior", definitionRevision: 1, occurrenceId: "orphan",
      caseId, projectId: null, dueAt: eight, reviewedGrantRef: "queue-only-prior",
      instructionHash: "prior-hash", enqueuedAt: eight });
    claimOccurrence(db, { occurrenceId: "orphan", asOf: eight });
    const pump = createScheduleQueuePump({ book: () => db });
    const result = pump.tick(nine + 5 * 60_000);
    expect(result).toMatchObject({ status: "scanned", schedules: 2, queued: 1, notDue: 1 });
    expect(getOccurrence(db, "orphan")?.status).toBe("uncertain");
    const rows = db.prepare("SELECT body FROM case_turn WHERE seat = ?").all(SCHEDULED_OCCURRENCE_SEAT) as {
      body: string
    }[];
    expect(rows.filter((row) => row.body.includes('"event":"enqueued"'))).toHaveLength(2);
    expect(rows.filter((row) => row.body.includes('"event":"claimed"'))).toHaveLength(1);
    expect(pump.tick(nine + 6 * 60_000)).toMatchObject({ queued: 0, alreadyQueued: 1 });
  });

  it("does not admit any schedule when a later receipt has corrupt semantic history", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily", question: "What changed?" });
    save(db, caseId, "a-valid"); grant(db, "a-valid");
    save(db, caseId, "z-corrupt"); grant(db, "z-corrupt");
    const prefix = `${SCHEDULE_DEFINITION_PREFIX}z-corrupt:`;
    const row = db.prepare("SELECT id, body FROM case_turn WHERE seat = ? AND substr(body, 1, ?) = ?")
      .get(SCHEDULE_DEFINITION_SEAT, prefix.length, prefix) as { id: string; body: string };
    const event = JSON.parse(row.body.slice(prefix.length)) as Record<string, unknown>;
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?")
      .run(`${prefix}${JSON.stringify({ ...event, instructionHash: "0".repeat(64) })}`, row.id);
    const pump = createScheduleQueuePump({ book: () => db });
    expect(() => pump.tick(nine)).toThrow(/Corrupt schedule instruction hash/);
    expect(receiptCount(db)).toBe(0);
    expect(() => scanScheduleDefinitions(db, 0)).toThrow(/scan bound/);
  });

  it("skips a closed Case without blocking unrelated open Case admission", () => {
    const db = createDb();
    const firstCase = openCase(db, { title: "First", question: "One" });
    const laterCase = openCase(db, { title: "Later", question: "Two" });
    save(db, firstCase, "a-first"); grant(db, "a-first");
    save(db, laterCase, "z-later"); grant(db, "z-later");
    db.prepare("UPDATE work_case SET closed_at = ?, closed_as = 'settled' WHERE id = ?")
      .run(nine - 1, laterCase);
    const pump = createScheduleQueuePump({ book: () => db });
    expect(pump.tick(nine)).toMatchObject({ queued: 1, inactive: 1 });
    expect(receiptCount(db)).toBe(1);
  });

  it("projects a queued row as cancelled after Case closure and restart without writing after verdict", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Closing", question: "Should this queue run?" });
    save(db, caseId, "closing"); grant(db, "closing");
    const pump = createScheduleQueuePump({ book: () => db });
    expect(pump.tick(nine)).toMatchObject({ queued: 1 });
    const body = (db.prepare("SELECT body FROM case_turn WHERE seat = ?")
      .get(SCHEDULED_OCCURRENCE_SEAT) as { body: string }).body;
    const id = (JSON.parse(body.slice(body.indexOf(":{\"") + 1)) as { occurrenceId: string }).occurrenceId;
    const beforeClose = receiptCount(db);
    closeCase(db, caseId, { closedAs: "settled", verdict: "Work complete" }, nine + 60_000);
    expect(getOccurrence(db, id)).toMatchObject({ status: "cancelled", terminal: true,
      cancelledAt: nine + 60_000 });
    const restarted = createScheduleQueuePump({ book: () => db });
    expect(restarted.tick(nine + 2 * 60_000)).toMatchObject({ inactive: 1, pruned: 0 });
    expect(receiptCount(db)).toBe(beforeClose);
    expect(() => claimOccurrence(db, { occurrenceId: id, asOf: nine + 2 * 60_000 }))
      .toThrow(/closed case/);
  });

  it("honours revoked and expired grants and accepts capacity equality", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily", question: "What changed?" });
    save(db, caseId, "revoked");
    const revokedGrant = grant(db, "revoked").grant;
    if (!revokedGrant) throw new Error("Missing grant.");
    revokeScheduleAdmission(db, { scheduleId: "revoked", grantId: revokedGrant.grantId,
      ownerActionId: randomUUID(), at: eight + 1 });
    save(db, caseId, "expired"); grant(db, "expired", nine - 1);
    const pump = createScheduleQueuePump({ book: () => db, maxSchedules: 2 });
    expect(pump.tick(nine)).toMatchObject({ schedules: 2, inactive: 2, queued: 0 });
    expect(receiptCount(db)).toBe(0);
    expect(() => createScheduleQueuePump({ book: () => db, maxSchedules: 1 }).tick(nine))
      .toThrow(/capacity exceeded/);
  });

  it("durably prunes queued work after revocation, regrant, revision and expiry", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Queued approvals", question: "What is still valid?" });
    const ids = ["revoked", "regranted", "revised", "expired"];
    const grants = new Map<string, ReturnType<typeof grant>>();
    for (const id of ids) {
      save(db, caseId, id);
      grants.set(id, grant(db, id, id === "expired" ? nine + 5 * 60_000 : eight + 24 * 60 * 60_000));
    }
    const pump = createScheduleQueuePump({ book: () => db });
    expect(pump.tick(nine + 60_000)).toMatchObject({ queued: 4, pruned: 0 });
    const queuedIds = (db.prepare("SELECT body FROM case_turn WHERE seat = ?").all(SCHEDULED_OCCURRENCE_SEAT) as { body: string }[])
      .map((row) => JSON.parse(row.body.slice(row.body.indexOf(":{\"") + 1)) as { occurrenceId: string });
    for (const id of ["revoked", "regranted"]) {
      const active = grants.get(id)?.grant;
      if (!active) throw new Error("Missing test grant.");
      revokeScheduleAdmission(db, { scheduleId: id, grantId: active.grantId,
        ownerActionId: randomUUID(), at: nine + 2 * 60_000 });
    }
    grantScheduleAdmission(db, { scheduleId: "regranted", expectedRevision: 1,
      ownerActionId: randomUUID(), expiresAt: eight + 24 * 60 * 60_000,
      at: nine + 3 * 60_000 });
    saveScheduleDefinition(db, { scheduleId: "revised", caseId, projectId: null,
      expectedRevision: 1, instruction: "Revised work.", expression: "0 0 9 * * *",
      timezone: "UTC", providerId: "gemini1", modelId: "gemini-3.8-flash-high",
      maxLatenessMs: 10 * 60_000, at: nine + 2 * 60_000 });
    expect(pump.tick(nine + 6 * 60_000)).toMatchObject({ pruned: 4, queued: 0 });
    for (const { occurrenceId } of queuedIds) {
      expect(getOccurrence(db, occurrenceId)?.status).toBe("cancelled");
      expect(() => claimOccurrence(db, { occurrenceId, asOf: nine + 6 * 60_000 }))
        .toThrow(/is cancelled/);
    }
    expect(receiptCount(db)).toBe(8);
    expect(pump.tick(nine + 7 * 60_000)).toMatchObject({ pruned: 0, queued: 0 });
  });

  it("scans more than 1,000 receipt rows without confusing history with definition capacity", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Many schedules", question: "Keep their history" });
    const instruction = "Draft a summary.";
    const instructionHash = createHash("sha256").update(instruction).digest("hex");
    for (let index = 0; index < 501; index += 1) {
      const scheduleId = `schedule-${index}`;
      const definition = { version: 1, event: "definition", scheduleId, revision: 1,
        caseId, projectId: null, instruction, instructionHash, expression: "0 0 9 * * *",
        timezone: "UTC", providerId: "gemini1", modelId: "gemini-3.8-flash-high",
        maxLatenessMs: 10 * 60_000, at: eight };
      const grant = { version: 1, event: "grant", scheduleId, revision: 1,
        grantId: randomUUID(), ownerActionId: randomUUID(), approvedBy: "local-owner",
        scope: "queue-only", instructionHash, expiresAt: eight + 24 * 60 * 60_000, at: eight };
      for (const event of [definition, grant]) {
        appendTurn(db, caseId, { seat: SCHEDULE_DEFINITION_SEAT, kind: "receipt",
          body: `${SCHEDULE_DEFINITION_PREFIX}${scheduleId}:${JSON.stringify(event)}` }, eight);
      }
    }
    expect(listScheduleDefinitions(db, caseId)).toHaveLength(501);
    expect(scanScheduleDefinitions(db)).toHaveLength(501);
    expect(() => scanScheduleDefinitions(db, 1000)).toThrow(/scan exceeds its bound/);
    const pump = createScheduleQueuePump({ book: () => db, maxSchedules: 501 });
    expect(pump.tick(eight + 60_000)).toMatchObject({ schedules: 501, queued: 0, notDue: 501 });
    expect(() => createScheduleQueuePump({ book: () => db, maxSchedules: 500 }).tick(eight + 60_000))
      .toThrow(/capacity exceeded/);
    expect(receiptCount(db)).toBe(0);
  });

  it("rejects invalid bounds and coalesces reentrant ticks without recursive replay", () => {
    const db = createDb();
    for (const maxSchedules of [0, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createScheduleQueuePump({ book: () => db, maxSchedules })).toThrow(/capacity/);
    }
    expect(() => createScheduleQueuePump({ book: () => db, intervalMs: 0 })).toThrow(/interval/);
    expect(() => createScheduleQueuePump({ book: () => db, maxScanRows: MAX_SCHEDULE_HISTORY_ROWS + 1 }))
      .toThrow(/scan rows/);
    let nested: unknown;
    let pump: ReturnType<typeof createScheduleQueuePump>;
    pump = createScheduleQueuePump({ book: () => db, now: () => {
      nested = pump.tick();
      return nine;
    } });
    expect(pump.tick()).toMatchObject({ status: "scanned", schedules: 0 });
    expect(nested).toEqual({ status: "busy" });
  });

  it("retries a lazy Book, then stops the timer and refuses later ticks", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily", question: "What changed?" });
    save(db, caseId, "daily"); grant(db, "daily");
    let callback: () => void = () => { throw new Error("Timer not registered."); };
    let cleared = false;
    let open = false;
    const pump = createScheduleQueuePump({
      book: () => { if (!open) throw new Error("Book not open"); return db; },
      now: () => nine,
      timer: {
        setInterval: (fn, ms) => { expect(ms).toBe(60_000); callback = fn; return 1; },
        clearInterval: (handle) => { expect(handle).toBe(1); cleared = true; }
      }
    });
    pump.start();
    expect(pump.lastError).toBeInstanceOf(Error);
    expect(receiptCount(db)).toBe(0);
    open = true;
    callback();
    expect(pump.lastError).toBeNull();
    expect(receiptCount(db)).toBe(1);
    pump.dispose();
    expect(cleared).toBe(true);
    callback();
    expect(receiptCount(db)).toBe(1);
    expect(() => pump.tick(nine)).toThrow(/stopped/);
  });

  it("records direct tick errors and remains restartable after timer setup fails", () => {
    const db = createDb();
    let failSetup = true;
    let cleared = false;
    const pump = createScheduleQueuePump({
      book: () => db,
      now: () => nine,
      timer: {
        setInterval: () => {
          if (failSetup) throw new Error("Timer setup failed");
          return 7;
        },
        clearInterval: (handle) => { expect(handle).toBe(7); cleared = true; }
      }
    });
    expect(() => pump.tick(0)).toThrow(/clock is invalid/);
    expect(pump.lastError).toMatchObject({ message: "Schedule clock is invalid." });
    expect(() => pump.start()).toThrow(/Timer setup failed/);
    expect(pump.lastError).toMatchObject({ message: "Timer setup failed" });
    failSetup = false;
    pump.start();
    expect(pump.lastError).toBeNull();
    pump.dispose();
    expect(cleared).toBe(true);
  });
});
