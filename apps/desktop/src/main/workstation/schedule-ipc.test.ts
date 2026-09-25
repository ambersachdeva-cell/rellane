import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { appendTurn, openCase, turnsFor } from "../book/cases.js";
import { inspectScheduledOccurrence, readScheduleDefinition, revokeScheduleAdmission } from "./schedule-definition-store.js";
import { installScheduleIpc, type ScheduleGrantReviewView } from "./schedule-ipc.js";
import type { createScheduledHostAdmission } from "./scheduled-host-admission.js";
import {
  claimOccurrence,
  enqueueOccurrence,
  getOccurrence,
  SCHEDULED_OCCURRENCE_PREFIX,
  SCHEDULED_OCCURRENCE_SEAT
} from "./scheduled-occurrence-store.js";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } }));

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
const owner = Object.freeze({ id: "owner" });
const other = Object.freeze({ id: "other" });
const event = { trusted: true, owner } as unknown as IpcMainInvokeEvent;
const foreign = { trusted: true, owner: other } as unknown as IpcMainInvokeEvent;
const untrusted = { trusted: false, owner: other } as unknown as IpcMainInvokeEvent;

function invoke(channel: string, input: unknown, caller = event): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(caller, input);
}

function saveInput(caseId: string, expectedRevision = 0) {
  return {
    scheduleId: "daily-brief", caseId, projectId: null, expectedRevision,
    instruction: "Draft a morning summary. Ask before sending.",
    expression: "0 0 9 * * *", timezone: "UTC", providerId: "gemini1",
    modelId: "gemini-3.8-flash-high", maxLatenessMs: 10 * 60_000
  };
}

function setup(confirm: (view: ScheduleGrantReviewView) => Promise<boolean> = async () => true) {
  const db = dbFixture();
  const caseId = openCase(db, { title: "Brief", question: "What changed?" });
  let clock = eight;
  const prepare = vi.fn(async () => ({ token: "b".repeat(64), occurrenceId: "occurrence-1" }));
  const start = vi.fn(async () => { throw new Error("Synthetic Start not configured."); });
  const revoke = vi.fn((input: { scheduleId: string; grantId: string; ownerActionId: string; at: number }) => {
    revokeScheduleAdmission(db, input);
  });
  const admission = {
    prepare, start, revoke,
    stopOccurrence: vi.fn(() => true),
    cancelOwner: vi.fn(), stopActive: vi.fn(() => false)
  } as unknown as ReturnType<typeof createScheduledHostAdmission>;
  const confirmOwnerGrant = vi.fn(async (_caller: IpcMainInvokeEvent, review: ScheduleGrantReviewView) => confirm(review));
  const lifecycle = installScheduleIpc({
    assertTrusted: (caller) => { if (!(caller as unknown as { trusted: boolean }).trusted) throw new Error("Untrusted sender."); },
    ownerFor: (caller) => (caller as unknown as { owner: object }).owner,
    book: () => db, admission, confirmOwnerGrant, now: () => clock
  });
  return { db, caseId, prepare, start, revoke, confirmOwnerGrant, lifecycle,
    setTime: (at: number) => { clock = at; } };
}

