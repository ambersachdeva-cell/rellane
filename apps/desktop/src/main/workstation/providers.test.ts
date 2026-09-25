import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorkstationProviders,
  findClaudeExecutable,
  resolveGeminiProfileHome,
  recommendWorkstationModels,
  assessTeamAdaptation,
  type AdaptationPackageSnapshot,
  type ModelCandidateFact,
  type TeamAdaptationPolicy,
  type AssessTeamAdaptationInput
} from "./providers.js";

describe("discoverWorkstationProviders", () => {
  it("returns launches for all five workstation providers with correct IDs and families", async () => {
    const launches = await discoverWorkstationProviders({
      codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      claudePath: "/mock/path/claude",
      agyPath: "/Users/example/.local/bin/agy",
      setupDir: "/Users/example/agy-setup"
    });

    expect(launches.length).toBe(5);

    const [codex, claude, gemini1, gemini2, gemini3] = launches;
    expect(codex?.provider.id).toBe("codex");
    expect(codex?.provider.family).toBe("codex");
    expect(codex?.provider.canApproveTools).toBe(true);
    expect(codex?.provider.canResume).toBe(true);

    expect(claude?.provider.id).toBe("claude");
    expect(claude?.provider.family).toBe("claude");
    expect(claude?.provider.canApproveTools).toBe(true);
    expect(claude?.provider.detail).toMatch(/Rellane does not check it/u);
    expect(claude?.provider.canResume).toBe(true);
    expect(claude?.provider.models.map((value) => value.id)).toEqual(["opus", "sonnet"]);

    expect(gemini1?.provider.id).toBe("gemini1");
    expect(gemini1?.provider.family).toBe("gemini");
    expect(gemini1?.profileHome).toBe("/Users/example/agy-setup/config1");
    expect(gemini1?.provider.canApproveTools).toBe(false);
    expect(gemini1?.provider.canResume).toBe(true);
    expect(gemini1?.provider.models[0]?.id).toBe("gemini-3.8-flash-high");

    expect(gemini2?.provider.id).toBe("gemini2");
    expect(gemini2?.profileHome).toBe("/Users/example/agy-setup/config2");
    expect(gemini2?.provider.canApproveTools).toBe(false);

    expect(gemini3?.provider.id).toBe("gemini3");
    expect(gemini3?.profileHome).toBe("/Users/example/agy-setup/config3");
    expect(gemini3?.provider.canApproveTools).toBe(false);
  });

  it("marks unavailable when executables are null without throwing", async () => {
    const launches = await discoverWorkstationProviders({
      codexPath: null,
      claudePath: null,
      agyPath: null
    });

    for (const launch of launches) {
      expect(launch.provider.state).toBe("unavailable");
      expect(launch.executable).toBeNull();
      expect(launch.provider.detail.length).toBeGreaterThan(0);
    }
  });

  it("finds newest Claude executable among installed extension versions", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "cadrane-claude-test-"));
    try {
      const extRoot = join(testHome, ".vscode", "extensions");
      const v1 = join(extRoot, "anthropic.claude-code-2.1.263-darwin-arm64", "resources", "native-binary");
      const v2 = join(extRoot, "anthropic.claude-code-2.1.264-darwin-arm64", "resources", "native-binary");

      await mkdir(v1, { recursive: true });
      await mkdir(v2, { recursive: true });

      const binary1 = join(v1, "claude");
      const binary2 = join(v2, "claude");
      await writeFile(binary1, "#!/bin/sh\nexit 0\n");
      await writeFile(binary2, "#!/bin/sh\nexit 0\n");
      await chmod(binary1, 0o755);
      await chmod(binary2, 0o755);

      const detected = await findClaudeExecutable(testHome);
      expect(detected).toBe(binary2);
    } finally {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  it("says a profile folder is missing without claiming anything about sign-in", async () => {
    const setupDir = await mkdtemp(join(tmpdir(), "cadrane-agy-setup-"));
    try {
      await mkdir(join(setupDir, "config1"), { recursive: true });

      const launches = await discoverWorkstationProviders({
        codexPath: null,
        claudePath: null,
        agyPath: "/mock/bin/agy",
        setupDir
      });

      const present = launches.find((launch) => launch.provider.id === "gemini1");
      const absent = launches.find((launch) => launch.provider.id === "gemini2");

      expect(present?.provider.detail).toMatch(/Rellane does not check it/u);
      expect(absent?.provider.detail).toContain("config2");
      expect(absent?.provider.detail).toContain("not been used yet");
      expect(present?.provider.state).toBe("detected");
      expect(absent?.provider.state).toBe("detected");
    } finally {
      await rm(setupDir, { recursive: true, force: true });
    }
  });

  it("correctly resolves gemini profile homes for all three profiles", () => {
    expect(resolveGeminiProfileHome("config1", "/custom/agy-setup")).toBe("/custom/agy-setup/config1");
    expect(resolveGeminiProfileHome("config2", "/custom/agy-setup")).toBe("/custom/agy-setup/config2");
    expect(resolveGeminiProfileHome("config3", "/custom/agy-setup")).toBe("/custom/agy-setup/config3");
  });
});

