import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { publishOutput, type PublishFormat } from "./publish-output.js";

export const WorkstationPublishInputSchema = z.object({
  caseId: z.string().min(1),
  format: z.enum(["html", "markdown", "slides"] satisfies [PublishFormat, ...PublishFormat[]])
});

export type WorkstationPublishInput = z.infer<typeof WorkstationPublishInputSchema>;
export const PublishInputSchema = WorkstationPublishInputSchema;
export type PublishRequest = WorkstationPublishInput;

export interface PublishPreviewFile {
  readonly relativePath: string;
  readonly bytes: number;
}

export interface PublishPreviewResult {
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly files: readonly PublishPreviewFile[];
}

export interface PublishWriteResult {
  readonly writtenTo: string;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly files: readonly PublishPreviewFile[];
}

export type PublishPreviewResponse = PublishPreviewResult;
export type PublishWriteResponse = PublishWriteResult;

export interface InstallPublishOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** The one folder this piece of work may write into, or null when it has none. */
  readonly caseFolder: (caseId: string) => Promise<string | null>;
  /** The output to publish, and the work's title. Null when there is nothing saved yet. */
  readonly latestOutput: (caseId: string) => Promise<{
    readonly title: string;
    readonly body: string;
    readonly sources: readonly { readonly label: string }[];
  } | null>;
  readonly write: (
    folder: string,
    files: readonly { readonly relativePath: string; readonly contents: string }[]
  ) => Promise<string>;
}

// Ensure relative paths never escape the target directory using directory traversal or absolute paths.
function assertSafePath(folder: string, relativePath: string): void {
  // A relative path containing ".." must be rejected immediately before touching disk.
  if (relativePath.includes("..")) {
    throw new Error("A published file path falls outside the destination folder.");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("A published file path falls outside the destination folder.");
  }

  const resolvedFolder = path.resolve(folder);
  const resolvedTarget = path.resolve(folder, relativePath);
  const rel = path.relative(resolvedFolder, resolvedTarget);

  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
    throw new Error("A published file path falls outside the destination folder.");
  }
}

function assertSafePaths(
  folder: string,
  files: readonly { readonly relativePath: string }[]
): void {
  for (const file of files) {
    assertSafePath(folder, file.relativePath);
  }
}

function toByteLength(contents: string): number {
  return Buffer.byteLength(contents, "utf8");
}

export function installPublish(options: InstallPublishOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  // Guard against overlapping writes across the workstation session to prevent disk race conditions.
  let isWriting = false;

  ipcMain.handle(
    IPC_CHANNELS.workstationPublishPreview,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<PublishPreviewResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationPublishInputSchema.parse(input);

      const output = await options.latestOutput(request.caseId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while preparing the preview.");
      }

      if (!output) {
        throw new Error("This case has no saved output to publish.");
      }

      const result = publishOutput({
        title: output.title,
        body: output.body,
        format: request.format,
        author: "Amber",
        at: Date.now(),
        sources: output.sources
      });

      const files: readonly PublishPreviewFile[] = result.files.map((file) => ({
        relativePath: file.relativePath,
        bytes: toByteLength(file.contents)
      }));

      return {
        summary: result.summary,
        warnings: result.warnings,
        files
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationPublishWrite,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<PublishWriteResult> => {
      if (isWriting) {
        throw new Error("Another publish is already in progress.");
      }

      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationPublishInputSchema.parse(input);

      isWriting = true;
      try {
        const output = await options.latestOutput(request.caseId);
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while publishing.");
        }

        if (!output) {
          throw new Error("This case has no saved output to publish.");
        }

        const folder = await options.caseFolder(request.caseId);
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while publishing.");
        }

        if (!folder || folder.trim() === "") {
          throw new Error("This case does not have a folder to write into.");
        }

        const result = publishOutput({
          title: output.title,
          body: output.body,
          format: request.format,
          author: "Amber",
          at: Date.now(),
          sources: output.sources
        });

        assertSafePaths(folder, result.files);

        const writtenTo = await options.write(folder, result.files);
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while publishing.");
        }

        const files: readonly PublishPreviewFile[] = result.files.map((file) => ({
          relativePath: file.relativePath,
          bytes: toByteLength(file.contents)
        }));

        return {
          writtenTo,
          summary: result.summary,
          warnings: result.warnings,
          files
        };
      } finally {
        isWriting = false;
      }
    }
  );
}
