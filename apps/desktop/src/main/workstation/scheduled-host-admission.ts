/**
 * A scheduled occurrence must reach the same reviewed host as owner chat.
 * This adapter keeps the host's Start token private while a separate owner
 * action rechecks the queue grant and exact saved context before dispatch.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkstationReview, WorkstationSnapshot } from "@cadrane/contracts";
import { restoreContextSnapshot } from "./context-snapshot-store.js";
import {
  claimScheduledOccurrence,
  inspectScheduledOccurrence,
  revokeScheduleAdmission,
  type RevokeScheduleInput,
  type ScheduleDefinition
} from "./schedule-definition-store.js";
import { settleOccurrence, type ScheduledOccurrenceRecord } from "./scheduled-occurrence-store.js";
import type { WorkstationHost } from "./service.js";

const MAX_PENDING_SCHEDULE_REVIEWS = 32;
const MAX_ERROR_DETAIL = 2000;

export interface ScheduledHostReview extends Omit<WorkstationReview, "token"> {
  /** Adapter token. This is never the host's Start token. */
  readonly token: string;
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly dueAt: number;
  readonly grantExpiresAt: number;
}

interface PendingScheduleReview {
  readonly owner: object;
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly grantId: string;
  readonly revision: number;
  readonly instructionHash: string;
  readonly prompt: string;
  readonly hostReview: WorkstationReview;
}

export interface ScheduledReviewHost {
  readonly prepare: WorkstationHost["prepare"];
  readonly start: WorkstationHost["start"];
  readonly awaitTerminal: WorkstationHost["awaitTerminal"];
  readonly stop: WorkstationHost["stop"];
}

export interface ScheduledHostAdmissionOptions {
  readonly book: () => DatabaseSync;
  readonly host: ScheduledReviewHost;
  readonly now?: () => number;
}

