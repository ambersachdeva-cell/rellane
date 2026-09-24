/** Shared briefs and reusable procedures stay local until an ordinary reviewed send. */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WorkstationProjectSaveInputSchema, WorkstationProjectAssignInputSchema, WorkstationProjectCaptureInputSchema, WorkstationRoutineSaveInputSchema } from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { listWorkstationProjects, listWorkstationProjectLinks, saveWorkstationProject, assignWorkstationProject, captureProjectBrief } from "./projects.js";
import { listSavedWorkstationRoutines, saveWorkstationRoutine, savedWorkstationRoutineVersions } from "./saved-routines.js";
import { renameWork, WorkTitleRequest } from "./work-title.js";

const VersionRequest = z.strictObject({ id: z.uuid() });

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
  ipcMain.handle(IPC_CHANNELS.workstationContinuity, event => {
    options.assertTrusted(event);
    const db = options.book();
    return { projects: listWorkstationProjects(db), links: listWorkstationProjectLinks(db), routines: listSavedWorkstationRoutines(db) };
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
