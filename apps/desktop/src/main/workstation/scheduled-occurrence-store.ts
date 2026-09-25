/**
 * R16 bounded durable occurrence queue primitive.
 *
 * Persists scheduled occurrences using the existing Book SQLite case_turn
 * receipt table with a dedicated seat and versioned event schema.
 *
 * Does not compute calendar/DST recurrence, does not dispatch providers,
 * and maintains no autonomous timer.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { appendTurn, readCase } from "../book/cases.js";
import { projectForWork } from "./projects.js";

export const SCHEDULED_OCCURRENCE_SEAT = "scheduled-occurrence";
export const SCHEDULED_OCCURRENCE_PREFIX = "RellaneScheduledOccurrenceV1:";
export const MAX_SCAN_ROWS = 1000;
// Historic terminal receipts are streamed, while active work is bounded.
export const MAX_ACTIVE_OCCURRENCES = 10_000;

export const SAFE_ID_REGEX = /^[a-zA-Z0-9-]+$/;

export const SafeIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    SAFE_ID_REGEX,
    "ID must contain only alphanumeric characters and hyphens without wildcards or delimiters."
  );

export const OccurrenceTerminalOutcomeSchema = z.enum([
  "completed",
  "stopped",
  "failed",
  "uncertain"
]);
export type OccurrenceTerminalOutcome = z.infer<typeof OccurrenceTerminalOutcomeSchema>;

export const ScheduledOccurrenceStatusSchema = z.enum([
  "queued",
  "claimed",
  "completed",
  "stopped",
  "failed",
  "uncertain",
  "cancelled"
]);
export type ScheduledOccurrenceStatus = z.infer<typeof ScheduledOccurrenceStatusSchema>;

export const EnqueuedEventPayloadSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("enqueued"),
  occurrenceId: SafeIdSchema,
  scheduleId: SafeIdSchema,
  definitionRevision: z.number().int().min(1),
  caseId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200).nullable(),
  dueAt: z.number().int(),
  reviewedGrantRef: z.string().min(1).max(500),
  instructionHash: z.string().min(1).max(200),
  enqueuedAt: z.number().int()
});
export type EnqueuedEventPayload = z.infer<typeof EnqueuedEventPayloadSchema>;

export const ClaimedEventPayloadSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("claimed"),
  occurrenceId: SafeIdSchema,
  claimId: z.string().uuid(),
  claimedAt: z.number().int()
});
export type ClaimedEventPayload = z.infer<typeof ClaimedEventPayloadSchema>;

export const SettledEventPayloadSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("settled"),
  occurrenceId: SafeIdSchema,
  claimId: z.string().uuid(),
  outcome: OccurrenceTerminalOutcomeSchema,
  settledAt: z.number().int(),
  detail: z.string().max(2000).optional()
});
export type SettledEventPayload = z.infer<typeof SettledEventPayloadSchema>;

export const CancelledEventPayloadSchema = z.strictObject({
  version: z.literal(1),
  event: z.literal("cancelled"),
  occurrenceId: SafeIdSchema,
  cancelledAt: z.number().int(),
  reason: z.string().max(2000).optional()
});
export type CancelledEventPayload = z.infer<typeof CancelledEventPayloadSchema>;

export const OccurrenceEventPayloadSchema = z.discriminatedUnion("event", [
  EnqueuedEventPayloadSchema,
  ClaimedEventPayloadSchema,
  SettledEventPayloadSchema,
  CancelledEventPayloadSchema
]);
export type OccurrenceEventPayload = z.infer<typeof OccurrenceEventPayloadSchema>;

export const EnqueueOccurrenceInputSchema = z.strictObject({
  scheduleId: SafeIdSchema,
  definitionRevision: z.number().int().min(1),
  occurrenceId: SafeIdSchema,
  caseId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200).nullable(),
  dueAt: z.number().int(),
  reviewedGrantRef: z.string().min(1).max(500),
  instructionHash: z.string().min(1).max(200),
  enqueuedAt: z.number().int().optional()
});
export type EnqueueOccurrenceInput = z.infer<typeof EnqueueOccurrenceInputSchema>;

export const ClaimOccurrenceInputSchema = z.strictObject({
  occurrenceId: SafeIdSchema,
  claimId: z.string().uuid().optional(),
  claimedAt: z.number().int().optional(),
  asOf: z.number().int().optional(),
  projectId: z.string().min(1).max(200).nullable().optional()
});
export type ClaimOccurrenceInput = z.infer<typeof ClaimOccurrenceInputSchema>;

export const SettleOccurrenceInputSchema = z.strictObject({
  occurrenceId: SafeIdSchema,
  claimId: z.string().uuid(),
  outcome: OccurrenceTerminalOutcomeSchema,
  settledAt: z.number().int().optional(),
  detail: z.string().max(2000).optional()
});
export type SettleOccurrenceInput = z.infer<typeof SettleOccurrenceInputSchema>;

export const CancelOccurrenceInputSchema = z.strictObject({
  occurrenceId: SafeIdSchema,
  cancelledAt: z.number().int().optional(),
  reason: z.string().max(2000).optional()
});
export type CancelOccurrenceInput = z.infer<typeof CancelOccurrenceInputSchema>;

export const ListDueOccurrencesQuerySchema = z.strictObject({
  asOf: z.number().int(),
  caseId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).nullable().optional(),
  limit: z.number().int().min(1).max(100).optional()
});
export type ListDueOccurrencesQuery = z.infer<typeof ListDueOccurrencesQuerySchema>;

export interface ScheduledOccurrenceRecord {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly dueAt: number;
  readonly reviewedGrantRef: string;
  readonly instructionHash: string;
  readonly enqueuedAt: number;
  readonly status: ScheduledOccurrenceStatus;
  readonly terminal: boolean;
  readonly claimId: string | null;
  readonly claimedAt: number | null;
  readonly settledAt: number | null;
  readonly outcome: OccurrenceTerminalOutcome | null;
  readonly cancelledAt: number | null;
  readonly cancelReason: string | null;
  readonly detail: string | null;
}

export interface EnqueueOccurrenceResult extends ScheduledOccurrenceRecord {
  readonly enqueued: boolean;
  readonly occurrence: ScheduledOccurrenceRecord;
}

export interface ClaimOccurrenceResult extends ScheduledOccurrenceRecord {
  readonly claimId: string;
  readonly claimedAt: number;
  readonly occurrence: ScheduledOccurrenceRecord;
}

export interface SettleOccurrenceResult extends ScheduledOccurrenceRecord {
  readonly outcome: OccurrenceTerminalOutcome;
  readonly settledAt: number;
  readonly occurrence: ScheduledOccurrenceRecord;
}

export interface CancelOccurrenceResult extends ScheduledOccurrenceRecord {
  readonly cancelled: boolean;
  readonly alreadyCancelled: boolean;
  readonly occurrence: ScheduledOccurrenceRecord;
}

interface TurnRow {
  readonly caseId: string;
  readonly body: string;
  readonly at: number;
  readonly seq: number;
}

export function withImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  let startedTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    startedTransaction = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("cannot start a transaction within a transaction")) {
      startedTransaction = false;
    } else {
      throw err;
    }
  }

  if (!startedTransaction) {
    const savepoint = `sp_${randomUUID().replace(/-/g, "")}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error: unknown) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Retain original error
      }
      throw error;
    }
  }

  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Retain original error
    }
    throw error;
  }
}

interface OccurrenceTurnEvent {
  readonly caseId: string;
  readonly payload: OccurrenceEventPayload;
}

function fetchEventsForOccurrence(
  db: DatabaseSync,
  occurrenceId: string
): readonly OccurrenceTurnEvent[] {
  SafeIdSchema.parse(occurrenceId);
  const prefix = `${SCHEDULED_OCCURRENCE_PREFIX}${occurrenceId}:`;

  const rows = db
    .prepare(
      `SELECT case_id AS caseId, body, at, seq
       FROM case_turn
       WHERE seat = ? AND kind = 'receipt' AND substr(body, 1, ?) = ?
       ORDER BY at ASC, seq ASC
       LIMIT ?`
    )
    .all(
      SCHEDULED_OCCURRENCE_SEAT,
      prefix.length,
      prefix,
      MAX_SCAN_ROWS + 1
    ) as unknown as readonly TurnRow[];

  if (rows.length > MAX_SCAN_ROWS) {
    throw new Error(
      `Occurrence scan exceeded hard cap of ${MAX_SCAN_ROWS} rows.`
    );
  }

  const events: OccurrenceTurnEvent[] = [];

  for (const row of rows) {
    if (!row.body.startsWith(prefix)) {
      throw new Error(
        `Corrupted occurrence receipt: unexpected body prefix in row for occurrence '${occurrenceId}'.`
      );
    }
    const jsonStr = row.body.slice(prefix.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new Error(
        `Corrupted occurrence event: malformed JSON payload for occurrence '${occurrenceId}'.`
      );
    }
    const validated = OccurrenceEventPayloadSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Corrupted occurrence event: schema validation failed for occurrence '${occurrenceId}': ${validated.error.message}`
      );
    }
    if (validated.data.occurrenceId !== occurrenceId) {
      throw new Error(
        `Corrupted occurrence event: payload occurrenceId '${validated.data.occurrenceId}' does not match expected '${occurrenceId}'.`
      );
    }
    events.push({
      caseId: row.caseId,
      payload: validated.data
    });
  }
  return events;
}

/** Validate every receipt without retaining all historic terminal work. */
function scanOccurrenceRecords(
  db: DatabaseSync,
  visit: (record: ScheduledOccurrenceRecord) => void
): void {
  // Sorting by the complete prefixed body groups each safe occurrence ID.
  // SQLite's statement iterator avoids the old global 1,000-row ceiling.
  const rows = db.prepare(
    `SELECT case_id AS caseId, body, at, seq FROM case_turn
     WHERE seat = ? AND kind = 'receipt'
     ORDER BY body ASC, rowid ASC`
  ).iterate(SCHEDULED_OCCURRENCE_SEAT) as Iterable<TurnRow>;
  let currentId: string | null = null;
  let currentEvents: (OccurrenceTurnEvent & { readonly at: number; readonly seq: number })[] = [];
  const flush = (): void => {
    if (currentId === null) return;
    currentEvents.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const record = buildOccurrenceRecord(currentEvents);
    if (record) visit(record);
    currentEvents = [];
  };

  for (const row of rows) {
    if (!row.body.startsWith(SCHEDULED_OCCURRENCE_PREFIX)) {
      throw new Error(
        `Corrupted occurrence receipt: unexpected body prefix in row '${row.body}'.`
      );
    }
    const withoutPrefix = row.body.slice(SCHEDULED_OCCURRENCE_PREFIX.length);
    const colonIndex = withoutPrefix.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `Corrupted occurrence receipt: missing delimiter in body '${row.body}'.`
      );
    }
    const occurrenceId = withoutPrefix.slice(0, colonIndex);
    const parsedId = SafeIdSchema.safeParse(occurrenceId);
    if (!parsedId.success) {
      throw new Error(
        `Corrupted occurrence receipt: invalid occurrenceId '${occurrenceId}' in body.`
      );
    }
    const jsonStr = withoutPrefix.slice(colonIndex + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new Error(
        `Corrupted occurrence event: malformed JSON for occurrence '${occurrenceId}'.`
      );
    }
    const validated = OccurrenceEventPayloadSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Corrupted occurrence event: schema validation failed for occurrence '${occurrenceId}': ${validated.error.message}`
      );
    }
    if (validated.data.occurrenceId !== occurrenceId) {
      throw new Error(
        `Corrupted occurrence event: payload occurrenceId '${validated.data.occurrenceId}' does not match receipt occurrenceId '${occurrenceId}'.`
      );
    }

    if (currentId !== occurrenceId) {
      flush();
      currentId = occurrenceId;
    }
    if (currentEvents.length >= MAX_SCAN_ROWS) {
      throw new Error(`Occurrence scan exceeded hard cap of ${MAX_SCAN_ROWS} rows.`);
    }
    currentEvents.push({
      caseId: row.caseId,
      payload: validated.data,
      at: row.at,
      seq: row.seq
    });
  }
  flush();
}

function buildOccurrenceRecord(
  events: readonly OccurrenceTurnEvent[]
): ScheduledOccurrenceRecord | null {
  if (events.length === 0) {
    return null;
  }

  const enqueuedEvents = events.filter(
    (e): e is OccurrenceTurnEvent & { payload: EnqueuedEventPayload } =>
      e.payload.event === "enqueued"
  );
  if (enqueuedEvents.length === 0) {
    throw new Error("Corrupted occurrence history: missing enqueued event.");
  }

  const enqueued = enqueuedEvents[0]!.payload;
  for (let i = 1; i < enqueuedEvents.length; i++) {
    const other = enqueuedEvents[i]!.payload;
    if (
      enqueued.scheduleId !== other.scheduleId ||
      enqueued.definitionRevision !== other.definitionRevision ||
      enqueued.caseId !== other.caseId ||
      enqueued.projectId !== other.projectId ||
      enqueued.dueAt !== other.dueAt ||
      enqueued.reviewedGrantRef !== other.reviewedGrantRef ||
      enqueued.instructionHash !== other.instructionHash
    ) {
      throw new Error(
        `Corrupted occurrence collision: conflicting enqueued events for occurrence '${enqueued.occurrenceId}'.`
      );
    }
  }

  for (const event of events) {
    if (event.caseId !== enqueued.caseId) {
      throw new Error(
        `Corrupted occurrence history: cross-case receipt attribution for occurrence '${enqueued.occurrenceId}'.`
      );
    }
  }

  const cancelledEvents = events.filter(
    (e): e is OccurrenceTurnEvent & { payload: CancelledEventPayload } =>
      e.payload.event === "cancelled"
  );
  const claimedEvents = events.filter(
    (e): e is OccurrenceTurnEvent & { payload: ClaimedEventPayload } =>
      e.payload.event === "claimed"
  );
  const settledEvents = events.filter(
    (e): e is OccurrenceTurnEvent & { payload: SettledEventPayload } =>
      e.payload.event === "settled"
  );

  if (cancelledEvents.length > 1) {
    const firstCancelled = cancelledEvents[0]!.payload;
    for (let i = 1; i < cancelledEvents.length; i++) {
      const other = cancelledEvents[i]!.payload;
      if (
        other.cancelledAt !== firstCancelled.cancelledAt ||
        (other.reason ?? null) !== (firstCancelled.reason ?? null)
      ) {
        throw new Error(
          `Corrupted occurrence history: conflicting cancellations for occurrence '${enqueued.occurrenceId}'.`
        );
      }
    }
  }

  if (claimedEvents.length > 1) {
    const firstClaim = claimedEvents[0]!.payload;
    for (let i = 1; i < claimedEvents.length; i++) {
      if (claimedEvents[i]!.payload.claimId !== firstClaim.claimId) {
        throw new Error(
          `Corrupted occurrence history: conflicting claims for occurrence '${enqueued.occurrenceId}'.`
        );
      }
    }
  }

  if (settledEvents.length > 1) {
    const firstSettled = settledEvents[0]!.payload;
    for (let i = 1; i < settledEvents.length; i++) {
      if (
        settledEvents[i]!.payload.claimId !== firstSettled.claimId ||
        settledEvents[i]!.payload.outcome !== firstSettled.outcome
      ) {
        throw new Error(
          `Corrupted occurrence history: conflicting settlements for occurrence '${enqueued.occurrenceId}'.`
        );
      }
    }
  }

  const cancelled = cancelledEvents[0]?.payload;
  const claimed = claimedEvents[0]?.payload;
  const settled = settledEvents[0]?.payload;

  if (cancelled && (claimed || settled)) {
    throw new Error(
      `Corrupted occurrence history: contradictory cancelled with claimed/settled events for occurrence '${enqueued.occurrenceId}'.`
    );
  }

  if (settled && !claimed) {
    throw new Error(
      `Corrupted occurrence history: settlement without claim for occurrence '${enqueued.occurrenceId}'.`
    );
  }

  if (settled && claimed && settled.claimId !== claimed.claimId) {
    throw new Error(
      `Corrupted occurrence history: settlement claimId mismatch for occurrence '${enqueued.occurrenceId}'.`
    );
  }

  let status: ScheduledOccurrenceStatus = "queued";
  let terminal = false;
  let outcome: OccurrenceTerminalOutcome | null = null;
  let settledAt: number | null = null;
  let detail: string | null = null;
  let cancelledAt: number | null = null;
  let cancelReason: string | null = null;

  if (cancelled) {
    status = "cancelled";
    terminal = true;
    cancelledAt = cancelled.cancelledAt;
    cancelReason = cancelled.reason ?? null;
  } else if (settled) {
    status = settled.outcome;
    terminal = true;
    outcome = settled.outcome;
    settledAt = settled.settledAt;
    detail = settled.detail ?? null;
  } else if (claimed) {
    status = "claimed";
    terminal = false;
  }

  return Object.freeze({
    occurrenceId: enqueued.occurrenceId,
    scheduleId: enqueued.scheduleId,
    definitionRevision: enqueued.definitionRevision,
    caseId: enqueued.caseId,
    projectId: enqueued.projectId,
    dueAt: enqueued.dueAt,
    reviewedGrantRef: enqueued.reviewedGrantRef,
    instructionHash: enqueued.instructionHash,
    enqueuedAt: enqueued.enqueuedAt,
    status,
    terminal,
    claimId: claimed?.claimId ?? null,
    claimedAt: claimed?.claimedAt ?? null,
    settledAt,
    outcome,
    cancelledAt,
    cancelReason,
    detail
  });
}

/** A closed Case is itself the durable cancellation fact for unclaimed work. */
function projectClosedCaseCancellation(
  db: DatabaseSync,
  record: ScheduledOccurrenceRecord
): ScheduledOccurrenceRecord {
  if (record.status !== "queued") return record;
  const caseRow = readCase(db, record.caseId);
  if (!caseRow) throw new Error(`Queued occurrence ${record.occurrenceId} has no Case.`);
  if (caseRow.closedAt === null) return record;
  return Object.freeze({
    ...record,
    status: "cancelled" as const,
    terminal: true,
    cancelledAt: caseRow.closedAt,
    cancelReason: "The Case was closed; queued work cannot start."
  });
}

export function enqueueOccurrence(
  db: DatabaseSync,
  input: unknown
): EnqueueOccurrenceResult {
  const valid = EnqueueOccurrenceInputSchema.parse(input);

  return withImmediateTransaction(db, () => {
    const caseRow = readCase(db, valid.caseId);
    if (!caseRow) {
      throw new Error(`Case ${valid.caseId} does not exist.`);
    }
    if (caseRow.closedAt !== null) {
      throw new Error(`Case ${valid.caseId} is closed. A closed case does not grow.`);
    }

    const currentProject = projectForWork(db, valid.caseId);
    const expectedProjectId = currentProject?.id ?? null;
    if (valid.projectId !== expectedProjectId) {
      throw new Error(
        `Project mismatch: case ${valid.caseId} is associated with project '${expectedProjectId}', but '${valid.projectId}' was supplied.`
      );
    }

    const existingEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const existing = buildOccurrenceRecord(existingEvents);

    if (existing !== null) {
      const isIdentical =
        existing.scheduleId === valid.scheduleId &&
        existing.definitionRevision === valid.definitionRevision &&
        existing.caseId === valid.caseId &&
        existing.projectId === expectedProjectId &&
        existing.dueAt === valid.dueAt &&
        existing.reviewedGrantRef === valid.reviewedGrantRef &&
        existing.instructionHash === valid.instructionHash;

      if (!isIdentical) {
        throw new Error(
          `Occurrence collision: occurrenceId ${valid.occurrenceId} already exists with differing spec or scope.`
        );
      }

      return Object.freeze({
        ...existing,
        enqueued: false,
        occurrence: existing
      });
    }

    const enqueuedAt = valid.enqueuedAt ?? Date.now();
    const payload: EnqueuedEventPayload = {
      version: 1,
      event: "enqueued",
      occurrenceId: valid.occurrenceId,
      scheduleId: valid.scheduleId,
      definitionRevision: valid.definitionRevision,
      caseId: valid.caseId,
      projectId: expectedProjectId,
      dueAt: valid.dueAt,
      reviewedGrantRef: valid.reviewedGrantRef,
      instructionHash: valid.instructionHash,
      enqueuedAt
    };

    appendTurn(
      db,
      valid.caseId,
      {
        seat: SCHEDULED_OCCURRENCE_SEAT,
        kind: "receipt",
        body: `${SCHEDULED_OCCURRENCE_PREFIX}${valid.occurrenceId}:${JSON.stringify(payload)}`
      },
      enqueuedAt
    );

    const updatedEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const record = buildOccurrenceRecord(updatedEvents);
    if (!record) {
      throw new Error(`Failed to read back enqueued occurrence ${valid.occurrenceId}.`);
    }

    return Object.freeze({
      ...record,
      enqueued: true,
      occurrence: record
    });
  });
}

export function claimOccurrence(
  db: DatabaseSync,
  input: unknown
): ClaimOccurrenceResult {
  const valid = ClaimOccurrenceInputSchema.parse(input);

  return withImmediateTransaction(db, () => {
    const existingEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const record = buildOccurrenceRecord(existingEvents);
    if (!record) {
      throw new Error(`Cannot claim occurrence ${valid.occurrenceId}: occurrence not found.`);
    }

    if (record.status === "cancelled") {
      throw new Error(`Cannot claim occurrence ${valid.occurrenceId}: occurrence is cancelled.`);
    }
    if (record.terminal) {
      throw new Error(
        `Cannot claim occurrence ${valid.occurrenceId}: occurrence is already terminal (${record.status}).`
      );
    }
    if (record.status === "claimed") {
      throw new Error(
        `Cannot claim occurrence ${valid.occurrenceId}: occurrence is already claimed by claim ${record.claimId}. Duplicate claims rejected.`
      );
    }
    if (record.status !== "queued") {
      throw new Error(
        `Cannot claim occurrence ${valid.occurrenceId}: occurrence is in state '${record.status}'.`
      );
    }

    const currentProject = projectForWork(db, record.caseId);
    const expectedProjectId = currentProject?.id ?? null;
    if (record.projectId !== expectedProjectId) {
      throw new Error(
        `Cannot claim occurrence ${valid.occurrenceId}: case ${record.caseId} project is '${expectedProjectId}', but occurrence is bound to '${record.projectId}'.`
      );
    }
    if (valid.projectId !== undefined && valid.projectId !== expectedProjectId) {
      throw new Error(
        `Cannot claim occurrence ${valid.occurrenceId}: caller supplied projectId '${valid.projectId}', but case is associated with '${expectedProjectId}'.`
      );
    }

    const claimedAt = valid.claimedAt ?? Date.now();
    const asOf = valid.asOf ?? claimedAt;

    if (record.dueAt > asOf) {
      throw new Error(
        `Cannot claim occurrence ${valid.occurrenceId}: occurrence is not due yet (dueAt: ${record.dueAt}, asOf: ${asOf}).`
      );
    }

    const caseRow = readCase(db, record.caseId);
    if (!caseRow || caseRow.closedAt !== null) {
      throw new Error(`Case ${record.caseId} is closed. Cannot claim occurrence in a closed case.`);
    }

    const claimId = valid.claimId ?? randomUUID();
    const payload: ClaimedEventPayload = {
      version: 1,
      event: "claimed",
      occurrenceId: valid.occurrenceId,
      claimId,
      claimedAt
    };

    appendTurn(
      db,
      record.caseId,
      {
        seat: SCHEDULED_OCCURRENCE_SEAT,
        kind: "receipt",
        body: `${SCHEDULED_OCCURRENCE_PREFIX}${valid.occurrenceId}:${JSON.stringify(payload)}`
      },
      claimedAt
    );

    const updatedEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const updatedRecord = buildOccurrenceRecord(updatedEvents);
    if (!updatedRecord) {
      throw new Error(`Failed to read back claimed occurrence ${valid.occurrenceId}.`);
    }

    return Object.freeze({
      ...updatedRecord,
      claimId,
      claimedAt,
      occurrence: updatedRecord
    });
  });
}

export function settleOccurrence(
  db: DatabaseSync,
  input: unknown
): SettleOccurrenceResult {
  const valid = SettleOccurrenceInputSchema.parse(input);

  return withImmediateTransaction(db, () => {
    const existingEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const record = buildOccurrenceRecord(existingEvents);
    if (!record) {
      throw new Error(`Cannot settle occurrence ${valid.occurrenceId}: occurrence not found.`);
    }

    if (record.status === "cancelled") {
      throw new Error(`Cannot settle occurrence ${valid.occurrenceId}: occurrence is cancelled.`);
    }
    if (record.terminal) {
      throw new Error(
        `Cannot settle occurrence ${valid.occurrenceId}: occurrence is already settled with outcome '${record.status}'.`
      );
    }
    if (record.status !== "claimed" || record.claimId === null) {
      throw new Error(
        `Cannot settle occurrence ${valid.occurrenceId}: occurrence has not been claimed.`
      );
    }
    if (record.claimId !== valid.claimId) {
      throw new Error(
        `Cannot settle occurrence ${valid.occurrenceId}: claimId mismatch (active: ${record.claimId}, supplied: ${valid.claimId}).`
      );
    }

    const settledAt = valid.settledAt ?? Date.now();
    const payload: SettledEventPayload = {
      version: 1,
      event: "settled",
      occurrenceId: valid.occurrenceId,
      claimId: valid.claimId,
      outcome: valid.outcome,
      settledAt,
      ...(valid.detail !== undefined ? { detail: valid.detail } : {})
    };

    appendTurn(
      db,
      record.caseId,
      {
        seat: SCHEDULED_OCCURRENCE_SEAT,
        kind: "receipt",
        body: `${SCHEDULED_OCCURRENCE_PREFIX}${valid.occurrenceId}:${JSON.stringify(payload)}`
      },
      settledAt
    );

    const updatedEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const updatedRecord = buildOccurrenceRecord(updatedEvents);
    if (!updatedRecord) {
      throw new Error(`Failed to read back settled occurrence ${valid.occurrenceId}.`);
    }

    return Object.freeze({
      ...updatedRecord,
      outcome: valid.outcome,
      settledAt,
      occurrence: updatedRecord
    });
  });
}

export function cancelOccurrence(
  db: DatabaseSync,
  input: unknown
): CancelOccurrenceResult {
  const valid = CancelOccurrenceInputSchema.parse(input);

  return withImmediateTransaction(db, () => {
    const existingEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const rawRecord = buildOccurrenceRecord(existingEvents);
    const record = rawRecord ? projectClosedCaseCancellation(db, rawRecord) : null;
    if (!record) {
      throw new Error(`Cannot cancel occurrence ${valid.occurrenceId}: occurrence not found.`);
    }

    if (record.status === "cancelled") {
      return Object.freeze({
        ...record,
        cancelled: false,
        alreadyCancelled: true,
        occurrence: record
      });
    }

    if (record.status !== "queued") {
      throw new Error(
        `Cannot cancel occurrence ${valid.occurrenceId}: only queued occurrences may be cancelled (current status: '${record.status}').`
      );
    }

    const cancelledAt = valid.cancelledAt ?? Date.now();
    const payload: CancelledEventPayload = {
      version: 1,
      event: "cancelled",
      occurrenceId: valid.occurrenceId,
      cancelledAt,
      ...(valid.reason !== undefined ? { reason: valid.reason } : {})
    };

    appendTurn(
      db,
      record.caseId,
      {
        seat: SCHEDULED_OCCURRENCE_SEAT,
        kind: "receipt",
        body: `${SCHEDULED_OCCURRENCE_PREFIX}${valid.occurrenceId}:${JSON.stringify(payload)}`
      },
      cancelledAt
    );

    const updatedEvents = fetchEventsForOccurrence(db, valid.occurrenceId);
    const updatedRecord = buildOccurrenceRecord(updatedEvents);
    if (!updatedRecord) {
      throw new Error(`Failed to read back cancelled occurrence ${valid.occurrenceId}.`);
    }

    return Object.freeze({
      ...updatedRecord,
      cancelled: true,
      alreadyCancelled: false,
      occurrence: updatedRecord
    });
  });
}

export function getOccurrence(
  db: DatabaseSync,
  occurrenceId: string
): ScheduledOccurrenceRecord | null {
  SafeIdSchema.parse(occurrenceId);
  const events = fetchEventsForOccurrence(db, occurrenceId);
  const record = buildOccurrenceRecord(events);
  return record ? projectClosedCaseCancellation(db, record) : null;
}

export function recoverOccurrence(
  db: DatabaseSync,
  occurrenceId: string,
  options?: { readonly at?: number; readonly detail?: string }
): ScheduledOccurrenceRecord | null {
  SafeIdSchema.parse(occurrenceId);
  return withImmediateTransaction(db, () => {
    const events = fetchEventsForOccurrence(db, occurrenceId);
    const record = buildOccurrenceRecord(events);
    if (!record) {
      return null;
    }

    if (record.status === "claimed" && record.claimId !== null) {
      const at = options?.at ?? Date.now();
      const detail =
        options?.detail ?? "Crash recovery: unsettled claim recovered as uncertain.";
      const payload: SettledEventPayload = {
        version: 1,
        event: "settled",
        occurrenceId,
        claimId: record.claimId,
        outcome: "uncertain",
        settledAt: at,
        detail
      };

      appendTurn(
        db,
        record.caseId,
        {
          seat: SCHEDULED_OCCURRENCE_SEAT,
          kind: "receipt",
          body: `${SCHEDULED_OCCURRENCE_PREFIX}${occurrenceId}:${JSON.stringify(payload)}`
        },
        at
      );

      const updatedEvents = fetchEventsForOccurrence(db, occurrenceId);
      return buildOccurrenceRecord(updatedEvents);
    }

    return record;
  });
}

export function recoverCrashedOccurrences(
  db: DatabaseSync,
  options?: {
    readonly at?: number;
    readonly detail?: string;
    readonly caseId?: string;
    readonly projectId?: string | null;
  }
): readonly ScheduledOccurrenceRecord[] {
  return withImmediateTransaction(db, () => {
    const claimedIds: string[] = [];
    const recovered: ScheduledOccurrenceRecord[] = [];
    scanOccurrenceRecords(db, (record) => {
      if (record.status !== "claimed" || record.claimId === null) return;
      if (options?.caseId !== undefined && record.caseId !== options.caseId) return;
      if (options?.projectId !== undefined && record.projectId !== options.projectId) return;
      if (claimedIds.length >= MAX_ACTIVE_OCCURRENCES) {
        throw new Error("Active occurrence recovery capacity exceeded.");
      }
      claimedIds.push(record.occurrenceId);
    });
    for (const occurrenceId of claimedIds) {
      const rec = recoverOccurrence(db, occurrenceId, options);
      if (rec) {
        recovered.push(rec);
      }
    }

    return Object.freeze(recovered);
  });
}

export function listDueOccurrences(
  db: DatabaseSync,
  query: unknown
): readonly ScheduledOccurrenceRecord[] {
  const validQuery = ListDueOccurrencesQuerySchema.parse(query);

  const dueRecords: ScheduledOccurrenceRecord[] = [];
  const limit = Math.min(Math.max(1, validQuery.limit ?? 50), 100);
  const compare = (a: ScheduledOccurrenceRecord, b: ScheduledOccurrenceRecord): number => {
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
    return a.occurrenceId.localeCompare(b.occurrenceId);
  };
  scanOccurrenceRecords(db, (rawRecord) => {
    const record = projectClosedCaseCancellation(db, rawRecord);
    if (record.status !== "queued" || record.dueAt > validQuery.asOf) return;
    if (validQuery.caseId !== undefined && record.caseId !== validQuery.caseId) return;
    if (validQuery.projectId !== undefined && record.projectId !== validQuery.projectId) return;

    dueRecords.push(record);
    dueRecords.sort(compare);
    if (dueRecords.length > limit) dueRecords.pop();
  });
  return Object.freeze(dueRecords);
}

/** Visit queued work only after every historic occurrence has been validated. */
export function forEachQueuedOccurrence(
  db: DatabaseSync,
  visit: (record: ScheduledOccurrenceRecord) => void
): void {
  withImmediateTransaction(db, () => {
    const queued: ScheduledOccurrenceRecord[] = [];
    scanOccurrenceRecords(db, (rawRecord) => {
      const record = projectClosedCaseCancellation(db, rawRecord);
      if (record.status !== "queued") return;
      if (queued.length >= MAX_ACTIVE_OCCURRENCES) {
        throw new Error("Active occurrence queue capacity exceeded.");
      }
      queued.push(record);
    });
    for (const record of queued) visit(record);
  });
}
