/**
 * The workstation host: a native subscription session somebody reviewed first.
 *
 * The organising rule is that **consent is a token, not a flag**. `prepare`
 * assembles the exact bytes that would leave this Mac, hashes them, and hands
 * back a review carrying that hash, the provider, the model and the folder. The
 * token in that review is thirty-two random bytes, lives five minutes, is bound
 * to the window and document that asked, and is consumed *before* a process is
 * launched. `start` also requires a durable preimage before dispatch. The
 * auxiliary `askOnce` path below does not use this reviewed-run policy.
 *
 * The second rule is that a start is not an answer. A user turn and a start
 * receipt are durable before dispatch; the completed turn and its finish receipt
 * land in one transaction; a run that was interrupted keeps whatever text it had
 * produced, visibly labelled as partial. A crash therefore leaves evidence that
 * something was attempted rather than an answer nobody watched arrive.
 *
 * This file holds policy only. Every side effect — the book, the picker, the
 * adapters, the durable store — arrives as a dependency, which is what lets the
 * decisions below be tested without Electron and without a subscription.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentRunResult,
  AutomationHostBindOperationInput,
  AutomationHostBindOperationResult,
  AutomationHostReconcileTerminalInput,
  AutomationHostReconcileTerminalResult,
  AutomationHostReserveAttemptInput,
  AutomationHostReserveAttemptResult,
  AutomationHostReviewDescriptor,
  AutomationPendingHostReviewInput,
  AutomationWorkspaceSnapshot,
  LocalChatRequest,
  WorkstationContextSuggestion,
  WorkstationPermission,
  WorkstationProvider,
  WorkstationProviderId,
  WorkstationReview,
  WorkstationReviewTools,
  WorkstationRoutine,
  WorkstationSnapshot,
  WorkstationStatus,
  WorkstationWorkspace
} from "@cadrane/contracts";
import { ProjectMemoryRoleIdSchema } from "@cadrane/contracts";
import type {
  ContextSource,
  ExtractedArtifact,
  NativeEvent,
  NativeProviderLaunch,
  NativeWorker,
  NativeWorkerFactory,
  NativeWorkerOptions,
  NativeWorkerResult,
  NativeAskOutcome,
  WorkstationContext,
  WorkstationSessionReceipt
} from "./types.js";

/** Five minutes: long enough to read a packet, short enough to be a decision. */
export const REVIEW_TTL_MS = 5 * 60_000;

/** One answer's ceiling. Beyond this the transcript is truncated and says so. */
export const MAX_ANSWER_CHARS = 200_000;

/** What the packet may carry. Selected turns, never a folder walk. */
export const MAX_PACKET_CHARS = 24_000;

const MAX_ACTIVITY_LINES = 60;
const MAX_ACTIVITY_LINE_CHARS = 400;
const MAX_PENDING_REVIEWS = 8;
const MAX_REMEMBERED_CASES = 24;
const MAX_WAITING_PERMISSIONS = 4;

/** A whole session's wall clock, and how long it may go quiet inside that. */
export const RUN_LIMIT_MS = 30 * 60_000;
export const SILENCE_LIMIT_MS = 5 * 60_000;
const WATCHDOG_TICK_MS = 5_000;
const CHECKPOINT_MS = 15_000;

/** The book's shape, as this module needs it and no wider. */
export interface WorkstationCaseRow {
  readonly id: string;
  readonly title: string;
  readonly closedAt: number | null;
}

export interface WorkstationTurnRow {
  readonly id: string;
  readonly seat: string;
  readonly kind: string;
  readonly body: string;
}

export interface WorkstationTurnInput {
  readonly seat: string;
  readonly kind: "verbatim" | "receipt";
  readonly body: string;
}

import type {
  NativeToolSession,
  NativeToolSessionOptions
} from "./native-tools.js";
// A pure formatter with no imports and no effects of its own — the same kind of
// thing as `startReceiptBody` below, and imported for the same reason. The deps
// object exists to keep side effects out of this file, not string building.
import { buildToolLedger, type ToolLedgerEntry } from "./tool-ledger.js";
import { admit } from "./session-pool.js";
import { LocalCaseRunScope, type LocalCaseRunInput, type LocalAgentRunInput,
  type LocalSuggestionRunInput } from "./local-case-run-scope.js";
import { LocalBriefDraftScope, type LocalBriefDraftInput } from "./local-brief-draft-scope.js";
import type { AcceptedConstraint, AcceptedFinding, FindingDecision } from "./context.js";
import type { ContextSnapshot, ContextSnapshotManifest } from "./context-snapshot-store.js";
import type { LocalCaseRunHooks } from "../workroom/local.js";
import { composeGraphHostReviewPacket } from "./graph-host-review-packet.js";
import {
  lookup,
  recordDispatch,
  recordTerminal,
  recordTerminalInExistingTransaction,
  saveIntent,
  type GraphHostCorrelationKey,
  type GraphHostTerminalOutcome
} from "./graph-host-correlation-store.js";
import { readProvenGraphHostTerminal } from "./graph-host-terminal-evidence.js";
import {
  RecoveryQuiescenceCoordinator,
  type WriterPermit
} from "./recovery-quiescence.js";
import {
  createHostWriterGate,
  createTrustedHostQuiescenceCoordinator,
  type HostWriterGate
} from "./recovery-quiescence-host-bridge.js";

export interface WorkstationGraphReview {
  readonly token: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly attemptId: string;
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly workflowSha256: string;
  readonly agentId: string;
  readonly agentRevision: number;
  readonly agentSha256: string;
  readonly caseId: string;
  readonly sourceTurnIds: readonly string[];
  readonly operationId: string;
  readonly runtimeId: string;
  readonly modelId: string;
  readonly instruction: string;
  readonly systemPrompt: string;
  readonly descriptorSha256: string;
  readonly sourceBindingSha256: string;
  readonly requestSha256: string;
  readonly preview: string;
  readonly contextPreview: string;
  readonly workspace: WorkstationWorkspace;
  readonly projectId: string | null;
  readonly memoryEpoch: number;
  readonly expiresAt: number;
}

export interface WorkstationGraphHostDeps {
  readonly describeReview: (input: AutomationPendingHostReviewInput) => Promise<AutomationHostReviewDescriptor>;
  readonly reserveAttempt: (input: AutomationHostReserveAttemptInput) => Promise<AutomationHostReserveAttemptResult>;
  readonly bindOperation: (input: AutomationHostBindOperationInput) => Promise<AutomationHostBindOperationResult>;
  readonly reconcileTerminal: (input: AutomationHostReconcileTerminalInput) => Promise<AutomationHostReconcileTerminalResult>;
  readonly snapshot?: () => Promise<AutomationWorkspaceSnapshot>;
  readonly runNode: (input: {
    readonly db: DatabaseSync;
    readonly caseId: string;
    readonly nodeTitle: string;
    readonly instruction: string;
    readonly sourceTurnIds: readonly string[];
    readonly request: LocalChatRequest;
    readonly hooks: LocalCaseRunHooks;
  }) => Promise<{ readonly answerTurnId: string; readonly output: string }>;
  readonly stopNode?: (caseId: string, operationId: string) => Promise<{ readonly stopped: boolean }>;
  readonly composeReviewPacket?: typeof composeGraphHostReviewPacket;
  readonly saveIntent?: typeof saveIntent;
  readonly recordDispatch?: typeof recordDispatch;
  readonly recordTerminal?: typeof recordTerminal;
  readonly recordTerminalInExistingTransaction?: typeof recordTerminalInExistingTransaction;
  readonly lookupCorrelation?: typeof lookup;
  readonly readProvenTerminal?: typeof readProvenGraphHostTerminal;
}

/**
 * Everything with a side effect, named.
 *
 * The worker modules (`codex.ts`, `claude.ts`, `gemini.ts`, `context.ts`,
 * `store.ts`, `routines.ts`) are reached only through these, so this file
 * imports none of them and the host's decisions can be exercised on their own.
 */
export interface WorkstationHostDeps {
  /** The bundled Case draft uses this host's admission and owner lifecycle. */
  readonly localCaseScope?: LocalCaseRunScope;
  readonly localBriefScope?: LocalBriefDraftScope;
  readonly quiescenceCoordinator?: RecoveryQuiescenceCoordinator;
  readonly graph?: WorkstationGraphHostDeps;
  readonly book: () => DatabaseSync;
  readonly readCase: (db: DatabaseSync, caseId: string) => WorkstationCaseRow | null;
  readonly turnsFor: (db: DatabaseSync, caseId: string) => readonly WorkstationTurnRow[];
  readonly appendTurn: (db: DatabaseSync, caseId: string, turn: WorkstationTurnInput) => string;
  /** BEGIN IMMEDIATE … COMMIT, rolling back on any throw. */
  readonly transaction: (db: DatabaseSync, work: () => void) => void;
  readonly discoverProviders: () => Promise<readonly NativeProviderLaunch[]>;
  readonly buildContext: (input: {
    prompt: string;
    sources: readonly ContextSource[];
    maxChars?: number;
    acceptedConstraints?: readonly AcceptedConstraint[];
    approvedFindings?: readonly AcceptedFinding[];
    taskRole?: string;
  }) => WorkstationContext & { readonly findingDecisions?: readonly FindingDecision[] };
  /** Canonical Book memory. Missing data and read errors fail the review closed. */
  readonly memory: {
    readonly projectForCase: (db: DatabaseSync, caseId: string) => string | null;
    readonly epoch: (db: DatabaseSync, projectId: string) => number;
    readonly constraints: (db: DatabaseSync, projectId: string) => readonly AcceptedConstraint[];
    readonly findings?: (db: DatabaseSync, projectId: string) => readonly AcceptedFinding[];
    readonly saveSnapshot: (db: DatabaseSync, input: {
      readonly id: string; readonly caseId: string; readonly projectId: string | null;
      readonly memoryEpoch: number; readonly providerId: string; readonly modelId: string | null;
      readonly packet: string; readonly manifest: ContextSnapshotManifest;
    }, at: number) => ContextSnapshot;
    readonly readSnapshot: (db: DatabaseSync, id: string, caseId: string, projectId: string | null) => ContextSnapshot | null;
    readonly markDispatchAttempt: (db: DatabaseSync, id: string, caseId: string, projectId: string | null, at: number) => void;
  };
  readonly createWorker: NativeWorkerFactory;
  readonly saveReceipt: (
    db: DatabaseSync,
    caseId: string,
    receipt: WorkstationSessionReceipt
  ) => void;
  readonly latestReceipt: (
    db: DatabaseSync,
    caseId: string,
    providerId?: WorkstationProviderId
  ) => WorkstationSessionReceipt | null;
  readonly recoverInterrupted: (db: DatabaseSync, at?: number) => number;
  readonly routines: () => readonly WorkstationRoutine[];
  /** The app's own data directory. One folder per case lives under it. */
  readonly privateWorkspace: (caseId: string) => Promise<WorkstationWorkspace>;
  /** Resolve filesystem aliases before review and admission bind a workspace. */
  readonly canonicalWorkspacePath: (workspacePath: string) => Promise<string>;
  /** What an answer appears to contain. Named in the receipt; nothing is saved. */
  readonly extractArtifacts: (text: string) => readonly ExtractedArtifact[];
  readonly now: () => number;
  /**
   * A session is about to touch this folder.
   *
   * A durable preimage barrier. A worker cannot be created until it resolves
   * true; false or rejection fails the run before dispatch.
   */
  readonly onRunStart: (input: {
    readonly caseId: string;
    readonly operationId: string;
    readonly workspacePath: string;
  }) => Promise<boolean>;
  /** Thirty-two cryptographically random bytes, hex. */
  readonly token: () => string;
  readonly newId: () => string;
  /**
   * Reviewed native tools, injected whole or not at all.
   *
   * One optional object rather than four optional functions, so a half-wired
   * host cannot be written down: either this build can offer tools or it
   * cannot, and `prepare` can say which in a single check. Injected rather than
   * imported for the same reason every other effect here is — the host's
   * decisions stay testable without the skill catalogue or a Python child
   * anywhere near them.
   */
  readonly tools?: {
    readonly create: (options: NativeToolSessionOptions) => NativeToolSession;
    readonly names: () => readonly string[];
    readonly skillIds: () => readonly string[];
    readonly checkCitations: NativeToolSessionOptions["checkCitations"];
  };
}

/**
 * What a reviewed tool scope may cover, mirrored from the broker.
 *
 * Stated again here so the review is never shown for a scope the broker would
 * refuse a moment later. The broker enforces the same two ceilings on its own;
 * agreeing twice is the point, and disagreeing is a compile-time-invisible bug
 * that would surface as an approved request that cannot start.
 */
const MAX_TOOL_SOURCES = 20;
const MAX_TOOL_SOURCE_BYTES = 204_800;

