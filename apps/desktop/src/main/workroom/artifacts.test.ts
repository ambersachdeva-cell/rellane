/** TypeScript / vitest: review must attach to an exact saved output, never a chat. */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../book/schema.js";
import {
  appendTurn,
  closeCase,
  eraseCase,
  openCase,
  turnsFor
} from "../book/cases.js";
import { acceptArtifact, artifactVersions, saveArtifact } from "./artifacts.js";

let db: DatabaseSync;
let id: string;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  id = openCase(db, { title: "Campaign", question: "Prepare a launch note" });
});
afterEach(() => db.close());
const save = (
  body: string,
  baseVersionId: string | null = null,
  sourceTurnId: string | null = null
) => saveArtifact(db, { id, body, baseVersionId, sourceTurnId });

describe("a reviewed output", () => {
  it("keeps edits as new versions and requires fresh acceptance", () => {
    const source = appendTurn(db, id, {
      seat: "Local · test",
      kind: "verbatim",
      body: "Initial draft"
    });
    const first = save("Reviewed wording", null, source);
    const accepted = acceptArtifact(db, id, first.id);
    expect(accepted.acceptedAt).not.toBeNull();
    const second = save("Improved wording", first.id, source);
    expect(artifactVersions(db, id)).toEqual([second, accepted]);
    expect(second.acceptedAt).toBeNull();
    expect(() => acceptArtifact(db, id, first.id)).toThrow(
      "latest saved version"
    );
    expect(() => save("Stale overwrite", first.id)).toThrow("newer output");
    expect(artifactVersions(db, id)[1]?.body).toBe("Reviewed wording");
  });
  it("refuses a source or output belonging to another workroom", () => {
    const other = openCase(db, { title: "Other client", question: "Private" });
    const source = appendTurn(db, other, {
      seat: "Local · test",
      kind: "verbatim",
      body: "PRIVATE_CANARY"
    });
    expect(() => save("Draft", null, source)).toThrow("not in this workroom");
    const version = save("This client's work");
    expect(() => acceptArtifact(db, other, version.id)).toThrow(
      "latest saved version"
    );
    expect(artifactVersions(db, other)).toEqual([]);
  });
  it("does not accept a receipt as a source and validates content bounds", () => {
    const receipt = appendTurn(db, id, {
      seat: "workroom",
      kind: "receipt",
      body: "A status"
    });
    expect(() => save("Draft", null, receipt)).toThrow("source draft");
    expect(() => save("   ")).toThrow();
    expect(() => save("x".repeat(50_001))).toThrow();
    expect(artifactVersions(db, id)).toEqual([]);
  });
  it("keeps an accepted closed output readable and erases versions with its room", () => {
    const version = save("Final copy");
    acceptArtifact(db, id, version.id);
    closeCase(db, id, { closedAs: "settled", verdict: "Exported" });
    expect(() => save("An unwanted edit", version.id)).toThrow(
      "Open this workroom"
    );
    expect(artifactVersions(db, id)[0]?.body).toBe("Final copy");
    eraseCase(db, id);
    expect(artifactVersions(db, id)).toEqual([]);
  });
  it("records acceptance once and rolls it back if its receipt cannot persist", () => {
    const version = save("Ready for review");
    db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON case_turn BEGIN SELECT RAISE(ABORT, 'receipt refused'); END"
    );
    expect(() => acceptArtifact(db, id, version.id)).toThrow("receipt refused");
    expect(artifactVersions(db, id)[0]?.acceptedAt).toBeNull();
    db.exec("DROP TRIGGER reject_receipt");
    const accepted = acceptArtifact(db, id, version.id);
    const count = turnsFor(db, id).length;
    expect(acceptArtifact(db, id, version.id)).toEqual(accepted);
    expect(turnsFor(db, id)).toHaveLength(count);
  });
  it("rolls back a new version if its receipt cannot persist", () => {
    db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON case_turn BEGIN SELECT RAISE(ABORT, 'receipt refused'); END"
    );
    expect(() => save("Unrecorded work")).toThrow("receipt refused");
    expect(artifactVersions(db, id)).toEqual([]);
  });
});
