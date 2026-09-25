import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  GovernedProjectMemoryCommandSchema,
  type GovernedProjectMemoryView
} from "@cadrane/contracts";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { learnFrom, STALE_AGE_MS, type Learned } from "./project-memory.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  proposeProjectMemory as bookProposeProjectMemory,
  reviewProjectMemory as bookReviewProjectMemory,
  forgetProjectMemory as bookForgetProjectMemory,
  listProjectMemory as bookListProjectMemory,
  projectMemoryEpoch as bookProjectMemoryEpoch
} from "./project-memory-book.js";

export const MAX_PROJECT_FACTS = 2_000;
export const MAX_PROJECT_MEMORY_BYTES = 512 * 1024;
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export interface ProjectMemoryFact {
  readonly id: string;
  readonly text: string;
  readonly confirmations: number;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * What sort of thing this is, and which piece of work it came from.
   *
   * Both were being thrown away. The screen groups facts under "About the
   * business" and "Decisions you made" and says "Learned from the Acme
   * proposal" beneath each one, and with neither field stored it could only
   * ever have shown one unlabelled pile with no provenance. Records written
   * before these existed read as an unclassified fact from an unnamed source,
   * which is true of them.
   */
  readonly kind: LearnedKind;
  readonly learnedFrom: string;
}

export type LearnedKind = Learned["kind"];

/**
 * The deciding lives in project-memory.ts: what sort of fact this is, whether
 * it is the same fact said again, and when one has gone stale. This module
 * keeps them on disk and answers the screen. Matching facts by lowercased text
 * — which is what stood here — treated "use Stripe" and "use Adyen" as
 * different and "We use Stripe." and "we use stripe" as the same, and could
 * never have noticed either.
 */
function toLearned(fact: ProjectMemoryFact): Learned {
  return {
    id: fact.id,
    fact: fact.text,
    learnedFrom: fact.learnedFrom,
    firstSeenAt: Date.parse(fact.createdAt) || 0,
    lastConfirmedAt: Date.parse(fact.updatedAt) || 0,
    timesSeen: fact.confirmations,
    kind: fact.kind,
    pinned: fact.pinned,
    hidden: fact.hidden
  };
}

function fromLearned(learned: Learned): ProjectMemoryFact {
  return {
    id: learned.id,
    text: learned.fact,
    confirmations: learned.timesSeen,
    pinned: learned.pinned,
    hidden: learned.hidden,
    createdAt: new Date(learned.firstSeenAt).toISOString(),
    updatedAt: new Date(learned.lastConfirmedAt).toISOString(),
    kind: learned.kind,
    learnedFrom: learned.learnedFrom
  };
}

export interface ProjectMemoryResult {
  readonly facts: readonly ProjectMemoryFact[];
  readonly skippedCount?: number;
  readonly droppedCount?: number;
}

export interface InstallMemoryOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly folder: () => string;
  readonly book?: () => DatabaseSync;
  readonly principalFor?: (event: IpcMainInvokeEvent) => string;
  readonly beforeMutation?: (projectId: string) => void;
}

export const ProjectIdSchema = z
  .string()
  .min(1, "Project identifier cannot be empty.")
  .max(64, "Project identifier cannot exceed 64 characters.")
  .regex(PROJECT_ID_PATTERN, "Project identifier may only contain letters, numbers, and hyphens.")
  .refine((val) => val !== "." && val !== "..", "Project identifier cannot be a reserved directory name.");

export const MemoryFindingItemSchema = z.union([
  z.string().min(1).max(10_000),
  z.object({
    id: z.string().min(1).optional(),
    text: z.string().min(1).max(10_000).optional(),
    finding: z.string().min(1).max(10_000).optional(),
    content: z.string().min(1).max(10_000).optional(),
    /** The piece of work this came from, by title. Shown under every fact. */
    fromTitle: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    hidden: z.boolean().optional(),
  }),
]);

export type MemoryFindingInput = z.infer<typeof MemoryFindingItemSchema>;

export const WorkstationMemoryReadInputSchema = z.preprocess(
  (val) => (typeof val === "string" ? { projectId: val } : val),
  z.object({
    projectId: ProjectIdSchema,
  })
);