interface PendingReview {
  readonly review: WorkstationReview;
  /** Exactly what would be sent. Reviewed, then dispatched unchanged. */
  readonly packet: string;
  readonly owner: object;
  /** The case and its selected turns as they stood when they were shown. */
  readonly fingerprint: string;
  readonly launch: NativeProviderLaunch;
  readonly sourceIds: readonly string[];
  /** Whether this review described tools. `start` builds a broker only then. */
  readonly enableTools: boolean;
  readonly projectId: string | null;
  readonly memoryEpoch: number;
  readonly contextSnapshotId: string;
  readonly includedFindingRefs: readonly { readonly id: string; readonly revision: number }[];
}

interface PendingGraphReview {
  readonly review: WorkstationGraphReview;
  readonly descriptor: AutomationHostReviewDescriptor;
  readonly request: LocalChatRequest;
  readonly owner: object;
}

const TERMINAL_STATUSES = new Set<WorkstationStatus>(["completed", "stopped", "failed", "interrupted"]);

interface RunState {
  readonly operationId: string;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly memoryEpoch: number;
  readonly contextSnapshotId: string;
  readonly providerId: WorkstationProviderId;
  readonly providerLabel: string;
  readonly modelId: string | null;
  readonly workspace: WorkstationWorkspace;
  owner: object;
  readonly startedAt: number;
  sessionId: string | null;
  reportedModelId: string | null;
  status: WorkstationStatus;
  updatedAt: number;
  text: string;
  answerTurnId: string | null;
  truncated: boolean;
  activity: string[];
  waiting: WorkstationPermission[];
  decidingPermissionId: string | null;
  detail: string;
  worker: NativeWorker | null;
  /** The reviewed tool scope for this run, or null when none was approved. */
  toolSession: NativeToolSession | null;
  /** Every decided tool call, in the order it happened. */
  toolCalls: ToolLedgerEntry[];
  stopping: boolean;
  finished: boolean;
  lastEventAt: number;
  lastCheckpointAt: number;
  quiescencePermit?: WriterPermit;
}

/** `NativeWorkerOptions` while it is being assembled. Same fields, writable. */
interface MutableWorkerOptions {
  executable: string;
  cwd: string;
  modelId?: string;
  profileHome?: string;
  resumeId?: string;
  tools?: NativeToolSession;
  onEvent: (event: NativeEvent) => void;
}

/** What a provider said when a real attempt was made against it. */
interface AttemptOutcome {
  readonly state: "detected" | "blocked";
  readonly detail: string;
}

export class WorkstationHost {
  private readonly deps: WorkstationHostDeps;
  private readonly localCaseScope: LocalCaseRunScope | null;
  private readonly localBriefScope: LocalBriefDraftScope | null;
  private readonly quiescenceCoordinator: RecoveryQuiescenceCoordinator;
  private readonly hostWriterGate: HostWriterGate;
  private readonly invalidatedOwners = new WeakSet<object>();
  private readonly pending = new Map<string, PendingReview>();
  private readonly pendingGraphReviews = new Map<string, PendingGraphReview>();
  private readonly stoppedGraphOperations = new Set<string>();
  private readonly workspaces = new Map<string, { readonly workspace: WorkstationWorkspace; readonly owner: object }>();
  private readonly finished = new Map<string, WorkstationSnapshot>();
  private readonly finishedOwners = new Map<string, object>();
  private readonly attempts = new Map<WorkstationProviderId, AttemptOutcome>();
  private readonly parentStopHooks = new Set<() => Promise<boolean>>();
  /**
   * Every session running right now, keyed by operation id.
   *
   * This was a single slot, and the rule that enforced it said "Cadrane runs
   * one at a time so two sessions cannot edit the same folder". The reason was
   * always right and the rule was always wider than its reason: two sessions in
   * different works, different folders and different subscriptions cannot
   * collide at all, and refusing them is what stopped the owner using the five
   * subscriptions they pay for. `session-pool.ts` now decides, and it still
   * refuses every case the original sentence was protecting.
   */
  private readonly active = new Map<string, RunState>();
  /** File restore holds the same workspace admission lane as native starts. */
  private readonly restoreLeases = new Map<string, {
    readonly operationId: string;
    readonly caseId: string;
    readonly workspacePath: string;
    readonly owner: object;
    readonly startedAt: number;
  }>();
  private readonly running = new Map<string, Promise<void>>();
  private recovered = false;

  constructor(deps: WorkstationHostDeps) {
    this.deps = deps;
    this.localCaseScope = deps.localCaseScope ?? null;
    this.localBriefScope = deps.localBriefScope ?? null;
    this.quiescenceCoordinator =
      deps.quiescenceCoordinator ?? createTrustedHostQuiescenceCoordinator();
    for (const writerId of [
      "workstation-brief",
      "workstation-case",
      "workstation-agent",
      "restore-lease",
      "session-pool"
    ] as const) {
      this.quiescenceCoordinator.registerWriter(writerId);
    }
    this.hostWriterGate = createHostWriterGate(this.quiescenceCoordinator);
  }

  quiescence(): RecoveryQuiescenceCoordinator {
    return this.quiescenceCoordinator;
  }

  writerGate(): HostWriterGate {
    return this.hostWriterGate;
  }

  async runLocalBrief(input: Omit<LocalBriefDraftInput, "workspacePath">) {
    const scope = this.localBriefScope;
    if (!scope) throw new Error("Local brief ownership is unavailable.");
    const workspace = await this.deps.privateWorkspace("agent-brief");
    const workspacePath = await this.deps.canonicalWorkspacePath(workspace.path);
    if (this.invalidatedOwners.has(input.owner))
      throw new Error("This window changed before the brief could start.");
    this.assertAdmissible({ caseId: "agent-brief", providerId: "bundled-local",
      workspacePath, owner: input.owner });
    const permit = this.quiescenceCoordinator.acquireWriterPermit("workstation-brief");
    try {
      return await scope.run({ ...input, workspacePath });
    } finally {
      permit.release();
    }
  }

  localBriefHistory() {
    if (!this.localBriefScope) throw new Error("Local brief history is unavailable.");
    return this.localBriefScope.history(this.deps.book());
  }

  forgetLocalBriefHistory(reviewSha256: string) {
    const scope = this.localBriefScope;
    if (!scope) throw new Error("Local brief history is unavailable.");
    return this.hostWriterGate.workstationBrief.runSync(() =>
      scope.forget(this.deps.book(), reviewSha256)
    );
  }

  /** Admit a bundled-local Case draft under the same case/workspace lane as native work. */
  async runLocalCase(input: Omit<LocalCaseRunInput, "workspacePath">): Promise<void> {
    const scope = this.localCaseScope;
    if (!scope) throw new Error("Local Case run ownership is unavailable.");
    const workspace = await this.deps.privateWorkspace(input.caseId);
    const workspacePath = await this.deps.canonicalWorkspacePath(workspace.path);
    if (this.invalidatedOwners.has(input.owner))
      throw new Error("This window changed before the local request could start.");
    this.assertAdmissible({
      caseId: input.caseId, providerId: "bundled-local", workspacePath, owner: input.owner
    });
    // No await between admission and the scope's synchronous reservation.
    const permit = this.quiescenceCoordinator.acquireWriterPermit("workstation-case");
    try {
      return await scope.run({ ...input, workspacePath });
    } finally {
      permit.release();
    }
  }

  localCaseState(caseId: string, owner: object): { operationId: string; stopping: boolean } | null {
    return this.localCaseScope?.current(caseId, owner) ?? null;
  }

  stopLocalCase(caseId: string, operationId: string, owner: object): Promise<{ stopped: boolean }> {
    return this.localCaseScope?.stop(caseId, operationId, owner) ?? Promise.resolve({ stopped: false });
  }

  async runLocalAgent(input: Omit<LocalAgentRunInput, "workspacePath">): Promise<AgentRunResult> {
    const scope = this.localCaseScope;
    if (!scope) throw new Error("Local Agent run ownership is unavailable.");
    const laneId = `agent:${input.agentId}`;
    const workspace = await this.deps.privateWorkspace(laneId);
    const workspacePath = await this.deps.canonicalWorkspacePath(workspace.path);
    if (this.invalidatedOwners.has(input.owner))
      throw new Error("This window changed before the Agent could start.");
    this.assertAdmissible({ caseId: laneId, providerId: "bundled-local", workspacePath, owner: input.owner });
    const permit = this.quiescenceCoordinator.acquireWriterPermit("workstation-agent");
    try {
      return await scope.runAgent({ ...input, workspacePath });
    } finally {
      permit.release();
    }
  }

  stopLocalAgent(agentId: string, owner: object): { stopped: boolean } {
    return this.localCaseScope?.stopAgent(agentId, owner) ?? { stopped: false };
  }

  /** Preparatory local advice holds the same Case/workspace admission as a run. */
  async runLocalSuggestion(input: Omit<LocalSuggestionRunInput, "workspacePath">): Promise<WorkstationContextSuggestion> {
    const scope = this.localCaseScope;
    if (!scope) throw new Error("Local suggestion ownership is unavailable.");
    const workspace = await this.deps.privateWorkspace(input.request.caseId);
    const workspacePath = await this.deps.canonicalWorkspacePath(workspace.path);
    if (this.invalidatedOwners.has(input.owner))
      throw new Error("This window changed before the suggestion could start.");
    this.assertAdmissible({ caseId: input.request.caseId, providerId: "bundled-local",
      workspacePath, owner: input.owner });
    const permit = this.quiescenceCoordinator.acquireWriterPermit("workstation-case");
    try {
      return await scope.runSuggestion({ ...input, workspacePath });
    } finally {
      permit.release();
    }
  }

  async prepareGraphNode(
    input: AutomationPendingHostReviewInput,
    owner: object
  ): Promise<WorkstationGraphReview> {
    this.expireReviews();
    const graph = this.deps.graph;
    if (!graph) throw new Error("Graph Host execution is unavailable.");
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window changed before the graph review could be prepared.");

    const descriptor = await graph.describeReview(input);
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window changed before the graph review could be prepared.");

    const workspace = await this.deps.privateWorkspace(descriptor.caseId);
    const canonicalPath = await this.deps.canonicalWorkspacePath(workspace.path);
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window changed before the graph review could be prepared.");

    const db = this.deps.book();
    const room = this.deps.readCase(db, descriptor.caseId);
    if (room === null || room.closedAt !== null)
      throw new Error("This case is closed or missing. Open the case before reviewing a graph step.");

    const projectId = this.deps.memory.projectForCase(db, descriptor.caseId);
    const memoryEpoch = projectId === null ? 0 : this.deps.memory.epoch(db, projectId);
    const key: GraphHostCorrelationKey = {
      caseId: descriptor.caseId,
      graphRunId: descriptor.runId,
      nodeId: descriptor.nodeId,
      attemptId: descriptor.attemptId
    };
    const lookupFn = graph.lookupCorrelation ?? lookup;
    if (lookupFn(db, key) !== null)
      throw new Error("This graph attempt was already reserved or dispatched. Reconcile or inspect its outcome.");

    const operationId = this.deps.newId();
    const compose = graph.composeReviewPacket ?? composeGraphHostReviewPacket;
    const composed = compose(db, descriptor, operationId);

    for (const [existingToken, existing] of this.pendingGraphReviews) {
      if (
        existing.review.runId === descriptor.runId &&
        existing.review.nodeId === descriptor.nodeId
      ) {
        this.pendingGraphReviews.delete(existingToken);
      }
    }
    while (this.pendingGraphReviews.size >= MAX_PENDING_REVIEWS) {
      const oldest = this.pendingGraphReviews.keys().next().value;
      if (oldest === undefined) break;
      this.pendingGraphReviews.delete(oldest);
    }

    const token = this.deps.token();
    const review: WorkstationGraphReview = {
      token,
      runId: descriptor.runId,
      nodeId: descriptor.nodeId,
      nodeTitle: descriptor.provenance.nodeTitle,
      attemptId: descriptor.attemptId,
      workflowId: descriptor.workflowId,
      workflowRevision: descriptor.workflowRevision,
      workflowSha256: descriptor.workflowSha256,
      agentId: descriptor.agentId,
      agentRevision: descriptor.agentRevision,
      agentSha256: descriptor.agentSha256,
      caseId: descriptor.caseId,
      sourceTurnIds: [...descriptor.sourceTurnIds],
      operationId,
      runtimeId: descriptor.runtimeId,
      modelId: descriptor.modelId,
      instruction: descriptor.instruction,
      systemPrompt: descriptor.systemPrompt,
      descriptorSha256: composed.descriptorSha256,
      sourceBindingSha256: composed.sourceBindingSha256,
      requestSha256: composed.requestSha256,
      preview: composed.preview,
      contextPreview: composed.preview,
      workspace: { ...workspace, path: canonicalPath },
      projectId,
      memoryEpoch,
      expiresAt: this.deps.now() + REVIEW_TTL_MS
    };

    this.pendingGraphReviews.set(token, {
      review,
      descriptor,
      request: composed.request,
      owner
    });
    return review;
  }

