import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { listWorkspace, previewFile } from "./workspace-files.js";
import { compareText, type FileChange } from "./file-change.js";

export const WorkstationFilesListInputSchema = z.object({
  caseId: z.string().min(1)
});

export const WorkstationFilePreviewInputSchema = z.object({
  caseId: z.string().min(1),
  relativePath: z.string().min(1)
});

export const WorkstationFileChangeInputSchema = z
  .object({
    caseId: z.string().min(1),
    relativePath: z.string().min(1),
    previousText: z.string().optional(),
    lastSeenText: z.string().optional(),
    before: z.string().optional()
  })
  .refine(
    (val) =>
      val.previousText !== undefined ||
      val.lastSeenText !== undefined ||
      val.before !== undefined,
    {
      message: "Previous text is required to calculate file changes."
    }
  );

export interface WorkstationFilesListInput {
  readonly caseId: string;
}

export interface WorkstationFilePreviewInput {
  readonly caseId: string;
  readonly relativePath: string;
}

export interface WorkstationFileChangeInput {
  readonly caseId: string;
  readonly relativePath: string;
  readonly previousText?: string;
  readonly lastSeenText?: string;
  readonly before?: string;
}

export interface InstallWorkstationFilesOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly workspaceFor: (caseId: string) => Promise<string | null>;
  readonly readFile: (absolutePath: string) => Promise<string>;
}

// Sibling paths, parent directories and symlinks are verified against the root
// so callers cannot escape the designated workspace folder.
function isInsideRoot(candidate: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// When a file has been removed by the user or session, diffing returns a missing
// change record rather than terminating the channel with an exception.
function isMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && (error as { readonly code?: unknown }).code === "ENOENT") {
      return true;
    }
    if (
      "message" in error &&
      typeof (error as { readonly message?: unknown }).message === "string"
    ) {
      const msg = (error as { readonly message: string }).message.toLowerCase();
      if (
        msg.includes("enoent") ||
        msg.includes("not found") ||
        msg.includes("does not exist")
      ) {
        return true;
      }
    }
  }
  return false;
}

async function computeFileChange(
  workspaceRoot: string,
  request: WorkstationFileChangeInput,
  readFile: (absolutePath: string) => Promise<string>
): Promise<FileChange> {
  const resolvedRoot = path.resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch {
    return {
      relativePath: request.relativePath,
      kind: "missing",
      added: 0,
      removed: 0,
      hunks: [],
      truncated: false,
      summary: "This file could not be found."
    };
  }

  const cleanRelative = request.relativePath.replace(/^[/\\]+/, "");
  const targetPath = path.resolve(canonicalRoot, cleanRelative);
  if (!isInsideRoot(targetPath, canonicalRoot)) {
    throw new Error("The requested path is outside the workspace.");
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(targetPath);
  } catch {
    return {
      relativePath: request.relativePath,
      kind: "missing",
      added: 0,
      removed: 0,
      hunks: [],
      truncated: false,
      summary: "This file could not be found."
    };
  }

  if (!isInsideRoot(realTarget, canonicalRoot)) {
    throw new Error("The requested file links outside the workspace.");
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(realTarget);
  } catch {
    return {
      relativePath: request.relativePath,
      kind: "missing",
      added: 0,
      removed: 0,
      hunks: [],
      truncated: false,
      summary: "This file could not be found."
    };
  }

  if (stat.isDirectory()) {
    throw new Error("The requested path is a folder, not a file.");
  }

  if (!stat.isFile()) {
    throw new Error("The requested path is not a regular file.");
  }

  let currentText: string;
  try {
    currentText = await readFile(realTarget);
  } catch (error: unknown) {
    if (isMissingError(error)) {
      return {
        relativePath: request.relativePath,
        kind: "missing",
        added: 0,
        removed: 0,
        hunks: [],
        truncated: false,
        summary: "This file could not be found."
      };
    }
    throw new Error("The file could not be opened for reading.");
  }

  const beforeText =
    request.previousText ?? request.lastSeenText ?? request.before ?? "";
  return compareText(beforeText, currentText, request.relativePath);
}

export function installWorkstationFiles(options: InstallWorkstationFilesOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let previewInFlight = false;
  let changeInFlight = false;

  ipcMain.handle(IPC_CHANNELS.workstationFilesList, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    const request = WorkstationFilesListInputSchema.parse(input);

    const workspace = await options.workspaceFor(request.caseId);
    if (!workspace) {
      throw new Error("This work has no workspace folder.");
    }

    const result = await listWorkspace(workspace);

    options.assertTrusted(event);
    if (ownerFor(event) !== owner) {
      throw new Error("This window changed while reading workspace files.");
    }

    return result;
  });

  ipcMain.handle(IPC_CHANNELS.workstationFilePreview, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (previewInFlight) {
      throw new Error("A file preview is already running. Wait for it to finish.");
    }

    const request = WorkstationFilePreviewInputSchema.parse(input);

    previewInFlight = true;
    try {
      const workspace = await options.workspaceFor(request.caseId);
      if (!workspace) {
        throw new Error("This work has no workspace folder.");
      }

      const result = await previewFile(workspace, request.relativePath);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while previewing the file.");
      }

      return result;
    } finally {
      previewInFlight = false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.workstationFileChange, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (changeInFlight) {
      throw new Error("A file change check is already running. Wait for it to finish.");
    }

    const request = WorkstationFileChangeInputSchema.parse(input);

    changeInFlight = true;
    try {
      const workspace = await options.workspaceFor(request.caseId);
      if (!workspace) {
        throw new Error("This work has no workspace folder.");
      }

      // Optional properties must be ABSENT, not present-and-undefined. Built by
      // assignment rather than by filtering an object, so the type is the
      // declared one throughout instead of being asserted back into shape.
      const previous = request.previousText ?? request.lastSeenText ?? request.before;
      const changeInput: WorkstationFileChangeInput = {
        caseId: request.caseId,
        relativePath: request.relativePath,
        ...(previous === undefined ? {} : { previousText: previous })
      };
      const result = await computeFileChange(workspace, changeInput, options.readFile);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while checking file changes.");
      }

      return result;
    } finally {
      changeInFlight = false;
    }
  });
}
