import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

export type AgentSourceOwner = ReturnType<ReturnType<typeof createAgentSourceOwners>>;

export interface WorkstationChange {
  readonly relativePath: string;
  readonly kind: "added" | "changed" | "removed";
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly canRestore: boolean;
}

export interface WorkstationChangesListResult {
  readonly changes: readonly WorkstationChange[];
  readonly folderKnown: boolean;
  readonly beforeKnown: boolean;
}

export interface WorkstationChangeContentsResult {
  readonly before: string | null;
  readonly after: string | null;
}

export interface WorkstationChangeRestoreResult {
  readonly restored: boolean;
  readonly restoreOperationId?: string;
  readonly preimageOperationId?: string;
  readonly uncertain?: boolean;
}

export const WorkstationChangesListInputSchema = z.object({
  caseId: z.string().min(1),
  operationId: z.string().min(1)
});

export type WorkstationChangesListInput = z.infer<typeof WorkstationChangesListInputSchema>;

export const WorkstationChangeContentsInputSchema = z.object({
  caseId: z.string().min(1),
  operationId: z.string().min(1),
  relativePath: z.string().min(1)
});

export type WorkstationChangeContentsInput = z.infer<typeof WorkstationChangeContentsInputSchema>;

export const WorkstationChangeRestoreInputSchema = z.object({
  caseId: z.string().min(1),
  operationId: z.string().min(1),
  relativePath: z.string().min(1)
});

export type WorkstationChangeRestoreInput = z.infer<typeof WorkstationChangeRestoreInputSchema>;

export interface InstallFileHistoryOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** The folder a piece of work runs in, or null when it has none. */
  readonly folderFor: (caseId: string) => Promise<string | null>;
  /** Every file in the folder now, with a hash. */
  readonly snapshot: (
    folder: string,
    signal: AbortSignal
  ) => Promise<
    readonly {
      readonly relativePath: string;
      readonly hash: string;
      readonly bytes: number;
      readonly modifiedAt: number;
    }[]
  >;
  /** The snapshot taken before a session ran, or null when none was taken. */
  readonly before: (
    caseId: string,
    operationId: string
  ) => Promise<readonly { readonly relativePath: string; readonly hash: string }[] | null>;
  /** The saved contents of one file as it was before, or null. */
  readonly contentBefore: (
    caseId: string,
    operationId: string,
    relativePath: string
  ) => Promise<string | null>;
  readonly restore: (folder: string, relativePath: string, contents: string) => Promise<void>;
  /** Shared host restore admission lease wrapping the entire mutation critical section. */
  readonly withAdmissionLease: <T>(
    caseId: string,
    folder: string,
    owner: AgentSourceOwner,
    action: () => Promise<T>
  ) => Promise<T>;
  /** Durable preimage save for the exact folder before restore. */
  readonly savePreimage: (
    caseId: string,
    restoreOperationId: string,
    folder: string
  ) => Promise<boolean>;
}

// An unrecognised or traversing path must not reach the disk or reveal host file structure.
function isSafeRelativePath(folder: string, relativePath: string): boolean {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return false;
  }
  if (relativePath.includes("\0")) {
    return false;
  }
  if (isAbsolute(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    return false;
  }
  const resolvedFolder = resolve(folder);
  const resolvedTarget = resolve(resolvedFolder, relativePath);
  const rel = relative(resolvedFolder, resolvedTarget);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return false;
  }
  return true;
}

