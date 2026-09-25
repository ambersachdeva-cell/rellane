import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { WorkstationProvider, WorkstationProviderId, WorkstationStatus } from "@cadrane/contracts";
import { describeConnection } from "./connection-readiness.js";
import type { NativeProviderLaunch } from "./types.js";

const EXTENSION_BIN_SUBPATHS: readonly string[] = [
  join("resources", "native-binary", "claude"),
  join("bin", "claude"),
  join("out", "bin", "claude")
];

export interface ProviderDiscoveryOverrides {
  readonly codexPath?: string | null;
  readonly claudePath?: string | null;
  readonly agyPath?: string | null;
  readonly setupDir?: string;
  readonly homeDirectory?: string;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return false;
    }
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs(envPath?: string, homeDirectory?: string): string[] {
  const rawPath = envPath ?? process.env["PATH"] ?? "";
  const fromPath = rawPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isAbsolute(entry));

  const home = homeDirectory ?? homedir();
  const wellKnown = [
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of [...fromPath, ...wellKnown]) {
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    ordered.push(dir);
  }
  return ordered;
}

function editorExtensionRoots(homeDirectory?: string): string[] {
  const home = homeDirectory ?? homedir();
  return [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".cursor", "extensions"),
    join(home, ".windsurf", "extensions")
  ];
}

interface ClaudeCandidate {
  readonly path: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly mtimeMs: number;
}

