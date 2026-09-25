/**
 * Schedules stay inert until a trusted window reviews and explicitly enables
 * one exact revision. The renderer can ask for previews and queue eligible
 * work, but main alone mints approval identities and Start authority.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { readCase } from "../book/cases.js";
import { projectForWork } from "./projects.js";
import { evaluateRecurrence } from "./recurrence-evaluator.js";
import {
  admitScheduledOccurrence,
  grantScheduleAdmission,
  listScheduleDefinitions,
  MAX_GRANT_LIFETIME_MS,
  MAX_REVIEWABLE_SCHEDULE_INSTRUCTION,
  readScheduleDefinition,
  saveScheduleDefinition,
  type ScheduleDefinition,
  type ScheduleRecord
} from "./schedule-definition-store.js";
import { getOccurrence, recoverCrashedOccurrences } from "./scheduled-occurrence-store.js";
import type { createScheduledHostAdmission, ScheduledHostReview } from "./scheduled-host-admission.js";

const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+$/);
const Token = z.string().regex(/^[a-f0-9]{64}$/);
const Save = z.strictObject({
  scheduleId: Id, caseId: z.string().min(1).max(200), projectId: z.string().min(1).max(200).nullable(),
  expectedRevision: z.number().int().min(0), instruction: z.string().trim().min(1).max(MAX_REVIEWABLE_SCHEDULE_INSTRUCTION),
  expression: z.string().min(1).max(300), timezone: z.string().min(1).max(200),
  providerId: z.enum(["codex", "claude", "gemini1", "gemini2", "gemini3"]),
  modelId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  maxLatenessMs: z.number().int().min(0).max(10 * 60_000)
});
const List = z.strictObject({ caseId: z.string().min(1).max(200) });
const ById = z.strictObject({ scheduleId: Id });
const GrantReview = z.strictObject({
  scheduleId: Id, expectedRevision: z.number().int().min(1), expiresAt: z.number().int()
});
const GrantConfirm = z.strictObject({ token: Token });
const Revoke = z.strictObject({ scheduleId: Id, grantId: z.string().uuid() });
const Prepare = z.strictObject({ scheduleId: Id, occurrenceId: Id });
const Run = z.strictObject({ runId: z.string().uuid() });

const GRANT_REVIEW_TTL_MS = 5 * 60_000;
const MAX_GRANT_REVIEWS = 32;
const MAX_RUN_VIEWS = 100;

export interface ScheduleGrantReviewView {
  readonly token: string;
  readonly reviewExpiresAt: number;
  readonly grantExpiresAt: number;
  readonly definition: ScheduleDefinition;
  readonly nextDueAt: readonly number[];
  readonly scope: "queue-only";
}

export interface ScheduleRunView {
  readonly runId: string;
  readonly occurrenceId: string;
  readonly status: "working" | "completed" | "stopped" | "failed" | "uncertain" | "rejected";
  readonly detail: string;
  readonly operationId: string | null;
}

interface PendingGrant {
  readonly owner: object;
  readonly definitionHash: string;
  readonly scheduleId: string;
  readonly revision: number;
  readonly grantExpiresAt: number;
  readonly reviewExpiresAt: number;
}

interface RunState {
  readonly owner: object;
  readonly occurrenceId: string;
  view: ScheduleRunView;
}

export interface InstallScheduleIpcOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly ownerFor: (event: IpcMainInvokeEvent) => object;
  readonly book: () => DatabaseSync;
  readonly admission: ReturnType<typeof createScheduledHostAdmission>;
  /** Main-owned native confirmation; never a boolean supplied by the renderer. */
  readonly confirmOwnerGrant: (event: IpcMainInvokeEvent, view: ScheduleGrantReviewView) => Promise<boolean>;
  readonly now?: () => number;
}

