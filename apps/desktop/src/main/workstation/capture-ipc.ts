import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  captureTarget,
  listCaptureTargets,
  type CaptureDeps,
  type CaptureOutcome,
  type CaptureTarget
} from "./screen-source.js";

export type { CaptureOutcome, CaptureTarget };

export interface InstallWorkstationCaptureOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly listSources: CaptureDeps["listSources"];
  readonly captureDir: (caseId: string) => Promise<string>;
}

export const WorkstationCaptureListInputSchema = z
  .object({
    caseId: z.string().min(1).optional()
  })
  .nullish();

export const WorkstationCaptureTakeInputSchema = z.object({
  caseId: z.string().min(1, "A case ID must be specified."),
  targetId: z.string().min(1, "A window or screen must be selected.")
});

// Screen capture is strictly on-demand. Never capture on a timer, never on an
// interval, and never in response to anything but an explicit IPC call from you.
// Automated background recording without direct consent contradicts the workstation
// security model.
export function installWorkstationCapture(options: InstallWorkstationCaptureOptions): void {
  const allowedTargetsByOwner = new Map<unknown, Set<string>>();
  let activeOwner: unknown = undefined;

  const owners = createAgentSourceOwners((evictedOwner) => {
    if (evictedOwner !== undefined) {
      allowedTargetsByOwner.delete(evictedOwner);
    } else {
      allowedTargetsByOwner.clear();
    }
    if (evictedOwner === activeOwner) {
      activeOwner = undefined;
    }
  });

  const ownerFor = (event: IpcMainInvokeEvent): unknown => owners(event.sender, event.senderFrame);

  let inFlight = false;

  ipcMain.handle(IPC_CHANNELS.workstationCaptureList, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    // Switching window owners invalidates previously listed targets to prevent cross-window capture.
    if (activeOwner !== undefined && activeOwner !== owner) {
      allowedTargetsByOwner.delete(activeOwner);
    }
    activeOwner = owner;

    WorkstationCaptureListInputSchema.parse(input);

    let targets: readonly CaptureTarget[];
    try {
      targets = await listCaptureTargets({ listSources: options.listSources });
    } catch {
      targets = [];
    }

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      allowedTargetsByOwner.delete(owner);
      throw new Error("This window changed while listing capture targets.");
    }

    // Pinned target IDs ensure take cannot be invoked with an arbitrary or unlisted identifier.
    const allowed = new Set(targets.map((target) => target.id));
    allowedTargetsByOwner.set(owner, allowed);

    return targets;
  });

  ipcMain.handle(IPC_CHANNELS.workstationCaptureTake, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    if (activeOwner !== undefined && activeOwner !== owner) {
      allowedTargetsByOwner.delete(activeOwner);
    }
    activeOwner = owner;

    // Enforcing single in-flight capture protects memory and display server load.
    if (inFlight) {
      throw new Error("A screen capture is already running. Wait for it to finish.");
    }

    const request = WorkstationCaptureTakeInputSchema.parse(input);

    const allowed = allowedTargetsByOwner.get(owner);
    if (!allowed || !allowed.has(request.targetId)) {
      throw new Error("The selected window or screen was not listed. Choose a target from the list before capturing.");
    }

    inFlight = true;
    try {
      let outputDir: string;
      try {
        outputDir = path.resolve(await options.captureDir(request.caseId));
        await fs.mkdir(outputDir, { recursive: true });
      } catch {
        // Neutral failure prevents leaking filesystem paths or internal stack traces to the renderer.
        return {
          status: "unavailable",
          reason: "The destination folder for this work is not available."
        };
      }

      let result: CaptureOutcome;
      try {
        result = await captureTarget(
          { listSources: options.listSources },
          request.targetId,
          outputDir,
          Date.now()
        );
      } catch {
        return {
          status: "unavailable",
          reason: "The screen capture could not be completed."
        };
      }

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        allowedTargetsByOwner.delete(owner);
        throw new Error("This window changed while capturing the screen.");
      }

      // Verify write boundary to guarantee confinement to the designated case folder.
      if (result.status === "captured") {
        const relative = path.relative(outputDir, result.pngPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return {
            status: "unavailable",
            reason: "The capture path resolved outside the destination folder."
          };
        }
      }

      return result;
    } finally {
      inFlight = false;
    }
  });
}