function parseSemver(dirName: string): { major: number; minor: number; patch: number } | null {
  const match = dirName.match(/anthropic\.claude-code-(?:v)?(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    return {
      major: Number.parseInt(match[1] ?? "0", 10),
      minor: Number.parseInt(match[2] ?? "0", 10),
      patch: Number.parseInt(match[3] ?? "0", 10)
    };
  }
  const shortMatch = dirName.match(/anthropic\.claude-code-(?:v)?(\d+)\.(\d+)/);
  if (shortMatch) {
    return {
      major: Number.parseInt(shortMatch[1] ?? "0", 10),
      minor: Number.parseInt(shortMatch[2] ?? "0", 10),
      patch: 0
    };
  }
  return null;
}

export async function findCodexExecutable(homeDirectory?: string): Promise<string | null> {
  const home = homeDirectory ?? homedir();
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    ...searchDirs(undefined, home).map((dir) => join(dir, "codex"))
  ];

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function findClaudeExecutable(homeDirectory?: string): Promise<string | null> {
  const home = homeDirectory ?? homedir();
  const candidates: ClaudeCandidate[] = [];

  for (const root of editorExtensionRoots(home)) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("anthropic.claude-code")) {
          continue;
        }
        const semver = parseSemver(entry.name) ?? { major: 0, minor: 0, patch: 0 };
        for (const subpath of EXTENSION_BIN_SUBPATHS) {
          const candidatePath = join(root, entry.name, subpath);
          if (await isExecutableFile(candidatePath)) {
            let mtimeMs = 0;
            try {
              const fileStat = await stat(candidatePath);
              mtimeMs = fileStat.mtimeMs;
            } catch {
              // File stat unreadable, default mtime to 0
            }
            candidates.push({
              path: candidatePath,
              major: semver.major,
              minor: semver.minor,
              patch: semver.patch,
              mtimeMs
            });
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (b.major !== a.major) return b.major - a.major;
      if (b.minor !== a.minor) return b.minor - a.minor;
      if (b.patch !== a.patch) return b.patch - a.patch;
      return b.mtimeMs - a.mtimeMs;
    });
    return candidates[0]?.path ?? null;
  }

  const fallbackCandidates = [
    join(home, ".local", "bin", "claude"),
    ...searchDirs(undefined, home).map((dir) => join(dir, "claude"))
  ];
  for (const candidate of fallbackCandidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function findAgyExecutable(homeDirectory?: string): Promise<string | null> {
  const home = homeDirectory ?? homedir();
  const candidates = [
    join(home, ".local", "bin", "agy"),
    ...searchDirs(undefined, home).map((dir) => join(dir, "agy"))
  ];

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveGeminiProfileHome(
  profileKey: "config1" | "config2" | "config3",
  setupDir?: string,
  homeDirectory?: string
): string {
  if (setupDir) {
    return join(setupDir, profileKey);
  }
  if (process.env["AGY_SETUP_DIR"]) {
    return join(process.env["AGY_SETUP_DIR"], profileKey);
  }
  const home = homeDirectory ?? process.env["HOME"] ?? homedir();
  return join(home, "agy-setup", profileKey);
}

/**
 * Whether a profile directory is there — and nothing beyond that.
 *
 * Deliberately a directory check: the files that would say whether an account is
 * signed in are that vendor's credentials, and this app does not open them. So
 * "the folder exists" is the strongest claim available here, and the labels
 * below say exactly that rather than implying a working account.
 */
async function directoryExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function discoverWorkstationProviders(
  overrides?: ProviderDiscoveryOverrides
): Promise<NativeProviderLaunch[]> {
  const home = overrides?.homeDirectory;
  const [codexExe, claudeExe, agyExe] = await Promise.all([
    overrides?.codexPath !== undefined ? Promise.resolve(overrides.codexPath) : findCodexExecutable(home),
    overrides?.claudePath !== undefined ? Promise.resolve(overrides.claudePath) : findClaudeExecutable(home),
    overrides?.agyPath !== undefined ? Promise.resolve(overrides.agyPath) : findAgyExecutable(home)
  ]);

  // "Detected" is a statement about a file on disk, never about an account.
  // Whether the subscription behind a CLI will answer is only knowable from a
  // real attempt, and the host upgrades or blocks the row once one has happened.
  const codexProvider: WorkstationProvider = {
    id: "codex",
    label: "Codex",
    family: "codex",
    state: codexExe !== null ? "detected" : "unavailable",
    detail: describeConnection({
      family: "codex",
      executable: codexExe
    }).detail,
    // Empty means "whatever the CLI is configured to use". Naming models this
    // app has not verified would imply the owner's plan includes them.
    models: [],
    canResume: true,
    // The app-server has a real approval protocol, and this adapter answers it.
    canApproveTools: true
  };

  const claudeProvider: WorkstationProvider = {
    id: "claude",
    label: "Claude",
    family: "claude",
    state: claudeExe !== null ? "detected" : "unavailable",
    detail: describeConnection({
      family: "claude",
      executable: claudeExe
    }).detail,
    models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }],
    canResume: true,
    // Native stdio control was verified with real Read/Write allow and deny decisions.
    canApproveTools: true
  };

  const geminiModels = [
    {
      id: "gemini-3.8-flash-high",
      label: "Gemini 3.8 Flash (High)"
    }
  ] as const;

  const createGeminiLaunch = async (
    id: "gemini1" | "gemini2" | "gemini3",
    label: string,
    profileKey: "config1" | "config2" | "config3"
  ): Promise<NativeProviderLaunch> => {
    const profileHome = resolveGeminiProfileHome(profileKey, overrides?.setupDir, home);
    const hasProfile = await directoryExists(profileHome);
    const provider: WorkstationProvider = {
      id,
      label,
      family: "gemini",
      state: agyExe !== null ? "detected" : "unavailable",
      detail: describeConnection({
        family: "gemini",
        executable: agyExe,
        profileReady: hasProfile,
        profileKey
      }).detail,
      models: geminiModels,
      canResume: true,
      // Headless stream-json carries no approval channel, so a tool this
      // session cannot run is refused by the sandbox rather than asked about.
      canApproveTools: false
    };

    return {
      provider,
      executable: agyExe,
      profileHome
    };
  };

  const geminiLaunches = await Promise.all([
    createGeminiLaunch("gemini1", "Gemini (Profile 1)", "config1"),
    createGeminiLaunch("gemini2", "Gemini (Profile 2)", "config2"),
    createGeminiLaunch("gemini3", "Gemini (Profile 3)", "config3")
  ]);

  return [
    {
      provider: codexProvider,
      executable: codexExe
    },
    {
      provider: claudeProvider,
      executable: claudeExe
    },
    ...geminiLaunches
  ];
}