function hashDefinition(definition: ScheduleDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function assertCurrentScope(db: DatabaseSync, definition: ScheduleDefinition): void {
  const room = readCase(db, definition.caseId);
  if (!room || room.closedAt !== null) throw new Error("Schedule Case is missing or closed.");
  if ((projectForWork(db, definition.caseId)?.id ?? null) !== definition.projectId) {
    throw new Error("Schedule project scope changed. Save and review a new revision.");
  }
}

export function installScheduleIpc(options: InstallScheduleIpcOptions) {
  const pendingGrants = new Map<string, PendingGrant>();
  const preparedRuns = new Map<string, { readonly owner: object; readonly occurrenceId: string }>();
  const runs = new Map<string, RunState>();
  const now = options.now ?? Date.now;
  let recovered = false;

  const owner = (event: IpcMainInvokeEvent): object => {
    options.assertTrusted(event);
    const reviewer = options.ownerFor(event);
    // The Book may not be open at IPC installation. Before the first usable
    // schedule action after launch, settle every orphan claim as uncertain.
    // A failed sweep is retried on the next call; it never starts or replays.
    if (!recovered) {
      recoverCrashedOccurrences(options.book(), { at: now() });
      recovered = true;
    }
    return reviewer;
  };

  ipcMain.handle(IPC_CHANNELS.workstationScheduleList, async (event, input: unknown) => {
    owner(event);
    const query = List.parse(input);
    return listScheduleDefinitions(options.book(), query.caseId);
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleSave, async (event, input: unknown) => {
    owner(event);
    const valid = Save.parse(input);
    pendingGrants.forEach((entry, token) => {
      if (entry.scheduleId === valid.scheduleId) pendingGrants.delete(token);
    });
    return saveScheduleDefinition(options.book(), { ...valid, at: now() });
  });

  ipcMain.handle(IPC_CHANNELS.workstationSchedulePreview, async (event, input: unknown) => {
    owner(event);
    const { scheduleId } = ById.parse(input);
    const current = readScheduleDefinition(options.book(), scheduleId);
    if (!current) throw new Error("Schedule is unavailable.");
    assertCurrentScope(options.book(), current.definition);
    return {
      definition: current.definition,
      grant: current.grant,
      grantRevoked: current.grantRevoked,
      next: evaluateRecurrence({ expression: current.definition.expression,
        timezone: current.definition.timezone, afterMs: now(), count: 5,
        maxLookaheadDays: 3660 }).occurrences
    };
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleGrantReview, async (event, input: unknown): Promise<ScheduleGrantReviewView> => {
    const reviewer = owner(event);
    const valid = GrantReview.parse(input);
    const current = readScheduleDefinition(options.book(), valid.scheduleId);
    if (!current || current.definition.revision !== valid.expectedRevision) {
      throw new Error("Schedule revision changed. Review its current definition.");
    }
    assertCurrentScope(options.book(), current.definition);
    if (current.definition.instruction.length > MAX_REVIEWABLE_SCHEDULE_INSTRUCTION) {
      throw new Error("Instructions are too long for the native schedule approval dialog.");
    }
    const at = now();
    if (valid.expiresAt <= at || valid.expiresAt - at > MAX_GRANT_LIFETIME_MS) {
      throw new Error("Schedule grant must expire within 30 days.");
    }
    const nextDueAt = evaluateRecurrence({ expression: current.definition.expression,
      timezone: current.definition.timezone, afterMs: at, count: 1 }).instants
      .filter((dueAt) => dueAt < valid.expiresAt);
    const token = randomBytes(32).toString("hex");
    const reviewExpiresAt = at + GRANT_REVIEW_TTL_MS;
    pendingGrants.set(token, { owner: reviewer, scheduleId: valid.scheduleId,
      revision: valid.expectedRevision, definitionHash: hashDefinition(current.definition),
      grantExpiresAt: valid.expiresAt, reviewExpiresAt });
    while (pendingGrants.size > MAX_GRANT_REVIEWS) {
      const oldest = pendingGrants.keys().next();
      if (oldest.done) break;
      pendingGrants.delete(oldest.value);
    }
    return { token, reviewExpiresAt, grantExpiresAt: valid.expiresAt,
      definition: current.definition, nextDueAt, scope: "queue-only" };
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleGrantConfirm, async (event, input: unknown): Promise<ScheduleRecord> => {
    const reviewer = owner(event);
    const { token } = GrantConfirm.parse(input);
    const pending = pendingGrants.get(token);
    pendingGrants.delete(token);
    if (!pending || pending.owner !== reviewer || now() >= pending.reviewExpiresAt) {
      throw new Error("Schedule grant review expired or belongs to another window.");
    }
    const current = readScheduleDefinition(options.book(), pending.scheduleId);
    if (!current || current.definition.revision !== pending.revision ||
        hashDefinition(current.definition) !== pending.definitionHash) {
      throw new Error("Schedule changed after review. Review again.");
    }
    assertCurrentScope(options.book(), current.definition);
    const view: ScheduleGrantReviewView = {
      token, reviewExpiresAt: pending.reviewExpiresAt, grantExpiresAt: pending.grantExpiresAt,
      definition: current.definition,
      nextDueAt: evaluateRecurrence({ expression: current.definition.expression,
        timezone: current.definition.timezone, afterMs: now(), count: 1 }).instants
        .filter((dueAt) => dueAt < pending.grantExpiresAt),
      scope: "queue-only"
    };
    if (!(await options.confirmOwnerGrant(event, view))) {
      throw new Error("Schedule approval was cancelled. Nothing was enabled.");
    }
    options.assertTrusted(event);
    if (options.ownerFor(event) !== reviewer || now() >= pending.reviewExpiresAt) {
      throw new Error("Schedule review expired or its window changed during confirmation.");
    }
    const latest = readScheduleDefinition(options.book(), pending.scheduleId);
    if (!latest || latest.definition.revision !== pending.revision ||
        hashDefinition(latest.definition) !== pending.definitionHash) {
      throw new Error("Schedule changed during confirmation. Review again.");
    }
    assertCurrentScope(options.book(), latest.definition);
    return grantScheduleAdmission(options.book(), {
      scheduleId: pending.scheduleId, expectedRevision: pending.revision,
      ownerActionId: randomUUID(), expiresAt: pending.grantExpiresAt, at: now()
    });
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleRevoke, async (event, input: unknown) => {
    owner(event);
    const valid = Revoke.parse(input);
    options.admission.revoke({ ...valid, ownerActionId: randomUUID(), at: now() });
    pendingGrants.forEach((entry, token) => {
      if (entry.scheduleId === valid.scheduleId) pendingGrants.delete(token);
    });
    return readScheduleDefinition(options.book(), valid.scheduleId);
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleQueue, async (event, input: unknown) => {
    owner(event);
    const { scheduleId } = ById.parse(input);
    return admitScheduledOccurrence(options.book(), { scheduleId, asOf: now() });
  });

  ipcMain.handle(IPC_CHANNELS.workstationSchedulePrepare, async (event, input: unknown): Promise<ScheduledHostReview> => {
    const reviewer = owner(event);
    const valid = Prepare.parse(input);
    const review = await options.admission.prepare({ ...valid, owner: reviewer });
    options.assertTrusted(event);
    if (options.ownerFor(event) !== reviewer) throw new Error("Window changed during schedule review.");
    preparedRuns.set(review.token, { owner: reviewer, occurrenceId: valid.occurrenceId });
    while (preparedRuns.size > MAX_GRANT_REVIEWS) {
      const oldest = preparedRuns.keys().next();
      if (oldest.done) break;
      preparedRuns.delete(oldest.value);
    }
    return review;
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleStart, async (event, input: unknown): Promise<ScheduleRunView> => {
    const reviewer = owner(event);
    const { token } = GrantConfirm.parse(input);
    const prepared = preparedRuns.get(token);
    preparedRuns.delete(token);
    if (!prepared || prepared.owner !== reviewer) {
      throw new Error("Scheduled Start review is unavailable to this window.");
    }
    // Adapter owns the token and consumes it once. It will revalidate the
    // schedule grant and saved context before the shared host can start.
    if (runs.size >= MAX_RUN_VIEWS) {
      for (const [id, state] of runs) {
        if (state.view.status !== "working") runs.delete(id);
        if (runs.size < MAX_RUN_VIEWS) break;
      }
    }
    if (runs.size >= MAX_RUN_VIEWS) throw new Error("Too many scheduled runs are still active.");
    const runId = randomUUID();
    const started: ScheduleRunView = { runId, occurrenceId: prepared.occurrenceId, status: "working",
      detail: "Starting reviewed scheduled work.", operationId: null };
    const state: RunState = { owner: reviewer, occurrenceId: prepared.occurrenceId, view: started };
    runs.set(runId, state);
    void options.admission.start({ token, owner: reviewer }).then((result) => {
      state.view = { runId, occurrenceId: result.occurrence.occurrenceId,
        status: result.occurrence.status === "completed" ? "completed"
          : result.occurrence.status === "stopped" ? "stopped"
          : result.occurrence.status === "failed" ? "failed" : "uncertain",
        detail: result.snapshot.detail, operationId: result.snapshot.operationId };
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "Scheduled Start failed.";
      let status: ScheduleRunView["status"] = "rejected";
      try {
        if (getOccurrence(options.book(), state.occurrenceId)?.status === "uncertain") status = "uncertain";
      } catch {
        status = "uncertain";
      }
      state.view = { ...state.view,
        status,
        detail: detail.slice(0, 2000) };
    });
    return started;
  });

  ipcMain.handle(IPC_CHANNELS.workstationSchedulePoll, async (event, input: unknown): Promise<ScheduleRunView> => {
    const reviewer = owner(event);
    const { runId } = Run.parse(input);
    const state = runs.get(runId);
    if (!state || state.owner !== reviewer) throw new Error("Scheduled run is unavailable to this window.");
    return state.view;
  });

  ipcMain.handle(IPC_CHANNELS.workstationScheduleStop, async (event, input: unknown): Promise<ScheduleRunView> => {
    const reviewer = owner(event);
    const { runId } = Run.parse(input);
    const state = runs.get(runId);
    if (!state || state.owner !== reviewer) throw new Error("Scheduled run is unavailable to this window.");
    if (state.occurrenceId !== "" && options.admission.stopOccurrence(state.occurrenceId, reviewer)) {
      state.view = { ...state.view, detail: "Stop requested; waiting for the host to settle." };
    }
    return state.view;
  });

  return {
    cancelOwner(ownerValue: object): void {
      for (const [token, entry] of pendingGrants) if (entry.owner === ownerValue) pendingGrants.delete(token);
      for (const [token, entry] of preparedRuns) if (entry.owner === ownerValue) preparedRuns.delete(token);
      for (const [runId, state] of runs) if (state.owner === ownerValue) runs.delete(runId);
      options.admission.cancelOwner(ownerValue);
    },
    stopActive(): boolean {
      const hadPending = pendingGrants.size > 0 || preparedRuns.size > 0;
      pendingGrants.clear();
      preparedRuns.clear();
      return options.admission.stopActive() || hadPending;
    },
    shutdown(): void {
      pendingGrants.clear();
      preparedRuns.clear();
      options.admission.stopActive();
      runs.clear();
    }
  };
}
