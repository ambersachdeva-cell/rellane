import { DatabaseSync } from "node:sqlite";
import type { WorkstationProvider } from "@cadrane/contracts";
import { describe, expect, it } from "vitest";
import { openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { adviseSoloModelChoice } from "./model-choice-advisor.js";
import {
  MAX_MODEL_ADAPTATION_PROPOSALS_PER_PROJECT,
  MODEL_ADAPTATION_PROPOSAL_TTL_MS,
  acceptModelAdaptation,
  identifyModelCatalog,
  proposeModelAdaptation
} from "./model-adaptation-policy.js";
import { forgetProjectModelPreferences, getProjectModelPreferences,
  listProjectModelPreferenceHistory, saveProjectModelPreferences } from "./model-project-preferences-store.js";
import { assignWorkstationProject, saveWorkstationProject } from "./projects.js";
import { saveSessionReceipt } from "./store.js";

const providers: readonly WorkstationProvider[] = [
  { id: "codex", label: "Codex", family: "codex", state: "detected", detail: "Synthetic",
    models: [{ id: "measured", label: "Measured" }, { id: "other", label: "Other" }],
    canResume: true, canApproveTools: true },
  { id: "gemini1", label: "Gemini", family: "gemini", state: "unavailable", detail: "Synthetic",
    models: [{ id: "unavailable", label: "Unavailable" }],
    canResume: true, canApproveTools: false }
];

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const projectId = saveWorkstationProject(db, { title: "Project", brief: "Brief" }).id;
  const caseId = openCase(db, { title: "Case", question: "Question" });
  assignWorkstationProject(db, { caseId, projectId });
  return { db, projectId, caseId };
}

function addOutcomes(db: DatabaseSync, caseId: string, projectId: string, completedCount: number) {
  for (let index = 0; index < 10; index += 1) {
    saveSessionReceipt(db, caseId, {
      version: 1, event: "finish", projectId, workspacePath: "/synthetic",
      snapshot: { operationId: `operation-${index}`, caseId, providerId: "codex",
        modelId: "measured", reportedModelId: "measured", sessionId: `session-${index}`,
        status: index < completedCount ? "completed" : "failed",
        startedAt: 100, updatedAt: 200, text: "PRIVATE ANSWER", activity: [],
        permission: null, detail: "PRIVATE DETAIL" }
    });
  }
}