  async startGraphNode(
    input: { readonly token: string } | string,
    owner: object
  ): Promise<AutomationHostReconcileTerminalResult> {
    this.expireReviews();
    const graph = this.deps.graph;
    const scope = this.localCaseScope;
    if (!graph || !scope) throw new Error("Graph Host execution is unavailable.");

    const token = typeof input === "string" ? input : input.token;
    const reviewed = this.pendingGraphReviews.get(token);
    this.pendingGraphReviews.delete(token);
    if (reviewed === undefined)
      throw new Error("That graph review has expired or was already used. Review the step again.");
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window's authority ended. Review the request again.");
    if (reviewed.owner !== owner)
      throw new Error("This window changed since that review. Review the step again.");

    const { review } = reviewed;
    const currentDescriptor = await graph.describeReview({
      runId: review.runId,
      nodeId: review.nodeId,
      attemptId: review.attemptId
    });
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window changed before the graph step could start.");

    const compose = graph.composeReviewPacket ?? composeGraphHostReviewPacket;
    const lookupFn = graph.lookupCorrelation ?? lookup;
    const saveIntentFn = graph.saveIntent ?? saveIntent;
    const recordDispatchFn = graph.recordDispatch ?? recordDispatch;
    const recordTerminalFn = graph.recordTerminal ?? recordTerminal;
    const recordTerminalTxFn =
      graph.recordTerminalInExistingTransaction ?? recordTerminalInExistingTransaction;
    const readProvenFn = graph.readProvenTerminal ?? readProvenGraphHostTerminal;

    const key: GraphHostCorrelationKey = {
      caseId: review.caseId,
      graphRunId: review.runId,
      nodeId: review.nodeId,
      attemptId: review.attemptId
    };

    const assertCurrentReviewState = (): void => {
      const db = this.deps.book();
      const room = this.deps.readCase(db, review.caseId);
      if (room === null || room.closedAt !== null)
        throw new Error("This case is no longer open. Review the step again.");
      const currentProjectId = this.deps.memory.projectForCase(db, review.caseId);
      if (currentProjectId !== review.projectId)
        throw new Error("This case changed projects after review. Review the step again.");
      const currentEpoch =
        currentProjectId === null ? 0 : this.deps.memory.epoch(db, currentProjectId);
      if (currentEpoch !== review.memoryEpoch)
        throw new Error("Project memory changed after review. Review the step again.");
      const recomposed = compose(db, currentDescriptor, review.operationId);
      if (
        recomposed.descriptorSha256 !== review.descriptorSha256 ||
        recomposed.sourceBindingSha256 !== review.sourceBindingSha256 ||
        recomposed.requestSha256 !== review.requestSha256 ||
        recomposed.preview !== review.preview
      ) {
        throw new Error("The reviewed graph inputs or case sources changed since you looked at them. Review again.");
      }
    };

    assertCurrentReviewState();
    if (lookupFn(this.deps.book(), key) !== null)
      throw new Error("This graph attempt was already reserved or dispatched.");
    this.assertAdmissible({
      caseId: review.caseId,
      providerId: "bundled-local",
      workspacePath: review.workspace.path,
      owner
    });

    const permit = this.quiescenceCoordinator.acquireWriterPermit("workstation-agent");
    try {
      saveIntentFn(this.deps.book(), {
        ...key,
        descriptorSha256: review.descriptorSha256,
        workflowSha256: review.workflowSha256,
        agentSha256: review.agentSha256,
        sourceTurnIds: review.sourceTurnIds,
        runtimeId: review.runtimeId,
        modelId: review.modelId,
        createdAt: this.deps.now()
      });

      const reserved = await graph.reserveAttempt({
        runId: review.runId,
        nodeId: review.nodeId,
        attemptId: review.attemptId,
        descriptorSha256: review.descriptorSha256
      });

      await graph.bindOperation({
        runId: review.runId,
        nodeId: review.nodeId,
        attemptId: review.attemptId,
        operationId: review.operationId,
        correlation: reserved.correlation
      });

      recordDispatchFn(this.deps.book(), {
        ...key,
        operationId: review.operationId,
        dispatchedAt: this.deps.now()
      });

      try {
        if (this.invalidatedOwners.has(owner))
          throw new Error("This window changed before the graph step could start.");
        assertCurrentReviewState();
        this.assertAdmissible({
          caseId: review.caseId,
          providerId: "bundled-local",
          workspacePath: review.workspace.path,
          owner
        });

        await scope.run({
          kind: "graph-node",
          db: this.deps.book(),
          caseId: review.caseId,
          operationId: review.operationId,
          modelId: review.modelId,
          sourceTurnIds: review.sourceTurnIds,
          workspacePath: review.workspace.path,
          owner,
          stop: async () => {
            this.stoppedGraphOperations.add(review.operationId);
            if (graph.stopNode) {
              return graph.stopNode(review.caseId, review.operationId);
            }
            return { stopped: true };
          },
          graph: {
            binding: {
              ...key,
              descriptorSha256: review.descriptorSha256
            },
            requestSha256: review.requestSha256,
            validate: () => {
              assertCurrentReviewState();
            },
            onFinish: (answerTurnId: string) => {
              const dbCurrent = this.deps.book();
              const turn = this.deps
                .turnsFor(dbCurrent, review.caseId)
                .find((candidate) => candidate.id === answerTurnId);
              if (!turn)
                throw new Error("Graph node answer turn is missing during completion.");
              const resultSha256 = createHash("sha256")
                .update(turn.body, "utf8")
                .digest("hex");
              recordTerminalTxFn(dbCurrent, {
                ...key,
                operationId: review.operationId,
                outcome: "completed",
                answerTurnId,
                resultSha256,
                terminalAt: this.deps.now()
              });
            },
            onFailure: (interrupted: boolean) => {
              const dbCurrent = this.deps.book();
              const outcome: GraphHostTerminalOutcome = this.stoppedGraphOperations.has(
                review.operationId
              )
                ? "stopped"
                : interrupted
                  ? "interrupted"
                  : "failed";
              recordTerminalTxFn(dbCurrent, {
                ...key,
                operationId: review.operationId,
                outcome,
                answerTurnId: null,
                resultSha256: null,
                terminalAt: this.deps.now()
              });
            }
          },
          work: async (hooks) => {
            await graph.runNode({
              db: this.deps.book(),
              caseId: review.caseId,
              nodeTitle: review.nodeTitle,
              instruction: review.instruction,
              sourceTurnIds: review.sourceTurnIds,
              request: reviewed.request,
              hooks
            });
          }
        });
      } catch (error) {
        const dbAfter = this.deps.book();
        const current = lookupFn(dbAfter, key);
        if (current !== null && current.status !== "terminal") {
          const outcome: GraphHostTerminalOutcome = this.stoppedGraphOperations.has(
            review.operationId
          )
            ? "stopped"
            : this.invalidatedOwners.has(owner)
              ? "interrupted"
              : "failed";
          recordTerminalFn(dbAfter, {
            ...key,
            operationId: review.operationId,
            outcome,
            answerTurnId: null,
            resultSha256: null,
            terminalAt: this.deps.now()
          });
        }
        this.stoppedGraphOperations.delete(review.operationId);
        const evidence = readProvenFn(dbAfter, key, review.operationId);
        if (evidence !== null) {
          await graph.reconcileTerminal({
            runId: review.runId,
            nodeId: review.nodeId,
            attemptId: review.attemptId,
            correlation: reserved.correlation,
            operationId: review.operationId,
            terminalEvidence: evidence
          });
        }
        throw error;
      }

      this.stoppedGraphOperations.delete(review.operationId);
      const evidence = readProvenFn(this.deps.book(), key, review.operationId);
      if (evidence === null)
        throw new Error("Graph node finished without proven terminal evidence.");

      return await graph.reconcileTerminal({
        runId: review.runId,
        nodeId: review.nodeId,
        attemptId: review.attemptId,
        correlation: reserved.correlation,
        operationId: review.operationId,
        terminalEvidence: evidence
      });
    } finally {
      permit.release();
    }
  }

  async stopGraphNode(
    caseId: string,
    operationId: string,
    owner: object
  ): Promise<{ stopped: boolean }> {
    const scope = this.localCaseScope;
    if (!scope) return { stopped: false };
    const current = scope.current(caseId, owner);
    if (!current || current.operationId !== operationId) {
      return { stopped: false };
    }
    this.stoppedGraphOperations.add(operationId);
    return scope.stop(caseId, operationId, owner);
  }

  async reconcileGraphHostRuns(): Promise<number> {
    this.recover();
    const db = this.deps.book();
    this.localCaseScope?.recover(db);
    this.localBriefScope?.recover(db);

    const graph = this.deps.graph;
    if (!graph?.snapshot) return 0;

    const lookupFn = graph.lookupCorrelation ?? lookup;
    const saveIntentFn = graph.saveIntent ?? saveIntent;
    const recordDispatchFn = graph.recordDispatch ?? recordDispatch;
    const recordTerminalFn = graph.recordTerminal ?? recordTerminal;
    const readProvenFn = graph.readProvenTerminal ?? readProvenGraphHostTerminal;

    const workspace = await graph.snapshot();
    const activeLocalOps = new Set(
      (this.localCaseScope?.sessions() ?? []).map((session) => session.operationId)
    );
    let reconciled = 0;

    for (const run of workspace.runs) {
      if (run.schemaVersion !== 2) continue;
      for (const step of run.steps) {
        if (step.attemptId === null) continue;
        if (step.operationId !== null && activeLocalOps.has(step.operationId)) {
          continue;
        }

        const key: GraphHostCorrelationKey = {
          caseId: run.reviewBinding.caseId,
          graphRunId: run.id,
          nodeId: step.nodeId,
          attemptId: step.attemptId
        };

        if (step.state === "awaiting-review" && step.intent === null) {
          const preReserved = lookupFn(db, key);
          if (preReserved === null) continue;
          const reserved = await graph.reserveAttempt({
            runId: run.id,
            nodeId: step.nodeId,
            attemptId: step.attemptId,
            descriptorSha256: preReserved.intent.descriptorSha256
          });
          const opId =
            preReserved.dispatch?.operationId ??
            preReserved.terminal?.operationId ??
            this.deps.newId();
          if (preReserved.status === "reserved") {
            recordDispatchFn(db, {
              ...key,
              operationId: opId,
              dispatchedAt: this.deps.now()
            });
          }
          const afterDispatch = lookupFn(db, key);
          if (afterDispatch !== null && afterDispatch.status !== "terminal") {
            recordTerminalFn(db, {
              ...key,
              operationId: opId,
              outcome: "interrupted",
              answerTurnId: null,
              resultSha256: null,
              terminalAt: this.deps.now()
            });
          }
          const evidence = readProvenFn(db, key, opId);
          if (evidence !== null) {
            if (evidence.status !== "interrupted") {
              await graph.bindOperation({
                runId: run.id,
                nodeId: step.nodeId,
                attemptId: step.attemptId,
                operationId: opId,
                correlation: reserved.correlation
              });
            }
            await graph.reconcileTerminal({
              runId: run.id,
              nodeId: step.nodeId,
              attemptId: step.attemptId,
              correlation: reserved.correlation,
              operationId: opId,
              terminalEvidence: evidence
            });
            reconciled += 1;
          }
          continue;
        }

        const isUnprovenInterrupted =
          step.state === "interrupted" &&
          step.error === "Unproven Host dispatch was interrupted by restart.";
        const isCancelledWhileReserved =
          step.state === "cancelled" &&
          step.error === "Cancelled while reserved for Host.";
        if (
          step.intent === null ||
          (step.state !== "host-reserved" &&
            !isUnprovenInterrupted &&
            !isCancelledWhileReserved)
        ) {
          continue;
        }

        let record = lookupFn(db, key);
        if (record === null && this.deps.readCase(db, key.caseId) !== null) {
          const workflowSha256 = createHash("sha256")
            .update(JSON.stringify(run.workflowSnapshot ?? {}), "utf8")
            .digest("hex");
          const agentSha256 = createHash("sha256")
            .update(JSON.stringify(step.agent), "utf8")
            .digest("hex");
          saveIntentFn(db, {
            ...key,
            descriptorSha256: step.intent.descriptorSha256,
            workflowSha256,
            agentSha256,
            sourceTurnIds: run.reviewBinding.sourceTurnIds,
            runtimeId: step.agent.runtimeId,
            modelId: step.agent.modelId,
            createdAt: this.deps.now()
          });
          record = lookupFn(db, key);
        }

        const opId =
          step.operationId ??
          record?.dispatch?.operationId ??
          record?.terminal?.operationId ??
          this.deps.newId();

        if (record !== null && record.status === "reserved") {
          recordDispatchFn(db, {
            ...key,
            operationId: opId,
            dispatchedAt: this.deps.now()
          });
          record = lookupFn(db, key);
        }

        if (record !== null && record.status === "dispatched") {
          recordTerminalFn(db, {
            ...key,
            operationId: opId,
            outcome: "interrupted",
            answerTurnId: null,
            resultSha256: null,
            terminalAt: this.deps.now()
          });
        }

        const evidence =
          record !== null
            ? readProvenFn(db, key, opId)
            : {
                status: "interrupted" as const,
                answerTurnId: null,
                output: null,
                outputSha256: null
              };
        if (evidence === null) continue;

        if (
          step.operationId === null &&
          step.state === "host-reserved" &&
          evidence.status !== "interrupted"
        ) {
          await graph.bindOperation({
            runId: run.id,
            nodeId: step.nodeId,
            attemptId: step.attemptId,
            operationId: opId,
            correlation: step.intent.correlation
          });
        }

        await graph.reconcileTerminal({
          runId: run.id,
          nodeId: step.nodeId,
          attemptId: step.attemptId,
          correlation: step.intent.correlation,
          operationId: opId,
          terminalEvidence: evidence
        });
        reconciled += 1;
      }
    }

    return reconciled;
  }


