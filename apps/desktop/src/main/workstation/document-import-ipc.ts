import type { IpcMainInvokeEvent } from "electron";
import { app, ipcMain } from "electron";
import path from "node:path";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  importDocument,
  type DocumentImportResult,
  type DocumentImportRuntimeOptions
} from "./document-import.js";

export const WORKSTATION_DOCUMENT_IMPORT_PATH_LIMIT = 4096;

/**
 * Never pass a path the renderer chose straight through. The owner picks a file
 * with Electron's own dialog; this handler accepts only a path that dialog produced.
 * In the IPC boundary we enforce what we can: bounded length, absolute paths only,
 * and rejection of null bytes.
 */
const PathStringSchema = z
  .string()
  .min(1, "Path cannot be empty.")
  .max(
    WORKSTATION_DOCUMENT_IMPORT_PATH_LIMIT,
    `Path exceeds ${WORKSTATION_DOCUMENT_IMPORT_PATH_LIMIT} character limit.`
  )
  .refine((val) => !val.includes("\0"), "Path must not contain null bytes.")
  .refine((val) => path.isAbsolute(val), "Path must be an absolute path.");

export const WorkstationDocumentImportInputSchema = z
  .union([
    PathStringSchema,
    z.object({
      filePath: PathStringSchema
    })
  ])
  .transform((val) => (typeof val === "string" ? val : val.filePath));

export const DocumentImportInputSchema = WorkstationDocumentImportInputSchema;

/**
 * Where the document import converter lives, dev and packaged.
 *
 * Exported to mirror runtime options resolution across workstation channels.
 * `app.isPackaged` and `process.resourcesPath` are only meaningful once Electron is ready.
 */
export function defaultDocumentImportRuntimeOptions(): DocumentImportRuntimeOptions {
  return {
    scriptPath: app.isPackaged
      ? path.join(process.resourcesPath, "scripts", "document-import-bridge.py")
      : path.join(app.getAppPath(), "scripts", "document-import-bridge.py")
  };
}

function sanitizeReason(reason: string): string {
  // Never let a filesystem path from an error reach the renderer.
  if (!reason.includes("/")) {
    return reason;
  }
  const scrubbed = reason
    .replace(/(?:^|\s)\/(?:[^\s]+\/)*[^\s]*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (scrubbed.length > 0 && !scrubbed.includes("/")) {
    return scrubbed;
  }
  return "The selected document could not be imported.";
}

export function installWorkstationDocumentImport(options: {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly runtimeOptions?: DocumentImportRuntimeOptions;
}): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;
  const runtimeOptions = (): DocumentImportRuntimeOptions =>
    options.runtimeOptions ?? defaultDocumentImportRuntimeOptions();

  ipcMain.handle(IPC_CHANNELS.workstationDocumentImport, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("A document conversion is already running. Wait for it to finish.");
    }

    const filePath = WorkstationDocumentImportInputSchema.parse(input);

    inFlight = true;
    try {
      let result: DocumentImportResult;
      try {
        result = await importDocument({
          filePath,
          runtimeOptions: runtimeOptions()
        });
      } catch {
        result = {
          status: "unavailable",
          reason: "The selected document could not be imported."
        };
      }

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while converting the document.");
      }

      if (result.status === "unavailable") {
        return {
          status: "unavailable",
          reason: sanitizeReason(result.reason)
        };
      }

      return result;
    } finally {
      inFlight = false;
    }
  });
}
