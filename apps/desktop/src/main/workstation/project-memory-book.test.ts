/**
 * Tests for canonical project memory persistence in Book SQLite.
 *
 * Verifies:
 * 1. Old V9 project data survives V10 and can still be read.
 * 2. Approved record persistence across database close and reopen.
 * 3. Proposals are not treated as normative constraints.
 * 4. Exact verbatim body preservation (whitespace and newlines).
 * 5. Prior active revision survives candidate proposals and rejections.
 * 6. Findings are excluded from normative constraints.
 * 7. Rejection of cross-project, stale source-hash, and unknown projects.
 * 8. CAS mismatch aborts transaction and preserves epoch stability.
 * 9. Constraints byte budget enforcement via the context compiler.
 * 10. Forgetting redacts all revision bodies and invalidates active selection.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendTurn, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { buildWorkstationContext } from "./context.js";
import { assignWorkstationProject, saveWorkstationProject } from "./projects.js";
import {
  approvedProjectConstraints,
  approvedProjectFindings,
  forgetProjectMemory,
  listProjectMemory,
  projectMemoryEpoch,
  proposeProjectMemory,
  reviewProjectMemory
} from "./project-memory-book.js";
import { declareProjectMemoryConflict } from "./project-memory-conflict-store.js";

function createTestBook(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

describe("Canonical Project Memory in Book SQLite", () => {
  it("1. old V9 project data survives V10 and can still be read", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 9)) {
      db.exec(migration.sql);
    }

    const proj = saveWorkstationProject(db, {
      title: "V9 Legacy Project",
      brief: "Legacy brief content before V10 migration"
    });

    for (const migration of MIGRATIONS.slice(9)) db.exec(migration.sql);

    const epoch = projectMemoryEpoch(db, proj.id);
    expect(epoch).toBe(0);

    const constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toEqual([]);

    const memoryList = listProjectMemory(db, proj.id);
    expect(memoryList).toEqual([]);
  });

  it("2. DB close/reopen approved record persistence", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cadrane-memory-test-"));
    const dbPath = join(tempDir, "book.db");

    try {
      const db1 = new DatabaseSync(dbPath);
      db1.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) {
        db1.exec(migration.sql);
      }

      const proj = saveWorkstationProject(db1, {
        title: "Persistence Project",
        brief: "Testing SQLite file persistence"
      });

      const proposal = proposeProjectMemory(db1, {
        projectId: proj.id,
        kind: "instruction",
        text: "Always require PAN for bills over 200k",
        actorId: "owner-1"
      });

      reviewProjectMemory(db1, {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: proposal.revision,
        decision: "approve",
        actorId: "reviewer-1"
      });

      expect(projectMemoryEpoch(db1, proj.id)).toBe(2);
      db1.close();

      const db2 = new DatabaseSync(dbPath);
      db2.exec("PRAGMA foreign_keys = ON");

      expect(projectMemoryEpoch(db2, proj.id)).toBe(2);

      const constraints = approvedProjectConstraints(db2, proj.id);
      expect(constraints).toHaveLength(1);
      expect(constraints[0]).toMatchObject({
        id: proposal.id,
        revision: 2,
        kind: "instruction",
        text: "Always require PAN for bills over 200k",
        approvedBy: "reviewer-1"
      });
      expect(typeof constraints[0]!.approvedAt).toBe("string");
      expect(new Date(constraints[0]!.approvedAt).toString()).not.toBe("Invalid Date");

      db2.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("3. proposals not constraints", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, {
      title: "Pending Proposal Project",
      brief: "Brief"
    });

    const proposal = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "decision",
      text: "Switch accounting year to April-March",
      actorId: "advisor"
    });

    const constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toEqual([]);

    const list = listProjectMemory(db, proj.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.active).toBeNull();
    expect(list[0]!.candidate).toMatchObject({
      revision: 1,
      state: "proposed",
      text: "Switch accounting year to April-March",
      createdBy: "advisor"
    });
    expect(list[0]!.headRevision).toBe(1);
    expect(list[0]!.activeRevision).toBeNull();
  });

  it("does not invent an approver or approval time for a damaged approved row", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Approval receipt", brief: "Brief" });
    const proposal = proposeProjectMemory(db, {
      projectId: proj.id, kind: "instruction", text: "Keep this rule", actorId: "owner"
    });
    const approved = reviewProjectMemory(db, {
      projectId: proj.id, id: proposal.id, expectedRevision: proposal.revision,
      decision: "approve", actorId: "reviewer"
    });
    db.prepare(
      "UPDATE workstation_project_memory_revision SET approver_id = NULL WHERE entry_id = ? AND revision = ?"
    ).run(proposal.id, approved.revision);
    expect(() => approvedProjectConstraints(db, proj.id)).toThrow(/no approval receipt/u);
  });

  it("4. exact approved body with whitespace and newlines preserved", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Verbatim Project", brief: "Brief" });

    const verbatimText = "\n  Section 1: Indented rule.\n\n  Section 2: With trailing spaces.  \n";
    const proposal = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "exclusion",
      text: verbatimText,
      actorId: "architect"
    });

    reviewProjectMemory(db, {
      projectId: proj.id,
      id: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approve",
      actorId: "lead"
    });

    const constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.text).toBe(verbatimText);

    const list = listProjectMemory(db, proj.id);
    expect(list[0]!.active?.text).toBe(verbatimText);
  });

  it("5. prior active survives candidate and rejection", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "CAS Stability Project", brief: "Brief" });

    const rev1 = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "instruction",
      text: "Original constraint version 1",
      actorId: "owner"
    });

    reviewProjectMemory(db, {
      projectId: proj.id,
      id: rev1.id,
      expectedRevision: rev1.revision,
      decision: "approve",
      actorId: "approver"
    });

    let constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.text).toBe("Original constraint version 1");
    expect(constraints[0]!.revision).toBe(2);

    const rev3 = proposeProjectMemory(db, {
      projectId: proj.id,
      id: rev1.id,
      expectedRevision: 2,
      kind: "instruction",
      text: "Candidate constraint update version 2",
      actorId: "contributor"
    });

    constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.text).toBe("Original constraint version 1");
    expect(constraints[0]!.revision).toBe(2);

    let list = listProjectMemory(db, proj.id);
    expect(list[0]!.active?.text).toBe("Original constraint version 1");
    expect(list[0]!.candidate?.text).toBe("Candidate constraint update version 2");

    reviewProjectMemory(db, {
      projectId: proj.id,
      id: rev1.id,
      expectedRevision: rev3.revision,
      decision: "reject",
      actorId: "approver",
      reason: "Not aligned with Q3 roadmap"
    });

    constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.text).toBe("Original constraint version 1");
    expect(constraints[0]!.revision).toBe(2);

    list = listProjectMemory(db, proj.id);
    expect(list[0]!.active?.text).toBe("Original constraint version 1");
    expect(list[0]!.candidate).toBeNull();
    expect(list[0]!.headRevision).toBe(4);
    expect(list[0]!.activeRevision).toBe(2);
  });

  it("6. findings excluded from normative constraints", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Findings Project", brief: "Brief" });

    const proposal = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "finding",
      text: "Found three duplicate vendors in Q2 receivables audit",
      actorId: "auditor"
    });

    reviewProjectMemory(db, {
      projectId: proj.id,
      id: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approve",
      actorId: "lead"
    });

    const list = listProjectMemory(db, proj.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe("finding");
    expect(list[0]!.active?.state).toBe("approved");

    const constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toEqual([]);
  });

  it("7. cross-project / source-hash / unknown project rejection", () => {
    const db = createTestBook();
    const projA = saveWorkstationProject(db, { title: "Project A", brief: "Brief A" });
    const projB = saveWorkstationProject(db, { title: "Project B", brief: "Brief B" });

    expect(() => projectMemoryEpoch(db, "unknown-proj")).toThrow(/does not exist/);
    expect(() => approvedProjectConstraints(db, "unknown-proj")).toThrow(/does not exist/);
    expect(() =>
      proposeProjectMemory(db, {
        projectId: "unknown-proj",
        kind: "instruction",
        text: "Some text",
        actorId: "user"
      })
    ).toThrow(/does not exist/);

    const caseA = openCase(db, { title: "Case A", question: "Question A" });
    assignWorkstationProject(db, { caseId: caseA, projectId: projA.id });
    const turnText = "Verified ledger export turn content";
    const turnId = appendTurn(db, caseA, {
      seat: "owner",
      kind: "verbatim",
      body: turnText
    });
    const validSha256 = createHash("sha256").update(turnText, "utf8").digest("hex");

    expect(() =>
      proposeProjectMemory(db, {
        projectId: projB.id,
        kind: "decision",
        text: "Project B cannot cite Project A case",
        sourceRefs: [{ caseId: caseA, turnId, sha256: validSha256 }],
        actorId: "owner"
      })
    ).toThrow(/not linked to project/);

    expect(() =>
      proposeProjectMemory(db, {
        projectId: projA.id,
        kind: "decision",
        text: "Wrong hash test",
        sourceRefs: [{ caseId: caseA, turnId, sha256: "0".repeat(64) }],
        actorId: "owner"
      })
    ).toThrow(/sha256 mismatch/);

    expect(() =>
      proposeProjectMemory(db, {
        projectId: projA.id,
        kind: "decision",
        text: "Missing turn test",
        sourceRefs: [{ caseId: caseA, turnId: "non-existent-turn", sha256: validSha256 }],
        actorId: "owner"
      })
    ).toThrow(/does not belong to case/);

    const validProposal = proposeProjectMemory(db, {
      projectId: projA.id,
      kind: "decision",
      text: "Legitimate referenced decision",
      sourceRefs: [{ caseId: caseA, turnId, sha256: validSha256 }],
      actorId: "owner"
    });
    expect(validProposal.revision).toBe(1);

    const epochBeforeReview = projectMemoryEpoch(db, projA.id);
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run("Source changed after proposal", turnId);
    expect(() => reviewProjectMemory(db, {
      projectId: projA.id,
      id: validProposal.id,
      expectedRevision: validProposal.revision,
      decision: "approve",
      actorId: "reviewer"
    })).toThrow(/sha256 mismatch/);
    expect(projectMemoryEpoch(db, projA.id)).toBe(epochBeforeReview);
    expect(approvedProjectConstraints(db, projA.id)).toEqual([]);

    // A reviewer can still reject the stale proposal without trusting its source.
    expect(reviewProjectMemory(db, {
      projectId: projA.id,
      id: validProposal.id,
      expectedRevision: validProposal.revision,
      decision: "reject",
      actorId: "reviewer"
    }).state).toBe("rejected");
  });

  it("8. CAS rollback and epoch stability", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "CAS Rollback Project", brief: "Brief" });

    const proposal = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "instruction",
      text: "Rule 1",
      actorId: "owner"
    });
    expect(projectMemoryEpoch(db, proj.id)).toBe(1);

    expect(() =>
      proposeProjectMemory(db, {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: 99,
        kind: "instruction",
        text: "Rule 2 with stale revision",
        actorId: "owner"
      })
    ).toThrow(/Stale memory revision/);
    expect(projectMemoryEpoch(db, proj.id)).toBe(1);

    expect(() =>
      reviewProjectMemory(db, {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: 99,
        decision: "approve",
        actorId: "owner"
      })
    ).toThrow(/Stale memory revision/);
    expect(projectMemoryEpoch(db, proj.id)).toBe(1);

    const revisions = db
      .prepare(
        `SELECT COUNT(*) AS c FROM workstation_project_memory_revision WHERE entry_id = ?`
      )
      .get(proposal.id) as { c: number };
    expect(Number(revisions.c)).toBe(1);
  });

  it("9. constraints byte budget via existing compiler", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Compiler Project", brief: "Brief" });

    const proposal = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "instruction",
      text: "Strict ledger policy: no negative balances permitted without owner override.",
      actorId: "owner"
    });
    reviewProjectMemory(db, {
      projectId: proj.id,
      id: proposal.id,
      expectedRevision: proposal.revision,
      decision: "approve",
      actorId: "owner"
    });

    const constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toHaveLength(1);

    const validContext = buildWorkstationContext({
      prompt: "Check ledger health",
      sources: [],
      acceptedConstraints: constraints,
      maxChars: 50_000
    });
    expect(validContext.constraintIds).toEqual([proposal.id]);
    expect(validContext.packet).toContain("governed_context");
    expect(validContext.packet).toContain(proposal.id);

    expect(() =>
      buildWorkstationContext({
        prompt: "Check ledger health",
        sources: [],
        acceptedConstraints: constraints,
        maxChars: 120
      })
    ).toThrow(/Insufficient maxChars budget/);
  });

  it("10. forgetting redacts all memory revisions and invalidates active selection", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Right to Forget Project", brief: "Brief" });

    const rev1 = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "decision",
      text: "Sensory data retention policy v1",
      actorId: "legal"
    });
    reviewProjectMemory(db, {
      projectId: proj.id,
      id: rev1.id,
      expectedRevision: 1,
      decision: "approve",
      actorId: "dpo",
      reason: "Sensitive context from the owner's request"
    });
    proposeProjectMemory(db, {
      projectId: proj.id,
      id: rev1.id,
      expectedRevision: 2,
      kind: "decision",
      text: "Sensory data retention policy v2 proposed update",
      actorId: "legal"
    });

    const epochBefore = projectMemoryEpoch(db, proj.id);
    expect(epochBefore).toBe(3);

    const forgetResult = forgetProjectMemory(db, {
      projectId: proj.id,
      id: rev1.id,
      expectedRevision: 3,
      actorId: "dpo",
      reason: "GDPR / DPDP Article 10.3 erasure request"
    });

    expect(forgetResult.state).toBe("forgotten");
    expect(forgetResult.activeRevision).toBeNull();
    expect(projectMemoryEpoch(db, proj.id)).toBe(4);

    const constraints = approvedProjectConstraints(db, proj.id);
    expect(constraints).toEqual([]);

    const list = listProjectMemory(db, proj.id);
    expect(list).toEqual([]);

    const revisionRows = db
      .prepare(
        `SELECT revision, state, body, source_refs_json AS sourceRefsJson, reason
         FROM workstation_project_memory_revision
         WHERE entry_id = ?
         ORDER BY revision ASC`
      )
      .all(rev1.id) as unknown as readonly {
        revision: number;
        state: string;
        body: string;
        sourceRefsJson: string;
        reason: string | null;
      }[];

    expect(revisionRows).toHaveLength(4);
    for (const row of revisionRows) {
      expect(row.body).toBe("");
      expect(row.sourceRefsJson).toBe("[]");
    }
    expect(revisionRows.slice(0, -1).map((row) => row.reason)).toEqual([null, null, null]);
    expect(revisionRows[3]!.state).toBe("forgotten");
    expect(revisionRows[3]!.reason).toBe("GDPR / DPDP Article 10.3 erasure request");

    expect(() =>
      proposeProjectMemory(db, {
        projectId: proj.id,
        id: rev1.id,
        expectedRevision: 4,
        kind: "decision",
        text: "Attempt to revive forgotten entry",
        actorId: "user"
      })
    ).toThrow(/was forgotten and cannot be updated/);

    expect(() =>
      reviewProjectMemory(db, {
        projectId: proj.id,
        id: rev1.id,
        expectedRevision: 4,
        decision: "approve",
        actorId: "user"
      })
    ).toThrow(/was forgotten and cannot be reviewed/);
  });

  it("11. source ref retention when omitted vs explicit empty and stale ref refusal", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Source Ref Retention Project", brief: "Brief" });
    const caseId = openCase(db, { title: "Case 1", question: "Question 1" });
    assignWorkstationProject(db, { caseId, projectId: proj.id });

    const turn1Text = "Turn 1 factual text content";
    const turn1Id = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: turn1Text });
    const turn1Sha = createHash("sha256").update(turn1Text, "utf8").digest("hex");

    const entryWithoutRefs = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "decision",
      text: "Decision without refs",
      actorId: "author"
    });
    const rev1Row = db
      .prepare(`SELECT source_refs_json AS sourceRefsJson FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 1`)
      .get(entryWithoutRefs.id) as { sourceRefsJson: string };
    expect(JSON.parse(rev1Row.sourceRefsJson)).toEqual([]);

    const entryWithRefs = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "instruction",
      text: "Initial instruction citing turn 1",
      sourceRefs: [{ caseId, turnId: turn1Id, sha256: turn1Sha }],
      actorId: "author"
    });

    const rev2 = proposeProjectMemory(db, {
      projectId: proj.id,
      id: entryWithRefs.id,
      expectedRevision: 1,
      kind: "instruction",
      text: "Updated text without mentioning sourceRefs",
      actorId: "editor"
    });
    const rev2Row = db
      .prepare(`SELECT source_refs_json AS sourceRefsJson FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = ?`)
      .get(entryWithRefs.id, rev2.revision) as { sourceRefsJson: string };
    expect(JSON.parse(rev2Row.sourceRefsJson)).toEqual([{ caseId, turnId: turn1Id, sha256: turn1Sha }]);

    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run("Turn 1 modified content", turn1Id);

    expect(() =>
      proposeProjectMemory(db, {
        projectId: proj.id,
        id: entryWithRefs.id,
        expectedRevision: rev2.revision,
        kind: "instruction",
        text: "Another update with omitted refs should fail on stale ref",
        actorId: "editor"
      })
    ).toThrow(/sha256 mismatch/);

    const rev3 = proposeProjectMemory(db, {
      projectId: proj.id,
      id: entryWithRefs.id,
      expectedRevision: rev2.revision,
      kind: "instruction",
      text: "Explicitly detached evidence",
      sourceRefs: [],
      actorId: "editor"
    });
    const rev3Row = db
      .prepare(`SELECT source_refs_json AS sourceRefsJson FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = ?`)
      .get(entryWithRefs.id, rev3.revision) as { sourceRefsJson: string };
    expect(JSON.parse(rev3Row.sourceRefsJson)).toEqual([]);
  });

  it("12. review and forget revision provenance, timestamps, and approval metadata in SQL history", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "SQL History Provenance Project", brief: "Brief" });

    const t1 = 1000;
    const t2 = 2000;
    const t3 = 3000;
    const t4 = 4000;
    const t5 = 5000;

    const proposal = proposeProjectMemory(
      db,
      {
        projectId: proj.id,
        kind: "decision",
        text: "Provenance policy v1",
        actorId: "author-1"
      },
      t1
    );

    const rev1Row = db
      .prepare(
        `SELECT created_by AS createdBy, created_at AS createdAt, approver_id AS approverId, approved_at AS approvedAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 1`
      )
      .get(proposal.id) as { createdBy: string; createdAt: number; approverId: string | null; approvedAt: number | null };

    expect(rev1Row.createdBy).toBe("author-1");
    expect(rev1Row.createdAt).toBe(t1);
    expect(rev1Row.approverId).toBeNull();
    expect(rev1Row.approvedAt).toBeNull();

    const approved = reviewProjectMemory(
      db,
      {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: 1,
        decision: "approve",
        actorId: "reviewer-1"
      },
      t2
    );

    const rev2Row = db
      .prepare(
        `SELECT created_by AS createdBy, created_at AS createdAt, approver_id AS approverId, approved_at AS approvedAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 2`
      )
      .get(proposal.id) as { createdBy: string; createdAt: number; approverId: string | null; approvedAt: number | null };

    expect(rev2Row.createdBy).toBe("reviewer-1");
    expect(rev2Row.createdAt).toBe(t2);
    expect(rev2Row.approverId).toBe("reviewer-1");
    expect(rev2Row.approvedAt).toBe(t2);

    const rev1AfterApprove = db
      .prepare(
        `SELECT created_by AS createdBy, created_at AS createdAt, approver_id AS approverId, approved_at AS approvedAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 1`
      )
      .get(proposal.id) as { createdBy: string; createdAt: number; approverId: string | null; approvedAt: number | null };
    expect(rev1AfterApprove.createdBy).toBe("author-1");
    expect(rev1AfterApprove.createdAt).toBe(t1);

    proposeProjectMemory(
      db,
      {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: approved.revision,
        kind: "decision",
        text: "Provenance policy v2",
        actorId: "author-2"
      },
      t3
    );

    const rejected = reviewProjectMemory(
      db,
      {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: 3,
        decision: "reject",
        actorId: "reviewer-2",
        reason: "Does not meet standard"
      },
      t4
    );

    const rev4Row = db
      .prepare(
        `SELECT state, created_by AS createdBy, created_at AS createdAt, approver_id AS approverId, approved_at AS approvedAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 4`
      )
      .get(proposal.id) as { state: string; createdBy: string; createdAt: number; approverId: string | null; approvedAt: number | null };

    expect(rev4Row.state).toBe("rejected");
    expect(rev4Row.createdBy).toBe("reviewer-2");
    expect(rev4Row.createdAt).toBe(t4);
    expect(rev4Row.approverId).toBeNull();
    expect(rev4Row.approvedAt).toBeNull();

    forgetProjectMemory(
      db,
      {
        projectId: proj.id,
        id: proposal.id,
        expectedRevision: rejected.revision,
        actorId: "forget-admin",
        reason: "Erased per request"
      },
      t5
    );

    const rev5Row = db
      .prepare(
        `SELECT state, created_by AS createdBy, created_at AS createdAt, approver_id AS approverId, approved_at AS approvedAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 5`
      )
      .get(proposal.id) as { state: string; createdBy: string; createdAt: number; approverId: string | null; approvedAt: number | null };

    expect(rev5Row.state).toBe("forgotten");
    expect(rev5Row.createdBy).toBe("forget-admin");
    expect(rev5Row.createdAt).toBe(t5);
    expect(rev5Row.approverId).toBeNull();
    expect(rev5Row.approvedAt).toBeNull();

    const rev2AfterForget = db
      .prepare(
        `SELECT body, source_refs_json AS sourceRefsJson, created_by AS createdBy, created_at AS createdAt, approver_id AS approverId, approved_at AS approvedAt
         FROM workstation_project_memory_revision WHERE entry_id = ? AND revision = 2`
      )
      .get(proposal.id) as {
        body: string;
        sourceRefsJson: string;
        createdBy: string;
        createdAt: number;
        approverId: string | null;
        approvedAt: number | null;
      };

    expect(rev2AfterForget.body).toBe("");
    expect(rev2AfterForget.sourceRefsJson).toBe("[]");
    expect(rev2AfterForget.createdBy).toBe("reviewer-1");
    expect(rev2AfterForget.createdAt).toBe(t2);
    expect(rev2AfterForget.approverId).toBe("reviewer-1");
    expect(rev2AfterForget.approvedAt).toBe(t2);
  });

  it("13. listProjectMemory omits contentless rows when never-approved proposal is rejected while keeping history", () => {
    const db = createTestBook();
    const proj = saveWorkstationProject(db, { title: "Omit Rejected Project", brief: "Brief" });

    const proposal = proposeProjectMemory(db, {
      projectId: proj.id,
      kind: "decision",
      text: "Never approved candidate",
      actorId: "author"
    });

    const listBefore = listProjectMemory(db, proj.id);
    expect(listBefore).toHaveLength(1);
    expect(listBefore[0]!.candidate?.text).toBe("Never approved candidate");

    reviewProjectMemory(db, {
      projectId: proj.id,
      id: proposal.id,
      expectedRevision: proposal.revision,
      decision: "reject",
      actorId: "reviewer",
      reason: "Bad idea"
    });

    const listAfter = listProjectMemory(db, proj.id);
    expect(listAfter).toEqual([]);

    const entryInDb = db
      .prepare(`SELECT id, head_revision AS headRevision, active_revision AS activeRevision FROM workstation_project_memory_entry WHERE id = ?`)
      .get(proposal.id) as { id: string; headRevision: number; activeRevision: number | null };
    expect(entryInDb).toBeDefined();
    expect(entryInDb.headRevision).toBe(2);
    expect(entryInDb.activeRevision).toBeNull();

    const revisionsInDb = db
      .prepare(`SELECT revision, state FROM workstation_project_memory_revision WHERE entry_id = ? ORDER BY revision ASC`)
      .all(proposal.id) as unknown as readonly { revision: number; state: string }[];
    expect(revisionsInDb).toEqual([
      { revision: 1, state: "proposed" },
      { revision: 2, state: "rejected" }
    ]);
  });
});

describe("approved finding evidence", () => {
  it("does not inherit role tags from an unreviewed head proposal", () => {
    const db = createTestBook();
    const project = saveWorkstationProject(db, { title: "Draft audience", brief: "Brief" });
    const first = proposeProjectMemory(db, {
      projectId: project.id, kind: "finding", text: "Draft observation",
      roleTags: ["design"], actorId: "owner"
    });
    const second = proposeProjectMemory(db, {
      projectId: project.id, id: first.id, expectedRevision: first.revision,
      kind: "finding", text: "Replacement observation", actorId: "owner"
    });
    expect(listProjectMemory(db, project.id)[0]?.candidate?.roleTags).toEqual([]);
    const approved = reviewProjectMemory(db, {
      projectId: project.id, id: first.id, expectedRevision: second.revision,
      decision: "approve", actorId: "owner"
    });
    const third = proposeProjectMemory(db, {
      projectId: project.id, id: first.id, expectedRevision: approved.revision,
      kind: "finding", text: "Another draft", roleTags: ["finance"], actorId: "owner"
    });
    proposeProjectMemory(db, {
      projectId: project.id, id: first.id, expectedRevision: third.revision,
      kind: "finding", text: "Replacement without audience", actorId: "owner"
    });
    expect(listProjectMemory(db, project.id)[0]?.candidate?.roleTags).toEqual([]);
    expect(listProjectMemory(db, project.id)[0]?.active?.roleTags).toEqual([]);
    db.close();
  });

  it("migrates V13 findings as general evidence without changing their approval or epoch", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((one) => one.version <= 13)) db.exec(migration.sql);
    const project = saveWorkstationProject(db, { title: "Old finding", brief: "Brief" });
    const caseId = openCase(db, { title: "Source", question: "Question" });
    assignWorkstationProject(db, { caseId, projectId: project.id });
    const body = "Approved brand layout source.";
    const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body });
    const sha256 = createHash("sha256").update(body).digest("hex");
    db.prepare(`INSERT INTO workstation_project_memory_entry
      (id, project_id, kind, head_revision, active_revision, created_at)
      VALUES ('old-finding', ?, 'finding', 2, 2, 1)`).run(project.id);
    db.prepare(`INSERT INTO workstation_project_memory_revision
      (entry_id, revision, state, body, source_refs_json, created_by, created_at, approver_id, approved_at, reason)
      VALUES ('old-finding', 2, 'approved', 'Brand layout approved.', ?, 'owner', 2, 'owner', 2, NULL)`)
      .run(JSON.stringify([{ caseId, turnId, sha256 }]));
    const before = projectMemoryEpoch(db, project.id);
    db.exec(MIGRATIONS.find((one) => one.version === 14)!.sql);
    expect(projectMemoryEpoch(db, project.id)).toBe(before);
    expect(approvedProjectFindings(db, project.id)).toMatchObject([{
      id: "old-finding", revision: 2, roleTags: [], provenance: "verified"
    }]);
    const context = buildWorkstationContext({
      prompt: "Review brand layout", sources: [], taskRole: "design",
      approvedFindings: approvedProjectFindings(db, project.id)
    });
    expect(context.findingDecisions).toEqual([{
      id: "old-finding", revision: 2, included: true,
      reason: "relevant_general_approved_finding"
    }]);
    db.close();
  });

  it("versions owner-assigned finding roles, preserves active approval during proposal, and scrubs tags on forget", () => {
    const db = createTestBook();
    const project = saveWorkstationProject(db, { title: "Role findings", brief: "Brief" });
    const caseId = openCase(db, { title: "Source", question: "Question" });
    assignWorkstationProject(db, { caseId, projectId: project.id });
    const body = "The brand layout was approved.";
    const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body });
    const sourceRefs = [{ caseId, turnId, sha256: createHash("sha256").update(body).digest("hex") }];
    const proposed = proposeProjectMemory(db, {
      projectId: project.id, kind: "finding", text: "Brand layout approved.",
      sourceRefs, roleTags: ["reviewer", "design"], actorId: "owner"
    });
    expect(listProjectMemory(db, project.id)[0]?.candidate?.roleTags).toEqual(["design", "reviewer"]);
    const epochBeforeReview = projectMemoryEpoch(db, project.id);
    expect(() => reviewProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
      decision: "approve", actorId: "owner"
    })).toThrow(/Confirm the finding's exact role tags/u);
    expect(() => reviewProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
      decision: "approve", roleTags: ["finance"], actorId: "owner"
    })).toThrow(/do not match/u);
    expect(projectMemoryEpoch(db, project.id)).toBe(epochBeforeReview);
    const approved = reviewProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
      decision: "approve", roleTags: ["reviewer", "design"], actorId: "owner"
    });
    expect(approvedProjectFindings(db, project.id)[0]).toMatchObject({
      revision: approved.revision, roleTags: ["design", "reviewer"], provenance: "verified"
    });
    const epoch = projectMemoryEpoch(db, project.id);
    expect(() => proposeProjectMemory(db, {
      projectId: project.id, kind: "instruction", text: "Always review brand layout.",
      roleTags: ["design"], actorId: "owner"
    })).toThrow(/Only findings may have role tags/u);
    expect(() => proposeProjectMemory(db, {
      projectId: project.id, kind: "finding", text: "Bad role.",
      roleTags: ["Lead Analyst"], actorId: "owner"
    })).toThrow();
    expect(projectMemoryEpoch(db, project.id)).toBe(epoch);
    expect(() => proposeProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: 1,
      kind: "finding", text: "Changed audience", roleTags: ["finance"], actorId: "owner"
    })).toThrow(/Stale memory revision/u);
    expect(projectMemoryEpoch(db, project.id)).toBe(epoch);
    const updated = proposeProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: approved.revision,
      kind: "finding", text: "Brand layout approved.", roleTags: ["finance"], actorId: "owner"
    });
    expect(projectMemoryEpoch(db, project.id)).toBe(epoch + 1);
    expect(approvedProjectFindings(db, project.id)[0]?.roleTags).toEqual(["design", "reviewer"]);
    expect(listProjectMemory(db, project.id)[0]?.candidate?.roleTags).toEqual(["finance"]);
    const replacement = reviewProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: updated.revision,
      decision: "approve", roleTags: ["finance"], actorId: "owner"
    });
    expect(approvedProjectFindings(db, project.id)[0]?.roleTags).toEqual(["finance"]);
    const inherited = proposeProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: replacement.revision,
      kind: "finding", text: "Brand layout approved with context.", actorId: "owner"
    });
    expect(listProjectMemory(db, project.id)[0]?.candidate?.roleTags).toEqual(["finance"]);
    expect(approvedProjectFindings(db, project.id)[0]?.roleTags).toEqual(["finance"]);
    const rejected = reviewProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: inherited.revision,
      decision: "reject", actorId: "owner"
    });
    expect(approvedProjectFindings(db, project.id)[0]?.roleTags).toEqual(["finance"]);
    forgetProjectMemory(db, {
      projectId: project.id, id: proposed.id, expectedRevision: rejected.revision, actorId: "owner"
    });
    expect(approvedProjectFindings(db, project.id)).toEqual([]);
    const history = db.prepare(`SELECT role_tags_json AS roleTagsJson
      FROM workstation_project_memory_revision WHERE entry_id = ? ORDER BY revision`)
      .all(proposed.id) as unknown as readonly { roleTagsJson: string }[];
    expect(history.every((row) => row.roleTagsJson === "[]")).toBe(true);
    db.close();
  });

  it("keeps source identity across restart, then excludes changed and forgotten sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "rellane-findings-"));
    const path = join(dir, "book.sqlite");
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const project = saveWorkstationProject(db, { title: "Findings", brief: "Brief" });
      const caseId = openCase(db, { title: "Source case", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      const sourceText = "The brand layout passed owner review.";
      const turnId = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: sourceText });
      const sha256 = createHash("sha256").update(sourceText).digest("hex");
      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "finding", text: "Brand layout passed owner review.",
        sourceRefs: [{ caseId, turnId, sha256 }], actorId: "owner"
      });
      const approved = reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner"
      });
      expect(approvedProjectFindings(db, project.id)).toMatchObject([{
        id: proposed.id, revision: approved.revision, provenance: "verified",
        sourceRefs: [{ caseId, turnId, sha256 }]
      }]);
      db.close();

      const reopened = new DatabaseSync(path);
      reopened.exec("PRAGMA foreign_keys = ON");
      expect(approvedProjectFindings(reopened, project.id)[0]?.provenance).toBe("verified");
      reopened.prepare("UPDATE case_turn SET body = ? WHERE id = ?")
        .run("The source changed after approval.", turnId);
      expect(approvedProjectFindings(reopened, project.id)[0]?.provenance).toBe("stale");
      forgetProjectMemory(reopened, {
        projectId: project.id, id: proposed.id, expectedRevision: approved.revision,
        actorId: "owner", reason: "Withdrawn"
      });
      expect(approvedProjectFindings(reopened, project.id)).toEqual([]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps unattributed findings out of evidence and blocks an unresolved authority conflict", () => {
    const db = createTestBook();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const proposedFinding = proposeProjectMemory(db, {
      projectId: project.id, kind: "finding", text: "A claimed fact without a source.", actorId: "owner"
    });
    reviewProjectMemory(db, {
      projectId: project.id, id: proposedFinding.id, expectedRevision: proposedFinding.revision,
      decision: "approve", actorId: "owner"
    });
    expect(approvedProjectFindings(db, project.id)[0]?.provenance).toBe("unattributed");
    const approve = (text: string) => {
      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "decision", text, actorId: "owner"
      });
      return reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner"
      });
    };
    const first = approve("Use serif.");
    const second = approve("Use sans.");
    declareProjectMemoryConflict(db, {
      projectId: project.id, firstMemoryId: first.id, secondMemoryId: second.id,
      expectedFirstActiveRevision: first.revision,
      expectedSecondActiveRevision: second.revision,
      expectedConflictRevision: 0, actorId: "owner", reason: "Opposite instructions"
    });
    expect(() => approvedProjectFindings(db, project.id)).toThrow(/unresolved/u);
    db.close();
  });
});