describe("recommendWorkstationModels", () => {
  it("excludes tool-incapable candidate when required capability is missing", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "gemini1",
        modelId: "gemini-3.8-flash-high",
        readiness: "ready",
        confirmedCapabilities: ["reasoning"],
        quotaState: "available",
        costTier: "included-subscription"
      },
      {
        providerId: "claude",
        modelId: "sonnet",
        readiness: "ready",
        confirmedCapabilities: ["tools", "reasoning"],
        quotaState: "available",
        costTier: "included-subscription"
      }
    ];

    const result = recommendWorkstationModels({
      requiredCapabilities: ["tools"],
      candidates
    });

    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0]?.providerId).toBe("claude");
    expect(result.excluded.length).toBe(1);
    expect(result.excluded[0]?.providerId).toBe("gemini1");
    expect(result.excluded[0]?.reasons).toContain("Missing required capability: tools");
  });

  it("preserves unknown quota and detection state as unverified unknowns", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "codex",
        modelId: "gpt-4o",
        readiness: "detected",
        quotaState: "unknown",
        costTier: "unknown"
      }
    ];

    const result = recommendWorkstationModels({ candidates });

    expect(result.recommendations.length).toBe(1);
    const rec = result.recommendations[0];
    expect(rec?.readiness).toBe("detected");
    expect(rec?.quotaState).toBe("unknown");
    expect(rec?.unknowns.some((u) => u.includes("Executable detected on disk, but sign-in and quota are unverified"))).toBe(true);
    expect(rec?.unknowns).toContain("Quota availability is unverified/unknown");
    expect(rec?.unknowns).toContain("Cost tier is unverified/unknown");
  });

  it("respects deliberate Solo choice without overwriting it with unselected models", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "claude",
        modelId: "opus",
        readiness: "ready",
        quotaState: "available",
        costTier: "included-subscription"
      },
      {
        providerId: "claude",
        modelId: "sonnet",
        readiness: "ready",
        quotaState: "available",
        costTier: "included-subscription"
      }
    ];

    const result = recommendWorkstationModels({
      candidates,
      deliberateChoice: {
        providerId: "claude",
        modelId: "sonnet",
        reason: "Owner chosen default for coding routine"
      }
    });

    expect(result.deliberateChoiceApplied).toBe(true);
    expect(result.recommendations[0]?.providerId).toBe("claude");
    expect(result.recommendations[0]?.modelId).toBe("sonnet");
    expect(result.recommendations[0]?.isDeliberateChoice).toBe(true);
    expect(result.recommendations[0]?.reasons.some((r) => r.includes("explicit owner preference"))).toBe(true);
  });

  it("does not fabricate fallback or perform automatic cross-profile account hopping when deliberate choice is exhausted", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "gemini1",
        profileId: "config1",
        modelId: "gemini-3.8-flash-high",
        readiness: "ready",
        quotaState: "exhausted",
        costTier: "included-subscription"
      },
      {
        providerId: "gemini2",
        profileId: "config2",
        modelId: "gemini-3.8-flash-high",
        readiness: "ready",
        quotaState: "available",
        costTier: "included-subscription"
      }
    ];

    const result = recommendWorkstationModels({
      candidates,
      deliberateChoice: {
        providerId: "gemini1",
        profileId: "config1",
        modelId: "gemini-3.8-flash-high"
      }
    });

    expect(result.deliberateChoiceApplied).toBe(false);
    expect(result.excluded.some((e) => e.providerId === "gemini1" && e.profileId === "config1")).toBe(true);
    const gemini2Rec = result.recommendations.find((r) => r.providerId === "gemini2");
    expect(gemini2Rec?.isDeliberateChoice).toBe(false);
  });

  it("excludes candidates exceeding required context limit and reports unknown context limits", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "claude",
        modelId: "opus",
        readiness: "ready",
        contextLimit: 32_000,
        quotaState: "available"
      },
      {
        providerId: "claude",
        modelId: "sonnet",
        readiness: "ready",
        quotaState: "available"
      }
    ];

    const result = recommendWorkstationModels({
      requiredContextSize: 64_000,
      candidates
    });

    expect(result.excluded.some((e) => e.modelId === "opus")).toBe(true);
    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0]?.modelId).toBe("sonnet");
    expect(result.recommendations[0]?.unknowns).toContain("Source-size context limit is unknown");
  });

  it("excludes paid API candidates under workstation included-subscription policy", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "codex",
        modelId: "gpt-4-paid",
        readiness: "ready",
        costTier: "paid",
        quotaState: "available"
      }
    ];

    const result = recommendWorkstationModels({ candidates });

    expect(result.recommendations.length).toBe(0);
    expect(result.excluded[0]?.reasons).toContain(
      "Paid API candidates are disallowed under included-subscription policy"
    );
  });

  it("bounds recommendations to maximum 3 with deterministic tie order and explicit reasons", () => {
    const candidates: ModelCandidateFact[] = [
      { providerId: "codex", modelId: "model-e", readiness: "ready", quotaState: "available" },
      { providerId: "claude", modelId: "model-d", readiness: "ready", quotaState: "available" },
      { providerId: "gemini1", modelId: "model-c", readiness: "ready", quotaState: "available" },
      { providerId: "gemini2", modelId: "model-b", readiness: "ready", quotaState: "available" },
      { providerId: "gemini3", modelId: "model-a", readiness: "ready", quotaState: "available" }
    ];

    const result = recommendWorkstationModels({ candidates });

    expect(result.recommendations.length).toBe(3);
    expect(result.recommendations.map((r) => `${r.providerId}:${r.modelId}`)).toEqual([
      "claude:model-d",
      "codex:model-e",
      "gemini1:model-c"
    ]);
  });

  it("requires actual supplied evidence for task-fit claims and states when no quality evidence is present", () => {
    const candidates: ModelCandidateFact[] = [
      {
        providerId: "claude",
        modelId: "sonnet",
        readiness: "ready",
        quotaState: "available",
        taskFitEvidence: "Passed 100% of benchmark suite tests"
      },
      {
        providerId: "gemini1",
        modelId: "gemini-3.8-flash-high",
        readiness: "ready",
        quotaState: "available"
      }
    ];

    const result = recommendWorkstationModels({
      taskRole: "reviewer",
      candidates
    });

    const claudeRec = result.recommendations.find((r) => r.providerId === "claude");
    const geminiRec = result.recommendations.find((r) => r.providerId === "gemini1");

    expect(claudeRec?.evidence).toContain("Passed 100% of benchmark suite tests");
    expect(geminiRec?.reasons).toContain("No quality evidence supplied for task-fit");
  });

  it("excludes candidates disallowed by provider allowlist", () => {
    const candidates: ModelCandidateFact[] = [
      { providerId: "claude", modelId: "sonnet", readiness: "ready", quotaState: "available" },
      { providerId: "gemini1", modelId: "gemini-3.8-flash-high", readiness: "ready", quotaState: "available" }
    ];

    const result = recommendWorkstationModels({
      allowedProviders: ["claude"],
      candidates
    });

    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0]?.providerId).toBe("claude");
    expect(result.excluded.some((e) => e.providerId === "gemini1")).toBe(true);
  });
});

