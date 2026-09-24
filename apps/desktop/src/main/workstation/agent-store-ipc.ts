import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

export const AGENT_ID_REGEX = /^[a-zA-Z0-9-]{1,64}$/;
export const MAX_AGENT_ID_LENGTH = 64;
export const MAX_AGENT_MARKDOWN_BYTES = 64 * 1024;

export type AgentOrigin = "bundled" | "user";

export interface StoredAgent {
  readonly id: string;
  readonly origin: AgentOrigin;
  readonly markdown: string;
  readonly updatedAt: number;
}

export interface WorkstationAgentsListResult {
  readonly agents: readonly StoredAgent[];
}

export interface WorkstationAgentSaveInput {
  readonly id: string;
  readonly markdown: string;
}

export interface WorkstationAgentSaveResult {
  readonly id: string;
  readonly updatedAt: number;
}

export interface WorkstationAgentDeleteInput {
  readonly id: string;
}

export interface WorkstationAgentDeleteResult {
  readonly deleted: boolean;
}

export interface InstallAgentStoreOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** The folder his own agents live in. Created if missing. */
  readonly agentsFolder: () => string;
  /** The bundled ones, already read for you. */
  readonly bundled: () => readonly { readonly id: string; readonly markdown: string }[];
}

export const WorkstationAgentSaveInputSchema = z.object({
  id: z.string().min(1).max(MAX_AGENT_ID_LENGTH).regex(AGENT_ID_REGEX),
  markdown: z.string(),
});

export const WorkstationAgentDeleteInputSchema = z.object({
  id: z.string().min(1).max(MAX_AGENT_ID_LENGTH).regex(AGENT_ID_REGEX),
});

export const WorkstationAgentsListInputSchema = z.record(z.string(), z.unknown()).optional();

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateMarkdown(markdown: string): void {
  if (Buffer.byteLength(markdown, "utf8") > MAX_AGENT_MARKDOWN_BYTES) {
    throw new Error("Agent content exceeds limit.");
  }
  if (markdown.includes("\0")) {
    throw new Error("Agent content contains invalid characters.");
  }
  try {
    encodeURIComponent(markdown);
  } catch {
    throw new Error("Agent content is not valid text.");
  }
}

function resolveAgentPath(folder: string, id: string): string {
  if (!AGENT_ID_REGEX.test(id) || id.length === 0 || id.length > MAX_AGENT_ID_LENGTH) {
    throw new Error("Invalid agent identifier.");
  }
  const resolvedFolder = path.resolve(folder);
  const targetPath = path.resolve(resolvedFolder, `${id}.md`);
  const relative = path.relative(resolvedFolder, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error("Agent path is outside the agents directory.");
  }
  return targetPath;
}

