/**
 * Strict, bounded Case/source validator for graph Host review adapter.
 *
 * Resolves exact source turns directly from the trusted Book (never accepting
 * renderer-supplied source text). Validates open Case invariants, rejects
 * closed or missing Cases, cross-Case/duplicate/missing turn IDs, unsupported turn
 * kinds without verified provenance, oversized text bounds, and detects any content
 * modifications between review and dispatch.
 *
 * Provenance verification & boundaries:
 * 1. Reference sources (owner turns and imported verbatim files) are validated
 *    strictly via isCaseReference.
 * 2. Graph-generated answers are verified through the public lookup API of
 *    graph-host-correlation-store. A turn is accepted if and only if a completed
 *    terminal record exists in the SAME Case with an identical resultSha256
 *    matching the turn body's SHA-256 and exact origin sourceTurnIds.
 * 3. Model self-attestation or text claims inside a turn body are never accepted
 *    as provenance.
 *
 * Future dependency documentation:
 * Currently, correlation records are stored as append-only receipt turns in the Case
 * (seat 'graph-host-correlation', kind 'receipt'). If a future architecture moves
 * correlation records out of Case turns or decouples receipt storage into a dedicated
 * table without turn receipts, an explicit indexed lookup API (e.g., lookupByAnswerTurnId
 * in graph-host-correlation-store) will be required. Under current APIs, scanning receipts
 * in the same Case and verifying history via lookup() provides the authoritative linkage.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type CaseTurn, type TurnKind, readCase } from "../book/cases.js";
import { isCaseReference } from "../../shared/case-sources.js";
import {
  GRAPH_HOST_CORRELATION_PREFIX,
  GRAPH_HOST_CORRELATION_SEAT,
  lookup,
  type GraphHostTerminalOutcome
} from "./graph-host-correlation-store.js";

export const DEFAULT_MAX_SOURCE_TURN_COUNT = 100;
export const DEFAULT_MAX_SINGLE_TURN_BYTES = 512 * 1024; // 512 KiB
export const DEFAULT_MAX_TOTAL_SOURCE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const DEFAULT_MAX_CORRELATION_SCAN = 1000;

export enum CaseSourceValidationErrorCode {
  INVALID_INPUT = "INVALID_INPUT",
  CASE_NOT_FOUND = "CASE_NOT_FOUND",
  CASE_CLOSED = "CASE_CLOSED",
  EMPTY_SELECTION = "EMPTY_SELECTION",
  TOO_MANY_TURNS = "TOO_MANY_TURNS",
  DUPLICATE_TURN_ID = "DUPLICATE_TURN_ID",
  TURN_NOT_FOUND = "TURN_NOT_FOUND",
  CROSS_CASE_TURN = "CROSS_CASE_TURN",
  UNSUPPORTED_TURN_KIND = "UNSUPPORTED_TURN_KIND",
  UNVERIFIED_PROVENANCE = "UNVERIFIED_PROVENANCE",
  PROVENANCE_HASH_MISMATCH = "PROVENANCE_HASH_MISMATCH",
  TURN_SIZE_EXCEEDED = "TURN_SIZE_EXCEEDED",
  TOTAL_SIZE_EXCEEDED = "TOTAL_SIZE_EXCEEDED",
  BINDING_MISMATCH = "BINDING_MISMATCH",
  CONTENT_HASH_MISMATCH = "CONTENT_HASH_MISMATCH"
}

export class CaseSourceValidationError extends Error {
  readonly code: CaseSourceValidationErrorCode;
  readonly turnId?: string;

  constructor(message: string, code: CaseSourceValidationErrorCode, turnId?: string) {
    super(message);
    this.name = "CaseSourceValidationError";
    this.code = code;
    if (turnId !== undefined) {
      this.turnId = turnId;
    }
  }
}

export interface GraphSourceProvenance {
  readonly graphRunId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly terminalOutcome: GraphHostTerminalOutcome;
  readonly resultSha256: string;
  readonly sourceTurnIds: readonly string[];
}

export interface ValidatedSourceTurn {
  readonly turnId: string;
  readonly seq: number;
  readonly seat: string;
  readonly kind: TurnKind;
  readonly body: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly sourceType: "case_reference" | "graph_generated";
  readonly provenance?: GraphSourceProvenance;
}

export interface CaseSourceTurnBinding {
  readonly turnId: string;
  readonly contentSha256: string;
}

export interface CaseSourceBinding {
  readonly caseId: string;
  readonly turnBindings: readonly CaseSourceTurnBinding[];
  readonly canonicalString: string;
  readonly bindingSha256: string;
}

export interface ValidatedCaseSourcesResult {
  readonly caseId: string;
  readonly sources: readonly ValidatedSourceTurn[];
  readonly aggregateBinding: CaseSourceBinding;
  readonly totalBytes: number;
}

export interface ValidateCaseSourcesInput {
  readonly caseId: string;
  readonly selectedTurnIds: readonly string[];
  readonly expectedBinding?: string;
  readonly expectedContentSha256ByTurnId?:
    | ReadonlyMap<string, string>
    | Record<string, string>;
  readonly maxTurnCount?: number;
  readonly maxTurnBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxCorrelationScan?: number;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").toLowerCase();
}

/**
 * Computes a deterministic, collision-resistant aggregate binding across ordered turns.
 */
