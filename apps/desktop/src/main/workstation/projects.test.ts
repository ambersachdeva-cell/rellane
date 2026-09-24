/**
 * Tests for long-lived workstation project persistence and immutable briefs.
 *
 * Validates creation, versioned edits, stale-edit rejection, case assignment,
 * verbatim brief capture into case turns, recapture idempotence, cascade safety,
 * and persistence to real SQLite storage on disk.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeCase, eraseCase, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import {
  assignWorkstationProject,
  captureProjectBrief,
  listWorkstationProjectLinks,
  listWorkstationProjects,
  projectForWork,
  saveWorkstationProject
} from "./projects.js";

function createTestBook(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }

  return db;
}

let db: DatabaseSync;

beforeEach(() => {
  db = createTestBook();
});

afterEach(() => { db.close(); });

describe("workstation projects and immutable briefs", () => {
  it("keeps whitespace and Unicode intact when a brief becomes source evidence", () => {
    const brief = "    an indented example\r\nमूल निर्देश ₹125\n\n";
    const project = saveWorkstationProject(db, {title: "Source integrity", brief});
    const caseId = openCase(db, {title: "Check source", question: "Use the original brief"});
    assignWorkstationProject(db, {caseId, projectId: project.id});
    const captured = captureProjectBrief(db, {caseId, expectedRevision: 1});
    expect(listWorkstationProjects(db)[0]?.brief).toBe(brief);
    expect(turnsFor(db, caseId).find(turn => turn.id === captured.sourceTurnId)?.body).toBe(brief);
    expect(() => saveWorkstationProject(db, {title: "Blank", brief: " \n\t"})).toThrow();
  });
  it("creates a project at v1, appends immutable revisions on edit, and refuses stale revisions", () => {
    const created = saveWorkstationProject(db, {
      title: "Studio Brand Launch",
      brief: "Initial creative direction and positioning"
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.revision).toBe(1);
    expect(created.title).toBe("Studio Brand Launch");
    expect(created.brief).toBe("Initial creative direction and positioning");
    expect(created.createdAt).toBe(created.updatedAt);

    // Update to v2 with expected revision 1
    const updated = saveWorkstationProject(db, {
      id: created.id,
      expectedRevision: 1,
      title: "Studio Brand Launch (Revised)",
      brief: "Updated tone and audience constraints"
    });

    expect(updated.id).toBe(created.id);
    expect(updated.revision).toBe(2);
    expect(updated.title).toBe("Studio Brand Launch (Revised)");
    expect(updated.brief).toBe("Updated tone and audience constraints");
    expect(updated.createdAt).toBe(created.createdAt);

    // Stale edit with old expected revision 1 is refused
    expect(() =>
      saveWorkstationProject(db, {
        id: created.id,
        expectedRevision: 1,
        title: "Conflict Edit",
        brief: "Should be rejected"
      })
    ).toThrow(/stale project revision/iu);

    // Schema rejects mismatched update arguments (id without expectedRevision)
    expect(() =>
      saveWorkstationProject(db, {
        id: created.id,
        title: "Invalid Input",
        brief: "Missing expected revision"
      } as unknown as Parameters<typeof saveWorkstationProject>[1])
    ).toThrow();

    // Listing reports latest revision
    const listed = listWorkstationProjects(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revision).toBe(2);
    expect(listed[0]?.title).toBe("Studio Brand Launch (Revised)");
  });

  it("assigns open cases, rejects closed or non-existent cases, and unlinks cleanly without losing history", () => {
    const caseId = openCase(db, {
      title: "Task: Landing Page Copy",
      question: "How do we frame the new offer?"
    });

    const project = saveWorkstationProject(db, {
      title: "Marketing Core",
      brief: "Brand voice and primary claims"
    });

    // Assignment associates case with project
    assignWorkstationProject(db, { caseId, projectId: project.id });
    const linkedProject = projectForWork(db, caseId);
    expect(linkedProject).not.toBeNull();
    expect(linkedProject?.id).toBe(project.id);

    // Refuses non-existent case
    expect(() =>
      assignWorkstationProject(db, { caseId: "missing-case-id", projectId: project.id })
    ).toThrow(/does not exist/iu);

    // Refuses closed case
    closeCase(db, caseId, { closedAs: "settled", verdict: "Copy finalised." });
    expect(() =>
      assignWorkstationProject(db, { caseId, projectId: project.id })
    ).toThrow(/is closed/iu);

    // Open another case, link, and test unlinking with projectId: null
    const activeCaseId = openCase(db, { title: "Active Task", question: "WIP" });
    assignWorkstationProject(db, { caseId: activeCaseId, projectId: project.id });
    expect(projectForWork(db, activeCaseId)?.id).toBe(project.id);

    assignWorkstationProject(db, { caseId: activeCaseId, projectId: null });
    expect(projectForWork(db, activeCaseId)).toBeNull();
  });

  it("allows multiple cases to share the same project brief via independent immutable source turns", () => {
    const caseA = openCase(db, { title: "Task A: Frontend", question: "UI implementation" });
    const caseB = openCase(db, { title: "Task B: Backend", question: "API routes" });

    const project = saveWorkstationProject(db, {
      title: "Unified Client Portal",
      brief: "Exact shared spec: auth via native tokens, 10-second timeout."
    });

    assignWorkstationProject(db, { caseId: caseA, projectId: project.id });
    assignWorkstationProject(db, { caseId: caseB, projectId: project.id });

    const capA = captureProjectBrief(db, { caseId: caseA, expectedRevision: 1 });
    const capB = captureProjectBrief(db, { caseId: caseB, expectedRevision: 1 });

    // Both tasks received independent source turn IDs
    expect(capA.sourceTurnId).not.toBe(capB.sourceTurnId);
    expect(capA.project.id).toBe(project.id);
    expect(capB.project.id).toBe(project.id);

    // Turn attributes are verbatim and structured
    const turnsA = turnsFor(db, caseA);
    const turnsB = turnsFor(db, caseB);

    expect(turnsA).toHaveLength(1);
    expect(turnsB).toHaveLength(1);

    expect(turnsA[0]?.seat).toBe("Source · Project brief · Unified Client Portal · v1");
    expect(turnsA[0]?.kind).toBe("verbatim");
    expect(turnsA[0]?.body).toBe(project.brief);

    expect(turnsB[0]?.seat).toBe("Source · Project brief · Unified Client Portal · v1");
    expect(turnsB[0]?.kind).toBe("verbatim");
    expect(turnsB[0]?.body).toBe(project.brief);
  });

  it("recapture of same case, project and revision is idempotent", () => {
    const caseId = openCase(db, { title: "Research Task", question: "Investigate competitor pricing" });
    const project = saveWorkstationProject(db, {
      title: "Pricing Strategy",
      brief: "Target 25% lower overhead than incumbents."
    });

    assignWorkstationProject(db, { caseId, projectId: project.id });

    const firstCapture = captureProjectBrief(db, { caseId, expectedRevision: 1 });
    const secondCapture = captureProjectBrief(db, { caseId, expectedRevision: 1 });

    // Recapture returns the exact same still-existing sourceTurnId
    expect(secondCapture.sourceTurnId).toBe(firstCapture.sourceTurnId);

    // Room turns were not duplicated
    const turns = turnsFor(db, caseId);
    expect(turns).toHaveLength(1);
  });

  it("project revision updates do not mutate earlier captured sources", () => {
    const caseId = openCase(db, { title: "Execution Task", question: "Build phase 1" });
    const project = saveWorkstationProject(db, {
      title: "Mobile App",
      brief: "v1 scope: iOS only with local SQLite cache."
    });

    assignWorkstationProject(db, { caseId, projectId: project.id });
    const cap1 = captureProjectBrief(db, { caseId, expectedRevision: 1 });

    // Update project to v2
    saveWorkstationProject(db, {
      id: project.id,
      expectedRevision: 1,
      title: "Mobile App (Expanded)",
      brief: "v2 scope: iOS and Android cross-platform sync."
    });

    // Earlier source turn in the room remains unchanged
    const turnsAfterEdit = turnsFor(db, caseId);
    expect(turnsAfterEdit).toHaveLength(1);
    expect(turnsAfterEdit[0]?.seat).toBe("Source · Project brief · Mobile App · v1");
    expect(turnsAfterEdit[0]?.body).toBe("v1 scope: iOS only with local SQLite cache.");

    // Capturing v2 appends a new turn without modifying v1
    const cap2 = captureProjectBrief(db, { caseId, expectedRevision: 2 });
    expect(cap2.sourceTurnId).not.toBe(cap1.sourceTurnId);

    const turnsAfterV2 = turnsFor(db, caseId);
    expect(turnsAfterV2).toHaveLength(2);
    expect(turnsAfterV2[0]?.body).toBe("v1 scope: iOS only with local SQLite cache.");
    expect(turnsAfterV2[1]?.seat).toBe("Source · Project brief · Mobile App (Expanded) · v2");
    expect(turnsAfterV2[1]?.body).toBe("v2 scope: iOS and Android cross-platform sync.");
  });

  it("erasing a case cascades links and sources but preserves project and other case links", () => {
    const caseA = openCase(db, { title: "Case A", question: "Question A" });
    const caseB = openCase(db, { title: "Case B", question: "Question B" });

    const project = saveWorkstationProject(db, {
      title: "Shared Core",
      brief: "Permanent company overview."
    });

    assignWorkstationProject(db, { caseId: caseA, projectId: project.id });
    assignWorkstationProject(db, { caseId: caseB, projectId: project.id });
    captureProjectBrief(db, { caseId: caseA, expectedRevision: 1 });
    captureProjectBrief(db, { caseId: caseB, expectedRevision: 1 });

    expect(listWorkstationProjectLinks(db)).toHaveLength(2);

    // Erase Case A
    const erased = eraseCase(db, caseA);
    expect(erased).toBe(true);

    // Project itself remains intact with full history
    const projects = listWorkstationProjects(db);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(project.id);

    // Case B remains linked and has its turn intact
    expect(projectForWork(db, caseB)?.id).toBe(project.id);
    expect(turnsFor(db, caseB)).toHaveLength(1);

    // Only Case B link remains in workstation_project_link
    const remainingLinks = listWorkstationProjectLinks(db);
    expect(remainingLinks).toHaveLength(1);
    expect(remainingLinks[0]?.caseId).toBe(caseB);
  });

  it("persists projects, links, and captured briefs across real SQLite file reopen", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "rellane-projects-test-"));
    const dbPath = join(tempDir, "book.sqlite");

    try {
      const initialDb = new DatabaseSync(dbPath);
      initialDb.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS) {
        initialDb.exec(migration.sql);
      }

      const caseId = openCase(initialDb, {
        title: "Durable Task",
        question: "Will this survive reboot?"
      });

      const project = saveWorkstationProject(initialDb, {
        title: "Durable Project",
        brief: "Persisted on disk with zero data loss."
      });

      assignWorkstationProject(initialDb, { caseId, projectId: project.id });
      const capture = captureProjectBrief(initialDb, { caseId, expectedRevision: 1 });

      initialDb.close();

      // Reopen the file connection
      const reopenedDb = new DatabaseSync(dbPath);
      reopenedDb.exec("PRAGMA foreign_keys = ON");

      const listedProjects = listWorkstationProjects(reopenedDb);
      expect(listedProjects).toHaveLength(1);
      expect(listedProjects[0]?.title).toBe("Durable Project");
      expect(listedProjects[0]?.brief).toBe("Persisted on disk with zero data loss.");

      const resolved = projectForWork(reopenedDb, caseId);
      expect(resolved?.id).toBe(project.id);

      const roomTurns = turnsFor(reopenedDb, caseId);
      expect(roomTurns).toHaveLength(1);
      expect(roomTurns[0]?.id).toBe(capture.sourceTurnId);
      expect(roomTurns[0]?.body).toBe("Persisted on disk with zero data loss.");

      reopenedDb.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
