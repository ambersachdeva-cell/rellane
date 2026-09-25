import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MIGRATIONS } from "../book/schema.js";
import {
  saveScheduleDefinition,
  readScheduleDefinition,
  grantScheduleAdmission,
  revokeScheduleAdmission,
  admitScheduledOccurrence,
  pruneInvalidQueuedOccurrences,
  MAX_GRANT_LIFETIME_MS
} from "../workstation/schedule-definition-store.js";
import {
  recoverCrashedOccurrences,
  getOccurrence,
  claimOccurrence,
  enqueueOccurrence,
  settleOccurrence
} from "../workstation/scheduled-occurrence-store.js";

function setupTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

function seedCaseAndProject(
  db: DatabaseSync,
  caseId: string = "case-sched-1",
  projectId: string = "proj-sched-1"
): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO workstation_project (id, created_at, memory_epoch) VALUES (?, ?, 1)"
  ).run(projectId, now);

  db.prepare(
    "INSERT INTO workstation_project_revision (id, project_id, revision, title, brief, created_at) VALUES (?, ?, 1, ?, ?, ?)"
  ).run(randomUUID(), projectId, "Scheduled Project", "Project brief", now);

  db.prepare(
    "INSERT INTO work_case (id, title, question, opened_at) VALUES (?, ?, ?, ?)"
  ).run(caseId, "Scheduled Workroom", "Scheduled question", now);

  db.prepare(
    "INSERT INTO workstation_project_link (case_id, project_id, created_at) VALUES (?, ?, ?)"
  ).run(caseId, projectId, now);
}

