/**
 * Bounded, durable Book adapter for exact graph Host attempt correlation.
 *
 * Implements an append-only receipt protocol in existing Case turns
 * (seat "graph-host-correlation", kind "receipt").
 *
 * Persists immutable attempt intent before Host dispatch, binds one Host
 * operationId, and records terminal execution facts with truthful recovery.
 * Never sends model requests, stores review tokens, or infers execution
 * completion from dispatch events.
 *
 * Operational boundaries & precise dependencies:
 * 1. This store is an append-only Case Book receipt primitive, not a trusted Host
 *    terminal verifier or production execution bridge. Host terminal fact
 *    verification requires a future trusted Host adapter.
 * 2. Exact global operationId uniqueness across Cases is enforced transactionally inside
 *    `BEGIN IMMEDIATE` via a strict-parsing bounded scan (up to `MAX_CORRELATION_SCAN_ROWS`).
 *    Because schema migrations are disallowed (no index on operationId inside case_turn),
 *    enforcing global uniqueness across history sizes beyond `MAX_CORRELATION_SCAN_ROWS`
 *    strictly depends on a future index or dedicated lookup table schema migration.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { appendTurn } from "../book/cases.js";

export const GRAPH_HOST_CORRELATION_SEAT = "graph-host-correlation";
export const GRAPH_HOST_CORRELATION_PREFIX = "GraphHostCorrelationV1:";
export const MAX_MATCHING_ROWS = 3;
export const MAX_IDENTIFIER_LENGTH = 200;
export const MAX_SOURCE_TURN_IDS = 1000;
export const MAX_RECORD_JSON_LENGTH = 65536;
export const MAX_CORRELATION_SCAN_ROWS = 10000;

export class CorruptCorrelationRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptCorrelationRecordError";
  }
}

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/);
const IdentifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH);

export const TerminalOutcomeSchema = z.enum([
  "completed",
  "failed",
  "stopped",
  "interrupted"
]);
export type GraphHostTerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;
export type TerminalOutcome = GraphHostTerminalOutcome;

export const GraphHostEventStatusSchema = z.enum([
  "reserved",
  "dispatched",
  "terminal"
]);
export type GraphHostEventStatus = z.infer<typeof GraphHostEventStatusSchema>;

export const GraphHostCorrelationKeySchema = z.strictObject({
  caseId: UuidSchema,
  graphRunId: UuidSchema,
  nodeId: UuidSchema,
  attemptId: UuidSchema
});
export type GraphHostCorrelationKey = z.infer<typeof GraphHostCorrelationKeySchema>;

export const GraphHostIntentRecordSchema = z.strictObject({
  event: z.literal("intent"),
  caseId: UuidSchema,
  graphRunId: UuidSchema,
  nodeId: UuidSchema,
  attemptId: UuidSchema,
  descriptorSha256: Sha256Schema,
  workflowSha256: Sha256Schema,
  agentSha256: Sha256Schema,
  sourceTurnIds: z.array(IdentifierSchema).min(1).max(MAX_SOURCE_TURN_IDS),
  runtimeId: IdentifierSchema,
  modelId: IdentifierSchema,
  createdAt: z.number().int()
}).refine(
  (data) => new Set(data.sourceTurnIds).size === data.sourceTurnIds.length,
  {
    message: "sourceTurnIds must be unique and non-empty"
  }
).refine(
  (data) => JSON.stringify(data).length <= MAX_RECORD_JSON_LENGTH,
  {
    message: `Record payload exceeds maximum allowed size of ${MAX_RECORD_JSON_LENGTH} characters`
  }
);
export type GraphHostIntentRecord = z.infer<typeof GraphHostIntentRecordSchema>;

export const GraphHostDispatchRecordSchema = z.strictObject({
  event: z.literal("dispatch"),
  caseId: UuidSchema,
  graphRunId: UuidSchema,
  nodeId: UuidSchema,
  attemptId: UuidSchema,
  operationId: IdentifierSchema,
  dispatchedAt: z.number().int()
});
export type GraphHostDispatchRecord = z.infer<typeof GraphHostDispatchRecordSchema>;

export const GraphHostTerminalRecordSchema = z.strictObject({
  event: z.literal("terminal"),
  caseId: UuidSchema,
  graphRunId: UuidSchema,
  nodeId: UuidSchema,
  attemptId: UuidSchema,
  operationId: IdentifierSchema,
  outcome: TerminalOutcomeSchema,
  answerTurnId: IdentifierSchema.nullable(),
  resultSha256: Sha256Schema.nullable(),
  terminalAt: z.number().int()
}).superRefine((data, ctx) => {
  if (data.outcome === "completed") {
    if (data.answerTurnId === null || data.answerTurnId.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answerTurnId is required when outcome is completed"
      });
    }
    if (data.resultSha256 === null || data.resultSha256.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resultSha256 is required when outcome is completed"
      });
    }
  } else {
    if (data.answerTurnId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answerTurnId must be null when outcome is not completed"
      });
    }
    if (data.resultSha256 !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resultSha256 must be null when outcome is not completed"
      });
    }
  }
});
export type GraphHostTerminalRecord = z.infer<typeof GraphHostTerminalRecordSchema>;

export type GraphHostStoredRecord =
  | GraphHostIntentRecord
  | GraphHostDispatchRecord
  | GraphHostTerminalRecord;

export interface GraphHostIntent {
  readonly caseId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly descriptorSha256: string;
  readonly workflowSha256: string;
  readonly agentSha256: string;
  readonly sourceTurnIds: readonly string[];
  readonly runtimeId: string;
  readonly modelId: string;
  readonly createdAt: number;
}

export interface GraphHostDispatch {
  readonly operationId: string;
  readonly dispatchedAt: number;
}

export interface GraphHostTerminal {
  readonly operationId: string;
  readonly outcome: GraphHostTerminalOutcome;
  readonly answerTurnId: string | null;
  readonly resultSha256: string | null;
  readonly terminalAt: number;
}

export interface GraphHostCorrelationRecord {
  readonly caseId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly intent: GraphHostIntent;
  readonly status: GraphHostEventStatus;
  readonly eventStatus: GraphHostEventStatus;
  readonly uncertain: boolean;
  readonly dispatch?: GraphHostDispatch;
  readonly operationId?: string;
  readonly terminal?: GraphHostTerminal;
  readonly outcome?: GraphHostTerminalOutcome;
  readonly terminalOutcome?: GraphHostTerminalOutcome;
  readonly answerTurnId?: string | null;
  readonly resultSha256?: string | null;
  readonly isTerminal: boolean;
  readonly done: boolean;
}

export interface SaveIntentInput {
  readonly caseId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly descriptorSha256: string;
  readonly workflowSha256: string;
  readonly agentSha256: string;
  readonly sourceTurnIds: readonly string[];
  readonly runtimeId: string;
  readonly modelId: string;
  readonly at?: number;
  readonly createdAt?: number;
}

export interface RecordDispatchInput {
  readonly caseId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly at?: number;
  readonly dispatchedAt?: number;
}

export interface RecordTerminalInput {
  readonly caseId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly outcome: GraphHostTerminalOutcome;
  readonly answerTurnId?: string | null;
  readonly resultSha256?: string | null;
  readonly at?: number;
  readonly terminalAt?: number;
}

function getCorrelationPrefix(key: GraphHostCorrelationKey): string {
  return `${GRAPH_HOST_CORRELATION_PREFIX}${key.graphRunId}:${key.nodeId}:${key.attemptId}:`;
}

interface CorrelationHistory {
  readonly intent: GraphHostIntent | null;
  readonly dispatch: GraphHostDispatch | null;
  readonly terminal: GraphHostTerminal | null;
}

interface ParsedCorrelationRow {
  readonly caseId: string;
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly record: GraphHostStoredRecord;
}

function parseCorrelationRow(caseId: string, body: string): ParsedCorrelationRow {
  if (!body.startsWith(GRAPH_HOST_CORRELATION_PREFIX)) {
    throw new CorruptCorrelationRecordError(
      `Row body does not match expected correlation prefix: ${body.slice(0, 100)}`
    );
  }

  const rest = body.slice(GRAPH_HOST_CORRELATION_PREFIX.length);
  const firstColon = rest.indexOf(":");
  const secondColon = rest.indexOf(":", firstColon + 1);
  const thirdColon = rest.indexOf(":", secondColon + 1);

  if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
    throw new CorruptCorrelationRecordError(
      `Malformed correlation header in row: ${body.slice(0, 100)}`
    );
  }

  const graphRunId = rest.slice(0, firstColon);
  const nodeId = rest.slice(firstColon + 1, secondColon);
  const attemptId = rest.slice(secondColon + 1, thirdColon);
  const jsonStr = rest.slice(thirdColon + 1);

  const runIdParsed = UuidSchema.safeParse(graphRunId);
  const nodeIdParsed = UuidSchema.safeParse(nodeId);
  const attemptIdParsed = UuidSchema.safeParse(attemptId);

  if (!runIdParsed.success || !nodeIdParsed.success || !attemptIdParsed.success) {
    throw new CorruptCorrelationRecordError(
      `Malformed UUID in correlation header: ${body.slice(0, 100)}`
    );
  }

  if (jsonStr.length > MAX_RECORD_JSON_LENGTH) {
    throw new CorruptCorrelationRecordError(
      `Row payload exceeds maximum allowed size of ${MAX_RECORD_JSON_LENGTH} characters`
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonStr);
  } catch (cause) {
    throw new CorruptCorrelationRecordError(
      `Malformed JSON in correlation receipt: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  if (typeof parsedJson !== "object" || parsedJson === null || !("event" in parsedJson)) {
    throw new CorruptCorrelationRecordError("Correlation receipt is not a valid event object");
  }

  const eventType = (parsedJson as { readonly event: unknown }).event;

  let record: GraphHostStoredRecord;
  if (eventType === "intent") {
    const result = GraphHostIntentRecordSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new CorruptCorrelationRecordError(
        `Invalid intent record schema: ${result.error.message}`
      );
    }
    record = result.data;
  } else if (eventType === "dispatch") {
    const result = GraphHostDispatchRecordSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new CorruptCorrelationRecordError(
        `Invalid dispatch record schema: ${result.error.message}`
      );
    }
    record = result.data;
  } else if (eventType === "terminal") {
    const result = GraphHostTerminalRecordSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new CorruptCorrelationRecordError(
        `Invalid terminal record schema: ${result.error.message}`
      );
    }
    record = result.data;
  } else {
    throw new CorruptCorrelationRecordError(
      `Unknown correlation event type: ${String(eventType)}`
    );
  }

  if (
    record.caseId !== caseId ||
    record.graphRunId !== graphRunId ||
    record.nodeId !== nodeId ||
    record.attemptId !== attemptId
  ) {
    throw new CorruptCorrelationRecordError(
      `Correlation identity in ${record.event} body does not match row key`
    );
  }

  return {
    caseId,
    graphRunId,
    nodeId,
    attemptId,
    record
  };
}

function parseCorrelationHistory(
  expectedCaseId: string,
  rows: readonly { readonly caseId: string; readonly body: string; readonly seq: number }[],
  key: GraphHostCorrelationKey
): CorrelationHistory {
  if (rows.length > MAX_MATCHING_ROWS) {
    throw new CorruptCorrelationRecordError(
      `Exceeded bounded matching-row count: found ${rows.length} rows, maximum allowed is ${MAX_MATCHING_ROWS}`
    );
  }

  const prefix = getCorrelationPrefix(key);
  let intent: GraphHostIntent | null = null;
  let dispatch: GraphHostDispatch | null = null;
  let terminal: GraphHostTerminal | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.caseId !== expectedCaseId) {
      throw new CorruptCorrelationRecordError(
        `Cross-case correlation row detected: expected ${expectedCaseId}, found ${row.caseId}`
      );
    }
    if (!row.body.startsWith(prefix)) {
      throw new CorruptCorrelationRecordError(
        `Row body does not match expected correlation prefix: ${row.body.slice(0, 100)}`
      );
    }

    const parsedRow = parseCorrelationRow(row.caseId, row.body);
    if (
      parsedRow.graphRunId !== key.graphRunId ||
      parsedRow.nodeId !== key.nodeId ||
      parsedRow.attemptId !== key.attemptId
    ) {
      throw new CorruptCorrelationRecordError(
        "Correlation identity in body does not match row key"
      );
    }

    const data = parsedRow.record;

    if (data.event === "intent") {
      if (i !== 0 || intent !== null) {
        throw new CorruptCorrelationRecordError("Duplicate or misplaced intent record in history");
      }
      if (dispatch !== null || terminal !== null) {
        throw new CorruptCorrelationRecordError("Intent record found after dispatch or terminal");
      }
      intent = {
        caseId: data.caseId,
        graphRunId: data.graphRunId,
        nodeId: data.nodeId,
        attemptId: data.attemptId,
        descriptorSha256: data.descriptorSha256.toLowerCase(),
        workflowSha256: data.workflowSha256.toLowerCase(),
        agentSha256: data.agentSha256.toLowerCase(),
        sourceTurnIds: Object.freeze([...data.sourceTurnIds]),
        runtimeId: data.runtimeId,
        modelId: data.modelId,
        createdAt: data.createdAt
      };
    } else if (data.event === "dispatch") {
      if (intent === null) {
        throw new CorruptCorrelationRecordError("Dispatch record found before intent");
      }
      if (dispatch !== null) {
        throw new CorruptCorrelationRecordError("Duplicate dispatch record in history");
      }
      if (terminal !== null) {
        throw new CorruptCorrelationRecordError("Dispatch record found after terminal");
      }
      dispatch = {
        operationId: data.operationId,
        dispatchedAt: data.dispatchedAt
      };
    } else if (data.event === "terminal") {
      if (intent === null) {
        throw new CorruptCorrelationRecordError("Terminal record found before intent");
      }
      if (dispatch === null) {
        throw new CorruptCorrelationRecordError("Terminal record found before dispatch");
      }
      if (terminal !== null) {
        throw new CorruptCorrelationRecordError("Duplicate terminal record in history");
      }
      if (data.operationId !== dispatch.operationId) {
        throw new CorruptCorrelationRecordError(
          `Operation ID mismatch between dispatch (${dispatch.operationId}) and terminal (${data.operationId})`
        );
      }
      terminal = {
        operationId: data.operationId,
        outcome: data.outcome,
        answerTurnId: data.answerTurnId,
        resultSha256: data.resultSha256 === null ? null : data.resultSha256.toLowerCase(),
        terminalAt: data.terminalAt
      };
    }
  }

  return { intent, dispatch, terminal };
}

function normalizeKey(
  first: string | GraphHostCorrelationKey,
  second?: { readonly graphRunId: string; readonly nodeId: string; readonly attemptId: string }
): GraphHostCorrelationKey {
  if (typeof first === "string") {
    if (second === undefined) {
      throw new Error("Missing correlation identity components.");
    }
    return GraphHostCorrelationKeySchema.parse({
      caseId: first,
      graphRunId: second.graphRunId,
      nodeId: second.nodeId,
      attemptId: second.attemptId
    });
  }
  return GraphHostCorrelationKeySchema.parse(first);
}

export function saveIntent(db: DatabaseSync, input: SaveIntentInput): string;
export function saveIntent(
  db: DatabaseSync,
  caseId: string,
  input: Omit<SaveIntentInput, "caseId">
): string;
export function saveIntent(
  db: DatabaseSync,
  caseIdOrInput: string | SaveIntentInput,
  maybeInput?: Omit<SaveIntentInput, "caseId">
): string {
  const rawInput: SaveIntentInput =
    typeof caseIdOrInput === "string"
      ? { ...maybeInput!, caseId: caseIdOrInput }
      : caseIdOrInput;

  const validKey = GraphHostCorrelationKeySchema.parse({
    caseId: rawInput.caseId,
    graphRunId: rawInput.graphRunId,
    nodeId: rawInput.nodeId,
    attemptId: rawInput.attemptId
  });

  const createdAt = rawInput.createdAt ?? rawInput.at ?? Date.now();

  const record: GraphHostIntentRecord = GraphHostIntentRecordSchema.parse({
    event: "intent",
    caseId: validKey.caseId,
    graphRunId: validKey.graphRunId,
    nodeId: validKey.nodeId,
    attemptId: validKey.attemptId,
    descriptorSha256: rawInput.descriptorSha256,
    workflowSha256: rawInput.workflowSha256,
    agentSha256: rawInput.agentSha256,
    sourceTurnIds: rawInput.sourceTurnIds,
    runtimeId: rawInput.runtimeId,
    modelId: rawInput.modelId,
    createdAt
  });

  const prefix = getCorrelationPrefix(validKey);

  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare("SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?")
      .get(validKey.caseId) as { readonly id: string; readonly closedAt: number | null } | undefined;
    if (caseRow === undefined) {
      throw new Error(`Case ${validKey.caseId} does not exist.`);
    }
    if (caseRow.closedAt !== null) {
      throw new Error(`Case ${validKey.caseId} is closed. A closed case does not grow.`);
    }

    const existingGlobal = db
      .prepare(
        `SELECT case_id AS caseId, body FROM case_turn
         WHERE seat = ? AND kind = 'receipt' AND body LIKE ?`
      )
      .all(GRAPH_HOST_CORRELATION_SEAT, `${prefix}%`) as unknown as readonly {
        readonly caseId: string;
        readonly body: string;
      }[];

    if (existingGlobal.length > 0) {
      throw new Error(
        `Duplicate intent: correlation ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId} already exists in case ${existingGlobal[0]!.caseId}.`
      );
    }

    const recordJson = JSON.stringify(record);
    if (recordJson.length > MAX_RECORD_JSON_LENGTH) {
      throw new Error(
        `Record payload exceeds maximum allowed size of ${MAX_RECORD_JSON_LENGTH} characters`
      );
    }

    const turnId = appendTurn(
      db,
      validKey.caseId,
      {
        seat: GRAPH_HOST_CORRELATION_SEAT,
        kind: "receipt",
        body: `${prefix}${recordJson}`
      },
      record.createdAt
    );

    db.exec("COMMIT");
    return turnId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Retain primary error if rollback cannot execute
    }
    throw error;
  }
}

export function recordDispatch(db: DatabaseSync, input: RecordDispatchInput): string;
export function recordDispatch(
  db: DatabaseSync,
  caseId: string,
  input: Omit<RecordDispatchInput, "caseId">
): string;
export function recordDispatch(
  db: DatabaseSync,
  correlation: GraphHostCorrelationKey,
  operationId: string,
  at?: number
): string;
export function recordDispatch(
  db: DatabaseSync,
  first: string | RecordDispatchInput | GraphHostCorrelationKey,
  second?: Omit<RecordDispatchInput, "caseId"> | string,
  third?: number
): string {
  let rawInput: RecordDispatchInput;
  if (typeof first === "string") {
    rawInput = { ...(second as Omit<RecordDispatchInput, "caseId">), caseId: first };
  } else if (typeof second === "string") {
    rawInput = { ...(first as GraphHostCorrelationKey), operationId: second, ...(third === undefined ? {} : { at: third }) };
  } else {
    rawInput = first as RecordDispatchInput;
  }

  const validKey = GraphHostCorrelationKeySchema.parse({
    caseId: rawInput.caseId,
    graphRunId: rawInput.graphRunId,
    nodeId: rawInput.nodeId,
    attemptId: rawInput.attemptId
  });

  const dispatchedAt = rawInput.dispatchedAt ?? rawInput.at ?? Date.now();

  const record: GraphHostDispatchRecord = GraphHostDispatchRecordSchema.parse({
    event: "dispatch",
    caseId: validKey.caseId,
    graphRunId: validKey.graphRunId,
    nodeId: validKey.nodeId,
    attemptId: validKey.attemptId,
    operationId: rawInput.operationId,
    dispatchedAt
  });

  const prefix = getCorrelationPrefix(validKey);

  db.exec("BEGIN IMMEDIATE");
  try {
    const caseRow = db
      .prepare("SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?")
      .get(validKey.caseId) as { readonly id: string; readonly closedAt: number | null } | undefined;
    if (caseRow === undefined) {
      throw new Error(`Case ${validKey.caseId} does not exist.`);
    }
    if (caseRow.closedAt !== null) {
      throw new Error(`Case ${validKey.caseId} is closed. A closed case does not grow.`);
    }

    const existingGlobal = db
      .prepare(
        `SELECT case_id AS caseId, body, seq FROM case_turn
         WHERE seat = ? AND kind = 'receipt' AND body LIKE ?
         ORDER BY seq ASC`
      )
      .all(GRAPH_HOST_CORRELATION_SEAT, `${prefix}%`) as unknown as readonly {
        readonly caseId: string;
        readonly body: string;
        readonly seq: number;
      }[];

    if (existingGlobal.length === 0) {
      throw new Error(
        `Unknown intent: no intent found for correlation ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId}.`
      );
    }

    if (existingGlobal[0]!.caseId !== validKey.caseId) {
      throw new Error(
        `Cross-case correlation mismatch: attempt belongs to case ${existingGlobal[0]!.caseId}, not ${validKey.caseId}.`
      );
    }

    const history = parseCorrelationHistory(validKey.caseId, existingGlobal, validKey);
    if (history.intent === null) {
      throw new Error("Missing intent record in correlation receipts.");
    }
    if (history.dispatch !== null) {
      throw new Error(
        `Duplicate dispatch: attempt ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId} is already dispatched.`
      );
    }
    if (history.terminal !== null) {
      throw new Error(
        `Cannot dispatch: attempt ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId} is already terminal.`
      );
    }

    const recordJson = JSON.stringify(record);
    if (recordJson.length > MAX_RECORD_JSON_LENGTH) {
      throw new Error(
        `Record payload exceeds maximum allowed size of ${MAX_RECORD_JSON_LENGTH} characters`
      );
    }

    const existingReceipts = db
      .prepare(
        `SELECT case_id AS caseId, body FROM case_turn
         WHERE seat = ? AND kind = 'receipt'
         LIMIT ?`
      )
      .all(GRAPH_HOST_CORRELATION_SEAT, MAX_CORRELATION_SCAN_ROWS + 1) as unknown as readonly {
        readonly caseId: string;
        readonly body: string;
      }[];

    if (existingReceipts.length > MAX_CORRELATION_SCAN_ROWS) {
      throw new Error(
        `Exceeded bounded correlation scan limit: found more than ${MAX_CORRELATION_SCAN_ROWS} receipts.`
      );
    }

    for (const match of existingReceipts) {
      const parsedRow = parseCorrelationRow(match.caseId, match.body);
      const rowRecord = parsedRow.record;
      if (rowRecord.event === "dispatch" || rowRecord.event === "terminal") {
        if (rowRecord.operationId === record.operationId) {
          if (
            match.caseId !== validKey.caseId ||
            parsedRow.graphRunId !== validKey.graphRunId ||
            parsedRow.nodeId !== validKey.nodeId ||
            parsedRow.attemptId !== validKey.attemptId
          ) {
            throw new Error(
              `Operation ID ${record.operationId} is already bound to another attempt (${match.caseId}:${parsedRow.graphRunId}:${parsedRow.nodeId}:${parsedRow.attemptId}).`
            );
          }
        }
      }
    }

    const turnId = appendTurn(
      db,
      validKey.caseId,
      {
        seat: GRAPH_HOST_CORRELATION_SEAT,
        kind: "receipt",
        body: `${prefix}${recordJson}`
      },
      record.dispatchedAt
    );

    db.exec("COMMIT");
    return turnId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Retain primary error if rollback cannot execute
    }
    throw error;
  }
}

function recordTerminalCore(
  db: DatabaseSync,
  first: string | RecordTerminalInput,
  second?: Omit<RecordTerminalInput, "caseId">
): string {
  const rawInput: RecordTerminalInput =
    typeof first === "string"
      ? { ...second!, caseId: first }
      : first;

  const validKey = GraphHostCorrelationKeySchema.parse({
    caseId: rawInput.caseId,
    graphRunId: rawInput.graphRunId,
    nodeId: rawInput.nodeId,
    attemptId: rawInput.attemptId
  });

  const terminalAt = rawInput.terminalAt ?? rawInput.at ?? Date.now();

  const record: GraphHostTerminalRecord = GraphHostTerminalRecordSchema.parse({
    event: "terminal",
    caseId: validKey.caseId,
    graphRunId: validKey.graphRunId,
    nodeId: validKey.nodeId,
    attemptId: validKey.attemptId,
    operationId: rawInput.operationId,
    outcome: rawInput.outcome,
    answerTurnId: rawInput.answerTurnId ?? null,
    resultSha256: rawInput.resultSha256 ?? null,
    terminalAt
  });

  const prefix = getCorrelationPrefix(validKey);

  const caseRow = db
    .prepare("SELECT id, closed_at AS closedAt FROM work_case WHERE id = ?")
    .get(validKey.caseId) as { readonly id: string; readonly closedAt: number | null } | undefined;
  if (caseRow === undefined) {
    throw new Error(`Case ${validKey.caseId} does not exist.`);
  }
  if (caseRow.closedAt !== null) {
    throw new Error(`Case ${validKey.caseId} is closed. A closed case does not grow.`);
  }

  const existingGlobal = db
    .prepare(
      `SELECT case_id AS caseId, body, seq FROM case_turn
       WHERE seat = ? AND kind = 'receipt' AND body LIKE ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(GRAPH_HOST_CORRELATION_SEAT, `${prefix}%`, MAX_MATCHING_ROWS + 1) as unknown as readonly {
      readonly caseId: string;
      readonly body: string;
      readonly seq: number;
    }[];

  if (existingGlobal.length === 0) {
    throw new Error(
      `Unknown attempt: no intent found for correlation ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId}.`
    );
  }

  if (existingGlobal[0]!.caseId !== validKey.caseId) {
    throw new Error(
      `Cross-case correlation mismatch: attempt belongs to case ${existingGlobal[0]!.caseId}, not ${validKey.caseId}.`
    );
  }

  const history = parseCorrelationHistory(validKey.caseId, existingGlobal, validKey);
  if (history.intent === null) {
    throw new Error("Missing intent record in correlation receipts.");
  }
  if (history.dispatch === null) {
    throw new Error(
      `Cannot record terminal: attempt ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId} has not been dispatched.`
    );
  }
  if (history.dispatch.operationId !== record.operationId) {
    throw new Error(
      `Operation ID mismatch: expected ${history.dispatch.operationId}, got ${record.operationId}.`
    );
  }
  if (history.terminal !== null) {
    throw new Error(
      `Duplicate terminal: attempt ${validKey.graphRunId}:${validKey.nodeId}:${validKey.attemptId} already has a terminal record.`
    );
  }

  const recordJson = JSON.stringify(record);
  if (recordJson.length > MAX_RECORD_JSON_LENGTH) {
    throw new Error(
      `Record payload exceeds maximum allowed size of ${MAX_RECORD_JSON_LENGTH} characters`
    );
  }

  return appendTurn(
    db,
    validKey.caseId,
    {
      seat: GRAPH_HOST_CORRELATION_SEAT,
      kind: "receipt",
      body: `${prefix}${recordJson}`
    },
    record.terminalAt
  );
}

export function recordTerminalInExistingTransaction(
  db: DatabaseSync,
  input: RecordTerminalInput
): string;
export function recordTerminalInExistingTransaction(
  db: DatabaseSync,
  caseId: string,
  input: Omit<RecordTerminalInput, "caseId">
): string;
export function recordTerminalInExistingTransaction(
  db: DatabaseSync,
  first: string | RecordTerminalInput,
  second?: Omit<RecordTerminalInput, "caseId">
): string {
  if (db.isTransaction !== true) {
    throw new Error(
      "recordTerminalInExistingTransaction requires an active transaction (db.isTransaction must be true)."
    );
  }
  return recordTerminalCore(db, first, second);
}

export function recordTerminal(db: DatabaseSync, input: RecordTerminalInput): string;
export function recordTerminal(
  db: DatabaseSync,
  caseId: string,
  input: Omit<RecordTerminalInput, "caseId">
): string;
export function recordTerminal(
  db: DatabaseSync,
  first: string | RecordTerminalInput,
  second?: Omit<RecordTerminalInput, "caseId">
): string {
  db.exec("BEGIN IMMEDIATE");
  try {
    const turnId = recordTerminalCore(db, first, second);
    db.exec("COMMIT");
    return turnId;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Retain primary error if rollback cannot execute
    }
    throw error;
  }
}

export function lookup(
  db: DatabaseSync,
  correlation: GraphHostCorrelationKey
): GraphHostCorrelationRecord | null;
export function lookup(
  db: DatabaseSync,
  caseId: string,
  correlation: { readonly graphRunId: string; readonly nodeId: string; readonly attemptId: string }
): GraphHostCorrelationRecord | null;
export function lookup(
  db: DatabaseSync,
  first: string | GraphHostCorrelationKey,
  second?: { readonly graphRunId: string; readonly nodeId: string; readonly attemptId: string }
): GraphHostCorrelationRecord | null {
  const key = normalizeKey(first, second);
  const prefix = getCorrelationPrefix(key);

  const rows = db
    .prepare(
      `SELECT case_id AS caseId, body, seq FROM case_turn
       WHERE seat = ? AND kind = 'receipt' AND body LIKE ?
       ORDER BY seq ASC`
    )
    .all(GRAPH_HOST_CORRELATION_SEAT, `${prefix}%`) as unknown as readonly {
      readonly caseId: string;
      readonly body: string;
      readonly seq: number;
    }[];

  if (rows.length === 0) {
    return null;
  }

  if (rows.length > MAX_MATCHING_ROWS) {
    throw new CorruptCorrelationRecordError("Too many matching graph Host correlation receipts.");
  }

  const caseIds = new Set(rows.map((r) => r.caseId));
  if (caseIds.size > 1) {
    throw new CorruptCorrelationRecordError(
      `Cross-case correlation history detected for attempt: ${key.graphRunId}:${key.nodeId}:${key.attemptId}`
    );
  }

  if (rows[0]!.caseId !== key.caseId) {
    return null;
  }

  const history = parseCorrelationHistory(key.caseId, rows, key);
  if (history.intent === null) {
    throw new CorruptCorrelationRecordError("Missing intent record in correlation history.");
  }

  if (history.terminal !== null) {
    if (history.dispatch === null) {
      throw new CorruptCorrelationRecordError("Terminal receipt has no dispatch receipt.");
    }
    return {
      caseId: key.caseId,
      graphRunId: key.graphRunId,
      nodeId: key.nodeId,
      attemptId: key.attemptId,
      intent: history.intent,
      status: "terminal",
      eventStatus: "terminal",
      uncertain: false,
      dispatch: history.dispatch,
      operationId: history.dispatch.operationId,
      terminal: history.terminal,
      outcome: history.terminal.outcome,
      terminalOutcome: history.terminal.outcome,
      answerTurnId: history.terminal.answerTurnId,
      resultSha256: history.terminal.resultSha256,
      isTerminal: true,
      done: true
    };
  }

  if (history.dispatch !== null) {
    return {
      caseId: key.caseId,
      graphRunId: key.graphRunId,
      nodeId: key.nodeId,
      attemptId: key.attemptId,
      intent: history.intent,
      status: "dispatched",
      eventStatus: "dispatched",
      uncertain: true,
      dispatch: history.dispatch,
      operationId: history.dispatch.operationId,
      answerTurnId: null,
      resultSha256: null,
      isTerminal: false,
      done: false
    };
  }

  return {
    caseId: key.caseId,
    graphRunId: key.graphRunId,
    nodeId: key.nodeId,
    attemptId: key.attemptId,
    intent: history.intent,
    status: "reserved",
    eventStatus: "reserved",
    uncertain: false,
    answerTurnId: null,
    resultSha256: null,
    isTerminal: false,
    done: false
  };
}