export interface ModelCandidateFact {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly profileId?: string;
  readonly readiness: "ready" | "detected" | "unavailable" | "exhausted" | "unknown";
  readonly observedAt?: number;
  readonly readinessEvidence?: string;
  readonly confirmedCapabilities?: readonly string[];
  readonly contextLimit?: number;
  readonly quotaState?: "available" | "exhausted" | "unknown";
  readonly costTier?: "included-subscription" | "unknown" | "paid";
  readonly taskFitEvidence?: string;
}

export interface DeliberateProjectChoice {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly profileId?: string;
  readonly reason?: string;
}

export interface RecommendWorkstationModelsInput {
  readonly taskRole?: string;
  readonly taskRequirements?: readonly string[];
  readonly allowedProviders?: readonly WorkstationProviderId[];
  readonly sourceSensitivity?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly requiredContextSize?: number;
  readonly candidates: readonly ModelCandidateFact[];
  readonly deliberateChoice?: DeliberateProjectChoice;
}

export interface WorkstationModelRecommendation {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly profileId?: string;
  readonly reasons: readonly string[];
  readonly evidence: readonly string[];
  readonly unknowns: readonly string[];
  readonly isDeliberateChoice: boolean;
  readonly readiness: "ready" | "detected" | "unavailable" | "exhausted" | "unknown";
  readonly quotaState: "available" | "exhausted" | "unknown";
  readonly costTier: "included-subscription" | "unknown" | "paid";
}

export interface ExcludedModelCandidate {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly profileId?: string;
  readonly reasons: readonly string[];
}

export interface RecommendWorkstationModelsResult {
  readonly recommendations: readonly WorkstationModelRecommendation[];
  readonly excluded: readonly ExcludedModelCandidate[];
  readonly deliberateChoiceApplied: boolean;
}

