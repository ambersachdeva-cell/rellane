/** Book-only graph terminal proof. A trusted Host caller must write these receipts. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AutomationHostTerminalEvidenceSchema,
  type AutomationHostTerminalEvidence
} from "@cadrane/contracts";
import {
  CorruptCorrelationRecordError,
  GraphHostCorrelationKeySchema,
  lookup,
  type GraphHostCorrelationKey
} from "./graph-host-correlation-store.js";

/** Future graph workroom answers must use this exact seat. */
export const GRAPH_HOST_ANSWER_SEAT = "graph-host-answer";
const MAX_OUTPUT_CHARS = 2_000_000;

export function readProvenGraphHostTerminal(
  db: DatabaseSync,
  key: GraphHostCorrelationKey,
  expectedOperationId: string
): AutomationHostTerminalEvidence | null {
  const exactKey = GraphHostCorrelationKeySchema.parse(key);
  const operationId = z.uuid().parse(expectedOperationId);
  const record = lookup(db, exactKey);
  if (record === null || record.terminal === undefined) return null;
  if (record.dispatch?.operationId !== operationId || record.terminal.operationId !== operationId)
    throw new CorruptCorrelationRecordError("Graph terminal operation does not match the bound dispatch.");

  const terminal = record.terminal;
  if (terminal.outcome !== "completed") {
    if (terminal.answerTurnId !== null || terminal.resultSha256 !== null)
      throw new CorruptCorrelationRecordError("An incomplete graph terminal contains answer evidence.");
    return AutomationHostTerminalEvidenceSchema.parse({
      status: terminal.outcome, answerTurnId: null, output: null, outputSha256: null
    });
  }

  if (terminal.answerTurnId === null || terminal.resultSha256 === null)
    throw new CorruptCorrelationRecordError("A completed graph terminal lacks answer evidence.");
  const row = db.prepare(
    "SELECT case_id AS caseId, seat, kind, length(body) AS bodyLength FROM case_turn WHERE id = ?"
  ).get(terminal.answerTurnId) as {
    readonly caseId: string; readonly seat: string; readonly kind: string; readonly bodyLength: number;
  } | undefined;
  if (row === undefined || row.caseId !== exactKey.caseId || row.kind !== "finding" ||
      row.seat !== GRAPH_HOST_ANSWER_SEAT || row.bodyLength > MAX_OUTPUT_CHARS)
    throw new CorruptCorrelationRecordError("Graph terminal answer turn is missing, foreign, or invalid.");
  const bodyRow = db.prepare("SELECT body FROM case_turn WHERE id = ?").get(terminal.answerTurnId) as
    { readonly body: string } | undefined;
  if (bodyRow === undefined)
    throw new CorruptCorrelationRecordError("Graph terminal answer disappeared during verification.");
  const outputSha256 = createHash("sha256").update(bodyRow.body, "utf8").digest("hex");
  if (outputSha256 !== terminal.resultSha256)
    throw new CorruptCorrelationRecordError("Graph terminal answer hash does not match the Book turn.");
  return AutomationHostTerminalEvidenceSchema.parse({
    status: "completed", answerTurnId: terminal.answerTurnId,
    output: bodyRow.body, outputSha256
  });
}
