/**
 * Pure recommendation advisor for smart Solo and Team model selection.
 *
 * Invariants:
 * - Solo's explicit provider+model choice must NEVER be overridden or auto-switched.
 * - Explicit Solo pin to a model absent from supplied catalog remains pinned but clearly unavailable (no synthetic candidate, no fallback).
 * - Explicit Solo pin conflicting with project exclusion is blocked and needs owner resolution (never auto-switched).
 * - For an unselected task, returns ranked available candidates only as advice with concise reasons.
 * - Team suggests complementary packages with per-role ownership, inputs, outputs, and dependencies; never identical prompts.
 * - Team models receive partitioned role-specific work; full prompt alone is not considered sufficient by itself.
 * - Team ensures dependency closure and fails when no capability-matched candidate exists.
 * - Multi-model comparison remains a separate explicit action.
 * - Only attempted receipts are counted in the reliability denominator; stopped/failed receipts without attempted state are excluded.
 * - Tiny reliability samples are treated as unknown/insufficient sample until threshold is satisfied.
 * - Bounded input arrays, role counts, and output prompt lengths; invalid preferences or duplicate catalog entries cannot manufacture a score.
 * - Completed operation evidence represents solely observed execution completion; it makes no claim regarding quality, correctness, preference, price, quota, or availability.
 * - Deterministic, bounded, and pure: no side-effects, no persistence, no stale cached scores.
 */

import type { WorkstationProviderId } from "./store.js";
import type { ModelOutcomeEvidence } from "./model-outcome-evidence.js";

export const DEFAULT_MAX_RECOMMENDATIONS = 10;
export const MIN_RELIABILITY_ATTEMPTS = 3;
export const MAX_CATALOG_CANDIDATES = 50;
export const MAX_EVIDENCE_RECORDS = 200;
export const MAX_CAPABILITIES_PER_CANDIDATE = 20;
export const MAX_EXCLUSIONS = 50;
export const MAX_TEAM_ROLES = 10;
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_TEAM_PACKAGE_PROMPT_LENGTH = 8000;

export interface ModelCandidate {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly capabilities: readonly string[];
  readonly displayName?: string;
  readonly contextTokens?: number;
}

export interface ExplicitModelChoice {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
}

export interface TaskRequirements {
  readonly requiredCapabilities?: readonly string[];
  readonly preferredCapabilities?: readonly string[];
  readonly estimatedTokens?: number;
  readonly taskType?: string;
  readonly prompt?: string;
}

export interface ModelExclusion {
  readonly providerId: WorkstationProviderId;
  readonly modelId?: string;
}

export interface ProjectPreferences {
  readonly projectId?: string | null;
  readonly exclusions?: readonly ModelExclusion[];
  readonly providerWeights?: Readonly<Record<string, number>>;
  readonly modelWeights?: Readonly<Record<string, number>>;
  readonly providerModelWeights?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly capabilityWeights?: Readonly<Record<string, number>>;
}

export type ReliabilityStatus = "measured" | "insufficient_sample" | "unknown";

export interface ModelReliabilitySignal {
  readonly status: ReliabilityStatus;
  readonly observedCompletedCount: number;
  readonly totalAttemptedCount: number;
  readonly completionRatio: number | null;
  readonly summary: string;
}

export interface RankedModelCandidate {
  readonly candidate: ModelCandidate;
  readonly score: number;
  readonly capabilityScore: number;
  readonly preferenceScore: number;
  readonly reliabilityScore: number;
  readonly reliabilitySignal: ModelReliabilitySignal;
  readonly reasons: readonly string[];
}

export type SoloPinStatus = "none" | "active" | "unavailable" | "blocked";

export interface SoloAdvisorInput {
  readonly candidates: readonly ModelCandidate[];
  readonly explicitChoice?: ExplicitModelChoice | null;
  readonly requirements?: TaskRequirements;
  readonly preferences?: ProjectPreferences | null;
  readonly evidence?: readonly ModelOutcomeEvidence[];
  readonly maxRecommendations?: number;
}

export interface SoloRecommendationAdvice {
  readonly isPinned: boolean;
  readonly pinStatus: SoloPinStatus;
  readonly selected: RankedModelCandidate | null;
  readonly rankedCandidates: readonly RankedModelCandidate[];
  readonly reasons: readonly string[];
}