  /**
   * What a crash left behind, settled once per launch.
   *
   * Once, because the store's own sweep writes receipts: calling it on every
   * read would append a fresh "interrupted" line each time somebody opened the
   * screen, which is how a record stops being worth reading.
   */
  recover(): number {
    if (this.recovered) return 0;
    // Latched after the call, not before: a book that was not open yet is a
    // reason to try again on the next read, not a reason to skip recovery for
    // the rest of the launch.
    const settled = this.deps.recoverInterrupted(this.deps.book(), this.deps.now());
    this.recovered = true;
    return settled;
  }

  /**
   * Which providers are here — detected, and no stronger word than that.
   *
   * A version probe is not account readiness, so nothing below claims a session
   * would succeed. What upgrades the answer is a *real* attempt: once one has
   * failed for a reason that reads like sign-in, the row says so and says what
   * to do about it. No credential, keychain item, cookie or environment secret
   * is read here or anywhere else in this module.
   */
  async providers(): Promise<readonly WorkstationProvider[]> {
    const launches = await this.deps.discoverProviders();
    return launches.map((launch) => {
      const attempt = this.attempts.get(launch.provider.id);
      if (attempt === undefined) return launch.provider;
      if (launch.provider.state === "unavailable") return launch.provider;
      return { ...launch.provider, state: attempt.state, detail: attempt.detail };
    });
  }

  /** The fixed catalogue. It is a list of prompts; it starts nothing. */
  routines(): readonly WorkstationRoutine[] {
    return this.deps.routines();
  }

  /**
   * A folder the owner picked, named by an id the host kept.
   *
   * The path crosses back so the review can show where work will happen, but it
   * is the id that `prepare` accepts: a renderer cannot name a folder that was
   * never chosen in Finder. A home directory or a filesystem root is refused —
   * "everything you own" is not a workspace, it is a blanket grant wearing one.
   */
  async chooseWorkspace(
    owner: object,
    /** Supplied by the caller so the picker stays bound to its own request. */
    pick: () => Promise<string | null>
  ): Promise<WorkstationWorkspace | null> {
    const chosen = await pick();
    if (chosen === null) return null;
    const problem = whyWorkspaceUnsuitable(chosen);
    if (problem !== null) throw new Error(problem);
    const label = basename(chosen);
    const workspace: WorkstationWorkspace = Object.freeze({
      id: this.deps.newId(),
      label: label === "" ? chosen : label,
      path: chosen
    });
    this.workspaces.set(workspace.id, { workspace, owner });
    // Bound: a window that opened the picker forty times is not forty grants.
    while (this.workspaces.size > MAX_PENDING_REVIEWS) {
      const oldest = this.workspaces.keys().next();
      if (oldest.done) break;
      this.workspaces.delete(oldest.value);
    }
    return workspace;
  }

  /**
   * Reach files made by a session, including after a restart. The saved path is
   * only a Finder destination: it does not restore a tool grant or start a run.
   */
  async filesWorkspace(caseId: string, workspaceId: string | undefined, owner: object): Promise<WorkstationWorkspace> {
    const db = this.deps.book();
    if (this.deps.readCase(db, caseId) === null) throw new Error("This work no longer exists.");
    if (workspaceId !== undefined) return this.resolveWorkspace(caseId, workspaceId, owner);
    const previous = this.deps.latestReceipt(db, caseId);
    if (previous !== null) {
      const problem = whyWorkspaceUnsuitable(previous.workspacePath);
      if (problem !== null) throw new Error(problem);
      return { id: `case:${caseId}`, label: basename(previous.workspacePath), path: previous.workspacePath };
    }
    return this.deps.privateWorkspace(caseId);
  }

  /**
   * Everything that would happen, assembled and shown before any of it does.
   *
   * Validation is not politeness here: the case must be open, every requested
   * source must still exist *as a source turn* in that case, the provider must
   * be present, and the model must be one the provider itself advertised. A
   * receipt id or a turn from another room is refused rather than quietly
   * dropped, because a packet that silently lost a source is one somebody
   * approved without reading.
   */
  async prepare(
    input: {
      readonly caseId: string;
      readonly providerId: WorkstationProviderId;
      readonly modelId: string;
      readonly prompt: string;
      readonly sourceTurnIds: readonly string[];
      /** Explicit owner-selected Crew audience, never inferred from prompt text. */
      readonly contextRoleId?: string;
      readonly workspaceId?: string | undefined;
      readonly enableTools?: boolean | undefined;
    },
    owner: object,
    policy: { readonly freshSession: true } | undefined = undefined
  ): Promise<WorkstationReview> {
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window's authority ended. Open a new review.");
    this.expireReviews();
    if (input.contextRoleId !== undefined)
      ProjectMemoryRoleIdSchema.parse(input.contextRoleId);
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("Write what you want done before reviewing it.");

    const db = this.deps.book();
    const room = this.deps.readCase(db, input.caseId);
    if (room === null || room.closedAt !== null)
      throw new Error("Open this case before starting a workstation session.");

    const projectId = this.deps.memory.projectForCase(db, input.caseId);
    const memoryEpoch = projectId === null ? 0 : this.deps.memory.epoch(db, projectId);
    const acceptedConstraints = projectId === null ? [] : this.deps.memory.constraints(db, projectId);
    if (projectId !== null && !this.deps.memory.findings)
      throw new Error("Project finding context is unavailable. Nothing was sent.");
    const approvedFindings = projectId === null ? [] : this.deps.memory.findings!(db, projectId);
    if (projectId !== null && this.deps.memory.epoch(db, projectId) !== memoryEpoch)
      throw new Error("Project memory changed while preparing context. Review again.");

    const sources = this.selectSources(db, input.caseId, input.sourceTurnIds);
    const enableTools = input.enableTools === true;
    // Refused here, before a packet is assembled or a token exists. Dropping an
    // opt-in quietly would be the worst outcome available: the owner would tick
    // a box, read a review that says nothing about tools, and get an ordinary
    // session — or, worse, believe they had granted something they had not.
    const tools = this.deps.tools;
    if (enableTools) {
      if (input.providerId !== "codex")
        throw new Error(
          "Tools are only available with Codex, which is the one connection that reviews each call with you. Switch to Codex, or send this request without tools."
        );
      if (tools === undefined)
        throw new Error("This build of Rellane cannot offer tools. Send this request without them.");
      if (sources.length > MAX_TOOL_SOURCES)
        throw new Error(
          `Tools can cover up to ${MAX_TOOL_SOURCES} sources. Select fewer, or send this request without tools.`
        );
      const selectedBytes = sources.reduce(
        (total, source) => total + Buffer.byteLength(source.text, "utf8"),
        0
      );
      if (selectedBytes > MAX_TOOL_SOURCE_BYTES)
        throw new Error(
          `Those sources are larger than tools can cover (${MAX_TOOL_SOURCE_BYTES.toLocaleString("en-GB")} bytes). Select fewer, or send this request without tools.`
        );
    }
    const launch = await this.launchFor(input.providerId);
    const modelId = chosenModel(launch.provider, input.modelId);
    const selectedWorkspace = await this.resolveWorkspace(input.caseId, input.workspaceId, owner);
    const canonicalPath = await this.deps.canonicalWorkspacePath(selectedWorkspace.path);
    const workspace: WorkstationWorkspace = Object.freeze({ ...selectedWorkspace, path: canonicalPath });
    const workspaceProblem = whyWorkspaceUnsuitable(canonicalPath);
    if (workspaceProblem !== null) throw new Error(workspaceProblem);
    // Refused at review, not at send: showing somebody a packet for a session
    // that cannot start is worse than saying so before they read it.
    this.assertAdmissible({
      caseId: input.caseId,
      providerId: input.providerId,
      workspacePath: workspace.path,
      owner
    });

    const context = this.deps.buildContext({
      prompt,
      sources,
      maxChars: MAX_PACKET_CHARS,
      acceptedConstraints,
      approvedFindings,
      ...(input.contextRoleId === undefined ? {} : { taskRole: input.contextRoleId })
    });
    if (input.contextRoleId !== undefined) {
      let scope: unknown;
      try {
        const parsed: unknown = JSON.parse(context.packet);
        const policy = typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)["policy"] : undefined;
        scope = typeof policy === "object" && policy !== null
          ? (policy as Record<string, unknown>)["contextRoleId"] : undefined;
      } catch {
        throw new Error("The context did not bind the selected role. Nothing was sent.");
      }
      if (scope !== input.contextRoleId)
        throw new Error("The context did not bind the selected role. Nothing was sent.");
    }
    if (acceptedConstraints.length > 0 &&
        JSON.stringify(context.constraintIds ?? []) !== JSON.stringify(acceptedConstraints.map((item) => item.id)))
      throw new Error("The context did not include every approved project constraint. Nothing was sent.");
    const findingDecisions = context.findingDecisions ?? [];
    if (approvedFindings.length > 0) {
      const expected = new Map(approvedFindings.map((item) => [item.id, item]));
      if (findingDecisions.length !== expected.size ||
          findingDecisions.some((decision) => {
            const finding = expected.get(decision.id);
            return !finding || finding.revision !== decision.revision ||
              (decision.included && finding.provenance !== "verified");
          }) || new Set(findingDecisions.map((decision) => decision.id)).size !== expected.size)
        throw new Error("The context did not account for every approved project finding. Nothing was sent.");
    }
    const packet = context.packet;
    if (packet.trim() === "")
      throw new Error("There is nothing to send. Select a source or write more of the request.");
    if (packet.length > MAX_PACKET_CHARS)
      throw new Error(
        `This request is too large to review. Select fewer sources or shorten it to fit ${MAX_PACKET_CHARS.toLocaleString("en-GB")} characters.`
      );
    // A packet that quietly lost a source is one somebody approved without
    // reading. Refuse, and say how many, rather than trimming the selection.
    if (context.omitted.length > 0)
      throw new Error(
        `${context.omitted.length} selected source${context.omitted.length === 1 ? "" : "s"} would not fit in this request. Select fewer sources, or shorten what you wrote.`
      );
    // And the packet must carry exactly the selection, no more and no fewer.
    // The assembler ranks sources, so order differs; membership must not.
    const packed = new Set(context.sourceIds);
    if (
      packed.size !== input.sourceTurnIds.length ||
      !input.sourceTurnIds.every((id) => packed.has(id))
    )
      throw new Error(
        "The assembled request does not match the sources you selected. Nothing was sent; review the request again."
      );

    // A native thread keeps the tool definitions it was started with, so
    // continuing a saved one would attach this reviewed source scope to
    // definitions nobody reviewed for it. Tools therefore start fresh, and the
    // review says so rather than letting the owner discover it afterwards.
    const resumeSessionId = enableTools || policy?.freshSession === true
      ? null
      : this.resumableSession(db, input.caseId, input.providerId, modelId, workspace, projectId, memoryEpoch);
    const reviewTools: WorkstationReviewTools | null =
      enableTools && tools !== undefined
        ? {
            enabled: true,
            toolNames: tools.names(),
            skillIds: tools.skillIds(),
            sources: sources.map((source) => ({
              label: displaySourceLabel(source.label),
              chars: source.text.length
            })),
            totalSourceChars: sources.reduce((total, source) => total + source.text.length, 0),
            reachNote:
              "With tools on, these sources can be read in full during the session, a page at a time — more than the excerpt in the request above. Nothing outside them becomes reachable, and each call still asks you first.",
            freshSessionNote:
              "Starts a new session with this provider rather than continuing a saved one."
          }
        : null;
    const now = this.deps.now();
    const token = this.deps.token();
    const contextSnapshotId = this.deps.newId();
    const savedContext = this.deps.memory.saveSnapshot(db, {
      id: contextSnapshotId,
      caseId: input.caseId,
      projectId,
      memoryEpoch,
      providerId: input.providerId,
      modelId,
      packet,
      manifest: {
        preview: context.preview,
        sourceIds: [...context.sourceIds],
        omitted: [...context.omitted],
        constraints: acceptedConstraints.map(({ id, revision }) => ({ id, revision }))
      }
    }, now);
    if (savedContext.packet !== packet || savedContext.packetHash !== sha256(packet))
      throw new Error("The saved review does not match the context packet. Nothing was sent.");
    const review: WorkstationReview = Object.freeze({
      token,
      caseId: input.caseId,
      providerId: input.providerId,
      providerLabel: launch.provider.label,
      modelId,
      prompt,
      // The exact bytes, not a description of them. The assembler also produces
      // a readable summary; showing that instead would mean the hash below
      // attests to something the reviewer never saw, which is the one thing a
      // review cannot afford. Root renders this beside `sourceHash`.
      contextPreview: packet,
      sourceIds: Object.freeze([...input.sourceTurnIds]),
      sourceHash: sha256(packet),
      projectId,
      memoryEpoch,
      contextSnapshotId,
      workspace,
      expiresAt: now + REVIEW_TTL_MS,
      resumeSessionId,
      // Absent, not present-and-undefined: a renderer that checks for the key
      // must be able to trust that its presence means tools were described.
      ...(reviewTools === null ? {} : { tools: reviewTools })
    });

