import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { buildWorkstationContext } from "./context.js";
import { saveWorkstationProject, assignWorkstationProject } from "./projects.js";
import { approvedProjectConstraints, forgetProjectMemory, projectMemoryEpoch, proposeProjectMemory, reviewProjectMemory } from "./project-memory-book.js";
import {
  markContextDispatchAttempt,
  readContextSnapshot,
  redactContextSnapshotsForMemory,
  restoreContextSnapshot,
  saveContextSnapshot
} from "./context-snapshot-store.js";

function openBook(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  return db;
}

describe("durable reviewed context", () => {
  it("keeps exact approved bytes and a dispatch attempt, then forgets referenced packets atomically across restart", () => {
    const folder = mkdtempSync(join(tmpdir(), "rellane-context-"));
    const file = join(folder, "book.db");
    let db: DatabaseSync | null = null;
    try {
      db = openBook(file);
      const project = saveWorkstationProject(db, { title: "Project A", brief: "Brief" });
      const other = saveWorkstationProject(db, { title: "Project B", brief: "Other" });
      const caseId = openCase(db, { title: "Case A", question: "Question" });
      const otherCase = openCase(db, { title: "Case B", question: "Other" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      assignWorkstationProject(db, { caseId: otherCase, projectId: other.id });

      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "exclusion", text: "Do not disclose Ω secret.\nSecond line.", actorId: "owner"
      });
      const approved = reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner", reason: "Sensitive reason to erase"
      });
      const constraints = approvedProjectConstraints(db, project.id);
      const context = buildWorkstationContext({ prompt: "Answer", sources: [], acceptedConstraints: constraints });
      const saved = saveContextSnapshot(db, {
        id: "snapshot-a", caseId, projectId: project.id, memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "codex", modelId: "selected-model", packet: context.packet,
        manifest: { preview: context.preview, sourceIds: [], omitted: [],
          constraints: [{ id: proposed.id, revision: approved.revision }] }
      }, 100);
      expect(saved.packet).toBe(context.packet);
      const parsed = JSON.parse(saved.packet!) as { constraints: readonly { text: string }[] };
      expect(parsed.constraints[0]?.text).toBe("Do not disclose Ω secret.\nSecond line.");
      expect(saved.packetHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(saved.modelId).toBe("selected-model");
      expect(saved.dispatchAttemptedAt).toBeNull();
      expect(() => saveContextSnapshot(db!, { ...saved, packet: "changed", manifest: saved.manifest! }, 101))
        .toThrow(/already belongs|hash|scope/u);

      const otherPacket = buildWorkstationContext({ prompt: "Other project", sources: [] });
      saveContextSnapshot(db, {
        id: "snapshot-b", caseId: otherCase, projectId: other.id,
        memoryEpoch: projectMemoryEpoch(db, other.id), providerId: "claude", modelId: null,
        packet: otherPacket.packet,
        manifest: { preview: otherPacket.preview, sourceIds: [], omitted: [], constraints: [] }
      }, 102);
      expect(() => readContextSnapshot(db!, "snapshot-a", otherCase, other.id)).toThrow(/scope mismatch/u);
      markContextDispatchAttempt(db, "snapshot-a", caseId, project.id, 103);
      expect(readContextSnapshot(db, "snapshot-a", caseId, project.id)?.dispatchAttemptedAt).toBe(103);

      const candidate = proposeProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: approved.revision,
        kind: "exclusion", text: "Candidate is not approved", actorId: "owner"
      });
      expect(approvedProjectConstraints(db, project.id)[0]?.text).toBe("Do not disclose Ω secret.\nSecond line.");
      expect(() => markContextDispatchAttempt(db!, "snapshot-a", caseId, project.id, 104))
        .toThrow(/memory changed|stale|Project memory changed/u);
      forgetProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: candidate.revision, actorId: "owner"
      }, 105);
      const forgotten = readContextSnapshot(db, "snapshot-a", caseId, project.id);
      expect(forgotten).toMatchObject({ packet: null, manifest: null, redactedAt: 105, dispatchAttemptedAt: 103 });
      expect(readContextSnapshot(db, "snapshot-b", otherCase, other.id)?.packet).toBe(otherPacket.packet);
      const reasons = db.prepare("SELECT reason, body FROM workstation_project_memory_revision WHERE entry_id = ?")
        .all(proposed.id) as unknown as readonly { reason: string | null; body: string }[];
      expect(reasons.every((row) => row.reason === null && row.body === "")).toBe(true);
      db.close(); db = null;

      const reopened = new DatabaseSync(file);
      db = reopened;
      reopened.exec("PRAGMA foreign_keys = ON");
      expect(readContextSnapshot(reopened, "snapshot-a", caseId, project.id)).toMatchObject({
        packet: null, manifest: null, redactedAt: 105, dispatchAttemptedAt: 103
      });
      expect(readContextSnapshot(reopened, "snapshot-b", otherCase, other.id)?.packet).toBe(otherPacket.packet);
      expect(() => markContextDispatchAttempt(reopened, "snapshot-a", caseId, project.id, 106))
        .toThrow(/unavailable/u);
    } finally {
      db?.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("verifies and restores exact immutable packet and manifest for matching scope, provider, and model", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Alpha", brief: "Brief" });
      const caseId = openCase(db, { title: "Case Alpha", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "instruction", text: "Always quote sources.", actorId: "owner"
      });
      const approved = reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner", reason: "Standard rule"
      });

      const constraints = approvedProjectConstraints(db, project.id);
      const context = buildWorkstationContext({ prompt: "Solve issue", sources: [], acceptedConstraints: constraints });
      saveContextSnapshot(db, {
        id: "snapshot-exact",
        caseId,
        projectId: project.id,
        memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "openai",
        modelId: "gpt-5",
        packet: context.packet,
        manifest: {
          preview: context.preview,
          sourceIds: ["source-1", "source-2"],
          omitted: ["omitted-item"],
          constraints: [{ id: proposed.id, revision: approved.revision }]
        }
      }, 100);

      const restored = restoreContextSnapshot(db, "snapshot-exact", caseId, project.id, "openai", "gpt-5");
      expect(restored.packet).toBe(context.packet);
      expect(restored.manifest.preview).toBe(context.preview);
      expect(restored.manifest.sourceIds).toEqual(["source-1", "source-2"]);
      expect(restored.manifest.omitted).toEqual(["omitted-item"]);
      expect(restored.manifest.constraints).toEqual([{ id: proposed.id, revision: approved.revision }]);
      expect(restored.providerId).toBe("openai");
      expect(restored.modelId).toBe("gpt-5");

      const restoredViaQuery = restoreContextSnapshot(db, {
        id: "snapshot-exact",
        caseId,
        projectId: project.id,
        providerId: "openai",
        modelId: "gpt-5"
      });
      expect(restoredViaQuery.packet).toBe(restored.packet);
      expect(restoredViaQuery.packetHash).toBe(restored.packetHash);

      // Omitted model in positional and query skips model comparison
      const restoredOmittedPositional = restoreContextSnapshot(db, "snapshot-exact", caseId, project.id, "openai");
      expect(restoredOmittedPositional.packet).toBe(context.packet);
      expect(restoredOmittedPositional.modelId).toBe("gpt-5");

      const restoredOmittedQuery = restoreContextSnapshot(db, {
        id: "snapshot-exact",
        caseId,
        projectId: project.id,
        providerId: "openai"
      });
      expect(restoredOmittedQuery.packet).toBe(context.packet);
      expect(restoredOmittedQuery.modelId).toBe("gpt-5");

      expect(Object.isFrozen(restored)).toBe(true);
      expect(Object.isFrozen(restored.manifest)).toBe(true);
      expect(Object.isFrozen(restored.manifest.sourceIds)).toBe(true);
      expect(Object.isFrozen(restored.manifest.omitted)).toBe(true);
      expect(Object.isFrozen(restored.manifest.constraints)).toBe(true);
      expect(Object.isFrozen(restored.manifest.constraints[0])).toBe(true);

      const unassignedCaseId = openCase(db, { title: "Unassigned Case", question: "Prompt" });
      const unassignedContext = buildWorkstationContext({ prompt: "Unassigned prompt", sources: [] });
      saveContextSnapshot(db, {
        id: "snapshot-unassigned",
        caseId: unassignedCaseId,
        projectId: null,
        memoryEpoch: 0,
        providerId: "anthropic",
        modelId: null,
        packet: unassignedContext.packet,
        manifest: { preview: unassignedContext.preview, sourceIds: [], omitted: [], constraints: [] }
      }, 110);

      const restoredUnassigned = restoreContextSnapshot(db, "snapshot-unassigned", unassignedCaseId, null, "anthropic", null);
      expect(restoredUnassigned.packet).toBe(unassignedContext.packet);
      expect(restoredUnassigned.projectId).toBeNull();
      expect(restoredUnassigned.modelId).toBeNull();

      const restoredUnassignedQuery = restoreContextSnapshot(db, {
        id: "snapshot-unassigned",
        caseId: unassignedCaseId,
        projectId: null,
        providerId: "anthropic",
        modelId: null
      });
      expect(restoredUnassignedQuery.modelId).toBeNull();

      const restoredUnassignedOmitted = restoreContextSnapshot(db, "snapshot-unassigned", unassignedCaseId, null, "anthropic");
      expect(restoredUnassignedOmitted.modelId).toBeNull();

      const restoredUnassignedOmittedQuery = restoreContextSnapshot(db, {
        id: "snapshot-unassigned",
        caseId: unassignedCaseId,
        projectId: null,
        providerId: "anthropic"
      });
      expect(restoredUnassignedOmittedQuery.modelId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("fails closed on scope, provider, model mismatch, or missing snapshot", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Mismatch", brief: "Brief" });
      const otherProject = saveWorkstationProject(db, { title: "Other Project", brief: "Other" });
      const caseId = openCase(db, { title: "Case Scope", question: "Question" });
      const otherCaseId = openCase(db, { title: "Other Case", question: "Other Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      assignWorkstationProject(db, { caseId: otherCaseId, projectId: otherProject.id });

      const context = buildWorkstationContext({ prompt: "Scope test", sources: [] });
      saveContextSnapshot(db, {
        id: "snapshot-scope",
        caseId,
        projectId: project.id,
        memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "openai",
        modelId: "gpt-4o",
        packet: context.packet,
        manifest: { preview: context.preview, sourceIds: [], omitted: [], constraints: [] }
      }, 100);

      expect(() => restoreContextSnapshot(db, "nonexistent", caseId, project.id, "openai", "gpt-4o"))
        .toThrow(/unavailable/u);
      expect(() => restoreContextSnapshot(db, "snapshot-scope", otherCaseId, project.id, "openai", "gpt-4o"))
        .toThrow(/scope mismatch/u);
      expect(() => restoreContextSnapshot(db, "snapshot-scope", caseId, otherProject.id, "openai", "gpt-4o"))
        .toThrow(/scope mismatch/u);
      expect(() => restoreContextSnapshot(db, "snapshot-scope", caseId, project.id, "anthropic", "gpt-4o"))
        .toThrow(/provider mismatch/u);
      expect(() => restoreContextSnapshot(db, "snapshot-scope", caseId, project.id, "openai", "other-model"))
        .toThrow(/model mismatch/u);
      expect(() => restoreContextSnapshot(db, {
        id: "snapshot-scope",
        caseId,
        projectId: project.id,
        providerId: "openai",
        modelId: "other-model"
      })).toThrow(/model mismatch/u);
      expect(() => restoreContextSnapshot(db, "snapshot-scope", caseId, project.id, "openai", null))
        .toThrow(/model mismatch/u);
      expect(() => restoreContextSnapshot(db, {
        id: "snapshot-scope",
        caseId,
        projectId: project.id,
        providerId: "openai",
        modelId: null
      })).toThrow(/model mismatch/u);

      expect(restoreContextSnapshot(db, "snapshot-scope", caseId, project.id, "openai").modelId).toBe("gpt-4o");
      expect(restoreContextSnapshot(db, {
        id: "snapshot-scope",
        caseId,
        projectId: project.id,
        providerId: "openai"
      }).modelId).toBe("gpt-4o");
    } finally {
      db.close();
    }
  });

  it("rejects malformed manifests before saving a reviewed packet", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Manifest validation", brief: "Brief" });
      const caseId = openCase(db, { title: "Manifest case", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });
      const base = {
        caseId, projectId: project.id, memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "codex", modelId: null, packet: "Exact reviewed packet"
      };
      const invalid: readonly { readonly manifest: unknown; readonly error: RegExp }[] = [
        { manifest: null, error: /Malformed context snapshot manifest/u },
        { manifest: { preview: "P", sourceIds: ["same", "same"], omitted: [], constraints: [] },
          error: /invalid or duplicate source IDs/u },
        { manifest: { preview: "P", sourceIds: [], omitted: [42], constraints: [] },
          error: /Malformed context snapshot manifest/u },
        { manifest: { preview: "P", sourceIds: [], omitted: [], constraints: [null] },
          error: /Malformed context snapshot constraint reference/u },
        { manifest: { preview: "P", sourceIds: [], omitted: [],
          constraints: [{ id: "same", revision: 1 }, { id: "same", revision: 1 }] },
          error: /duplicate constraint IDs/u }
      ];
      for (const [index, candidate] of invalid.entries()) {
        const id = `invalid-manifest-${index}`;
        expect(() => saveContextSnapshot(db, {
          ...base, id,
          manifest: candidate.manifest as Parameters<typeof saveContextSnapshot>[1]["manifest"]
        }, 100)).toThrow(candidate.error);
        expect(db.prepare("SELECT id FROM workstation_context_snapshot WHERE id = ?").get(id)).toBeUndefined();
      }

      const valid = { ...base, id: "valid-null-model", manifest: {
        preview: "P", sourceIds: [], omitted: [], constraints: []
      } };
      const saved = saveContextSnapshot(db, valid, 100);
      expect(saveContextSnapshot(db, valid, 101)).toEqual(saved);
    } finally {
      db.close();
    }
  });

  it("fails closed on corrupt hash, tampered packet, malformed manifest, or corrupted constraint links", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Corrupt", brief: "Brief" });
      const caseId = openCase(db, { title: "Case Corrupt", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "decision", text: "Use Postgres for storage.", actorId: "owner"
      });
      const approved = reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner"
      });

      const constraints = approvedProjectConstraints(db, project.id);
      const context = buildWorkstationContext({ prompt: "Data layer", sources: [], acceptedConstraints: constraints });
      const validManifest = {
        preview: context.preview,
        sourceIds: ["source-doc"],
        omitted: [],
        constraints: [{ id: proposed.id, revision: approved.revision }]
      };

      const saved = saveContextSnapshot(db, {
        id: "snapshot-tamper",
        caseId,
        projectId: project.id,
        memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "codex",
        modelId: "code-davinci",
        packet: context.packet,
        manifest: validManifest
      }, 100);
      const originalHash = saved.packetHash;

      const resetValid = () => {
        db.prepare(`UPDATE workstation_context_snapshot
          SET packet = ?, packet_hash = ?, manifest_json = ?
          WHERE id = 'snapshot-tamper'`).run(context.packet, originalHash, JSON.stringify(validManifest));
        db.prepare("DELETE FROM workstation_context_snapshot_constraint WHERE snapshot_id = 'snapshot-tamper'").run();
        db.prepare("INSERT INTO workstation_context_snapshot_constraint (snapshot_id, memory_id, revision) VALUES ('snapshot-tamper', ?, ?)")
          .run(proposed.id, approved.revision);
      };

      resetValid();
      db.prepare("UPDATE workstation_context_snapshot SET packet = 'altered byte stream' WHERE id = 'snapshot-tamper'").run();
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/hash mismatch/u);

      resetValid();
      db.prepare("UPDATE workstation_context_snapshot SET packet_hash = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff' WHERE id = 'snapshot-tamper'").run();
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/hash mismatch/u);

      resetValid();
      db.prepare("UPDATE workstation_context_snapshot SET manifest_json = '{malformed' WHERE id = 'snapshot-tamper'").run();
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/Malformed context snapshot manifest/u);

      resetValid();
      const duplicateSourcesManifest = { ...validManifest, sourceIds: ["source-doc", "source-doc"] };
      db.prepare("UPDATE workstation_context_snapshot SET manifest_json = ? WHERE id = 'snapshot-tamper'").run(JSON.stringify(duplicateSourcesManifest));
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/invalid or duplicate source IDs/u);

      resetValid();
      const emptySourceManifest = { ...validManifest, sourceIds: [""] };
      db.prepare("UPDATE workstation_context_snapshot SET manifest_json = ? WHERE id = 'snapshot-tamper'").run(JSON.stringify(emptySourceManifest));
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/invalid or duplicate source IDs/u);

      resetValid();
      const duplicateConstraintManifest = {
        ...validManifest,
        constraints: [{ id: proposed.id, revision: approved.revision }, { id: proposed.id, revision: approved.revision }]
      };
      db.prepare("UPDATE workstation_context_snapshot SET manifest_json = ? WHERE id = 'snapshot-tamper'").run(JSON.stringify(duplicateConstraintManifest));
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/duplicate constraint IDs/u);

      resetValid();
      db.prepare("DELETE FROM workstation_context_snapshot_constraint WHERE snapshot_id = 'snapshot-tamper'").run();
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/constraint links disagree with manifest/u);

      resetValid();
      db.prepare("UPDATE workstation_context_snapshot_constraint SET revision = ? WHERE snapshot_id = 'snapshot-tamper'")
        .run(approved.revision + 5);
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/constraint links disagree with manifest/u);

      resetValid();
      db.prepare("INSERT INTO workstation_context_snapshot_constraint (snapshot_id, memory_id, revision) VALUES ('snapshot-tamper', 'extra-id', 1)").run();
      expect(() => restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci"))
        .toThrow(/constraint links disagree with manifest/u);

      resetValid();
      expect(restoreContextSnapshot(db, "snapshot-tamper", caseId, project.id, "codex", "code-davinci").packet)
        .toBe(context.packet);
    } finally {
      db.close();
    }
  });

  it("fails closed when case closes, project link changes, epoch changes, or constraint is revoked", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Revoke", brief: "Brief" });
      const otherProject = saveWorkstationProject(db, { title: "Other Revoke Project", brief: "Other" });
      const caseId = openCase(db, { title: "Case Revoke", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "exclusion", text: "Exclude internal metrics.", actorId: "owner"
      });
      const approved = reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner"
      });

      const constraints = approvedProjectConstraints(db, project.id);
      const context = buildWorkstationContext({ prompt: "Security check", sources: [], acceptedConstraints: constraints });
      saveContextSnapshot(db, {
        id: "snapshot-revocation",
        caseId,
        projectId: project.id,
        memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "openai",
        modelId: "gpt-4",
        packet: context.packet,
        manifest: { preview: context.preview, sourceIds: [], omitted: [], constraints: [{ id: proposed.id, revision: approved.revision }] }
      }, 100);

      expect(restoreContextSnapshot(db, "snapshot-revocation", caseId, project.id, "openai", "gpt-4").packet).toBe(context.packet);

      db.prepare("UPDATE work_case SET closed_at = 200, closed_as = 'settled' WHERE id = ?").run(caseId);
      expect(() => restoreContextSnapshot(db, "snapshot-revocation", caseId, project.id, "openai", "gpt-4"))
        .toThrow(/unavailable/u);
      db.prepare("UPDATE work_case SET closed_at = NULL, closed_as = NULL WHERE id = ?").run(caseId);

      assignWorkstationProject(db, { caseId, projectId: otherProject.id });
      expect(() => restoreContextSnapshot(db, "snapshot-revocation", caseId, project.id, "openai", "gpt-4"))
        .toThrow(/changed projects/u);
      assignWorkstationProject(db, { caseId, projectId: project.id });

      db.prepare("UPDATE workstation_project SET memory_epoch = memory_epoch + 1 WHERE id = ?").run(project.id);
      expect(() => restoreContextSnapshot(db, "snapshot-revocation", caseId, project.id, "openai", "gpt-4"))
        .toThrow(/Project memory changed/u);
      db.prepare("UPDATE workstation_project SET memory_epoch = memory_epoch - 1 WHERE id = ?").run(project.id);

      db.prepare("UPDATE workstation_project_memory_revision SET state = 'rejected' WHERE entry_id = ? AND revision = ?")
        .run(proposed.id, approved.revision);
      expect(() => restoreContextSnapshot(db, "snapshot-revocation", caseId, project.id, "openai", "gpt-4"))
        .toThrow(/not an active approval/u);
    } finally {
      db.close();
    }
  });

  it("fails closed on redaction and ensures markContextDispatchAttempt does not mark on verification failure", () => {
    const db = openBook(":memory:");
    try {
      const project = saveWorkstationProject(db, { title: "Project Redact", brief: "Brief" });
      const caseId = openCase(db, { title: "Case Redact", question: "Question" });
      assignWorkstationProject(db, { caseId, projectId: project.id });

      const proposed = proposeProjectMemory(db, {
        projectId: project.id, kind: "instruction", text: "Must enforce sandbox.", actorId: "owner"
      });
      const approved = reviewProjectMemory(db, {
        projectId: project.id, id: proposed.id, expectedRevision: proposed.revision,
        decision: "approve", actorId: "owner"
      });

      const constraints = approvedProjectConstraints(db, project.id);
      const context = buildWorkstationContext({ prompt: "Sandbox prompt", sources: [], acceptedConstraints: constraints });
      saveContextSnapshot(db, {
        id: "snapshot-redact-test",
        caseId,
        projectId: project.id,
        memoryEpoch: projectMemoryEpoch(db, project.id),
        providerId: "openai",
        modelId: "gpt-4",
        packet: context.packet,
        manifest: { preview: context.preview, sourceIds: [], omitted: [], constraints: [{ id: proposed.id, revision: approved.revision }] }
      }, 100);

      db.prepare("UPDATE workstation_context_snapshot SET packet = 'corrupt' WHERE id = 'snapshot-redact-test'").run();
      expect(() => markContextDispatchAttempt(db, "snapshot-redact-test", caseId, project.id, 200))
        .toThrow(/hash mismatch/u);
      const unattempted = db.prepare("SELECT dispatch_attempted_at AS at FROM workstation_context_snapshot WHERE id = 'snapshot-redact-test'")
        .get() as { at: number | null };
      expect(unattempted.at).toBeNull();

      db.prepare("UPDATE workstation_context_snapshot SET packet = ? WHERE id = 'snapshot-redact-test'").run(context.packet);
      expect(() => markContextDispatchAttempt(db, "snapshot-redact-test", caseId, project.id, 201, "wrong-provider"))
        .toThrow(/provider mismatch/u);
      const stillUnattempted = db.prepare("SELECT dispatch_attempted_at AS at FROM workstation_context_snapshot WHERE id = 'snapshot-redact-test'")
        .get() as { at: number | null };
      expect(stillUnattempted.at).toBeNull();

      markContextDispatchAttempt(db, "snapshot-redact-test", caseId, project.id, 202, "openai", "gpt-4");
      const attempted = db.prepare("SELECT dispatch_attempted_at AS at FROM workstation_context_snapshot WHERE id = 'snapshot-redact-test'")
        .get() as { at: number | null };
      expect(attempted.at).toBe(202);

      const redactedCount = redactContextSnapshotsForMemory(db, project.id, proposed.id, 300);
      expect(redactedCount).toBe(1);

      expect(() => restoreContextSnapshot(db, "snapshot-redact-test", caseId, project.id, "openai", "gpt-4"))
        .toThrow(/unavailable/u);
      expect(() => markContextDispatchAttempt(db, "snapshot-redact-test", caseId, project.id, 301))
        .toThrow(/unavailable/u);

      const historical = readContextSnapshot(db, "snapshot-redact-test", caseId, project.id);
      expect(historical).not.toBeNull();
      expect(historical?.packet).toBeNull();
      expect(historical?.manifest).toBeNull();
      expect(historical?.redactedAt).toBe(300);
      expect(historical?.dispatchAttemptedAt).toBe(202);
    } finally {
      db.close();
    }
  });
});
