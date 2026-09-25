import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";

export const AGENT_ID_REGEX = /^[a-zA-Z0-9-]{1,64}$/;
export const MAX_AGENT_ID_LENGTH = 64;
export const MAX_AGENT_MARKDOWN_BYTES = 64 * 1024;
export const DEFAULT_MAX_PROMPT_LENGTH = 8000;

export type AgentOrigin = "bundled" | "user";

export type RequestedToolScope = "none" | "review-each-call";

export interface StoredAgent {
  readonly id: string;
  readonly origin: AgentOrigin;
  readonly markdown: string;
  readonly updatedAt: number;
  readonly revision: string;
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
  readonly revision: string;
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

export interface LoadStoredAgentContractOptions {
  /** The folder user agents live in. */
  readonly agentsFolder: () => string;
  /** The bundled ones, already read. */
  readonly bundled: () => readonly { readonly id: string; readonly markdown: string }[];
}

export interface StoredAgentContract {
  readonly agentId: string;
  readonly origin: AgentOrigin;
  readonly revision: string;
  readonly contractHash: string;
  readonly fullPrompt: string;
  readonly expectedOutput: string;
  readonly requestedToolScopes: readonly RequestedToolScope[];
}

export interface CompileStoredAgentContractInput {
  readonly agent:
    | StoredAgent
    | {
        readonly id: string;
        readonly origin: AgentOrigin;
        readonly markdown: string;
        readonly revision?: string;
        readonly updatedAt?: number;
      };
  readonly task: string;
  readonly expectedOutput: string;
  readonly requestedToolScopes?: readonly RequestedToolScope[];
  readonly expectedRevision?: string;
  readonly maxPromptLength?: number;
}

export interface LoadStoredAgentContractInput {
  readonly id: string;
  readonly origin: AgentOrigin;
  readonly expectedRevision: string;
  readonly task: string;
  readonly expectedOutput: string;
  readonly requestedToolScopes?: readonly RequestedToolScope[];
  readonly maxPromptLength?: number;
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

export function computeAgentRevision(
  id: string,
  origin: AgentOrigin,
  markdown: string
): string {
  if (!AGENT_ID_REGEX.test(id) || id.length === 0 || id.length > MAX_AGENT_ID_LENGTH) {
    throw new Error("Invalid agent identifier.");
  }
  if (origin !== "bundled" && origin !== "user") {
    throw new Error("Invalid agent origin.");
  }
  validateMarkdown(markdown);

  return createHash("sha256")
    .update(JSON.stringify({ id, origin, markdown }))
    .digest("hex");
}

export const computeStoredAgentRevision = computeAgentRevision;

export function compileStoredAgentContract(input: CompileStoredAgentContractInput): StoredAgentContract {
  const { agent, task, expectedOutput, requestedToolScopes, expectedRevision, maxPromptLength } = input;

  if (!agent || typeof agent !== "object") {
    throw new Error("Agent definition is required.");
  }
  if (!AGENT_ID_REGEX.test(agent.id) || agent.id.length === 0 || agent.id.length > MAX_AGENT_ID_LENGTH) {
    throw new Error("Invalid agent identifier.");
  }
  if (agent.origin !== "bundled" && agent.origin !== "user") {
    throw new Error("Invalid agent origin.");
  }
  if (typeof agent.markdown !== "string" || agent.markdown.trim().length === 0) {
    throw new Error("Agent markdown cannot be blank for compilation.");
  }
  validateMarkdown(agent.markdown);

  const revision = computeAgentRevision(agent.id, agent.origin, agent.markdown);
  if (agent.revision !== undefined && agent.revision !== revision) {
    throw new Error("Agent revision does not match content hash.");
  }
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw new Error(
      `Agent revision mismatch: expected '${expectedRevision}', got '${revision}'.`
    );
  }

  if (task === undefined || task === null || typeof task !== "string" || task.trim().length === 0) {
    throw new Error("Invocation task is required and cannot be blank.");
  }
  if (task.includes("\0")) {
    throw new Error("Invocation task contains invalid characters.");
  }
  try {
    encodeURIComponent(task);
  } catch {
    throw new Error("Invocation task is not valid text.");
  }

  if (
    expectedOutput === undefined ||
    expectedOutput === null ||
    typeof expectedOutput !== "string" ||
    expectedOutput.trim().length === 0
  ) {
    throw new Error("Expected output is required and cannot be blank.");
  }
  if (expectedOutput.includes("\0")) {
    throw new Error("Expected output contains invalid characters.");
  }
  try {
    encodeURIComponent(expectedOutput);
  } catch {
    throw new Error("Expected output is not valid text.");
  }

  const rawScopes = requestedToolScopes ?? ["none"];
  if (rawScopes.length === 0) {
    throw new Error("requestedToolScopes cannot be empty; use ['none'] to request no tools.");
  }

  const seenScopes = new Set<RequestedToolScope>();
  for (const scope of rawScopes) {
    if (scope !== "none" && scope !== "review-each-call") {
      throw new Error(`Invalid requested tool scope '${scope}'.`);
    }
    if (seenScopes.has(scope)) {
      throw new Error(`Duplicate requested tool scope '${scope}' is prohibited.`);
    }
    seenScopes.add(scope);
  }

  if (seenScopes.has("none") && rawScopes.length > 1) {
    throw new Error("'none' tool scope is exclusive and cannot be combined with other scopes.");
  }

  const validatedScopes: readonly RequestedToolScope[] = Object.freeze([...rawScopes]);