describe("Backend Final Acceptance - Schedules Missed Occurrences and No-Replay Truth (G00 / R16)", () => {
  it("persists schedule definition revisions with instruction hashing and enforces CAS", () => {
    const db = setupTestDatabase();
    seedCaseAndProject(db);

    const now = 1_700_000_000_000;

    // 1. Initial save of schedule definition
    const record1 = saveScheduleDefinition(db, {
      scheduleId: "sched-1",
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      expectedRevision: 0,
      instruction: "Run hourly health evaluation on build telemetry.",
      expression: "0 0 * * * *", // Hourly (strict 6-field cron)
      timezone: "UTC",
      providerId: "codex",
      modelId: "gpt-5-codex",
      maxLatenessMs: 10 * 60_000, // 10 minutes max lateness (MAX_LATENESS_MS)
      at: now
    });

    expect(record1.definition.revision).toBe(1);
    expect(record1.definition.scheduleId).toBe("sched-1");
    expect(record1.grant).toBeNull();
    expect(record1.definition.instructionHash).toBeDefined();

    // 2. CAS collision check: saving with expectedRevision 0 when current is 1 must throw
    expect(() =>
      saveScheduleDefinition(db, {
        scheduleId: "sched-1",
        caseId: "case-sched-1",
        projectId: "proj-sched-1",
        expectedRevision: 0, // Stale!
        instruction: "Tampered instruction",
        expression: "0 0 * * * *",
        timezone: "UTC",
        providerId: "codex",
        modelId: "gpt-5-codex",
        maxLatenessMs: 10 * 60_000,
        at: now + 1000
      })
    ).toThrow(/revision/i);

    // 3. Valid update with expectedRevision 1 increments to revision 2
    const record2 = saveScheduleDefinition(db, {
      scheduleId: "sched-1",
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      expectedRevision: 1,
      instruction: "Run hourly health evaluation and summarize regressions.",
      expression: "0 0 * * * *",
      timezone: "UTC",
      providerId: "codex",
      modelId: "gpt-5-codex",
      maxLatenessMs: 10 * 60_000,
      at: now + 2000
    });

    expect(record2.definition.revision).toBe(2);
    expect(record2.definition.instructionHash).not.toBe(record1.definition.instructionHash);
  });

  it("enforces explicit owner grant binding, 30-day lifetime limit, and revocation", () => {
    const db = setupTestDatabase();
    seedCaseAndProject(db);

    const now = 1_700_000_000_000;

    saveScheduleDefinition(db, {
      scheduleId: "sched-2",
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      expectedRevision: 0,
      instruction: "Daily archive verify.",
      expression: "0 0 0 * * *",
      timezone: "UTC",
      providerId: "claude",
      modelId: "sonnet-3-7",
      maxLatenessMs: 10 * 60_000,
      at: now
    });

    // 1. Grant with expiration exceeding 30 days must be rejected by schema / limits
    const excessiveExpiry = now + MAX_GRANT_LIFETIME_MS + 86_400_000;
    expect(() =>
      grantScheduleAdmission(db, {
        scheduleId: "sched-2",
        expectedRevision: 1,
        ownerActionId: randomUUID(),
        expiresAt: excessiveExpiry,
        at: now
      })
    ).toThrow();

    // 2. Valid grant within 30 days
    const validExpiry = now + 7 * 86_400_000; // 7 days
    const granted = grantScheduleAdmission(db, {
      scheduleId: "sched-2",
      expectedRevision: 1,
      ownerActionId: randomUUID(),
      expiresAt: validExpiry,
      at: now
    });

    expect(granted.grant).not.toBeNull();
    expect(granted.grantRevoked).toBe(false);
    expect(granted.grant?.expiresAt).toBe(validExpiry);

    // 3. Revoke grant
    const revoked = revokeScheduleAdmission(db, {
      scheduleId: "sched-2",
      grantId: granted.grant!.grantId,
      ownerActionId: randomUUID(),
      at: now + 5000
    });

    expect(revoked.grantRevoked).toBe(true);

    // Admission after revocation must report inactive
    const admission = admitScheduledOccurrence(db, {
      scheduleId: "sched-2",
      asOf: now + 10_000
    });
    expect(admission.status).toBe("inactive");
    expect(admission.occurrence).toBeNull();
  });

  it("skips stale missed occurrences older than maxLatenessMs (no catch-up stampede)", () => {
    const db = setupTestDatabase();
    seedCaseAndProject(db);

    // Exact top-of-hour instant in UTC (2023-11-15T01:00:00.000Z)
    const baseTime = 1_700_010_000_000;
    const maxLatenessMs = 10 * 60_000; // 10 minutes

    saveScheduleDefinition(db, {
      scheduleId: "sched-3",
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      expectedRevision: 0,
      instruction: "Hourly sync",
      expression: "0 0 * * * *",
      timezone: "UTC",
      providerId: "codex",
      modelId: "gpt-5-codex",
      maxLatenessMs,
      at: baseTime - 3600_000
    });

    grantScheduleAdmission(db, {
      scheduleId: "sched-3",
      expectedRevision: 1,
      ownerActionId: randomUUID(),
      expiresAt: baseTime + 7 * 86_400_000,
      at: baseTime - 3600_000
    });

    // Case A: Evaluated 50 minutes after due time (past maxLatenessMs of 10m)
    // admitScheduledOccurrence calculates afterMs = asOf - maxLatenessMs - 1
    // The occurrence that fell before that window is skipped.
    const veryLateAsOf = baseTime + 50 * 60_000;
    const lateAdmission = admitScheduledOccurrence(db, {
      scheduleId: "sched-3",
      asOf: veryLateAsOf
    });

    // Since the due time was 50 mins ago (> 10 mins lateness), and the next hourly occurrence
    // is at baseTime + 60 mins (which is > asOf), status must be "not-due".
    expect(lateAdmission.status).toBe("not-due");
    expect(lateAdmission.occurrence).toBeNull();

    // Case B: Evaluated 5 minutes after due time (within maxLatenessMs)
    const onTimeAsOf = baseTime + 5 * 60_000;
    const onTimeAdmission = admitScheduledOccurrence(db, {
      scheduleId: "sched-3",
      asOf: onTimeAsOf
    });

    expect(onTimeAdmission.status).toBe("queued");
    expect(onTimeAdmission.occurrence).not.toBeNull();
    expect(onTimeAdmission.occurrence?.status).toBe("queued");
  });

  it("cancels invalid queued occurrences upon schedule definition revision or grant change", () => {
    const db = setupTestDatabase();
    seedCaseAndProject(db);

    const now = 1_700_000_000_000;

    const record = saveScheduleDefinition(db, {
      scheduleId: "sched-4",
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      expectedRevision: 0,
      instruction: "Nightly backup report",
      expression: "0 0 0 * * *",
      timezone: "UTC",
      providerId: "codex",
      modelId: "gpt-5-codex",
      maxLatenessMs: 10 * 60_000,
      at: now
    });

    const grant = grantScheduleAdmission(db, {
      scheduleId: "sched-4",
      expectedRevision: 1,
      ownerActionId: randomUUID(),
      expiresAt: now + 7 * 86_400_000,
      at: now
    });

    // Manually enqueue an occurrence with the old grant ref
    const occId = "schedule-test-occ-1";
    enqueueOccurrence(db, {
      occurrenceId: occId,
      scheduleId: "sched-4",
      definitionRevision: 1,
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      dueAt: now + 3600_000,
      reviewedGrantRef: `queue-only-${grant.grant!.grantId}`,
      instructionHash: record.definition.instructionHash,
      enqueuedAt: now
    });

    expect(getOccurrence(db, occId)?.status).toBe("queued");

    // Owner revises definition to revision 2
    const revisedRecord = saveScheduleDefinition(db, {
      scheduleId: "sched-4",
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      expectedRevision: 1,
      instruction: "Nightly backup report with integrity hashes",
      expression: "0 0 0 * * *",
      timezone: "UTC",
      providerId: "codex",
      modelId: "gpt-5-codex",
      maxLatenessMs: 10 * 60_000,
      at: now + 1000
    });

    // Prune invalid queued occurrences
    const cancelledCount = pruneInvalidQueuedOccurrences(db, [revisedRecord], now + 2000);
    expect(cancelledCount).toBe(1);

    const prunedOcc = getOccurrence(db, occId);
    expect(prunedOcc?.status).toBe("cancelled");
    expect(prunedOcc?.cancelReason).toContain("Schedule definition or scope changed");
  });

  it("recovers crashed in-flight claims, settling them as uncertain and refusing automatic replay", () => {
    const db = setupTestDatabase();
    seedCaseAndProject(db);

    const now = 1_700_000_000_000;

    const occId = "schedule-crash-occ-1";
    enqueueOccurrence(db, {
      occurrenceId: occId,
      scheduleId: "sched-crash",
      definitionRevision: 1,
      caseId: "case-sched-1",
      projectId: "proj-sched-1",
      dueAt: now,
      reviewedGrantRef: "queue-only-grant-1",
      instructionHash: "hash12345",
      enqueuedAt: now
    });

    // Claim the occurrence (in-flight dispatch started)
    const claim = claimOccurrence(db, {
      occurrenceId: occId,
      claimedAt: now + 100
    });
    expect(claim.status).toBe("claimed");
    expect(getOccurrence(db, occId)?.status).toBe("claimed");

    // Simulate process crash: host died before settling to completed
    // On app reboot, recoverCrashedOccurrences is called before any schedule action
    const settled = recoverCrashedOccurrences(db, { at: now + 50_000 });
    expect(settled.length).toBe(1);

    const recoveredOcc = getOccurrence(db, occId);
    expect(recoveredOcc?.status).toBe("uncertain");
    expect(recoveredOcc?.detail).toContain("uncertain");

    // Once uncertain, it can never be claimed or replayed automatically
    expect(() =>
      claimOccurrence(db, {
        occurrenceId: occId,
        claimedAt: now + 60_000
      })
    ).toThrow();
  });
});
