/**
 * What the newer capabilities look like as they cross the bridge.
 *
 * Each of these has a tested module in the main process and, until now, no way
 * for a person to reach it: `scripts/reachable.mjs` counted ten thousand lines
 * that nothing imported. These are the shapes that make them reachable.
 *
 * Everything here is structural and deliberately loose about the *contents* of
 * a result — the owning module decides that, and restating its internals here
 * would give two places to be wrong about one thing. What this file pins is the
 * shape of the request, because that is what the renderer may send and what the
 * host must validate.
 */
import type {
  GovernedProjectMemoryCommand, GovernedProjectMemoryView,
  GovernedProjectMemoryConflictCommand, GovernedProjectMemoryConflictView
} from "./project-memory.js";
import type { WorkstationProviderId, WorkstationReview } from "./workstation.js";

/** One thing the app can do on this Mac. Described before it is ever run. */
export type MacActionInput =
  | { readonly kind: "reveal"; readonly caseId: string; readonly path: string }
  | { readonly kind: "open"; readonly caseId: string; readonly path: string }
  | { readonly kind: "shortcut"; readonly caseId: string; readonly name: string; readonly input?: string };

export interface MacActionDescription {
  readonly title: string;
  readonly detail: string;
  readonly reversible: boolean;
  /** Null when it may run. A sentence when it may not, shown instead of the action. */
  readonly refusedBecause: string | null;
}

export type MacActionResult =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "refused"; readonly reason: string };

export type WebReadResult =
  | {
      readonly status: "read";
      /** The url after redirects, which is where the text actually came from. */
      readonly url: string;
      readonly title: string;
      readonly text: string;
      readonly bytes: number;
      readonly truncated: boolean;
      readonly fetchedAt: number;
    }
  | { readonly status: "refused"; readonly reason: string };

export interface WorkspaceEntryView {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "file" | "folder";
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly textual: boolean;
  readonly depth: number;
}

export interface WorkspaceListingView {
  readonly entries: readonly WorkspaceEntryView[];
  readonly truncated: boolean;
  readonly totalBytes: number;
}

export type FilePreviewResult =
  | { readonly status: "text"; readonly text: string; readonly truncated: boolean; readonly bytes: number }
  | { readonly status: "unavailable"; readonly reason: string };

export interface DiffHunkView {
  readonly beforeStart: number;
  readonly beforeLines: readonly string[];
  readonly afterStart: number;
  readonly afterLines: readonly string[];
  readonly context: readonly string[];
}

export interface FileChangeView {
  readonly relativePath: string;
  readonly kind: "added" | "removed" | "modified" | "unchanged" | "binary" | "missing";
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunkView[];
  readonly truncated: boolean;
  readonly summary: string;
}

export interface TableColumnView {
  readonly name: string;
  readonly index: number;
  readonly type: "text" | "number" | "money" | "date" | "boolean" | "empty";
  readonly blanks: number;
}