  const effectiveMaxPromptLength = maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
  if (
    typeof effectiveMaxPromptLength !== "number" ||
    !Number.isFinite(effectiveMaxPromptLength) ||
    effectiveMaxPromptLength <= 0
  ) {
    throw new Error("maxPromptLength must be a positive number.");
  }

  const fullPrompt = JSON.stringify({
    markdown: agent.markdown,
    task,
    expectedOutput,
    requestedToolScopes: validatedScopes,
  });

  if (fullPrompt.length > effectiveMaxPromptLength) {
    throw new Error(
      `Compiled prompt length (${fullPrompt.length}) exceeds maximum allowed length of ${effectiveMaxPromptLength} characters.`
    );
  }

  const contractHash = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: agent.id,
        origin: agent.origin,
        revision,
        fullPrompt,
        expectedOutput,
        requestedToolScopes: validatedScopes,
      })
    )
    .digest("hex");

  return Object.freeze({
    agentId: agent.id,
    origin: agent.origin,
    revision,
    contractHash,
    fullPrompt,
    expectedOutput,
    requestedToolScopes: validatedScopes,
  });
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

export async function loadStoredAgentContract(
  options: LoadStoredAgentContractOptions,
  input: LoadStoredAgentContractInput
): Promise<StoredAgentContract> {
  if (!input || typeof input !== "object") {
    throw new Error("Input is required.");
  }
  if (!input.id || !AGENT_ID_REGEX.test(input.id) || input.id.length > MAX_AGENT_ID_LENGTH) {
    throw new Error("Invalid agent identifier.");
  }
  if (input.origin !== "bundled" && input.origin !== "user") {
    throw new Error("Invalid agent origin.");
  }
  if (
    !input.expectedRevision ||
    typeof input.expectedRevision !== "string" ||
    input.expectedRevision.trim() === ""
  ) {
    throw new Error("expectedRevision is required.");
  }

  const { task, expectedOutput, requestedToolScopes, maxPromptLength } = input;

  if (task === undefined || typeof task !== "string" || task.trim().length === 0) {
    throw new Error("Invocation task is required and cannot be blank.");
  }
  if (
    expectedOutput === undefined ||
    typeof expectedOutput !== "string" ||
    expectedOutput.trim().length === 0
  ) {
    throw new Error("Expected output is required and cannot be blank.");
  }

  if (input.origin === "bundled") {
    const bundledList = options.bundled();
    const found = bundledList.find((b) => b.id === input.id);
    if (!found) {
      throw new Error(`Bundled agent '${input.id}' not found.`);
    }
    validateMarkdown(found.markdown);
    const actualRevision = computeAgentRevision(found.id, "bundled", found.markdown);
    if (actualRevision !== input.expectedRevision) {
      throw new Error(
        `Agent revision mismatch: expected '${input.expectedRevision}', found '${actualRevision}'.`
      );
    }
    return compileStoredAgentContract({
      agent: {
        id: found.id,
        origin: "bundled",
        markdown: found.markdown,
        updatedAt: 0,
        revision: actualRevision,
      },
      task,
      expectedOutput,
      ...(requestedToolScopes === undefined ? {} : { requestedToolScopes }),
      expectedRevision: input.expectedRevision,
      ...(maxPromptLength === undefined ? {} : { maxPromptLength }),
    });
  }

  const folder = options.agentsFolder();
  const targetPath = resolveAgentPath(folder, input.id);

  let lstats;
  try {
    lstats = await fs.lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Agent '${input.id}' not found.`);
    }
    throw new Error("Unable to access agent file.");
  }

  if (lstats.isSymbolicLink()) {
    throw new Error("Symbolic links are not permitted.");
  }
  if (!lstats.isFile()) {
    throw new Error("Agent path is not a regular file.");
  }
  if (lstats.size > MAX_AGENT_MARKDOWN_BYTES) {
    throw new Error("Agent content exceeds limit.");
  }

  let handle: fs.FileHandle | undefined;
  try {
    const openFlags =
      constants.O_NOFOLLOW !== undefined ? constants.O_RDONLY | constants.O_NOFOLLOW : "r";
    handle = await fs.open(targetPath, openFlags);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Agent path is not a regular file.");
    }
    if (stats.size > MAX_AGENT_MARKDOWN_BYTES) {
      throw new Error("Agent content exceeds limit.");
    }

    const content = await handle.readFile("utf8");
    validateMarkdown(content);

    const actualRevision = computeAgentRevision(input.id, "user", content);
    if (actualRevision !== input.expectedRevision) {
      throw new Error(
        `Agent revision mismatch: expected '${input.expectedRevision}', found '${actualRevision}'.`
      );
    }

    return compileStoredAgentContract({
      agent: {
        id: input.id,
        origin: "user",
        markdown: content,
        updatedAt: Math.floor(stats.mtimeMs),
        revision: actualRevision,
      },
      task,
      expectedOutput,
      ...(requestedToolScopes === undefined ? {} : { requestedToolScopes }),
      expectedRevision: input.expectedRevision,
      ...(maxPromptLength === undefined ? {} : { maxPromptLength }),
    });
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new Error("Symbolic links are not permitted.");
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Agent '${input.id}' not found.`);
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
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
        revision: computeAgentRevision(b.id, "bundled", b.markdown),
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
            revision: computeAgentRevision(id, "user", content),
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
          revision: computeAgentRevision(targetId, "user", parsed.markdown),
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
