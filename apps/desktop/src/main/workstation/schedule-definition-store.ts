/**
 * A saved schedule needs its own durable owner decision before it may place work
 * in the Book queue. This module records that decision and admits at most the
 * current, recently due occurrence; it never starts a provider or a timer.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WorkstationProviderIdSchema } from "@cadrane/contracts";
import { appendTurn, readCase } from "../book/cases.js";
import { projectForWork } from "./projects.js";
import { evaluateRecurrence } from "./recurrence-evaluator.js";
import {
  cancelOccurrence,
  claimOccurrence,
  enqueueOccurrence,
  forEachQueuedOccurrence,
  getOccurrence,
  SafeIdSchema,
  withImmediateTransaction,
  type ClaimOccurrenceResult,
  type ScheduledOccurrenceRecord
} from "./scheduled-occurrence-store.js";

export const SCHEDULE_DEFINITION_SEAT = "schedule-definition";
export const SCHEDULE_DEFINITION_PREFIX = "RellaneScheduleDefinitionV1:";
export const MAX_SCHEDULE_EVENTS = 1000;
export const MAX_SCHEDULE_DEFINITIONS = 1000;
export const MAX_SCHEDULE_HISTORY_ROWS = 10_000;
export const MAX_LATENESS_MS = 10 * 60 * 1000;
export const MAX_GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REVIEWABLE_SCHEDULE_INSTRUCTION = 4_000;

const ProjectIdSchema = z.string().min(1).max(200).nullable();
const ProviderIdSchema = WorkstationProviderIdSchema;
const ModelIdSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
// Existing receipts may contain up to 20k; keep them readable. New definitions
// must fit the exact instruction shown in the native owner-grant dialog.
const StoredInstructionSchema = z.string().trim().min(1).max(20_000);
const ReviewableInstructionSchema = z.string().trim().min(1).max(MAX_REVIEWABLE_SCHEDULE_INSTRUCTION);
const TimestampSchema = z.number().int().finite();

const DefinitionInputSchema = z.strictObject({
  scheduleId: SafeIdSchema,
  caseId: z.string().min(1).max(200),
  projectId: ProjectIdSchema,
  expectedRevision: z.number().int().min(0),
  instruction: ReviewableInstructionSchema,
  expression: z.string().min(1).max(300),
  timezone: z.string().min(1).max(200),
  providerId: ProviderIdSchema,
  modelId: ModelIdSchema,
  maxLatenessMs: z.number().int().min(0).max(MAX_LATENESS_MS),
  at: TimestampSchema.optional()
});
export type SaveScheduleDefinitionInput = z.infer<typeof DefinitionInputSchema>;

const GrantInputSchema = z.strictObject({
  scheduleId: SafeIdSchema,
  expectedRevision: z.number().int().min(1),
  ownerActionId: z.string().uuid(),
  expiresAt: TimestampSchema,
  at: TimestampSchema.optional()
});
export type GrantScheduleInput = z.infer<typeof GrantInputSchema>;

const RevokeInputSchema = z.strictObject({
  scheduleId: SafeIdSchema,
  grantId: z.string().uuid(),
  ownerActionId: z.string().uuid(),
  at: TimestampSchema.optional()
});
export type RevokeScheduleInput = z.infer<typeof RevokeInputSchema>;

const AdmitInputSchema = z.strictObject({
  scheduleId: SafeIdSchema,
  asOf: TimestampSchema
});

const ClaimInputSchema = z.strictObject({
  scheduleId: SafeIdSchema,
  occurrenceId: SafeIdSchema,
  asOf: TimestampSchema
});

const DefinitionEventSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("definition"),
  scheduleId: SafeIdSchema,
  revision: z.number().int().min(1),
  caseId: z.string().min(1).max(200),
  projectId: ProjectIdSchema,
  instruction: StoredInstructionSchema,
  instructionHash: z.string().regex(/^[a-f0-9]{64}$/),
  expression: z.string().min(1).max(300),
  timezone: z.string().min(1).max(200),
  providerId: ProviderIdSchema,
  modelId: ModelIdSchema,
  maxLatenessMs: z.number().int().min(0).max(MAX_LATENESS_MS),
  at: TimestampSchema
});

const GrantEventSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("grant"),
  scheduleId: SafeIdSchema,
  revision: z.number().int().min(1),
  grantId: z.string().uuid(),
  ownerActionId: z.string().uuid(),
  approvedBy: z.literal("local-owner"),
  scope: z.literal("queue-only"),
  instructionHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: TimestampSchema,
  at: TimestampSchema
});

const RevokeEventSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("revoke"),
  scheduleId: SafeIdSchema,
  grantId: z.string().uuid(),
  ownerActionId: z.string().uuid(),
  at: TimestampSchema
});

const ScheduleEventSchema = z.discriminatedUnion("event", [
  DefinitionEventSchema,
  GrantEventSchema,
  RevokeEventSchema
]);
type ScheduleEvent = z.infer<typeof ScheduleEventSchema>;
export type ScheduleDefinition = z.infer<typeof DefinitionEventSchema>;
export type ScheduleGrant = z.infer<typeof GrantEventSchema>;

export interface ScheduleRecord {
  readonly definition: ScheduleDefinition;
  readonly grant: ScheduleGrant | null;
  readonly grantRevoked: boolean;
}

export type ScheduleAdmission =
  | { readonly status: "inactive" | "not-due"; readonly occurrence: null }
  | { readonly status: "queued" | "already-queued" | "already-recorded"; readonly occurrence: ScheduledOccurrenceRecord };

interface ScheduleTurnRow {
  readonly caseId: string;
  readonly body: string;
}

function instructionHash(instruction: string): string {
  return createHash("sha256").update(instruction).digest("hex");
}

function occurrenceId(scheduleId: string, revision: number, dueAt: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([scheduleId, revision, dueAt]))
    .digest("hex");
  return `schedule-${digest}`;
}

function appendScheduleEvent(db: DatabaseSync, caseId: string, event: ScheduleEvent): void {
  appendTurn(db, caseId, {
    seat: SCHEDULE_DEFINITION_SEAT,
    kind: "receipt",
    body: `${SCHEDULE_DEFINITION_PREFIX}${event.scheduleId}:${JSON.stringify(event)}`
  }, event.at);
}

function scheduleEvents(db: DatabaseSync, scheduleId: string): readonly ScheduleEvent[] {
  SafeIdSchema.parse(scheduleId);
  const prefix = `${SCHEDULE_DEFINITION_PREFIX}${scheduleId}:`;
  const rows = db.prepare(
    `SELECT case_id AS caseId, body FROM case_turn
     WHERE seat = ? AND kind = 'receipt' AND substr(body, 1, ?) = ?
     ORDER BY case_id ASC, seq ASC LIMIT ?`
  ).all(SCHEDULE_DEFINITION_SEAT, prefix.length, prefix, MAX_SCHEDULE_EVENTS + 1) as unknown as readonly ScheduleTurnRow[];
  if (rows.length > MAX_SCHEDULE_EVENTS) throw new Error("Schedule history exceeds its scan bound.");

  let caseId: string | null = null;
  return rows.map((row) => {
    if (caseId !== null && caseId !== row.caseId) throw new Error("Schedule receipts cross Cases.");
    caseId = row.caseId;
    if (!row.body.startsWith(prefix)) throw new Error("Corrupt schedule receipt prefix.");
    let payload: unknown;
    try {
      payload = JSON.parse(row.body.slice(prefix.length));
    } catch {
      throw new Error("Corrupt schedule receipt JSON.");
    }
    const parsed = ScheduleEventSchema.safeParse(payload);
    if (!parsed.success || parsed.data.scheduleId !== scheduleId) {
      throw new Error("Corrupt schedule receipt payload.");
    }
    if (parsed.data.event === "definition" && parsed.data.caseId !== row.caseId) {
      throw new Error("Schedule definition Case mismatch.");
    }
    return parsed.data;
  });
}

function recordFromEvents(events: readonly ScheduleEvent[]): ScheduleRecord | null {
  if (events.length === 0) return null;
  let definition: ScheduleDefinition | null = null;
  let grant: ScheduleGrant | null = null;
  let revoked = false;
  const ownerActions = new Set<string>();
  const grantIds = new Set<string>();
  for (const event of events) {
    if (event.event === "definition") {
      if (event.revision !== (definition?.revision ?? 0) + 1) {
        throw new Error("Corrupt schedule revision history.");
      }
      if (definition && (definition.caseId !== event.caseId || definition.projectId !== event.projectId)) {
        throw new Error("Schedule scope cannot move between Cases or projects.");
      }
      if (event.instructionHash !== instructionHash(event.instruction)) {
        throw new Error("Corrupt schedule instruction hash.");
      }
      definition = event;
      grant = null;
      revoked = false;
      continue;
    }
    if (!definition) throw new Error("Schedule approval precedes its definition.");
    if (ownerActions.has(event.ownerActionId)) throw new Error("Duplicate schedule owner action.");
    ownerActions.add(event.ownerActionId);
    if (event.event === "grant") {
      if (grantIds.has(event.grantId)) throw new Error("Duplicate schedule grant ID.");
      grantIds.add(event.grantId);
      if (event.revision !== definition.revision || event.instructionHash !== definition.instructionHash) {
        throw new Error("Schedule approval does not match current revision.");
      }
      grant = event;
      revoked = false;
    } else {
      if (!grant || grant.grantId !== event.grantId || revoked) {
        throw new Error("Schedule revocation does not match an active grant.");
      }
      revoked = true;
    }
  }
  if (!definition) throw new Error("Schedule history lacks a definition.");
  return Object.freeze({ definition, grant, grantRevoked: revoked });
}

export function readScheduleDefinition(db: DatabaseSync, scheduleId: string): ScheduleRecord | null {
  return recordFromEvents(scheduleEvents(db, scheduleId));
}

/** Bounded Case shelf. A malformed saved receipt fails the shelf closed. */
export function listScheduleDefinitions(db: DatabaseSync, caseId: string): readonly ScheduleRecord[] {
  if (typeof caseId !== "string" || caseId.length === 0 || caseId.length > 200) {
    throw new Error("A Case ID is required to list schedules.");
  }
  const rows = db.prepare(
    `SELECT body FROM case_turn WHERE case_id = ? AND seat = ? AND kind = 'receipt'
     AND substr(body, 1, ?) = ? ORDER BY seq ASC LIMIT ?`
  ).all(caseId, SCHEDULE_DEFINITION_SEAT, SCHEDULE_DEFINITION_PREFIX.length,
    SCHEDULE_DEFINITION_PREFIX, MAX_SCHEDULE_HISTORY_ROWS + 1) as unknown as readonly { body: string }[];
  if (rows.length > MAX_SCHEDULE_HISTORY_ROWS) throw new Error("Schedule shelf exceeds its scan bound.");
  const ids = new Set<string>();
  for (const row of rows) {
    const suffix = row.body.slice(SCHEDULE_DEFINITION_PREFIX.length);
    const separator = suffix.indexOf(":");
    const id = separator < 1 ? "" : suffix.slice(0, separator);
    if (!SafeIdSchema.safeParse(id).success) throw new Error("Corrupt schedule shelf receipt.");
    ids.add(id);
  }
  if (ids.size > MAX_SCHEDULE_DEFINITIONS) throw new Error("Schedule definition capacity exceeded.");
  return Object.freeze([...ids].map((id) => {
    const record = readScheduleDefinition(db, id);
    if (!record || record.definition.caseId !== caseId) throw new Error("Schedule shelf scope mismatch.");
    return record;
  }));
}