export interface ParsedTableView {
  readonly columns: readonly TableColumnView[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly delimiter: string;
  readonly problems: readonly string[];
}

export interface TableQueryRequest {
  readonly caseId: string;
  readonly sourceTurnId: string;
  readonly filters: readonly {
    readonly column: number;
    readonly op: "is" | "is-not" | "contains" | "gt" | "lt" | "between" | "empty" | "not-empty";
    readonly value: string;
    readonly value2?: string;
  }[];
  readonly sort?: { readonly column: number; readonly direction: "asc" | "desc" };
  readonly groupBy?: number;
  readonly aggregate?: { readonly column: number; readonly fn: "sum" | "count" | "avg" | "min" | "max" };
  readonly limit?: number;
}

export interface TableQueryView {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly matched: number;
  readonly total: number;
  readonly summary: string;
  readonly problems: readonly string[];
}

export interface ContentHitView {
  readonly turnId: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly who: string;
  readonly at: number;
  readonly score: number;
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
}

export interface BookSearchView {
  readonly hits: readonly ContentHitView[];
  readonly scanned: number;
  readonly matched: number;
  readonly summary: string;
}

export interface AuditDocumentView {
  readonly title: string;
  readonly markdown: string;
  readonly entryCount: number;
  readonly approvals: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
}

export interface DeliveryPackItemView {
  readonly relativePath: string;
  readonly kind: "output" | "source" | "image" | "record";
  readonly title: string;
  readonly bytes: number;
  /** The turn this came from, so a reader can go back to it. Null for the record. */
  readonly sourceId: string | null;
}

export interface DeliveryPackView {
  readonly folderName: string;
  readonly items: readonly DeliveryPackItemView[];
  readonly totalBytes: number;
  readonly readme: string;
  /** What is deliberately NOT going to the client, and why. */
  readonly excluded: readonly { readonly title: string; readonly reason: string }[];
  readonly warnings: readonly string[];
  /** Set only once the folder has actually been written. */
  readonly writtenTo?: string;
}

export interface CaptureTargetView {
  readonly id: string;
  readonly label: string;
  readonly kind: "screen" | "window";
  readonly thumbnailDataUrl: string;
}

export type CaptureResult =
  | {
      readonly status: "captured";
      readonly pngPath: string;
      readonly bytes: number;
      readonly width: number;
      readonly height: number;
      readonly label: string;
      readonly at: number;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface PasteAnalysisView {
  readonly kind: "text" | "markdown" | "csv" | "json" | "code" | "url" | "image";
  readonly title: string;
  readonly preview: string;
  readonly chars: number;
  readonly lines: number;
  readonly language: string | null;
  readonly host: string | null;
  /** Things worth seeing before this becomes a saved source, such as a secret. */
  readonly warnings: readonly string[];
}

/**
 * The newer half of the workstation bridge.
 *
 * Split into its own interface so the original one stays readable, and so what
 * was added to reach these capabilities is visible as a group rather than
 * scattered through a list of forty verbs.
 */
/** Going and reading, rather than answering from memory. */
export type ResearchStepKindView = "planning" | "reading" | "asking" | "thinking" | "writing";

export interface ResearchStepView {
  readonly index: number;
  readonly kind: ResearchStepKindView;
  readonly title: string;
  readonly detail: string;
  readonly at: number;
  /** null while the step is still running. */
  readonly ok: boolean | null;
}

export interface ResearchRunView {
  readonly runId: string;
  readonly caseId: string;
  readonly question: string;
  readonly state: "planning" | "working" | "writing" | "done" | "stopped" | "failed" | "interrupted";
  readonly steps: readonly ResearchStepView[];
  readonly sourcesRead: number;
  readonly notesKept: number;
  readonly headline: string;
  readonly answer: string | null;
  readonly nativeOutcomes?: readonly NativeAskOutcomeView[];
  /** The parts of the question it could not settle, said plainly. */
  readonly unanswered: readonly string[];
  readonly canStop: boolean;
}

/** One thing the app worked out about a project, and whether it still counts. */
export interface ProjectMemoryFactView {
  readonly id: string;
  readonly text: string;
  readonly confirmations: number;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Which of five sorts of thing this is, so the screen can group them. */
  readonly kind:
    | "about-the-business"
    | "about-a-person"
    | "a-decision"
    | "a-preference"
    | "a-constraint";
  /** The piece of work it came from, by title. */
  readonly learnedFrom: string;
}

export interface ProjectMemoryView {
  readonly facts: readonly ProjectMemoryFactView[];
  readonly skippedCount?: number;
  readonly droppedCount?: number;
}

export interface WorkstationChangeView {
  readonly relativePath: string;
  readonly kind: "added" | "changed" | "removed";
  readonly bytes: number;
  readonly modifiedAt: number;
  /** False when the file was too large to keep, so no undo is offered for it. */
  readonly canRestore: boolean;
}

export interface WorkstationChangesView {
  readonly changes: readonly WorkstationChangeView[];
  readonly folderKnown: boolean;
  /**
   * False when no snapshot was taken before the session ran. Different from an
   * empty list of changes, and said differently on screen.
   */
  readonly beforeKnown: boolean;
}

export interface UsageReceiptView {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string | null;
  readonly status: "completed" | "stopped" | "failed" | "interrupted";
  readonly startedAt: number;
  readonly endedAt: number;
  readonly caseId: string;
}

export interface UsageReceiptsView {
  readonly receipts: readonly UsageReceiptView[];
  /** Every subscription this Mac has, including ones he has not used. */
  readonly known: readonly { readonly id: string; readonly label: string }[];
  readonly skipped: number;
  readonly capped: boolean;
}

export type WatchTargetView =
  | { readonly kind: "page"; readonly url: string; readonly label: string }
  | { readonly kind: "folder"; readonly path: string; readonly label: string }
  | { readonly kind: "routine"; readonly routineId: string; readonly label: string };

export interface WatchView {
  readonly id: string;
  readonly target: WatchTargetView;
  readonly cadence: "hourly" | "daily" | "weekly";
  readonly tellMeWhen: "anything-changes" | "numbers-change" | "something-new-appears";
  readonly quietHours: boolean;
  readonly lastCheckedAt: number | null;
  readonly lastChangedAt: number | null;
  readonly paused: boolean;
}

export interface WatchVerdictView {
  readonly changed: boolean;
  readonly worthTelling: boolean;
  readonly what: string;
  readonly detail: readonly string[];
}

export interface ScheduleDefinitionView {
  readonly version: 1;
  readonly event: "definition";
  readonly scheduleId: string;
  readonly revision: number;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly instruction: string;
  readonly instructionHash: string;
  readonly expression: string;
  readonly timezone: string;
  readonly providerId: WorkstationProviderId;
  readonly modelId: string;
  readonly maxLatenessMs: number;
  readonly at: number;
}

export interface ScheduleGrantView {
  readonly version: 1;
  readonly event: "grant";
  readonly scheduleId: string;
  readonly revision: number;
  readonly grantId: string;
  readonly ownerActionId: string;
  readonly approvedBy: "local-owner";
  readonly scope: "queue-only";
  readonly instructionHash: string;
  readonly expiresAt: number;
  readonly at: number;
}

export interface ScheduleSavedView {
  readonly definition: ScheduleDefinitionView;
  readonly grant: ScheduleGrantView | null;
  readonly grantRevoked: boolean;
}

export interface ScheduleGrantReviewView {
  readonly token: string;
  readonly reviewExpiresAt: number;
  readonly grantExpiresAt: number;
  readonly definition: ScheduleDefinitionView;
  readonly nextDueAt: readonly number[];
  readonly scope: "queue-only";
}

export interface ScheduleOccurrenceView {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly dueAt: number;
  readonly status: "queued" | "claimed" | "completed" | "stopped" | "failed" | "uncertain" | "cancelled";
}

export interface ScheduleRunView {
  readonly runId: string;
  readonly occurrenceId: string;
  readonly status: "working" | "completed" | "stopped" | "failed" | "uncertain" | "rejected";
  readonly detail: string;
  readonly operationId: string | null;
}

export interface ModelOutcomeEvidenceView {
  readonly operationId: string;
  readonly caseId: string;
  readonly projectId: string | null;
  readonly providerId: string;
  readonly requestedModelId: string | null;
  readonly reportedModelId: string | null;
  readonly attemptState: "admitted" | "attempted" | "unknown";
  readonly terminalState: "completed" | "stopped" | "failed" | "interrupted" | "denied" | "unknown";
  readonly observedCompleted: boolean;
  readonly durationMs: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly reasons: readonly string[];
}

/** Owner policy; a tombstone keeps only an empty value and its next revision. */
export interface ModelProjectPreferencesView {
  readonly projectId?: string | null;
  readonly exclusions?: readonly { readonly providerId: WorkstationProviderId; readonly modelId?: string }[];
  readonly providerWeights?: Readonly<Record<string, number>>;
  readonly modelWeights?: Readonly<Record<string, number>>;
  readonly providerModelWeights?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly capabilityWeights?: Readonly<Record<string, number>>;
}

export interface StoredModelProjectPreferencesView {
  readonly projectId: string;
  readonly revision: number;
  readonly preferences: ModelProjectPreferencesView;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

/** Immutable, unaccepted proposal based only on measured completion and current owner policy. */
export interface ModelAdaptationProposalView {
  readonly id: string;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly catalogSha256: string;
  readonly catalog: readonly {
    readonly providerId: WorkstationProviderId;
    readonly state: "detected" | "unavailable" | "blocked";
    readonly modelIds: readonly string[];
  }[];
  readonly evidenceSha256: string;
  readonly evidenceOperations: number;
  readonly evidenceReceiptCount: number;
  readonly delta: {
    readonly kind: "model_weight";
    readonly providerId: WorkstationProviderId;
    readonly modelId: string;
    readonly from: number;
    readonly to: number;
  };
  readonly reasons: readonly string[];
  readonly unknowns: readonly string[];
  readonly createdAt: number;
  readonly proposalSha256: string;
}

export interface SoloModelAdviceView {
  readonly projectId: string | null;
  readonly preferencesRevision: number | null;
  readonly advice: {
    readonly isPinned: boolean;
    readonly pinStatus: "none" | "active" | "unavailable" | "blocked";
    readonly selected: ModelRankedCandidateView | null;
    readonly rankedCandidates: readonly ModelRankedCandidateView[];
    readonly reasons: readonly string[];
  };
  readonly evidenceOperations: number;
  readonly providerCatalog: readonly {
    readonly providerId: WorkstationProviderId;
    /** Detected means a local binary exists; it does not prove account readiness. */
    readonly state: "detected" | "unavailable" | "blocked";
    readonly modelIds: readonly string[];
  }[];
  readonly readiness: "unverified";
  readonly basis: string;
}

export interface TeamModelAdviceView {
  readonly projectId: string | null;
  readonly preferencesRevision: number | null;
  readonly advice: {
    readonly mode: "complementary_roles";
    readonly isComparison: false;
    readonly assignments: readonly {
      readonly roleId: string;
      readonly roleName: string;
      readonly ownership: string;
      readonly inputs: readonly string[];
      readonly outputs: readonly string[];
      readonly dependencies: readonly string[];
      readonly assignedCandidate: ModelRankedCandidateView["candidate"];
      readonly modelSpecificWork: string;
      readonly assignedPrompt: string;
      readonly score: number;
      readonly reasons: readonly string[];
    }[];
    readonly unassignedRoles: readonly {
      readonly roleId: string;
      readonly roleName: string;
      readonly requiredCapabilities: readonly string[];
    }[];
    readonly reviewRequiredPackages: readonly {
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
    }[];
    readonly reasons: readonly string[];
  };
  readonly evidenceOperations: number;
  readonly providerCatalog: SoloModelAdviceView["providerCatalog"];
  readonly readiness: "unverified";
  readonly basis: string;
}

export interface ModelRankedCandidateView {
  readonly candidate: {
    readonly providerId: WorkstationProviderId;
    readonly modelId: string;
    readonly capabilities: readonly string[];
    readonly displayName?: string;
    readonly contextTokens?: number;
  };
  readonly score: number;
  readonly capabilityScore: number;
  readonly preferenceScore: number;
  readonly reliabilityScore: number;
  readonly reliabilitySignal: {
    readonly status: "measured" | "insufficient_sample" | "unknown";
    readonly observedCompletedCount: number;
    readonly totalAttemptedCount: number;
    readonly completionRatio: number | null;
    readonly summary: string;
  };
  readonly reasons: readonly string[];
}

export interface WorkstationSurfaceBridge {
  // Explicit owner-reviewed schedules. Save, Queue and Prepare never run a model.
  scheduleList(input: { readonly caseId: string }): Promise<readonly ScheduleSavedView[]>;
  scheduleSave(input: Omit<ScheduleDefinitionView, "version" | "event" | "revision" | "instructionHash" | "at"> &
    { readonly expectedRevision: number }): Promise<ScheduleSavedView>;
  schedulePreview(input: { readonly scheduleId: string }): Promise<{
    readonly definition: ScheduleDefinitionView;
    readonly grant: ScheduleGrantView | null;
    readonly grantRevoked: boolean;
    readonly next: readonly { readonly utcMs: number; readonly utcIso: string; readonly localKey: string; readonly tz: string }[];
  }>;
  scheduleGrantReview(input: { readonly scheduleId: string; readonly expectedRevision: number;
    readonly expiresAt: number }): Promise<ScheduleGrantReviewView>;
  scheduleGrantConfirm(input: { readonly token: string }): Promise<ScheduleSavedView>;
  scheduleRevoke(input: { readonly scheduleId: string; readonly grantId: string }): Promise<ScheduleSavedView | null>;
  scheduleQueue(input: { readonly scheduleId: string }): Promise<{
    readonly status: "inactive" | "not-due" | "queued" | "already-queued" | "already-recorded";
    readonly occurrence: ScheduleOccurrenceView | null;
  }>;
  schedulePrepare(input: { readonly scheduleId: string; readonly occurrenceId: string }): Promise<
    WorkstationReview & { readonly scheduleId: string; readonly occurrenceId: string;
      readonly dueAt: number; readonly grantExpiresAt: number }
  >;
  scheduleStart(input: { readonly token: string }): Promise<ScheduleRunView>;
  schedulePoll(input: { readonly runId: string }): Promise<ScheduleRunView>;
  scheduleStop(input: { readonly runId: string }): Promise<ScheduleRunView>;
  describeMacAction(input: MacActionInput): Promise<MacActionDescription>;
  runMacAction(input: MacActionInput): Promise<MacActionResult>;
  readWebPage(input: { readonly url: string }): Promise<WebReadResult>;
  listFiles(input: { readonly caseId: string }): Promise<WorkspaceListingView>;
  previewFile(input: { readonly caseId: string; readonly relativePath: string }): Promise<FilePreviewResult>;
  fileChange(input: {
    readonly caseId: string;
    readonly relativePath: string;
    /** What the panel last showed. The diff is against this, not against disk. */
    readonly previousText: string;
  }): Promise<FileChangeView>;
  parseTable(input: { readonly caseId: string; readonly sourceTurnId: string }): Promise<ParsedTableView>;
  queryTable(input: TableQueryRequest): Promise<TableQueryView>;
  searchBook(input: { readonly query: string }): Promise<BookSearchView>;
  exportAudit(input: { readonly caseId: string }): Promise<AuditDocumentView>;
  deliveryPack(input: {
    readonly caseId: string;
    readonly clientName?: string;
    /** Absent or false plans only. The folder is written on an explicit yes. */
    readonly confirm?: boolean;
  }): Promise<DeliveryPackView>;
  listCaptureTargets(): Promise<readonly CaptureTargetView[]>;
  captureTarget(input: { readonly caseId: string; readonly targetId: string }): Promise<CaptureResult>;
  analysePaste(input: { readonly text: string }): Promise<PasteAnalysisView>;

  // Going and reading, rather than answering from memory. Start, watch, stop.
  researchPrepare(input: unknown): Promise<{ readonly token: string; readonly expiresAt: number;
    readonly review: Omit<WorkstationReview, "token"> }>;
  researchStart(input: { readonly token: string }): Promise<{ readonly runId: string }>;
  researchPoll(input: { readonly runId: string }): Promise<ResearchRunView>;
  researchStop(input: { readonly runId: string }): Promise<ResearchRunView>;

  // What it worked out about a project, and striking any of it out.
  memoryRead(input: { readonly projectId: string }): Promise<ProjectMemoryView>;
  memoryLearn(input: {
    readonly projectId: string;
    /**
     * A plain sentence, and which piece of work it came from. The title is what
     * lets the screen say "Learned from the Acme proposal" rather than leaving
     * a fact with no provenance at all.
     */
    readonly findings: readonly {
      readonly finding: string;
      readonly fromTitle: string;
    }[];
  }): Promise<ProjectMemoryView>;
  memorySet(input: {
    readonly projectId: string;
    readonly id: string;
    readonly pinned?: boolean;
    readonly hidden?: boolean;
  }): Promise<ProjectMemoryView>;
  memoryForget(input: { readonly projectId: string; readonly id: string }): Promise<ProjectMemoryView>;
  memoryGoverned(input: GovernedProjectMemoryCommand): Promise<GovernedProjectMemoryView>;
  memoryConflicts(input: GovernedProjectMemoryConflictCommand): Promise<GovernedProjectMemoryConflictView>;

  // What a session changed in a folder, and putting one file back.
  changesList(input: { readonly caseId: string; readonly operationId: string }): Promise<WorkstationChangesView>;
  changeContents(input: {
    readonly caseId: string;
    readonly operationId: string;
    readonly relativePath: string;
  }): Promise<{ readonly before: string | null; readonly after: string | null }>;
  changeRestore(input: {
    readonly caseId: string;
    readonly operationId: string;
    readonly relativePath: string;
  }): Promise<{ readonly restored: boolean }>;

  // Keeping an eye on a page, a folder or a routine between visits.
  watchList(): Promise<{ readonly watches: readonly WatchView[]; readonly checking: boolean }>;
  watchSave(input: { readonly watch: WatchView }): Promise<{ readonly watches: readonly WatchView[] }>;
  watchRemove(input: { readonly id: string }): Promise<{ readonly watches: readonly WatchView[] }>;
  watchNow(input: { readonly id: string }): Promise<{ readonly verdict: WatchVerdictView | null }>;

  /**
   * What he has used of the subscriptions he already pays for.
   *
   * Sessions and the time they took, counted from receipts this app already
   * wrote. Never tokens and never money: this app does not bill him and must
   * not imply it knows what a vendor will charge.
   */
  usage(input: { readonly window: "today" | "week" | "month" }): Promise<UsageReceiptsView>;
  /** Measured local run states only; no quality, quota, cost, or preference claim. */
  modelOutcomeEvidence(input: {
    readonly projectId?: string | null;
    readonly caseId?: string;
    readonly maxReceipts?: number;
  }): Promise<readonly ModelOutcomeEvidenceView[]>;
  modelPreferencesRead(input: { readonly projectId: string }): Promise<StoredModelProjectPreferencesView | null>;
  modelPreferencesSave(input: { readonly projectId: string; readonly expectedRevision: number;
    readonly preferences: ModelProjectPreferencesView }): Promise<StoredModelProjectPreferencesView>;
  modelPreferencesForget(input: { readonly projectId: string; readonly expectedRevision: number }): Promise<StoredModelProjectPreferencesView>;
  /** Read-only advice. It cannot select, prepare, or start a Solo run. */
  soloModelAdvice(input: { readonly projectId: string | null; readonly explicitChoice?: {
    readonly providerId: WorkstationProviderId; readonly modelId: string
  } | null }): Promise<SoloModelAdviceView>;
  /** Read-only complementary role plan. Unknown capability requires manual model review. */
  teamModelAdvice(input: { readonly projectId: string | null;
    readonly overallPrompt: string }): Promise<TeamModelAdviceView>;
  /** Creates no policy change and starts no work; null means measured evidence is insufficient. */
  modelAdaptationPropose(input: { readonly projectId: string }): Promise<ModelAdaptationProposalView | null>;
  /** An explicit owner review echo; only future advice weights change after fresh checks. */
  modelAdaptationAccept(input: { readonly projectId: string; readonly proposalId: string;
    readonly expectedProposalSha256: string; readonly confirmed: true }): Promise<StoredModelProjectPreferencesView>;

  /**
   * Who has messaged the bot and is not obeyed, and saying one of them is him.
   *
   * The only way a fresh install ever gains its first obeyed chat: it starts
   * obeying nobody, and nothing else on this Mac knows what his chat id is.
   */
  phoneKnocks(): Promise<{
    readonly knocks: readonly {
      readonly chatId: string;
      readonly from: string;
      readonly at: number;
    }[];
    readonly pairedChatId: string | null;
    /** False when this build has nowhere to write the list. */
    readonly canPair: boolean;
  }>;
  phonePair(input: {
    readonly chatId: string;
    /** Absent means pair. False takes a chat back off the list. */
    readonly pair?: boolean;
  }): Promise<{ readonly paired: boolean; readonly said: string }>;

  // Watching one agent work, step by step. Start, look, stop.
  agentPrepare(input: unknown): Promise<{ readonly token: string; readonly expiresAt: number;
    readonly reviews: readonly Omit<WorkstationReview, "token">[] }>;
  agentStart(input: { readonly token: string }): Promise<{ readonly runId: string }>;
  agentPoll(input: { readonly runId: string }): Promise<AgentPollView>;
  agentStop(input: { readonly runId: string }): Promise<{ readonly state: AgentRunStateView }>;

  // Explicit Compare: review every chosen call before the one-use parent starts.
  dispatchPrepare(input: {
    readonly caseId: string;
    readonly brief: string;
    readonly selections: readonly { readonly providerId: string; readonly modelId: string }[];
    readonly sourceTurnIds?: readonly string[];
  }): Promise<{ readonly token: string; readonly expiresAt: number;
    readonly reviews: readonly Omit<WorkstationReview, "token">[] }>;
  dispatchStart(input: { readonly token: string }): Promise<{ readonly runId: string }>;
  dispatchPoll(input: { readonly runId: string }): Promise<DispatchBoardView>;
  dispatchStop(input: { readonly runId: string; readonly providerId?: string }): Promise<DispatchBoardView>;

  // Carrying on from a phone. Status reports what is listening, never what was asked for.
  pairingStatus(): Promise<PairingStatusView>;
  pairingStart(input: { readonly reachable: "this-mac" | "wifi" }): Promise<PairingStatusView>;
  pairingStop(): Promise<PairingStatusView>;
  pairingHandoverCandidates(): Promise<{ readonly principals: readonly string[];
    readonly runs: readonly { readonly principalId: string; readonly caseId: string;
      readonly operationId: string }[] }>;
  pairingHandoverPrepare(input: { readonly caseId: string; readonly operationId: string;
    readonly oldPrincipalId: string; readonly newPrincipalId: string }): Promise<{
      readonly token: string; readonly expiresAt: number; readonly generation: number;
      readonly caseId: string; readonly operationId: string;
      readonly oldPrincipalId: string; readonly newPrincipalId: string }>;
  pairingHandoverApprove(input: { readonly token: string }): Promise<{
    readonly caseId: string; readonly operationId: string;
    readonly oldPrincipalId: string; readonly newPrincipalId: string }>;

  // Speaking instead of typing. Nothing recorded leaves this Mac.
  dictationStatus(): Promise<{ readonly ready: boolean; readonly detail: string }>;
  dictationWrite(input: { readonly wavBase64: string }): Promise<
    | { readonly status: "transcribed"; readonly text: string; readonly durationMs: number }
    | { readonly status: "unavailable"; readonly reason: string }
  >;
  dictationStop(): Promise<{ readonly status: "stopped" }>;

  // Reading a file he picked. Previewing only; adding it stays a separate step.
  pickDocument(input: { readonly caseId: string }): Promise<DocumentPickView>;
  documentFormats(): Promise<{ readonly formats: readonly { readonly id: string; readonly label: string; readonly detail: string }[] }>;

  // Finding work by meaning when a local model allows it, and by words when not.
  semanticStatus(): Promise<{ readonly ready: boolean; readonly detail: string; readonly indexed: number }>;
  semanticSearch(input: { readonly query: string }): Promise<SemanticSearchView>;

  // Turning a finished output into a file. Preview never writes.
  publishPreview(input: { readonly caseId: string; readonly format: PublishFormatView }): Promise<PublishPreviewView>;
  publishWrite(input: { readonly caseId: string; readonly format: PublishFormatView }): Promise<PublishPreviewView>;

  // Several bots, one request, each taking a part.
  crewPrepare(input: unknown): Promise<{ readonly token: string; readonly expiresAt: number;
    readonly reviews: readonly (Omit<WorkstationReview, "token"> & {
      readonly partId: string;
      readonly title: string;
      readonly role?: string;
      readonly work: string;
      readonly expectedOutput?: string;
      readonly integrationOwner?: string;
      readonly dependsOn: readonly string[];
    })[] }>;
  crewStart(input: { readonly token: string }): Promise<{ readonly runId: string }>;
  crewPoll(input: { readonly runId: string }): Promise<CrewRunPollView>;
  crewStop(input: { readonly runId: string; readonly partId?: string }): Promise<CrewRunPollView>;

  // What his phone may do, and telling him something happened.
  telegramWorkStatus(): Promise<{
    readonly linked: boolean;
    readonly chatLinked: boolean;
    readonly detail: string;
    readonly mayDo: readonly string[];
    readonly mayNotDo: readonly string[];
  }>;
  telegramNotify(input: { readonly text: string }): Promise<{ readonly sent: boolean }>;

  // The agents he writes, and the ones that came with the app.
  agentsList(): Promise<{
    readonly agents: readonly {
      readonly id: string;
      readonly origin: "bundled" | "user";
      readonly markdown: string;
      readonly updatedAt: number;
      readonly revision: string;
    }[];
  }>;
  agentSave(input: { readonly id: string; readonly markdown: string }): Promise<{ readonly id: string; readonly updatedAt: number; readonly revision: string }>;
  agentDelete(input: { readonly id: string }): Promise<{ readonly deleted: boolean }>;
}

export interface CrewPartInput {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly dependsOn: readonly string[];
  /** The second-round prompt, composed before the run starts. Absent means no second round. */
  readonly refinePrompt?: string;
}

export type CrewPartStateView =
  | "waiting" | "claimed" | "working" | "answered" | "refining" | "done" | "failed" | "stopped" | "interrupted";

/** Native result or marked transport failure, with cancellation tracked separately. */
export interface NativeAskOutcomeView {
  readonly text: string;
  readonly sessionId: string | null;
  readonly finishReason: "completed" | "denied" | "stopped" | "failed";
  readonly requestedModelId: string | null;
  readonly cancellationRequested: boolean;
  readonly resultSource: "worker" | "transport";
  readonly modelId?: string;
  readonly reportedModelId?: string;
  readonly detail?: string;
}

export interface CrewPartPollView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartStateView;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly draftTurnId?: string | null;
  readonly outcome?: NativeAskOutcomeView | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunPollView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartPollView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed" | "interrupted";
  readonly headline: string;
  readonly canStop: boolean;
}

export type AgentRunStateView =
  | "planning" | "awaiting-approval" | "running" | "stopping" | "done" | "stopped" | "failed" | "interrupted";

/** What the main process observed. The renderer decides how it reads. */
export interface AgentStepViewShape {
  readonly index: number;
  readonly thought: string;
  readonly toolName: string | null;
  readonly toolArgs: string;
  readonly toolResult: string;
  readonly toolFailed: boolean;
  readonly answer: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface AgentPollView {
  readonly state: AgentRunStateView;
  readonly steps: readonly AgentStepViewShape[];
  readonly answer?: string;
  readonly failure?: string;
  readonly nativeOutcomes?: readonly NativeAskOutcomeView[];
}

export type LaneStateView =
  | "queued" | "awaiting-approval" | "working" | "answered" | "stopped" | "failed" | "interrupted" | "unavailable";

export interface DispatchLaneView {
  readonly providerId: string;
  readonly label: string;
  readonly state: LaneStateView;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly draftTurnId?: string | null;
  readonly outcome?: NativeAskOutcomeView | null;
  readonly chars: number;
  readonly canStop: boolean;
}

export interface DispatchBoardView {
  readonly runId: string;
  readonly caseId: string;
  readonly brief: string;
  readonly lanes: readonly DispatchLaneView[];
  readonly headline: string;
  readonly working: number;
  readonly answered: number;
  readonly done: boolean;
}

export type PairingStatusView =
  | { readonly state: "off" }
  | { readonly state: "starting" }
  | {
      readonly state: "listening";
      readonly url: string;
      readonly pin: string;
      readonly expiresAt: number;
      readonly onThisMacOnly: boolean;
    }
  | { readonly state: "failed"; readonly reason: string };

export type DocumentPickView =
  | {
      readonly status: "parsed";
      readonly name: string;
      readonly format: string;
      readonly words: number;
      readonly preview: string;
      readonly headings: readonly { readonly level: number; readonly text: string }[];
      readonly warnings: readonly string[];
    }
  | { readonly status: "cancelled" }
  | { readonly status: "unreadable"; readonly reason: string };

export interface SemanticSearchView {
  readonly hits: readonly {
    readonly turnId: string;
    readonly caseId: string;
    readonly caseTitle: string;
    readonly snippet: string;
    readonly score: number;
    readonly why: string;
  }[];
  readonly mode: "meaning" | "words";
  readonly summary: string;
}

export type PublishFormatView = "html" | "markdown" | "slides";

export interface PublishPreviewView {
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly files: readonly { readonly relativePath: string; readonly bytes: number }[];
  readonly writtenTo?: string;
}