describe("reviewed model adaptation policy", () => {
  it("proposes a small measured advice weight and accepts only the exact reviewed proposal", () => {
    const { db, projectId, caseId } = setup();
    try {
      saveProjectModelPreferences(db, { projectId, expectedRevision: 0,
        preferences: { exclusions: [{ providerId: "gemini1" }], providerWeights: { codex: 1.2 } }
      }, 1000);
      addOutcomes(db, caseId, projectId, 10);
      const catalog = identifyModelCatalog(providers);
      const proposal = proposeModelAdaptation(db, projectId, catalog, 2000);
      expect(proposal).not.toBeNull();
      expect(proposal).toMatchObject({ projectId, baseRevision: 1, evidenceOperations: 10,
        delta: { kind: "model_weight", providerId: "codex", modelId: "measured", from: 1, to: 1.1 } });
      expect(JSON.stringify(proposal)).not.toContain("PRIVATE ANSWER");
      expect(getProjectModelPreferences(db, projectId)?.revision).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_project_model_adaptation_proposal")
        .get()).toEqual({ count: 1 });
      expect(() => acceptModelAdaptation(db, { projectId, proposalId: proposal!.id,
        expectedProposalSha256: "a".repeat(64) }, catalog, 3000))
        .toThrow(/differs from the accepted bytes/);
      expect(getProjectModelPreferences(db, projectId)?.revision).toBe(1);

      const accepted = acceptModelAdaptation(db, { projectId, proposalId: proposal!.id,
        expectedProposalSha256: proposal!.proposalSha256 }, catalog, 3000);
      expect(accepted.revision).toBe(2);
      expect(accepted.preferences.providerModelWeights).toEqual({ codex: { measured: 1.1 } });
      expect(accepted.preferences.exclusions).toEqual([{ providerId: "gemini1" }]);
      expect(accepted.preferences.providerWeights).toEqual({ codex: 1.2 });
      expect(listProjectModelPreferenceHistory(db, projectId).map((entry) =>
        [entry.revision, entry.changeKind, entry.proposalId]))
        .toEqual([[1, "owner_save", null], [2, "adaptive_accept", proposal!.id]]);
      expect(() => acceptModelAdaptation(db, { projectId, proposalId: proposal!.id,
        expectedProposalSha256: proposal!.proposalSha256 }, catalog, 3001))
        .toThrow(/preference revision changed/);

      const pin = adviseSoloModelChoice({ candidates: [
        { providerId: "codex", modelId: "measured", capabilities: [] },
        { providerId: "codex", modelId: "other", capabilities: [] }
      ], explicitChoice: { providerId: "codex", modelId: "other" },
      preferences: accepted.preferences });
      expect(pin.pinStatus).toBe("active");
      expect(pin.selected?.candidate.modelId).toBe("other");
    } finally { db.close(); }
  });

  it("requires strong attempted evidence and does not override a prior owner model weight", () => {
    const { db, projectId, caseId } = setup();
    try {
      const catalog = identifyModelCatalog(providers);
      expect(proposeModelAdaptation(db, projectId, catalog, 1000)).toBeNull();
      addOutcomes(db, caseId, projectId, 5);
      expect(proposeModelAdaptation(db, projectId, catalog, 1000)).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_project_model_adaptation_proposal")
        .get()).toEqual({ count: 0 });
      saveProjectModelPreferences(db, { projectId, expectedRevision: 0,
        preferences: { modelWeights: { measured: 1.0 } }
      }, 1000);
      expect(proposeModelAdaptation(db, projectId, catalog, 1001)).toBeNull();
    } finally { db.close(); }
  });

  it("fails closed when a project reaches the immutable proposal history bound", () => {
    const { db, projectId, caseId } = setup();
    try {
      addOutcomes(db, caseId, projectId, 10);
      const catalog = identifyModelCatalog(providers);
      const initial = proposeModelAdaptation(db, projectId, catalog, 2000)!;
      const seed = db.prepare(
        `INSERT INTO workstation_project_model_adaptation_proposal
         (id, project_id, base_revision, base_deleted_at, catalog_sha256, catalog_json,
          evidence_sha256, evidence_refs_json, evidence_operations, delta_json,
          reasons_json, unknowns_json, created_at)
         SELECT ?, project_id, base_revision, base_deleted_at, catalog_sha256, catalog_json,
                evidence_sha256, evidence_refs_json, evidence_operations, delta_json,
                reasons_json, unknowns_json, created_at
         FROM workstation_project_model_adaptation_proposal WHERE id = ?`
      );
      for (let index = 1; index < MAX_MODEL_ADAPTATION_PROPOSALS_PER_PROJECT; index += 1) {
        seed.run(`synthetic-proposal-${index}`, initial.id);
      }
      expect(() => proposeModelAdaptation(db, projectId, catalog, 3000)).toThrow(/history exceeds project bound/);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM workstation_project_model_adaptation_proposal WHERE project_id = ?"
      ).get(projectId)).toEqual({ count: MAX_MODEL_ADAPTATION_PROPOSALS_PER_PROJECT });
    } finally { db.close(); }
  });

  it("scopes an accepted weight to exact provider and model when another provider has the same model ID", () => {
    const { db, projectId, caseId } = setup();
    try {
      addOutcomes(db, caseId, projectId, 10);
      const duplicate = identifyModelCatalog([
        providers[0]!,
        { ...providers[1]!, state: "detected", models: [{ id: "measured", label: "Same ID" }] }
      ]);
      const proposal = proposeModelAdaptation(db, projectId, duplicate, 2000)!;
      expect(proposal.delta).toMatchObject({ providerId: "codex", modelId: "measured" });
      const accepted = acceptModelAdaptation(db, { projectId, proposalId: proposal.id,
        expectedProposalSha256: proposal.proposalSha256 }, duplicate, 3000);
      const advice = adviseSoloModelChoice({ candidates: [
        { providerId: "codex", modelId: "measured", capabilities: [] },
        { providerId: "gemini1", modelId: "measured", capabilities: [] }
      ], preferences: accepted.preferences });
      expect(advice.rankedCandidates.find((one) => one.candidate.providerId === "codex")?.preferenceScore)
        .toBe(1);
      expect(advice.rankedCandidates.find((one) => one.candidate.providerId === "gemini1")?.preferenceScore)
        .toBe(0);
    } finally { db.close(); }
  });

  it("rejects changed catalog, exact receipt bytes, preference CAS, expiry, and owner forget", () => {
    const scenarios = ["catalog", "receipt", "policy", "expired", "forget"] as const;
    for (const scenario of scenarios) {
      const { db, projectId, caseId } = setup();
      try {
        saveProjectModelPreferences(db, { projectId, expectedRevision: 0,
          preferences: { exclusions: [{ providerId: "gemini1" }] }
        }, 1000);
        addOutcomes(db, caseId, projectId, 10);
        const catalog = identifyModelCatalog(providers);
        const proposal = proposeModelAdaptation(db, projectId, catalog, 2000)!;
        let acceptingCatalog = catalog;
        let acceptingAt = 3000;
        if (scenario === "catalog") acceptingCatalog = identifyModelCatalog([
          { ...providers[0]!, models: [{ id: "measured", label: "Measured" }] }, providers[1]!
        ]);
        if (scenario === "receipt") {
          const turn = db.prepare("SELECT id, body FROM case_turn WHERE kind = 'receipt' LIMIT 1")
            .get() as { id: string; body: string };
          const body = JSON.parse(turn.body) as { snapshot: { text: string } };
          body.snapshot.text = "changed private answer";
          db.prepare("UPDATE case_turn SET body = ? WHERE id = ?")
            .run(JSON.stringify(body), turn.id);
        }
        if (scenario === "policy") saveProjectModelPreferences(db, { projectId, expectedRevision: 1,
          preferences: { exclusions: [{ providerId: "claude" }] }
        }, 2500);
        if (scenario === "expired") acceptingAt = 2000 + MODEL_ADAPTATION_PROPOSAL_TTL_MS + 1;
        if (scenario === "forget") forgetProjectModelPreferences(db, { projectId, expectedRevision: 1 }, 2500);
        expect(() => acceptModelAdaptation(db, { projectId, proposalId: proposal.id,
          expectedProposalSha256: proposal.proposalSha256 }, acceptingCatalog, acceptingAt))
          .toThrow();
        expect(listProjectModelPreferenceHistory(db, projectId)
          .some((entry) => entry.changeKind === "adaptive_accept")).toBe(false);
      } finally { db.close(); }
    }
  });

  it("proposes a negative weight only for observed attempted failures, not unknown readiness", () => {
    const { db, projectId, caseId } = setup();
    try {
      addOutcomes(db, caseId, projectId, 0);
      const proposal = proposeModelAdaptation(db, projectId, identifyModelCatalog(providers), 2000);
      expect(proposal?.delta.to).toBe(0.9);
      expect(proposal?.unknowns.join(" ")).toContain("quality");
    } finally { db.close(); }
  });
});
