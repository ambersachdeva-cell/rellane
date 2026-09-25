import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { eraseCase, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { assignWorkstationProject, saveWorkstationProject } from "./projects.js";
import { saveSessionReceipt } from "./store.js";
import {
  assertModelOutcomeEvidenceSnapshotCurrent,
  readModelOutcomeEvidenceSnapshot
} from "./model-outcome-evidence-store.js";

function book(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  return db;
}

function receipt(db: DatabaseSync, caseId: string, projectId?: string, operationId = "op-one") {
  saveSessionReceipt(db, caseId, {
    version: 1, event: "finish", workspacePath: "/synthetic",
    ...(projectId !== undefined ? { projectId } : {}),
    snapshot: {
      operationId, caseId, providerId: "codex", modelId: "listed-model",
      reportedModelId: "listed-model", sessionId: "synthetic-session",
      status: "completed", startedAt: 100, updatedAt: 200,
      text: "PRIVATE ANSWER", activity: [], permission: null,
      detail: "PRIVATE DETAIL"
    }
  });
}

describe("exact project model outcome evidence snapshot", () => {
  it("identifies exact receipt rows and link state, hashes raw bytes, and reveals no answer text", () => {
    const db = book();
    try {
      const project = saveWorkstationProject(db, { title: "One", brief: "One" });
      const caseId = openCase(db, { title: "Case", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      receipt(db, caseId, project.id);
      const row = db.prepare(
        "SELECT id, seq, body FROM case_turn WHERE case_id = ? AND kind = 'receipt'"
      ).get(caseId) as { id: string; seq: number; body: string };

      const snapshot = readModelOutcomeEvidenceSnapshot(db, project.id);
      expect(snapshot.receiptCount).toBe(1);
      expect(snapshot.operationCount).toBe(1);
      expect(snapshot.outcomes[0]).toMatchObject({ operationId: "op-one", observedCompleted: true });
      expect(snapshot.receiptRefs[0]).toMatchObject({
        caseTurnId: row.id, caseId, seq: row.seq,
        linkedProjectId: project.id, recordedProjectId: project.id,
        effectiveProjectId: project.id,
        bodySha256: createHash("sha256").update(row.body).digest("hex")
      });
      expect(assertModelOutcomeEvidenceSnapshotCurrent(db, snapshot).sha256).toBe(snapshot.sha256);
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE ANSWER");
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE DETAIL");

      const modified = JSON.parse(row.body) as Record<string, unknown>;
      const detail = modified["snapshot"] as Record<string, unknown>;
      detail["text"] = "A changed private answer";
      db.prepare("UPDATE case_turn SET body = ? WHERE id = ?")
        .run(JSON.stringify(modified), row.id);
      expect(() => assertModelOutcomeEvidenceSnapshotCurrent(db, snapshot))
        .toThrow(/Stale model outcome snapshot/);
      expect(readModelOutcomeEvidenceSnapshot(db, project.id).outcomes[0]?.observedCompleted).toBe(true);
    } finally {
      db.close();
    }
  });

  it("invalidates on legacy case relink and on changed link identity even for recorded project receipts", () => {
    const db = book();
    try {
      const first = saveWorkstationProject(db, { title: "First", brief: "First" });
      const second = saveWorkstationProject(db, { title: "Second", brief: "Second" });
      const legacyCase = openCase(db, { title: "Legacy", question: "Q" });
      assignWorkstationProject(db, { caseId: legacyCase, projectId: first.id });
      receipt(db, legacyCase);
      const legacySnapshot = readModelOutcomeEvidenceSnapshot(db, first.id);
      expect(legacySnapshot.receiptRefs[0]?.recordedProjectId).toBe("legacy_absent");
      assignWorkstationProject(db, { caseId: legacyCase, projectId: second.id });
      expect(() => assertModelOutcomeEvidenceSnapshotCurrent(db, legacySnapshot))
        .toThrow(/Stale model outcome snapshot/);
      expect(readModelOutcomeEvidenceSnapshot(db, second.id).operationCount).toBe(1);

      const recordedCase = openCase(db, { title: "Recorded", question: "Q" });
      assignWorkstationProject(db, { caseId: recordedCase, projectId: first.id });
      receipt(db, recordedCase, first.id, "recorded-op");
      const recordedSnapshot = readModelOutcomeEvidenceSnapshot(db, first.id);
      assignWorkstationProject(db, { caseId: recordedCase, projectId: second.id });
      expect(() => assertModelOutcomeEvidenceSnapshotCurrent(db, recordedSnapshot))
        .toThrow(/Stale model outcome snapshot/);
      expect(readModelOutcomeEvidenceSnapshot(db, first.id).outcomes.map((one) => one.operationId))
        .toContain("recorded-op");
      expect(readModelOutcomeEvidenceSnapshot(db, second.id).outcomes.map((one) => one.operationId))
        .not.toContain("recorded-op");
    } finally {
      db.close();
    }
  });

  it("refuses missing, malformed, and foreign source identity", () => {
    const db = book();
    try {
      const first = saveWorkstationProject(db, { title: "First", brief: "First" });
      const second = saveWorkstationProject(db, { title: "Second", brief: "Second" });
      const caseId = openCase(db, { title: "Case", question: "Q" });
      assignWorkstationProject(db, { caseId, projectId: first.id });
      receipt(db, caseId, first.id);
      const snapshot = readModelOutcomeEvidenceSnapshot(db, first.id);
      expect(() => assertModelOutcomeEvidenceSnapshotCurrent(db, {
        ...snapshot, projectId: second.id
      })).toThrow(/Stale model outcome snapshot/);
      db.prepare("UPDATE case_turn SET body = ? WHERE id = ?")
        .run("{ malformed", snapshot.receiptRefs[0]!.caseTurnId);
      expect(() => readModelOutcomeEvidenceSnapshot(db, first.id)).toThrow(/Corrupt receipt/);
      db.prepare("DELETE FROM case_turn WHERE id = ?").run(snapshot.receiptRefs[0]!.caseTurnId);
      expect(() => assertModelOutcomeEvidenceSnapshotCurrent(db, snapshot))
        .toThrow(/Stale model outcome snapshot/);
      db.prepare("DELETE FROM workstation_project WHERE id = ?").run(first.id);
      expect(() => readModelOutcomeEvidenceSnapshot(db, first.id))
        .toThrow(/does not exist or was forgotten/);
    } finally {
      db.close();
    }
  });

  it("invalidates when the owner erases the source Case and its linked receipt turns", () => {
    const db = book();
    try {
      const project = saveWorkstationProject(db, { title: "Project", brief: "Brief" });
      const caseId = openCase(db, { title: "Source", question: "Q" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      receipt(db, caseId, project.id);
      const snapshot = readModelOutcomeEvidenceSnapshot(db, project.id);
      expect(snapshot.receiptCount).toBe(1);
      expect(eraseCase(db, caseId)).toBe(true);
      expect(() => assertModelOutcomeEvidenceSnapshotCurrent(db, snapshot))
        .toThrow(/Stale model outcome snapshot/);
      expect(readModelOutcomeEvidenceSnapshot(db, project.id).receiptCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("fails closed above the selected receipt or operation bound without partial advice evidence", () => {
    const db = book();
    try {
      const project = saveWorkstationProject(db, { title: "Bound", brief: "Bound" });
      const caseId = openCase(db, { title: "Case", question: "Q" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      receipt(db, caseId, project.id, "first");
      receipt(db, caseId, project.id, "second");
      expect(() => readModelOutcomeEvidenceSnapshot(db, project.id, 1))
        .toThrow(/limit exceeded/);
      for (let index = 2; index < 201; index += 1) {
        receipt(db, caseId, project.id, `more-${index}`);
      }
      expect(() => readModelOutcomeEvidenceSnapshot(db, project.id))
        .toThrow(/operation bound exceeded/);
    } finally {
      db.close();
    }
  });
});