export function recommendWorkstationModels(
  input: RecommendWorkstationModelsInput
): RecommendWorkstationModelsResult {
  const excluded: ExcludedModelCandidate[] = [];
  const eligibleRecommendations: WorkstationModelRecommendation[] = [];

  for (const candidate of input.candidates) {
    const exclusionReasons: string[] = [];

    if (input.allowedProviders !== undefined && !input.allowedProviders.includes(candidate.providerId)) {
      exclusionReasons.push(`Provider '${candidate.providerId}' is not in the allowed provider list`);
    }

    if (candidate.readiness === "unavailable") {
      exclusionReasons.push("Candidate provider or model is unavailable");
    }

    if (candidate.quotaState === "exhausted" || candidate.readiness === "exhausted") {
      exclusionReasons.push("Candidate quota is exhausted");
    }

    if (input.requiredCapabilities && input.requiredCapabilities.length > 0) {
      const confirmed = new Set(candidate.confirmedCapabilities ?? []);
      for (const reqCap of input.requiredCapabilities) {
        if (!confirmed.has(reqCap)) {
          exclusionReasons.push(`Missing required capability: ${reqCap}`);
        }
      }
    }

    if (
      typeof input.requiredContextSize === "number" &&
      typeof candidate.contextLimit === "number" &&
      candidate.contextLimit < input.requiredContextSize
    ) {
      exclusionReasons.push(
        `Required context size (${input.requiredContextSize}) exceeds confirmed context limit (${candidate.contextLimit})`
      );
    }

    if (candidate.costTier === "paid") {
      exclusionReasons.push("Paid API candidates are disallowed under included-subscription policy");
    }

    if (exclusionReasons.length > 0) {
      excluded.push({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
        reasons: exclusionReasons
      });
      continue;
    }

    const reasons: string[] = [];
    const evidence: string[] = [];
    const unknowns: string[] = [];

    const isDeliberate = Boolean(
      input.deliberateChoice &&
        input.deliberateChoice.providerId === candidate.providerId &&
        input.deliberateChoice.modelId === candidate.modelId &&
        (!input.deliberateChoice.profileId || input.deliberateChoice.profileId === candidate.profileId)
    );

    if (isDeliberate) {
      reasons.push("Selected via explicit owner preference (recognized as owner preference, not measured superiority)");
      if (input.deliberateChoice?.reason) {
        reasons.push(input.deliberateChoice.reason);
      }
      evidence.push("Owner deliberate project choice confirmed");
    }

    if (candidate.taskFitEvidence && candidate.taskFitEvidence.trim().length > 0) {
      evidence.push(candidate.taskFitEvidence.trim());
      if (input.taskRole) {
        reasons.push(`Observed task-fit evidence for role '${input.taskRole}': ${candidate.taskFitEvidence.trim()}`);
      } else {
        reasons.push(`Observed task-fit evidence: ${candidate.taskFitEvidence.trim()}`);
      }
    } else {
      reasons.push("No quality evidence supplied for task-fit");
    }

    if (candidate.readiness === "ready") {
      evidence.push(
        candidate.readinessEvidence ??
          `Verified ready (observed at ${typeof candidate.observedAt === "number" ? candidate.observedAt : "unspecified timestamp"})`
      );
    } else if (candidate.readiness === "detected") {
      unknowns.push("Executable detected on disk, but sign-in and quota are unverified (detection is not sign-in evidence)");
    } else {
      unknowns.push(`Readiness status is ${candidate.readiness}`);
    }

    if (candidate.quotaState === "available") {
      evidence.push("Subscription quota confirmed available");
    } else {
      unknowns.push("Quota availability is unverified/unknown");
    }

    if (candidate.costTier === "included-subscription") {
      evidence.push("Covered under existing workstation subscription");
    } else {
      unknowns.push("Cost tier is unverified/unknown");
    }

    if (typeof candidate.contextLimit === "number") {
      evidence.push(`Confirmed context window: ${candidate.contextLimit}`);
    } else {
      unknowns.push("Source-size context limit is unknown");
      if (typeof input.requiredContextSize === "number") {
        unknowns.push(`Required context size is ${input.requiredContextSize}, but candidate limit is unverified`);
      }
    }

    if (candidate.confirmedCapabilities && candidate.confirmedCapabilities.length > 0) {
      evidence.push(`Confirmed capabilities: ${candidate.confirmedCapabilities.join(", ")}`);
    }

    eligibleRecommendations.push({
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
      reasons,
      evidence,
      unknowns,
      isDeliberateChoice: isDeliberate,
      readiness: candidate.readiness,
      quotaState: candidate.quotaState ?? "unknown",
      costTier: candidate.costTier ?? "unknown"
    });
  }

  eligibleRecommendations.sort((a, b) => {
    if (a.isDeliberateChoice !== b.isDeliberateChoice) {
      return a.isDeliberateChoice ? -1 : 1;
    }
    const readinessWeight = (r: string): number => (r === "ready" ? 0 : r === "detected" ? 1 : 2);
    const rwA = readinessWeight(a.readiness);
    const rwB = readinessWeight(b.readiness);
    if (rwA !== rwB) {
      return rwA - rwB;
    }
    const quotaWeight = (q: string): number => (q === "available" ? 0 : 1);
    const qwA = quotaWeight(a.quotaState);
    const qwB = quotaWeight(b.quotaState);
    if (qwA !== qwB) {
      return qwA - qwB;
    }
    if (a.providerId !== b.providerId) {
      return a.providerId.localeCompare(b.providerId);
    }
    if (a.modelId !== b.modelId) {
      return a.modelId.localeCompare(b.modelId);
    }
    return (a.profileId ?? "").localeCompare(b.profileId ?? "");
  });

  const recommendations = eligibleRecommendations.slice(0, 3);
  const deliberateChoiceApplied = recommendations.some((r) => r.isDeliberateChoice);

  return {
    recommendations,
    excluded,
    deliberateChoiceApplied
  };
}

export interface TeamAdaptationPolicyApproval {
  readonly approved: boolean;
  readonly approvedBy: string;
  readonly approvedAt: number;
  readonly signatureOrProof?: string;
}

export interface TeamAdaptationAllowedSelection {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
}