    if (this.pending.size >= MAX_PENDING_REVIEWS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(token, {
      review,
      packet,
      owner,
      fingerprint: fingerprintOf(room, sources),
      launch,
      // What was asked for, which is what the fingerprint covers. `review`
      // carries what the packet actually contains, and the two agree because a
      // packet that omitted anything was refused above.
      sourceIds: Object.freeze([...input.sourceTurnIds]),
      enableTools,
      projectId,
      memoryEpoch,
      contextSnapshotId,
      includedFindingRefs: findingDecisions.filter((decision) => decision.included)
        .map(({ id, revision }) => ({ id, revision }))
    });
    return review;
  }

  /**
   * Spends the token and starts after the record and preimage are durable.
   *
   * The token is removed from the map on the first line, before anything else is
   * checked, so a replay races against nothing — the second caller finds an
   * empty slot whatever happens next. The window that asked must be the window
   * that reviewed, the case and its sources must be exactly as they were shown,
   * and only then is a process created. What comes back is a snapshot; the
   * answer arrives through `state`.
   */
  async start(input: { readonly token: string }, owner: object, signal?: AbortSignal): Promise<WorkstationSnapshot> {
    const reviewed = this.pending.get(input.token);
    this.pending.delete(input.token);
    if (reviewed === undefined)
      throw new Error("That review has already been used or is no longer valid. Review the request again.");
    if (this.invalidatedOwners.has(owner))
      throw new Error("This window's authority ended. Review the request again.");
    if (reviewed.owner !== owner)
      throw new Error("This window changed since that review. Review the request again.");
    if (this.deps.now() > reviewed.review.expiresAt)
      throw new Error("That review expired. Review the request again.");
    if (signal?.aborted)
      throw new Error("Stopped before the provider was asked.");

    const db = this.deps.book();
    const room = this.deps.readCase(db, reviewed.review.caseId);
    if (room === null || room.closedAt !== null)
      throw new Error("This case is no longer open. Nothing was sent.");
    const sources = this.selectSources(db, reviewed.review.caseId, reviewed.sourceIds);
    if (fingerprintOf(room, sources) !== reviewed.fingerprint)
      throw new Error("This case changed after that review. Review the request again before sending it.");
    this.assertMemoryCurrent(db, reviewed);
    // Re-checked here as well: another session may have taken this folder or
    // this subscription in the time the review was on screen.
    this.assertAdmissible({
      caseId: reviewed.review.caseId,
      providerId: reviewed.review.providerId,
      workspacePath: reviewed.review.workspace.path,
      owner
    });

    const { review, launch } = reviewed;
    const executable = launch.executable;
    if (executable === null)
      throw new Error(`${review.providerLabel} is not installed on this Mac.`);

    const quiescencePermit = this.quiescenceCoordinator.acquireWriterPermit("session-pool");
    const startedAt = this.deps.now();
    const run: RunState = {
      operationId: this.deps.newId(),
      caseId: review.caseId,
      projectId: reviewed.projectId,
      memoryEpoch: reviewed.memoryEpoch,
      contextSnapshotId: reviewed.contextSnapshotId,
      providerId: review.providerId,
      providerLabel: review.providerLabel,
      modelId: review.modelId,
      workspace: review.workspace,
      owner,
      startedAt,
      sessionId: review.resumeSessionId,
      status: "starting",
      updatedAt: startedAt,
      text: "",
      answerTurnId: null,
      truncated: false,
      activity: [],
      reportedModelId: null,
      waiting: [],
      decidingPermissionId: null,
      detail: `Starting ${review.providerLabel} in ${review.workspace.label}.`,
      worker: null,
      toolSession: null,
      toolCalls: [],
      stopping: false,
      finished: false,
      lastEventAt: startedAt,
      lastCheckpointAt: startedAt,
      quiescencePermit
    };

    // Built from `sources` — the array just re-read and just fingerprint-checked
    // — never from the review's own copy. The two agree at this line and only
    // this line; anything later is a race with an edit in another window.
    const tools = this.deps.tools;
    if (reviewed.enableTools) {
      if (tools === undefined)
        throw new Error("This build of Rellane cannot offer tools. Review the request again without them.");
      run.toolSession = tools.create({
        operationId: run.operationId,
        caseId: run.caseId,
        sources: sources.map((source) => ({
          id: source.id,
          // The same names the owner just read in the review, so the model and
          // the person who approved it are talking about the same sources.
          label: displaySourceLabel(source.label),
          text: source.text
        })),
        isActive: () => this.toolScopeOpen(run, reviewed),
        checkCitations: tools.checkCitations
      });
    }

    // Reserve the reviewed case, provider and canonical path before awaiting
    // the preimage. Another start must see this pending run in the same pool.
    this.active.set(run.operationId, run);
    try {
      // Durable before dispatch, and all three in one transaction: a prompt
      // recorded without its start receipt would read as something the owner
      // said to nobody, and a start receipt without the prompt is incomplete.
      this.deps.transaction(db, () => {
        this.deps.appendTurn(db, run.caseId, {
          seat: "owner",
          kind: "verbatim",
          body: review.prompt
        });
        this.deps.appendTurn(db, run.caseId, {
          seat: "workstation",
          kind: "receipt",
          body: startReceiptBody(run, review)
        });
        this.deps.saveReceipt(db, run.caseId, this.receipt(run, "start"));
      });

      const preimageSaved = await this.deps.onRunStart({
        caseId: run.caseId,
        operationId: run.operationId,
        workspacePath: review.workspace.path
      });
      if (signal?.aborted || run.stopping || run.finished)
        throw new Error("Stopped before the provider was asked.");
      if (!preimageSaved)
        throw new Error("Could not cover this workspace with a saved preimage. Choose a narrower folder or check file access. Nothing was sent.");

      // The owner could close the case or edit a selected source while the
      // snapshot was pending. Never dispatch a packet whose review has drifted.
      const currentDb = this.deps.book();
      const currentRoom = this.deps.readCase(currentDb, run.caseId);
      if (currentRoom === null || currentRoom.closedAt !== null)
        throw new Error("This case closed while its folder was being saved. Nothing was sent.");
      const currentSources = this.selectSources(currentDb, run.caseId, reviewed.sourceIds);
      if (fingerprintOf(currentRoom, currentSources) !== reviewed.fingerprint)
        throw new Error("This case changed while its folder was being saved. Review the request again.");
      this.assertMemoryCurrent(currentDb, reviewed);
      if (signal?.aborted)
        throw new Error("Stopped before the provider was asked.");

      // Absent model, profile and resume ids remain absent in adapter options.
      const options: MutableWorkerOptions = {
        executable,
        cwd: review.workspace.path,
        onEvent: (event: NativeEvent) => {
          this.onEvent(run, event);
        }
      };
      if (review.modelId !== null) options.modelId = review.modelId;
      if (launch.profileHome !== undefined) options.profileHome = launch.profileHome;
      if (review.resumeSessionId !== null) options.resumeId = review.resumeSessionId;
      if (run.toolSession !== null) options.tools = run.toolSession;
      this.deps.memory.markDispatchAttempt(currentDb, run.contextSnapshotId, run.caseId, run.projectId, this.deps.now());
      this.running.set(run.operationId, this.execute(run, reviewed.packet, options));
      return this.snapshot(run);
    } catch (error) {
      try {
        this.fail(run, error, run.stopping ? "stopped" : "failed");
      } finally {
        this.disposeTools(run);
        this.retire(run);
      }
      throw error;
    }
  }

  /**
   * What this case's session is doing, or the last thing it did.
   *
   * Falls through to the durable receipt when nothing is in memory, so what a
   * session did survives a restart: an answer written into the room with no
   * state beside it reads like something that appeared on its own.
   */
  state(caseId: string): WorkstationSnapshot | null {
    const live = this.liveRuns().find((run) => run.caseId === caseId);
    if (live !== undefined) return this.snapshot(live);
    const remembered = this.finished.get(caseId);
    if (remembered !== undefined) return remembered;
    try {
      const receipt = this.deps.latestReceipt(this.deps.book(), caseId);
      if (receipt === null || receipt.snapshot.caseId !== caseId) return null;
      return receipt.snapshot;
    } catch {
      // No book open yet. A missing snapshot is the honest answer.
      return null;
    }
  }

  /** Waits for one host-owned operation, including a Stop that is still settling. */
  async awaitTerminal(caseId: string, operationId: string, owner: object,
    signal?: AbortSignal, onActivity?: (line: string) => void): Promise<WorkstationSnapshot> {
    const live = this.active.get(operationId);
    if (live !== undefined && (live.caseId !== caseId || live.owner !== owner))
      throw new Error("That reviewed session belongs to another work or window.");
    const finished = this.finished.get(caseId);
    if (live === undefined && finished?.operationId !== operationId)
      throw new Error("That reviewed session is no longer available.");
    if (live === undefined && this.finishedOwners.get(operationId) !== owner)
      throw new Error("That reviewed session belongs to another window.");
    const task = this.running.get(operationId);
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { void this.stop(caseId, operationId, owner).catch(() => undefined); };
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    if (onActivity !== undefined && task !== undefined) {
      let last = "";
      timer = setInterval(() => {
        const line = this.state(caseId)?.activity.at(-1) ?? "";
        if (line !== "" && line !== last) { last = line; onActivity(line); }
      }, 300);
      if (typeof timer.unref === "function") timer.unref();
    }
    try {
      if (task !== undefined) await task;
      const result = this.finished.get(caseId);
      if (result?.operationId !== operationId || this.finishedOwners.get(operationId) !== owner ||
          !TERMINAL_STATUSES.has(result.status))
        throw new Error("That session did not reach a recorded terminal state.");
      return result;
    } finally {
      signal?.removeEventListener("abort", stop);
      if (timer !== null) clearInterval(timer);
    }
  }

  /**
   * Stops one operation, named exactly.
   *
   * Bound to the case *and* the operation id *and* the window that started it:
   * a stale id from a screen that has been open since the last run stops
   * nothing, rather than silently killing whatever happens to be running now.
   */
  async stop(caseId: string, operationId: string, owner: object): Promise<WorkstationSnapshot> {
    const run = this.activeFor(caseId, operationId, owner);
    if (run.stopping) return this.snapshot(run);
    run.stopping = true;
    // Closed before the provider is even asked, so a call already in flight
    // cannot deliver its result into a session the owner has ended.
    this.disposeTools(run);
    this.setStatus(run, "stopping", "Stopping. Anything written so far is kept.");
    const worker = run.worker;
    if (worker === null) return this.snapshot(run);
    const acknowledgement = await worker.interrupt();
    this.note(
      run,
      acknowledgement.acknowledged
        ? `Stop acknowledged: ${acknowledgement.detail}`
        : `Stop requested but not acknowledged: ${acknowledgement.detail}`
    );
    return this.snapshot(run);
  }

  /** Narrow primitive for a future atomic, Mac-approved remote principal transition.
   * This does not revoke a bearer or authorize a handover by itself. The caller
   * must perform both in one synchronous server transaction before exposing
   * the new principal. No pending permission or tool authority is transferred.
   */
  handoverActiveRun(caseId: string, operationId: string, oldOwner: object, newOwner: object): WorkstationSnapshot {
    if (oldOwner === newOwner || this.invalidatedOwners.has(oldOwner) || this.invalidatedOwners.has(newOwner))
      throw new Error("The handover owners are not distinct and current.");
    const run = this.activeFor(caseId, operationId, oldOwner);
    if (run.status !== "running" || run.stopping || run.worker === null ||
        run.waiting.length > 0 || run.decidingPermissionId !== null || run.toolSession !== null ||
        !this.running.has(operationId))
      throw new Error("This run cannot be handed over while starting, stopping, or awaiting authority.");
    if (this.liveRuns().some((item) => item !== run && item.owner === newOwner) ||
        [...this.pending.values()].some((review) => review.owner === newOwner) ||
        [...this.pendingGraphReviews.values()].some((review) => review.owner === newOwner))
      throw new Error("The new owner already has workstation authority.");
    if (this.liveRuns().some((item) => item !== run && item.owner === oldOwner && item.status === "starting"))
      throw new Error("Another run is still starting for the old owner.");
    // No await: old exact Stop fails as soon as this assignment happens. The
    // server transaction must revoke the old bearer in the same event-loop turn.
    run.owner = newOwner;
    for (const [token, review] of this.pending)
      if (review.owner === oldOwner) this.pending.delete(token);
    for (const [token, review] of this.pendingGraphReviews)
      if (review.owner === oldOwner) this.pendingGraphReviews.delete(token);
    this.invalidatedOwners.add(oldOwner);
    return this.snapshot(run);
  }

