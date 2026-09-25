import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../book/schema.js";
import {
  adviseSoloModelChoice,
  type ModelCandidate,
  type ExplicitModelChoice,
  type ProjectPreferences
} from "../workstation/model-choice-advisor.js";
import {
  identifyModelCatalog,
  proposeModelAdaptation,
  acceptModelAdaptation,
  type ModelCatalogIdentity
} from "../workstation/model-adaptation-policy.js";
import { saveProjectModelPreferences } from "../workstation/model-project-preferences-store.js";
import type { WorkstationProvider } from "@cadrane/contracts";

function createInMemoryBook(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }
  return db;
}

describe("Backend Final Acceptance - Solo Pin and Model Advice Contracts (G03 / R07)", () => {
  const candidates: readonly ModelCandidate[] = [
    {
      providerId: "codex",
      modelId: "gpt-5-codex",
      displayName: "Codex · GPT-5",
      capabilities: ["code", "planning"]
    },
    {
      providerId: "claude",
      modelId: "sonnet-3-7",
      displayName: "Claude · Sonnet 3.7",
      capabilities: ["code", "writing"]
    },
    {
      providerId: "gemini1",
      modelId: "gemini-2-5-pro",
      displayName: "Gemini · 2.5 Pro",
      capabilities: ["multimodal", "reasoning"]
    }
  ];

  it("enforces explicit Solo pin invariance without auto-switching or fallback", () => {
    const explicitChoice: ExplicitModelChoice = {
      providerId: "codex",
      modelId: "gpt-5-codex"
    };

    // Even if claude has high preference and gemini has higher capability match,
    // explicit Solo pin must strictly preserve the pinned selection.
    const preferences: ProjectPreferences = {
      providerWeights: { claude: 1.5, gemini1: 1.8, codex: 0.2 },
      modelWeights: { "sonnet-3-7": 2.0 }
    };

    const advice = adviseSoloModelChoice({
      candidates,
      explicitChoice,
      preferences,
      requirements: { requiredCapabilities: ["reasoning"] }
    });

    expect(advice.isPinned).toBe(true);
    expect(advice.pinStatus).toBe("active");
    expect(advice.selected).not.toBeNull();
    expect(advice.selected?.candidate.providerId).toBe("codex");
    expect(advice.selected?.candidate.modelId).toBe("gpt-5-codex");
    // Pinned candidate reasons must explicitly state the owner's choice
    expect(advice.reasons.some((r) => r.toLowerCase().includes("explicit") || r.toLowerCase().includes("pinned"))).toBe(true);
  });

  it("retains pinned identity when model is absent from catalog, marking unavailable without synthetic fallback", () => {
    const absentChoice: ExplicitModelChoice = {
      providerId: "codex",
      modelId: "legacy-unlisted-model"
    };

    const advice = adviseSoloModelChoice({
      candidates,
      explicitChoice: absentChoice
    });

    expect(advice.isPinned).toBe(true);
    expect(advice.pinStatus).toBe("unavailable");
    // Must NOT substitute an available model or manufacture a synthetic candidate
    expect(advice.selected).toBeNull();
    expect(advice.reasons.some((r) => r.toLowerCase().includes("unavailable") || r.toLowerCase().includes("catalog"))).toBe(true);
  });

  it("blocks pinned model if explicitly excluded by project governance, requiring owner resolution", () => {
    const explicitChoice: ExplicitModelChoice = {
      providerId: "claude",
      modelId: "sonnet-3-7"
    };

    const preferencesWithExclusion: ProjectPreferences = {
      exclusions: [{ providerId: "claude", modelId: "sonnet-3-7" }]
    };

    const advice = adviseSoloModelChoice({
      candidates,
      explicitChoice,
      preferences: preferencesWithExclusion
    });

    expect(advice.isPinned).toBe(true);
    expect(advice.pinStatus).toBe("blocked");
    expect(advice.selected).toBeNull();
    expect(advice.reasons.some((r) => r.toLowerCase().includes("excluded") || r.toLowerCase().includes("blocked"))).toBe(true);
  });

  it("isolates same model ID across different providers preventing weight contamination", () => {
    // Both codex and claude have a hypothetical model with same string ID "shared-name-v1"
    const candidatesWithSharedIds: readonly ModelCandidate[] = [
      { providerId: "codex", modelId: "shared-name-v1", capabilities: ["code"] },
      { providerId: "claude", modelId: "shared-name-v1", capabilities: ["code"] }
    ];

    const preferences: ProjectPreferences = {
      providerModelWeights: {
        codex: { "shared-name-v1": 2.0 },
        claude: { "shared-name-v1": 0.1 }
      }
    };

    const codexAdvice = adviseSoloModelChoice({
      candidates: candidatesWithSharedIds,
      explicitChoice: { providerId: "codex", modelId: "shared-name-v1" },
      preferences
    });

    const claudeAdvice = adviseSoloModelChoice({
      candidates: candidatesWithSharedIds,
      explicitChoice: { providerId: "claude", modelId: "shared-name-v1" },
      preferences
    });

    expect(codexAdvice.selected?.candidate.providerId).toBe("codex");
    expect(claudeAdvice.selected?.candidate.providerId).toBe("claude");
    // Provider model weights must score differently
    expect(codexAdvice.selected?.score).toBeGreaterThan(claudeAdvice.selected?.score ?? 0);
  });

  it("rejects stale or mismatched adaptation proposals during policy acceptance", () => {
    const db = createInMemoryBook();
    const projectId = "proj-acceptance-1";
    db.prepare("INSERT INTO workstation_project (id, created_at, memory_epoch) VALUES (?, ?, ?)").run(
      projectId,
      Date.now(),
      1
    );

    saveProjectModelPreferences(db, {
      projectId,
      expectedRevision: 0,
      preferences: {
        exclusions: [],
        providerWeights: { codex: 1.0 },
        modelWeights: {},
        providerModelWeights: {},
        capabilityWeights: {}
      }
    });

    const mockProviders: readonly WorkstationProvider[] = [
      {
        id: "codex",
        label: "Codex",
        family: "codex",
        state: "detected",
        detail: "Installed",
        models: [{ id: "gpt-5-codex", label: "Codex" }],
        canResume: true,
        canApproveTools: true
      }
    ];

    const catalog = identifyModelCatalog(mockProviders);
    const proposal = proposeModelAdaptation(db, projectId, catalog);

    // Without 10+ measured operations, proposeModelAdaptation returns null
    expect(proposal).toBeNull();

    // Attempting to accept a non-existent or forged proposal ID must be rejected
    expect(() => {
      acceptModelAdaptation(
        db,
        {
          projectId,
          proposalId: "11111111-1111-4111-8111-111111111111",
          expectedProposalSha256: "0000000000000000000000000000000000000000000000000000000000000000"
        },
        catalog
      );
    }).toThrow(/missing|forgotten|stale|mismatch/i);
  });
});
