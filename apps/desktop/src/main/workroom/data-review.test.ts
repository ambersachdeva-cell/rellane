/** Real room stores prove that checked evidence cannot cross a source boundary. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaseDataQuery } from "@cadrane/contracts";
import { MIGRATIONS } from "../book/schema.js";
import { appendTurn, closeCase, eraseCase, openCase, turnsFor } from "../book/cases.js";
import { addDataSample, reviewData, saveDataReview } from "./data-review.js";
let db: DatabaseSync;
let id: string;
let query: CaseDataQuery;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  id = openCase(db, { title: "Data review", question: "Check the unpaid orders" });
  const sourceTurnId = addDataSample(db, id);
  query = { id, sourceTurnId, operation: "total", valueColumn: 3, groupColumn: 0, unit: "INR", filter: { column: 2, equals: "Awaiting payment" } };
});
afterEach(() => db.close());
describe("room-scoped data evidence", () => {
  it("calculates the known sample amounts and includes honest coverage and source identity", () => {
    const before = turnsFor(db, id);
    const result = reviewData(db, query);
    expect(result.total).toBe("5000.00");
    expect(result.matchedRows).toBe(4);
    expect(result.blankValues).toBe(1);
    expect(result.groups[0]?.rowNumbers).toEqual([1, 2]);
    expect(result.evidence).toContain(query.sourceTurnId);
    expect(result.evidence).toContain('"blankValuesExcludedFromTotal": 1');
    expect(result.evidence).toContain("not a live connection or audited ledger");
    expect(turnsFor(db, id)).toEqual(before);
  });
  it("saves recomputed evidence atomically and refuses a repeated save identity", () => {
    const input = { query, operationId: randomUUID() };
    const source = saveDataReview(db, input);
    const turns = turnsFor(db, id);
    expect(turns.find(turn => turn.id === source)?.body).toBe(reviewData(db, query).evidence);
    expect(turns.at(-1)?.body).toContain(input.operationId);
    expect(() => saveDataReview(db, input)).toThrow("already saved");
    expect(turnsFor(db, id)).toEqual(turns);
  });
  it("does not accept a source from another room or a model answer posing as CSV", () => {
    const other = openCase(db, { title: "Other client", question: "Different records" });
    expect(() => reviewData(db, { ...query, id: other })).toThrow("CSV source saved in this workroom");
    const answer = appendTurn(db, id, { seat: "Local", kind: "verbatim", body: "A,B\n1,2" });
    expect(() => reviewData(db, { ...query, sourceTurnId: answer })).toThrow("CSV source saved in this workroom");
  });
  it("refuses closed-room saves and erased-room reads without changing history", () => {
    closeCase(db, id, { closedAs: "settled", verdict: "Reviewed" });
    const before = turnsFor(db, id);
    expect(() => saveDataReview(db, { query, operationId: randomUUID() })).toThrow("Open this workroom");
    expect(() => addDataSample(db, id)).toThrow("Open this workroom");
    expect(turnsFor(db, id)).toEqual(before);
    eraseCase(db, id);
    expect(() => reviewData(db, query)).toThrow("no longer available");
  });
  it("rolls back the source if its receipt cannot be saved", () => {
    const before = turnsFor(db, id);
    db.exec("CREATE TRIGGER refuse_review BEFORE INSERT ON case_turn WHEN NEW.kind='receipt' BEGIN SELECT RAISE(ABORT, 'receipt refused'); END");
    expect(() => saveDataReview(db, { query, operationId: randomUUID() })).toThrow("receipt refused");
    expect(turnsFor(db, id)).toEqual(before);
  });
  it("rejects an executable or out-of-range query at the input boundary", () => {
    expect(() => reviewData(db, { ...query, sql: "DELETE FROM case_turn" } as CaseDataQuery)).toThrow();
    expect(() => reviewData(db, { ...query, valueColumn: 32 })).toThrow();
    expect(turnsFor(db, id)).toHaveLength(2);
  });
});