describe("assessTeamAdaptation", () => {
  type MutableInput = { -readonly [K in keyof AssessTeamAdaptationInput]: AssessTeamAdaptationInput[K] };
  const basePolicy: TeamAdaptationPolicy = {
    policyId: "policy-123",
    policyHash: "hash-abc",
    projectId: "proj-1",
    runId: "run-1",
    ownerId: "owner-1",
    expiresAt: 2_000_000_000,
    approval: {
      approved: true,
      approvedBy: "owner-1",
      approvedAt: 1_000_000_000
    },
    allowedSelections: [
      { providerId: "claude", modelId: "sonnet" },
      { providerId: "codex", modelId: "gpt-4o" }
    ],
    requiredCapabilities: ["tools"],
    confirmedCapabilityEvidence: ["tools"],
    sources: [{ sourceId: "src-1", revisionHash: "rev-hash-1" }],
    allowedToolScopes: ["file_read", "terminal_run"],
    maxCalls: 10,
    maxConcurrency: 2,
    budgetLimit: 50,
    reservedBudget: 10
  };

  const createBaseInput = (): MutableInput => ({
    policy: basePolicy,
    now: 1_500_000_000,
    projectId: "proj-1",
    runId: "run-1",
    ownerId: "owner-1",
    mode: "team",
    callCount: 2,
    currentConcurrency: 0,
    consumedBudget: 10,
    proposed: {
      providerId: "claude",
      modelId: "sonnet",
      proposedCalls: 3,
      proposedConcurrency: 2,
      proposedCost: 15,
      sources: [{ sourceId: "src-1", revisionHash: "rev-hash-1" }],
      tools: ["file_read"],
      effectCertainty: "certain"
    }
  });

  it("authorizes team permitted assignment with exact approved immutable inputs", () => {
    const input = createBaseInput();
    const result = assessTeamAdaptation(input);

    expect(result.decision).toBe("within-policy");
    expect(result.requiresFreshReview).toBe(false);
    expect(result.proposedEffect?.providerId).toBe("claude");
    expect(result.proposedEffect?.modelId).toBe("sonnet");
    expect(result.proposedEffect?.allowedCalls).toBe(3);
    expect(result.proposedEffect?.allowedConcurrency).toBe(2);
    expect(result.proposedEffect?.estimatedCost).toBe(15);
  });

  it("fails closed when sources are expanded or revision hashes mismatch", () => {
    const inputWithNewSource = createBaseInput();
    inputWithNewSource.proposed = {
      ...inputWithNewSource.proposed,
      sources: [
        { sourceId: "src-1", revisionHash: "rev-hash-1" },
        { sourceId: "src-2", revisionHash: "rev-hash-2" }
      ]
    };
    const resultNew = assessTeamAdaptation(inputWithNewSource);
    expect(resultNew.decision).toBe("blocked");
    expect(resultNew.reasons.some((r) => r.includes("Source expansion disallowed"))).toBe(true);

    const inputWithMismatchedHash = createBaseInput();
    inputWithMismatchedHash.proposed = {
      ...inputWithMismatchedHash.proposed,
      sources: [{ sourceId: "src-1", revisionHash: "tampered-hash" }]
    };
    const resultMismatch = assessTeamAdaptation(inputWithMismatchedHash);
    expect(resultMismatch.decision).toBe("blocked");
    expect(resultMismatch.reasons.some((r) => r.includes("Source revision mismatch"))).toBe(true);
  });

  it("fails closed when tools are expanded beyond policy allowed tool scopes", () => {
    const input = createBaseInput();
    input.proposed = {
      ...input.proposed,
      tools: ["file_read", "unapproved_admin_write"]
    };

    const result = assessTeamAdaptation(input);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Tool scope expansion disallowed"))).toBe(true);
  });

  it("fails closed when proposed provider/model is not in policy allowed selections", () => {
    const input = createBaseInput();
    input.proposed = {
      ...input.proposed,
      providerId: "gemini1",
      modelId: "gemini-3.8-flash-high"
    };

    const result = assessTeamAdaptation(input);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("not among policy allowed selections"))).toBe(true);
  });

  it("fails closed when call count expansion exceeds policy maximum calls", () => {
    const input = createBaseInput();
    input.callCount = 8;
    input.proposed = {
      ...input.proposed,
      proposedCalls: 5
    };

    const result = assessTeamAdaptation(input);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Call limit expansion disallowed"))).toBe(true);
  });

  it("fails closed when concurrency expansion exceeds policy maximum concurrency", () => {
    const input = createBaseInput();
    input.proposed = {
      ...input.proposed,
      proposedConcurrency: 4
    };

    const result = assessTeamAdaptation(input);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Concurrency expansion disallowed"))).toBe(true);
  });

  it("fails closed when budget expansion exceeds policy budget limit", () => {
    const input = createBaseInput();
    input.consumedBudget = 40;
    input.proposed = {
      ...input.proposed,
      proposedCost: 15
    };

    const result = assessTeamAdaptation(input);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Budget expansion disallowed"))).toBe(true);
  });

  it("fails closed on invalid numbers such as NaN, negative, or Infinity", () => {
    const inputNaN = createBaseInput();
    inputNaN.proposed = {
      ...inputNaN.proposed,
      proposedCalls: Number.NaN
    };
    expect(assessTeamAdaptation(inputNaN).decision).toBe("blocked");

    const inputNegative = createBaseInput();
    inputNegative.callCount = -1;
    expect(assessTeamAdaptation(inputNegative).decision).toBe("blocked");

    const inputInfinity = createBaseInput();
    inputInfinity.proposed = {
      ...inputInfinity.proposed,
      proposedCost: Number.POSITIVE_INFINITY
    };
    expect(assessTeamAdaptation(inputInfinity).decision).toBe("blocked");
  });

  it("fails closed on duplicate IDs in policy or proposed inputs", () => {
    const inputDuplicateSources = createBaseInput();
    inputDuplicateSources.policy = {
      ...basePolicy,
      sources: [
        { sourceId: "src-1", revisionHash: "hash-1" },
        { sourceId: "src-1", revisionHash: "hash-2" }
      ]
    };
    expect(assessTeamAdaptation(inputDuplicateSources).decision).toBe("blocked");

    const inputDuplicateTools = createBaseInput();
    inputDuplicateTools.proposed = {
      ...inputDuplicateTools.proposed,
      tools: ["file_read", "file_read"]
    };
    expect(assessTeamAdaptation(inputDuplicateTools).decision).toBe("blocked");
  });

  it("fails closed on expired policy or missing/unapproved policy evidence", () => {
    const inputExpired = createBaseInput();
    inputExpired.now = 2_500_000_000;
    const resultExpired = assessTeamAdaptation(inputExpired);
    expect(resultExpired.decision).toBe("blocked");
    expect(resultExpired.reasons.some((r) => r.includes("Policy expired"))).toBe(true);

    const inputUnapproved = createBaseInput();
    inputUnapproved.policy = {
      ...basePolicy,
      approval: {
        approved: false,
        approvedBy: "owner-1",
        approvedAt: 1_000_000_000
      }
    };
    expect(assessTeamAdaptation(inputUnapproved).decision).toBe("blocked");
  });

  it("fails closed on mismatched project, run, or owner IDs", () => {
    const inputProjMismatch = createBaseInput();
    const resultProj = assessTeamAdaptation({ ...inputProjMismatch, projectId: "different-proj" });
    expect(resultProj.decision).toBe("blocked");

    const inputRunMismatch = createBaseInput();
    const resultRun = assessTeamAdaptation({ ...inputRunMismatch, runId: "different-run" });
    expect(resultRun.decision).toBe("blocked");

    const inputOwnerMismatch = createBaseInput();
    const resultOwner = assessTeamAdaptation({ ...inputOwnerMismatch, ownerId: "different-owner" });
    expect(resultOwner.decision).toBe("blocked");
  });

  it("fails closed on late replacement of an already-started or completed package snapshot", () => {
    const inputRunning = createBaseInput();
    inputRunning.snapshot = {
      providerId: "claude",
      modelId: "sonnet",
      status: "running"
    };

    const result = assessTeamAdaptation(inputRunning);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Late replacement of an already-started"))).toBe(true);
  });

  it("fails closed on uncertain snapshot status", () => {
    const inputUncertain = createBaseInput();
    inputUncertain.snapshot = {
      providerId: "claude",
      modelId: "sonnet",
      status: "" as "waiting"
    };

    const result = assessTeamAdaptation(inputUncertain);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("status is uncertain"))).toBe(true);
  });

  it("fails closed on uncertain effects attempting automatic retry", () => {
    const inputRetryUncertain = createBaseInput();
    inputRetryUncertain.proposed = {
      ...inputRetryUncertain.proposed,
      isRetry: true,
      effectCertainty: "uncertain"
    };

    const result = assessTeamAdaptation(inputRetryUncertain);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Uncertain effects cannot retry automatically"))).toBe(true);
  });

  it("returns needs-review when budget counters are unknown or effect certainty is uncertain", () => {
    const inputUnknownCounters = createBaseInput();
    delete inputUnknownCounters.callCount;
    delete inputUnknownCounters.consumedBudget;
    const resultCounters = assessTeamAdaptation(inputUnknownCounters);
    expect(resultCounters.decision).toBe("needs-review");
    expect(resultCounters.reasons.some((r) => r.includes("Budget counters are not fully known"))).toBe(true);

    const inputUncertainEffect = createBaseInput();
    inputUncertainEffect.proposed = {
      ...inputUncertainEffect.proposed,
      effectCertainty: "uncertain"
    };
    const resultEffect = assessTeamAdaptation(inputUncertainEffect);
    expect(resultEffect.decision).toBe("needs-review");
    expect(resultEffect.reasons.some((r) => r.includes("Effect certainty is 'uncertain'"))).toBe(true);
  });

  it("fails closed on automatic quota-rotation trigger or paid fallback", () => {
    const inputQuotaRotation = createBaseInput();
    inputQuotaRotation.proposed = {
      ...inputQuotaRotation.proposed,
      isQuotaRotation: true
    };
    expect(assessTeamAdaptation(inputQuotaRotation).decision).toBe("blocked");

    const inputPaidFallback = createBaseInput();
    inputPaidFallback.proposed = {
      ...inputPaidFallback.proposed,
      isPaidFallback: true
    };
    expect(assessTeamAdaptation(inputPaidFallback).decision).toBe("blocked");
  });

  it("enforces fixed Solo provider and model invariance while permitting workflow adjustments inside chosen model", () => {
    const inputSoloReroute = createBaseInput();
    inputSoloReroute.mode = "solo";
    inputSoloReroute.currentProviderId = "claude";
    inputSoloReroute.currentModelId = "sonnet";
    inputSoloReroute.proposed = {
      ...inputSoloReroute.proposed,
      providerId: "codex",
      modelId: "gpt-4o"
    };

    const rerouteResult = assessTeamAdaptation(inputSoloReroute);
    expect(rerouteResult.decision).toBe("blocked");
    expect(rerouteResult.reasons.some((r) => r.includes("Fixed Solo provider"))).toBe(true);

    const inputSoloAdjustment = createBaseInput();
    inputSoloAdjustment.mode = "solo";
    inputSoloAdjustment.currentProviderId = "claude";
    inputSoloAdjustment.currentModelId = "sonnet";
    inputSoloAdjustment.proposed = {
      ...inputSoloAdjustment.proposed,
      providerId: "claude",
      modelId: "sonnet",
      workflowAdjustment: "Tighten response temperature for verification"
    };

    const adjustmentResult = assessTeamAdaptation(inputSoloAdjustment);
    expect(adjustmentResult.decision).toBe("within-policy");
    expect(adjustmentResult.reasons.some((r) => r.includes("Solo workflow adjustment inside chosen model"))).toBe(true);
  });

  it("reports requiresFreshReview when exact packet is compiled or changed", () => {
    const inputChanged = createBaseInput();
    inputChanged.proposed = {
      ...inputChanged.proposed,
      packetChanged: true
    };

    const result = assessTeamAdaptation(inputChanged);
    expect(result.decision).toBe("needs-review");
    expect(result.requiresFreshReview).toBe(true);
    expect(result.reasons.some((r) => r.includes("requires host review before dispatch"))).toBe(true);
  });

  it("blocks Solo mode when provider or model IDs are missing without verified snapshot", () => {
    const inputSoloMissing = createBaseInput();
    inputSoloMissing.mode = "solo";
    delete inputSoloMissing.currentProviderId;
    delete inputSoloMissing.currentModelId;

    const result = assessTeamAdaptation(inputSoloMissing);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Solo mode requires known current provider and model"))).toBe(true);
  });

  it("blocks when explicit IDs conflict with snapshot IDs or when snapshot mismatches in Solo mode", () => {
    const inputConflict = createBaseInput();
    inputConflict.currentProviderId = "claude";
    inputConflict.currentModelId = "sonnet";
    const conflictingSnapshot: AdaptationPackageSnapshot = {
      providerId: "codex",
      modelId: "gpt-4o",
      status: "waiting"
    };
    inputConflict.snapshot = conflictingSnapshot;

    const result = assessTeamAdaptation(inputConflict);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Snapshot provider 'codex' does not match current provider 'claude'"))).toBe(true);

    const inputModelConflict = createBaseInput();
    inputModelConflict.currentProviderId = "claude";
    inputModelConflict.currentModelId = "sonnet";
    inputModelConflict.snapshot = {
      ...conflictingSnapshot,
      providerId: "claude",
      modelId: "opus"
    };
    const resultModel = assessTeamAdaptation(inputModelConflict);
    expect(resultModel.decision).toBe("blocked");
    expect(resultModel.reasons.some((r) => r.includes("Snapshot model 'opus' does not match current model 'sonnet'"))).toBe(true);

    const inputSoloSnap = createBaseInput();
    inputSoloSnap.mode = "solo";
    delete inputSoloSnap.currentProviderId;
    delete inputSoloSnap.currentModelId;
    inputSoloSnap.snapshot = {
      ...conflictingSnapshot,
      providerId: "claude",
      modelId: "sonnet"
    };
    expect(assessTeamAdaptation(inputSoloSnap).decision).toBe("blocked");

    const inputSoloSnapMismatch = {
      ...inputSoloSnap,
      currentProviderId: "claude" as const,
      currentModelId: "sonnet",
      proposed: {
        ...inputSoloSnap.proposed,
        providerId: "codex" as const,
        modelId: "gpt-4o"
      }
    };
    const resultSnapMismatch = assessTeamAdaptation(inputSoloSnapMismatch);
    expect(resultSnapMismatch.decision).toBe("blocked");
    expect(resultSnapMismatch.reasons.some((r) => r.includes("Fixed Solo provider 'claude' must never change"))).toBe(true);
  });

  it("does not allow snapshot to fabricate policy approval", () => {
    const inputUnapprovedWithSnap = createBaseInput();
    inputUnapprovedWithSnap.policy = {
      ...basePolicy,
      approval: {
        approved: false,
        approvedBy: "owner-1",
        approvedAt: 1_000_000_000
      }
    };
    inputUnapprovedWithSnap.snapshot = {
      providerId: "claude",
      modelId: "sonnet",
      status: "waiting"
    };

    const result = assessTeamAdaptation(inputUnapprovedWithSnap);
    expect(result.decision).toBe("blocked");
    expect(result.reasons.some((r) => r.includes("Policy approval flag is not true"))).toBe(true);
  });

  it("enforces budget check with consumed, reserved, and proposed cost", () => {
    const inputBlocked = createBaseInput();
    inputBlocked.consumedBudget = 20;
    inputBlocked.policy = {
      ...inputBlocked.policy,
      budgetLimit: 50,
      reservedBudget: 20
    };
    inputBlocked.proposed = {
      ...inputBlocked.proposed,
      proposedCost: 15
    };

    const resultBlocked = assessTeamAdaptation(inputBlocked);
    expect(resultBlocked.decision).toBe("blocked");
    expect(resultBlocked.reasons.some((r) => r.includes("Budget expansion disallowed"))).toBe(true);

    const inputEqual = createBaseInput();
    inputEqual.consumedBudget = 20;
    inputEqual.policy = {
      ...inputEqual.policy,
      budgetLimit: 50,
      reservedBudget: 20
    };
    inputEqual.proposed = {
      ...inputEqual.proposed,
      proposedCost: 10
    };

    const resultEqual = assessTeamAdaptation(inputEqual);
    expect(resultEqual.decision).toBe("within-policy");

    const inputReservedExceeds = createBaseInput();
    inputReservedExceeds.policy = {
      ...inputReservedExceeds.policy,
      budgetLimit: 50,
      reservedBudget: 60
    };
    const resultReserved = assessTeamAdaptation(inputReservedExceeds);
    expect(resultReserved.decision).toBe("blocked");
    expect(resultReserved.reasons.some((r) => r.includes("Policy reserved budget"))).toBe(true);
  });

  it("enforces concurrency accounting and integer validation for call and concurrency counts", () => {
    const inputBlocked = createBaseInput();
    inputBlocked.currentConcurrency = 2;
    inputBlocked.policy = {
      ...inputBlocked.policy,
      maxConcurrency: 2
    };
    inputBlocked.proposed = {
      ...inputBlocked.proposed,
      proposedConcurrency: 1
    };

    const resultBlocked = assessTeamAdaptation(inputBlocked);
    expect(resultBlocked.decision).toBe("blocked");
    expect(resultBlocked.reasons.some((r) => r.includes("Concurrency expansion disallowed"))).toBe(true);

    const inputPermitted = createBaseInput();
    inputPermitted.currentConcurrency = 2;
    inputPermitted.policy = {
      ...inputPermitted.policy,
      maxConcurrency: 3
    };
    inputPermitted.proposed = {
      ...inputPermitted.proposed,
      proposedConcurrency: 1
    };

    const resultPermitted = assessTeamAdaptation(inputPermitted);
    expect(resultPermitted.decision).toBe("within-policy");

    const inputFractionalCalls = createBaseInput();
    inputFractionalCalls.proposed = {
      ...inputFractionalCalls.proposed,
      proposedCalls: 2.5
    };
    expect(assessTeamAdaptation(inputFractionalCalls).decision).toBe("blocked");

    const inputFractionalConcurrency = createBaseInput();
    inputFractionalConcurrency.proposed = {
      ...inputFractionalConcurrency.proposed,
      proposedConcurrency: 1.5
    };
    expect(assessTeamAdaptation(inputFractionalConcurrency).decision).toBe("blocked");
  });
});