  /** Called only after the paired phone has passed its owner-chat check. */
  async stopFromPhone(caseId: string, operationId: string): Promise<WorkstationSnapshot> {
    const run = this.active.get(operationId);
    if (run === undefined || run.finished || run.caseId !== caseId)
      throw new Error("That session is no longer running.");
    return this.stop(caseId, operationId, run.owner);
  }

  /**
   * One permission, decided once, for this operation only.
   *
   * `allow` here means "this request, now" — it stores nothing and widens
   * nothing, and the decision is written into the case as a receipt so a person
   * reading the room a month later can see what was permitted and when. A
   * permission id the host is not currently waiting on is refused: an approval
   * that arrives for something already answered is a stale click at best.
   */
  async decide(
    operationId: string,
    permissionId: string,
    allow: boolean,
    owner: object
  ): Promise<WorkstationSnapshot> {
    const run = this.active.get(operationId);
    if (run === undefined || run.finished || TERMINAL_STATUSES.has(run.status))
      throw new Error("That session is no longer running.");
    if (run.owner !== owner)
      throw new Error("This window changed since that request. Start a new session.");
    if (run.stopping || run.decidingPermissionId !== null)
      throw new Error("That session is stopping or already applying a decision.");
    const waiting = run.waiting[0];
    if (waiting === undefined || waiting.id !== permissionId)
      throw new Error("That approval is no longer waiting.");
    const worker = run.worker;
    if (worker === null) throw new Error("That session is no longer running.");

    run.decidingPermissionId = permissionId;
    try {
      await worker.decide(permissionId, allow);
      // A provider may withdraw this review or finish while its decision is in
      // flight. Remove only this id; never shift a different waiting action.
      run.waiting = run.waiting.filter(item => item.id !== permissionId);
      this.note(run, `${allow ? "Allowed once" : "Declined"}: ${waiting.title}`);
      this.audit(run, `${allow ? "allowed once" : "declined"} ${waiting.title}. ${waiting.detail}`);
      if (!run.finished && !TERMINAL_STATUSES.has(run.status)) {
        const next = run.waiting[0];
        this.setStatus(run, run.stopping ? "stopping" : next ? "needs-approval" : "running",
          run.stopping ? "Stopping. Anything written so far is kept."
            : next ? next.title : `Working in ${run.workspace.label}.`);
      }
    } finally { run.decidingPermissionId = null; }
    return this.snapshot(run);
  }

  /** The paired phone names the exact announced call, never an oldest slot. */
  async decideFromPhone(operationId: string, permissionId: string, allow: boolean): Promise<WorkstationSnapshot> {
    const run = this.active.get(operationId);
    if (run === undefined || run.finished)
      throw new Error("That session is no longer running.");
    return this.decide(operationId, permissionId, allow, run.owner);
  }

  /**
   * Every session alive right now.
   *
   * `state` answers for one case and falls back to the record; this answers for
   * the machine and deliberately does not. A fleet view asks "what is working",
   * and a receipt from last Tuesday is not an answer to that question.
   */
  liveSnapshots(): readonly WorkstationSnapshot[] {
    return this.liveRuns().map((run) => this.snapshot(run));
  }

  /** Remote state and decisions may see only sessions owned by their paired principal. */
  snapshotsForOwner(owner: object): readonly WorkstationSnapshot[] {
    const live = this.liveRuns().filter((run) => run.owner === owner).map((run) => this.snapshot(run));
    const recent = [...this.finished].filter(([, snapshot]) => this.finishedOwners.get(snapshot.operationId) === owner)
      .map(([, snapshot]) => snapshot);
    return [...live, ...recent].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Coordinators register their queued work so a global Stop reaches it too. */
  registerParentStop(hook: () => Promise<boolean>): () => void {
    this.parentStopHooks.add(hook);
    return () => { this.parentStopHooks.delete(hook); };
  }

  /** Called only after a paired-phone or equally trusted global Stop check. */
  async stopAllFromPhone(): Promise<{ readonly parents: number; readonly sessions: number; readonly failures: number }> {
    const hooks = [...this.parentStopHooks];
    const parentResults = await Promise.allSettled(hooks.map((hook) => hook()));
    let failures = parentResults.filter((result) => result.status === "rejected").length;
    const live = this.liveSnapshots().filter((snapshot) => snapshot.status !== "stopping");
    for (const snapshot of live) {
      try { await this.stopFromPhone(snapshot.caseId, snapshot.operationId); }
      catch { failures += 1; }
    }
    const local = this.localCaseScope?.sessions() ?? [];
    for (const run of local) {
      try { await this.localCaseScope?.stopSession(run.operationId, run.owner); }
      catch { failures += 1; }
    }
    const briefs = this.localBriefScope?.sessions() ?? [];
    for (const run of briefs) {
      try { this.localBriefScope?.stop(run.operationId, run.owner); }
      catch { failures += 1; }
    }
    return { parents: parentResults.filter((result) => result.status === "fulfilled" && result.value).length,
      sessions: live.length + local.length + briefs.length, failures };
  }

  /**
   * One provider and one prompt outside the host-owned reviewed run.
   *
   * This bypasses `admit` and its case/workspace concurrency rules. The worker
   * receives the caller's cwd, and provider adapters may have their own file,
   * tool or network capabilities. There is no host-enforced read-only scope,
   * preimage barrier or durable run ownership here. Callers must supply their
   * own review and treat the returned outcome as evidence, not an approval.
   */
  async askOnce(input: {
    readonly providerId: WorkstationProviderId;
    readonly prompt: string;
    readonly cwd: string;
    readonly modelId?: string;
    readonly signal: AbortSignal;
    readonly onActivity?: (text: string) => void;
  }): Promise<NativeAskOutcome> {
    const launch = await this.launchFor(input.providerId);
    if (launch.executable === null) throw new Error("That provider is not installed on this Mac.");
    if (input.signal.aborted) throw new Error("Stopped before the provider was asked.");

    let streamedText = "";
    let observedSessionId: string | null = null;
    const options: MutableWorkerOptions = {
      executable: launch.executable,
      cwd: input.cwd,
      onEvent: (event) => {
        if (event.type === "text") streamedText += event.text;
        if (event.type === "session") observedSessionId = event.sessionId;
        if (event.type === "activity" && input.onActivity !== undefined) input.onActivity(event.text);
      }
    };
    if (launch.profileHome !== undefined) options.profileHome = launch.profileHome;
    if (input.modelId !== undefined) options.modelId = input.modelId;

    const worker = this.deps.createWorker(input.providerId, options);
    const stop = (): void => {
      void worker.interrupt().catch(() => undefined);
    };
    input.signal.addEventListener("abort", stop, { once: true });
    try {
      const result = await worker.run(input.prompt);
      return {
        ...result,
        requestedModelId: input.modelId ?? null,
        cancellationRequested: input.signal.aborted,
        resultSource: "worker"
      };
    } catch (problem) {
      return {
        text: streamedText,
        sessionId: observedSessionId,
        finishReason: "failed",
        requestedModelId: input.modelId ?? null,
        cancellationRequested: input.signal.aborted,
        resultSource: "transport",
        detail: problem instanceof Error ? problem.message : "The provider could not finish this request."
      };
    } finally {
      input.signal.removeEventListener("abort", stop);
      await worker.dispose().catch(() => undefined);
    }
  }

  /** Closing or erasing a case while it is working would strand the session. */
  assertIdle(caseId: string): void {
    this.localCaseScope?.assertIdle(caseId);
    if (this.liveRuns().some((run) => run.caseId === caseId) ||
        [...this.restoreLeases.values()].some((lease) => lease.caseId === caseId))
      throw new Error("Stop the workstation session before closing or erasing this case.");
  }

  /** Reserve a canonical workspace for restore before awaiting a durable preimage. */
  async withFileRestoreLease<T>(
    caseId: string,
    workspacePath: string,
    owner: object,
    action: () => Promise<T>
  ): Promise<T> {
    const canonicalPath = await this.deps.canonicalWorkspacePath(workspacePath);
    const room = this.deps.readCase(this.deps.book(), caseId);
    if (room === null || room.closedAt !== null) {
      throw new Error("This case is no longer open. Nothing was restored.");
    }
    // No await between admission and reservation: starts and restores see the
    // same lane, including the time spent saving the preimage.
    this.assertAdmissible({ caseId, providerId: "file restore", workspacePath: canonicalPath, owner });
    const permit = this.quiescenceCoordinator.acquireWriterPermit("restore-lease");
    const operationId = this.deps.newId();
    this.restoreLeases.set(operationId, {
      operationId, caseId, workspacePath: canonicalPath, owner,
      startedAt: this.deps.now()
    });
    try {
      return await action();
    } finally {
      this.restoreLeases.delete(operationId);
      permit.release();
    }
  }

  /** Mutation cannot revoke context while a provider still has it in flight. */
  assertProjectIdle(projectId: string): void {
    this.localCaseScope?.assertProjectIdle(projectId);
    if (this.liveRuns().some((run) => run.projectId === projectId))
      throw new Error("Stop this project's workstation session, then retry changing memory.");
  }

  invalidateProjectReviews(projectId: string): void {
    for (const [token, review] of this.pending)
      if (review.projectId === projectId) this.pending.delete(token);
    for (const [token, review] of this.pendingGraphReviews)
      if (review.review.projectId === projectId) this.pendingGraphReviews.delete(token);
  }

  /**
   * A navigation or a destroyed window ends that window's authority.
   *
   * Reviews it holds are dropped — a token that outlived the document it was
   * shown in is a token nobody read — and a session it started is asked to stop,
   * because there is no longer anywhere to show what it is doing.
   */
  invalidate(owner: object): void {
    this.invalidatedOwners.add(owner);
    this.localCaseScope?.invalidate(owner);
    this.localBriefScope?.invalidate(owner);
    for (const [token, review] of this.pending)
      if (review.owner === owner) this.pending.delete(token);
    for (const [token, review] of this.pendingGraphReviews)
      if (review.owner === owner) this.pendingGraphReviews.delete(token);
    for (const [id, chosen] of this.workspaces)
      if (chosen.owner === owner) this.workspaces.delete(id);
    // Every session that window started, not just the newest one.
    for (const run of this.liveRuns())
      if (run.owner === owner)
        void this.interruptQuietly(run, "The window it was started from went away.");
  }

  /**
   * Quitting is not a crash, and should not look like one in the record.
   *
   * Interrupts, waits briefly for the adapter to settle so the partial answer
   * and its receipt are written by the ordinary path, then gives up rather than
   * holding the quit open on a process that is not listening.
   */
  async shutdown(): Promise<void> {
    await this.localCaseScope?.shutdown();
    await this.localBriefScope?.shutdown();
    const live = this.liveRuns();
    await Promise.all(live.map((run) => this.interruptQuietly(run, "Cadrane is quitting.")));
    const running = [...this.running.values()];
    if (running.length === 0) return;
    // One budget for the whole quit, not one per session: four sessions must
    // not hold the app open for four times as long.
    await Promise.race([
      Promise.all(running),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4_000);
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
  }

  // ---------------------------------------------------------------- internals

  /**
   * Whether a reviewed tool scope is still allowed to answer.
   *
   * Asked by the broker before every single call, and deliberately re-reads the
   * book rather than trusting anything cached: the whole point of the scope is
   * that it covers the sources a person approved, and a source edited in
   * another window mid-run is exactly the case where a cached answer would be
   * wrong. Everything this cannot positively confirm is treated as closed, and
   * a throw on the way to finding out is one of those things.
   */
  private toolScopeOpen(run: RunState, reviewed: PendingReview): boolean {
    try {
      if (run.finished || run.stopping) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (this.active.get(run.operationId) !== run) return false;
      if (run.owner !== reviewed.owner) return false;
      const db = this.deps.book();
      const room = this.deps.readCase(db, run.caseId);
      if (room === null || room.closedAt !== null) return false;
      this.assertMemoryCurrent(db, reviewed);
      const current = this.selectSources(db, run.caseId, reviewed.sourceIds);
      return fingerprintOf(room, current) === reviewed.fingerprint;
    } catch {
      return false;
    }
  }

  private assertMemoryCurrent(db: DatabaseSync, reviewed: PendingReview): void {
    if (this.deps.memory.projectForCase(db, reviewed.review.caseId) !== reviewed.projectId)
      throw new Error("This case changed projects after review. Review again.");
    if (reviewed.projectId !== null && this.deps.memory.epoch(db, reviewed.projectId) !== reviewed.memoryEpoch)
      throw new Error("Project memory changed after review. Review again.");
    if (reviewed.projectId !== null && reviewed.includedFindingRefs.length > 0) {
      if (!this.deps.memory.findings)
        throw new Error("Project finding context is unavailable. Review again.");
      const currentFindings = new Map(this.deps.memory.findings(db, reviewed.projectId)
        .map((finding) => [finding.id, finding]));
      for (const ref of reviewed.includedFindingRefs) {
        const current = currentFindings.get(ref.id);
        if (!current || current.revision !== ref.revision || current.provenance !== "verified")
          throw new Error("An approved finding's source changed after review. Review again.");
      }
    }
    const saved = this.deps.memory.readSnapshot(db, reviewed.contextSnapshotId, reviewed.review.caseId, reviewed.projectId);
    if (!saved || saved.packet !== reviewed.packet || saved.packetHash !== reviewed.review.sourceHash ||
        saved.memoryEpoch !== reviewed.memoryEpoch)
      throw new Error("The reviewed context is unavailable or changed. Review again.");
  }

  /**
   * Closes the scope once, from wherever a run ends.
   *
   * Cleared before `dispose()` is called, so a broker that throws on the way
   * down still leaves nothing behind that a later call could reach.
   */
  private disposeTools(run: RunState): void {
    const session = run.toolSession;
    if (session === null) return;
    run.toolSession = null;
    try {
      session.dispose();
    } catch {
      // A scope that cannot be told to close has already stopped answering:
      // `toolSession` is null above, and every path through the broker checks
      // liveness before it does anything.
    }
  }

  /** Live sessions, oldest first, with anything finished already dropped. */
  private liveRuns(): readonly RunState[] {
    return [...this.active.values()]
      .filter((run) => !run.finished)
      .sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
  }

  /**
   * Whether another session may start beside the ones already going.
   *
   * The policy lives in `session-pool.ts` so it can be read and tested on its
   * own; this only supplies what is running and raises what it decides.
   */
  private assertAdmissible(request: {
    readonly caseId: string;
    readonly providerId: string;
    readonly workspacePath: string;
    readonly owner: object;
  }): void {
    const decision = admit(
      [...this.liveRuns().map((run) => ({
        operationId: run.operationId,
        caseId: run.caseId,
        providerId: run.providerId,
        workspacePath: run.workspace.path,
        owner: run.owner,
        startedAt: run.startedAt
      })), ...(this.localCaseScope?.sessions() ?? []), ...(this.localBriefScope?.sessions() ?? []),
      ...[...this.restoreLeases.values()].map((lease) => ({
        ...lease,
        providerId: ""
      }))],
      request,
      this.deps.now()
    );
    if (!decision.allowed) throw new Error(decision.reason);
  }

  private activeFor(caseId: string, operationId: string, owner: object): RunState {
    const run = this.active.get(operationId);
    if (run === undefined || run.finished || run.caseId !== caseId)
      throw new Error("That session is no longer running.");
    if (run.owner !== owner)
      throw new Error("This window changed since that session started. Reopen the case.");
    return run;
  }

  /**
   * The selected turns, in the order they were asked for.
   *
   * `verbatim` only. Receipts carry operation ids, hashes and the host's own
   * bookkeeping; a request that could name one would be a way to read the room's
   * evidence into a packet by id rather than by choosing a source.
   */
  private selectSources(
    db: DatabaseSync,
    caseId: string,
    ids: readonly string[]
  ): readonly ContextSource[] {
    const turns = this.deps.turnsFor(db, caseId);
    const seen = new Set<string>();
    return ids.map((id, index) => {
      if (seen.has(id)) throw new Error("Select each source once.");
      seen.add(id);
      const turn = turns.find((one) => one.id === id && one.kind === "verbatim");
      if (turn === undefined)
        throw new Error("A selected source is no longer in this case. Review your selection.");
      return { id: turn.id, label: `Source ${index + 1} · ${turn.seat}`, text: turn.body };
    });
  }

  private async launchFor(providerId: WorkstationProviderId): Promise<NativeProviderLaunch> {
    const launches = await this.deps.discoverProviders();
    const launch = launches.find((one) => one.provider.id === providerId);
    if (launch === undefined || launch.executable === null)
      throw new Error("That provider is not installed on this Mac. Check the workstation list.");
    if (launch.provider.state !== "detected")
      throw new Error(`${launch.provider.label} is not usable: ${launch.provider.detail}`);
    return launch;
  }

  private async resolveWorkspace(
    caseId: string,
    workspaceId: string | undefined,
    owner: object
  ): Promise<WorkstationWorkspace> {
    if (workspaceId === undefined) return this.deps.privateWorkspace(caseId);
    const chosen = this.workspaces.get(workspaceId);
    // The window that picked the folder is the window that may use it; a
    // reloaded document did not stand in front of that Finder dialog.
    if (chosen === undefined || chosen.owner !== owner)
      throw new Error("That folder choice is no longer available. Choose the folder again.");
    return chosen.workspace;
  }

  /**
   * A session may be resumed only into the same provider and the same folder.
   *
   * Anything looser would hand one vendor's session id to another, or continue
   * work somewhere it never happened. Resuming is also why the packet stays the
   * current prompt and its selected sources: replaying a whole transcript as if
   * it were new input is a different conversation wearing the same id.
   */
  private resumableSession(
    db: DatabaseSync,
    caseId: string,
    providerId: WorkstationProviderId,
    modelId: string | null,
    workspace: WorkstationWorkspace,
    projectId: string | null,
    memoryEpoch: number
  ): string | null {
    const receipt = this.deps.latestReceipt(db, caseId, providerId);
    if (receipt === null) return null;
    if (receipt.workspacePath !== workspace.path) return null;
    if (receipt.snapshot.providerId !== providerId) return null;
    if (receipt.snapshot.modelId !== modelId) return null;
    if (receipt.projectId === undefined || receipt.projectId !== projectId) return null;
    if (!receipt.contextSnapshotId) return null;
    const context = this.deps.memory.readSnapshot(db, receipt.contextSnapshotId, caseId, projectId);
    if (!context || context.packet === null || context.manifest === null ||
        context.memoryEpoch !== memoryEpoch || context.providerId !== providerId ||
        context.modelId !== modelId || context.dispatchAttemptedAt === null) return null;
    const sessionId = receipt.snapshot.sessionId;
    return sessionId === null || sessionId === "" ? null : sessionId;
  }

  private expireReviews(): void {
    const now = this.deps.now();
    for (const [token, review] of this.pending)
      if (now > review.review.expiresAt) this.pending.delete(token);
    for (const [token, review] of this.pendingGraphReviews)
      if (now > review.review.expiresAt) this.pendingGraphReviews.delete(token);
  }

  private async execute(
    run: RunState,
    packet: string,
    options: NativeWorkerOptions
  ): Promise<void> {
    let worker: NativeWorker | null = null;
    try {
      worker = this.deps.createWorker(run.providerId, options);
      run.worker = worker;
      if (run.stopping) {
        // Stopped in the moment between the durable start and the launch.
        await worker.interrupt().catch(() => undefined);
        throw new Error("Stopped before the provider was asked.");
      }
      this.setStatus(run, "running", `Working in ${run.workspace.label}.`);
      const watchdog = this.watch(run);
      let result: NativeWorkerResult;
      try {
        result = await worker.run(packet);
      } finally {
        clearInterval(watchdog);
      }
      this.settle(run, result);
    } catch (error) {
      this.fail(run, error);
    } finally {
      if (worker !== null) await worker.dispose().catch(() => undefined);
      run.worker = null;
      // Every exit runs through here: a completed turn, a failure, a stop and a
      // throw from the launch itself. One place to close the scope is one place
      // to be wrong about, rather than five.
      this.disposeTools(run);
      this.retire(run);
    }
  }

  /**
   * A session that has gone quiet, and one that has simply gone on too long.
   *
   * Both are real: a native tool waiting on a prompt nobody will answer looks
   * exactly like one thinking hard, and an unbounded run holds a subscription
   * and a folder open indefinitely. Interrupting keeps whatever was produced.
   */
  private watch(run: RunState): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      if (run.finished || run.stopping) return;
      const now = this.deps.now();
      if (now - run.startedAt > RUN_LIMIT_MS) {
        void this.interruptQuietly(run, "This session reached its thirty-minute limit.");
        return;
      }
      if (run.waiting.length === 0 && now - run.lastEventAt > SILENCE_LIMIT_MS)
        void this.interruptQuietly(run, "This session went quiet for five minutes.");
    }, WATCHDOG_TICK_MS);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  private async interruptQuietly(run: RunState, why: string): Promise<void> {
    if (run.finished || run.stopping) return;
    run.stopping = true;
    this.disposeTools(run);
    this.setStatus(run, "stopping", why);
    this.note(run, why);
    await run.worker?.interrupt().catch(() => undefined);
  }