export interface TeamAdaptationSourceBound {
  readonly sourceId: string;
  readonly revisionHash: string;
}

export interface TeamAdaptationPolicy {
  readonly policyId: string;
  readonly policyHash: string;
  readonly projectId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly expiresAt: number;
  readonly approval: TeamAdaptationPolicyApproval;
  readonly allowedSelections: readonly TeamAdaptationAllowedSelection[];
  readonly requiredCapabilities?: readonly string[];
  readonly confirmedCapabilityEvidence?: readonly string[];
  readonly sources: readonly TeamAdaptationSourceBound[];
  readonly allowedToolScopes: readonly string[];
  readonly maxCalls: number;
  readonly maxConcurrency: number;
  readonly budgetLimit: number;
  readonly reservedBudget: number;
}

export interface TeamAdaptationProposedChange {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly proposedCalls: number;
  readonly proposedConcurrency: number;
  readonly proposedCost: number;
  readonly sources?: readonly TeamAdaptationSourceBound[];
  readonly tools?: readonly string[];
  readonly effectCertainty: "certain" | "uncertain" | "unknown" | "speculative";
  readonly workflowAdjustment?: string;
  readonly isQuotaRotation?: boolean;
  readonly isPaidFallback?: boolean;
  readonly isRetry?: boolean;
  readonly packetChanged?: boolean;
}

export interface AssessTeamAdaptationInput {
  readonly policy: TeamAdaptationPolicy;
  readonly now: number;
  readonly projectId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly mode?: "team" | "solo";
  readonly currentProviderId?: WorkstationProviderId;
  readonly currentModelId?: string;
  readonly snapshot?: AdaptationPackageSnapshot | null;
  readonly callCount?: number;
  readonly currentConcurrency?: number;
  readonly consumedBudget?: number;
  readonly proposed: TeamAdaptationProposedChange;
}

/** A package awaiting admission or an observed host state; never approval evidence. */
export interface AdaptationPackageSnapshot {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string | null;
  readonly status: "waiting" | WorkstationStatus;
}

export interface TeamAdaptationEffect {
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly allowedCalls: number;
  readonly allowedConcurrency: number;
  readonly estimatedCost: number;
  readonly tools: readonly string[];
  readonly sourceIds: readonly string[];
  readonly workflowAdjustment?: string;
}

export type TeamAdaptationDecision = "blocked" | "needs-review" | "within-policy";

export interface AssessTeamAdaptationResult {
  readonly decision: TeamAdaptationDecision;
  readonly reasons: readonly string[];
  readonly proposedEffect: TeamAdaptationEffect | null;
  readonly requiresFreshReview: boolean;
}

function isNonNegativeFiniteNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && !Number.isNaN(val) && val >= 0;
}

function isNonNegativeInteger(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val >= 0;
}