/**
 * Reads the entire bounded schedule shelf before background admission starts.
 * Every receipt and each schedule's semantic history is checked in one scan;
 * a later corrupt schedule cannot leave earlier schedules partly admitted.
 */
export function scanScheduleDefinitions(
  db: DatabaseSync,
  maxScanRows: number = MAX_SCHEDULE_HISTORY_ROWS
): readonly ScheduleRecord[] {
  if (!Number.isSafeInteger(maxScanRows) || maxScanRows < 1 || maxScanRows > MAX_SCHEDULE_HISTORY_ROWS) {
    throw new Error("Schedule scan bound must be a safe integer within the shelf limit.");
  }
  const rows = db.prepare(
    `SELECT case_id AS caseId, body FROM case_turn
     WHERE seat = ? AND kind = 'receipt'
     ORDER BY case_id ASC, seq ASC LIMIT ?`
  ).all(SCHEDULE_DEFINITION_SEAT, maxScanRows + 1) as unknown as readonly ScheduleTurnRow[];
  if (rows.length > maxScanRows) throw new Error("Schedule receipt scan exceeds its bound.");

  const histories = new Map<string, { caseId: string; events: ScheduleEvent[] }>();
  for (const row of rows) {
    if (!row.body.startsWith(SCHEDULE_DEFINITION_PREFIX)) {
      throw new Error("Corrupt schedule receipt prefix.");
    }
    const suffix = row.body.slice(SCHEDULE_DEFINITION_PREFIX.length);
    const separator = suffix.indexOf(":");
    const id = separator < 1 ? "" : suffix.slice(0, separator);
    if (!SafeIdSchema.safeParse(id).success) throw new Error("Corrupt schedule receipt ID.");
    let payload: unknown;
    try {
      payload = JSON.parse(suffix.slice(separator + 1));
    } catch {
      throw new Error("Corrupt schedule receipt JSON.");
    }
    const parsed = ScheduleEventSchema.safeParse(payload);
    if (!parsed.success || parsed.data.scheduleId !== id) {
      throw new Error("Corrupt schedule receipt payload.");
    }
    if (parsed.data.event === "definition" && parsed.data.caseId !== row.caseId) {
      throw new Error("Schedule definition Case mismatch.");
    }
    const history = histories.get(id);
    if (history && history.caseId !== row.caseId) throw new Error("Schedule receipts cross Cases.");
    if (history) history.events.push(parsed.data);
    else histories.set(id, { caseId: row.caseId, events: [parsed.data] });
  }
  const records = [...histories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, history]) => {
    const record = recordFromEvents(history.events);
    if (!record || record.definition.caseId !== history.caseId) {
      throw new Error("Schedule shelf scope mismatch.");
    }
    return record;
  });
  if (records.length > MAX_SCHEDULE_DEFINITIONS) {
    throw new Error("Schedule definition capacity exceeded.");
  }
  return Object.freeze(records);
}