export interface ScheduledStartResult {
  readonly snapshot: WorkstationSnapshot;
  readonly occurrence: ScheduledOccurrenceRecord;
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function schedulePrompt(definition: ScheduleDefinition, dueAt: number): string {
  return `Scheduled work ${definition.scheduleId}, revision ${definition.revision}, due ${new Date(dueAt).toISOString()}.\n\n${definition.instruction}`;
}

function assertReview(
  db: DatabaseSync,
  review: WorkstationReview,
  definition: ScheduleDefinition,
  prompt: string
): void {
  if (review.caseId !== definition.caseId ||
      review.projectId !== definition.projectId ||
      review.providerId !== definition.providerId ||
      review.modelId !== definition.modelId ||
      review.prompt !== prompt ||
      review.resumeSessionId !== null ||
      review.sourceIds.length !== 0 ||
      !review.contextSnapshotId ||
      review.sourceHash !== hash(review.contextPreview)) {
    throw new Error("Host review does not match the scheduled work.");
  }
  const snapshot = restoreContextSnapshot(db, {
    id: review.contextSnapshotId,
    caseId: definition.caseId,
    projectId: definition.projectId,
    providerId: definition.providerId,
    modelId: definition.modelId
  });
  if (snapshot.packet !== review.contextPreview || snapshot.packetHash !== review.sourceHash ||
      snapshot.manifest.sourceIds.length !== 0 || snapshot.dispatchAttemptedAt !== null) {
    throw new Error("Saved context no longer matches the scheduled review.");
  }
}

function outcomeFor(status: WorkstationSnapshot["status"]): "completed" | "stopped" | "failed" | "uncertain" {
  switch (status) {
    case "completed": return "completed";
    case "stopped": return "stopped";
    case "failed": return "failed";
    case "interrupted": return "uncertain";
    default: throw new Error("Host did not reach a terminal outcome.");
  }
}

/** No scheduler loop: these methods are called by trusted owner actions only. */
export function createScheduledHostAdmission(options: ScheduledHostAdmissionOptions) {
  const pending = new Map<string, PendingScheduleReview>();
  const active = new Map<string, { readonly owner: object; readonly scheduleId: string; readonly abort: AbortController }>();
  const revokedOwners = new WeakSet<object>();
  let stopGeneration = 0;
  const now = options.now ?? Date.now;

  async function prepare(input: {
    readonly scheduleId: string;
    readonly occurrenceId: string;
    readonly owner: object;
  }): Promise<ScheduledHostReview> {
    if (revokedOwners.has(input.owner)) throw new Error("That window was closed. Review again.");
    const generation = stopGeneration;
    const before = inspectScheduledOccurrence(options.book(), {
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      asOf: now()
    });
    const prompt = schedulePrompt(before.definition, before.occurrence.dueAt);
    const hostReview = await options.host.prepare({
      caseId: before.definition.caseId,
      providerId: before.definition.providerId,
      modelId: before.definition.modelId,
      prompt,
      sourceTurnIds: []
    }, input.owner, { freshSession: true });
    const after = inspectScheduledOccurrence(options.book(), {
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      asOf: now()
    });
    if (revokedOwners.has(input.owner) || generation !== stopGeneration) {
      throw new Error("Scheduled review was stopped while preparing.");
    }
    if (after.definition.revision !== before.definition.revision ||
        after.grant.grantId !== before.grant.grantId ||
        after.definition.instructionHash !== before.definition.instructionHash) {
      throw new Error("Schedule changed while its host review was prepared.");
    }
    assertReview(options.book(), hostReview, after.definition, prompt);
    if (hostReview.expiresAt <= now() || after.grant.expiresAt <= now()) {
      throw new Error("Scheduled review expired while it was prepared.");
    }
    const token = randomBytes(32).toString("hex");
    pending.set(token, {
      owner: input.owner,
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      grantId: after.grant.grantId,
      revision: after.definition.revision,
      instructionHash: after.definition.instructionHash,
      prompt,
      hostReview
    });
    while (pending.size > MAX_PENDING_SCHEDULE_REVIEWS) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
    const { token: _hostToken, ...shown } = hostReview;
    return Object.freeze({ ...shown, token, scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId, dueAt: after.occurrence.dueAt,
      grantExpiresAt: after.grant.expiresAt });
  }

  /** Separate explicit owner Start; consumes the adapter token before any await. */
  async function start(input: {
    readonly token: string;
    readonly owner: object;
    readonly signal?: AbortSignal;
  }): Promise<ScheduledStartResult> {
    const saved = pending.get(input.token);
    pending.delete(input.token);
    if (!saved) throw new Error("Scheduled review is unavailable. Review again.");
    if (saved.owner !== input.owner) throw new Error("Scheduled review belongs to another window.");
    if (revokedOwners.has(input.owner)) throw new Error("That window was closed. Review again.");
    if (input.signal?.aborted) throw new Error("Stopped before scheduled Start.");
    if (saved.hostReview.expiresAt <= now()) throw new Error("Scheduled review expired. Review again.");
    const before = inspectScheduledOccurrence(options.book(), {
      scheduleId: saved.scheduleId,
      occurrenceId: saved.occurrenceId,
      asOf: now()
    });
    if (before.grant.grantId !== saved.grantId ||
        before.definition.revision !== saved.revision ||
        before.definition.instructionHash !== saved.instructionHash) {
      throw new Error("Schedule or grant changed after review. Review again.");
    }
    assertReview(options.book(), saved.hostReview, before.definition, saved.prompt);
    const claim = claimScheduledOccurrence(options.book(), {
      scheduleId: saved.scheduleId,
      occurrenceId: saved.occurrenceId,
      asOf: now()
    });
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (input.signal?.aborted) abort.abort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    active.set(saved.occurrenceId, { owner: saved.owner, scheduleId: saved.scheduleId, abort });
    let launched: WorkstationSnapshot | null = null;
    try {
      launched = await options.host.start({ token: saved.hostReview.token }, saved.owner, abort.signal);
      if (launched.caseId !== before.definition.caseId ||
          launched.providerId !== before.definition.providerId ||
          launched.modelId !== before.definition.modelId) {
        await options.host.stop(launched.caseId, launched.operationId, saved.owner).catch(() => undefined);
        throw new Error("Started session did not match the scheduled review.");
      }
      const terminal = await options.host.awaitTerminal(
        launched.caseId, launched.operationId, saved.owner, abort.signal
      );
      const settled = settleOccurrence(options.book(), {
        occurrenceId: saved.occurrenceId,
        claimId: claim.claimId,
        outcome: outcomeFor(terminal.status),
        detail: terminal.detail.slice(0, MAX_ERROR_DETAIL),
        settledAt: now()
      });
      return { snapshot: terminal, occurrence: settled.occurrence };
    } catch (error) {
      if (launched && abort.signal.aborted) {
        await options.host.stop(launched.caseId, launched.operationId, saved.owner).catch(() => undefined);
      }
      try {
        settleOccurrence(options.book(), {
          occurrenceId: saved.occurrenceId,
          claimId: claim.claimId,
          outcome: "uncertain",
          detail: "Host Start or terminal confirmation failed; effect may have occurred. Do not replay.",
          settledAt: now()
        });
      } catch {
        // The crash-recovery sweep will mark a still-claimed occurrence uncertain.
      }
      throw error;
    } finally {
      active.delete(saved.occurrenceId);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  function cancelOwner(owner: object): void {
    revokedOwners.add(owner);
    for (const [token, entry] of pending) if (entry.owner === owner) pending.delete(token);
    for (const entry of active.values()) if (entry.owner === owner) entry.abort.abort();
  }

  function stopOccurrence(occurrenceId: string, owner: object): boolean {
    let stopped = false;
    for (const [token, entry] of pending) {
      if (entry.occurrenceId === occurrenceId && entry.owner === owner) {
        pending.delete(token);
        stopped = true;
      }
    }
    const running = active.get(occurrenceId);
    if (running?.owner === owner) {
      running.abort.abort();
      stopped = true;
    }
    return stopped;
  }

  /** Owner revocation also withdraws pending review tokens and stops an active child. */
  function revoke(input: RevokeScheduleInput): void {
    revokeScheduleAdmission(options.book(), input);
    for (const [token, entry] of pending) {
      if (entry.scheduleId === input.scheduleId) pending.delete(token);
    }
    for (const entry of active.values()) {
      if (entry.scheduleId === input.scheduleId) entry.abort.abort();
    }
  }

  function stopActive(): boolean {
    const hadWork = pending.size > 0 || active.size > 0;
    stopGeneration += 1;
    pending.clear();
    for (const entry of active.values()) entry.abort.abort();
    return hadWork;
  }

  return { prepare, start, revoke, stopOccurrence, cancelOwner, stopActive };
}