export function assessTeamAdaptation(input: AssessTeamAdaptationInput): AssessTeamAdaptationResult {
  const policy = input.policy;

  const integersToCheck: readonly [string, unknown][] = [
    ["policy.maxCalls", policy?.maxCalls],
    ["policy.maxConcurrency", policy?.maxConcurrency],
    ["proposed.proposedCalls", input.proposed?.proposedCalls],
    ["proposed.proposedConcurrency", input.proposed?.proposedConcurrency]
  ];

  for (const [name, val] of integersToCheck) {
    if (!isNonNegativeInteger(val)) {
      return {
        decision: "blocked",
        reasons: [`Invalid integer value for ${name} (must be non-negative integer)`],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }

  const numbersToCheck: readonly [string, unknown][] = [
    ["policy.expiresAt", policy?.expiresAt],
    ["policy.budgetLimit", policy?.budgetLimit],
    ["policy.reservedBudget", policy?.reservedBudget],
    ["policy.approval.approvedAt", policy?.approval?.approvedAt],
    ["input.now", input.now],
    ["proposed.proposedCost", input.proposed?.proposedCost]
  ];

  for (const [name, val] of numbersToCheck) {
    if (!isNonNegativeFiniteNumber(val)) {
      return {
        decision: "blocked",
        reasons: [`Invalid numeric value for ${name} (must be non-negative, finite number)`],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }

  if (input.callCount !== undefined && !isNonNegativeInteger(input.callCount)) {
    return {
      decision: "blocked",
      reasons: ["Invalid numeric value for input.callCount"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (input.currentConcurrency !== undefined && !isNonNegativeInteger(input.currentConcurrency)) {
    return {
      decision: "blocked",
      reasons: ["Invalid numeric value for input.currentConcurrency"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (input.consumedBudget !== undefined && !isNonNegativeFiniteNumber(input.consumedBudget)) {
    return {
      decision: "blocked",
      reasons: ["Invalid numeric value for input.consumedBudget"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (Array.isArray(policy.sources)) {
    const sourceIds = policy.sources.map((s) => s.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      return {
        decision: "blocked",
        reasons: ["Duplicate source IDs detected in policy.sources"],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }
  if (Array.isArray(policy.allowedToolScopes)) {
    if (new Set(policy.allowedToolScopes).size !== policy.allowedToolScopes.length) {
      return {
        decision: "blocked",
        reasons: ["Duplicate tool scopes detected in policy.allowedToolScopes"],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }
  if (Array.isArray(policy.allowedSelections)) {
    const selectionKeys = policy.allowedSelections.map((s) => `${s.providerId}:${s.modelId}`);
    if (new Set(selectionKeys).size !== selectionKeys.length) {
      return {
        decision: "blocked",
        reasons: ["Duplicate selections detected in policy.allowedSelections"],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }
  if (input.proposed.sources && Array.isArray(input.proposed.sources)) {
    const proposedSourceIds = input.proposed.sources.map((s) => s.sourceId);
    if (new Set(proposedSourceIds).size !== proposedSourceIds.length) {
      return {
        decision: "blocked",
        reasons: ["Duplicate source IDs detected in proposed.sources"],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }
  if (input.proposed.tools && Array.isArray(input.proposed.tools)) {
    if (new Set(input.proposed.tools).size !== input.proposed.tools.length) {
      return {
        decision: "blocked",
        reasons: ["Duplicate tools detected in proposed.tools"],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }

  if (!policy.policyId || !policy.policyHash) {
    return {
      decision: "blocked",
      reasons: ["Policy is missing policyId or policyHash"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (!policy.approval || typeof policy.approval !== "object") {
    return {
      decision: "blocked",
      reasons: ["Policy is missing required host approval evidence"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (policy.approval.approved !== true) {
    return {
      decision: "blocked",
      reasons: ["Policy approval flag is not true"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (!policy.approval.approvedBy || typeof policy.approval.approvedBy !== "string") {
    return {
      decision: "blocked",
      reasons: ["Policy approval lacks valid approvedBy identity"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (policy.approval.approvedAt > input.now) {
    return {
      decision: "blocked",
      reasons: ["Policy approval timestamp is in the future"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (input.now >= policy.expiresAt) {
    return {
      decision: "blocked",
      reasons: [`Policy expired at ${policy.expiresAt} (current time: ${input.now})`],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (input.projectId !== policy.projectId) {
    return {
      decision: "blocked",
      reasons: [`Project ID mismatch: input '${input.projectId}' !== policy '${policy.projectId}'`],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (input.runId !== policy.runId) {
    return {
      decision: "blocked",
      reasons: [`Run ID mismatch: input '${input.runId}' !== policy '${policy.runId}'`],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (input.ownerId !== policy.ownerId) {
    return {
      decision: "blocked",
      reasons: [`Owner ID mismatch: input '${input.ownerId}' !== policy '${policy.ownerId}'`],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (input.snapshot !== undefined && input.snapshot !== null) {
    const snap = input.snapshot;
    if (!snap.status || typeof snap.status !== "string") {
      return {
        decision: "blocked",
        reasons: ["Package snapshot status is uncertain; cannot adapt"],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
    const startedOrFinishedStatuses = new Set([
      "starting",
      "running",
      "stopping",
      "completed",
      "stopped",
      "failed",
      "interrupted"
    ]);
    if (startedOrFinishedStatuses.has(snap.status)) {
      return {
        decision: "blocked",
        reasons: [`Late replacement of an already-started or completed package is disallowed (current status: ${snap.status})`],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
    if (input.currentProviderId && snap.providerId !== input.currentProviderId) {
      return {
        decision: "blocked",
        reasons: [`Snapshot provider '${snap.providerId}' does not match current provider '${input.currentProviderId}'`],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
    if (input.currentModelId && snap.modelId !== input.currentModelId) {
      return {
        decision: "blocked",
        reasons: [`Snapshot model '${snap.modelId}' does not match current model '${input.currentModelId}'`],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }

  if (input.mode === "solo") {
    const currentProviderId = input.currentProviderId;
    const currentModelId = input.currentModelId;

    if (!currentProviderId || !currentModelId) {
      return {
        decision: "blocked",
        reasons: [
          "Solo mode requires known current provider and model (explicit or verified snapshot)"
        ],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }

    if (input.proposed.providerId !== currentProviderId) {
      return {
        decision: "blocked",
        reasons: [
          `Fixed Solo provider '${currentProviderId}' must never change (proposed '${input.proposed.providerId}')`
        ],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
    if (input.proposed.modelId !== currentModelId) {
      return {
        decision: "blocked",
        reasons: [
          `Fixed Solo model '${currentModelId}' must never change (proposed '${input.proposed.modelId}')`
        ],
        proposedEffect: null,
        requiresFreshReview: true
      };
    }
  }

  if (input.proposed.isQuotaRotation === true) {
    return {
      decision: "blocked",
      reasons: ["Automatic quota-rotation trigger is disallowed"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }
  if (input.proposed.isPaidFallback === true) {
    return {
      decision: "blocked",
      reasons: ["Paid API fallback is disallowed under workstation policy"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  const matchesSelection = policy.allowedSelections.some(
    (sel) => sel.providerId === input.proposed.providerId && sel.modelId === input.proposed.modelId
  );
  if (!matchesSelection) {
    return {
      decision: "blocked",
      reasons: [
        `Selection '${input.proposed.providerId}:${input.proposed.modelId}' is not among policy allowed selections`
      ],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (policy.requiredCapabilities && policy.requiredCapabilities.length > 0) {
    const evidenceSet = new Set(policy.confirmedCapabilityEvidence ?? []);
    for (const reqCap of policy.requiredCapabilities) {
      if (!evidenceSet.has(reqCap)) {
        return {
          decision: "blocked",
          reasons: [`Missing required capability evidence for: ${reqCap}`],
          proposedEffect: null,
          requiresFreshReview: true
        };
      }
    }
  }

  const existingCalls = input.callCount ?? 0;
  if (existingCalls + input.proposed.proposedCalls > policy.maxCalls) {
    return {
      decision: "blocked",
      reasons: [
        `Call limit expansion disallowed: total calls (${existingCalls + input.proposed.proposedCalls}) exceeds policy maximum (${policy.maxCalls})`
      ],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  const existingConcurrency = input.currentConcurrency ?? 0;
  if (existingConcurrency + input.proposed.proposedConcurrency > policy.maxConcurrency) {
    return {
      decision: "blocked",
      reasons: [
        `Concurrency expansion disallowed: total concurrency (${existingConcurrency + input.proposed.proposedConcurrency}) exceeds policy maximum (${policy.maxConcurrency})`
      ],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (policy.reservedBudget > policy.budgetLimit) {
    return {
      decision: "blocked",
      reasons: [
        `Policy reserved budget (${policy.reservedBudget}) exceeds budget limit (${policy.budgetLimit})`
      ],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  const existingCost = input.consumedBudget ?? 0;
  const totalBudget = existingCost + policy.reservedBudget + input.proposed.proposedCost;
  if (totalBudget > policy.budgetLimit) {
    return {
      decision: "blocked",
      reasons: [
        `Budget expansion disallowed: total cost (${totalBudget}) exceeds policy limit (${policy.budgetLimit})`
      ],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  if (input.proposed.sources && input.proposed.sources.length > 0) {
    const policySourceMap = new Map(policy.sources.map((s) => [s.sourceId, s.revisionHash]));
    for (const proposedSource of input.proposed.sources) {
      const expectedHash = policySourceMap.get(proposedSource.sourceId);
      if (!expectedHash) {
        return {
          decision: "blocked",
          reasons: [`Source expansion disallowed: source '${proposedSource.sourceId}' is not in policy sources`],
          proposedEffect: null,
          requiresFreshReview: true
        };
      }
      if (expectedHash !== proposedSource.revisionHash) {
        return {
          decision: "blocked",
          reasons: [
            `Source revision mismatch for source '${proposedSource.sourceId}': expected '${expectedHash}', got '${proposedSource.revisionHash}'`
          ],
          proposedEffect: null,
          requiresFreshReview: true
        };
      }
    }
  }

  if (input.proposed.tools && input.proposed.tools.length > 0) {
    const allowedTools = new Set(policy.allowedToolScopes);
    for (const tool of input.proposed.tools) {
      if (!allowedTools.has(tool)) {
        return {
          decision: "blocked",
          reasons: [`Tool scope expansion disallowed: tool '${tool}' is not in policy allowedToolScopes`],
          proposedEffect: null,
          requiresFreshReview: true
        };
      }
    }
  }

  if (input.proposed.isRetry === true && input.proposed.effectCertainty !== "certain") {
    return {
      decision: "blocked",
      reasons: ["Uncertain effects cannot retry automatically"],
      proposedEffect: null,
      requiresFreshReview: true
    };
  }

  const effectSources = input.proposed.sources ?? policy.sources;
  const effectTools = input.proposed.tools ?? [];
  const proposedEffect: TeamAdaptationEffect = {
    providerId: input.proposed.providerId,
    modelId: input.proposed.modelId,
    allowedCalls: input.proposed.proposedCalls,
    allowedConcurrency: input.proposed.proposedConcurrency,
    estimatedCost: input.proposed.proposedCost,
    tools: effectTools,
    sourceIds: effectSources.map((s) => s.sourceId),
    ...(input.proposed.workflowAdjustment === undefined ? {} : { workflowAdjustment: input.proposed.workflowAdjustment })
  };

  const hasUnknownCounters =
    input.callCount === undefined || input.consumedBudget === undefined || input.currentConcurrency === undefined;
  const isCertain = input.proposed.effectCertainty === "certain";

  if (hasUnknownCounters || !isCertain) {
    const reviewReasons: string[] = [];
    if (hasUnknownCounters) {
      reviewReasons.push("Budget counters are not fully known; host review required before adaptation");
    }
    if (!isCertain) {
      reviewReasons.push(
        `Effect certainty is '${input.proposed.effectCertainty}'; host review required before adaptation`
      );
    }
    return {
      decision: "needs-review",
      reasons: reviewReasons,
      proposedEffect,
      requiresFreshReview: true
    };
  }

  const packetChanged = Boolean(input.proposed.packetChanged);
  const reasons: string[] = [
    "Proposed adaptation is within all owner-reviewed policy bounds",
    `Exact selection confirmed: ${input.proposed.providerId}:${input.proposed.modelId}`,
    `Calls (${existingCalls + input.proposed.proposedCalls}/${policy.maxCalls}), concurrency (${existingConcurrency + input.proposed.proposedConcurrency}/${policy.maxConcurrency}), and budget (${totalBudget}/${policy.budgetLimit}) within limits`
  ];

  if (input.mode === "solo" && input.proposed.workflowAdjustment) {
    reasons.push(`Solo workflow adjustment inside chosen model: ${input.proposed.workflowAdjustment}`);
  }
  if (packetChanged) {
    reasons.push("Newly compiled or changed exact packet requires host review before dispatch");
    return {
      decision: "needs-review",
      reasons,
      proposedEffect,
      requiresFreshReview: true
    };
  }

  return {
    decision: "within-policy",
    reasons,
    proposedEffect,
    requiresFreshReview: false
  };
}