export function computeSourceAggregateBinding(
  caseId: string,
  sources: readonly { readonly turnId: string; readonly contentSha256: string }[]
): CaseSourceBinding {
  const turnBindings: CaseSourceTurnBinding[] = sources.map((s) => ({
    turnId: s.turnId,
    contentSha256: s.contentSha256
  }));

  const lines = [
    `case:${caseId}`,
    ...sources.map((s) => `turn:${s.turnId}:${s.contentSha256}`)
  ];
  const canonicalString = lines.join("\n");
  const bindingSha256 = sha256Hex(canonicalString);

  return {
    caseId,
    turnBindings: Object.freeze(turnBindings),
    canonicalString,
    bindingSha256
  };
}

/**
 * Verifies if an answer turn has a truthful, completed graph execution terminal
 * in the same Case via the public correlation store lookup API.
 */
function findVerifiedGraphProvenance(
  db: DatabaseSync,
  caseId: string,
  turn: CaseTurn,
  maxCorrelationScan = DEFAULT_MAX_CORRELATION_SCAN
): GraphSourceProvenance | null {
  if (turn.kind !== "finding") {
    return null;
  }

  if (!Number.isSafeInteger(maxCorrelationScan) || maxCorrelationScan < 1 || maxCorrelationScan > DEFAULT_MAX_CORRELATION_SCAN) {
    throw new CaseSourceValidationError(
      "Invalid correlation scan bound",
      CaseSourceValidationErrorCode.INVALID_INPUT,
      turn.id
    );
  }

  const rows = db
    .prepare(
      `SELECT body FROM case_turn
       WHERE case_id = ? AND seat = ? AND kind = 'receipt' AND body LIKE ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(
      caseId,
      GRAPH_HOST_CORRELATION_SEAT,
      `${GRAPH_HOST_CORRELATION_PREFIX}%`,
      maxCorrelationScan + 1
    ) as unknown as readonly { readonly body: string }[];

  if (rows.length > maxCorrelationScan) {
    throw new CaseSourceValidationError(
      `Correlation receipt scan bound exceeded (max ${maxCorrelationScan})`,
      CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
      turn.id
    );
  }

  if (rows.length === 0) {
    return null;
  }

  const turnHash = sha256Hex(turn.body);
  const seenKeys = new Set<string>();

  for (const row of rows) {
    const body = row?.body;
    if (typeof body !== "string" || !body.startsWith(GRAPH_HOST_CORRELATION_PREFIX)) {
      throw new CaseSourceValidationError(
        `Malformed correlation receipt body in case ${caseId}`,
        CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
        turn.id
      );
    }
    const rest = body.slice(GRAPH_HOST_CORRELATION_PREFIX.length);
    const firstColon = rest.indexOf(":");
    const secondColon = rest.indexOf(":", firstColon + 1);
    const thirdColon = rest.indexOf(":", secondColon + 1);
    if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
      throw new CaseSourceValidationError(
        `Malformed correlation receipt key in case ${caseId}`,
        CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
        turn.id
      );
    }

    const graphRunId = rest.slice(0, firstColon);
    const nodeId = rest.slice(firstColon + 1, secondColon);
    const attemptId = rest.slice(secondColon + 1, thirdColon);
    if (!graphRunId || !nodeId || !attemptId) {
      throw new CaseSourceValidationError(
        `Malformed correlation receipt key components in case ${caseId}`,
        CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
        turn.id
      );
    }
    const keyStr = `${graphRunId}:${nodeId}:${attemptId}`;
    if (seenKeys.has(keyStr)) {
      continue;
    }
    seenKeys.add(keyStr);

    let record;
    try {
      record = lookup(db, caseId, { graphRunId, nodeId, attemptId });
    } catch (error) {
      throw new CaseSourceValidationError(
        `Correlation lookup failure or corruption for ${keyStr}: ${error instanceof Error ? error.message : String(error)}`,
        CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
        turn.id
      );
    }

    if (
      record !== null &&
      record.status === "terminal" &&
      record.outcome === "completed" &&
      record.answerTurnId === turn.id
    ) {
      const expectedHash = record.resultSha256?.toLowerCase();
      if (expectedHash !== turnHash) {
        throw new CaseSourceValidationError(
          `Graph-generated turn ${turn.id} content does not match terminal receipt result hash (expected ${expectedHash}, got ${turnHash})`,
          CaseSourceValidationErrorCode.PROVENANCE_HASH_MISMATCH,
          turn.id
        );
      }

      return {
        graphRunId: record.graphRunId,
        nodeId: record.nodeId,
        attemptId: record.attemptId,
        operationId: record.operationId ?? record.terminal!.operationId,
        terminalOutcome: record.outcome,
        resultSha256: expectedHash,
        sourceTurnIds: Object.freeze([...record.intent.sourceTurnIds])
      };
    }
  }

  return null;
}

/**
 * Validates selected source turns for an open Case from the Book.
 * Never accepts renderer-supplied source text. Resolves directly from SQLite.
 */
export function validateCaseSources(
  db: DatabaseSync,
  input: ValidateCaseSourcesInput
): ValidatedCaseSourcesResult {
  if (typeof input.caseId !== "string" || input.caseId.trim().length === 0) {
    throw new CaseSourceValidationError(
      "caseId must be a non-empty string",
      CaseSourceValidationErrorCode.INVALID_INPUT
    );
  }

  if (!Array.isArray(input.selectedTurnIds)) {
    throw new CaseSourceValidationError(
      "selectedTurnIds must be an array",
      CaseSourceValidationErrorCode.INVALID_INPUT
    );
  }

  if (input.selectedTurnIds.length === 0) {
    throw new CaseSourceValidationError(
      "Selection must contain at least one turn ID",
      CaseSourceValidationErrorCode.EMPTY_SELECTION
    );
  }

  const maxTurnCount = input.maxTurnCount ?? DEFAULT_MAX_SOURCE_TURN_COUNT;
  if (input.selectedTurnIds.length > maxTurnCount) {
    throw new CaseSourceValidationError(
      `Selection count ${input.selectedTurnIds.length} exceeds maximum allowed turns (${maxTurnCount})`,
      CaseSourceValidationErrorCode.TOO_MANY_TURNS
    );
  }

  // Reject duplicate turn IDs in selection
  const seenIds = new Set<string>();
  for (const turnId of input.selectedTurnIds) {
    if (typeof turnId !== "string" || turnId.trim().length === 0) {
      throw new CaseSourceValidationError(
        "Each selected turn ID must be a non-empty string",
        CaseSourceValidationErrorCode.INVALID_INPUT
      );
    }
    if (seenIds.has(turnId)) {
      throw new CaseSourceValidationError(
        `Duplicate turn ID in selection: ${turnId}`,
        CaseSourceValidationErrorCode.DUPLICATE_TURN_ID,
        turnId
      );
    }
    seenIds.add(turnId);
  }

  // Verify Case exists and is open in the Book
  const caseRow = readCase(db, input.caseId);
  if (caseRow === null) {
    throw new CaseSourceValidationError(
      `Case ${input.caseId} not found`,
      CaseSourceValidationErrorCode.CASE_NOT_FOUND
    );
  }

  if (caseRow.closedAt !== null) {
    throw new CaseSourceValidationError(
      `Case ${input.caseId} is closed. Closed cases cannot be used for review or dispatch`,
      CaseSourceValidationErrorCode.CASE_CLOSED
    );
  }

  const maxTurnBytes = input.maxTurnBytes ?? DEFAULT_MAX_SINGLE_TURN_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_SOURCE_BYTES;

  const validatedTurns: ValidatedSourceTurn[] = [];
  let totalBytes = 0;

  // Resolve turns in exact selected order
  for (const turnId of input.selectedTurnIds) {
    const row = db
      .prepare(
        `SELECT id, case_id AS caseId, seq, seat, kind, body, at, compacted_from AS compactedFrom
         FROM case_turn WHERE id = ?`
      )
      .get(turnId) as Record<string, unknown> | undefined;

    if (row === undefined) {
      throw new CaseSourceValidationError(
        `Turn ${turnId} not found in case history`,
        CaseSourceValidationErrorCode.TURN_NOT_FOUND,
        turnId
      );
    }

    if (String(row["caseId"]) !== input.caseId) {
      throw new CaseSourceValidationError(
        `Turn ${turnId} belongs to case ${String(row["caseId"])}, not ${input.caseId}`,
        CaseSourceValidationErrorCode.CROSS_CASE_TURN,
        turnId
      );
    }

    const turn: CaseTurn = {
      id: String(row["id"]),
      seq: Number(row["seq"]),
      seat: String(row["seat"]),
      kind: String(row["kind"]) as TurnKind,
      body: String(row["body"]),
      at: Number(row["at"]),
      compactedFrom:
        row["compactedFrom"] === null
          ? null
          : (JSON.parse(String(row["compactedFrom"])) as readonly string[])
    };

    const byteLength = Buffer.byteLength(turn.body, "utf8");
    if (byteLength > maxTurnBytes) {
      throw new CaseSourceValidationError(
        `Turn ${turn.id} size (${byteLength} bytes) exceeds maximum allowed single turn size (${maxTurnBytes} bytes)`,
        CaseSourceValidationErrorCode.TURN_SIZE_EXCEEDED,
        turn.id
      );
    }
    totalBytes += byteLength;

    if (totalBytes > maxTotalBytes) {
      throw new CaseSourceValidationError(
        `Total source size (${totalBytes} bytes) exceeds maximum allowed total size (${maxTotalBytes} bytes)`,
        CaseSourceValidationErrorCode.TOTAL_SIZE_EXCEEDED
      );
    }

    const contentSha256 = sha256Hex(turn.body);
    const isRef = isCaseReference({
      seat: turn.seat,
      kind: turn.kind
    });

    let sourceType: "case_reference" | "graph_generated";
    let provenance: GraphSourceProvenance | undefined;

    if (isRef) {
      sourceType = "case_reference";
    } else if (turn.kind === "finding") {
      const verifiedProvenance = findVerifiedGraphProvenance(
        db,
        input.caseId,
        turn,
        input.maxCorrelationScan ?? DEFAULT_MAX_CORRELATION_SCAN
      );
      if (verifiedProvenance !== null) {
        sourceType = "graph_generated";
        provenance = verifiedProvenance;
      } else {
        throw new CaseSourceValidationError(
          `Finding turn ${turn.id} lacks verified graph-generated provenance`,
          CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
          turn.id
        );
      }
    } else if (turn.kind === "compacted") {
      throw new CaseSourceValidationError(
        `Compacted turn ${turn.id} cannot be used as a source`,
        CaseSourceValidationErrorCode.UNSUPPORTED_TURN_KIND,
        turn.id
      );
    } else if (turn.kind === "receipt") {
      throw new CaseSourceValidationError(
        `Receipt turn ${turn.id} cannot be used as a source`,
        CaseSourceValidationErrorCode.UNSUPPORTED_TURN_KIND,
        turn.id
      );
    } else {
      throw new CaseSourceValidationError(
        `Turn ${turn.id} (seat: "${turn.seat}", kind: "${turn.kind}") is neither a trusted reference nor verified graph-generated provenance`,
        CaseSourceValidationErrorCode.UNVERIFIED_PROVENANCE,
        turn.id
      );
    }

    validatedTurns.push({
      turnId: turn.id,
      seq: turn.seq,
      seat: turn.seat,
      kind: turn.kind,
      body: turn.body,
      byteLength,
      contentSha256,
      sourceType,
      ...(provenance !== undefined ? { provenance } : {})
    });
  }

  const aggregateBinding = computeSourceAggregateBinding(input.caseId, validatedTurns);

  // Verify content has not changed between review and dispatch
  if (input.expectedContentSha256ByTurnId !== undefined) {
    for (const vTurn of validatedTurns) {
      const expected =
        input.expectedContentSha256ByTurnId instanceof Map
          ? input.expectedContentSha256ByTurnId.get(vTurn.turnId)
          : (input.expectedContentSha256ByTurnId as Record<string, string>)[vTurn.turnId];
      if (expected !== undefined && expected.toLowerCase() !== vTurn.contentSha256) {
        throw new CaseSourceValidationError(
          `Turn ${vTurn.turnId} content SHA-256 changed between review and dispatch (expected ${expected}, got ${vTurn.contentSha256})`,
          CaseSourceValidationErrorCode.CONTENT_HASH_MISMATCH,
          vTurn.turnId
        );
      }
    }
  }

  if (input.expectedBinding !== undefined) {
    const exp = input.expectedBinding.toLowerCase();
    const actualSha = aggregateBinding.bindingSha256.toLowerCase();
    const actualCanonical = aggregateBinding.canonicalString;
    if (exp !== actualSha && input.expectedBinding !== actualCanonical) {
      throw new CaseSourceValidationError(
        `Aggregate source binding mismatch between review and dispatch (expected ${input.expectedBinding}, got ${aggregateBinding.bindingSha256})`,
        CaseSourceValidationErrorCode.BINDING_MISMATCH
      );
    }
  }

  return {
    caseId: input.caseId,
    sources: Object.freeze(validatedTurns),
    aggregateBinding,
    totalBytes
  };
}
