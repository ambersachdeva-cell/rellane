import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { appendTurn, openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { assignWorkstationProject, saveWorkstationProject } from "./projects.js";
import { WORKSTATION_SESSION_SEAT, saveSessionReceipt } from "./store.js";
import type { WorkstationSessionReceipt } from "./store.js";
import {
  MAX_MODEL_OUTCOME_RECEIPTS,
  readModelOutcomeEvidence
} from "./model-outcome-evidence-store.js";

function openBook(file = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

describe("model-outcome-evidence-store", () => {
  it("applies the receipt cap to the selected project, even when another project exceeds the global cap", () => {
    const db = openBook();
    try {
      const projectA = saveWorkstationProject(db, { title: "Small", brief: "One operation" });
      const projectB = saveWorkstationProject(db, { title: "Large", brief: "Many operations" });
      const caseA = openCase(db, { title: "Small case", question: "A" });
      const caseB = openCase(db, { title: "Large case", question: "B" });
      assignWorkstationProject(db, { caseId: caseA, projectId: projectA.id });
      assignWorkstationProject(db, { caseId: caseB, projectId: projectB.id });
      saveSessionReceipt(db, caseA, {
        version: 1, event: "finish", projectId: projectA.id, workspacePath: "/ws/a",
        snapshot: { operationId: "only-a", caseId: caseA, providerId: "codex",
          modelId: "model-a", sessionId: "s-a", status: "completed", startedAt: 1,
          updatedAt: 2, text: "", activity: [], permission: null, detail: "" }
      });

      const insert = db.prepare(`INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
        VALUES (?, ?, ?, ?, 'receipt', ?, ?)`);
      const body = JSON.stringify({ version: 1, event: "finish", projectId: projectB.id,
        workspacePath: "/ws/b", snapshot: { operationId: "only-b", caseId: caseB,
          providerId: "claude", modelId: "model-b", sessionId: "s-b", status: "completed",
          startedAt: 1, updatedAt: 2, text: "", activity: [], permission: null, detail: "" } });
      db.exec("BEGIN");
      for (let seq = 1; seq <= MAX_MODEL_OUTCOME_RECEIPTS + 1; seq += 1) {
        insert.run(`other-${seq}`, caseB, seq, WORKSTATION_SESSION_SEAT, body, seq);
      }
      db.exec("COMMIT");

      expect(readModelOutcomeEvidence(db, { projectId: projectA.id }).map((one) => one.operationId))
        .toEqual(["only-a"]);
      expect(() => readModelOutcomeEvidence(db, { projectId: projectB.id })).toThrow(/limit exceeded/i);
    } finally {
      db.close();
    }
  });

  it("ignores corrupt receipts in another linked project but fails closed for targeted corruption", () => {
    const db = openBook();
    try {
      const projectA = saveWorkstationProject(db, { title: "Healthy", brief: "A" });
      const projectB = saveWorkstationProject(db, { title: "Corrupt", brief: "B" });
      const caseA = openCase(db, { title: "Healthy case", question: "A" });
      const caseB = openCase(db, { title: "Corrupt case", question: "B" });
      assignWorkstationProject(db, { caseId: caseA, projectId: projectA.id });
      assignWorkstationProject(db, { caseId: caseB, projectId: projectB.id });
      saveSessionReceipt(db, caseA, {
        version: 1, event: "finish", projectId: projectA.id, workspacePath: "/ws/a",
        snapshot: { operationId: "healthy", caseId: caseA, providerId: "codex",
          modelId: "model-a", sessionId: "s-a", status: "completed", startedAt: 1,
          updatedAt: 2, text: "", activity: [], permission: null, detail: "" }
      });
      const insert = db.prepare(`INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
        VALUES (?, ?, ?, ?, 'receipt', ?, ?)`);
      insert.run("other-invalid-json", caseB, 1, WORKSTATION_SESSION_SEAT, "{ invalid", 3);
      insert.run("other-invalid-schema", caseB, 2, WORKSTATION_SESSION_SEAT,
        JSON.stringify({ version: 1, event: "invalid", projectId: projectB.id }), 4);

      expect(readModelOutcomeEvidence(db, { projectId: projectA.id }).map((one) => one.operationId))
        .toEqual(["healthy"]);
      expect(() => readModelOutcomeEvidence(db, { projectId: projectB.id })).toThrow(/corrupt/i);

      insert.run("target-invalid-json", caseA, 2, WORKSTATION_SESSION_SEAT, "{ invalid", 5);
      expect(() => readModelOutcomeEvidence(db, { projectId: projectA.id })).toThrow(/corrupt/i);
    } finally {
      db.close();
    }
  });

  it("enforces project and case scoping across assigned and unassigned cases", () => {
    const db = openBook(":memory:");
    try {
      const projectA = saveWorkstationProject(db, { title: "Project Alpha", brief: "Alpha brief" });
      const projectB = saveWorkstationProject(db, { title: "Project Beta", brief: "Beta brief" });

      const caseA1 = openCase(db, { title: "Case Alpha 1", question: "Question A1" });
      const caseA2 = openCase(db, { title: "Case Alpha 2", question: "Question A2" });
      const caseB = openCase(db, { title: "Case Beta 1", question: "Question B1" });
      const caseUnassigned = openCase(db, { title: "Case Unassigned", question: "Question U" });

      assignWorkstationProject(db, { caseId: caseA1, projectId: projectA.id });
      assignWorkstationProject(db, { caseId: caseA2, projectId: projectA.id });
      assignWorkstationProject(db, { caseId: caseB, projectId: projectB.id });

      // Operation 1 in Case A1 (Project A)
      saveSessionReceipt(db, caseA1, {
        version: 1,
        event: "start",
        workspacePath: "/ws/a1",
        projectId: projectA.id,
        snapshot: {
          operationId: "op-a1",
          caseId: caseA1,
          providerId: "codex",
          modelId: "gpt-4",
          sessionId: "s-a1",
          status: "starting",
          startedAt: 1000,
          updatedAt: 1000,
          text: "prompt a1",
          activity: [],
          permission: null,
          detail: ""
        }
      });
      saveSessionReceipt(db, caseA1, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/a1",
        projectId: projectA.id,
        snapshot: {
          operationId: "op-a1",
          caseId: caseA1,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4-0613",
          sessionId: "s-a1",
          status: "completed",
          startedAt: 1000,
          updatedAt: 1500,
          text: "answer a1",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Operation 2 in Case A2 (Project A)
      saveSessionReceipt(db, caseA2, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/a2",
        projectId: projectA.id,
        snapshot: {
          operationId: "op-a2",
          caseId: caseA2,
          providerId: "claude",
          modelId: "claude-3-opus",
          reportedModelId: "claude-3-opus-20240229",
          sessionId: "s-a2",
          status: "completed",
          startedAt: 2000,
          updatedAt: 2600,
          text: "answer a2",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Operation 3 in Case B (Project B)
      saveSessionReceipt(db, caseB, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/b",
        projectId: projectB.id,
        snapshot: {
          operationId: "op-b",
          caseId: caseB,
          providerId: "gemini1",
          modelId: "gemini-pro",
          reportedModelId: "gemini-1.0-pro",
          sessionId: "s-b",
          status: "completed",
          startedAt: 3000,
          updatedAt: 3700,
          text: "answer b",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Operation 4 in Case Unassigned (no project)
      saveSessionReceipt(db, caseUnassigned, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/u",
        snapshot: {
          operationId: "op-u",
          caseId: caseUnassigned,
          providerId: "codex",
          modelId: "gpt-4o",
          reportedModelId: "gpt-4o-2024-05-13",
          sessionId: "s-u",
          status: "completed",
          startedAt: 4000,
          updatedAt: 4400,
          text: "answer u",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Scope to Project A
      const evidenceA = readModelOutcomeEvidence(db, { projectId: projectA.id });
      expect(evidenceA.length).toBe(2);
      expect(evidenceA.map((e) => e.operationId).sort()).toEqual(["op-a1", "op-a2"]);
      expect(evidenceA.every((e) => e.projectId === projectA.id)).toBe(true);

      // Scope to Project B
      const evidenceB = readModelOutcomeEvidence(db, { projectId: projectB.id });
      expect(evidenceB.length).toBe(1);
      expect(evidenceB[0]?.operationId).toBe("op-b");
      expect(evidenceB[0]?.projectId).toBe(projectB.id);

      // Scope to unassigned cases (projectId: null)
      const evidenceUnassigned = readModelOutcomeEvidence(db, { projectId: null });
      expect(evidenceUnassigned.length).toBe(1);
      expect(evidenceUnassigned[0]?.operationId).toBe("op-u");
      expect(evidenceUnassigned[0]?.caseId).toBe(caseUnassigned);
      expect(evidenceUnassigned[0]?.projectId).toBeNull();

      // Scope by caseId
      const evidenceCaseA1 = readModelOutcomeEvidence(db, { caseId: caseA1 });
      expect(evidenceCaseA1.length).toBe(1);
      expect(evidenceCaseA1[0]?.operationId).toBe("op-a1");
      expect(evidenceCaseA1[0]?.projectId).toBe(projectA.id);

      // Scope mismatch: caseA1 exists in Project A, querying for Project B returns empty array
      const evidenceMismatch = readModelOutcomeEvidence(db, {
        caseId: caseA1,
        projectId: projectB.id
      });
      expect(evidenceMismatch).toEqual([]);

      // Unfiltered returns all operations
      const evidenceAll = readModelOutcomeEvidence(db);
      expect(evidenceAll.length).toBe(4);
      expect(evidenceAll.map((e) => e.operationId).sort()).toEqual(["op-a1", "op-a2", "op-b", "op-u"]);
    } finally {
      db.close();
    }
  });

  it("fails closed when a corrupt later terminal receipt occurs, preventing false completion", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Corrupt", brief: "Brief" });
      const caseId = openCase(db, { title: "Case Corrupt", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      // Valid start and completed receipts for operation "op-1"
      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "start",
        workspacePath: "/ws",
        projectId: project.id,
        snapshot: {
          operationId: "op-1",
          caseId,
          providerId: "codex",
          modelId: "gpt-4",
          sessionId: "s-1",
          status: "starting",
          startedAt: 1000,
          updatedAt: 1000,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws",
        projectId: project.id,
        snapshot: {
          operationId: "op-1",
          caseId,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-1",
          status: "completed",
          startedAt: 1000,
          updatedAt: 1500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Before corrupt turn, readModelOutcomeEvidence reports observedCompleted = true
      const initialEvidence = readModelOutcomeEvidence(db, { caseId });
      expect(initialEvidence.length).toBe(1);
      expect(initialEvidence[0]?.observedCompleted).toBe(true);

      // Now insert a corrupt later terminal receipt (invalid JSON syntax)
      db.prepare(
        `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, ?, ?, ?)`
      ).run(
        "turn-corrupt-terminal",
        caseId,
        caseId,
        WORKSTATION_SESSION_SEAT,
        "receipt",
        "{ invalid json claiming contradictory error/abort op-1",
        1600
      );

      // Read must fail closed: never silently ignore and falsely present op-1 as completed
      expect(() => readModelOutcomeEvidence(db, { caseId })).toThrow(/corrupt|invalid/i);

      // Also fails closed when queried by projectId
      expect(() => readModelOutcomeEvidence(db, { projectId: project.id })).toThrow(/corrupt|invalid/i);
    } finally {
      db.close();
    }
  });

  it("fails closed on cap overflow with no partial projection", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Bounded", brief: "Brief" });
      const caseId = openCase(db, { title: "Case Bounded", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      expect(MAX_MODEL_OUTCOME_RECEIPTS).toBe(5000);

      // Insert 30 completed receipts
      db.exec("BEGIN");
      const stmt = db.prepare(
        `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (let i = 1; i <= 30; i += 1) {
        const opId = `op-bulk-${String(i).padStart(4, "0")}`;
        const receipt: WorkstationSessionReceipt = {
          version: 1,
          event: "finish",
          workspacePath: "/ws",
          projectId: project.id,
          snapshot: {
            operationId: opId,
            caseId,
            providerId: "codex",
            modelId: "gpt-4",
            reportedModelId: "gpt-4",
            sessionId: `sess-${i}`,
            status: "completed",
            startedAt: 1000 + i,
            updatedAt: 2000 + i,
            text: "",
            activity: [],
            permission: null,
            detail: ""
          }
        };

        stmt.run(
          `turn-${i}`,
          caseId,
          i,
          WORKSTATION_SESSION_SEAT,
          "receipt",
          JSON.stringify(receipt),
          1000 + i
        );
      }
      db.exec("COMMIT");

      // Within limit (30 <= 30): succeeds
      const evidenceExact = readModelOutcomeEvidence(db, { caseId, maxReceipts: 30 });
      expect(evidenceExact.length).toBe(30);

      // Within limit (30 <= 50): succeeds
      const evidencePlenty = readModelOutcomeEvidence(db, { caseId, maxReceipts: 50 });
      expect(evidencePlenty.length).toBe(30);

      // Overflow limit (30 > 25): must fail closed, NO partial projection
      expect(() => readModelOutcomeEvidence(db, { caseId, maxReceipts: 25 })).toThrow(
        /limit exceeded|overflow/i
      );
    } finally {
      db.close();
    }
  });

  it("preserves historical project evidence on project reassignment without relabeling or erasure", () => {
    const db = openBook(":memory:");
    try {
      const projectA = saveWorkstationProject(db, { title: "Project Alpha", brief: "Alpha brief" });
      const projectB = saveWorkstationProject(db, { title: "Project Beta", brief: "Beta brief" });

      const caseId = openCase(db, { title: "Case Reassigned", question: "Question R" });

      // Initially case is assigned to Project Alpha
      assignWorkstationProject(db, { caseId, projectId: projectA.id });

      // Operation 1 performed and recorded while in Project Alpha
      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/reassigned",
        projectId: projectA.id,
        snapshot: {
          operationId: "op-alpha-historical",
          caseId,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-alpha",
          status: "completed",
          startedAt: 1000,
          updatedAt: 1500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Later, case is reassigned to Project Beta
      assignWorkstationProject(db, { caseId, projectId: projectB.id });

      // Operation 2 performed and recorded after reassignment to Project Beta
      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/reassigned",
        projectId: projectB.id,
        snapshot: {
          operationId: "op-beta-current",
          caseId,
          providerId: "gemini1",
          modelId: "gemini-pro",
          reportedModelId: "gemini-pro",
          sessionId: "s-beta",
          status: "completed",
          startedAt: 2000,
          updatedAt: 2500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Legacy receipt without recorded projectId in a case assigned to Project Beta
      const legacyCaseId = openCase(db, { title: "Case Legacy", question: "Question L" });
      assignWorkstationProject(db, { caseId: legacyCaseId, projectId: projectB.id });

      saveSessionReceipt(db, legacyCaseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/legacy",
        snapshot: {
          operationId: "op-beta-legacy",
          caseId: legacyCaseId,
          providerId: "claude",
          modelId: "claude-3-opus",
          reportedModelId: "claude-3-opus",
          sessionId: "s-legacy",
          status: "completed",
          startedAt: 3000,
          updatedAt: 3500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Querying Project Alpha: must preserve op-alpha-historical with truthful projectId
      const evidenceAlpha = readModelOutcomeEvidence(db, { projectId: projectA.id });
      expect(evidenceAlpha.length).toBe(1);
      expect(evidenceAlpha[0]?.operationId).toBe("op-alpha-historical");
      expect(evidenceAlpha[0]?.projectId).toBe(projectA.id);

      // Querying Project Beta: must include op-beta-current and op-beta-legacy, but NOT op-alpha-historical
      const evidenceBeta = readModelOutcomeEvidence(db, { projectId: projectB.id });
      expect(evidenceBeta.length).toBe(2);
      expect(evidenceBeta.map((e) => e.operationId).sort()).toEqual(["op-beta-current", "op-beta-legacy"]);
      expect(evidenceBeta.every((e) => e.projectId === projectB.id)).toBe(true);

      // Querying by caseId returns both operations with their respective recorded project IDs
      const evidenceCase = readModelOutcomeEvidence(db, { caseId });
      expect(evidenceCase.length).toBe(2);
      expect(Object.fromEntries(evidenceCase.map((e) => [e.operationId, e.projectId]))).toEqual({
        "op-alpha-historical": projectA.id,
        "op-beta-current": projectB.id
      });
    } finally {
      db.close();
    }
  });

  it("enforces case isolation and fails closed on mismatched receipt snapshot caseId", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Isolation", brief: "Brief" });
      const caseA = openCase(db, { title: "Case A", question: "Question A" });
      const caseB = openCase(db, { title: "Case B", question: "Question B" });
      assignWorkstationProject(db, { caseId: caseA, projectId: project.id });
      assignWorkstationProject(db, { caseId: caseB, projectId: project.id });

      // Valid receipt in Case B
      saveSessionReceipt(db, caseB, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/b",
        projectId: project.id,
        snapshot: {
          operationId: "op-valid-b",
          caseId: caseB,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-b",
          status: "completed",
          startedAt: 1000,
          updatedAt: 1500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Valid receipt in Case A
      saveSessionReceipt(db, caseA, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/a",
        projectId: project.id,
        snapshot: {
          operationId: "op-valid-a",
          caseId: caseA,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-a",
          status: "completed",
          startedAt: 2000,
          updatedAt: 2500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      // Mismatched receipt: turn inserted into Case A, but claiming snapshot.caseId = Case B
      const mismatchedReceipt: WorkstationSessionReceipt = {
        version: 1,
        event: "finish",
        workspacePath: "/ws/a",
        projectId: project.id,
        snapshot: {
          operationId: "op-mismatched",
          caseId: caseB,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-mismatch",
          status: "completed",
          startedAt: 3000,
          updatedAt: 3500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      };

      db.prepare(
        `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, ?, ?, ?)`
      ).run(
        "turn-mismatched-case",
        caseA,
        caseA,
        WORKSTATION_SESSION_SEAT,
        "receipt",
        JSON.stringify(mismatchedReceipt),
        3600
      );

      // Case B is isolated: does not read Case A turns, returns op-valid-b cleanly
      const evidenceB = readModelOutcomeEvidence(db, { caseId: caseB });
      expect(evidenceB.length).toBe(1);
      expect(evidenceB[0]?.operationId).toBe("op-valid-b");

      // Querying Case A must fail closed due to mismatched snapshot caseId
      expect(() => readModelOutcomeEvidence(db, { caseId: caseA })).toThrow(/mismatch/i);
    } finally {
      db.close();
    }
  });

  it("never exposes raw body, prompt, or answer text in returned evidence", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Secrets", brief: "Secret Brief" });
      const caseId = openCase(db, { title: "Case Secrets", question: "Top secret question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      const rawPrompt = "CONFIDENTIAL_USER_PROMPT_ALPHA_SECRET_98765";
      const rawAnswer = "CONFIDENTIAL_MODEL_ANSWER_OMEGA_SECRET_54321";
      const rawTurnBody = "CONFIDENTIAL_RAW_VERBATIM_TURN_BODY_99999";

      // Session receipt containing sensitive prompt, answer, detail, and activity
      const receipt: WorkstationSessionReceipt = {
        version: 1,
        event: "finish",
        workspacePath: "/ws/secret",
        projectId: project.id,
        snapshot: {
          operationId: "op-secret",
          caseId,
          providerId: "gemini1",
          modelId: "gemini-pro",
          reportedModelId: "gemini-pro",
          sessionId: "sess-secret",
          status: "completed",
          startedAt: 1000,
          updatedAt: 2500,
          text: rawPrompt,
          activity: ["Generated answer for prompt: " + rawPrompt],
          permission: null,
          detail: rawAnswer
        }
      };

      saveSessionReceipt(db, caseId, receipt);

      // Also append a verbatim turn with sensitive body to the case
      appendTurn(db, caseId, {
        seat: "owner",
        kind: "verbatim",
        body: rawTurnBody
      });

      // Verify evidence outcome objects have no raw body/text fields
      const evidenceList = readModelOutcomeEvidence(db, { caseId });
      expect(evidenceList.length).toBe(1);
      const evidence = evidenceList[0];
      expect(evidence).toBeDefined();

      const evidenceRecord = evidence as unknown as Record<string, unknown>;
      expect("body" in evidenceRecord).toBe(false);
      expect("text" in evidenceRecord).toBe(false);
      expect("detail" in evidenceRecord).toBe(false);
      expect("activity" in evidenceRecord).toBe(false);
      expect(evidenceRecord["body"]).toBeUndefined();
      expect(evidenceRecord["text"]).toBeUndefined();
      expect(evidenceRecord["detail"]).toBeUndefined();
      expect(evidenceRecord["activity"]).toBeUndefined();

      // Serialized evidence output must never contain raw prompt or answer strings
      const serialized = JSON.stringify(evidenceList);
      expect(serialized).not.toContain(rawPrompt);
      expect(serialized).not.toContain(rawAnswer);
      expect(serialized).not.toContain(rawTurnBody);

      // Evidence preserves necessary measured operation telemetry
      expect(evidence?.operationId).toBe("op-secret");
      expect(evidence?.caseId).toBe(caseId);
      expect(evidence?.projectId).toBe(project.id);
      expect(evidence?.providerId).toBe("gemini1");
      expect(evidence?.requestedModelId).toBe("gemini-pro");
      expect(evidence?.reportedModelId).toBe("gemini-pro");
      expect(evidence?.observedCompleted).toBe(true);
      expect(evidence?.durationMs).toBe(1500);
      expect(evidence?.startedAt).toBe(1000);
      expect(evidence?.endedAt).toBe(2500);
    } finally {
      db.close();
    }
  });

  it("fails closed on project query when a malformed later terminal receipt exists in an unlinked case", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Malformed", brief: "Brief" });
      const caseId = openCase(db, { title: "Case Unlinked", question: "Question" });

      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "start",
        workspacePath: "/ws/m",
        projectId: project.id,
        snapshot: {
          operationId: "op-proj",
          caseId,
          providerId: "codex",
          modelId: "gpt-4",
          sessionId: "s-proj",
          status: "starting",
          startedAt: 1000,
          updatedAt: 1000,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/m",
        projectId: project.id,
        snapshot: {
          operationId: "op-proj",
          caseId,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-proj",
          status: "completed",
          startedAt: 1000,
          updatedAt: 1500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      db.prepare(
        `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?), ?, ?, ?, ?)`
      ).run(
        "turn-malformed-terminal",
        caseId,
        caseId,
        WORKSTATION_SESSION_SEAT,
        "receipt",
        "{ invalid json terminal for op-proj without project link",
        1600
      );

      expect(() => readModelOutcomeEvidence(db, { projectId: project.id })).toThrow(/corrupt|invalid/i);
    } finally {
      db.close();
    }
  });

  it("distinguishes explicit null projectId from absent legacy field after linking case", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Linked", brief: "Linked brief" });
      const caseId = openCase(db, { title: "Case Linked", question: "Question L" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/linked",
        projectId: null,
        snapshot: {
          operationId: "op-explicit-null",
          caseId,
          providerId: "codex",
          modelId: "gpt-4",
          reportedModelId: "gpt-4",
          sessionId: "s-null",
          status: "completed",
          startedAt: 1000,
          updatedAt: 1500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      saveSessionReceipt(db, caseId, {
        version: 1,
        event: "finish",
        workspacePath: "/ws/linked",
        snapshot: {
          operationId: "op-legacy-absent",
          caseId,
          providerId: "claude",
          modelId: "claude-3-opus",
          reportedModelId: "claude-3-opus",
          sessionId: "s-legacy",
          status: "completed",
          startedAt: 2000,
          updatedAt: 2500,
          text: "",
          activity: [],
          permission: null,
          detail: ""
        }
      });

      const evidenceProject = readModelOutcomeEvidence(db, { projectId: project.id });
      expect(evidenceProject.length).toBe(1);
      expect(evidenceProject[0]?.operationId).toBe("op-legacy-absent");
      expect(evidenceProject[0]?.projectId).toBe(project.id);

      const evidenceNull = readModelOutcomeEvidence(db, { projectId: null });
      expect(evidenceNull.length).toBe(1);
      expect(evidenceNull[0]?.operationId).toBe("op-explicit-null");
      expect(evidenceNull[0]?.projectId).toBeNull();

      const evidenceCase = readModelOutcomeEvidence(db, { caseId });
      expect(evidenceCase.length).toBe(2);
      expect(Object.fromEntries(evidenceCase.map((e) => [e.operationId, e.projectId]))).toEqual({
        "op-explicit-null": null,
        "op-legacy-absent": project.id
      });
    } finally {
      db.close();
    }
  });
});