  private onEvent(run: RunState, event: NativeEvent): void {
    // A process that keeps talking after its result was settled must not be
    // able to move a finished record.
    if (run.finished || TERMINAL_STATUSES.has(run.status)) return;
    run.lastEventAt = this.deps.now();
    switch (event.type) {
      case "session": {
        if (event.sessionId !== "" && run.sessionId !== event.sessionId) {
          if (run.sessionId !== null) this.note(run, "The provider started a new session.");
          run.sessionId = event.sessionId;
        }
        break;
      }
      case "text": {
        this.appendText(run, event.text);
        break;
      }
      case "activity": {
        this.note(run, event.text);
        break;
      }
      case "tool": {
        // Timed here rather than in the adapter: one clock for the whole record,
        // and an adapter cannot backdate what it did.
        run.toolCalls.push({
          callId: event.callId,
          tool: event.tool,
          at: this.deps.now(),
          outcome: event.outcome,
          argumentSummary: event.argumentSummary,
          resultBytes: event.resultBytes,
          detail: event.detail
        });
        break;
      }
      case "permission-cleared": {
        const removed = run.waiting.find(item => item.id === event.id);
        if (!removed) break;
        run.waiting = run.waiting.filter(item => item.id !== event.id);
        this.note(run, `Review withdrawn: ${removed.title}`);
        const next = run.waiting[0];
        this.setStatus(run, run.stopping ? "stopping" : next ? "needs-approval" : "running",
          run.stopping ? "Stopping. Anything written so far is kept."
            : next ? next.title : `Working in ${run.workspace.label}.`);
        break;
      }
      case "permission": {
        if (run.stopping) {
          void run.worker?.decide(event.id, false).catch(() => undefined);
          break;
        }
        if (run.waiting.length >= MAX_WAITING_PERMISSIONS) {
          this.note(run, `Too many approvals are waiting; ignored: ${event.title}`);
          break;
        }
        run.waiting.push(
          Object.freeze({ id: event.id, title: event.title, detail: event.detail })
        );
        this.setStatus(run, "needs-approval", event.title);
        break;
      }
    }
    run.updatedAt = this.deps.now();
    this.checkpoint(run);
  }

  private appendText(run: RunState, text: string): void {
    if (text === "") return;
    const room = MAX_ANSWER_CHARS - run.text.length;
    if (room <= 0) {
      if (!run.truncated) {
        run.truncated = true;
        this.note(run, "The answer reached its length limit; the rest was dropped.");
      }
      return;
    }
    run.text += text.length > room ? text.slice(0, room) : text;
    if (text.length > room && !run.truncated) {
      run.truncated = true;
      this.note(run, "The answer reached its length limit; the rest was dropped.");
    }
  }

  private note(run: RunState, line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    run.activity.push(trimmed.slice(0, MAX_ACTIVITY_LINE_CHARS));
    while (run.activity.length > MAX_ACTIVITY_LINES) run.activity.shift();
    run.updatedAt = this.deps.now();
  }

  private setStatus(run: RunState, status: WorkstationStatus, detail: string): void {
    run.status = status;
    run.detail = detail;
    run.updatedAt = this.deps.now();
  }

  private checkpoint(run: RunState): void {
    const now = this.deps.now();
    if (now - run.lastCheckpointAt < CHECKPOINT_MS) return;
    run.lastCheckpointAt = now;
    this.withOpenCase(run, (db) => {
      this.deps.saveReceipt(db, run.caseId, this.receipt(run, "checkpoint"));
    });
  }

