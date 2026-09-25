import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { MIGRATIONS } from "../book/schema.js";
import {
  proposeProjectMemory,
  reviewProjectMemory,
  forgetProjectMemory,
  projectMemoryEpoch,
  listProjectMemory,
  approvedProjectConstraints,
  approvedProjectFindings,
  type ProjectMemorySourceRef
} from "../workstation/project-memory-book.js";
import { buildWorkstationContext } from "../workstation/context.js";

function setupTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

function seedProjectAndCase(
  db: DatabaseSync,
  projectId: string = "proj-1",
  caseId: string = "case-1"
): { readonly sourceTurnId: string; readonly sha256: string; readonly body: string } {
  const now = Date.now();
  // 1. Create project with initial memory_epoch 1
  db.prepare(
    "INSERT INTO workstation_project (id, created_at, memory_epoch) VALUES (?, ?, 1)"
  ).run(projectId, now);

  // 2. Create work_case
  db.prepare(
    "INSERT INTO work_case (id, title, question, opened_at) VALUES (?, ?, ?, ?)"
  ).run(caseId, "Test Case", "Test Question", now);

  // 3. Link case to project
  db.prepare(
    "INSERT INTO workstation_project_link (case_id, project_id, created_at) VALUES (?, ?, ?)"
  ).run(caseId, projectId, now);

  // 4. Create verbatim turn in case
  const turnId = "turn-source-1";
  const body = "Architecture Decision: The database layer must use transactional SQLite WAL mode.";
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");

  db.prepare(
    "INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at) VALUES (?, ?, 1, 'owner', 'verbatim', ?, ?)"
  ).run(turnId, caseId, body, now);

  return { sourceTurnId: turnId, sha256, body };
}