/** Invalidated queue receipts become terminal before new times are admitted. */
export function pruneInvalidQueuedOccurrences(
  db: DatabaseSync,
  schedules: readonly ScheduleRecord[],
  asOf: number
): number {
  if (!Number.isSafeInteger(asOf) || asOf <= 0) throw new Error("Schedule clock is invalid.");
  const byId = new Map(schedules.map((record) => [record.definition.scheduleId, record]));
  let cancelled = 0;
  forEachQueuedOccurrence(db, (occurrence) => {
    const record = byId.get(occurrence.scheduleId);
    const definition = record?.definition;
    const grant = record?.grant;
    const projectId = projectForWork(db, occurrence.caseId)?.id ?? null;
    let reason: string | null = null;
    if (!definition || definition.revision !== occurrence.definitionRevision ||
        definition.caseId !== occurrence.caseId || definition.projectId !== occurrence.projectId ||
        definition.instructionHash !== occurrence.instructionHash) {
      reason = "Schedule definition or scope changed; queued work will not replay.";
    } else if (projectId !== occurrence.projectId) {
      reason = "The Case project link changed; queued work will not replay.";
    } else if (!grant || record?.grantRevoked || asOf < grant.at || grant.expiresAt <= asOf ||
               occurrence.reviewedGrantRef !== `queue-only-${grant.grantId}` ||
               occurrence.dueAt < grant.at || occurrence.dueAt >= grant.expiresAt) {
      reason = "The exact schedule grant is inactive or replaced; queued work will not replay.";
    }
    if (reason) {
      cancelOccurrence(db, { occurrenceId: occurrence.occurrenceId, cancelledAt: asOf, reason });
      cancelled += 1;
    }
  });
  return cancelled;
}