export const WorkstationMemoryLearnInputSchema = z.object({
  projectId: ProjectIdSchema,
  findings: z.union([
    z.array(MemoryFindingItemSchema),
    MemoryFindingItemSchema,
  ]),
});

export const WorkstationMemorySetInputSchema = z.object({
  projectId: ProjectIdSchema,
  id: z.string().min(1),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

export const WorkstationMemoryForgetInputSchema = z.object({
  projectId: ProjectIdSchema,
  id: z.string().min(1),
});

export function resolveProjectPath(folder: string, projectId: string): string {
  // Reject traversal characters before any path calculation to prevent probing filesystem layout.
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    projectId.length > 64 ||
    projectId === "." ||
    projectId === ".." ||
    !PROJECT_ID_PATTERN.test(projectId)
  ) {
    throw new Error("Project identifier may only contain letters, numbers, and hyphens.");
  }

  const resolvedFolder = path.resolve(folder);
  const targetPath = path.resolve(resolvedFolder, `${projectId}.json`);
  const relative = path.relative(resolvedFolder, targetPath);

  // Invariant: the resolved file must stay strictly within the designated memory directory.
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(targetPath) !== resolvedFolder
  ) {
    throw new Error("Project identifier resolves outside the memory directory.");
  }

  return targetPath;
}

function validateStoredFact(item: unknown): ProjectMemoryFact | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const obj = item as Record<string, unknown>;
  const idVal = obj["id"];
  const textVal = obj["text"];

  if (typeof idVal !== "string" || idVal.trim().length === 0) {
    return null;
  }
  if (typeof textVal !== "string" || textVal.trim().length === 0) {
    return null;
  }

  const confirmationsVal = obj["confirmations"];
  const confirmedCountVal = obj["confirmedCount"];
  let confirmations = 1;
  if (typeof confirmationsVal === "number" && confirmationsVal >= 1) {
    confirmations = Math.floor(confirmationsVal);
  } else if (typeof confirmedCountVal === "number" && confirmedCountVal >= 1) {
    confirmations = Math.floor(confirmedCountVal);
  }

  const pinnedVal = obj["pinned"];
  const hiddenVal = obj["hidden"];
  const pinned = typeof pinnedVal === "boolean" ? pinnedVal : false;
  const hidden = typeof hiddenVal === "boolean" ? hiddenVal : false;

  const createdAtVal = obj["createdAt"];
  const updatedAtVal = obj["updatedAt"];
  const createdAt = typeof createdAtVal === "string" && createdAtVal.length > 0
    ? createdAtVal
    : new Date().toISOString();
  const updatedAt = typeof updatedAtVal === "string" && updatedAtVal.length > 0
    ? updatedAtVal
    : createdAt;

  const kindVal = obj["kind"];
  const learnedFromVal = obj["learnedFrom"];

  return {
    id: idVal.trim(),
    text: textVal.trim(),
    confirmations,
    pinned,
    hidden,
    createdAt,
    updatedAt,
    kind: isLearnedKind(kindVal) ? kindVal : "about-the-business",
    learnedFrom:
      typeof learnedFromVal === "string" && learnedFromVal.trim().length > 0
        ? learnedFromVal.trim()
        : "an earlier piece of work",
  };
}

function isLearnedKind(value: unknown): value is LearnedKind {
  return (
    value === "about-the-business" ||
    value === "about-a-person" ||
    value === "a-decision" ||
    value === "a-preference" ||
    value === "a-constraint"
  );
}

