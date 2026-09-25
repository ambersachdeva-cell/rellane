/** TypeScript / vitest: review must attach to an exact saved output, never a chat. */
import { createHash } from "node:crypto";
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
import {
  acceptArtifact,
  artifactLineage,
  artifactVersions,
  saveArtifact
} from "./artifacts.js";

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
  it("preserves exact Markdown bytes through save and read", () => {
    const markdown = "  indented first line\n\n# Heading\nBody with trailing spaces  \n";
    const saved = save(markdown);
    expect(saved.body).toBe(markdown);
    expect(artifactVersions(db, id)[0]?.body).toBe(markdown);
  });
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

describe("artifact lineage", () => {
  it("projects deterministic linear lineage across multiple edits and acceptance", () => {
    const v1 = save("Draft version 1");
    acceptArtifact(db, id, v1.id);
    const v2 = save("Draft version 2 with improvements", v1.id);
    const v3 = save("Draft version 3 final polish", v2.id);
    acceptArtifact(db, id, v3.id);

    const lineage = artifactLineage(db, id);
    expect(lineage).toHaveLength(3);

    const l3 = lineage[0]!;
    const l2 = lineage[1]!;
    const l1 = lineage[2]!;
    expect(l3.revision).toBe(3);
    expect(l3.versionId).toBe(v3.id);
    expect(l3.id).toBe(v3.id);
    expect(l3.previousVersionId).toBe(v2.id);
    expect(l3.acceptedAt).not.toBeNull();
    expect(l3.status).toBe("verified");
    expect(l3.reason).toBeNull();

    expect(l2.revision).toBe(2);
    expect(l2.versionId).toBe(v2.id);
    expect(l2.id).toBe(v2.id);
    expect(l2.previousVersionId).toBe(v1.id);
    expect(l2.acceptedAt).toBeNull();
    expect(l2.status).toBe("verified");
    expect(l2.reason).toBeNull();

    expect(l1.revision).toBe(1);
    expect(l1.versionId).toBe(v1.id);
    expect(l1.id).toBe(v1.id);
    expect(l1.previousVersionId).toBeNull();
    expect(l1.acceptedAt).not.toBeNull();
    expect(l1.status).toBe("verified");
    expect(l1.reason).toBeNull();
  });

  it("verifies source linkage when source turn exists in same workroom and distinguishes human-authored", () => {
    const sourceId = appendTurn(db, id, {
      seat: "Local · researcher",
      kind: "verbatim",
      body: "Verbatim research draft"
    });
    const v1 = save("Output linked to draft", null, sourceId);
    const v2 = save("Output without source draft", v1.id, null);

    const lineage = artifactLineage(db, id);
    expect(lineage).toHaveLength(2);

    const l2 = lineage[0]!;
    const l1 = lineage[1]!;

    expect(l1.sourceTurnId).toBe(sourceId);
    expect(l1.sourceSeat).toBe("Local · researcher");
    expect(l1.sourceKind).toBe("verbatim");
    expect(l1.source).toEqual({
      id: sourceId,
      seat: "Local · researcher",
      kind: "verbatim"
    });
    expect(l1.status).toBe("verified");
    expect(l1.reason).toBeNull();

    expect(l2.sourceTurnId).toBeNull();
    expect(l2.sourceSeat).toBeNull();
    expect(l2.sourceKind).toBeNull();
    expect(l2.source).toBeNull();
    expect(l2.status).toBe("verified");
    expect(l2.reason).toBeNull();
  });

  it("detects missing source draft and revision gap as unverified without recasting as human-authored", () => {
    const v1 = save("Base version 1");

    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("corrupt-source-v", id, 2, "ghost-turn-999", "Corrupt source body", Date.now(), null);

    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("gapped-v4", id, 4, null, "Gapped body at revision 4", Date.now(), null);
    db.exec("PRAGMA foreign_keys = ON");

    const lineage = artifactLineage(db, id);
    expect(lineage).toHaveLength(3);

    const l4 = lineage[0]!;
    const l2 = lineage[1]!;
    const l1 = lineage[2]!;

    expect(l4.revision).toBe(4);
    expect(l4.previousVersionId).toBeNull();
    expect(l4.sourceTurnId).toBeNull();
    expect(l4.source).toBeNull();
    expect(l4.status).toBe("unverified");
    expect(l4.reason).toContain("Missing predecessor revision 3");

    expect(l2.revision).toBe(2);
    expect(l2.previousVersionId).toBe(v1.id);
    expect(l2.sourceTurnId).toBe("ghost-turn-999");
    expect(l2.sourceSeat).toBeNull();
    expect(l2.sourceKind).toBeNull();
    expect(l2.source).toBeNull();
    expect(l2.status).toBe("unverified");
    expect(l2.reason).toContain("ghost-turn-999");
    expect(l2.reason).toContain("not found in this workroom");

    expect(l1.revision).toBe(1);
    expect(l1.sourceTurnId).toBeNull();
    expect(l1.source).toBeNull();
    expect(l1.status).toBe("verified");
    expect(l1.reason).toBeNull();
  });

  it("enforces cross-case isolation and reports cross-case source as unverified", () => {
    const otherCaseId = openCase(db, {
      title: "Isolated Client",
      question: "Confidential inquiry"
    });
    const foreignTurnId = appendTurn(db, otherCaseId, {
      seat: "Secret · seat",
      kind: "verbatim",
      body: "SECRET_CROSS_CASE_PAYLOAD"
    });

    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("cross-case-v", id, 1, foreignTurnId, "Infiltrated artifact", Date.now(), null);

    const lineage = artifactLineage(db, id);
    expect(lineage).toHaveLength(1);
    const entry = lineage[0]!;

    expect(entry.status).toBe("unverified");
    expect(entry.sourceTurnId).toBe(foreignTurnId);
    expect(entry.sourceSeat).toBeNull();
    expect(entry.sourceKind).toBeNull();
    expect(entry.source).toBeNull();
    expect(entry.reason).toContain(foreignTurnId);
    expect(entry.reason).toContain("not found in this workroom");

    expect(artifactLineage(db, otherCaseId)).toEqual([]);
  });

  it("produces deterministic SHA-256 hashes of exact stored bodies", () => {
    const content = "# Exact Document\nLine with trailing whitespace   \n\tTab indented\n";
    const expectedSha256 = createHash("sha256").update(content).digest("hex");

    save(content);
    const lineage1 = artifactLineage(db, id);
    const lineage2 = artifactLineage(db, id);

    expect(lineage1[0]?.sha256).toBe(expectedSha256);
    expect(lineage2[0]?.sha256).toBe(expectedSha256);
    expect(lineage1[0]?.sha256).toBe(lineage2[0]?.sha256);
  });

  it("performs read-only inspection without modifying state and allows reading closed cases", () => {
    const v1 = save("First version");
    acceptArtifact(db, id, v1.id);
    const v2 = save("Second version", v1.id);

    const turnsBefore = turnsFor(db, id);
    const versionsBefore = artifactVersions(db, id);

    const openLineage = artifactLineage(db, id);
    expect(openLineage).toHaveLength(2);

    expect(turnsFor(db, id)).toEqual(turnsBefore);
    expect(artifactVersions(db, id)).toEqual(versionsBefore);

    closeCase(db, id, { closedAs: "settled", verdict: "Accepted" });

    const closedLineage = artifactLineage(db, id);
    expect(closedLineage).toEqual(openLineage);

    expect(() => save("Third version", v2.id)).toThrow("Open this workroom");
    expect(() => acceptArtifact(db, id, v2.id)).toThrow("Open this workroom");
  });

  it("retains invalid stored sourceTurnId while distinguishing true human-authored null", () => {
    const v1 = save("Human-authored base revision", null, null);

    const receiptTurnId = appendTurn(db, id, {
      seat: "workroom",
      kind: "receipt",
      body: "System status receipt"
    });
    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("non-verbatim-source-v2", id, 2, receiptTurnId, "Derived from receipt", Date.now(), null);

    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("ghost-source-v3", id, 3, "ghost-turn-404", "Derived from missing turn", Date.now(), null);
    db.exec("PRAGMA foreign_keys = ON");

    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("human-authored-v4", id, 4, null, "Human authored follow-up", Date.now(), null);

    const lineage = artifactLineage(db, id);
    expect(lineage).toHaveLength(4);

    const l4 = lineage[0]!;
    const l3 = lineage[1]!;
    const l2 = lineage[2]!;
    const l1 = lineage[3]!;

    expect(l4.revision).toBe(4);
    expect(l4.sourceTurnId).toBeNull();
    expect(l4.sourceSeat).toBeNull();
    expect(l4.sourceKind).toBeNull();
    expect(l4.source).toBeNull();
    expect(l4.status).toBe("verified");
    expect(l4.reason).toBeNull();

    expect(l3.revision).toBe(3);
    expect(l3.sourceTurnId).toBe("ghost-turn-404");
    expect(l3.sourceSeat).toBeNull();
    expect(l3.sourceKind).toBeNull();
    expect(l3.source).toBeNull();
    expect(l3.status).toBe("unverified");
    expect(l3.reason).toContain("ghost-turn-404");
    expect(l3.reason).toContain("not found in this workroom");

    expect(l2.revision).toBe(2);
    expect(l2.sourceTurnId).toBe(receiptTurnId);
    expect(l2.sourceSeat).toBeNull();
    expect(l2.sourceKind).toBeNull();
    expect(l2.source).toBeNull();
    expect(l2.status).toBe("unverified");
    expect(l2.reason).toContain(receiptTurnId);
    expect(l2.reason).toContain("is not verbatim in this workroom");

    expect(l1.revision).toBe(1);
    expect(l1.sourceTurnId).toBeNull();
    expect(l1.sourceSeat).toBeNull();
    expect(l1.sourceKind).toBeNull();
    expect(l1.source).toBeNull();
    expect(l1.status).toBe("verified");
    expect(l1.reason).toBeNull();
  });
});