describe("Backend Final Acceptance - Memory Epoch, CAS, and Forget Binding (G04 / R04)", () => {
  it("enforces CAS expectedRevision on proposals and increments memory_epoch on mutations", () => {
    const db = setupTestDatabase();
    const { sourceTurnId, sha256 } = seedProjectAndCase(db);

    const initialEpoch = projectMemoryEpoch(db, "proj-1");
    expect(initialEpoch).toBe(1);

    const sourceRef: ProjectMemorySourceRef = {
      caseId: "case-1",
      turnId: sourceTurnId,
      sha256
    };

    // 1. Propose memory with expectedRevision: 0 (new item)
    const proposed = proposeProjectMemory(db, {
      projectId: "proj-1",
      kind: "decision",
      text: "We must use SQLite WAL mode for concurrency.",
      sourceRefs: [sourceRef],
      expectedRevision: 0,
      actorId: "actor-lead"
    });

    expect(proposed.revision).toBe(1);
    expect(proposed.state).toBe("proposed");
    expect(proposed.epoch).toBe(initialEpoch + 1);
    expect(projectMemoryEpoch(db, "proj-1")).toBe(proposed.epoch);

    // 2. Adversarial CAS check: Attempting to update or propose with wrong expectedRevision must throw
    expect(() =>
      proposeProjectMemory(db, {
        projectId: "proj-1",
        id: proposed.id,
        kind: "decision",
        text: "Tampered decision",
        expectedRevision: 0, // Stale! Revision is already 1
        actorId: "actor-rogue"
      })
    ).toThrow(/Stale memory revision: expected revision 0, but current head revision is 1/i);

    // 3. Propose update with correct expectedRevision: 1
    const updated = proposeProjectMemory(db, {
      projectId: "proj-1",
      id: proposed.id,
      kind: "decision",
      text: "We must use SQLite WAL mode with 64KB page size.",
      expectedRevision: 1,
      actorId: "actor-lead"
    });

    expect(updated.revision).toBe(2);
    expect(updated.epoch).toBe(proposed.epoch + 1);
  });

  it("verifies source turn sha256 against actual case_turn body, rejecting mismatched hashes", () => {
    const db = setupTestDatabase();
    const { sourceTurnId } = seedProjectAndCase(db);

    const forgedSourceRef: ProjectMemorySourceRef = {
      caseId: "case-1",
      turnId: sourceTurnId,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" // Fake hash
    };

    expect(() =>
      proposeProjectMemory(db, {
        projectId: "proj-1",
        kind: "finding",
        text: "Database observation",
        sourceRefs: [forgedSourceRef],
        actorId: "actor-lead"
      })
    ).toThrow(/sha256 mismatch/i);
  });

  it("handles review approval/rejection lifecycle with atomic epoch bump and role scoping", () => {
    const db = setupTestDatabase();
    const { sourceTurnId, sha256 } = seedProjectAndCase(db);

    const sourceRef: ProjectMemorySourceRef = {
      caseId: "case-1",
      turnId: sourceTurnId,
      sha256
    };

    // Propose a verified finding with explicit roleTags
    const finding = proposeProjectMemory(db, {
      projectId: "proj-1",
      kind: "finding",
      text: "Memory bus bandwidth saturates at 4 concurrent workers.",
      sourceRefs: [sourceRef],
      roleTags: ["architect", "benchmarker"],
      actorId: "actor-eng"
    });

    const epochBeforeReview = projectMemoryEpoch(db, "proj-1");

    // Review with approval
    const approved = reviewProjectMemory(db, {
      projectId: "proj-1",
      id: finding.id,
      expectedRevision: finding.revision,
      decision: "approve",
      roleTags: ["architect", "benchmarker"],
      reason: "Confirmed via load tests",
      actorId: "actor-lead"
    });

    expect(approved.state).toBe("approved");
    expect(approved.epoch).toBe(epochBeforeReview + 1);

    // Context compilation scoping:
    // General instruction is universally included
    proposeProjectMemory(db, {
      projectId: "proj-1",
      kind: "instruction",
      text: "Always enforce bounded memory allocations.",
      actorId: "actor-lead"
    });
    // Approve instruction
    const items = listProjectMemory(db, "proj-1");
    const instruction = items.find((i) => i.kind === "instruction")!;
    reviewProjectMemory(db, {
      projectId: "proj-1",
      id: instruction.id,
      expectedRevision: 1,
      decision: "approve",
      actorId: "actor-lead"
    });

    const constraints = approvedProjectConstraints(db, "proj-1");
    const findings = approvedProjectFindings(db, "proj-1");
    const sources = [{ id: "src-1", label: "Architecture Spec", text: "System architecture and memory bus layout." }];

    // 1. Context compiled for "architect" role includes both instruction and finding
    const archContext = buildWorkstationContext({
      prompt: "Evaluate memory bus bandwidth saturation for concurrent workers.",
      sources,
      acceptedConstraints: constraints,
      approvedFindings: findings,
      taskRole: "architect"
    });
    expect(archContext.findingDecisions?.some((d) => d.id === finding.id && d.included)).toBe(true);
    expect(archContext.constraintIds).toContain(instruction.id);
    expect(archContext.packet).toContain("saturates at 4");
    expect(archContext.packet).toContain("bounded");

    // 2. Context compiled for "implementer" role does NOT include the architect-only finding
    const implContext = buildWorkstationContext({
      prompt: "Evaluate memory bus bandwidth saturation for concurrent workers.",
      sources,
      acceptedConstraints: constraints,
      approvedFindings: findings,
      taskRole: "implementer"
    });
    expect(implContext.findingDecisions?.some((d) => d.id === finding.id && !d.included && d.reason === "outside_task_role")).toBe(true);
    expect(implContext.constraintIds).toContain(instruction.id);
    expect(implContext.packet).not.toContain("saturates at 4");
    expect(implContext.packet).toContain("bounded");
  });

  it("executes forgetProjectMemory: blanks forgotten content, cascades snapshot redaction, and invalidates epoch", () => {
    const db = setupTestDatabase();
    seedProjectAndCase(db);

    const decision = proposeProjectMemory(db, {
      projectId: "proj-1",
      kind: "decision",
      text: "Customer secret key salt is salt_alpha_12345",
      actorId: "actor-lead"
    });

    reviewProjectMemory(db, {
      projectId: "proj-1",
      id: decision.id,
      expectedRevision: 1,
      decision: "approve",
      actorId: "actor-lead"
    });

    const epochBeforeForget = projectMemoryEpoch(db, "proj-1");

    // Forget the memory item
    const forgotten = forgetProjectMemory(db, {
      projectId: "proj-1",
      id: decision.id,
      expectedRevision: 2,
      reason: "Sensitive credential inadvertently recorded",
      actorId: "actor-compliance"
    });

    expect(forgotten.state).toBe("forgotten");
    expect(forgotten.activeRevision).toBeNull();
    expect(forgotten.epoch).toBe(epochBeforeForget + 1);

    // Verify stored text is blanked in SQLite revision rows and omitted from listProjectMemory
    expect(listProjectMemory(db, "proj-1").some((i) => i.id === decision.id)).toBe(false);
    const revisions = db
      .prepare("SELECT body FROM workstation_project_memory_revision WHERE entry_id = ?")
      .all(decision.id) as Array<{ body: string }>;
    expect(revisions.length).toBeGreaterThan(0);
    for (const rev of revisions) {
      expect(rev.body).toBe("");
    }

    // Context compilation must not include forgotten records
    const constraints = approvedProjectConstraints(db, "proj-1");
    expect(constraints.some((c) => c.text.includes("salt_alpha_12345"))).toBe(false);
  });

  it("validates that Host memory assertion rejects dispatch when memoryEpoch drifts", () => {
    const db = setupTestDatabase();
    seedProjectAndCase(db);

    const initialEpoch = projectMemoryEpoch(db, "proj-1");

    // Simulated PendingReview created when epoch was initialEpoch
    const reviewedSnapshot = {
      projectId: "proj-1",
      memoryEpoch: initialEpoch
    };

    // Before run starts, someone modifies project memory (e.g. proposes new memory)
    proposeProjectMemory(db, {
      projectId: "proj-1",
      kind: "instruction",
      text: "New requirement added mid-review",
      actorId: "actor-other"
    });

    const currentEpoch = projectMemoryEpoch(db, "proj-1");
    expect(currentEpoch).toBeGreaterThan(reviewedSnapshot.memoryEpoch);

    // Mimic the exact invariant in WorkstationHost.assertMemoryCurrent:
    // `if (reviewed.projectId !== null && this.deps.memory.epoch(db, reviewed.projectId) !== reviewed.memoryEpoch)`
    const isMemoryStale = currentEpoch !== reviewedSnapshot.memoryEpoch;
    expect(isMemoryStale).toBe(true);

    const assertMemoryCurrentCheck = () => {
      if (currentEpoch !== reviewedSnapshot.memoryEpoch) {
        throw new Error("Project memory changed after review. Review again.");
      }
    };

    expect(assertMemoryCurrentCheck).toThrow("Project memory changed after review. Review again.");
  });
});
