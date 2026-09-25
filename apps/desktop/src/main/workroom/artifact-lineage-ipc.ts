import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { readCase } from "../book/cases.js";
import {
  artifactLineage,
  type ArtifactLineageEntry
} from "./artifacts.js";

export const ArtifactLineageInputSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(64)
});

export type ArtifactLineageInput = z.infer<typeof ArtifactLineageInputSchema>;

export interface InstallArtifactLineageOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
}

export function installArtifactLineage({
  assertTrusted,
  book
}: InstallArtifactLineageOptions): () => void {
  ipcMain.handle(
    IPC_CHANNELS.casesArtifactLineage,
    async (
      event: IpcMainInvokeEvent,
      input: unknown
    ): Promise<readonly ArtifactLineageEntry[]> => {
      assertTrusted(event);
      const { caseId } = ArtifactLineageInputSchema.parse(input);
      const db = book();
      const room = readCase(db, caseId);
      if (!room) {
        throw new Error("Workroom not found");
      }
      return artifactLineage(db, caseId);
    }
  );

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.casesArtifactLineage);
  };
}

export function uninstallArtifactLineage(): void {
  ipcMain.removeHandler(IPC_CHANNELS.casesArtifactLineage);
}
