import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { readWebPage, type WebReadOutcome } from "./web-read.js";

/**
 * Why: Address validation and private-network refusal are strictly enforced
 * by `readWebPage` in `web-read.ts`. This IPC channel deliberately exposes no
 * parameter, flag, or configuration to relax or bypass private host checks,
 * ensuring non-public and loopback hosts can never be reached across the boundary.
 */

/**
 * Why: The owner's reading history is private. Web addresses and page contents
 * are never logged to console, disk, or telemetry.
 */

export const WebReadInputSchema = z.union([
  z
    .object({
      url: z.string().max(2000)
    })
    .strict(),
  z
    .string()
    .max(2000)
    .transform((url) => ({ url }))
]);

export type WebReadInput = z.infer<typeof WebReadInputSchema>;

export interface WorkstationWebReadOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
}

export function installWorkstationWebRead(options: WorkstationWebReadOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;

  ipcMain.handle(
    IPC_CHANNELS.workstationWebRead,
    async (event, input: unknown): Promise<WebReadOutcome> => {
      // Why: Untrusted callers must be rejected immediately before evaluating inputs or state.
      options.assertTrusted(event);
      const owner = ownerFor(event);

      // Why: Network page reads are slow; concurrent requests are almost always accidental double-clicks.
      if (inFlight) {
        throw new Error("A web page read is already running. Wait for it to finish.");
      }

      const request = WebReadInputSchema.parse(input);

      inFlight = true;
      try {
        const result = await readWebPage(request.url, Date.now());

        // Why: Mid-flight navigation must prevent the incoming response from leaking to a replacement frame.
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while reading the web page.");
        }

        // Why: Refusals and final redirect URLs are preserved directly from the outcome union without throwing.
        return result;
      } finally {
        inFlight = false;
      }
    }
  );
}
