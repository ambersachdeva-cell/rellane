import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ModelOutcomeEvidence } from "./model-outcome-evidence.js";
import {
  adviseSoloModelChoice,
  adviseTeamModelChoice,
  MAX_PROMPT_LENGTH,
  MAX_TEAM_PACKAGE_PROMPT_LENGTH,
  computeReliabilitySignal,
  forgetProjectPreferences,
  type ModelCandidate,
  type ExplicitModelChoice,
  type TaskRequirements,
  type ProjectPreferences,
  type TeamRoleDefinition
} from "./model-choice-advisor.js";

const CANDIDATES: readonly ModelCandidate[] = [
  {
    providerId: "codex",
    modelId: "gpt-4o",
    capabilities: ["planning", "reasoning", "architecture"]
  },
  {
    providerId: "claude",
    modelId: "claude-3-5-sonnet",
    capabilities: ["code", "refactoring", "implementation"]
  },
  {
    providerId: "gemini3",
    modelId: "gemini-pro-preview",
    capabilities: ["review", "testing", "verification", "security"]
  },
  {
    providerId: "gemini1",
    modelId: "gemini-flash",
    capabilities: ["fast", "formatting", "docs"]
  }
];

describe("model-choice-advisor", () => {
  it("Solo's explicit pin to a model absent from catalog remains pinned but clearly unavailable without synthetic candidate or fallback", () => {
    const explicitChoice: ExplicitModelChoice = {
      providerId: "codex",
      modelId: "non-existent-model"
    };

    const advice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      explicitChoice,
      requirements: { requiredCapabilities: ["code"] }
    });

    assert.equal(advice.isPinned, true);
    assert.equal(advice.pinStatus, "unavailable");
    assert.equal(advice.selected, null);
    assert.equal(advice.rankedCandidates.length, 0);
    assert.ok(
      advice.reasons.some((r) =>
        r.includes("absent from supplied candidate catalog")
      )
    );
    assert.ok(
      advice.reasons.some((r) =>
        r.includes("No synthetic candidate connected and fallback is prohibited")
      )
    );
  });

  it("Solo's explicit pin conflicting with project exclusion is blocked and needs owner resolution, never auto-switched", () => {
    const explicitChoice: ExplicitModelChoice = {
      providerId: "gemini1",
      modelId: "gemini-flash"
    };

    const preferences: ProjectPreferences = {
      projectId: "proj-blocked",
      exclusions: [{ providerId: "gemini1" }]
    };

    const advice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      explicitChoice,
      preferences
    });

    assert.equal(advice.isPinned, true);
    assert.equal(advice.pinStatus, "blocked");
    assert.equal(advice.selected, null);
    assert.equal(advice.rankedCandidates.length, 0);
    assert.ok(
      advice.reasons.some((r) =>
        r.includes("conflicts with project exclusion policy and is blocked")
      )
    );
    assert.ok(
      advice.reasons.some((r) =>
        r.includes("Requires owner resolution; auto-switching is prohibited")
      )
    );
  });

  it("Solo's valid explicit pin present in catalog remains locked and active without auto-switch", () => {
    const explicitChoice: ExplicitModelChoice = {
      providerId: "gemini1",
      modelId: "gemini-flash"
    };

    const requirements: TaskRequirements = {
      requiredCapabilities: ["planning", "code"]
    };

    const advice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      explicitChoice,
      requirements
    });

    assert.equal(advice.isPinned, true);
    assert.equal(advice.pinStatus, "active");
    assert.ok(advice.selected !== null);
    assert.equal(advice.selected.candidate.providerId, "gemini1");
    assert.equal(advice.selected.candidate.modelId, "gemini-flash");
    assert.equal(advice.rankedCandidates.length, 1);
    assert.ok(
      advice.selected.reasons.some((r) =>
        r.includes("Auto-switch and ranking override disabled")
      )
    );
  });

  it("Exclusions hard-filter candidates during unselected recommendation", () => {
    const preferences: ProjectPreferences = {
      projectId: "proj-exclusions",
      exclusions: [
        { providerId: "claude" },
        { providerId: "codex", modelId: "gpt-4o" }
      ]
    };

    const advice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      preferences
    });

    assert.equal(advice.isPinned, false);
    assert.equal(advice.pinStatus, "none");
    for (const ranked of advice.rankedCandidates) {
      assert.notEqual(ranked.candidate.providerId, "claude");
      if (ranked.candidate.providerId === "codex") {
        assert.notEqual(ranked.candidate.modelId, "gpt-4o");
      }
    }

    const excludeAllPrefs: ProjectPreferences = {
      projectId: "proj-all-excluded",
      exclusions: [
        { providerId: "codex" },
        { providerId: "claude" },
        { providerId: "gemini3" },
        { providerId: "gemini1" }
      ]
    };

    const allExcludedAdvice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      preferences: excludeAllPrefs
    });

    assert.equal(allExcludedAdvice.selected, null);
    assert.equal(allExcludedAdvice.rankedCandidates.length, 0);
    assert.ok(
      allExcludedAdvice.reasons.some((r) =>
        r.includes("excluded by per-project preference filters")
      )
    );
  });

  it("Reliability denominator only counts receipts where attemptState is attempted; stopped/failed receipts without attempted state are excluded", () => {
    const candidate: ModelCandidate = {
      providerId: "codex",
      modelId: "gpt-4o",
      capabilities: ["code"]
    };

    const mixedEvidence: ModelOutcomeEvidence[] = [
      {
        operationId: "op-stopped",
        caseId: "case-1",
        projectId: "proj-1",
        providerId: "codex",
        requestedModelId: "gpt-4o",
        reportedModelId: "gpt-4o",
        attemptState: "stopped" as any,
        terminalState: "stopped",
        observedCompleted: false,
        durationMs: 0,
        startedAt: 100,
        endedAt: 100,
        reasons: ["Stopped before attempt"]
      },
      {
        operationId: "op-queue-fail",
        caseId: "case-1",
        projectId: "proj-1",
        providerId: "codex",
        requestedModelId: "gpt-4o",
        reportedModelId: "gpt-4o",
        attemptState: "failed" as any,
        terminalState: "failed",
        observedCompleted: false,
        durationMs: 0,
        startedAt: 100,
        endedAt: 100,
        reasons: ["Failed before execution attempt"]
      }
    ];

    const signalResult = computeReliabilitySignal(candidate, mixedEvidence);
    assert.equal(signalResult.signal.totalAttemptedCount, 0);
    assert.equal(signalResult.signal.status, "unknown");
    assert.equal(signalResult.signal.completionRatio, null);
    assert.equal(signalResult.scoreDelta, 0);
  });

  it("Tiny reliability samples do not turn into strong ranking signals (held neutral/insufficient sample until threshold)", () => {
    const candidate: ModelCandidate = {
      providerId: "claude",
      modelId: "claude-3-5-sonnet",
      capabilities: ["code"]
    };

    const tinyEvidence: ModelOutcomeEvidence[] = [
      {
        operationId: "op-1",
        caseId: "case-1",
        projectId: "proj-1",
        providerId: "claude",
        requestedModelId: "claude-3-5-sonnet",
        reportedModelId: "claude-3-5-sonnet",
        attemptState: "attempted",
        terminalState: "completed",
        observedCompleted: true,
        durationMs: 300,
        startedAt: 100,
        endedAt: 400,
        reasons: []
      }
    ];

    const tinyResult = computeReliabilitySignal(candidate, tinyEvidence);
    assert.equal(tinyResult.signal.totalAttemptedCount, 1);
    assert.equal(tinyResult.signal.status, "insufficient_sample");
    assert.equal(tinyResult.signal.completionRatio, null);
    assert.equal(tinyResult.scoreDelta, 0);
    assert.ok(tinyResult.signal.summary.includes("minimum 3 required"));

    const measuredEvidence: ModelOutcomeEvidence[] = [
      ...tinyEvidence,
      {
        operationId: "op-2",
        caseId: "case-1",
        projectId: "proj-1",
        providerId: "claude",
        requestedModelId: "claude-3-5-sonnet",
        reportedModelId: "claude-3-5-sonnet",
        attemptState: "attempted",
        terminalState: "completed",
        observedCompleted: true,
        durationMs: 300,
        startedAt: 400,
        endedAt: 700,
        reasons: []
      },
      {
        operationId: "op-3",
        caseId: "case-1",
        projectId: "proj-1",
        providerId: "claude",
        requestedModelId: "claude-3-5-sonnet",
        reportedModelId: "claude-3-5-sonnet",
        attemptState: "attempted",
        terminalState: "completed",
        observedCompleted: true,
        durationMs: 300,
        startedAt: 700,
        endedAt: 1000,
        reasons: []
      }
    ];

    const measuredResult = computeReliabilitySignal(candidate, measuredEvidence);
    assert.equal(measuredResult.signal.totalAttemptedCount, 3);
    assert.equal(measuredResult.signal.status, "measured");
    assert.equal(measuredResult.signal.completionRatio, 1.0);
    assert.equal(measuredResult.scoreDelta, 10);
    assert.ok(
      measuredResult.reason.includes("completion does not guarantee quality, price, or quota")
    );
  });

  it("credits observed execution to the reported model only when the host redirects a request", () => {
    const requested: ModelCandidate = { providerId: "codex", modelId: "model-a", capabilities: [] };
    const reported: ModelCandidate = { providerId: "codex", modelId: "model-b", capabilities: [] };
    const evidence: ModelOutcomeEvidence[] = [
      ...[1, 2, 3].map((i): ModelOutcomeEvidence => ({
        operationId: `redirect-${i}`, caseId: "case-a", projectId: "project-a",
        providerId: "codex", requestedModelId: "model-a", reportedModelId: "model-b",
        attemptState: "attempted", terminalState: "completed", observedCompleted: true,
        durationMs: 1, startedAt: i, endedAt: i + 1, reasons: []
      })),
      { operationId: "matched", caseId: "case-a", projectId: "project-a",
        providerId: "codex", requestedModelId: "model-a", reportedModelId: "model-a",
        attemptState: "attempted", terminalState: "completed", observedCompleted: true,
        durationMs: 1, startedAt: 4, endedAt: 5, reasons: [] },
      { operationId: "unreported", caseId: "case-a", projectId: "project-a",
        providerId: "codex", requestedModelId: "model-a", reportedModelId: null,
        attemptState: "attempted", terminalState: "completed", observedCompleted: true,
        durationMs: 1, startedAt: 5, endedAt: 6, reasons: [] }
    ];

    const requestedSignal = computeReliabilitySignal(requested, evidence).signal;
    const reportedSignal = computeReliabilitySignal(reported, evidence).signal;
    assert.equal(requestedSignal.totalAttemptedCount, 2);
    assert.equal(requestedSignal.observedCompletedCount, 2);
    assert.equal(requestedSignal.status, "insufficient_sample");
    assert.equal(reportedSignal.totalAttemptedCount, 3);
    assert.equal(reportedSignal.observedCompletedCount, 3);
    assert.equal(reportedSignal.status, "measured");
  });

  it("Missing/unknown evidence remains unknown and is never treated as zero quality", () => {
    const candidates: readonly ModelCandidate[] = [
      {
        providerId: "codex",
        modelId: "untested-model",
        capabilities: ["code"]
      },
      {
        providerId: "codex",
        modelId: "failed-model",
        capabilities: ["code"]
      }
    ];

    const failedEvidence: ModelOutcomeEvidence[] = Array.from(
      { length: 5 },
      (_, i) => ({
        operationId: `op-${i}`,
        caseId: "case-1",
        projectId: "proj-1",
        providerId: "codex",
        requestedModelId: "failed-model",
        reportedModelId: "failed-model",
        attemptState: "attempted",
        terminalState: "failed",
        observedCompleted: false,
        durationMs: 1500,
        startedAt: 1000,
        endedAt: 2500,
        reasons: ["Process crashed"]
      })
    );

    const advice = adviseSoloModelChoice({
      candidates,
      requirements: { requiredCapabilities: ["code"] },
      evidence: failedEvidence
    });

    const untestedRanked = advice.rankedCandidates.find(
      (r) => r.candidate.modelId === "untested-model"
    );
    const failedRanked = advice.rankedCandidates.find(
      (r) => r.candidate.modelId === "failed-model"
    );

    assert.ok(untestedRanked !== undefined);
    assert.ok(failedRanked !== undefined);

    assert.equal(untestedRanked.reliabilitySignal.status, "unknown");
    assert.equal(untestedRanked.reliabilitySignal.completionRatio, null);
    assert.equal(untestedRanked.reliabilityScore, 0);
    assert.ok(
      untestedRanked.reasons.some((r) =>
        r.includes("never treated as zero quality")
      )
    );

    assert.ok(untestedRanked.score > failedRanked.score);
    assert.equal(advice.selected?.candidate.modelId, "untested-model");
  });

  it("Solo holds undeclared host capabilities neutral and describes requirements as unverified", () => {
    const advice = adviseSoloModelChoice({
      candidates: [{ providerId: "codex", modelId: "listed", capabilities: [] }],
      explicitChoice: { providerId: "codex", modelId: "listed" },
      requirements: { requiredCapabilities: ["code"], preferredCapabilities: ["review"] }
    });
    assert.equal(advice.pinStatus, "active");
    assert.equal(advice.selected?.capabilityScore, 30);
    assert.ok(advice.selected?.reasons.some((reason) => reason.includes("capabilities are undeclared")));
    assert.ok(advice.selected?.reasons.every((reason) => !reason.includes("Missing required capabilities")));
  });

  it("Invalid preferences or duplicate catalog entries cannot manufacture a score", () => {
    const duplicateCandidates: readonly ModelCandidate[] = [
      CANDIDATES[0]!,
      CANDIDATES[0]!,
      CANDIDATES[1]!
    ];

    const invalidPreferences: ProjectPreferences = {
      projectId: "proj-invalid",
      providerWeights: {
        codex: NaN as any,
        claude: Infinity as any,
        gemini1: -2.0 as any,
        gemini3: 1.5
      }
    };

    const advice = adviseSoloModelChoice({
      candidates: duplicateCandidates,
      preferences: invalidPreferences
    });

    const codexEntries = advice.rankedCandidates.filter(
      (r) => r.candidate.providerId === "codex" && r.candidate.modelId === "gpt-4o"
    );
    assert.equal(codexEntries.length, 1);

    const codexRanked = advice.rankedCandidates.find(
      (r) => r.candidate.providerId === "codex"
    );
    const claudeRanked = advice.rankedCandidates.find(
      (r) => r.candidate.providerId === "claude"
    );
    assert.ok(codexRanked !== undefined);
    assert.ok(claudeRanked !== undefined);

    assert.equal(codexRanked.preferenceScore, 0);
    assert.equal(claudeRanked.preferenceScore, 0);
  });

  it("Conflicting preferences are resolved deterministically with clear visible reasons", () => {
    const requirements: TaskRequirements = {
      requiredCapabilities: ["planning", "reasoning"]
    };

    const preferences: ProjectPreferences = {
      projectId: "proj-conflicts",
      providerWeights: {
        codex: 0.5,
        gemini1: 2.0
      }
    };

    const advice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      requirements,
      preferences
    });

    assert.ok(advice.rankedCandidates.length > 0);
    const codexRanked = advice.rankedCandidates.find(
      (r) => r.candidate.providerId === "codex"
    );
    assert.ok(codexRanked !== undefined);
    assert.ok(
      codexRanked.reasons.some((r) =>
        r.includes("Satisfies all required capabilities")
      )
    );
    assert.ok(
      codexRanked.reasons.some((r) =>
        r.includes("Project preference provider weight")
      )
    );
  });

  it("Team output provides genuine complementary packages with per-role ownership, inputs, outputs, dependencies, and distinct model-specific work", () => {
    const overallPrompt = "Implement durable workstation session transaction receipts";

    const advice = adviseTeamModelChoice({
      candidates: CANDIDATES,
      overallPrompt
    });

    assert.equal(advice.mode, "complementary_roles");
    assert.equal(advice.isComparison, false);
    assert.equal(advice.assignments.length, 3);

    const planner = advice.assignments.find((a) => a.roleId === "planner");
    const coder = advice.assignments.find((a) => a.roleId === "coder");
    const reviewer = advice.assignments.find((a) => a.roleId === "reviewer");

    assert.ok(planner !== undefined);
    assert.ok(coder !== undefined);
    assert.ok(reviewer !== undefined);

    assert.equal(planner.ownership, "Architecture & Decomposition");
    assert.deepEqual(planner.inputs, ["task_requirements", "system_constraints"]);
    assert.deepEqual(planner.outputs, ["architecture_spec", "interface_contracts"]);
    assert.deepEqual(planner.dependencies, []);

    assert.equal(coder.ownership, "Implementation & Unit Tests");
    assert.deepEqual(coder.inputs, ["architecture_spec", "interface_contracts"]);
    assert.deepEqual(coder.outputs, ["source_code", "unit_tests"]);
    assert.deepEqual(coder.dependencies, ["planner"]);

    assert.equal(reviewer.ownership, "Quality Verification & Defect Analysis");
    assert.deepEqual(reviewer.inputs, ["source_code", "unit_tests", "architecture_spec"]);
    assert.deepEqual(reviewer.outputs, ["review_report", "verification_verdict"]);
    assert.deepEqual(reviewer.dependencies, ["planner", "coder"]);

    const distinctWork = new Set(advice.assignments.map((a) => a.modelSpecificWork));
    assert.equal(distinctWork.size, advice.assignments.length);

    const distinctPrompts = new Set(advice.assignments.map((a) => a.assignedPrompt));
    assert.equal(distinctPrompts.size, advice.assignments.length);

    for (const assignment of advice.assignments) {
      assert.ok(assignment.assignedPrompt.includes(overallPrompt));
      assert.ok(assignment.assignedPrompt.includes(assignment.modelSpecificWork));
      assert.ok(assignment.assignedPrompt.includes(assignment.ownership));
    }

    assert.ok(
      advice.reasons.some((r) =>
        r.includes("Comparison across identical prompts remains a separate explicit action")
      )
    );
  });

  it("Team leaves unsupported roles for owner review without guessing capabilities", () => {
    const limitedCandidates: readonly ModelCandidate[] = [
      {
        providerId: "codex",
        modelId: "gpt-4o",
        capabilities: ["planning"]
      }
    ];

    const advice = adviseTeamModelChoice({
      candidates: limitedCandidates,
      overallPrompt: "Build system"
    });
    assert.deepEqual(advice.assignments.map((one) => one.roleId), ["planner"]);
    assert.deepEqual(advice.unassignedRoles.map((one) => one.roleId), ["coder", "reviewer"]);
    assert.deepEqual(advice.reviewRequiredPackages.map((one) => one.roleId), ["coder", "reviewer"]);
    assert.ok(advice.reviewRequiredPackages.every((one) => one.reason.includes("owner review")));
    assert.ok(advice.reviewRequiredPackages.every((one) => one.draftPrompt.includes("Build system")));
  });

  it("Team holds downstream roles when a prerequisite is unassigned, even if roles arrive out of order", () => {
    const advice = adviseTeamModelChoice({
      candidates: [
        { providerId: "codex", modelId: "coder", capabilities: ["code"] },
        { providerId: "claude", modelId: "reviewer", capabilities: ["review"] }
      ],
      customRoles: [
        { roleId: "reviewer", roleName: "Reviewer", requiredCapabilities: ["review"],
          dependencies: ["coder"] },
        { roleId: "coder", roleName: "Coder", requiredCapabilities: ["code"],
          dependencies: ["planner"] },
        { roleId: "planner", roleName: "Planner", requiredCapabilities: ["planning"] }
      ]
    });
    assert.deepEqual(advice.assignments, []);
    assert.deepEqual(advice.unassignedRoles.map((role) => role.roleId), ["planner", "coder", "reviewer"]);
    assert.ok(advice.reviewRequiredPackages[1]?.reason.includes('Prerequisite role "planner"'));
    assert.ok(advice.reviewRequiredPackages[2]?.reason.includes('Prerequisite role "coder"'));
  });

  it("Team uses role-specific work when a custom specialization is blank", () => {
    const advice = adviseTeamModelChoice({
      candidates: [{ providerId: "codex", modelId: "planner", capabilities: ["planning"] }],
      customRoles: [{ roleId: "planner", roleName: "Planner", requiredCapabilities: ["planning"],
        promptSpecializationPrefix: "   " }],
      overallPrompt: "Make a plan"
    });
    assert.equal(advice.assignments.length, 1);
    assert.ok(advice.assignments[0]?.modelSpecificWork.includes("Execute Planner"));
    assert.ok(advice.assignments[0]?.assignedPrompt.includes("Execute Planner"));
  });

  it("Team keeps an admissible owner brief intact inside bounded, distinct role packages", () => {
    const overallPrompt = "x".repeat(MAX_PROMPT_LENGTH);
    const advice = adviseTeamModelChoice({ candidates: CANDIDATES, overallPrompt });
    assert.equal(advice.assignments.length, 3);
    assert.ok(advice.assignments.every((one) => one.assignedPrompt.includes(overallPrompt)));
    assert.ok(advice.assignments.every((one) => one.assignedPrompt.length <= MAX_TEAM_PACKAGE_PROMPT_LENGTH));
    assert.equal(new Set(advice.assignments.map((one) => one.assignedPrompt)).size, 3);
    assert.throws(() => adviseTeamModelChoice({
      candidates: CANDIDATES, overallPrompt: `${overallPrompt}x`
    }), /Shared objective exceeds the advisor limit/);
    assert.throws(() => adviseTeamModelChoice({
      candidates: CANDIDATES,
      customRoles: [{ roleId: "large", roleName: "Large role",
        requiredCapabilities: ["planning"], promptSpecializationPrefix: "x".repeat(MAX_TEAM_PACKAGE_PROMPT_LENGTH) }],
      overallPrompt: "Brief"
    }), /Team package prompt exceeds the advisor limit/);
  });

  it("Team with an honest empty capability catalog makes no automatic model assignment", () => {
    const advice = adviseTeamModelChoice({
      candidates: [
        { providerId: "codex", modelId: "listed-a", capabilities: [] },
        { providerId: "claude", modelId: "listed-b", capabilities: [] }
      ],
      overallPrompt: "Prepare a research artifact"
    });
    assert.deepEqual(advice.assignments, []);
    assert.deepEqual(advice.unassignedRoles.map((one) => one.roleId), ["planner", "coder", "reviewer"]);
    assert.equal(new Set(advice.reviewRequiredPackages.map((one) => one.draftPrompt)).size, 3);
    assert.ok(advice.reviewRequiredPackages[0]?.reason.includes("No detected model declares"));
    assert.ok(advice.reviewRequiredPackages.slice(1).every((one) => one.reason.includes("Prerequisite role")));
    assert.ok(advice.reasons[0]?.includes("0 roles have model assignments"));
    const unspecifiedRole = adviseTeamModelChoice({
      candidates: [{ providerId: "codex", modelId: "listed-a", capabilities: [] }],
      customRoles: [{ roleId: "unspecified", roleName: "Unspecified", requiredCapabilities: [] }]
    });
    assert.deepEqual(unspecifiedRole.assignments, []);
    assert.equal(unspecifiedRole.reviewRequiredPackages[0]?.roleId, "unspecified");
  });

  it("Team fails when dependency closure is broken (non-existent dependency or circular dependency)", () => {
    assert.throws(() => adviseTeamModelChoice({
      candidates: CANDIDATES,
      customRoles: [
        { roleId: "same", roleName: "First", requiredCapabilities: ["planning"] },
        { roleId: "same", roleName: "Second", requiredCapabilities: ["code"] }
      ]
    }), /duplicate roleId/);

    const brokenDepRoles: readonly TeamRoleDefinition[] = [
      {
        roleId: "a",
        roleName: "Role A",
        requiredCapabilities: ["planning"],
        dependencies: ["non_existent_role"]
      }
    ];

    assert.throws(
      () =>
        adviseTeamModelChoice({
          candidates: CANDIDATES,
          customRoles: brokenDepRoles
        }),
      /Dependency closure failure: role "a" depends on non-existent role "non_existent_role"/
    );

    const circularRoles: readonly TeamRoleDefinition[] = [
      {
        roleId: "a",
        roleName: "Role A",
        requiredCapabilities: ["planning"],
        dependencies: ["b"]
      },
      {
        roleId: "b",
        roleName: "Role B",
        requiredCapabilities: ["code"],
        dependencies: ["a"]
      }
    ];

    assert.throws(
      () =>
        adviseTeamModelChoice({
          candidates: CANDIDATES,
          customRoles: circularRoles
        }),
      /Dependency closure failure: circular dependency detected involving role "(a|b)"/
    );
  });

  it("forget returns cold-start advice with no cached stale score", () => {
    const heavyPrefs: ProjectPreferences = {
      projectId: "proj-reset",
      providerWeights: { gemini1: 2.0 }
    };

    const biasedAdvice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      preferences: heavyPrefs
    });
    assert.equal(biasedAdvice.selected?.candidate.providerId, "gemini1");

    const coldPrefs = forgetProjectPreferences("proj-reset");
    const coldAdvice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      preferences: coldPrefs
    });

    const cleanAdvice = adviseSoloModelChoice({
      candidates: CANDIDATES,
      preferences: null
    });

    assert.deepEqual(
      coldAdvice.rankedCandidates.map((r) => ({
        id: r.candidate.modelId,
        score: r.score
      })),
      cleanAdvice.rankedCandidates.map((r) => ({
        id: r.candidate.modelId,
        score: r.score
      }))
    );
  });

  it("refuses oversized exclusions, catalog and prompts without dropping owner intent", () => {
    assert.throws(() => adviseSoloModelChoice({
      candidates: CANDIDATES,
      preferences: { exclusions: Array.from({ length: 51 }, () => ({ providerId: "gemini1" })) }
    }), /exclusions exceed/i);
    assert.throws(() => adviseSoloModelChoice({
      candidates: Array.from({ length: 51 }, (_, i) => ({
        providerId: "codex" as const, modelId: `model-${i}`, capabilities: []
      }))
    }), /catalog exceeds/i);
    assert.throws(() => adviseTeamModelChoice({
      candidates: CANDIDATES,
      overallPrompt: "Do not spend money. ".repeat(200)
    }), /cannot be truncated/i);
  });
});
