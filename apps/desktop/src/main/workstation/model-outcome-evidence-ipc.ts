import type { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { readModelOutcomeEvidence } from "./model-outcome-evidence-store.js";
import type { ModelOutcomeEvidence } from "./model-outcome-evidence.js";

export const ModelOutcomeEvidenceInputSchema = z.strictObject({
  projectId: z.string().trim().min(1).max(128).nullable().optional(),
  caseId: z.string().trim().min(1).max(64).optional(),
  maxReceipts: z.number().int().min(1).max(5_000).optional()
});

export function installModelOutcomeEvidence(options: {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
}): void {
  ipcMain.handle(
    IPC_CHANNELS.workstationModelOutcomeEvidence,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<readonly ModelOutcomeEvidence[]> => {
      options.assertTrusted(event);
      const parsed = ModelOutcomeEvidenceInputSchema.parse(input);
      return readModelOutcomeEvidence(options.book(), {
        ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
        ...(parsed.caseId !== undefined ? { caseId: parsed.caseId } : {}),
        ...(parsed.maxReceipts !== undefined ? { maxReceipts: parsed.maxReceipts } : {})
      });
    }
  );
}