export interface TeamRoleDefinition {
  readonly roleId: string;
  readonly roleName: string;
  readonly ownership?: string;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly preferredCapabilities?: readonly string[];
  readonly promptSpecializationPrefix?: string;
}

export interface TeamRoleAssignment {
  readonly roleId: string;
  readonly roleName: string;
  readonly ownership: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly assignedCandidate: ModelCandidate;
  readonly modelSpecificWork: string;
  readonly assignedPrompt: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface TeamReviewRequiredPackage {
  readonly roleId: string;
  readonly roleName: string;
  readonly ownership: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly modelSpecificWork: string;
  readonly draftPrompt: string;
  readonly reason: string;
}

export interface TeamAdvisorInput {
  readonly candidates: readonly ModelCandidate[];
  readonly requirements?: TaskRequirements;
  readonly customRoles?: readonly TeamRoleDefinition[];
  readonly preferences?: ProjectPreferences | null;
  readonly evidence?: readonly ModelOutcomeEvidence[];
  readonly overallPrompt?: string;
}

export interface TeamRecommendationAdvice {
  readonly mode: "complementary_roles";
  readonly isComparison: false;
  readonly assignments: readonly TeamRoleAssignment[];
  readonly unassignedRoles: readonly TeamRoleDefinition[];
  readonly reviewRequiredPackages: readonly TeamReviewRequiredPackage[];
  readonly reasons: readonly string[];
}

export const DEFAULT_TEAM_ROLES: readonly TeamRoleDefinition[] = [
  {
    roleId: "planner",
    roleName: "Decomposition & Architecture Planner",
    ownership: "Architecture & Decomposition",
    inputs: ["task_requirements", "system_constraints"],
    outputs: ["architecture_spec", "interface_contracts"],
    dependencies: [],
    requiredCapabilities: ["planning"],
    preferredCapabilities: ["reasoning", "architecture"],
    promptSpecializationPrefix: "[Role: Planner] Decompose requirements and establish module interface contracts"
  },
  {
    roleId: "coder",
    roleName: "Code Implementation Specialist",
    ownership: "Implementation & Unit Tests",
    inputs: ["architecture_spec", "interface_contracts"],
    outputs: ["source_code", "unit_tests"],
    dependencies: ["planner"],
    requiredCapabilities: ["code"],
    preferredCapabilities: ["refactoring", "implementation"],
    promptSpecializationPrefix: "[Role: Implementer] Implement concrete code units adhering to planned interfaces"
  },
  {
    roleId: "reviewer",
    roleName: "Verification & Quality Reviewer",
    ownership: "Quality Verification & Defect Analysis",
    inputs: ["source_code", "unit_tests", "architecture_spec"],
    outputs: ["review_report", "verification_verdict"],
    dependencies: ["planner", "coder"],
    requiredCapabilities: ["review"],
    preferredCapabilities: ["testing", "verification", "security"],
    promptSpecializationPrefix: "[Role: Reviewer] Inspect implementation for edge-case defects, invariants, and test coverage"
  }
];

export function isCandidateExcluded(
  candidate: { readonly providerId: string; readonly modelId?: string },
  exclusions?: readonly ModelExclusion[]
): boolean {
  if (!exclusions || exclusions.length === 0) {
    return false;
  }
  if (exclusions.length > MAX_EXCLUSIONS) {
    throw new Error("Project exclusions exceed the advisor limit; no exclusion may be silently ignored.");
  }
  for (const exclusion of exclusions) {
    if (exclusion.providerId === candidate.providerId) {
      if (!exclusion.modelId || exclusion.modelId === candidate.modelId) {
        return true;
      }
    }
  }
  return false;
}

export function isChoiceExcluded(
  choice: ExplicitModelChoice,
  exclusions?: readonly ModelExclusion[]
): boolean {
  return isCandidateExcluded(choice, exclusions);
}

function requireBoundedString(str: string, maxLength: number, label: string): string {
  if (typeof str !== "string" || str.length > maxLength) {
    throw new Error(`${label} exceeds the advisor limit; instructions cannot be truncated.`);
  }
  return str;
}

function deduplicateCandidates(
  candidates: readonly ModelCandidate[]
): readonly ModelCandidate[] {
  if (!Array.isArray(candidates)) {
    return [];
  }
  const seen = new Set<string>();
  const result: ModelCandidate[] = [];
  if (candidates.length > MAX_CATALOG_CANDIDATES) {
    throw new Error("Model catalog exceeds the advisor limit; candidates cannot be silently omitted.");
  }
  const boundedInput = candidates;

  for (const c of boundedInput) {
    if (!c || typeof c.providerId !== "string" || typeof c.modelId !== "string") {
      continue;
    }
    const key = `${c.providerId}:${c.modelId}`;
    if (!seen.has(key)) {
      seen.add(key);
      const caps = Array.isArray(c.capabilities)
        ? Array.from(
            new Set(
              c.capabilities
                .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
                .map((s: string) => s.trim().toLowerCase())
            )
          )
        : [];
      result.push({
        ...c,
        capabilities: caps
      });
      if (caps.length > MAX_CAPABILITIES_PER_CANDIDATE) throw new Error("Candidate capability list exceeds advisor limit.");
    }
  }
  return result;
}

export function computeReliabilitySignal(
  candidate: ModelCandidate,
  evidence?: readonly ModelOutcomeEvidence[]
): { readonly signal: ModelReliabilitySignal; readonly scoreDelta: number; readonly reason: string } {
  if (!evidence || !Array.isArray(evidence) || evidence.length === 0) {
    return {
      signal: {
        status: "unknown",
        observedCompletedCount: 0,
        totalAttemptedCount: 0,
        completionRatio: null,
        summary: "No measured operation evidence available; reliability is unknown (neutral baseline, not penalized as zero quality)."
      },
      scoreDelta: 0,
      reason: "No measured operation evidence; reliability remains unknown and is not penalized as zero quality."
    };
  }

  if (evidence.length > MAX_EVIDENCE_RECORDS) {
    throw new Error("Measured evidence exceeds advisor limit; no receipt may be silently omitted.");
  }
  const boundedEvidence = evidence;
  let observedCompletedCount = 0;
  let totalAttemptedCount = 0;

  for (const item of boundedEvidence) {
    if (!item || item.providerId !== candidate.providerId) {
      continue;
    }
    // A provider-reported model is the observed executor. A redirected run
    // cannot also count as a completed execution by the requested model.
    const executedModelId = item.reportedModelId ?? item.requestedModelId;
    const matchesModel = executedModelId === candidate.modelId;
    if (!matchesModel) {
      continue;
    }

    if (item.attemptState === "attempted") {
      totalAttemptedCount += 1;
      if (item.observedCompleted === true) {
        observedCompletedCount += 1;
      }
    }
  }

  if (totalAttemptedCount === 0) {
    return {
      signal: {
        status: "unknown",
        observedCompletedCount: 0,
        totalAttemptedCount: 0,
        completionRatio: null,
        summary: "No attempted operation receipts recorded; reliability status is unknown (neutral baseline, not penalized as zero quality)."
      },
      scoreDelta: 0,
      reason: "Unknown operation evidence: reliability status is unknown and never treated as zero quality or failure."
    };
  }

  if (totalAttemptedCount < MIN_RELIABILITY_ATTEMPTS) {
    return {
      signal: {
        status: "insufficient_sample",
        observedCompletedCount,
        totalAttemptedCount,
        completionRatio: null,
        summary: `Insufficient evidence sample (${totalAttemptedCount}/${MIN_RELIABILITY_ATTEMPTS} attempts, minimum ${MIN_RELIABILITY_ATTEMPTS} required); reliability signal is held neutral.`
      },
      scoreDelta: 0,
      reason: `Insufficient sample size (${totalAttemptedCount}/${MIN_RELIABILITY_ATTEMPTS} attempts); reliability remains neutral until sample threshold is reached.`
    };
  }

  const completionRatio = observedCompletedCount / totalAttemptedCount;
  const scoreDelta = Math.max(-10, Math.min(10, Math.round((completionRatio - 0.5) * 20)));
  const percentage = Math.round(completionRatio * 100);

  return {
    signal: {
      status: "measured",
      observedCompletedCount,
      totalAttemptedCount,
      completionRatio,
      summary: `Measured reliability: ${observedCompletedCount}/${totalAttemptedCount} observed completions (${percentage}%). Reflects execution stability only, not output quality or quota.`
    },
    scoreDelta,
    reason: `Measured reliability signal: ${observedCompletedCount}/${totalAttemptedCount} completions (${percentage}% execution stability; completion does not guarantee quality, price, or quota).`
  };
}

export function computeCapabilityScore(
  candidate: ModelCandidate,
  requirements?: TaskRequirements
): { readonly score: number; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  const candidateCaps = new Set(
    candidate.capabilities.map((c) => c.toLowerCase().trim())
  );

  const rawReqCaps = requirements?.requiredCapabilities;
  const rawPrefCaps = requirements?.preferredCapabilities;

  const reqCaps = Array.isArray(rawReqCaps)
    ? Array.from(
        new Set(
          rawReqCaps
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => c.trim())
        )
      )
    : [];