function assertCurrentScope(db: DatabaseSync, definition: ScheduleDefinition): void {
  const caseRow = readCase(db, definition.caseId);
  if (!caseRow || caseRow.closedAt !== null) throw new Error("Schedule Case is missing or closed.");
  const projectId = projectForWork(db, definition.caseId)?.id ?? null;
  if (definition.projectId !== projectId) throw new Error("Schedule project link changed. Review a new schedule scope.");
}

/** Saving a revision invalidates the preceding grant. The schedule remains off. */
export function saveScheduleDefinition(db: DatabaseSync, input: unknown): ScheduleRecord {
  const valid = DefinitionInputSchema.parse(input);
  return withImmediateTransaction(db, () => {
    const previous = readScheduleDefinition(db, valid.scheduleId);
    if ((previous?.definition.revision ?? 0) !== valid.expectedRevision) {
      throw new Error("Schedule revision changed. Review the latest draft.");
    }
    if (previous && (previous.definition.caseId !== valid.caseId || previous.definition.projectId !== valid.projectId)) {
      throw new Error("Schedule scope cannot be moved to another Case or project.");
    }
    const at = valid.at ?? Date.now();
    const definition: ScheduleDefinition = {
      version: 1,
      event: "definition",
      scheduleId: valid.scheduleId,
      revision: valid.expectedRevision + 1,
      caseId: valid.caseId,
      projectId: valid.projectId,
      instruction: valid.instruction,
      instructionHash: instructionHash(valid.instruction),
      expression: valid.expression,
      timezone: valid.timezone,
      providerId: valid.providerId,
      modelId: valid.modelId,
      maxLatenessMs: valid.maxLatenessMs,
      at
    };
    assertCurrentScope(db, definition);
    evaluateRecurrence({ expression: definition.expression, timezone: definition.timezone, afterMs: at });
    appendScheduleEvent(db, definition.caseId, definition);
    const saved = readScheduleDefinition(db, definition.scheduleId);
    if (!saved) throw new Error("Saved schedule could not be read back.");
    return saved;
  });
}