export function installFileHistory(options: InstallFileHistoryOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  // Two writers in one folder risk file corruption; track active directories across operations.
  const activeFolders = new Set<string>();

  ipcMain.handle(
    IPC_CHANNELS.workstationChangesList,
    async (event, input: unknown): Promise<WorkstationChangesListResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationChangesListInputSchema.parse(input);

      const folder = await options.folderFor(request.caseId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while listing file changes.");
      }

      if (folder === null) {
        return {
          changes: [],
          folderKnown: false,
          beforeKnown: false
        };
      }

      const beforeFiles = await options.before(request.caseId, request.operationId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while listing file changes.");
      }

      // Historical sessions run before snapshots were captured have an unknown baseline, not an empty change set.
      if (beforeFiles === null) {
        return {
          changes: [],
          folderKnown: true,
          beforeKnown: false
        };
      }

      const controller = new AbortController();
      const currentFiles = await options.snapshot(folder, controller.signal);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while listing file changes.");
      }

      const beforeMap = new Map<string, string>();
      for (const file of beforeFiles) {
        beforeMap.set(file.relativePath, file.hash);
      }

      const currentMap = new Map<
        string,
        {
          readonly relativePath: string;
          readonly hash: string;
          readonly bytes: number;
          readonly modifiedAt: number;
        }
      >();
      for (const file of currentFiles) {
        currentMap.set(file.relativePath, file);
      }

      const candidateAdded: {
        readonly relativePath: string;
        readonly bytes: number;
        readonly modifiedAt: number;
      }[] = [];
      const candidateChanged: {
        readonly relativePath: string;
        readonly bytes: number;
        readonly modifiedAt: number;
      }[] = [];
      const candidateRemoved: { readonly relativePath: string }[] = [];

      for (const file of currentFiles) {
        const previousHash = beforeMap.get(file.relativePath);
        if (previousHash === undefined) {
          candidateAdded.push(file);
        } else if (previousHash !== file.hash) {
          candidateChanged.push(file);
        }
      }

      for (const file of beforeFiles) {
        if (!currentMap.has(file.relativePath)) {
          candidateRemoved.push(file);
        }
      }

      // Added files had no prior presence in the folder, so there are no saved contents to restore.
      const addedChanges: WorkstationChange[] = candidateAdded.map((file) => ({
        relativePath: file.relativePath,
        kind: "added" as const,
        bytes: file.bytes,
        modifiedAt: file.modifiedAt,
        canRestore: false
      }));

      const changedPromises = candidateChanged.map(async (file): Promise<WorkstationChange> => {
        const saved = await options.contentBefore(
          request.caseId,
          request.operationId,
          file.relativePath
        );
        return {
          relativePath: file.relativePath,
          kind: "changed" as const,
          bytes: file.bytes,
          modifiedAt: file.modifiedAt,
          canRestore: saved !== null
        };
      });

      // Files removed during a session can only be restored when their prior contents were saved.
      const removedPromises = candidateRemoved.map(async (file): Promise<WorkstationChange> => {
        const saved = await options.contentBefore(
          request.caseId,
          request.operationId,
          file.relativePath
        );
        return {
          relativePath: file.relativePath,
          kind: "removed" as const,
          bytes: saved !== null ? Buffer.byteLength(saved, "utf8") : 0,
          modifiedAt: 0,
          canRestore: saved !== null
        };
      });

      const [changedResults, removedResults] = await Promise.all([
        Promise.all(changedPromises),
        Promise.all(removedPromises)
      ]);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while listing file changes.");
      }

      const allChanges = [...addedChanges, ...changedResults, ...removedResults];
      allChanges.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

      return {
        changes: allChanges,
        folderKnown: true,
        beforeKnown: true
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationChangeContents,
    async (event, input: unknown): Promise<WorkstationChangeContentsResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationChangeContentsInputSchema.parse(input);

      const folder = await options.folderFor(request.caseId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while reading file contents.");
      }

      if (folder === null || !isSafeRelativePath(folder, request.relativePath)) {
        return { before: null, after: null };
      }

      const before = await options.contentBefore(
        request.caseId,
        request.operationId,
        request.relativePath
      );
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while reading file contents.");
      }

      // Content reading fails gracefully when a file was removed or moved on disk.
      let after: string | null = null;
      try {
        const targetPath = resolve(folder, request.relativePath);
        after = await readFile(targetPath, "utf8");
      } catch {
        after = null;
      }

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while reading file contents.");
      }

      return { before, after };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationChangeRestore,
    async (event, input: unknown): Promise<WorkstationChangeRestoreResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationChangeRestoreInputSchema.parse(input);

      const folder = await options.folderFor(request.caseId);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while restoring the file.");
      }

      if (folder === null || !isSafeRelativePath(folder, request.relativePath)) {
        return { restored: false };
      }

      if (activeFolders.has(folder)) {
        return { restored: false };
      }

      if (
        typeof options.withAdmissionLease !== "function" ||
        typeof options.savePreimage !== "function"
      ) {
        return { restored: false };
      }

      activeFolders.add(folder);
      let mutationResult: WorkstationChangeRestoreResult | null = null;
      try {
        let executionCount = 0;

        const leaseResult = await options.withAdmissionLease(
          request.caseId,
          folder,
          owner,
          async (): Promise<WorkstationChangeRestoreResult> => {
            executionCount++;
            if (executionCount > 1 || mutationResult !== null) {
              return mutationResult ?? { restored: false };
            }

            options.assertTrusted(event);
            if (ownerFor(event) !== owner) {
              return { restored: false };
            }
            const currentFolder1 = await options.folderFor(request.caseId);
            options.assertTrusted(event);
            if (ownerFor(event) !== owner || currentFolder1 !== folder) {
              return { restored: false };
            }

            const contents = await options.contentBefore(
              request.caseId,
              request.operationId,
              request.relativePath
            );
            options.assertTrusted(event);
            if (ownerFor(event) !== owner) {
              return { restored: false };
            }
            const currentFolder2 = await options.folderFor(request.caseId);
            options.assertTrusted(event);
            if (ownerFor(event) !== owner || currentFolder2 !== folder) {
              return { restored: false };
            }

            if (contents === null) {
              return { restored: false };
            }

            let restoreOperationId = randomUUID();
            while (restoreOperationId === request.operationId) {
              restoreOperationId = randomUUID();
            }

            let preimagePersisted = false;
            try {
              preimagePersisted = await options.savePreimage(
                request.caseId,
                restoreOperationId,
                folder
              );
            } catch {
              preimagePersisted = false;
            }

            if (!preimagePersisted) {
              return { restored: false };
            }

            const failureReceipt: WorkstationChangeRestoreResult = {
              restored: false,
              restoreOperationId,
              preimageOperationId: restoreOperationId
            };

            options.assertTrusted(event);
            if (ownerFor(event) !== owner) {
              return failureReceipt;
            }
            const currentFolder3 = await options.folderFor(request.caseId);
            options.assertTrusted(event);
            if (ownerFor(event) !== owner || currentFolder3 !== folder) {
              return failureReceipt;
            }

            try {
              await options.restore(folder, request.relativePath, contents);
            } catch {
              mutationResult = {
                restored: false,
                uncertain: true,
                restoreOperationId,
                preimageOperationId: restoreOperationId
              };
              return mutationResult;
            }

            mutationResult = {
              restored: true,
              restoreOperationId,
              preimageOperationId: restoreOperationId
            };
            return mutationResult;
          }
        );

        if (mutationResult !== null) {
          return mutationResult;
        }

        if (executionCount !== 1) {
          return { restored: false };
        }

        if (
          leaseResult &&
          typeof leaseResult === "object" &&
          typeof leaseResult.restored === "boolean"
        ) {
          return leaseResult;
        }

        return { restored: false };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("This window changed")) {
          throw error;
        }
        if (mutationResult !== null) {
          return mutationResult;
        }
        return { restored: false };
      } finally {
        activeFolders.delete(folder);
      }
    }
  );
}
