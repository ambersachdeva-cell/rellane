import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { analysePaste, type PasteAnalysis } from "./paste-source.js";

/**
 * Upper limit on characters accepted across the IPC boundary.
 *
 * Bounded generously above paste-source's MAX_PASTE_CHARS (500,000) so that oversize
 * pastes reach paste-source's analysis and return friendly warnings rather than failing
 * schema validation at the boundary, while still guarding the host against runaway payloads.
 */
export const WORKSTATION_PASTE_INPUT_LIMIT = 2_000_000;

export const WorkstationPasteInputSchema = z.object({
  text: z.string().max(WORKSTATION_PASTE_INPUT_LIMIT)
});

export type WorkstationPasteInput = z.infer<typeof WorkstationPasteInputSchema>;

export interface InstallWorkstationPasteOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
}

export function installWorkstationPaste(options: InstallWorkstationPasteOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  ipcMain.handle(IPC_CHANNELS.workstationPasteAnalyse, async (event, input: unknown): Promise<PasteAnalysis> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    const request = WorkstationPasteInputSchema.parse(
      typeof input === "string" ? { text: input } : input
    );

    // The pasted text is never logged, never written to disk, and never sent anywhere.
    // A paste is the single most likely place for a credential to enter this app, which
    // is exactly why paste-source warns about secrets — and why this channel must not
    // persist what it inspects.
    const result = analysePaste(request.text);

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while analysing the paste.");
    }

    return result;
  });
}