/** The trusted owner action grants queue admission only, for one exact revision. */
export function grantScheduleAdmission(db: DatabaseSync, input: unknown): ScheduleRecord {
  const valid = GrantInputSchema.parse(input);
  return withImmediateTransaction(db, () => {
    const current = readScheduleDefinition(db, valid.scheduleId);
    if (!current || current.definition.revision !== valid.expectedRevision) {
      throw new Error("Schedule revision changed. Review the latest definition.");
    }
    assertCurrentScope(db, current.definition);
    const at = valid.at ?? Date.now();
    if (valid.expiresAt <= at || valid.expiresAt - at > MAX_GRANT_LIFETIME_MS) {
      throw new Error("Schedule grant must expire within 30 days.");
    }
    const prior = scheduleEvents(db, valid.scheduleId).find(
      (event) => event.event !== "definition" && event.ownerActionId === valid.ownerActionId
    );
    if (prior) throw new Error("Owner action was already used.");
    if (current.grant && !current.grantRevoked) {
      throw new Error("Schedule already has an active grant. Revoke it before reviewing a replacement.");
    }
    const grant: ScheduleGrant = {
      version: 1,
      event: "grant",
      scheduleId: valid.scheduleId,
      revision: current.definition.revision,
      grantId: randomUUID(),
      ownerActionId: valid.ownerActionId,
      approvedBy: "local-owner",
      scope: "queue-only",
      instructionHash: current.definition.instructionHash,
      expiresAt: valid.expiresAt,
      at
    };
    appendScheduleEvent(db, current.definition.caseId, grant);
    const saved = readScheduleDefinition(db, valid.scheduleId);
    if (!saved) throw new Error("Granted schedule could not be read back.");
    return saved;
  });
}