describe("trusted schedule IPC", () => {
  beforeEach(() => handlers.clear());

  it("settles orphan claims before the first usable schedule IPC action and never retries them", async () => {
    const kit = setup();
    enqueueOccurrence(kit.db, { scheduleId: "old-schedule", definitionRevision: 1,
      occurrenceId: "orphan-claim", caseId: kit.caseId, projectId: null,
      dueAt: nine, reviewedGrantRef: "queue-only-old", instructionHash: "old-hash",
      enqueuedAt: nine });
    claimOccurrence(kit.db, { occurrenceId: "orphan-claim", asOf: nine });
    kit.setTime(nine + 1);
    await expect(invoke(IPC_CHANNELS.workstationScheduleList, { caseId: kit.caseId }, untrusted))
      .rejects.toThrow(/Untrusted/);
    expect(getOccurrence(kit.db, "orphan-claim")?.status).toBe("claimed");

    await invoke(IPC_CHANNELS.workstationScheduleList, { caseId: kit.caseId });
    const recovered = getOccurrence(kit.db, "orphan-claim");
    expect(recovered?.status).toBe("uncertain");
    expect(recovered?.terminal).toBe(true);
    expect(recovered?.detail).toMatch(/Crash recovery/);
    const turnsAfter = turnsFor(kit.db, kit.caseId).length;
    await invoke(IPC_CHANNELS.workstationScheduleList, { caseId: kit.caseId });
    expect(turnsFor(kit.db, kit.caseId)).toHaveLength(turnsAfter);
    expect(kit.prepare).not.toHaveBeenCalled();
    expect(kit.start).not.toHaveBeenCalled();
  });

  it("keeps schedule IPC unavailable on corrupt recovery history, then retries the sweep", async () => {
    const kit = setup();
    const badTurn = appendTurn(kit.db, kit.caseId, { seat: SCHEDULED_OCCURRENCE_SEAT,
      kind: "receipt", body: `${SCHEDULED_OCCURRENCE_PREFIX}bad:{broken` });
    await expect(invoke(IPC_CHANNELS.workstationScheduleSave, saveInput(kit.caseId)))
      .rejects.toThrow(/Corrupted occurrence event/);
    expect(readScheduleDefinition(kit.db, "daily-brief")).toBeNull();
    kit.db.prepare("DELETE FROM case_turn WHERE id = ?").run(badTurn);
    await invoke(IPC_CHANNELS.workstationScheduleSave, saveInput(kit.caseId));
    expect(readScheduleDefinition(kit.db, "daily-brief")?.definition.revision).toBe(1);
    expect(kit.start).not.toHaveBeenCalled();
  });

  it("saves only instructions that fit the exact native grant review", async () => {
    const kit = setup();
    await expect(invoke(IPC_CHANNELS.workstationScheduleSave, {
      ...saveInput(kit.caseId), instruction: "x".repeat(4_001)
    })).rejects.toThrow();
    expect(readScheduleDefinition(kit.db, "daily-brief")).toBeNull();
    await invoke(IPC_CHANNELS.workstationScheduleSave, {
      ...saveInput(kit.caseId), instruction: "x".repeat(4_000)
    });
    const reviewed = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    expect(reviewed.definition.instruction).toHaveLength(4_000);
    expect(kit.start).not.toHaveBeenCalled();
  });

  it("requires a main-owned exact review and native yes before minting a queue-only grant", async () => {
    const kit = setup();
    await invoke(IPC_CHANNELS.workstationScheduleSave, saveInput(kit.caseId));
    expect(kit.start).not.toHaveBeenCalled();
    expect(readScheduleDefinition(kit.db, "daily-brief")?.grant).toBeNull();
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, {
      ownerActionId: randomUUID(), approved: true
    })).rejects.toThrow();
    const reviewed = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    expect(reviewed.definition.instruction).toBe(saveInput(kit.caseId).instruction);
    expect(reviewed.definition.providerId).toBe("gemini1");
    expect(reviewed.scope).toBe("queue-only");
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, {
      token: reviewed.token, ownerActionId: randomUUID()
    })).rejects.toThrow();
    expect(kit.confirmOwnerGrant).not.toHaveBeenCalled();
    const granted = await invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: reviewed.token }) as {
      grant: { ownerActionId: string; scope: string }
    };
    expect(kit.confirmOwnerGrant).toHaveBeenCalledTimes(1);
    expect(granted.grant.ownerActionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(granted.grant.scope).toBe("queue-only");
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: reviewed.token }))
      .rejects.toThrow(/expired|another window/);
    expect(kit.start).not.toHaveBeenCalled();
  });

  it("fails closed for untrusted, foreign, expired and revised grant reviews", async () => {
    const kit = setup();
    await invoke(IPC_CHANNELS.workstationScheduleSave, saveInput(kit.caseId));
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }, untrusted)).rejects.toThrow(/Untrusted sender/);
    const first = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: first.token }, foreign))
      .rejects.toThrow(/another window/);
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: first.token }))
      .rejects.toThrow(/expired|another window/);
    const expired = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    kit.setTime(expired.reviewExpiresAt);
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: expired.token }))
      .rejects.toThrow(/expired/);
    kit.setTime(eight);
    const stale = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    await invoke(IPC_CHANNELS.workstationScheduleSave, {
      ...saveInput(kit.caseId, 1), instruction: "A revised instruction."
    });
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: stale.token }))
      .rejects.toThrow(/expired|changed/);
    expect(kit.confirmOwnerGrant).not.toHaveBeenCalled();
    expect(kit.start).not.toHaveBeenCalled();
  });

  it("native cancel leaves the schedule disabled; Queue and Prepare remain separate from Start", async () => {
    let allow = false;
    const kit = setup(async () => allow);
    await invoke(IPC_CHANNELS.workstationScheduleSave, saveInput(kit.caseId));
    const first = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    await expect(invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: first.token }))
      .rejects.toThrow(/cancelled/);
    expect(readScheduleDefinition(kit.db, "daily-brief")?.grant).toBeNull();
    allow = true;
    const second = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    await invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: second.token });
    kit.setTime(nine);
    const queued = await invoke(IPC_CHANNELS.workstationScheduleQueue, { scheduleId: "daily-brief" }) as {
      status: string; occurrence: { occurrenceId: string } | null
    };
    expect(queued.status).toBe("queued");
    if (!queued.occurrence) throw new Error("Expected queued occurrence.");
    expect(getOccurrence(kit.db, queued.occurrence.occurrenceId)?.status).toBe("queued");
    expect(kit.start).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.workstationSchedulePrepare, {
      scheduleId: "daily-brief", occurrenceId: queued.occurrence.occurrenceId
    });
    expect(kit.prepare).toHaveBeenCalledTimes(1);
    expect(kit.start).not.toHaveBeenCalled();
    await expect(invoke(IPC_CHANNELS.workstationScheduleStart, { token: "c".repeat(64) }))
      .rejects.toThrow(/unavailable/);
    expect(kit.start).not.toHaveBeenCalled();
  });

  it("revokes a confirmed grant and rejects further queue admission without starting a provider", async () => {
    const kit = setup();
    await invoke(IPC_CHANNELS.workstationScheduleSave, saveInput(kit.caseId));
    const reviewed = await invoke(IPC_CHANNELS.workstationScheduleGrantReview, {
      scheduleId: "daily-brief", expectedRevision: 1, expiresAt: eight + 24 * 60 * 60_000
    }) as ScheduleGrantReviewView;
    const granted = await invoke(IPC_CHANNELS.workstationScheduleGrantConfirm, { token: reviewed.token }) as {
      grant: { grantId: string }
    };
    kit.setTime(nine);
    const queued = await invoke(IPC_CHANNELS.workstationScheduleQueue, { scheduleId: "daily-brief" }) as {
      status: string; occurrence: { occurrenceId: string } | null
    };
    expect(queued.status).toBe("queued");
    if (!queued.occurrence) throw new Error("Expected queued occurrence.");
    const revoked = await invoke(IPC_CHANNELS.workstationScheduleRevoke, {
      scheduleId: "daily-brief", grantId: granted.grant.grantId
    }) as { grantRevoked: boolean };
    expect(kit.revoke).toHaveBeenCalledTimes(1);
    expect(revoked.grantRevoked).toBe(true);
    const preview = await invoke(IPC_CHANNELS.workstationSchedulePreview, {
      scheduleId: "daily-brief"
    }) as { grantRevoked: boolean };
    expect(preview.grantRevoked).toBe(true);
    // Retain the exact historical queue state; the revoked grant blocks use.
    expect(getOccurrence(kit.db, queued.occurrence.occurrenceId)?.status).toBe("queued");
    const admission = await invoke(IPC_CHANNELS.workstationScheduleQueue, { scheduleId: "daily-brief" }) as {
      status: string
    };
    expect(admission.status).toBe("inactive");
    expect(() => inspectScheduledOccurrence(kit.db, {
      scheduleId: "daily-brief", occurrenceId: queued.occurrence!.occurrenceId, asOf: nine
    })).toThrow(/grant is inactive/);
    expect(kit.prepare).not.toHaveBeenCalled();
    expect(kit.start).not.toHaveBeenCalled();
  });
});
