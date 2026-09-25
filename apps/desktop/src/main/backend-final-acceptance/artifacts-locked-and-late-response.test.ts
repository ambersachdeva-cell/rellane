import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../book/schema.js";
import {
  saveArtifact,
  acceptArtifact,
  artifactVersions,
  artifactLineage
} from "../workroom/artifacts.js";

function setupTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

const CASE_1 = "11111111-1111-4111-8111-111111111101";
const CASE_2 = "11111111-1111-4111-8111-111111111102";
const CASE_3 = "11111111-1111-4111-8111-111111111103";
const CASE_4 = "11111111-1111-4111-8111-111111111104";
const TURN_DRAFT_1 = "22222222-2222-4222-8222-222222222201";
const TURN_RECEIPT_1 = "22222222-2222-4222-8222-222222222202";
const TURN_NON_EXISTENT = "22222222-2222-4222-8222-222222222299";
const ORPHAN_V4 = "33333333-3333-4333-8333-333333333304";

function seedWorkCase(db: DatabaseSync, caseId: string = CASE_1): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO work_case (id, title, question, opened_at) VALUES (?, ?, ?, ?)"
  ).run(caseId, "Artifact Workroom", "Question", now);

  // Seed verbatim turn
  db.prepare(
    "INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?, ?, 1, 'claude', 'verbatim', 'Draft prose proposal', ?)"
  ).run(TURN_DRAFT_1, caseId, now);

  // Seed non-verbatim receipt turn
  db.prepare(
    "INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?, ?, 2, 'workstation', 'receipt', 'Execution completed', ?)"
  ).run(TURN_RECEIPT_1, caseId, now);
}

describe("Backend Final Acceptance - Artifact Revision, Lineage, and Late Response Safety (G05 / R10)", () => {
  it("enforces append-only versioning, baseVersionId validation, and protects human edits from late responses", () => {
    const db = setupTestDatabase();
    seedWorkCase(db, CASE_1);

    // 1. Save version 1 (initial output from draft)
    const v1 = saveArtifact(db, {
      id: CASE_1,
      body: "# Initial Specification\n\nSection 1: Requirements.",
      baseVersionId: null,
      sourceTurnId: TURN_DRAFT_1
    });

    expect(v1.revision).toBe(1);
    expect(v1.sourceTurnId).toBe(TURN_DRAFT_1);
    expect(v1.acceptedAt).toBeNull();

    // 2. Human editor modifies and saves version 2
    const v2 = saveArtifact(db, {
      id: CASE_1,
      body: "# Initial Specification\n\nSection 1: Requirements (Owner edited with stricter bounds).",
      baseVersionId: v1.id,
      sourceTurnId: null
    });

    expect(v2.revision).toBe(2);

    // 3. ADVERSARIAL LATE RESPONSE:
    // A background or late model process, unaware of the human's v2 edit, tries to save
    // with baseVersionId pointing to v1.
    // It MUST be rejected with a strict error, preserving the human's v2 changes intact.
    expect(() =>
      saveArtifact(db, {
        id: CASE_1,
        body: "# Initial Specification\n\nSection 1: Model generated alternative that arrived late.",
        baseVersionId: v1.id, // Stale base!
        sourceTurnId: TURN_DRAFT_1
      })
    ).toThrow("A newer output version exists. Reload it before saving your changes.");

    // Verify current latest version remains untouched as v2
    const currentVersions = artifactVersions(db, CASE_1);
    expect(currentVersions.length).toBe(2);
    expect(currentVersions[0]?.id).toBe(v2.id);
    expect(currentVersions[0]?.body).toContain("Owner edited");
  });

  it("strictly validates source turn lineage, rejecting non-verbatim or foreign turn IDs", () => {
    const db = setupTestDatabase();
    seedWorkCase(db, CASE_2);

    // Attempting to save an artifact citing a receipt turn (non-verbatim) must be refused
    expect(() =>
      saveArtifact(db, {
        id: CASE_2,
        body: "Content derived from receipt",
        baseVersionId: null,
        sourceTurnId: TURN_RECEIPT_1 // receipt kind, not verbatim!
      })
    ).toThrow("The source draft is not in this workroom.");

    // Attempting to cite a turn ID from another case or non-existent
    expect(() =>
      saveArtifact(db, {
        id: CASE_2,
        body: "Content derived from ghost turn",
        baseVersionId: null,
        sourceTurnId: TURN_NON_EXISTENT
      })
    ).toThrow("The source draft is not in this workroom.");
  });

  it("handles acceptance lifecycle: only latest version can be accepted, and acceptance is idempotent", () => {
    const db = setupTestDatabase();
    seedWorkCase(db, CASE_3);

    const v1 = saveArtifact(db, {
      id: CASE_3,
      body: "Version 1 draft",
      baseVersionId: null,
      sourceTurnId: TURN_DRAFT_1
    });

    const v2 = saveArtifact(db, {
      id: CASE_3,
      body: "Version 2 final draft",
      baseVersionId: v1.id,
      sourceTurnId: null
    });

    // 1. Attempting to accept older version v1 when v2 exists must be refused
    expect(() => acceptArtifact(db, CASE_3, v1.id)).toThrow(
      "Only the latest saved version in this workroom can be accepted. Reload the output."
    );

    // 2. Accept latest version v2
    const acceptedV2 = acceptArtifact(db, CASE_3, v2.id);
    expect(acceptedV2.acceptedAt).not.toBeNull();
    const firstAcceptedAt = acceptedV2.acceptedAt;

    // 3. Idempotent acceptance: re-accepting does not alter acceptedAt timestamp
    const reacceptedV2 = acceptArtifact(db, CASE_3, v2.id);
    expect(reacceptedV2.acceptedAt).toBe(firstAcceptedAt);
  });

  it("verifies artifactLineage integrity, calculating SHA-256 hashes and detecting broken lineage", () => {
    const db = setupTestDatabase();
    seedWorkCase(db, CASE_4);

    const v1 = saveArtifact(db, {
      id: CASE_4,
      body: "Module Spec v1",
      baseVersionId: null,
      sourceTurnId: TURN_DRAFT_1
    });

    const v2 = saveArtifact(db, {
      id: CASE_4,
      body: "Module Spec v2",
      baseVersionId: v1.id,
      sourceTurnId: null
    });

    const lineage = artifactLineage(db, CASE_4);
    expect(lineage.length).toBe(2);

    const l2 = lineage.find((l) => l.versionId === v2.id)!;
    const l1 = lineage.find((l) => l.versionId === v1.id)!;

    expect(l2.previousVersionId).toBe(v1.id);
    expect(l2.status).toBe("verified");
    expect(l2.sha256).toBeDefined();

    expect(l1.previousVersionId).toBeNull();
    expect(l1.status).toBe("verified");
    expect(l1.sourceSeat).toBe("claude");
    expect(l1.sourceKind).toBe("verbatim");

    // Manually break lineage by inserting an orphaned revision 4 without revision 3
    db.prepare(
      `INSERT INTO case_artifact_version (id, case_id, revision, source_turn_id, body, created_at)
       VALUES (?, ?, 4, NULL, 'Orphaned revision', ?)`
    ).run(ORPHAN_V4, CASE_4, Date.now());

    const brokenLineage = artifactLineage(db, CASE_4);
    const l4 = brokenLineage.find((l) => l.versionId === ORPHAN_V4)!;
    expect(l4.status).toBe("unverified");
    expect(l4.reason).toContain("Missing predecessor revision 3");
  });
});