export function revokeScheduleAdmission(db: DatabaseSync, input: unknown): ScheduleRecord {
  const valid = RevokeInputSchema.parse(input);
  return withImmediateTransaction(db, () => {
    const current = readScheduleDefinition(db, valid.scheduleId);
    if (!current?.grant || current.grantRevoked || current.grant.grantId !== valid.grantId) {
      throw new Error("That schedule grant is not active.");
    }
    if (scheduleEvents(db, valid.scheduleId).some(
      (event) => event.event !== "definition" && event.ownerActionId === valid.ownerActionId
    )) throw new Error("Owner action was already used.");
    appendScheduleEvent(db, current.definition.caseId, {
      version: 1,
      event: "revoke",
      scheduleId: valid.scheduleId,
      grantId: valid.grantId,
      ownerActionId: valid.ownerActionId,
      at: valid.at ?? Date.now()
    });
    const saved = readScheduleDefinition(db, valid.scheduleId);
    if (!saved) throw new Error("Revoked schedule could not be read back.");
    return saved;
  });
}

/** Skip stale missed times; at most one recent due time is admitted per call. */
export function admitScheduledOccurrence(db: DatabaseSync, input: unknown): ScheduleAdmission {
  const valid = AdmitInputSchema.parse(input);
  return withImmediateTransaction(db, () => {
    const current = readScheduleDefinition(db, valid.scheduleId);
    if (!current?.grant || current.grantRevoked ||
        valid.asOf < current.grant.at || current.grant.expiresAt <= valid.asOf) {
      return { status: "inactive", occurrence: null };
    }
    // Closure is a durable cancellation of unclaimed Case work. It must not
    // block admission of unrelated open Cases or add a post-verdict turn.
    const caseRow = readCase(db, current.definition.caseId);
    if (!caseRow) throw new Error("Schedule Case is missing.");
    if (caseRow.closedAt !== null) return { status: "inactive", occurrence: null };
    assertCurrentScope(db, current.definition);
    const next = evaluateRecurrence({
      expression: current.definition.expression,
      timezone: current.definition.timezone,
      afterMs: valid.asOf - current.definition.maxLatenessMs - 1,
      count: 1
    }).occurrences[0];
    if (!next || next.utcMs > valid.asOf) return { status: "not-due", occurrence: null };
    if (next.utcMs < current.grant.at || next.utcMs >= current.grant.expiresAt) {
      return { status: "not-due", occurrence: null };
    }
    const id = occurrenceId(current.definition.scheduleId, current.definition.revision, next.utcMs);
    const previous = getOccurrence(db, id);
    if (previous) {
      if (previous.scheduleId !== current.definition.scheduleId ||
          previous.definitionRevision !== current.definition.revision ||
          previous.caseId !== current.definition.caseId ||
          previous.projectId !== current.definition.projectId ||
          previous.dueAt !== next.utcMs ||
          previous.instructionHash !== current.definition.instructionHash) {
        throw new Error("Schedule occurrence identity collided with different work.");
      }
      if (previous.reviewedGrantRef !== `queue-only-${current.grant.grantId}`) {
        // A revoked grant cannot authorize the same due time again. Keep the
        // old receipt and explicitly cancel its queued state if encountered.
        const historical = previous.status === "queued" ? cancelOccurrence(db, {
          occurrenceId: previous.occurrenceId,
          cancelledAt: valid.asOf,
          reason: "The exact schedule grant was replaced; this due time will not replay."
        }).occurrence : previous;
        return { status: "already-recorded", occurrence: historical };
      }
      return { status: previous.status === "queued" ? "already-queued" : "already-recorded", occurrence: previous };
    }
    const enqueued = enqueueOccurrence(db, {
      scheduleId: current.definition.scheduleId,
      definitionRevision: current.definition.revision,
      occurrenceId: id,
      caseId: current.definition.caseId,
      projectId: current.definition.projectId,
      dueAt: next.utcMs,
      reviewedGrantRef: `queue-only-${current.grant.grantId}`,
      instructionHash: current.definition.instructionHash,
      enqueuedAt: valid.asOf
    });
    return {
      status: enqueued.enqueued ? "queued" :
        enqueued.occurrence.status === "queued" ? "already-queued" : "already-recorded",
      occurrence: enqueued.occurrence
    };
  });
}