  const prefCaps = Array.isArray(rawPrefCaps)
    ? Array.from(
        new Set(
          rawPrefCaps
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => c.trim())
        )
      )
    : [];

  if (reqCaps.length > MAX_CAPABILITIES_PER_CANDIDATE || prefCaps.length > MAX_CAPABILITIES_PER_CANDIDATE) {
    throw new Error("Task capability requirements exceed advisor limit; none may be silently omitted.");
  }

  let requiredScore = 30;
  if (reqCaps.length > 0) {
    if (candidateCaps.size === 0) {
      reasons.push(`Host model capabilities are undeclared; required capabilities [${reqCaps.join(", ")}] are unverified (neutral baseline).`);
    } else {
      let matchedReq = 0;
      const undeclaredReq: string[] = [];
      for (const cap of reqCaps) {
        if (candidateCaps.has(cap.toLowerCase())) {
          matchedReq += 1;
        } else {
          undeclaredReq.push(cap);
        }
      }
      const ratio = matchedReq / reqCaps.length;
      requiredScore = Math.round(ratio * 40);
      if (undeclaredReq.length === 0) {
        reasons.push(`Satisfies all required capabilities: [${reqCaps.join(", ")}]`);
      } else {
        reasons.push(`Required capabilities not declared: [${undeclaredReq.join(", ")}]`);
      }
    }
  } else {
    reasons.push("No explicit required capabilities specified (assigned baseline score).");
  }

  let preferredScore = 0;
  if (prefCaps.length > 0) {
    let matchedPref = 0;
    const matchedNames: string[] = [];
    for (const cap of prefCaps) {
      if (candidateCaps.has(cap.toLowerCase())) {
        matchedPref += 1;
        matchedNames.push(cap);
      }
    }
    preferredScore = Math.round((matchedPref / prefCaps.length) * 20);
    if (matchedNames.length > 0) {
      reasons.push(`Matches preferred capabilities: [${matchedNames.join(", ")}]`);
    }
  }

  const totalCapScore = requiredScore + preferredScore;
  return { score: totalCapScore, reasons };
}

