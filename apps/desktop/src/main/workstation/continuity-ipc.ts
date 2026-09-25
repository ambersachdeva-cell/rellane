/** Shared briefs and reusable procedures stay local until an ordinary reviewed send. */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WorkstationProjectSaveInputSchema, WorkstationProjectAssignInputSchema, WorkstationProjectCaptureInputSchema, WorkstationRoutineSaveInputSchema } from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { listWorkstationProjects, listWorkstationProjectLinks, saveWorkstationProject, assignWorkstationProject, captureProjectBrief } from "./projects.js";
import { listSavedWorkstationRoutines, saveWorkstationRoutine, savedWorkstationRoutineVersions } from "./saved-routines.js";
import { renameWork, WorkTitleRequest } from "./work-title.js";
import { buildHandoffBrief, HANDOFF_BUDGET_CHARS, type HandoffBrief, type TurnLike } from "./handoff-brief.js";
import { composeWithHandoff, type ComposeResult } from "./handoff-compose.js";
import { proposeRoutine, type ProposedRoutine } from "./learned-routines.js";

const VersionRequest = z.strictObject({ id: z.uuid() });

export function computeCaseHandoff(
  db: DatabaseSync,
  input: {
    readonly caseId: string;
    readonly currentProviderId?: string;
    readonly lastProviderId?: string | null;
    readonly draft?: string;
    readonly budgetChars?: number;
  }
): { readonly brief: HandoffBrief; readonly composed: ComposeResult | null } {
  const turnRows = db
    .prepare("SELECT id, seat, kind, body FROM case_turn WHERE case_id = ? ORDER BY seq ASC")
    .all(input.caseId) as Array<{
    id?: unknown;
    seat?: unknown;
    kind?: unknown;
    body?: unknown;
  }>;

  const turns: TurnLike[] = turnRows.map((row) => ({
    id: String(row.id ?? ""),
    seat: String(row.seat ?? ""),
    kind: String(row.kind ?? ""),
    body: String(row.body ?? "")
  }));

  const brief = buildHandoffBrief(
    turns,
    input.budgetChars !== undefined ? { budgetChars: input.budgetChars } : undefined
  );

  let composed: ComposeResult | null = null;
  if (input.currentProviderId !== undefined && input.draft !== undefined) {
    const inferredLastProvider =
      input.lastProviderId !== undefined
        ? input.lastProviderId
        : turns
            .slice()
            .reverse()
            .find((t) => t.seat !== "owner" && !t.seat.startsWith("Source"))?.seat ?? null;
    composed = composeWithHandoff({
      providerId: input.currentProviderId,
      lastProviderId: inferredLastProvider,
      briefText: brief.text,
      prompt: input.draft,
      budgetChars: input.budgetChars ?? HANDOFF_BUDGET_CHARS * 2
    });
  }

  return { brief, composed };
}

export function computeLearnedRoutinesForDb(db: DatabaseSync): readonly ProposedRoutine[] {
  const caseRows = db
    .prepare("SELECT id FROM work_case ORDER BY opened_at DESC LIMIT 50")
    .all() as Array<{ id?: unknown }>;
  const turnsStatement = db.prepare(
    "SELECT id, seat, kind, body FROM case_turn WHERE case_id = ? ORDER BY seq ASC"
  );
  const proposals: ProposedRoutine[] = [];
  for (const row of caseRows) {
    const caseId = String(row.id ?? "");
    const turns = (
      turnsStatement.all(caseId) as Array<{
        id?: unknown;
        seat?: unknown;
        kind?: unknown;
        body?: unknown;
      }>
    ).map((turn) => ({
      id: String(turn.id ?? ""),
      seat: String(turn.seat ?? ""),
      kind: String(turn.kind ?? ""),
      body: String(turn.body ?? "")
    }));
    const proposed = proposeRoutine(turns);
    if (proposed !== null) {
      proposals.push(proposed);
    }
  }
  return proposals;
}

export function installWorkstationContinuity(options: {
  readonly book: () => DatabaseSync;
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly assertIdle: (caseId: string) => void;
}): void {
  ipcMain.handle(IPC_CHANNELS.workstationRenameWork, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkTitleRequest.parse(input);
    options.assertIdle(request.caseId);
    return renameWork(options.book(), request);
  });
  ipcMain.handle(IPC_CHANNELS.workstationContinuity, (event, raw?: unknown) => {
    options.assertTrusted(event);
    const db = options.book();
    const base = {
      projects: listWorkstationProjects(db),
      links: listWorkstationProjectLinks(db),
      routines: listSavedWorkstationRoutines(db)
    };
    if (!raw || typeof raw !== "object") {
      return base;
    }
    const params = raw as {
      includeLearned?: unknown;
      handoffCaseId?: unknown;
      currentProviderId?: unknown;
      lastProviderId?: unknown;
      draft?: unknown;
      budgetChars?: unknown;
    };
    const hasLearned = params.includeLearned === true;
    const hasHandoff = typeof params.handoffCaseId === "string" && params.handoffCaseId.length > 0;
    if (!hasLearned && !hasHandoff) {
      return base;
    }
    return {
      ...base,
      ...(hasLearned ? { learnedRoutines: computeLearnedRoutinesForDb(db) } : {}),
      ...(hasHandoff
        ? {
            handoff: computeCaseHandoff(db, {
              caseId: params.handoffCaseId as string,
              ...(typeof params.currentProviderId === "string"
                ? { currentProviderId: params.currentProviderId }
                : {}),
              ...(typeof params.lastProviderId === "string" || params.lastProviderId === null
                ? { lastProviderId: params.lastProviderId }
                : {}),
              ...(typeof params.draft === "string" ? { draft: params.draft } : {}),
              ...(typeof params.budgetChars === "number" ? { budgetChars: params.budgetChars } : {})
            })
          }
        : {})
    };
  });
  ipcMain.handle(IPC_CHANNELS.workstationProjectSave, (event, input: unknown) => {
    options.assertTrusted(event);
    return saveWorkstationProject(options.book(), WorkstationProjectSaveInputSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.workstationProjectAssign, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationProjectAssignInputSchema.parse(input);
    options.assertIdle(request.caseId);
    return assignWorkstationProject(options.book(), request);
  });
  ipcMain.handle(IPC_CHANNELS.workstationProjectCapture, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationProjectCaptureInputSchema.parse(input);
    options.assertIdle(request.caseId);
    return captureProjectBrief(options.book(), request);
  });
  ipcMain.handle(IPC_CHANNELS.workstationRoutineSave, (event, input: unknown) => {
    options.assertTrusted(event);
    return saveWorkstationRoutine(options.book(), WorkstationRoutineSaveInputSchema.parse(input));
  });
  ipcMain.handle(IPC_CHANNELS.workstationRoutineVersions, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = VersionRequest.parse(input);
    return savedWorkstationRoutineVersions(options.book(), request.id);
  });
}