async function fileExistsInFolder(folder: string, id: string): Promise<boolean> {
  try {
    const targetPath = resolveAgentPath(folder, id);
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findAvailableCopyId(
  folder: string,
  baseId: string,
  bundledIds: ReadonlySet<string>
): Promise<string> {
  const resolvedFolder = path.resolve(folder);
  const initialSuffix = "-copy";
  const maxInitialBaseLen = Math.max(1, MAX_AGENT_ID_LENGTH - initialSuffix.length);
  let candidate = `${baseId.slice(0, maxInitialBaseLen)}${initialSuffix}`;

  let counter = 2;
  while (bundledIds.has(candidate) || (await fileExistsInFolder(resolvedFolder, candidate))) {
    const suffix = `-copy-${counter}`;
    const maxBaseLen = Math.max(1, MAX_AGENT_ID_LENGTH - suffix.length);
    candidate = `${baseId.slice(0, maxBaseLen)}${suffix}`;
    counter++;
  }

  return candidate;
}

export function installAgentStore(options: InstallAgentStoreOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentsList,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentsListResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);
      const verifySender = () => {
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while listing agents.");
        }
      };

      WorkstationAgentsListInputSchema.parse(input === undefined ? {} : input);

      // Bundled agents are static templates; zero timestamp reflects their immutable built-in origin.
      const bundledAgents: StoredAgent[] = options.bundled().map((b) => ({
        id: b.id,
        origin: "bundled",
        markdown: b.markdown,
        updatedAt: 0,
      }));

      const folder = options.agentsFolder();
      const userAgents: StoredAgent[] = [];
      const seenIds = new Set<string>();

      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
        verifySender();
      } catch (error: unknown) {
        verifySender();
        if (isNodeError(error) && error.code === "ENOENT") {
          // A missing folder indicates no custom agents have been written yet; return bundled only.
          return { agents: bundledAgents };
        }
        throw new Error("Unable to list agents.");
      }

      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".")) {
          continue;
        }
        const id = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
        if (!AGENT_ID_REGEX.test(id) || id.length === 0 || id.length > MAX_AGENT_ID_LENGTH) {
          continue;
        }
        if (seenIds.has(id)) {
          continue;
        }

        try {
          const filePath = path.resolve(folder, entry.name);
          const resolvedFolder = path.resolve(folder);
          const relative = path.relative(resolvedFolder, filePath);
          if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
            continue;
          }

          const stats = await fs.stat(filePath);
          verifySender();

          const content = await fs.readFile(filePath, "utf8");
          verifySender();

          if (Buffer.byteLength(content, "utf8") > MAX_AGENT_MARKDOWN_BYTES) {
            continue;
          }

          seenIds.add(id);
          userAgents.push({
            id,
            origin: "user",
            markdown: content,
            updatedAt: Math.floor(stats.mtimeMs),
          });
        } catch {
          verifySender();
          // Unreadable files are skipped individually so transient filesystem errors do not mask valid agents.
          continue;
        }
      }

      return {
        agents: [...bundledAgents, ...userAgents],
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentSave,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentSaveResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);
      const verifySender = () => {
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while saving the agent.");
        }
      };

      let parsed: WorkstationAgentSaveInput;
      try {
        parsed = WorkstationAgentSaveInputSchema.parse(input);
      } catch {
        throw new Error("Invalid agent parameters.");
      }

      validateMarkdown(parsed.markdown);

      const folder = options.agentsFolder();
      const bundledList = options.bundled();
      const bundledIds = new Set(bundledList.map((b) => b.id));

      let targetId = parsed.id;
      if (bundledIds.has(targetId)) {
        // Bundled agents cannot be mutated; allocate a fresh user copy identifier instead.
        targetId = await findAvailableCopyId(folder, targetId, bundledIds);
        verifySender();
      }

      const targetPath = resolveAgentPath(folder, targetId);
      const resolvedFolder = path.resolve(folder);

      try {
        await fs.mkdir(resolvedFolder, { recursive: true });
        verifySender();
      } catch {
        verifySender();
        throw new Error("Unable to create agents directory.");
      }

      // Writing to an adjacent hidden temporary file ensures the eventual rename is atomic.
      const tempFileName = `.${targetId}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
      const tempPath = path.resolve(resolvedFolder, tempFileName);

      let committed = false;
      try {
        await fs.writeFile(tempPath, parsed.markdown, "utf8");
        verifySender();

        await fs.rename(tempPath, targetPath);
        verifySender();
        committed = true;
      } catch {
        verifySender();
        throw new Error("Unable to save agent.");
      } finally {
        if (!committed) {
          try {
            await fs.unlink(tempPath);
          } catch {
            // Temporary file may not have been created; ignore removal errors during cleanup.
          }
        }
      }

      try {
        const stats = await fs.stat(targetPath);
        verifySender();
        return {
          id: targetId,
          updatedAt: Math.floor(stats.mtimeMs),
        };
      } catch {
        verifySender();
        throw new Error("Unable to verify saved agent.");
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationAgentDelete,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationAgentDeleteResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);
      const verifySender = () => {
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while deleting the agent.");
        }
      };

      let parsed: WorkstationAgentDeleteInput;
      try {
        parsed = WorkstationAgentDeleteInputSchema.parse(input);
      } catch {
        throw new Error("Invalid agent parameters.");
      }

      const bundledList = options.bundled();
      const bundledIds = new Set(bundledList.map((b) => b.id));
      if (bundledIds.has(parsed.id)) {
        // Built-in agents are permanent application assets and must not be deleted.
        throw new Error("Bundled agents cannot be deleted.");
      }

      const folder = options.agentsFolder();
      const targetPath = resolveAgentPath(folder, parsed.id);

      try {
        await fs.unlink(targetPath);
        verifySender();
        return { deleted: true };
      } catch (error: unknown) {
        verifySender();
        if (isNodeError(error) && error.code === "ENOENT") {
          // Deleting an absent entry succeeds idempotently with a false indicator.
          return { deleted: false };
        }
        throw new Error("Unable to delete agent.");
      }
    }
  );
}