export function computePreferenceScore(
  candidate: ModelCandidate,
  preferences?: ProjectPreferences | null
): { readonly score: number; readonly reasons: readonly string[] } {
  if (!preferences) {
    return { score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let scoreDelta = 0;

  if (preferences.providerWeights && typeof preferences.providerWeights === "object") {
    if (Object.prototype.hasOwnProperty.call(preferences.providerWeights, candidate.providerId)) {
      const pWeight = preferences.providerWeights[candidate.providerId];
      if (typeof pWeight === "number" && Number.isFinite(pWeight) && pWeight >= 0 && pWeight <= 2.0) {
        const delta = Math.max(-10, Math.min(10, Math.round((pWeight - 1.0) * 10)));
        if (delta !== 0) {
          scoreDelta += delta;
          reasons.push(
            `Project preference provider weight (${candidate.providerId}: ${pWeight}) adjusted score by ${delta}.`
          );
        }
      }
    }
  }

  if (preferences.modelWeights && typeof preferences.modelWeights === "object") {
    if (Object.prototype.hasOwnProperty.call(preferences.modelWeights, candidate.modelId)) {
      const mWeight = preferences.modelWeights[candidate.modelId];
      if (typeof mWeight === "number" && Number.isFinite(mWeight) && mWeight >= 0 && mWeight <= 2.0) {
        const delta = Math.max(-10, Math.min(10, Math.round((mWeight - 1.0) * 10)));
        if (delta !== 0) {
          scoreDelta += delta;
          reasons.push(
            `Project preference model weight (${candidate.modelId}: ${mWeight}) adjusted score by ${delta}.`
          );
        }
      }
    }
  }

  const scopedWeights = preferences.providerModelWeights?.[candidate.providerId];
  if (scopedWeights && typeof scopedWeights === "object" &&
      Object.prototype.hasOwnProperty.call(scopedWeights, candidate.modelId)) {
    const weight = scopedWeights[candidate.modelId];
    if (typeof weight === "number" && Number.isFinite(weight) && weight >= 0 && weight <= 2) {
      const delta = Math.max(-10, Math.min(10, Math.round((weight - 1) * 10)));
      if (delta !== 0) {
        scoreDelta += delta;
        reasons.push(
          `Project preference provider-model weight (${candidate.providerId}:${candidate.modelId}: ${weight}) adjusted score by ${delta}.`
        );
      }
    }
  }

  const boundedScore = Math.max(-20, Math.min(20, scoreDelta));
  return { score: boundedScore, reasons };
}

function evaluateCandidate(
  candidate: ModelCandidate,
  requirements?: TaskRequirements,
  preferences?: ProjectPreferences | null,
  evidence?: readonly ModelOutcomeEvidence[]
): RankedModelCandidate {
  const capEval = computeCapabilityScore(candidate, requirements);
  const prefEval = computePreferenceScore(candidate, preferences);
  const relEval = computeReliabilitySignal(candidate, evidence);

  const baseScore = 20;
  const rawScore = baseScore + capEval.score + prefEval.score + relEval.scoreDelta;
  const score = Math.max(0, Math.min(100, rawScore));

  const reasons: string[] = [
    ...capEval.reasons,
    ...prefEval.reasons,
    relEval.reason
  ];

  return {
    candidate,
    score,
    capabilityScore: capEval.score,
    preferenceScore: prefEval.score,
    reliabilityScore: relEval.scoreDelta,
    reliabilitySignal: relEval.signal,
    reasons
  };
}

function compareRankedCandidates(
  a: RankedModelCandidate,
  b: RankedModelCandidate
): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (b.capabilityScore !== a.capabilityScore) {
    return b.capabilityScore - a.capabilityScore;
  }
  const provCmp = a.candidate.providerId.localeCompare(b.candidate.providerId);
  if (provCmp !== 0) {
    return provCmp;
  }
  return a.candidate.modelId.localeCompare(b.candidate.modelId);
}

export function forgetProjectPreferences(projectId?: string | null): ProjectPreferences {
  return {
    projectId: projectId ?? null,
    exclusions: [],
    providerWeights: {},
    modelWeights: {},
    providerModelWeights: {},
    capabilityWeights: {}
  };
}

export function adviseSoloModelChoice(
  input: SoloAdvisorInput
): SoloRecommendationAdvice {
  const deduplicated = deduplicateCandidates(input.candidates);

  if (input.explicitChoice) {
    const choice = input.explicitChoice;
    const exclusions = input.preferences?.exclusions;

    if (isChoiceExcluded(choice, exclusions)) {
      return {
        isPinned: true,
        pinStatus: "blocked",
        selected: null,
        rankedCandidates: [],
        reasons: [
          `Explicit pin ${choice.providerId}:${choice.modelId} conflicts with project exclusion policy and is blocked. Requires owner resolution; auto-switching is prohibited.`
        ]
      };
    }

    const catalogCandidate = deduplicated.find(
      (c) => c.providerId === choice.providerId && c.modelId === choice.modelId
    );

    if (!catalogCandidate) {
      return {
        isPinned: true,
        pinStatus: "unavailable",
        selected: null,
        rankedCandidates: [],
        reasons: [
          `Explicit pin ${choice.providerId}:${choice.modelId} is absent from supplied candidate catalog; pinned but unavailable. No synthetic candidate connected and fallback is prohibited.`
        ]
      };
    }

    const evaluated = evaluateCandidate(
      catalogCandidate,
      input.requirements,
      input.preferences,
      input.evidence
    );

    const pinnedReasons = [
      `Explicit model pin active (${choice.providerId}:${choice.modelId}). Auto-switch and ranking override disabled.`,
      ...evaluated.reasons
    ];

    const pinnedRanked: RankedModelCandidate = {
      ...evaluated,
      reasons: pinnedReasons
    };

    return {
      isPinned: true,
      pinStatus: "active",
      selected: pinnedRanked,
      rankedCandidates: [pinnedRanked],
      reasons: [
        `Explicit model pin active (${choice.providerId}:${choice.modelId}). Auto-switch and ranking override disabled.`
      ]
    };
  }

  const exclusions = input.preferences?.exclusions;
  const availableCandidates = deduplicated.filter(
    (c) => !isCandidateExcluded(c, exclusions)
  );

  if (availableCandidates.length === 0) {
    const exclusionReason =
      deduplicated.length > 0
        ? "All available model candidates were excluded by per-project preference filters."
        : "No model candidates provided for selection.";
    return {
      isPinned: false,
      pinStatus: "none",
      selected: null,
      rankedCandidates: [],
      reasons: [exclusionReason]
    };
  }

  const ranked: RankedModelCandidate[] = availableCandidates.map((candidate) =>
    evaluateCandidate(
      candidate,
      input.requirements,
      input.preferences,
      input.evidence
    )
  );

  ranked.sort(compareRankedCandidates);

  const limit =
    typeof input.maxRecommendations === "number" &&
    Number.isFinite(input.maxRecommendations) &&
    input.maxRecommendations > 0
      ? Math.min(MAX_CATALOG_CANDIDATES, Math.floor(input.maxRecommendations))
      : DEFAULT_MAX_RECOMMENDATIONS;

  const boundedRanked = ranked.slice(0, limit);
  const topCandidate = boundedRanked[0] ?? null;

  const hasDeclaredCapabilities = boundedRanked.some(
    (candidate) => candidate.candidate.capabilities.length > 0
  );
  const advisorReasons: string[] = [
    hasDeclaredCapabilities
      ? `Ranked ${boundedRanked.length} available model candidates using declared capabilities, project preferences, and observed operation completion where available.`
      : `Ranked ${boundedRanked.length} available model candidates with no declared model capabilities; project preferences and observed operation completion were used where available.`
  ];
  if (topCandidate) {
    advisorReasons.push(
      `Recommended candidate: ${topCandidate.candidate.providerId}:${topCandidate.candidate.modelId} (score: ${topCandidate.score}/100).`
    );
  }

  return {
    isPinned: false,
    pinStatus: "none",
    selected: topCandidate,
    rankedCandidates: boundedRanked,
    reasons: advisorReasons
  };
}

function isCapabilityMatched(
  candidate: ModelCandidate,
  requiredCapabilities: readonly string[]
): boolean {
  if (requiredCapabilities.length === 0) {
    return true;
  }
  const candidateCaps = new Set(
    candidate.capabilities.map((c) => c.toLowerCase().trim())
  );
  return requiredCapabilities.every((cap) =>
    candidateCaps.has(cap.toLowerCase().trim())
  );
}

function validateDependencyClosure(roles: readonly TeamRoleDefinition[]): readonly TeamRoleDefinition[] {
  const roleById = new Map<string, TeamRoleDefinition>(
    roles.map((role) => [role.roleId, role])
  );
  if (roleById.size !== roles.length) {
    throw new Error("Team role definitions contain duplicate roleId identifiers.");
  }

  for (const role of roles) {
    const deps = role.dependencies ?? [];
    for (const dep of deps) {
      if (!roleById.has(dep)) {
        throw new Error(
          `Dependency closure failure: role "${role.roleId}" depends on non-existent role "${dep}".`
        );
      }
      if (dep === role.roleId) {
        throw new Error(
          `Dependency closure failure: role "${role.roleId}" cannot depend on itself.`
        );
      }
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const orderedRoles: TeamRoleDefinition[] = [];

  function checkCycle(roleId: string): boolean {
    visited.add(roleId);
    inStack.add(roleId);

    const role = roleById.get(roleId);
    if (!role) throw new Error(`Dependency closure failure: unknown role "${roleId}".`);
    const deps = role.dependencies ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (checkCycle(dep)) {
          return true;
        }
      } else if (inStack.has(dep)) {
        return true;
      }
    }

    inStack.delete(roleId);
    orderedRoles.push(role);
    return false;
  }

  for (const role of roles) {
    if (!visited.has(role.roleId)) {
      if (checkCycle(role.roleId)) {
        throw new Error(
          `Dependency closure failure: circular dependency detected involving role "${role.roleId}".`
        );
      }
    }
  }
  return orderedRoles;
}

export function adviseTeamModelChoice(
  input: TeamAdvisorInput
): TeamRecommendationAdvice {
  const deduplicated = deduplicateCandidates(input.candidates);
  const exclusions = input.preferences?.exclusions;
  const availableCandidates = deduplicated.filter(
    (c) => !isCandidateExcluded(c, exclusions)
  );

  const rawRoles =
    input.customRoles && input.customRoles.length > 0
      ? input.customRoles
      : DEFAULT_TEAM_ROLES;

  if (rawRoles.length > MAX_TEAM_ROLES) {
    throw new Error("Team role count exceeds advisor limit; no package may be silently omitted.");
  }
  const roles = validateDependencyClosure(rawRoles);

  const assignments: TeamRoleAssignment[] = [];
  const unassignedRoles: TeamRoleDefinition[] = [];
  const reviewRequiredPackages: TeamReviewRequiredPackage[] = [];
  const unassignedRoleIds = new Set<string>();
  const assignedModelKeys = new Set<string>();
  const packageWorkSet = new Set<string>();
  const packagePromptSet = new Set<string>();
  const boundedOverallPrompt = input.overallPrompt
    ? requireBoundedString(input.overallPrompt, MAX_PROMPT_LENGTH, "Shared objective")
    : undefined;

  for (const role of roles) {
    const roleReqCaps = role.requiredCapabilities ?? [];
    const rolePrefCaps = role.preferredCapabilities ?? [];
    if (roleReqCaps.length > MAX_CAPABILITIES_PER_CANDIDATE || rolePrefCaps.length > MAX_CAPABILITIES_PER_CANDIDATE) {
      throw new Error(`Role ${role.roleId} has too many capability requirements; none may be silently omitted.`);
    }

    const ownership = role.ownership ?? role.roleName;
    const inputs = role.inputs && role.inputs.length > 0 ? role.inputs : ["task_context"];
    const outputs = role.outputs && role.outputs.length > 0 ? role.outputs : [`${role.roleId}_deliverable`];
    const dependencies = role.dependencies ?? [];
    const specialization = role.promptSpecializationPrefix;
    const modelSpecificWork = specialization && specialization.trim().length > 0
      ? specialization
      : `Execute ${role.roleName} focusing on required capabilities: [${roleReqCaps.join(", ")}].`;
    const rawAssignedPrompt = boundedOverallPrompt
      ? `[Shared Objective]: ${boundedOverallPrompt}\n[Role Ownership]: ${ownership}\n[Inputs]: ${inputs.join(", ")}\n[Outputs]: ${outputs.join(", ")}\n[Dependencies]: ${dependencies.length > 0 ? dependencies.join(", ") : "none"}\n[Model-Specific Work]: ${modelSpecificWork}`
      : `[Role Ownership]: ${ownership}\n[Inputs]: ${inputs.join(", ")}\n[Outputs]: ${outputs.join(", ")}\n[Dependencies]: ${dependencies.length > 0 ? dependencies.join(", ") : "none"}\n[Model-Specific Work]: ${modelSpecificWork}`;
    const assignedPrompt = requireBoundedString(
      rawAssignedPrompt, MAX_TEAM_PACKAGE_PROMPT_LENGTH, "Team package prompt"
    );
    if (packageWorkSet.has(modelSpecificWork) || packagePromptSet.has(assignedPrompt)) {
      throw new Error(`Invariant violation: duplicate role work or prompt for role "${role.roleId}".`);
    }
    packageWorkSet.add(modelSpecificWork);
    packagePromptSet.add(assignedPrompt);

    const blockedDependency = dependencies.find((dependency) => unassignedRoleIds.has(dependency));
    if (blockedDependency) {
      const reason = `Prerequisite role "${blockedDependency}" requires owner review; this dependent role cannot be assigned yet.`;
      unassignedRoles.push(role);
      unassignedRoleIds.add(role.roleId);
      reviewRequiredPackages.push({ roleId: role.roleId, roleName: role.roleName,
        ownership, inputs, outputs, dependencies, requiredCapabilities: roleReqCaps,
        modelSpecificWork, draftPrompt: assignedPrompt, reason });
      continue;
    }

    const matchingCandidates = roleReqCaps.length === 0 ? [] : availableCandidates.filter((c) =>
      c.capabilities.length > 0 && isCapabilityMatched(c, roleReqCaps)
    );

    if (matchingCandidates.length === 0) {
      const reason = roleReqCaps.length === 0
        ? "This role has no required capabilities to verify; owner model review is required."
        : availableCandidates.length === 0
        ? "No detected, non-excluded model is available for automatic assignment; owner review required."
        : `No detected model declares all required capabilities [${roleReqCaps.join(", ")}]; owner review required before choosing a model.`;
      unassignedRoles.push(role);
      unassignedRoleIds.add(role.roleId);
      reviewRequiredPackages.push({ roleId: role.roleId, roleName: role.roleName,
        ownership, inputs, outputs, dependencies, requiredCapabilities: roleReqCaps,
        modelSpecificWork, draftPrompt: assignedPrompt, reason });
      continue;
    }

    const roleReqs: TaskRequirements = {
      requiredCapabilities: roleReqCaps,
      preferredCapabilities: rolePrefCaps,
      taskType: role.roleId
    };

    const scoredForRole = matchingCandidates.map((c) => {
      const evaluation = evaluateCandidate(
        c,
        roleReqs,
        input.preferences,
        input.evidence
      );
      const modelKey = `${c.providerId}:${c.modelId}`;
      const isAlreadyAssigned = assignedModelKeys.has(modelKey);
      const diversityBonus = isAlreadyAssigned ? 0 : 15;
      const combinedScore = Math.min(100, evaluation.score + diversityBonus);
      return {
        candidate: c,
        evaluation,
        combinedScore,
        isAlreadyAssigned
      };
    });

    scoredForRole.sort((a, b) => {
      if (b.combinedScore !== a.combinedScore) {
        return b.combinedScore - a.combinedScore;
      }
      return compareRankedCandidates(a.evaluation, b.evaluation);
    });

    const best = scoredForRole[0];
    if (!best) {
      throw new Error(
        `Failed to assemble team: no candidate could be selected for role "${role.roleId}".`
      );
    }

    assignedModelKeys.add(`${best.candidate.providerId}:${best.candidate.modelId}`);

    const assignmentReasons = [
      `Assigned to role "${role.roleName}" satisfying required capabilities [${roleReqCaps.join(", ")}].`,
      ...best.evaluation.reasons
    ];
    if (!best.isAlreadyAssigned) {
      assignmentReasons.push("Distinct model selected for this role based on declared capabilities and available evidence.");
    } else {
      assignmentReasons.push("Shared model assignment: selected candidate satisfies role requirements among limited available models.");
    }

    assignments.push({
      roleId: role.roleId,
      roleName: role.roleName,
      ownership,
      inputs,
      outputs,
      dependencies,
      assignedCandidate: best.candidate,
      modelSpecificWork,
      assignedPrompt,
      score: best.combinedScore,
      reasons: assignmentReasons
    });
  }

  const teamReasons = [
    `${assignments.length} roles have model assignments supported by declared capabilities; ${reviewRequiredPackages.length} require owner model review.`,
    "Each role has a distinct work package. Comparison across identical prompts remains a separate explicit action; this advice does not dispatch work."
  ];

  return {
    mode: "complementary_roles",
    isComparison: false,
    assignments,
    unassignedRoles,
    reviewRequiredPackages,
    reasons: teamReasons
  };
}
