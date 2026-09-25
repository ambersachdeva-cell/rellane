import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openCase } from "../book/cases.js";
import {
  admitScheduledOccurrence,
  claimScheduledOccurrence,
  grantScheduleAdmission,
  inspectScheduledOccurrence,
  readScheduleDefinition,
  revokeScheduleAdmission,
  saveScheduleDefinition,
  SCHEDULE_DEFINITION_PREFIX,
  SCHEDULE_DEFINITION_SEAT
} from "./schedule-definition-store.js";
import { cancelOccurrence, getOccurrence } from "./scheduled-occurrence-store.js";

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
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, seat TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('verbatim', 'finding', 'receipt', 'compacted')),
      body TEXT NOT NULL, at INTEGER NOT NULL, compacted_from TEXT,
      UNIQUE (case_id, seq),
      CHECK ((kind = 'compacted') = (compacted_from IS NOT NULL))
    );
    CREATE TABLE workstation_project (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    );
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

function draft(caseId: string, expectedRevision = 0) {
  return {
    scheduleId: "daily-brief",
    caseId,
    projectId: null,
    expectedRevision,
    instruction: "Make a draft summary. Ask before any outbound action.",
    expression: "0 0 9 * * *",
    timezone: "UTC",
    providerId: "gemini1",
    modelId: "gemini-3.8-flash-high",
    maxLatenessMs: 10 * 60 * 1000,
    at: eight
  };
}

function approve(db: DatabaseSync) {
  return grantScheduleAdmission(db, {
    scheduleId: "daily-brief",
    expectedRevision: 1,
    ownerActionId: randomUUID(),
    expiresAt: eight + 24 * 60 * 60 * 1000,
    at: eight
  });
}

