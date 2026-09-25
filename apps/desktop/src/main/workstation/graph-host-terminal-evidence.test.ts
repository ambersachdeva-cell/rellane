import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendTurn, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { recordDispatch, recordTerminal, saveIntent } from "./graph-host-correlation-store.js";
import { GRAPH_HOST_ANSWER_SEAT, readProvenGraphHostTerminal } from "./graph-host-terminal-evidence.js";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
});
afterEach(() => db.close());

function attempt() {
  const caseId = openCase(db, { title: "Graph case", question: "Answer from source" });
  const sourceId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Source" });
  const key = { caseId, graphRunId: randomUUID(), nodeId: randomUUID(), attemptId: randomUUID() };
  const operationId = randomUUID();
  saveIntent(db, { ...key, descriptorSha256: "a".repeat(64), workflowSha256: "b".repeat(64),
    agentSha256: "c".repeat(64), sourceTurnIds: [sourceId],
    runtimeId: "cadrane-local-loopback", modelId: "local-model" });
  return { key, operationId };
}

describe("unregistered graph Host Book terminal evidence", () => {
  it("returns no outcome for a reserved or uncertain dispatched attempt", () => {
    const { key, operationId } = attempt();
    expect(readProvenGraphHostTerminal(db, key, operationId)).toBeNull();
    recordDispatch(db, { ...key, operationId });
    expect(readProvenGraphHostTerminal(db, key, operationId)).toBeNull();
  });

  it("returns exact completed finding bytes only for the bound operation and hash", () => {
    const { key, operationId } = attempt();
    recordDispatch(db, { ...key, operationId });
    const body = "Grounded graph output";
    const answerTurnId = appendTurn(db, key.caseId, { seat: GRAPH_HOST_ANSWER_SEAT, kind: "finding", body });
    const outputSha256 = createHash("sha256").update(body).digest("hex");
    recordTerminal(db, { ...key, operationId, outcome: "completed", answerTurnId, resultSha256: outputSha256 });
    expect(readProvenGraphHostTerminal(db, key, operationId)).toEqual({
      status: "completed", answerTurnId, output: body, outputSha256
    });
    expect(() => readProvenGraphHostTerminal(db, key, randomUUID())).toThrow("operation");
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run("changed", answerTurnId);
    expect(() => readProvenGraphHostTerminal(db, key, operationId)).toThrow("hash");
  });

  it("rejects an answer turn with an owner seat even if the hash matches", () => {
    const { key, operationId } = attempt();
    recordDispatch(db, { ...key, operationId });
    const body = "Untrusted owner text";
    const answerTurnId = appendTurn(db, key.caseId, { seat: "owner", kind: "finding", body });
    recordTerminal(db, { ...key, operationId, outcome: "completed", answerTurnId,
      resultSha256: createHash("sha256").update(body).digest("hex") });
    expect(() => readProvenGraphHostTerminal(db, key, operationId)).toThrow("invalid");
  });

  it("returns a proven failed terminal with no invented output", () => {
    const { key, operationId } = attempt();
    recordDispatch(db, { ...key, operationId });
    recordTerminal(db, { ...key, operationId, outcome: "failed" });
    expect(readProvenGraphHostTerminal(db, key, operationId)).toEqual({
      status: "failed", answerTurnId: null, output: null, outputSha256: null
    });
  });
});
