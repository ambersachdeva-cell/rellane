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
  readonly state: "planning" | "working" | "writing" | "done" | "stopped" | "failed";
  readonly steps: readonly ResearchStepView[];
  readonly sourcesRead: number;
  readonly notesKept: number;
  readonly headline: string;
  readonly answer: string | null;
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

export interface WorkstationSurfaceBridge {
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
  researchStart(input: {
    readonly caseId: string;
    readonly question: string;
    /** Addresses he named himself. Anything else is found by following links. */
    readonly urls?: readonly string[];
    readonly depth: "quick" | "thorough";
  }): Promise<{ readonly runId: string }>;
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
  agentStart(input: { readonly caseId: string; readonly goal: string; readonly sourceTurnIds?: readonly string[] }): Promise<{ readonly runId: string }>;
  agentPoll(input: { readonly runId: string }): Promise<AgentPollView>;
  agentStop(input: { readonly runId: string }): Promise<{ readonly state: AgentRunStateView }>;

  // Several subscriptions on one brief, at once.
  dispatchStart(input: {
    readonly caseId: string;
    readonly brief: string;
    readonly providerIds: readonly string[];
    readonly sourceTurnIds?: readonly string[];
  }): Promise<{ readonly runId: string }>;
  dispatchPoll(input: { readonly runId: string }): Promise<DispatchBoardView>;
  dispatchStop(input: { readonly runId: string; readonly providerId?: string }): Promise<DispatchBoardView>;

  // Carrying on from a phone. Status reports what is listening, never what was asked for.
  pairingStatus(): Promise<PairingStatusView>;
  pairingStart(input: { readonly reachable: "this-mac" | "wifi" }): Promise<PairingStatusView>;
  pairingStop(): Promise<PairingStatusView>;

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
  crewStart(input: {
    readonly caseId: string;
    readonly request: string;
    readonly parts: readonly CrewPartInput[];
    readonly sourceTurnIds?: readonly string[];
  }): Promise<{ readonly runId: string }>;
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
      readonly origin: "bundled" | "mine";
      readonly markdown: string;
      readonly updatedAt: number;
    }[];
  }>;
  agentSave(input: { readonly id: string; readonly markdown: string }): Promise<{ readonly id: string; readonly updatedAt: number }>;
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
  | "waiting" | "claimed" | "working" | "answered" | "refining" | "done" | "failed" | "stopped";

export interface CrewPartPollView {
  readonly id: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly state: CrewPartStateView;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
  readonly refinedFrom: readonly string[];
  readonly canStop: boolean;
}

export interface CrewRunPollView {
  readonly runId: string;
  readonly caseId: string;
  readonly request: string;
  readonly parts: readonly CrewPartPollView[];
  readonly round: "splitting" | "working" | "reading-each-other" | "done" | "stopped" | "failed";
  readonly headline: string;
  readonly canStop: boolean;
}

export type AgentRunStateView =
  | "planning" | "awaiting-approval" | "running" | "stopping" | "done" | "stopped" | "failed";

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
}

export type LaneStateView =
  | "queued" | "awaiting-approval" | "working" | "answered" | "stopped" | "failed" | "unavailable";

export interface DispatchLaneView {
  readonly providerId: string;
  readonly label: string;
  readonly state: LaneStateView;
  readonly line: string;
  readonly elapsed: string;
  readonly answerTurnId: string | null;
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

