/** Owner-authored project model policy crosses only the trusted desktop bridge. */
import type { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { ProjectPreferences } from "./model-choice-advisor.js";
import {
  ProjectIdSchema,
  ProjectPreferencesSchema,
  forgetProjectModelPreferences,
  getProjectModelPreferences,
  saveProjectModelPreferences
} from "./model-project-preferences-store.js";

const Read = z.strictObject({ projectId: ProjectIdSchema });
const Save = z.strictObject({
  projectId: ProjectIdSchema,
  expectedRevision: z.number().int().safe().min(0),
  preferences: ProjectPreferencesSchema
});
const Forget = z.strictObject({
  projectId: ProjectIdSchema,
  expectedRevision: z.number().int().safe().min(1)
});

export function installModelPreferencesIpc(options: {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
}): void {
  ipcMain.handle(IPC_CHANNELS.workstationModelPreferencesRead, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = Read.parse(input);
    // A tombstone still has the revision needed for a later explicit save.
    return getProjectModelPreferences(options.book(), valid.projectId, { includeDeleted: true });
  });
  ipcMain.handle(IPC_CHANNELS.workstationModelPreferencesSave, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = Save.parse(input);
    const parsed = valid.preferences;
    const preferences: ProjectPreferences = {
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
      ...(parsed.exclusions !== undefined ? { exclusions: parsed.exclusions.map((one) => ({
        providerId: one.providerId,
        ...(one.modelId !== undefined ? { modelId: one.modelId } : {})
      })) } : {}),
      ...(parsed.providerWeights !== undefined ? { providerWeights: parsed.providerWeights } : {}),
      ...(parsed.modelWeights !== undefined ? { modelWeights: parsed.modelWeights } : {}),
      ...(parsed.providerModelWeights !== undefined ? { providerModelWeights: parsed.providerModelWeights } : {}),
      ...(parsed.capabilityWeights !== undefined ? { capabilityWeights: parsed.capabilityWeights } : {})
    };
    return saveProjectModelPreferences(options.book(), {
      projectId: valid.projectId, expectedRevision: valid.expectedRevision, preferences
    });
  });
  ipcMain.handle(IPC_CHANNELS.workstationModelPreferencesForget, async (event, input: unknown) => {
    options.assertTrusted(event);
    const valid = Forget.parse(input);
    return forgetProjectModelPreferences(options.book(), valid);
  });
}