export function parseMemoryContent(raw: string): {
  readonly facts: readonly ProjectMemoryFact[];
  readonly skippedCount: number;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { facts: [], skippedCount: 0 };
  }

  // Handle standard JSON arrays or wrapped objects when present.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      let candidates: unknown[] = [];
      if (Array.isArray(parsed)) {
        candidates = parsed;
      } else if (
        typeof parsed === "object" &&
        parsed !== null &&
        "facts" in parsed &&
        Array.isArray((parsed as { readonly facts: unknown }).facts)
      ) {
        candidates = (parsed as { readonly facts: unknown[] }).facts;
      }

      if (candidates.length > 0) {
        const validFacts: ProjectMemoryFact[] = [];
        let skipped = 0;
        for (const candidate of candidates) {
          const validated = validateStoredFact(candidate);
          if (validated) {
            validFacts.push(validated);
          } else {
            skipped += 1;
          }
        }
        return { facts: validFacts, skippedCount: skipped };
      }
    } catch {
      // Fall through to line-by-line parsing so one damaged entry does not discard others.
    }
  }

  // Handle line-delimited records and isolate broken lines without throwing.
  const lines = raw.split(/\r?\n/);
  const validFacts: ProjectMemoryFact[] = [];
  let skipped = 0;

  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (
      lineTrimmed.length === 0 ||
      lineTrimmed === "[" ||
      lineTrimmed === "]" ||
      lineTrimmed === "],"
    ) {
      continue;
    }

    const sanitizedLine = lineTrimmed.endsWith(",")
      ? lineTrimmed.slice(0, -1)
      : lineTrimmed;

    try {
      const parsed: unknown = JSON.parse(sanitizedLine);
      const validated = validateStoredFact(parsed);
      if (validated) {
        validFacts.push(validated);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { facts: validFacts, skippedCount: skipped };
}

export function serializeFacts(facts: readonly ProjectMemoryFact[]): string {
  // Stored as newline-delimited JSON so single-entry corruption never affects neighboring facts.
  if (facts.length === 0) {
    return "";
  }
  return facts.map((fact) => JSON.stringify(fact)).join("\n") + "\n";
}

export function enforceMemoryLimits(facts: readonly ProjectMemoryFact[]): {
  readonly facts: readonly ProjectMemoryFact[];
  readonly droppedCount: number;
} {
  const currentFacts = [...facts];
  let droppedCount = 0;

  const exceedsLimits = (): boolean => {
    if (currentFacts.length > MAX_PROJECT_FACTS) {
      return true;
    }
    const byteLength = Buffer.byteLength(serializeFacts(currentFacts), "utf8");
    return byteLength > MAX_PROJECT_MEMORY_BYTES;
  };

  while (exceedsLimits()) {
    let victimIndex = -1;
    let lowestConfirmations = Number.POSITIVE_INFINITY;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (let i = 0; i < currentFacts.length; i += 1) {
      const candidate = currentFacts[i];
      if (!candidate) {
        continue;
      }
      // Pinned facts represent Amber's explicit anchors and must never be pruned.
      if (candidate.pinned) {
        continue;
      }

      const createdTime = Date.parse(candidate.createdAt) || 0;
      if (
        candidate.confirmations < lowestConfirmations ||
        (candidate.confirmations === lowestConfirmations && createdTime < oldestTimestamp)
      ) {
        victimIndex = i;
        lowestConfirmations = candidate.confirmations;
        oldestTimestamp = createdTime;
      }
    }

    // When all remaining facts are pinned, we cannot discard anything further.
    if (victimIndex === -1) {
      break;
    }

    currentFacts.splice(victimIndex, 1);
    droppedCount += 1;
  }

  return { facts: currentFacts, droppedCount };
}

export async function readProjectMemory(
  folder: string,
  projectId: string
): Promise<ProjectMemoryResult> {
  const targetPath = resolveProjectPath(folder, projectId);

  let raw: string;
  try {
    raw = await fs.promises.readFile(targetPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { facts: [] };
    }
    throw new Error("Project memory could not be read.");
  }

  const parsed = parseMemoryContent(raw);
  const limited = enforceMemoryLimits(parsed.facts);

  return {
    facts: limited.facts,
    ...(parsed.skippedCount > 0 ? { skippedCount: parsed.skippedCount } : {}),
    ...(limited.droppedCount > 0 ? { droppedCount: limited.droppedCount } : {}),
  };
}

export async function writeProjectMemory(
  folder: string,
  projectId: string,
  facts: readonly ProjectMemoryFact[]
): Promise<void> {
  const targetPath = resolveProjectPath(folder, projectId);
  const resolvedFolder = path.dirname(targetPath);

  await fs.promises.mkdir(resolvedFolder, { recursive: true });

  const tempPath = path.resolve(resolvedFolder, `${projectId}.${randomUUID()}.tmp`);
  const serialized = serializeFacts(facts);

  try {
    await fs.promises.writeFile(tempPath, serialized, "utf8");
    await fs.promises.rename(tempPath, targetPath);
  } catch {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw new Error("Project memory could not be saved.");
  }
}

export async function learnProjectMemory(
  folder: string,
  projectId: string,
  findings: readonly MemoryFindingInput[] | MemoryFindingInput
): Promise<ProjectMemoryResult> {
  const readResult = await readProjectMemory(folder, projectId);

  const items = Array.isArray(findings) ? findings : [findings];
  const newFindings: { readonly finding: string; readonly fromTitle: string }[] = [];
  /**
   * Pin and hide can arrive alongside a finding, and they are the owner's word
   * about a fact rather than a fact, so they are applied after the engine has
   * decided which fact they belong to.
   */
  const marks = new Map<string, { pinned?: boolean; hidden?: boolean }>();

  for (const item of items) {
    let text = "";
    let fromTitle = "this piece of work";
    let mark: { pinned?: boolean; hidden?: boolean } | null = null;

    if (typeof item === "string") {
      text = item.trim();
    } else if (typeof item === "object" && item !== null) {
      text = (item.text ?? item.finding ?? item.content ?? "").trim();
      if (typeof item.fromTitle === "string" && item.fromTitle.trim().length > 0) {
        fromTitle = item.fromTitle.trim();
      }
      if (item.pinned !== undefined || item.hidden !== undefined) {
        mark = {};
        if (item.pinned !== undefined) mark.pinned = item.pinned;
        if (item.hidden !== undefined) mark.hidden = item.hidden;
      }
    }

    if (text.length === 0) {
      continue;
    }
    newFindings.push({ finding: text, fromTitle });
    if (mark !== null) {
      marks.set(text.toLowerCase(), mark);
    }
  }

  const learned = learnFrom({
    existing: readResult.facts.map(toLearned),
    newFindings,
    now: Date.now()
  });

  const factsMap = new Map<string, ProjectMemoryFact>();
  for (const fact of [...learned.facts, ...learned.stale]) {
    const stored = fromLearned(fact);
    const mark = marks.get(fact.fact.toLowerCase());
    factsMap.set(
      stored.id,
      mark === undefined
        ? stored
        : {
            ...stored,
            pinned: mark.pinned !== undefined ? mark.pinned : stored.pinned,
            hidden: mark.hidden !== undefined ? mark.hidden : stored.hidden
          }
    );
  }

  const allFacts = Array.from(factsMap.values());
  const limited = enforceMemoryLimits(allFacts);
  await writeProjectMemory(folder, projectId, limited.facts);

  return {
    facts: limited.facts,
    ...(readResult.skippedCount !== undefined && readResult.skippedCount > 0
      ? { skippedCount: readResult.skippedCount }
      : {}),
    ...(limited.droppedCount > 0 ? { droppedCount: limited.droppedCount } : {}),
  };
}

export async function setProjectMemory(
  folder: string,
  projectId: string,
  id: string,
  updates: { readonly pinned?: boolean; readonly hidden?: boolean }
): Promise<ProjectMemoryResult> {
  const readResult = await readProjectMemory(folder, projectId);
  let changed = false;

  const updatedFacts = readResult.facts.map((fact) => {
    if (fact.id !== id) {
      return fact;
    }
    changed = true;
    return {
      ...fact,
      pinned: updates.pinned !== undefined ? updates.pinned : fact.pinned,
      hidden: updates.hidden !== undefined ? updates.hidden : fact.hidden,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await writeProjectMemory(folder, projectId, updatedFacts);
  }

  return {
    facts: updatedFacts,
    ...(readResult.skippedCount !== undefined && readResult.skippedCount > 0
      ? { skippedCount: readResult.skippedCount }
      : {}),
    ...(readResult.droppedCount !== undefined && readResult.droppedCount > 0
      ? { droppedCount: readResult.droppedCount }
      : {}),
  };
}

export async function forgetProjectMemory(
  folder: string,
  projectId: string,
  id: string
): Promise<ProjectMemoryResult> {
  const readResult = await readProjectMemory(folder, projectId);
  const remaining = readResult.facts.filter((fact) => fact.id !== id);

  if (remaining.length !== readResult.facts.length) {
    await writeProjectMemory(folder, projectId, remaining);
  }

  return {
    facts: remaining,
    ...(readResult.skippedCount !== undefined && readResult.skippedCount > 0
      ? { skippedCount: readResult.skippedCount }
      : {}),
    ...(readResult.droppedCount !== undefined && readResult.droppedCount > 0
      ? { droppedCount: readResult.droppedCount }
      : {}),
  };
}

export function installProjectMemory(options: InstallMemoryOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  ipcMain.handle(
    IPC_CHANNELS.workstationMemoryRead,
    async (event, input: unknown): Promise<ProjectMemoryResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationMemoryReadInputSchema.parse(input);
      const result = await readProjectMemory(options.folder(), request.projectId);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }

      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationMemoryLearn,
    async (event, input: unknown): Promise<ProjectMemoryResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationMemoryLearnInputSchema.parse(input);
      const result = await learnProjectMemory(
        options.folder(),
        request.projectId,
        request.findings
      );

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }

      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationMemorySet,
    async (event, input: unknown): Promise<ProjectMemoryResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationMemorySetInputSchema.parse(input);
      const updates: { readonly pinned?: boolean; readonly hidden?: boolean } = {
        ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
        ...(request.hidden !== undefined ? { hidden: request.hidden } : {}),
      };

      const result = await setProjectMemory(
        options.folder(),
        request.projectId,
        request.id,
        updates
      );

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }

      return result;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationMemoryForget,
    async (event, input: unknown): Promise<ProjectMemoryResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      const request = WorkstationMemoryForgetInputSchema.parse(input);
      const result = await forgetProjectMemory(
        options.folder(),
        request.projectId,
        request.id
      );

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while accessing project memory.");
      }

      return result;
    }
  );

  if (options.book && options.principalFor && options.beforeMutation) {
    const getBook = options.book;
    const principalFor = options.principalFor;
    const beforeMutation = options.beforeMutation;

    ipcMain.handle(
      IPC_CHANNELS.workstationMemoryGoverned,
      async (event, input: unknown): Promise<GovernedProjectMemoryView> => {
        options.assertTrusted(event);
        const owner = ownerFor(event);

        const command = GovernedProjectMemoryCommandSchema.parse(input);
        const principal = principalFor(event);
        if (!principal || typeof principal !== "string" || principal.trim().length === 0) {
          throw new Error("A valid principal identity is required.");
        }

        const db = getBook();

        if (command.action === "read") {
          const items = bookListProjectMemory(db, command.projectId);
          const epoch = bookProjectMemoryEpoch(db, command.projectId);

          options.assertTrusted(event);
          if (ownerFor(event) !== owner) {
            throw new Error("This window changed while accessing project memory.");
          }

          return { projectId: command.projectId, epoch, items };
        }

        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while accessing project memory.");
        }

        beforeMutation(command.projectId);

        if (command.action === "propose") {
          bookProposeProjectMemory(db, {
            projectId: command.projectId,
            ...(command.id !== undefined ? { id: command.id } : {}),
            ...(command.expectedRevision !== undefined ? { expectedRevision: command.expectedRevision } : {}),
            kind: command.kind,
            text: command.text,
            ...(command.sourceRefs !== undefined ? { sourceRefs: command.sourceRefs } : {}),
            ...(command.roleTags !== undefined ? { roleTags: command.roleTags } : {}),
            actorId: principal
          });
        } else if (command.action === "review") {
          bookReviewProjectMemory(db, {
            projectId: command.projectId,
            id: command.id,
            expectedRevision: command.expectedRevision,
            decision: command.decision,
            actorId: principal,
            ...(command.roleTags !== undefined ? { roleTags: command.roleTags } : {}),
            ...(command.reason !== undefined ? { reason: command.reason } : {})
          });
        } else if (command.action === "forget") {
          bookForgetProjectMemory(db, {
            projectId: command.projectId,
            id: command.id,
            expectedRevision: command.expectedRevision,
            actorId: principal,
            ...(command.reason !== undefined ? { reason: command.reason } : {})
          });
        }

        const items = bookListProjectMemory(db, command.projectId);
        const epoch = bookProjectMemoryEpoch(db, command.projectId);

        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while accessing project memory.");
        }

        return { projectId: command.projectId, epoch, items };
      }
    );
  }
}