  /**
   * A late write must never land in a case somebody closed or erased.
   *
   * The check happens inside the same call as the write rather than once at the
   * top of the run: erasure is exactly the thing that happens while a session is
   * in flight, and a record that reappears in a room the owner deleted is worse
   * than a lost answer.
   */
  private withOpenCase(run: RunState, write: (db: DatabaseSync) => void): boolean {
    try {
      const db = this.deps.book();
      const room = this.deps.readCase(db, run.caseId);
      if (room === null || room.closedAt !== null) return false;
      write(db);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * What the answer appears to contain, for the receipt only.
   *
   * Named rather than saved: turning a fenced block into a stored output is the
   * owner's press in the room, not something a finishing session decides for
   * them. Wrapped because an extractor is pattern-matching on untrusted text and
   * must never be able to lose a completed answer's transaction.
   */
  private describe(answer: string): string {
    if (answer === "") return "";
    try {
      const found = this.deps.extractArtifacts(answer);
      if (found.length === 0) return "";
      return `\nContains ${found.length} output${found.length === 1 ? "" : "s"}: ${found
        .slice(0, 5)
        .map((artifact) => `${artifact.kind} "${artifact.title}"`)
        .join("; ")}.`;
    } catch {
      return "";
    }
  }

  private audit(run: RunState, sentence: string): void {
    this.withOpenCase(run, (db) => {
      this.deps.appendTurn(db, run.caseId, {
        seat: "workstation",
        kind: "receipt",
        body: `Workstation ${run.operationId}: the owner ${sentence}\nThis decision applied to that one request only.`
      });
    });
  }

  private settle(run: RunState, result: NativeWorkerResult): void {
    if (result.reportedModelId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(result.reportedModelId))
      run.reportedModelId = result.reportedModelId;
    if (result.sessionId !== null && result.sessionId !== "") run.sessionId = result.sessionId;
    const answer = run.text.trim() === "" ? result.text.trim() : run.text.trim();
    // A stop that races a finishing answer must land as stopped. Reporting
    // "completed" here would tell somebody who pressed Stop that their session
    // ran to the end, and keep whatever the provider did after the stop as if
    // they had waited for it. The partial text is kept either way.
    const settled = finishStatus(result, answer);
    const status: WorkstationStatus = run.stopping && settled === "completed" ? "stopped" : settled;
    const detail =
      status === settled
        ? finishDetail(result, answer, run)
        : "Stopped. The answer above is what had arrived when you stopped it.";
    this.remember(run.providerId, status, detail);
    this.setStatus(run, status, detail);
    run.text = answer;

    const contains = this.describe(answer);
    const wrote = this.withOpenCase(run, (db) => {
      this.deps.transaction(db, () => {
        if (answer !== "") {
          const turnId = this.deps.appendTurn(db, run.caseId, {
            seat: `Workstation · ${run.providerLabel}${run.modelId === null ? "" : ` · ${run.modelId}`}`,
            kind: "verbatim",
            body: status === "completed" ? answer : partialBody(answer, detail)
          });
          run.answerTurnId = turnId;
          this.deps.appendTurn(db, run.caseId, {
            seat: "workstation",
            kind: "receipt",
            body: `${finishReceiptBody(run, status, detail, turnId)}${contains}`
          });
          return;
        }
        this.deps.appendTurn(db, run.caseId, {
          seat: "workstation",
          kind: "receipt",
          body: finishReceiptBody(run, status, detail, null)
        });
      });
      this.deps.saveReceipt(db, run.caseId, this.receipt(run, status === "completed" ? "finish" : "interrupted"));
    });
    if (!wrote)
      this.setStatus(
        run,
        status,
        `${detail} This case was closed or erased while it ran, so nothing was written to it.`
      );
  }

  private fail(run: RunState, error: unknown, status: WorkstationStatus = run.stopping ? "interrupted" : "failed"): void {
    const reason = error instanceof Error ? error.message : "The session failed.";
    const answer = run.text.trim();
    const detail = answer === "" ? reason : `${reason} The partial answer above was kept.`;
    this.remember(run.providerId, status, reason);
    this.setStatus(run, status, detail);
    run.text = answer;

    this.withOpenCase(run, (db) => {
      this.deps.transaction(db, () => {
        if (answer !== "") {
          const turnId = this.deps.appendTurn(db, run.caseId, {
            seat: `Workstation · ${run.providerLabel}${run.modelId === null ? "" : ` · ${run.modelId}`}`,
            kind: "verbatim",
            body: partialBody(answer, detail)
          });
          run.answerTurnId = turnId;
          this.deps.appendTurn(db, run.caseId, {
            seat: "workstation",
            kind: "receipt",
            body: finishReceiptBody(run, status, detail, turnId)
          });
          return;
        }
        this.deps.appendTurn(db, run.caseId, {
          seat: "workstation",
          kind: "receipt",
          body: finishReceiptBody(run, status, detail, null)
        });
      });
      this.deps.saveReceipt(db, run.caseId, this.receipt(run, "interrupted"));
    });
  }

  /**
   * What a real attempt taught us about a provider.
   *
   * Only a failure that reads like sign-in changes the row, and it changes it to
   * a sentence about the vendor's own app. Nothing here opens, reads or repairs
   * a credential — that is the vendor's business and stays that way.
   */
  private remember(providerId: WorkstationProviderId, status: WorkstationStatus, detail: string): void {
    if (status === "completed") {
      this.attempts.set(providerId, { state: "detected", detail: "Answered a real request." });
      return;
    }
    if (status !== "failed") return;
    if (!looksLikeSignIn(detail)) return;
    this.attempts.set(providerId, {
      state: "blocked",
      detail:
        "This provider needs you to sign in with its own app or CLI. Cadrane never reads or stores your credentials."
    });
  }

  private retire(run: RunState): void {
    run.finished = true;
    run.waiting = [];
    run.updatedAt = this.deps.now();
    const previous = this.finished.get(run.caseId);
    if (previous !== undefined) this.finishedOwners.delete(previous.operationId);
    this.finished.set(run.caseId, this.snapshot(run));
    this.finishedOwners.set(run.operationId, run.owner);
    while (this.finished.size > MAX_REMEMBERED_CASES) {
      const oldest = this.finished.keys().next();
      if (oldest.done) break;
      const forgotten = this.finished.get(oldest.value);
      if (forgotten !== undefined) this.finishedOwners.delete(forgotten.operationId);
      this.finished.delete(oldest.value);
    }
    this.active.delete(run.operationId);
    this.running.delete(run.operationId);
    run.quiescencePermit?.release();
    delete run.quiescencePermit;
  }

  private receipt(run: RunState, event: WorkstationSessionReceipt["event"]): WorkstationSessionReceipt {
    const receipt: WorkstationSessionReceipt = {
      version: 1,
      event,
      snapshot: this.snapshot(run),
      workspacePath: run.workspace.path,
      contextSnapshotId: run.contextSnapshotId,
      projectId: run.projectId
    };
    return Object.freeze(receipt);
  }

  private snapshot(run: RunState): WorkstationSnapshot {
    return Object.freeze({
      operationId: run.operationId,
      caseId: run.caseId,
      providerId: run.providerId,
      modelId: run.modelId,
      ...(run.reportedModelId ? { reportedModelId: run.reportedModelId } : {}),
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      text: run.text,
      answerTurnId: run.answerTurnId,
      activity: Object.freeze([...run.activity]),
      permission: run.waiting[0] ?? null,
      detail: run.detail
    });
  }
}

function finishStatus(result: NativeWorkerResult, answer: string): WorkstationStatus {
  switch (result.finishReason) {
    case "completed":
      // A success with nothing in it is not an answer, and saying so is the
      // difference between an empty draft and a silent failure.
      return answer === "" ? "failed" : "completed";
    case "stopped":
      return "stopped";
    case "denied":
      return "failed";
    case "failed":
      return "failed";
  }
}

function finishDetail(result: NativeWorkerResult, answer: string, run: RunState): string {
  const said = result.detail?.trim() ?? "";
  switch (result.finishReason) {
    case "completed":
      return answer === ""
        ? `${run.providerLabel} finished without writing an answer. Nothing was saved as a draft.`
        : said === ""
          ? `${run.providerLabel} finished. Review the draft before using it.`
          : said;
    case "stopped":
      return said === "" ? "Stopped. Anything written before the stop was kept." : said;
    case "denied":
      return said === ""
        ? "The session stopped because a permission was declined."
        : said;
    case "failed":
      return said === "" ? `${run.providerLabel} could not finish this session.` : said;
  }
}

function partialBody(answer: string, detail: string): string {
  return `${answer}\n\n---\nThis is a partial answer. ${detail}`;
}

function startReceiptBody(run: RunState, review: WorkstationReview): string {
  return [
    `Workstation ${run.operationId} started with ${review.providerLabel}${review.modelId === null ? "" : ` · ${review.modelId}`}.`,
    `Workspace: ${review.workspace.label} (${review.workspace.path}).`,
    `Reviewed packet SHA-256: ${review.sourceHash}.`,
    `Reviewed context snapshot: ${run.contextSnapshotId}.`,
    `Selected sources: ${review.sourceIds.length === 0 ? "none" : review.sourceIds.join(", ")}.`,
    review.resumeSessionId === null
      ? "New provider session."
      : `Resuming provider session ${review.resumeSessionId}.`,
    review.tools === undefined || !review.tools.enabled
      ? "No tools were granted; the provider saw only the packet above."
      : `Tools granted: ${review.tools.toolNames.length} over ${review.tools.sources.length} reviewed ${review.tools.sources.length === 1 ? "source" : "sources"} (${review.tools.totalSourceChars.toLocaleString("en-GB")} characters), in a new session. Each call was asked about separately.`,
    "A start is not a completed answer. Without a matching outcome below, this session was interrupted and will not restart on its own."
  ].join("\n");
}

function finishReceiptBody(
  run: RunState,
  status: WorkstationStatus,
  detail: string,
  turnId: string | null
): string {
  const ledger = buildToolLedger(run.toolCalls);
  return [
    `Workstation ${run.operationId} ${status}.`,
    turnId === null ? "No draft was saved." : `Saved draft: ${turnId}.`,
    run.sessionId === null ? "No provider session id was reported." : `Provider session: ${run.sessionId}.`,
    `Workspace: ${run.workspace.path}.`,
    detail,
    // Absent entirely when no tool was ever called, rather than a line saying
    // nothing happened: a receipt for an ordinary session should read exactly
    // as it did before any of this existed.
    ...(ledger.receiptText === "" ? [] : ["", ledger.receiptText])
  ].join("\n");
}

/**
 * A folder that is really a blanket grant.
 *
 * A home directory or a volume root is everything somebody owns, which is not a
 * workspace whatever the picker returned; and a relative path is not a choice a
 * picker produces at all.
 */
export function whyWorkspaceUnsuitable(candidate: string): string | null {
  const normalised = candidate.replace(/\/+$/u, "");
  if (!candidate.startsWith("/"))
    return "Choose a folder from the picker. Cadrane does not accept a typed path.";
  if (normalised === "") return "Choose a folder inside your home directory, not the whole disk.";
  const segments = normalised.split("/").filter((part) => part !== "");
  if (segments.length <= 1)
    return "Choose a folder inside your home directory, not the whole disk.";
  if (segments[0] === "Users" && segments.length === 2)
    return "Choose a folder to work in rather than your whole home directory.";
  if (segments[0] === "Volumes" && segments.length === 2)
    return "Choose a folder on that disk rather than the whole disk.";
  return null;
}

/**
 * A case id becomes at most one folder name, and never a path.
 *
 * Ids are minted here as UUIDs, so this changes nothing today. It exists
 * because the private workspace root is joined with this value, and "the id in
 * the book has always been a UUID" is an assumption rather than a boundary.
 */
export function workspaceFolderName(caseId: string): string {
  const safe = caseId
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (safe === "") throw new Error("This case cannot be given a private workspace folder.");
  return safe;
}

function chosenModel(provider: WorkstationProvider, requested: string): string {
  if (requested.trim() === "")
    throw new Error("Choose a model before reviewing this request.");
  const wanted = requested.trim();
  // Codex has no verified catalogue; the owner can enter an identifier, which
  // is sent exactly as typed and verified only by the real native attempt.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(wanted) ||
      (provider.id !== "codex" && !provider.models.some((model) => model.id === wanted)))
    throw new Error(`${provider.label} does not offer the model "${wanted}".`);
  return wanted;
}

function looksLikeSignIn(detail: string): boolean {
  return /\bsigned?[- ]?(in|out)\b|\blog(ged)?[- ]?(in|out)\b|\bunauthori[sz]ed\b|authenticat|credential|\bsubscription required\b|\bnot entitled\b/iu.test(
    detail
  );
}

/**
 * The name a person reads for a source.
 *
 * `selectSources` labels for the packet assembler, which numbers sources and
 * prefixes the seat. The review and the tool answers both show this shorter
 * form, and they show the *same* shorter form on purpose: a model naming a
 * source the owner cannot find in the screen they approved is a small thing
 * that makes the whole review harder to trust.
 */
function displaySourceLabel(label: string): string {
  const stripped = label.replace(/^Source \d+ · (?:Source · )?/u, "").trim();
  return stripped === "" ? "Untitled source" : stripped;
}

function fingerprintOf(room: WorkstationCaseRow, sources: readonly ContextSource[]): string {
  return sha256(
    JSON.stringify([
      room.id,
      room.closedAt,
      sources.map((source) => [source.id, sha256(source.text)])
    ])
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function basename(value: string): string {
  const parts = value.replace(/\/+$/u, "").split("/");
  return parts[parts.length - 1] ?? "";
}
