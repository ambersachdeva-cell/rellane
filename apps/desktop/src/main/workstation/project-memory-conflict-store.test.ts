/** Pairwise owner rulings must survive restart and stop contradictory approvals at Prepare. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../book/schema.js";
import { saveWorkstationProject } from "./projects.js";
import { buildWorkstationContext } from "./context.js";
import { WorkstationHost, type WorkstationHostDeps } from "./service.js";
import {
  approvedProjectConstraints,
  explainApprovedProjectConstraints,
  forgetProjectMemory,
  projectMemoryEpoch,
  proposeProjectMemory,
  reviewProjectMemory
} from "./project-memory-book.js";
import {
  declareProjectMemoryConflict,
  listProjectMemoryConflicts,
  resolveProjectMemoryConflict
} from "./project-memory-conflict-store.js";

function book(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  return db;
}

function approve(db: DatabaseSync, projectId: string, text: string) {
  const proposed = proposeProjectMemory(db, {
    projectId, kind: "decision", text, actorId: "owner"
  });
  return reviewProjectMemory(db, {
    projectId, id: proposed.id, expectedRevision: proposed.revision,
    decision: "approve", actorId: "owner"
  });
}

function declare(db: DatabaseSync, projectId: string, first: { id: string; revision: number },
  second: { id: string; revision: number }, expectedConflictRevision = 0) {
  return declareProjectMemoryConflict(db, {
    projectId, firstMemoryId: first.id, secondMemoryId: second.id,
    expectedFirstActiveRevision: first.revision,
    expectedSecondActiveRevision: second.revision,
    expectedConflictRevision, actorId: "owner",
    reason: "These directions cannot both govern the next review."
  });
}

function resolve(db: DatabaseSync, projectId: string, conflictId: string, expectedRevision: number,
  firstRevision: number | null, secondRevision: number | null,
  resolution: { kind: "winner"; winnerId: string } | { kind: "both_retired" }) {
  return resolveProjectMemoryConflict(db, {
    projectId, conflictId, expectedRevision,
    expectedFirstActiveRevision: firstRevision,
    expectedSecondActiveRevision: secondRevision,
    resolution, actorId: "owner", reason: "Owner reviewed the conflict and made this ruling."
  });
}

describe("canonical project memory conflicts", () => {
  it("keeps unpaired approved memories usable, but blocks an unresolved pair before packet compilation", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Use the serif masthead.");
    const b = approve(db, project.id, "Use the sans masthead.");
    expect(new Set(approvedProjectConstraints(db, project.id).map((row) => row.id)))
      .toEqual(new Set([a.id, b.id]));
    const epoch = projectMemoryEpoch(db, project.id);
    const conflict = declare(db, project.id, a, b);
    expect(projectMemoryEpoch(db, project.id)).toBe(epoch + 1);
    expect(() => approvedProjectConstraints(db, project.id)).toThrow(/unresolved/u);
    expect(conflict.history).toMatchObject([{
      revision: 1, state: "declared", actorId: "owner",
      reason: "These directions cannot both govern the next review."
    }]);
    db.close();
  });

  it("stops production Host Prepare through the injected Book compiler before provider discovery", async () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Choose blue.");
    const b = approve(db, project.id, "Choose red.");
    declare(db, project.id, a, b);
    let providerDiscoveries = 0;
    const host = new WorkstationHost({
      book: () => db,
      now: () => 100,
      readCase: () => ({ id: "case-1", title: "Case", closedAt: null }),
      memory: {
        projectForCase: () => project.id,
        epoch: projectMemoryEpoch,
        constraints: approvedProjectConstraints
      },
      discoverProviders: async () => { providerDiscoveries += 1; return []; }
    } as unknown as WorkstationHostDeps);
    await expect(host.prepare({
      caseId: "case-1", providerId: "codex", modelId: "model",
      prompt: "Review", sourceTurnIds: []
    }, {})).rejects.toThrow(/unresolved/u);
    expect(providerDiscoveries).toBe(0);
    db.close();
  });

  it("compiles only the explicit winner and explains the losing approval", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Use the serif masthead.");
    const b = approve(db, project.id, "Use the sans masthead.");
    const c = approve(db, project.id, "Keep margins wide.");
    const conflict = declare(db, project.id, a, b);
    const firstId = conflict.firstMemoryId;
    const secondId = conflict.secondMemoryId;
    const revById = new Map([[a.id, a.revision], [b.id, b.revision]]);
    const ruling = resolve(db, project.id, conflict.id, 1,
      revById.get(firstId)!, revById.get(secondId)!, { kind: "winner", winnerId: a.id });
    expect(ruling.history.map((row) => row.revision)).toEqual([1, 2]);
    const selected = explainApprovedProjectConstraints(db, project.id);
    expect(new Set(selected.included.map((row) => row.id))).toEqual(new Set([a.id, c.id]));
    expect(selected.excluded).toMatchObject([{
      constraint: { id: b.id, text: "Use the sans masthead." },
      conflicts: [{ conflictId: conflict.id, conflictRevision: 2,
        winnerId: a.id, reason: "Owner reviewed the conflict and made this ruling." }]
    }]);
    const packet = buildWorkstationContext({
      prompt: "Prepare", sources: [], acceptedConstraints: approvedProjectConstraints(db, project.id)
    });
    expect(new Set(packet.constraintIds)).toEqual(new Set([a.id, c.id]));
    expect(packet.packet).not.toContain("Use the sans masthead.");
    db.close();
  });

  it("supports both retired without silently approving either side", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Choose blue.");
    const b = approve(db, project.id, "Choose red.");
    const conflict = declare(db, project.id, a, b);
    const revById = new Map([[a.id, a.revision], [b.id, b.revision]]);
    resolve(db, project.id, conflict.id, 1,
      revById.get(conflict.firstMemoryId)!, revById.get(conflict.secondMemoryId)!,
      { kind: "both_retired" });
    expect(approvedProjectConstraints(db, project.id)).toEqual([]);
    expect(explainApprovedProjectConstraints(db, project.id).excluded).toHaveLength(2);
    db.close();
  });

  it("fails closed when either approved version changes, then accepts a new explicit ruling", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Choose blue.");
    const b = approve(db, project.id, "Choose red.");
    const conflict = declare(db, project.id, a, b);
    const revById = new Map([[a.id, a.revision], [b.id, b.revision]]);
    resolve(db, project.id, conflict.id, 1,
      revById.get(conflict.firstMemoryId)!, revById.get(conflict.secondMemoryId)!,
      { kind: "winner", winnerId: a.id });
    const proposal = proposeProjectMemory(db, {
      projectId: project.id, id: a.id, expectedRevision: a.revision,
      kind: "decision", text: "Choose navy.", actorId: "owner"
    });
    // A pending candidate does not change the exact active approval.
    expect(approvedProjectConstraints(db, project.id)).toHaveLength(1);
    const changed = reviewProjectMemory(db, {
      projectId: project.id, id: a.id, expectedRevision: proposal.revision,
      decision: "approve", actorId: "owner"
    });
    expect(() => approvedProjectConstraints(db, project.id)).toThrow(/stale/u);
    expect(() => resolve(db, project.id, conflict.id, 2,
      a.revision, b.revision, { kind: "winner", winnerId: a.id })).toThrow(/active revision changed/u);
    const currentById = new Map([[a.id, changed.revision], [b.id, b.revision]]);
    resolve(db, project.id, conflict.id, 2,
      currentById.get(conflict.firstMemoryId)!, currentById.get(conflict.secondMemoryId)!,
      { kind: "winner", winnerId: a.id });
    expect(approvedProjectConstraints(db, project.id)).toMatchObject([{
      id: a.id, revision: changed.revision, text: "Choose navy."
    }]);
    db.close();
  });

  it("requires a new ruling when the winner is forgotten and permits both-retired cleanup", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Choose blue.");
    const b = approve(db, project.id, "Choose red.");
    const conflict = declare(db, project.id, a, b);
    const revById = new Map([[a.id, a.revision], [b.id, b.revision]]);
    resolve(db, project.id, conflict.id, 1,
      revById.get(conflict.firstMemoryId)!, revById.get(conflict.secondMemoryId)!,
      { kind: "winner", winnerId: a.id });
    db.prepare("UPDATE workstation_project_memory_conflict_revision SET reason = 'Private phrase from memory' WHERE conflict_id = ?")
      .run(conflict.id);
    forgetProjectMemory(db, {
      projectId: project.id, id: a.id, expectedRevision: a.revision,
      actorId: "owner", reason: "Withdrawn"
    });
    expect(() => approvedProjectConstraints(db, project.id)).toThrow(/stale/u);
    expect(JSON.stringify(listProjectMemoryConflicts(db, project.id))).not.toContain("Private phrase from memory");
    const currentById = new Map<string, number | null>([[a.id, null], [b.id, b.revision]]);
    resolve(db, project.id, conflict.id, 2,
      currentById.get(conflict.firstMemoryId)!, currentById.get(conflict.secondMemoryId)!,
      { kind: "both_retired" });
    expect(approvedProjectConstraints(db, project.id)).toEqual([]);
    db.close();
  });

  it("rejects stale CAS, cross-project pairs and contradictory rulings without changing epoch", () => {
    const db = book();
    const one = saveWorkstationProject(db, { title: "One", brief: "Brief" });
    const two = saveWorkstationProject(db, { title: "Two", brief: "Brief" });
    const a = approve(db, one.id, "A");
    const b = approve(db, one.id, "B");
    const foreign = approve(db, two.id, "Foreign");
    const epoch = projectMemoryEpoch(db, one.id);
    expect(() => declare(db, one.id, a, foreign)).toThrow(/not in project/u);
    expect(projectMemoryEpoch(db, one.id)).toBe(epoch);
    const conflict = declare(db, one.id, a, b);
    expect(() => declare(db, one.id, a, b)).toThrow(/Stale conflict revision/u);
    expect(() => resolve(db, one.id, conflict.id, 1,
      a.revision, b.revision, { kind: "winner", winnerId: foreign.id })).toThrow(/Winner must/u);
    expect(listProjectMemoryConflicts(db, one.id)[0]?.headRevision).toBe(1);
    expect(projectMemoryEpoch(db, one.id)).toBe(epoch + 1);
    db.close();
  });

  it("blocks an overlapping ruling that would include and retire the same memory", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "A");
    const b = approve(db, project.id, "B");
    const c = approve(db, project.id, "C");
    const ab = declare(db, project.id, a, b);
    const bc = declare(db, project.id, b, c);
    const revisions = new Map([[a.id, a.revision], [b.id, b.revision], [c.id, c.revision]]);
    resolve(db, project.id, ab.id, 1,
      revisions.get(ab.firstMemoryId)!, revisions.get(ab.secondMemoryId)!,
      { kind: "winner", winnerId: a.id });
    resolve(db, project.id, bc.id, 1,
      revisions.get(bc.firstMemoryId)!, revisions.get(bc.secondMemoryId)!,
      { kind: "winner", winnerId: b.id });
    expect(() => approvedProjectConstraints(db, project.id)).toThrow(/both a conflict winner and retired/u);
    db.close();
  });

  it("fails closed on excessive stored conflict history", () => {
    const db = book();
    const project = saveWorkstationProject(db, { title: "Rules", brief: "Brief" });
    const a = approve(db, project.id, "Choose blue.");
    const b = approve(db, project.id, "Choose red.");
    const conflict = declare(db, project.id, a, b);
    const firstRevision = conflict.firstMemoryId === a.id ? a.revision : b.revision;
    const secondRevision = conflict.secondMemoryId === b.id ? b.revision : a.revision;
    const insert = db.prepare(`INSERT INTO workstation_project_memory_conflict_revision
      (conflict_id, revision, state, first_active_revision, second_active_revision,
       resolution, actor_id, reason, created_at)
      VALUES (?, ?, 'declared', ?, ?, NULL, 'owner', 'Recorded ruling', ?)`);
    for (let revision = 2; revision <= 101; revision += 1) {
      insert.run(conflict.id, revision, firstRevision, secondRevision, revision);
    }
    db.prepare("UPDATE workstation_project_memory_conflict SET head_revision = 101 WHERE id = ?")
      .run(conflict.id);
    expect(() => approvedProjectConstraints(db, project.id)).toThrow(/revision limit/u);
    db.close();
  });

  it("upgrades a populated v12 synthetic Book and preserves conflict history on restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "rellane-conflicts-"));
    const path = join(dir, "book.sqlite");
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS.filter((migration) => migration.version <= 12)) db.exec(migration.sql);
      const project = saveWorkstationProject(db, { title: "Existing", brief: "Keep me" });
      // Seed with the v12 shape itself; today's Book writer requires v14.
      const seedLegacyApproval = (id: string, body: string) => {
        db.prepare(`INSERT INTO workstation_project_memory_entry
          (id, project_id, kind, head_revision, active_revision, created_at)
          VALUES (?, ?, 'decision', 2, 2, 1)`).run(id, project.id);
        db.prepare(`INSERT INTO workstation_project_memory_revision
          (entry_id, revision, state, body, source_refs_json, created_by, created_at, approver_id, approved_at, reason)
          VALUES (?, 2, 'approved', ?, '[]', 'owner', 2, 'owner', 2, NULL)`).run(id, body);
        return { id, revision: 2 };
      };
      const a = seedLegacyApproval("legacy-serf", "Use serif.");
      const b = seedLegacyApproval("legacy-sans", "Use sans.");
      db.exec(MIGRATIONS.find((migration) => migration.version === 13)!.sql);
      db.exec(MIGRATIONS.find((migration) => migration.version === 14)!.sql);
      const conflict = declare(db, project.id, a, b);
      const revById = new Map([[a.id, a.revision], [b.id, b.revision]]);
      resolve(db, project.id, conflict.id, 1,
        revById.get(conflict.firstMemoryId)!, revById.get(conflict.secondMemoryId)!,
        { kind: "winner", winnerId: a.id });
      db.close();
      const reopened = new DatabaseSync(path);
      reopened.exec("PRAGMA foreign_keys = ON");
      expect(listProjectMemoryConflicts(reopened, project.id)[0]?.history).toHaveLength(2);
      expect(approvedProjectConstraints(reopened, project.id).map((row) => row.id)).toEqual([a.id]);
      expect(reopened.prepare("SELECT title, brief FROM workstation_project_revision WHERE project_id = ?")
        .get(project.id)).toMatchObject({ title: "Existing", brief: "Keep me" });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