describe("schedule definition and queue admission", () => {
  it("rejects new unreviewable instructions while preserving a long legacy receipt for revision", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Legacy schedule", question: "Keep prior data readable" });
    expect(() => saveScheduleDefinition(db, { ...draft(caseId), instruction: "x".repeat(4_001) }))
      .toThrow();
    saveScheduleDefinition(db, draft(caseId));
    const prefix = `${SCHEDULE_DEFINITION_PREFIX}daily-brief:`;
    const row = db.prepare("SELECT id, body FROM case_turn WHERE seat = ?").get(SCHEDULE_DEFINITION_SEAT) as {
      id: string; body: string
    };
    const existing = JSON.parse(row.body.slice(prefix.length)) as Record<string, unknown>;
    const legacyInstruction = "L".repeat(5_000);
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run(
      `${prefix}${JSON.stringify({ ...existing, instruction: legacyInstruction,
        instructionHash: createHash("sha256").update(legacyInstruction).digest("hex") })}`,
      row.id
    );
    expect(readScheduleDefinition(db, "daily-brief")?.definition.instruction).toBe(legacyInstruction);
    const revised = saveScheduleDefinition(db, { ...draft(caseId, 1), instruction: "Reviewable revision." });
    expect(revised.definition.revision).toBe(2);
    expect(revised.definition.instruction).toBe("Reviewable revision.");
  });

  it("needs a saved exact grant, skips missed times, and queues one deterministic due item across reads", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    const saved = saveScheduleDefinition(db, draft(caseId));
    expect(saved.definition.revision).toBe(1);
    expect(saved.grant).toBeNull();
    expect(admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine })).toEqual({
      status: "inactive", occurrence: null
    });

    const granted = approve(db);
    expect(granted.grant?.scope).toBe("queue-only");
    expect(granted.grant?.approvedBy).toBe("local-owner");
    expect(admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine - 1 }).status).toBe("not-due");
    expect(admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine + 11 * 60_000 }).status).toBe("not-due");

    const first = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine + 5 * 60_000 });
    expect(first.status).toBe("queued");
    if (!first.occurrence) throw new Error("Expected a queued occurrence.");
    expect(first.occurrence.dueAt).toBe(nine);
    expect(first.occurrence.reviewedGrantRef).toBe(`queue-only-${granted.grant?.grantId}`);
    expect(getOccurrence(db, first.occurrence.occurrenceId)?.status).toBe("queued");

    // A new module reader after a simulated restart sees the same Book receipts.
    expect(readScheduleDefinition(db, "daily-brief")?.grant?.grantId).toBe(granted.grant?.grantId);
    const again = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine + 5 * 60_000 });
    expect(again.status).toBe("already-queued");
    expect(again.occurrence?.occurrenceId).toBe(first.occurrence.occurrenceId);
  });

  it("invalidates approval on revision, expiry, and revocation; rejects stale approvals", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    saveScheduleDefinition(db, draft(caseId));
    const grant = approve(db).grant;
    if (!grant) throw new Error("Expected grant.");
    expect(() => grantScheduleAdmission(db, {
      scheduleId: "daily-brief", expectedRevision: 1,
      ownerActionId: grant.ownerActionId,
      expiresAt: eight + 24 * 60 * 60 * 1000, at: eight
    })).toThrow(/Owner action was already used/);
    const revoked = revokeScheduleAdmission(db, {
      scheduleId: "daily-brief", grantId: grant.grantId, ownerActionId: randomUUID(), at: eight + 1
    });
    expect(revoked.grantRevoked).toBe(true);
    expect(admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine }).status).toBe("inactive");

    const revised = saveScheduleDefinition(db, { ...draft(caseId, 1), instruction: "Make a new draft.", at: eight + 2 });
    expect(revised.definition.revision).toBe(2);
    expect(revised.grant).toBeNull();
    expect(() => grantScheduleAdmission(db, {
      scheduleId: "daily-brief", expectedRevision: 1,
      ownerActionId: randomUUID(), expiresAt: eight + 24 * 60 * 60 * 1000, at: eight + 2
    })).toThrow(/revision changed/);
    expect(() => saveScheduleDefinition(db, draft(caseId))).toThrow(/revision changed/);
    expect(() => grantScheduleAdmission(db, {
      scheduleId: "daily-brief", expectedRevision: 2,
      ownerActionId: randomUUID(), expiresAt: eight + 31 * 24 * 60 * 60 * 1000, at: eight + 2
    })).toThrow(/expire within 30 days/);
  });

  it("reports a cancelled due occurrence as recorded without re-queuing it", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    saveScheduleDefinition(db, draft(caseId));
    approve(db);
    const first = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine });
    if (!first.occurrence) throw new Error("Expected queued occurrence.");
    cancelOccurrence(db, { occurrenceId: first.occurrence.occurrenceId, cancelledAt: nine + 1 });
    const again = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine + 2 });
    expect(again.status).toBe("already-recorded");
    expect(again.occurrence?.status).toBe("cancelled");
    expect(again.occurrence?.occurrenceId).toBe(first.occurrence.occurrenceId);
  });

  it("keeps a timely queued occurrence reviewable after the admission window", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    saveScheduleDefinition(db, draft(caseId));
    approve(db);
    const queued = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine });
    if (!queued.occurrence) throw new Error("Expected queued occurrence.");
    const later = nine + 11 * 60_000;
    expect(admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: later }).status).toBe("not-due");
    expect(inspectScheduledOccurrence(db, {
      scheduleId: "daily-brief", occurrenceId: queued.occurrence.occurrenceId, asOf: later
    }).occurrence.status).toBe("queued");
    expect(claimScheduledOccurrence(db, {
      scheduleId: "daily-brief", occurrenceId: queued.occurrence.occurrenceId, asOf: later
    }).status).toBe("claimed");
  });

  it("will not replace an active grant or replay a due time under a replacement grant", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    saveScheduleDefinition(db, draft(caseId));
    const original = approve(db).grant;
    if (!original) throw new Error("Expected grant.");
    expect(() => grantScheduleAdmission(db, { scheduleId: "daily-brief", expectedRevision: 1,
      ownerActionId: randomUUID(), expiresAt: eight + 24 * 60 * 60_000, at: eight + 1
    })).toThrow(/already has an active grant/);
    const queued = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine });
    if (!queued.occurrence) throw new Error("Expected queued occurrence.");
    revokeScheduleAdmission(db, { scheduleId: "daily-brief", grantId: original.grantId,
      ownerActionId: randomUUID(), at: nine });
    grantScheduleAdmission(db, { scheduleId: "daily-brief", expectedRevision: 1,
      ownerActionId: randomUUID(), expiresAt: nine + 24 * 60 * 60_000, at: nine });
    const sameDue = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine + 1 });
    expect(sameDue.status).toBe("already-recorded");
    expect(sameDue.occurrence?.occurrenceId).toBe(queued.occurrence.occurrenceId);
    expect(sameDue.occurrence?.status).toBe("cancelled");
    expect(getOccurrence(db, queued.occurrence.occurrenceId)?.status).toBe("cancelled");
    expect(() => claimScheduledOccurrence(db, { scheduleId: "daily-brief",
      occurrenceId: queued.occurrence!.occurrenceId, asOf: nine + 2
    })).toThrow(/no longer matches the active schedule grant/);
  });

  it("checks the grant again at claim time and never replays an old queued time", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    saveScheduleDefinition(db, draft(caseId));
    const firstGrant = approve(db).grant;
    if (!firstGrant) throw new Error("Expected grant.");
    const queued = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine });
    if (!queued.occurrence) throw new Error("Expected queued occurrence.");

    revokeScheduleAdmission(db, {
      scheduleId: "daily-brief", grantId: firstGrant.grantId,
      ownerActionId: randomUUID(), at: nine + 1
    });
    expect(() => claimScheduledOccurrence(db, {
      scheduleId: "daily-brief", occurrenceId: queued.occurrence!.occurrenceId,
      asOf: nine + 2
    })).toThrow(/grant is inactive/);

    const replacement = grantScheduleAdmission(db, {
      scheduleId: "daily-brief", expectedRevision: 1,
      ownerActionId: randomUUID(), expiresAt: nine + 2 * 24 * 60 * 60 * 1000,
      at: nine + 3
    });
    expect(replacement.grant?.grantId).not.toBe(firstGrant.grantId);
    expect(() => claimScheduledOccurrence(db, {
      scheduleId: "daily-brief", occurrenceId: queued.occurrence!.occurrenceId,
      asOf: nine + 4
    })).toThrow(/no longer matches the active schedule grant/);
    expect(admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine + 4 }).status).toBe("not-due");

    const nextDay = nine + 24 * 60 * 60 * 1000;
    const next = admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nextDay });
    expect(next.status).toBe("queued");
    if (!next.occurrence) throw new Error("Expected next day's occurrence.");
    const claimed = claimScheduledOccurrence(db, {
      scheduleId: "daily-brief", occurrenceId: next.occurrence.occurrenceId, asOf: nextDay + 1
    });
    expect(claimed.status).toBe("claimed");
    expect(() => claimScheduledOccurrence(db, {
      scheduleId: "daily-brief", occurrenceId: next.occurrence!.occurrenceId, asOf: nextDay + 2
    })).toThrow(/no longer queued/);
  });

  it("fails closed when a Case changes project or a receipt is corrupt", () => {
    const db = createDb();
    const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
    saveScheduleDefinition(db, draft(caseId));
    approve(db);
    db.prepare("INSERT INTO workstation_project (id, created_at) VALUES (?, ?)").run("other-project", eight);
    db.prepare(
      "INSERT INTO workstation_project_revision (project_id, revision, title, brief, created_at) VALUES (?, 1, ?, ?, ?)"
    ).run("other-project", "Other", "Other brief", eight);
    db.prepare("INSERT INTO workstation_project_link (case_id, project_id, created_at) VALUES (?, ?, ?)")
      .run(caseId, "other-project", eight);
    expect(() => admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine })).toThrow(/project link changed/);

    db.prepare("DELETE FROM workstation_project_link WHERE case_id = ?").run(caseId);
    db.prepare(`INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
      VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, 'receipt', ?, ?)`)
      .run(randomUUID(), caseId, caseId, SCHEDULE_DEFINITION_SEAT,
        `${SCHEDULE_DEFINITION_PREFIX}daily-brief:{broken`, eight + 3);
    expect(() => readScheduleDefinition(db, "daily-brief")).toThrow(/Corrupt schedule receipt JSON/);
    expect(() => admitScheduledOccurrence(db, { scheduleId: "daily-brief", asOf: nine })).toThrow(/Corrupt schedule receipt JSON/);
  });
});
