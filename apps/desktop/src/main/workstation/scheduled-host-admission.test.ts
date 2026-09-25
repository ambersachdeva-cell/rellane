import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WorkstationReview, WorkstationSnapshot } from "@cadrane/contracts";
import { openCase } from "../book/cases.js";
import { saveContextSnapshot } from "./context-snapshot-store.js";
import { admitScheduledOccurrence, grantScheduleAdmission, revokeScheduleAdmission, saveScheduleDefinition } from "./schedule-definition-store.js";
import { createScheduledHostAdmission, type ScheduledReviewHost } from "./scheduled-host-admission.js";
import { getOccurrence } from "./scheduled-occurrence-store.js";

function dbFixture(): DatabaseSync {
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
    CREATE TABLE workstation_project (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, memory_epoch INTEGER NOT NULL DEFAULT 0);
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
    CREATE TABLE workstation_context_snapshot (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
      project_id TEXT REFERENCES workstation_project (id) ON DELETE CASCADE,
      memory_epoch INTEGER NOT NULL, provider_id TEXT NOT NULL, model_id TEXT,
      packet_hash TEXT NOT NULL, packet TEXT, manifest_json TEXT,
      created_at INTEGER NOT NULL, dispatch_attempted_at INTEGER, redacted_at INTEGER
    );
    CREATE TABLE workstation_context_snapshot_constraint (
      snapshot_id TEXT NOT NULL REFERENCES workstation_context_snapshot (id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, memory_id)
    );
    CREATE TABLE workstation_project_memory_entry (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, active_revision INTEGER NOT NULL, kind TEXT NOT NULL
    );
    CREATE TABLE workstation_project_memory_revision (
      entry_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (entry_id, revision)
    );
  `);
  return db;
}

const eight = Date.parse("2026-09-24T08:00:00.000Z");
const nine = Date.parse("2026-09-24T09:00:00.000Z");

function setup(grantExpiresAt = eight + 2 * 24 * 60 * 60_000) {
  const db = dbFixture();
  const caseId = openCase(db, { title: "Daily brief", question: "What changed?" });
  saveScheduleDefinition(db, {
    scheduleId: "brief", caseId, projectId: null, expectedRevision: 0,
    instruction: "Draft a morning summary.", expression: "0 0 9 * * *", timezone: "UTC",
    providerId: "gemini1", modelId: "gemini-3.8-flash-high", maxLatenessMs: 10 * 60_000, at: eight
  });
  const grant = grantScheduleAdmission(db, {
    scheduleId: "brief", expectedRevision: 1, ownerActionId: randomUUID(),
    expiresAt: grantExpiresAt, at: eight
  }).grant;
  if (!grant) throw new Error("Expected grant.");
  const due = admitScheduledOccurrence(db, { scheduleId: "brief", asOf: nine });
  if (!due.occurrence) throw new Error("Expected occurrence.");
  return { db, caseId, grant, occurrenceId: due.occurrence.occurrenceId };
}

function hostFixture(db: DatabaseSync, clock: () => number) {
  const rawHostToken = "a".repeat(64);
  let prepareCount = 0;
  let startCount = 0;
  let startedToken: string | null = null;
  let lastSnapshotId: string | null = null;
  let failStart = false;
  let mismatchModel = false;
  let reviewPolicy: { readonly freshSession: true } | undefined;
  const terminal: WorkstationSnapshot = {
    operationId: randomUUID(), caseId: "", providerId: "gemini1",
    modelId: "gemini-3.8-flash-high", sessionId: null,
    status: "completed", startedAt: clock(), updatedAt: clock(), text: "Done",
    activity: [], permission: null, detail: "Completed."
  };
  const host: ScheduledReviewHost = {
    async prepare(input, _owner, policy): Promise<WorkstationReview> {
      prepareCount += 1;
      reviewPolicy = policy;
      const packet = `Compiled: ${input.prompt}`;
      const id = randomUUID();
      lastSnapshotId = id;
      saveContextSnapshot(db, {
        id, caseId: input.caseId, projectId: null, memoryEpoch: 0,
        providerId: input.providerId, modelId: input.modelId, packet,
        manifest: { preview: packet, sourceIds: [], omitted: [], constraints: [] }
      }, clock());
      return {
        token: rawHostToken, caseId: input.caseId, projectId: null, memoryEpoch: 0,
        providerId: input.providerId, providerLabel: "Gemini profile 1",
        modelId: mismatchModel ? "wrong-model" : input.modelId,
        prompt: input.prompt, contextPreview: packet, sourceIds: [],
        sourceHash: createHash("sha256").update(packet).digest("hex"),
        contextSnapshotId: id, workspace: { id: `case:${input.caseId}`, label: "Private", path: "/private/tmp/test" },
        expiresAt: clock() + 5 * 60_000, resumeSessionId: null
      };
    },
    async start(input, _owner, signal): Promise<WorkstationSnapshot> {
      startCount += 1;
      startedToken = input.token;
      if (signal?.aborted) throw new Error("Stopped before provider launch.");
      if (failStart) throw new Error("Host Start uncertain.");
      return { ...terminal, caseId: caseIdForHost() , status: "running" };
    },
    async awaitTerminal(caseId): Promise<WorkstationSnapshot> {
      return { ...terminal, caseId };
    },
    async stop(caseId): Promise<WorkstationSnapshot> {
      return { ...terminal, caseId, status: "stopped" };
    }
  };
  let hostCaseId = "";
  function caseIdForHost(): string { return hostCaseId; }
  return {
    host, rawHostToken,
    setCaseId: (id: string) => { hostCaseId = id; },
    failNextStart: () => { failStart = true; },
    mismatchNextModel: () => { mismatchModel = true; },
    get prepareCount() { return prepareCount; },
    get startCount() { return startCount; },
    get startedToken() { return startedToken; },
    get lastSnapshotId() { return lastSnapshotId; },
    get reviewPolicy() { return reviewPolicy; }
  };
}

describe("scheduled host admission", () => {
  it("keeps the host token private and only Start claims/runs the exact saved packet", async () => {
    const fixture = setup();
    let clock = nine + 1000;
    const fake = hostFixture(fixture.db, () => clock);
    fake.setCaseId(fixture.caseId);
    const adapter = createScheduledHostAdmission({ book: () => fixture.db, host: fake.host, now: () => clock });
    const owner = {};
    const review = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    expect(fake.prepareCount).toBe(1);
    expect(fake.reviewPolicy).toEqual({ freshSession: true });
    expect(review.token).not.toBe(fake.rawHostToken);
    expect(review.contextSnapshotId).toBe(fake.lastSnapshotId);
    expect(review.projectId).toBeNull();
    expect(review.providerId).toBe("gemini1");
    expect(review.modelId).toBe("gemini-3.8-flash-high");
    expect(fake.startCount).toBe(0);
    expect(getOccurrence(fixture.db, fixture.occurrenceId)?.status).toBe("queued");

    clock += 1000;
    const result = await adapter.start({ token: review.token, owner });
    expect(fake.startCount).toBe(1);
    expect(fake.startedToken).toBe(fake.rawHostToken);
    expect(result.snapshot.status).toBe("completed");
    expect(result.occurrence.status).toBe("completed");
    await expect(adapter.start({ token: review.token, owner })).rejects.toThrow(/unavailable/);
  });

  it("rejects a revoked grant, changed context, wrong owner, and restart without dispatch", async () => {
    const fixture = setup();
    const fake = hostFixture(fixture.db, () => nine + 1000);
    fake.setCaseId(fixture.caseId);
    const adapter = createScheduledHostAdmission({ book: () => fixture.db, host: fake.host, now: () => nine + 1000 });
    const owner = {};
    const review = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    await expect(adapter.start({ token: review.token, owner: {} })).rejects.toThrow(/another window/);
    expect(fake.startCount).toBe(0);
    const review2 = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    const restarted = createScheduledHostAdmission({ book: () => fixture.db, host: fake.host, now: () => nine + 1000 });
    await expect(restarted.start({ token: review2.token, owner })).rejects.toThrow(/unavailable/);
    if (!review2.contextSnapshotId) throw new Error("Expected saved context ID.");
    fixture.db.prepare("UPDATE workstation_context_snapshot SET packet = ? WHERE id = ?")
      .run("tampered packet", review2.contextSnapshotId);
    await expect(adapter.start({ token: review2.token, owner })).rejects.toThrow(/hash mismatch/);
    expect(getOccurrence(fixture.db, fixture.occurrenceId)?.status).toBe("queued");
    const review3 = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    revokeScheduleAdmission(fixture.db, {
      scheduleId: "brief", grantId: fixture.grant.grantId,
      ownerActionId: randomUUID(), at: nine + 1001
    });
    await expect(adapter.start({ token: review3.token, owner })).rejects.toThrow(/grant is inactive/);
    expect(fake.startCount).toBe(0);
    expect(getOccurrence(fixture.db, fixture.occurrenceId)?.status).toBe("queued");
  });

  it("refuses host identity mismatch and settles an uncertain Start without replay", async () => {
    const first = setup();
    const fakeWrong = hostFixture(first.db, () => nine + 1000);
    fakeWrong.setCaseId(first.caseId);
    fakeWrong.mismatchNextModel();
    const wrong = createScheduledHostAdmission({ book: () => first.db, host: fakeWrong.host, now: () => nine + 1000 });
    await expect(wrong.prepare({ scheduleId: "brief", occurrenceId: first.occurrenceId, owner: {} }))
      .rejects.toThrow(/Host review does not match/);
    expect(fakeWrong.startCount).toBe(0);

    const second = setup();
    const fakeFail = hostFixture(second.db, () => nine + 1000);
    fakeFail.setCaseId(second.caseId);
    fakeFail.failNextStart();
    const adapter = createScheduledHostAdmission({ book: () => second.db, host: fakeFail.host, now: () => nine + 1000 });
    const owner = {};
    const review = await adapter.prepare({ scheduleId: "brief", occurrenceId: second.occurrenceId, owner });
    await expect(adapter.start({ token: review.token, owner })).rejects.toThrow(/Start uncertain/);
    expect(getOccurrence(second.db, second.occurrenceId)?.status).toBe("uncertain");
    await expect(adapter.start({ token: review.token, owner })).rejects.toThrow(/unavailable/);
  });

  it("refuses grant expiry and case or project drift before consuming the queue", async () => {
    const expiry = setup(nine + 2 * 60_000);
    let clock = nine + 1000;
    const hostExpiry = hostFixture(expiry.db, () => clock);
    hostExpiry.setCaseId(expiry.caseId);
    const adapterExpiry = createScheduledHostAdmission({ book: () => expiry.db, host: hostExpiry.host, now: () => clock });
    const ownerExpiry = {};
    const expiryReview = await adapterExpiry.prepare({ scheduleId: "brief", occurrenceId: expiry.occurrenceId, owner: ownerExpiry });
    clock = nine + 2 * 60_000;
    await expect(adapterExpiry.start({ token: expiryReview.token, owner: ownerExpiry }))
      .rejects.toThrow(/grant is inactive/);
    expect(hostExpiry.startCount).toBe(0);

    const closed = setup();
    const hostClosed = hostFixture(closed.db, () => nine + 1000);
    hostClosed.setCaseId(closed.caseId);
    const adapterClosed = createScheduledHostAdmission({ book: () => closed.db, host: hostClosed.host, now: () => nine + 1000 });
    const ownerClosed = {};
    const closedReview = await adapterClosed.prepare({ scheduleId: "brief", occurrenceId: closed.occurrenceId, owner: ownerClosed });
    closed.db.prepare("UPDATE work_case SET closed_at = ?, closed_as = 'settled', verdict = 'Done' WHERE id = ?")
      .run(nine + 1001, closed.caseId);
    await expect(adapterClosed.start({ token: closedReview.token, owner: ownerClosed }))
      .rejects.toThrow(/missing or closed/);
    expect(hostClosed.startCount).toBe(0);

    const moved = setup();
    const hostMoved = hostFixture(moved.db, () => nine + 1000);
    hostMoved.setCaseId(moved.caseId);
    const adapterMoved = createScheduledHostAdmission({ book: () => moved.db, host: hostMoved.host, now: () => nine + 1000 });
    const ownerMoved = {};
    const movedReview = await adapterMoved.prepare({ scheduleId: "brief", occurrenceId: moved.occurrenceId, owner: ownerMoved });
    moved.db.prepare("INSERT INTO workstation_project (id, created_at, memory_epoch) VALUES (?, ?, 0)")
      .run("moved-project", nine);
    moved.db.prepare("INSERT INTO workstation_project_revision (project_id, revision, title, brief, created_at) VALUES (?, 1, ?, ?, ?)")
      .run("moved-project", "Moved", "Other brief", nine);
    moved.db.prepare("INSERT INTO workstation_project_link (case_id, project_id, created_at) VALUES (?, ?, ?)")
      .run(moved.caseId, "moved-project", nine);
    await expect(adapterMoved.start({ token: movedReview.token, owner: ownerMoved }))
      .rejects.toThrow(/project link changed/);
    expect(hostMoved.startCount).toBe(0);
  });

  it("cancels queued reviews on owner navigation or global Stop", async () => {
    const fixture = setup();
    const fake = hostFixture(fixture.db, () => nine + 1000);
    fake.setCaseId(fixture.caseId);
    const adapter = createScheduledHostAdmission({ book: () => fixture.db, host: fake.host, now: () => nine + 1000 });
    const owner = {};
    const first = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    adapter.cancelOwner(owner);
    await expect(adapter.start({ token: first.token, owner })).rejects.toThrow(/unavailable/);
    const newOwner = {};
    const second = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner: newOwner });
    expect(adapter.stopActive()).toBe(true);
    await expect(adapter.start({ token: second.token, owner: newOwner })).rejects.toThrow(/unavailable/);
    expect(fake.startCount).toBe(0);
  });

  it("owner revocation withdraws pending scheduled reviews immediately", async () => {
    const fixture = setup();
    const fake = hostFixture(fixture.db, () => nine + 1000);
    fake.setCaseId(fixture.caseId);
    const adapter = createScheduledHostAdmission({ book: () => fixture.db, host: fake.host, now: () => nine + 1000 });
    const owner = {};
    const review = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    adapter.revoke({
      scheduleId: "brief", grantId: fixture.grant.grantId,
      ownerActionId: randomUUID(), at: nine + 1001
    });
    await expect(adapter.start({ token: review.token, owner })).rejects.toThrow(/unavailable/);
    expect(fake.startCount).toBe(0);
    expect(getOccurrence(fixture.db, fixture.occurrenceId)?.status).toBe("queued");
  });

  it("global Stop aborts a Start already handed to the shared host", async () => {
    const fixture = setup();
    const fake = hostFixture(fixture.db, () => nine + 1000);
    fake.setCaseId(fixture.caseId);
    const stoppedHost: ScheduledReviewHost = {
      ...fake.host,
      async awaitTerminal(caseId, _operationId, _owner, signal): Promise<WorkstationSnapshot> {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { operationId: randomUUID(), caseId, providerId: "gemini1",
          modelId: "gemini-3.8-flash-high", sessionId: null, status: "stopped",
          startedAt: nine, updatedAt: nine + 1000, text: "", activity: [],
          permission: null, detail: "Stopped by owner." };
      }
    };
    const adapter = createScheduledHostAdmission({ book: () => fixture.db, host: stoppedHost, now: () => nine + 1000 });
    const owner = {};
    const review = await adapter.prepare({ scheduleId: "brief", occurrenceId: fixture.occurrenceId, owner });
    const started = adapter.start({ token: review.token, owner });
    expect(adapter.stopActive()).toBe(true);
    const result = await started;
    expect(result.occurrence.status).toBe("stopped");
  });
});