/**
 * The only schedule-aware claim path. A grant is checked again immediately
 * before reserving work, so revocation and edits cannot activate old queue rows.
 * Claiming is not a model run; the shared host must still prepare a fresh review.
 */
export function inspectScheduledOccurrence(db: DatabaseSync, input: unknown): {
  readonly definition: ScheduleDefinition;
  readonly grant: ScheduleGrant;
  readonly occurrence: ScheduledOccurrenceRecord;
} {
  const valid = ClaimInputSchema.parse(input);
  const current = readScheduleDefinition(db, valid.scheduleId);
  if (!current?.grant || current.grantRevoked ||
      valid.asOf < current.grant.at || current.grant.expiresAt <= valid.asOf) {
    throw new Error("Schedule grant is inactive. Review this work again.");
  }
  assertCurrentScope(db, current.definition);
  const occurrence = getOccurrence(db, valid.occurrenceId);
  if (!occurrence || occurrence.scheduleId !== valid.scheduleId ||
      occurrence.definitionRevision !== current.definition.revision ||
      occurrence.caseId !== current.definition.caseId ||
      occurrence.projectId !== current.definition.projectId ||
      occurrence.instructionHash !== current.definition.instructionHash ||
      occurrence.reviewedGrantRef !== `queue-only-${current.grant.grantId}` ||
      occurrence.dueAt < current.grant.at ||
      occurrence.dueAt >= current.grant.expiresAt ||
      occurrence.occurrenceId !== occurrenceId(valid.scheduleId, current.definition.revision, occurrence.dueAt)) {
    throw new Error("Occurrence no longer matches the active schedule grant.");
  }
  const exactDue = evaluateRecurrence({
    expression: current.definition.expression,
    timezone: current.definition.timezone,
    afterMs: occurrence.dueAt - 1,
    count: 1
  }).instants[0];
  if (exactDue !== occurrence.dueAt) {
    throw new Error("Occurrence due time does not match the current schedule.");
  }
  // maxLatenessMs governs initial queue admission, not the time a human may
  // take to review already admitted work. The exact grant still must be live.
  if (valid.asOf < occurrence.dueAt) {
    throw new Error("Occurrence is not due yet.");
  }
  if (occurrence.status !== "queued") {
    throw new Error("Occurrence is no longer queued.");
  }
  return Object.freeze({ definition: current.definition, grant: current.grant, occurrence });
}

export function claimScheduledOccurrence(db: DatabaseSync, input: unknown): ClaimOccurrenceResult {
  const valid = ClaimInputSchema.parse(input);
  return withImmediateTransaction(db, () => {
    const { definition } = inspectScheduledOccurrence(db, valid);
    return claimOccurrence(db, {
      occurrenceId: valid.occurrenceId,
      asOf: valid.asOf,
      claimedAt: valid.asOf,
      projectId: definition.projectId
    });
  });
}
