/**
 * The workstation's channels, and the wiring behind them.
 *
 * This file is where the host meets the world: Electron's picker, the book, the
 * durable store and the four native adapters. It holds no policy of its own —
 * every decision about what may run lives in `service.ts`, so there is one
 * place to read rather than a check here and a check there that could disagree.
 *
 * Two properties are enforced at this boundary and nowhere else. Every handler
 * asserts the trusted sender exactly as the rest of the bridge does, and every
 * handler resolves the caller to an *owner* — a key that changes when the
 * document navigates or the window is destroyed. A review, a picked folder and a
 * running session all belong to one owner, so a reloaded renderer inherits none
 * of them.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  desktopCapturer,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from "electron";
import {
  AutomationPendingHostReviewInputSchema,
  WorkstationDecideInputSchema,
  WorkstationPrepareInputSchema,
  WorkstationRevealWorkspaceInputSchema,
  WorkstationStartInputSchema,
  WorkstationStateInputSchema,
  WorkstationStopInputSchema,
  type AgentRunResult,
  type AutomationHostReconcileTerminalResult,
  type AutomationPendingHostReviewInput,
  type WorkstationContextSuggestion,
  type WorkstationProviderId,
  type WorkstationReview,
  type WorkstationWorkspace
} from "@cadrane/contracts";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { appendTurn, openCase, readCase, turnsFor } from "../book/cases.js";
import { createCodexWorker } from "./codex.js";
import { createClaudeWorker } from "./claude.js";
import { createGeminiWorker } from "./gemini.js";
import { discoverWorkstationProviders } from "./providers.js";
import { buildWorkstationContext } from "./context.js";
import { approvedProjectConstraints, approvedProjectFindings, projectMemoryEpoch } from "./project-memory-book.js";
import { projectForWork } from "./projects.js";
import { saveContextSnapshot, readContextSnapshot, markContextDispatchAttempt } from "./context-snapshot-store.js";
import { extractWorkstationArtifacts } from "./artifacts.js";
import { WORKSTATION_ROUTINES } from "./routines.js";
import { hermesSkillRoutines } from "./upstream-skills.js";
import {
  createNativeToolSession,
  nativeToolSkillIds,
  NATIVE_TOOL_DEFINITIONS
} from "./native-tools.js";
import { checkHermesCitations } from "./hermes-citations.js";
import {
  latestSessionReceipt,
  recoverInterruptedSessions,
  saveSessionReceipt,
  WORKSTATION_SESSION_SEAT
} from "./store.js";
import {
  WorkstationHost,
  workspaceFolderName,
  type WorkstationGraphHostDeps,
  type WorkstationGraphReview
} from "./service.js";
import { LocalCaseRunScope, type LocalCaseRunInput, type LocalAgentRunInput,
  type LocalSuggestionRunInput } from "./local-case-run-scope.js";
import { LocalBriefDraftScope, type LocalBriefDraftInput, type LocalBriefHistory } from "./local-brief-draft-scope.js";
import type { DraftResult } from "../agents/draft.js";
import { type NativeAskOutcome, type NativeWorker, type NativeWorkerOptions } from "./types.js";
import { installWorkstationContinuity } from "./continuity-ipc.js";
import {
  defaultHermesCitationsRuntimeOptions,
  installWorkstationCitations
} from "./hermes-citations-ipc.js";
import { installWorkstationDocumentImport } from "./document-import-ipc.js";
import { installWorkstationSpeech } from "./speech-ipc.js";
import { installWorkstationMacActions } from "./mac-actions-ipc.js";
import { installWorkstationWebRead } from "./web-read-ipc.js";
import { installWorkstationFiles } from "./workspace-files-ipc.js";
import { installWorkstationTable } from "./table-ipc.js";
import { installWorkstationBookSearch } from "./book-search-ipc.js";
import { installWorkstationHandover } from "./handover-ipc.js";
import { installWorkstationCapture } from "./capture-ipc.js";
import { installWorkstationPaste } from "./paste-ipc.js";
import { installRemotePairing } from "./remote-pairing-ipc.js";
import { installDocumentParse } from "./document-parse-ipc.js";
import { installDictation } from "./dictation-ipc.js";
import { installSemanticSearch } from "./book-semantic-ipc.js";
import { installPublish } from "./publish-ipc.js";
import { installReviewedDispatchRun } from "./dispatch-run-ipc.js";
import { recoveredCompareBoard, saveCompareChild, saveCompareParent } from "./compare-run-store.js";
import { installReviewedAgentStream, WORKSTATION_AGENT_GOAL_LIMIT, type WorkstationAgentPollResult } from "./agent-stream-ipc.js";
import { installReviewedCrewRun, type CrewRunView } from "./crew-run-ipc.js";
import { installAgentStore, loadStoredAgentContract } from "./agent-store-ipc.js";
import { exactPhoneReview, installTelegramWork, sanitiseReply } from "./telegram-work-ipc.js";
import { installReviewedResearchRun, type ResearchRunView } from "./research-run-ipc.js";
import { recoverReviewedParent, saveReviewedChild, saveReviewedParent, type RecoveredReviewedParent } from "./reviewed-parent-store.js";
import { installProjectMemory } from "./project-memory-ipc.js";
import { installProjectMemoryConflicts } from "./project-memory-conflict-ipc.js";
import { installFileHistory } from "./file-history-ipc.js";
import { safeRestoreFile } from "./file-restore-writer.js";
import { createScheduledHostAdmission } from "./scheduled-host-admission.js";
import { installScheduleIpc } from "./schedule-ipc.js";
import { createScheduleQueuePump } from "./schedule-queue-pump.js";
import { installWatch } from "./watch-runner-ipc.js";
import { installUsage, WORKSTATION_USAGE_RECEIPT_CAP } from "./usage-ipc.js";
import { installModelOutcomeEvidence } from "./model-outcome-evidence-ipc.js";
import { installModelPreferencesIpc } from "./model-preferences-ipc.js";
import { installModelAdviceIpc } from "./model-advice-ipc.js";
import { readBefore, readContentBefore, saveBefore, snapshotFolder } from "./change-store.js";
import { AnnouncedCalls, describeCall, waitingCalls } from "./phone-approvals.js";
import { forgetSeen, lastSeen, loadWatches, remember, saveWatches } from "./watch-store.js";
import { readPageSource } from "./web-read.js";
import { listWorkspace, previewFile } from "./workspace-files.js";
import { listHermesSkills, readHermesSkill } from "./upstream-skills.js";
import { artifactVersions } from "../workroom/artifacts.js";
import { createRemoteDispatchServer } from "./remote-dispatch-server.js";
import { installRemoteHostBridge } from "./remote-host-bridge.js";
import { parseDocument } from "./universal-parser.js";
import { transcribeAudio } from "./whisper-dictation.js";
import { installSelfCheck } from "./self-check-ipc.js";
import {
  exportPortableOperatorWorkspace,
  verifyPortableOperatorWorkspaceDigest,
  projectOperatorWorkspaceView,
  PortableOperatorWorkspaceStore,
  type PortableOperatorWorkspaceDefinition
} from "./portable-operator-workspace.js";
import {
  preflightWorkspaceRecovery,
  captureWorkspace,
  importWorkspace,
  reopenRecoveredWorkspace,
  type CaptureWorkspaceOptions,
  type ImportWorkspaceOptions
} from "./workspace-recovery-coordinator.js";
import { createTrustedHostQuiescenceCoordinator } from "./recovery-quiescence-host-bridge.js";

/**
 * The largest file this bridge will read whole in order to diff it.
 *
 * A diff has to see all of a file to be honest about it, so the read refuses
 * past this rather than truncating: half a file produces a diff that claims
 * lines were removed when they were only never read.
 */
const MAX_DIFF_BYTES = 4_194_304;

/** One search reads a bounded slice of the book, newest first. */
const MAX_SEARCHABLE_TURNS = 20_000;

/**
 * Asking for tools is opting in, in words, every time.
 *
 * Not a default: most of what anyone texts is a question, and starting a
 * file-touching session for "what did we decide about Acme" would be answering
 * a different request than the one he sent.
 */
const WANTS_TOOLS = /\b(?:with|using)\s+tools\b|\btools?\s+on\b|\b(?:edit|change|fix|write|update|rename|move|delete|create)\s+(?:the\s+|my\s+|a\s+)?(?:files?|folder|code|repo)\b|\bwork\s+on\s+(?:the\s+|my\s+)?(?:files?|folder|code|repo)\b/i;

/**
 * The phone, as one identity the session pool can recognise.
 *
 * Runs are owned by whoever started them, and a window's owner dies with the
 * window. The phone is neither, so it gets one object that lasts as long as the
 * app does — otherwise a session started from a phone could never be stopped
 * from the same phone.
 */
const PHONE_OWNER: object = Object.freeze({ seat: "phone" });

const PhonePairInputSchema = z
  .object({
    chatId: z.string().min(1).max(64),
    pair: z.boolean().optional().default(true)
  })
  .strict();

/** Enough rows to recognise himself among; not enough to be filled up with. */
const MAX_KNOCKS = 8;

/** A title a person would recognise in a list, from the words he sent. */
function titleFromRequest(request: string): string {
  const firstLine = request.trim().split("\n")[0] ?? request.trim();
  const trimmed = firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
  return trimmed.length > 0 ? trimmed : "From your phone";
}

export const WORKSTATION_GRAPH_PREPARE_CHANNEL =
  "cadrane:v4:workstation-graph-prepare" as const;
export const WORKSTATION_GRAPH_START_CHANNEL =
  "cadrane:v4:workstation-graph-start" as const;
export const WORKSTATION_GRAPH_STOP_CHANNEL =
  "cadrane:v4:workstation-graph-stop" as const;
export const WORKSTATION_GRAPH_RECONCILE_CHANNEL =
  "cadrane:v4:workstation-graph-reconcile" as const;
export const AUTOMATION_WORKFLOW_SAVE_REVIEW_BOUND_CHANNEL =
  "cadrane:v4:automation-workflow-save-review-bound" as const;

export interface WorkstationIpcOptions {
  /**
   * Puts one Telegram chat on the list this Mac obeys.
   *
   * Absent when there is no settings store to write to, and then the phone
   * screen says so rather than offering a button that does nothing.
   */
  readonly telegramAddContact?: (chat: { readonly chatId: string; readonly label: string }) => Promise<void>;
  /** Takes one back off it. */
  readonly telegramRemoveContact?: (chatId: string) => Promise<void>;
  readonly getWindow: () => BrowserWindow | null;
  /** The bridge's own sender check, passed in so there is one implementation. */
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly book: () => DatabaseSync;
  readonly userData: () => string;
  readonly graph?: WorkstationGraphHostDeps;
  /**
   * The Telegram chats this Mac is willing to obey, from the owner's own
   * contact list. Empty means it obeys nobody, which is the state a fresh
   * install is in and the one a stranger always gets.
   */
  readonly telegramContacts?: () => Promise<readonly string[]>;
  /** Sends one plain message back to a chat. Absent when Telegram is off. */
  readonly telegramSend?: (chatId: string, text: string) => Promise<void>;
}

export interface WorkstationIpc {
  localBriefHistory(event: IpcMainInvokeEvent): LocalBriefHistory;
  forgetLocalBriefHistory(event: IpcMainInvokeEvent, reviewSha256: string): { removed: number };
  runLocalBrief(event: IpcMainInvokeEvent,
    input: Omit<LocalBriefDraftInput, "owner" | "workspacePath">): Promise<DraftResult>;
  /** Refuses to close or erase a case with a session still working in it. */
  assertIdle(caseId: string): void;
  runLocalCase(event: IpcMainInvokeEvent, input: Omit<LocalCaseRunInput, "owner" | "workspacePath">): Promise<void>;
  localCaseState(event: IpcMainInvokeEvent, caseId: string): { operationId: string; stopping: boolean } | null;
  stopLocalCase(event: IpcMainInvokeEvent, caseId: string, operationId: string): Promise<{ stopped: boolean }>;
  runLocalAgent(event: IpcMainInvokeEvent,
    input: Omit<LocalAgentRunInput, "owner" | "workspacePath">): Promise<AgentRunResult>;
  stopLocalAgent(event: IpcMainInvokeEvent, agentId: string): { stopped: boolean };
  runLocalSuggestion(event: IpcMainInvokeEvent,
    input: Omit<LocalSuggestionRunInput, "owner" | "workspacePath">): Promise<WorkstationContextSuggestion>;
  prepareGraphNode(event: IpcMainInvokeEvent,
    input: AutomationPendingHostReviewInput): Promise<WorkstationGraphReview>;
  startGraphNode(event: IpcMainInvokeEvent,
    token: string): Promise<AutomationHostReconcileTerminalResult>;
  stopGraphNode(event: IpcMainInvokeEvent,
    caseId: string,
    operationId: string): Promise<{ stopped: boolean }>;
  reconcileGraphHostRuns(event?: IpcMainInvokeEvent): Promise<number>;
  /** Safe stop and receipts, for a quit or a reload. */
  shutdown(): Promise<void>;
  /**
   * One message from his phone, answered.
   *
   * Handed upward because the messages that matter arrive at the poller in the
   * main process, not at a window. Without this the whole phone surface —
   * status, stop, the bots, staging — was registered, tested, and reachable
   * only by a renderer that never called it.
   */
  answerPhone(chatId: string, text: string, from?: string): Promise<{ readonly replied: string }>;
}

/**
 * One adapter per provider, chosen from the reviewed provider id.
 *
 * A switch rather than a lookup table keyed by a string from the renderer: the
 * id has already been through the schema and the provider list by the time it
 * arrives, and this way a new provider cannot be added without the compiler
 * asking what runs it.
 */
function createWorker(providerId: WorkstationProviderId, options: NativeWorkerOptions): NativeWorker {
  switch (providerId) {
    case "codex":
      return createCodexWorker(options);
    case "claude":
      return createClaudeWorker(options);
    case "gemini1":
    case "gemini2":
    case "gemini3":
      return createGeminiWorker(options);
  }
}

export function installWorkstationIpc(options: WorkstationIpcOptions): WorkstationIpc {
  const localCaseScope = new LocalCaseRunScope();
  const localBriefScope = new LocalBriefDraftScope();
  let reviewedDispatch: ReturnType<typeof installReviewedDispatchRun> | null = null;
  let reviewedAgent: ReturnType<typeof installReviewedAgentStream> | null = null;
  let reviewedCrew: ReturnType<typeof installReviewedCrewRun> | null = null;
  let reviewedResearch: ReturnType<typeof installReviewedResearchRun> | null = null;
  let scheduled: ReturnType<typeof installScheduleIpc> | null = null;
  const owners = createAgentSourceOwners((owner) => {
    void reviewedDispatch?.cancelOwner(owner);
    void reviewedAgent?.cancelOwner(owner);
    void reviewedCrew?.cancelOwner(owner);
    void reviewedResearch?.cancelOwner(owner);
    scheduled?.cancelOwner(owner);
    host.invalidate(owner);
  });

  /**
   * Who has messaged the bot and is not obeyed yet.
   *
   * Held in memory rather than written down: it is a list of strangers, and the
   * only thing ever done with it is showing him one row to recognise. It starts
   * empty on every launch, which is the right amount of memory for it.
   */
  const knocks = new Map<string, { readonly chatId: string; readonly from: string; readonly at: number }>();

  const changeHistoryFolder = path.join(options.userData(), "workstation", "changes");
  const watchFolder = path.join(options.userData(), "workstation", "watches");
  const memoryFolder = path.join(options.userData(), "workstation", "memory");

  const host = new WorkstationHost({
    localCaseScope,
    localBriefScope,
    ...(options.graph ? { graph: options.graph } : {}),
    book: options.book,
    readCase,
    turnsFor,
    appendTurn,
    transaction: (db, work) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        work();
        db.exec("COMMIT");
      } catch (problem) {
        db.exec("ROLLBACK");
        throw problem;
      }
    },
    discoverProviders: discoverWorkstationProviders,
    buildContext: buildWorkstationContext,
    memory: {
      projectForCase: (db, caseId) => {
        const link = db.prepare("SELECT project_id AS projectId FROM workstation_project_link WHERE case_id = ?")
          .get(caseId) as { projectId: string } | undefined;
        const project = projectForWork(db, caseId);
        if (link && (!project || project.id !== link.projectId))
          throw new Error("This case's project record is unavailable. Nothing was sent.");
        return project?.id ?? null;
      },
      epoch: projectMemoryEpoch,
      constraints: approvedProjectConstraints,
      findings: approvedProjectFindings,
      saveSnapshot: saveContextSnapshot,
      readSnapshot: readContextSnapshot,
      markDispatchAttempt: markContextDispatchAttempt
    },
    createWorker,
    saveReceipt: saveSessionReceipt,
    latestReceipt: latestSessionReceipt,
    recoverInterrupted: recoverInterruptedSessions,
    routines: () => [...WORKSTATION_ROUTINES, ...hermesSkillRoutines()],
    extractArtifacts: extractWorkstationArtifacts,
    /**
     * The default workspace: one private folder per case, inside the app's own
     * data. Nothing is granted by it — it exists precisely so that a session
     * started without picking a folder cannot write anywhere that matters.
     */
    privateWorkspace: async (caseId: string): Promise<WorkstationWorkspace> => {
      const folder = path.join(
        options.userData(),
        "workstation",
        "workspaces",
        workspaceFolderName(caseId)
      );
      await mkdir(folder, { recursive: true, mode: 0o700 });
      return {
        // Not a uuid, and deliberately: `prepare` only accepts a uuid as a
        // workspace id, so this can be shown but never named back.
        id: `case:${caseId}`,
        label: "Private work folder",
        path: folder
      };
    },
    canonicalWorkspacePath: (workspacePath: string) => realpath(workspacePath),
    now: () => Date.now(),
    onRunStart: ({ caseId, operationId, workspacePath }) =>
      saveBefore(changeHistoryFolder, caseId, operationId, workspacePath),
    token: () => randomBytes(32).toString("hex"),
    newId: () => randomUUID(),
    /**
     * Reviewed native tools, reached the same way everything else here is.
     *
     * `names` is read off the definitions the adapter actually registers, so
     * the review cannot name one set of tools while the session offers another.
     * The citation checker is the same pinned child the renderer's own channel
     * runs, with the same dev-versus-packaged resolution, resolved per call so
     * a packaged build can never fall back to a development script path.
     */
    tools: {
      create: createNativeToolSession,
      names: () => NATIVE_TOOL_DEFINITIONS.map((definition) => definition.name),
      skillIds: nativeToolSkillIds,
      checkCitations: (input) =>
        checkHermesCitations({
          caseId: input.caseId,
          draft: input.draft,
          sources: input.sources,
          runtimeOptions: defaultHermesCitationsRuntimeOptions()
        })
    }
  });
  host.registerParentStop(async () => reviewedDispatch?.stopActive() ?? false);
  host.registerParentStop(async () => reviewedAgent?.stopActive() ?? false);
  host.registerParentStop(async () => reviewedCrew?.stopActive() ?? false);
  host.registerParentStop(async () => reviewedResearch?.stopActive() ?? false);
  host.registerParentStop(async () => scheduled?.stopActive() ?? false);

  const ownerFor = (event: IpcMainInvokeEvent): object =>
    owners(event.sender, event.senderFrame);

  /**
   * Settling what a crash left behind, on the first read that can.
   *
   * Not at install: the book may not be open yet. The host latches this after a
   * successful call, so the sweep that writes receipts runs exactly once.
   */
  const recoverOnce = (): void => {
    try {
      host.recover();
      localCaseScope.recover(options.book());
      localBriefScope.recover(options.book());
    } catch {
      // No book yet. The next read tries again.
    }
  };

  /** Schedules remain inert until the owner explicitly grants queueing and later Starts one reviewed occurrence. */
  const scheduleAdmission = createScheduledHostAdmission({ book: options.book, host });
  scheduled = installScheduleIpc({
    assertTrusted: options.assertTrusted,
    ownerFor,
    book: options.book,
    admission: scheduleAdmission,
    confirmOwnerGrant: async (event, review) => {
      options.assertTrusted(event);
      const window = options.getWindow();
      if (window === null) return false;
      const definition = review.definition;
      if (definition.instruction.length > 4000) {
        throw new Error("This schedule's instructions are too long for the native approval dialog. Shorten them before enabling it.");
      }
      const response = await dialog.showMessageBox(window, {
        type: "question",
        title: "Enable this schedule",
        message: "Allow this exact schedule to place due work in the queue?",
        detail: [
          `Case: ${definition.caseId}`,
          `Project: ${definition.projectId ?? "None"}`,
          `Provider and model: ${definition.providerId} / ${definition.modelId}`,
          `Time: ${definition.expression} in ${definition.timezone}`,
          `Grant expires: ${new Date(review.grantExpiresAt).toISOString()}`,
          "This approval queues work only. Each model run still needs its own reviewed Start.",
          "",
          "Exact instructions:",
          definition.instruction
        ].join("\n"),
        buttons: ["Cancel", "Enable queueing"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      return response.response === 1;
    }
  });
  let scheduleBookOpened = false;
  const schedulePump = createScheduleQueuePump({
    book: () => {
      const db = options.book();
      scheduleBookOpened = true;
      return db;
    },
    onError: (error) => {
      // A lazily unopened Book is expected during setup. Once it has opened,
      // a failed scan or admission must remain visible for diagnosis.
      if (scheduleBookOpened) console.error("Schedule queue admission paused:", error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.workstationProviders, async (event) => {
    options.assertTrusted(event);
    recoverOnce();
    return host.providers();
  });

  ipcMain.handle(IPC_CHANNELS.workstationRoutines, async (event) => {
    options.assertTrusted(event);
    return host.routines();
  });

  ipcMain.handle(IPC_CHANNELS.workstationChooseWorkspace, async (event) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);
    return host.chooseWorkspace(owner, async () => {
      const window = options.getWindow();
      if (window === null) return null;
      const picked = await dialog.showOpenDialog(window, {
        title: "Where should this session work?",
        // Says what is actually enforced. The earlier wording promised the
        // provider could not read outside this folder; what the sandbox
        // policies below really bound is writing and running, and a guarantee
        // nobody can keep is worse than a smaller one that is true.
        message:
          "Pick one folder to work in. Writes and commands are limited to this folder, the session starts with network access off, and anything else it wants to do is shown to you before it happens. It may still be able to read files elsewhere on this Mac. Choose nothing and the session works in a private folder of its own.",
        buttonLabel: "Work here",
        properties: ["openDirectory", "createDirectory"]
      });
      // The dialog was open for a while. The window it belongs to must still be
      // the trusted one, and still the same document.
      options.assertTrusted(event);
      if (ownerFor(event) !== owner)
        throw new Error("This window changed while the folder picker was open. Choose again.");
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    });
  });

  ipcMain.handle(IPC_CHANNELS.workstationPrepare, async (event, input: unknown) => {
    options.assertTrusted(event);
    recoverOnce();
    const request = WorkstationPrepareInputSchema.parse(input);
    return host.prepare(request, ownerFor(event));
  });

  ipcMain.handle(IPC_CHANNELS.workstationRevealWorkspace, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationRevealWorkspaceInputSchema.parse(input);
    const owner = ownerFor(event);
    const folder = await host.filesWorkspace(request.caseId, request.workspaceId, owner);
    const entry = await lstat(folder.path);
    if (!entry.isDirectory()) throw new Error("This work folder was moved or replaced. Choose its new location.");
    options.assertTrusted(event);
    if (ownerFor(event) !== owner) throw new Error("This window changed. Open the work again.");
    // Select in Finder, rather than opening an arbitrary target in its default
    // application. A model's answer cannot turn this into an executable opener.
    shell.showItemInFolder(folder.path);
    return folder;
  });

  ipcMain.handle(IPC_CHANNELS.workstationStart, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationStartInputSchema.parse(input);
    return host.start(request, ownerFor(event));
  });

  ipcMain.handle(IPC_CHANNELS.workstationState, async (event, input: unknown) => {
    options.assertTrusted(event);
    recoverOnce();
    const request = WorkstationStateInputSchema.parse(input);
    return host.state(request.caseId);
  });

  ipcMain.handle(IPC_CHANNELS.workstationRunning, async (event) => {
    options.assertTrusted(event);
    recoverOnce();
    return host.liveSnapshots();
  });

  ipcMain.handle(IPC_CHANNELS.workstationStop, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationStopInputSchema.parse(input);
    return host.stop(request.caseId, request.operationId, ownerFor(event));
  });

  ipcMain.handle(IPC_CHANNELS.workstationDecide, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationDecideInputSchema.parse(input);
    return host.decide(request.operationId, request.permissionId, request.allow, ownerFor(event));
  });

  ipcMain.handle(WORKSTATION_GRAPH_PREPARE_CHANNEL, async (event, input: unknown) => {
    options.assertTrusted(event);
    recoverOnce();
    localCaseScope.recover(options.book());
    const request = AutomationPendingHostReviewInputSchema.parse(input);
    return host.prepareGraphNode(request, ownerFor(event));
  });

  ipcMain.handle(WORKSTATION_GRAPH_START_CHANNEL, async (event, input: unknown) => {
    options.assertTrusted(event);
    recoverOnce();
    localCaseScope.recover(options.book());
    const request = WorkstationStartInputSchema.parse(input);
    return host.startGraphNode(request, ownerFor(event));
  });

  ipcMain.handle(WORKSTATION_GRAPH_STOP_CHANNEL, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationStopInputSchema.parse(input);
    return host.stopGraphNode(request.caseId, request.operationId, ownerFor(event));
  });

  ipcMain.handle(WORKSTATION_GRAPH_RECONCILE_CHANNEL, async (event) => {
    options.assertTrusted(event);
    return host.reconcileGraphHostRuns();
  });

  // Quitting is not a crash and must not read like one. The hook itself belongs
  // in the app's own ordered shutdown — before the book closes, or the
  // interrupted receipt has nowhere to land — so `shutdown` is handed back
  // rather than registered on `app` from in here.
  installWorkstationContinuity({ book: options.book, assertTrusted: options.assertTrusted, assertIdle: caseId => host.assertIdle(caseId) });
  installWorkstationCitations({ book: options.book, assertTrusted: options.assertTrusted, assertIdle: caseId => host.assertIdle(caseId) });
  /**
   * The step-by-step agent is deliberately NOT installed here.
   *
   * Its channel ran a loop whose `executeModel` was a script: with no model
   * passed in it returned hand-written `<thought>` and `<tool_call>` text chosen
   * by a step counter, and wrote the result into the owner's book as a turn
   * seated "Autonomous Thinker", followed by a receipt claiming a reasoning loop
   * had completed. Nothing had reasoned. Fabricated content in the record is
   * worse than a missing feature, and the record is the thing this product is
   * for. It returns through `agent-stream-ipc`, against a real model, reviewed
   * before it starts and stoppable while it runs.
   */
  // Two capabilities that existed as tested modules with nothing able to reach
  // them. Both are one-at-a-time, trusted-sender-only, and neither touches the
  // network: the converter runs a pinned local child, and the voice runs the
  // binary already vendored in this bundle.
  installWorkstationDocumentImport({ assertTrusted: options.assertTrusted });
  installWorkstationSpeech({ assertTrusted: options.assertTrusted, userData: options.userData });
  installSelfCheck({
    assertTrusted: options.assertTrusted,
    probeBook: async () => {
      try {
        const db = options.book();
        const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count?: number } | undefined;
        return { open: true, tables: typeof row?.count === "number" ? row.count : null };
      } catch {
        return { open: false, tables: null };
      }
    },
    probeProviders: async () => {
      const providers = await host.providers();
      return providers.map((p) => ({
        id: p.id,
        label: p.label,
        detected: p.state === "detected",
        detail: p.detail ?? p.state
      }));
    },
    probeLocalModel: async () => ({ ready: true, detail: "Ready" }),
    probeFolders: async () => ({ granted: 0, lost: [] }),
    probeTelegram: async () => {
      const contacts = options.telegramContacts ? await options.telegramContacts().catch(() => []) : [];
      return { linked: Boolean(options.telegramSend), chatPaired: contacts.length > 0 };
    },
    probeKeychain: () => true,
    probeDisk: async () => null,
    lastBackupAt: async () => null
  });

  const portableWorkspaceStore = new PortableOperatorWorkspaceStore();
  ipcMain.handle(IPC_CHANNELS.workstationPortableWorkspace, async (event, input: unknown) => {
    options.assertTrusted(event);
    const cmd = z.object({ action: z.string() }).passthrough().parse(input);
    switch (cmd.action) {
      case "export":
        return exportPortableOperatorWorkspace(cmd.input);
      case "verify":
        return { valid: verifyPortableOperatorWorkspaceDigest(cmd.definition as PortableOperatorWorkspaceDefinition) };
      case "view":
        return projectOperatorWorkspaceView(
          cmd.definition as PortableOperatorWorkspaceDefinition,
          (cmd.mode === "customer" ? "customer" : "developer")
        );
      case "import":
        return portableWorkspaceStore.importWorkspace(cmd.definition as PortableOperatorWorkspaceDefinition);
      case "edit-output":
        return portableWorkspaceStore.editOutput(
          String(cmd.workspaceId ?? ""),
          String(cmd.outputId ?? ""),
          String(cmd.nextContent ?? "")
        );
      case "update":
        return portableWorkspaceStore.updateWorkspace(
          String(cmd.workspaceId ?? ""),
          cmd.nextDefinition as PortableOperatorWorkspaceDefinition
        );
      case "rollback":
        return portableWorkspaceStore.rollbackWorkspace(String(cmd.workspaceId ?? ""));
      default:
        throw new Error(`Unsupported portable workspace action: ${cmd.action}`);
    }
  });

  const recoveryQuiescence = createTrustedHostQuiescenceCoordinator();
  ipcMain.handle(IPC_CHANNELS.workstationRecovery, async (event, input: unknown) => {
    options.assertTrusted(event);
    const cmd = z.object({ action: z.string() }).passthrough().parse(input);
    switch (cmd.action) {
      case "preflight":
        return preflightWorkspaceRecovery(recoveryQuiescence);
      case "capture":
        return captureWorkspace({
          ...(cmd.options as Omit<CaptureWorkspaceOptions, "quiescenceCoordinator">),
          quiescenceCoordinator: recoveryQuiescence
        });
      case "import":
        return importWorkspace(cmd.options as ImportWorkspaceOptions);
      case "reopen":
        return reopenRecoveredWorkspace(String(cmd.rootPath ?? ""));
      default:
        throw new Error(`Unsupported workspace recovery action: ${cmd.action}`);
    }
  });

  /**
   * The one folder a piece of work is allowed to touch.
   *
   * `filesWorkspace` already answers this for the file list — the folder the
   * last session actually ran in, or the private one when there has not been a
   * session yet — so everything below asks it rather than each deciding for
   * itself. A second opinion about where a case lives is a second boundary to
   * get wrong. A case that no longer exists has no folder; each caller refuses
   * in its own words rather than repeating a reason from in here.
   *
   * The owner argument goes unread: it is only consulted for a workspace the
   * renderer named, and none of these channels lets it name one.
   */
  let lastKnownOwnerChat: string | null = null;
  const refreshOwnerChat = (): void => {
    const read = options.telegramContacts;
    if (read === undefined) return;
    void read()
      .then((ids) => {
        lastKnownOwnerChat = ids[0] ?? null;
      })
      .catch(() => {
        // An unreadable contact list means this Mac obeys nobody, which is the
        // safe direction and the state a fresh install is already in.
        lastKnownOwnerChat = null;
      });
  };
  refreshOwnerChat();
  /**
   * Re-read, because the list changes after this runs.
   *
   * Reading once at startup froze the answer: on a fresh install the list is
   * empty, so the bot obeyed nobody — correctly — and then went on obeying
   * nobody after he added his own chat, until he restarted the app. He would
   * have followed the setup exactly and watched it do nothing.
   *
   * Unref'd so a quit never waits on it.
   */
  const ownerChatTimer = setInterval(refreshOwnerChat, 20_000);
  if (typeof ownerChatTimer.unref === "function") ownerChatTimer.unref();
  const noChosenWorkspace = Object.freeze({});
  const caseFolder = async (caseId: string): Promise<string | null> => {
    try {
      const workspace = await host.filesWorkspace(caseId, undefined, noChosenWorkspace);
      return workspace.path;
    } catch {
      return null;
    }
  };

  // Eight more capabilities that were written, tested and unreachable: nothing
  // in the app could call any of them. Each is trusted-sender-only, each
  // re-checks the window after its await, and each is confined to the folder
  // above. Only the web read leaves this machine, and only to an address the
  // owner typed, through the private-network guards in its own module.
  installWorkstationMacActions({
    assertTrusted: options.assertTrusted,
    allowedRootFor: caseFolder
  });

  installWorkstationWebRead({ assertTrusted: options.assertTrusted });

  installWorkstationFiles({
    assertTrusted: options.assertTrusted,
    workspaceFor: caseFolder,
    readFile: async (absolutePath: string): Promise<string> => {
      const info = await stat(absolutePath);
      if (info.size > MAX_DIFF_BYTES) {
        throw new Error("This file is too large to compare.");
      }
      return readFile(absolutePath, "utf8");
    }
  });

  installWorkstationTable({
    assertTrusted: options.assertTrusted,
    /**
     * A table is parsed out of a turn that is already in the room, never out of
     * text the renderer supplies. Reading it back through the book is what
     * keeps "parse this source" from becoming "parse whatever I hand you".
     */
    sourceText: async (caseId: string, sourceTurnId: string): Promise<string | null> => {
      const db = options.book();
      if (readCase(db, caseId) === null) return null;
      const turn = turnsFor(db, caseId).find((candidate) => candidate.id === sourceTurnId);
      return turn === undefined ? null : turn.body;
    }
  });

  installWorkstationBookSearch({
    assertTrusted: options.assertTrusted,
    book: options.book,
    /**
     * Closed work is excluded here as well as in the searcher. The searcher
     * filters because it must not show a closed room; this filters because
     * reading every turn ever written in order to throw most of them away is
     * how a search starts taking a second.
     */
    allTurns: (db) => {
      const rows = db
        .prepare(
          `SELECT t.id AS id, t.case_id AS caseId, c.title AS caseTitle,
                  t.seat AS seat, t.kind AS kind, t.body AS body, t.at AS at
             FROM case_turn t JOIN work_case c ON c.id = t.case_id
            WHERE c.closed_at IS NULL
            ORDER BY t.at DESC
            LIMIT ?`
        )
        .all(MAX_SEARCHABLE_TURNS) as readonly Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row["id"]),
        caseId: String(row["caseId"]),
        caseTitle: String(row["caseTitle"]),
        seat: String(row["seat"]),
        kind: String(row["kind"]),
        body: String(row["body"]),
        at: Number(row["at"])
      }));
    }
  });

  installWorkstationHandover({
    assertTrusted: options.assertTrusted,
    book: options.book,
    /**
     * The pack lands in the work's own folder. `folderName` arrives sanitised
     * from the planner; it is sanitised again here because the thing standing
     * between a client's name and a path traversal should not be a function in
     * another file.
     */
    writeFolder: async (caseId, folderName, files): Promise<string> => {
      const root = await caseFolder(caseId);
      if (root === null) throw new Error("This work has no folder to write into.");
      const safeName = workspaceFolderName(folderName);
      const folder = path.join(root, "Deliveries", safeName);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const destination = path.join(folder, file.relativePath);
        const relative = path.relative(folder, destination);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error("A pack file resolved outside the delivery folder.");
        }
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.contents, { encoding: "utf8", mode: 0o600 });
      }
      return folder;
    }
  });

  installWorkstationCapture({
    assertTrusted: options.assertTrusted,
    /**
     * Narrowed rather than cast: Electron accepts exactly two source types, and
     * anything else the caller asks for is dropped here instead of being
     * asserted away and handed to the platform.
     */
    listSources: (input) =>
      desktopCapturer.getSources({
        types: input.types.filter(
          (type): type is "screen" | "window" => type === "screen" || type === "window"
        ),
        thumbnailSize: { ...input.thumbnailSize }
      }),
    captureDir: async (caseId: string): Promise<string> => {
      const root = await caseFolder(caseId);
      if (root === null) throw new Error("This work has no folder to capture into.");
      return path.join(root, "Captures");
    }
  });

  installWorkstationPaste({ assertTrusted: options.assertTrusted });

  /**
   * Work asked for from his phone.
   *
   * He decided the phone may run what he could run, after being told plainly
   * that anyone holding the phone holds this. So `ask` starts a real session
   * rather than writing the words down and waiting.
   *
   * What it does not do is skip anything. A session with tools still asks
   * before every call that touches a file, and that question now reaches the
   * phone instead of only the Mac. Outbound still stages. There is still no
   * allow-everything. He moved who may answer the question; he did not remove
   * the question.
   *
   * Each request opens its own piece of work. The session pool refuses two
   * sessions in one folder, so sharing a case would make the second request of
   * an afternoon fail for a reason no one holding a phone could diagnose — and
   * a piece of work that finishes is this product's unit anyway.
   */
  const phoneApprovals = new Map<string, {
    readonly code: string; readonly operationId: string; readonly permissionId: string;
    readonly title: string; readonly detail: string; readonly expiresAt: number;
  }>();
  let phoneReview: { readonly code: string; readonly token: string; readonly caseId: string;
    readonly providerId: WorkstationProviderId; readonly modelId: string; readonly expiresAt: number } | null = null;
  const phone = installTelegramWork({
    assertTrusted: options.assertTrusted,
    ownerChatId: () => lastKnownOwnerChat,
    noteKnock: ({ chatId, from }) => {
      /**
       * Bounded, and newest wins. This list is fed by anyone who can find the
       * bot, so it must not be a way to fill this Mac's memory — and the only
       * entry that matters is the one he is about to recognise as his own.
       */
      knocks.delete(chatId);
      knocks.set(chatId, { chatId, from, at: Date.now() });
      while (knocks.size > MAX_KNOCKS) {
        const oldest = knocks.keys().next().value;
        if (oldest === undefined) break;
        knocks.delete(oldest);
      }
    },
    decidePending: async (allow: boolean, code: string) => {
      const waiting = waitingCalls(host.liveSnapshots());
      const match = [...phoneApprovals.values()].find((one) => one.code === code);
      if (match === undefined || Date.now() > match.expiresAt)
        return { decided: false, detail: "That approval code is missing or expired. Check the current request on your Mac." };
      const exact = waiting.find((one) => one.operationId === match.operationId &&
        one.permissionId === match.permissionId && one.title === match.title && one.detail === match.detail);
      if (exact === undefined)
        return { decided: false, detail: "That action changed or is no longer waiting. Nothing was approved." };
      await host.decideFromPhone(match.operationId, match.permissionId, allow);
      phoneApprovals.delete(`${match.operationId}:${match.permissionId}`);
      /**
       * Says which call it answered, not only that it answered. A bare "done"
       * after a delay is how the wrong thing gets approved without anybody
       * noticing which thing it was.
       */
      const rest = waiting.length - 1;
      const more = rest > 0
        ? ` ${rest === 1 ? "One more is" : `${rest} more are`} waiting.`
        : "";
      return {
        decided: true,
        detail: `${allow ? "Allowed once" : "Declined"}: ${exact.title}.${more}`
      };
    },
    startWork: async ({ request, selection }) => {
      phoneReview = null;
      if (selection === undefined || !/^(codex|claude|gemini[123])$/u.test(selection.providerId))
        return { started: false, detail: "Choose the exact connection and model: /ask codex/model-id: your request (or claude, gemini1, gemini2, gemini3)." };
      const selectedId = selection.providerId as WorkstationProviderId;
      const wantsTools = WANTS_TOOLS.test(request);
      const available = await host.providers();
      const provider = available.find((one) => one.id === selectedId);
      if (provider?.state !== "detected") {
        return {
          started: false,
          detail: "That connection was not detected on this Mac. Choose an available connection and model. Sign-in is checked only by a real attempt."
        };
      }
      if (wantsTools && provider.id !== "codex")
        return { started: false, detail: "File tools require an explicitly chosen Codex model. Nothing was switched or sent." };

      const packet = buildWorkstationContext({ prompt: request, sources: [] }).packet;

      const db = options.book();
      const title = titleFromRequest(request);
      let caseId: string;
      db.exec("BEGIN IMMEDIATE");
      try {
        caseId = openCase(db, { title, question: request });
        db.exec("COMMIT");
      } catch (problem) {
        db.exec("ROLLBACK");
        throw problem;
      }

      const review = await host.prepare(
        {
          caseId,
          providerId: provider.id,
          modelId: selection.modelId,
          prompt: request,
          sourceTurnIds: [],
          enableTools: wantsTools
        },
        PHONE_OWNER
      );
      if (review.contextPreview !== packet)
        return { started: false, detail: "The reviewed context changed. Nothing was sent; review this work on your Mac." };
      const code = (randomBytes(4).readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
      const ownerChat = lastKnownOwnerChat;
      const send = options.telegramSend;
      const reviewText = ownerChat === null ? null : exactPhoneReview(review, code, ownerChat);
      if (send === undefined || ownerChat === null || reviewText === null)
        return { started: false, detail: "This exact review cannot be delivered to your paired phone. Review and send it on your Mac." };
      await send(ownerChat, reviewText);
      if (lastKnownOwnerChat !== ownerChat || Date.now() > review.expiresAt)
        return { started: false, detail: "The paired phone or review changed during delivery. Nothing was started; ask again." };
      phoneReview = { code, token: review.token, caseId, providerId: provider.id,
        modelId: selection.modelId, expiresAt: review.expiresAt };
      return {
        started: false,
        detail: "The exact review and confirmation code were delivered to your paired phone. Nothing has run yet."
      };
    },
    confirmWork: async (code: string) => {
      const pending = phoneReview;
      if (pending === null || pending.code !== code || Date.now() > pending.expiresAt)
        return { started: false, detail: "That review code is missing or expired. Nothing was sent." };
      phoneReview = null;
      const started = await host.start({ token: pending.token }, PHONE_OWNER);
      if (started.caseId !== pending.caseId || started.providerId !== pending.providerId || started.modelId !== pending.modelId)
        throw new Error("The started session did not match the reviewed choice.");
      return { started: true, detail: `Started ${pending.providerId} / ${pending.modelId}. Say stop to request cancellation; check status for the final result.` };
    },
    status: async () => {
      const live = host.liveSnapshots();
      if (live.length === 0) return { headline: "Nothing is running.", lines: [] };
      return {
        headline: live.length === 1 ? "One session working." : `${live.length} sessions working.`,
        lines: live.slice(0, 4).map((snapshot) => snapshot.detail)
      };
    },
    stopAll: async () => {
      const result = await host.stopAllFromPhone();
      if (result.failures > 0)
        return { detail: `Stop could not be confirmed for ${result.failures} item${result.failures === 1 ? "" : "s"}. Check your Mac.` };
      if (result.sessions === 0 && result.parents === 0)
        return { detail: "Nothing was running." };
      return { detail: "Global Stop requested for active and queued work. Check status for final results." };
    },
    reply: async (text: string) => {
      const send = options.telegramSend;
      if (send === undefined || lastKnownOwnerChat === null) return;
      await send(lastKnownOwnerChat, text);
    }
  });

  /**
   * Continuing on a phone, for real this time.
   *
   * A screen shipped that invented a PIN in the browser and reported a server
   * "ready" while nothing was listening. The server it described has existed in
   * this repo, tested, with no caller, since it was written. This is the caller.
   * The bind address is chosen by the owner and is never wider than what he
   * chose: there is no path here that listens on every interface.
   */
  const pairing = installRemotePairing({
    assertTrusted: options.assertTrusted,
    startServer: async ({ host: bindHost }) => {
      const server = createRemoteDispatchServer({ host: bindHost, port: 0, sessionTtlMs: 10 * 60_000 });
      const bridge = installRemoteHostBridge(server, host);
      const session = await server.start();
      return {
        url: session.serverUrl,
        pin: session.pin,
        // Long enough to walk to the other device, short enough that a code
        // left on screen is not a standing key to this Mac.
        expiresAt: Date.now() + 10 * 60_000,
        stop: () => server.stop(),
        handover: {
          candidates: () => ({ principals: server.pairedPrincipals(), runs: bridge.handoverCandidates() }),
          prepare: (input) => bridge.prepareOneRunHandover(input),
          approve: (token) => bridge.approveOneRunHandover(token)
        }
      };
    },
    /**
     * The Wi-Fi address of this Mac, or nothing.
     *
     * Only a private-range IPv4 on a non-internal interface counts. If this
     * returns null the pairing refuses rather than widening the bind, which is
     * the whole reason it is a separate function.
     */
    lanAddress: () => {
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.internal || address.family !== "IPv4") continue;
          if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(address.address)) return address.address;
        }
      }
      return null;
    }
  });

  // Reading whatever the owner drops in — Word, PDF, spreadsheets, saved web
  // pages. The parser has been in this repo unreachable; this previews with it,
  // and adding the result as a source stays a separate, reviewed step.
  installDocumentParse({
    assertTrusted: options.assertTrusted,
    readPicked: async ({ caseId }) => {
      void caseId;
      const window = options.getWindow();
      if (window === null) return null;
      const picked = await dialog.showOpenDialog(window, {
        properties: ["openFile"],
        message: "Choose a file to read"
      });
      const chosen = picked.canceled ? undefined : picked.filePaths[0];
      if (chosen === undefined) return null;
      const bytes = await readFile(chosen);
      return { name: path.basename(chosen), bytes: new Uint8Array(bytes), mimeType: "" };
    },
    parse: (content, parseOptions) => {
      const parsed = parseDocument(content, { filename: parseOptions.filename, mimeType: parseOptions.mimeType });
      // The parser returns markdown and counts, not a warning list: what it
      // could not do it simply does not put in the output. The one thing worth
      // saying back is when a document turned out to be empty, because an empty
      // preview otherwise reads like the app failed.
      return {
        format: parsed.format,
        text: parsed.markdown,
        headings: parsed.headings.map((heading) => ({ level: heading.level, text: heading.text })),
        warnings: parsed.markdown.trim().length === 0 ? ["There was no readable text in that file."] : []
      };
    }
  });

  // Speaking instead of typing. Nothing recorded leaves this Mac, and the
  // transcript lands in the composer to be reviewed like anything typed.
  installDictation({
    assertTrusted: options.assertTrusted,
    transcribe: async (wav, signal) => {
      void signal;
      const result = await transcribeAudio(wav);
      if (!result.success) throw new Error(result.errorDetail ?? "That recording could not be read.");
      return {
        text: result.text,
        durationMs: Math.round(result.durationSeconds * 1000),
        segments: result.segments.map((segment) => ({ text: segment.text }))
      };
    },
    /**
     * Observed, not assumed. Speech needs a local model this build does not
     * ship yet, and saying so plainly is the whole contract of this channel.
     */
    modelReady: async () => ({
      ready: false,
      detail: "No speech model is installed on this Mac yet, so dictation is not available."
    })
  });

  // Finding work by what it was about. Without a local embedding model this
  // matches words and says so; it never claims to search by meaning.
  installSemanticSearch({
    assertTrusted: options.assertTrusted,
    searchable: () => {
      try {
        const db = options.book();
        const rows = db
          .prepare(
            `SELECT t.id AS id, t.case_id AS caseId, c.title AS caseTitle, t.body AS body, t.at AS at
               FROM case_turn t JOIN work_case c ON c.id = t.case_id
              WHERE c.closed_at IS NULL
              ORDER BY t.at DESC
              LIMIT ?`
          )
          .all(MAX_SEARCHABLE_TURNS) as readonly Record<string, unknown>[];
        return rows.map((row) => ({
          id: String(row["id"]),
          caseId: String(row["caseId"]),
          caseTitle: String(row["caseTitle"]),
          body: String(row["body"]),
          at: Number(row["at"])
        }));
      } catch {
        return [];
      }
    },
    embed: null
  });

  /**
   * Turning a finished output into a file he can send someone.
   *
   * The screen this replaces offered four formats and had no call to the main
   * process at all. Preview and write are separate channels so nothing reaches
   * the disk before he has seen the list of files it would create.
   */
  installPublish({
    assertTrusted: options.assertTrusted,
    caseFolder,
    latestOutput: async (caseId: string) => {
      const db = options.book();
      const workCase = readCase(db, caseId);
      if (workCase === null) return null;
      const latest = artifactVersions(db, caseId)[0];
      if (latest === undefined) return null;
      const labels = turnsFor(db, caseId)
        .filter((turn) => turn.kind === "verbatim" && turn.seat.startsWith(CASE_SOURCE_SEAT_PREFIX))
        .map((turn) => ({ label: turn.seat.slice(CASE_SOURCE_SEAT_PREFIX.length) }));
      return { title: workCase.title, body: latest.body, sources: labels };
    },
    write: async (folder, files) => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      for (const file of files) {
        const destination = path.join(folder, file.relativePath);
        const relative = path.relative(folder, destination);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error("A published file resolved outside the destination folder.");
        }
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.contents, { encoding: "utf8", mode: 0o600 });
      }
      return folder;
    }
  });

  /** Every orchestration child starts a fresh, exact reviewed host session. */
  const prepareReviewedChild = (input: {
    readonly caseId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly prompt: string;
    readonly sourceTurnIds: readonly string[];
    readonly owner: object;
    readonly contextRoleId?: string;
  }): Promise<WorkstationReview> => host.prepare({
    caseId: input.caseId,
    providerId: input.providerId as WorkstationProviderId,
    modelId: input.modelId,
    prompt: input.prompt,
    sourceTurnIds: input.sourceTurnIds,
    ...(input.contextRoleId === undefined ? {} : { contextRoleId: input.contextRoleId })
  }, input.owner, { freshSession: true });

  const runReviewedChild = async (input: {
    readonly review: WorkstationReview;
    readonly owner: object;
    readonly signal: AbortSignal;
    readonly onActivity?: (line: string) => void;
  }): Promise<NativeAskOutcome & { readonly turnId: string | null }> => {
    const { review, owner, signal, onActivity } = input;
    const started = await host.start({ token: review.token }, owner, signal);
    if (started.caseId !== review.caseId || started.providerId !== review.providerId ||
        started.modelId !== review.modelId)
      throw new Error("The child session did not match its reviewed choice.");
    const terminal = await host.awaitTerminal(started.caseId, started.operationId, owner,
      signal, onActivity);
    return {
      text: terminal.text,
      sessionId: terminal.sessionId,
      finishReason: terminal.status === "completed" ? "completed" as const
        : terminal.status === "stopped" ? "stopped" as const : "failed" as const,
      detail: terminal.detail,
      requestedModelId: review.modelId,
      ...(terminal.reportedModelId ? { reportedModelId: terminal.reportedModelId } : {}),
      // The recorded host terminal result decides the child outcome. A parent
      // Stop may arrive after a provider already completed this child.
      cancellationRequested: terminal.status === "stopped",
      resultSource: "transport" as const,
      turnId: terminal.answerTurnId ?? null
    };
  };

  /** Explicit Compare is a reviewed parent with serial host-owned children. */
  reviewedDispatch = installReviewedDispatchRun({
    assertTrusted: options.assertTrusted,
    ownerFor,
    persistParent: async (record) => saveCompareParent(options.book(), record),
    persistChild: async (caseId, record) => saveCompareChild(options.book(), caseId, record),
    recover: async (runId) => recoveredCompareBoard(options.book(), runId),
    prepareLane: ({ caseId, providerId, modelId, brief, sourceTurnIds, owner }) =>
      prepareReviewedChild({ caseId, providerId, modelId, prompt: brief, sourceTurnIds, owner }),
    runLane: runReviewedChild
  });

  /** A recovered answer is read from the same-case Book turn, never a receipt summary. */
  const recoveredAnswer = (recovered: RecoveredReviewedParent): string | undefined => {
    const child = [...recovered.children].reverse().find((one) => one.state === "answered" && one.answerTurnId !== null);
    if (!child?.answerTurnId) return undefined;
    return turnsFor(options.book(), recovered.caseId)
      .find((turn) => turn.id === child.answerTurnId && (turn.kind === "verbatim" || turn.kind === "finding"))?.body;
  };

  const bundledAgentDefinitions = () => listHermesSkills().map((skill) => ({
    id: skill.id,
    markdown: (() => {
      try { return readHermesSkill(skill.id).content; }
      catch { return ""; }
    })()
  })).filter((entry) => entry.markdown.length > 0);

  reviewedAgent = installReviewedAgentStream({
    assertTrusted: options.assertTrusted,
    ownerFor,
    resolveSavedAgent: (input) => loadStoredAgentContract({
      agentsFolder: () => path.join(options.userData(), "workstation", "agents"),
      bundled: bundledAgentDefinitions
    }, { ...input, maxPromptLength: WORKSTATION_AGENT_GOAL_LIMIT }),
    prepareChild: prepareReviewedChild,
    runChild: runReviewedChild,
    persistParent: async (record) => {
      saveReviewedParent(options.book(), {
        event: "parent", kind: "agent", runId: record.runId, caseId: record.caseId,
        request: record.prompt, at: record.at,
        ...(record.agentContract ? { agentContract: record.agentContract } : {}),
        children: record.children.map((child, index) => ({
          id: String(index), label: child.label, providerId: child.providerId,
          modelId: child.modelId, contextSnapshotId: child.contextSnapshotId,
          sourceHash: child.sourceHash
        }))
      });
    },
    persistChild: async (caseId, record) => {
      saveReviewedChild(options.book(), caseId, {
        event: "child", kind: "agent", runId: record.runId, childId: String(record.index),
        state: record.state, at: record.at, line: record.line,
        answerTurnId: record.answerTurnId, draftTurnId: record.draftTurnId, chars: record.chars,
        ...(record.attempt ? { attempt: record.attempt } : {})
      });
    },
    recover: async (runId): Promise<WorkstationAgentPollResult | null> => {
      const recovered = recoverReviewedParent(options.book(), "agent", runId);
      if (recovered === null) return null;
      const answer = recoveredAnswer(recovered);
      return {
        state: recovered.status, steps: [],
        ...(answer === undefined ? {} : { answer }),
        ...(recovered.status === "done" ? {} : { failure: recovered.headline })
      };
    }
  });

  reviewedCrew = installReviewedCrewRun({
    assertTrusted: options.assertTrusted,
    ownerFor,
    prepareChild: prepareReviewedChild,
    runChild: runReviewedChild,
    persistParent: async (record) => {
      saveReviewedParent(options.book(), {
        event: "parent", kind: "crew", runId: record.runId, caseId: record.caseId,
        request: record.request, at: record.at,
        ...(record.integrationOwner === undefined ? {} : { integrationOwner: record.integrationOwner }),
        children: record.children.map((child) => ({
          id: child.partId, label: child.label, providerId: child.providerId,
          modelId: child.modelId, contextSnapshotId: child.contextSnapshotId,
          sourceHash: child.sourceHash, dependsOn: [...child.dependsOn],
          title: child.title,
          ...(child.role === undefined ? {} : { role: child.role }),
          ...(child.contextRoleId === undefined ? {} : { contextRoleId: child.contextRoleId }),
          work: child.work,
          ...(child.expectedOutput === undefined ? {} : { expectedOutput: child.expectedOutput })
        }))
      });
    },
    persistChild: async (caseId, record) => {
      saveReviewedChild(options.book(), caseId, {
        event: "child", kind: "crew", runId: record.runId, childId: record.partId,
        state: record.state, at: record.at, line: record.line,
        answerTurnId: record.answerTurnId, draftTurnId: record.draftTurnId, chars: record.chars,
        ...(record.attempt ? { attempt: record.attempt } : {})
      });
    },
    readDependency: async ({ caseId, turnId }) => {
      const turn = turnsFor(options.book(), caseId)
        .find((one) => one.id === turnId && (one.kind === "verbatim" || one.kind === "finding"));
      return turn === undefined ? null : { text: turn.body, seatLabel: turn.seat };
    },
    recover: async (runId): Promise<CrewRunView | null> => {
      const recovered = recoverReviewedParent(options.book(), "crew", runId);
      if (recovered === null) return null;
      return {
        runId, caseId: recovered.caseId, request: recovered.request,
        round: recovered.status, headline: recovered.headline, canStop: false,
        parts: recovered.children.map((child) => ({
          id: child.id, title: child.title ?? child.label, seatLabel: child.label,
          state: child.state === "answered" ? "done" as const : child.state,
          line: child.line, elapsed: "—", answerTurnId: child.answerTurnId,
          draftTurnId: child.draftTurnId, outcome: null, refinedFrom: [], canStop: false
        }))
      };
    }
  });

  /**
   * The agents he writes, and the four that came with the app.
   *
   * A bundled one is readable and never writable: saving over its id makes a
   * copy of his own instead, which is the behaviour that lets him start from a
   * procedure that already works without losing the original.
   */
  installAgentStore({
    assertTrusted: options.assertTrusted,
    agentsFolder: () => path.join(options.userData(), "workstation", "agents"),
    bundled: bundledAgentDefinitions
  });

  /** Research uses the same exact host review and durable child receipts. */
  reviewedResearch = installReviewedResearchRun({
    assertTrusted: options.assertTrusted,
    ownerFor,
    fetchPage: async (url, signal) => {
      const fetched = await readPageSource(url, signal);
      return fetched.status === "refused" ? null : { html: fetched.source, finalUrl: fetched.finalUrl };
    },
    files: async (caseId) => {
      const folder = await caseFolder(caseId);
      if (folder === null) return [];
      const listing = await listWorkspace(folder);
      const out: { readonly id: string; readonly label: string; readonly text: string }[] = [];
      for (const entry of listing.entries) {
        if (entry.kind !== "file" || !entry.textual || out.length >= 10) continue;
        const preview = await previewFile(folder, entry.relativePath);
        if (preview.status === "text") out.push({ id: entry.relativePath, label: entry.name, text: preview.text });
      }
      return out;
    },
    prepareChild: ({ owner, ...input }) => {
      if (typeof owner !== "object" || owner === null) throw new Error("A window owner is required.");
      return prepareReviewedChild({ ...input, owner });
    },
    runChild: ({ owner, ...input }) => {
      if (typeof owner !== "object" || owner === null) throw new Error("A window owner is required.");
      return runReviewedChild({ ...input, owner });
    },
    persistParent: async (record) => {
      saveReviewedParent(options.book(), {
        event: "parent", kind: "research", runId: record.runId, caseId: record.caseId,
        request: record.prompt, at: record.at,
        children: record.children.map((child, index) => ({
          id: String(index), label: child.label, providerId: child.providerId,
          modelId: child.modelId, contextSnapshotId: child.contextSnapshotId,
          sourceHash: child.sourceHash
        }))
      });
    },
    persistChild: async (caseId, record) => {
      saveReviewedChild(options.book(), caseId, {
        event: "child", kind: "research", runId: record.runId, childId: String(record.index),
        state: record.state, at: record.at, line: record.line,
        answerTurnId: record.answerTurnId, draftTurnId: record.draftTurnId, chars: record.chars,
        ...(record.attempt ? { attempt: record.attempt } : {})
      });
    },
    recover: async (runId): Promise<ResearchRunView | null> => {
      const recovered = recoverReviewedParent(options.book(), "research", runId);
      if (recovered === null) return null;
      return {
        runId, caseId: recovered.caseId, question: recovered.request,
        state: recovered.status, steps: [], sourcesRead: 0, notesKept: 0,
        headline: `${recovered.headline} Live source counts are unavailable after restart.`,
        answer: recoveredAnswer(recovered) ?? null, nativeOutcomes: [],
        unanswered: recovered.status === "done" ? [] : [recovered.request],
        canStop: false
      };
    }
  });

  /**
   * What it worked out about a project, and the controls to strike any of it
   * out. Stored beside the app's own data and never sent anywhere: this is what
   * the app believes about his business, and the only thing it is ever put in
   * front of is his own subscription, on his own Mac.
   */
  installProjectMemory({
    assertTrusted: options.assertTrusted,
    folder: () => memoryFolder,
    book: options.book,
    principalFor: (event) => {
      options.assertTrusted(event);
      return "local-owner";
    },
    beforeMutation: (projectId) => {
      host.assertProjectIdle(projectId);
      host.invalidateProjectReviews(projectId);
    }
  });
  installProjectMemoryConflicts({
    assertTrusted: options.assertTrusted,
    book: options.book,
    principalFor: (event) => {
      options.assertTrusted(event);
      return "local-owner";
    },
    beforeMutation: (projectId) => {
      host.assertProjectIdle(projectId);
      host.invalidateProjectReviews(projectId);
    }
  });

  /**
   * What a session changed on his Mac, and putting it back.
   *
   * The before is recorded by `onRunStart` above, as the session starts. When
   * nothing was recorded the panel is told so plainly rather than being handed
   * an empty list, because "no before was kept" and "nothing changed" are
   * different answers and only one of them is reassuring.
   */
  installFileHistory({
    assertTrusted: options.assertTrusted,
    folderFor: async (caseId) => {
      const folder = await caseFolder(caseId);
      if (folder === null) return null;
      try { return await realpath(folder); }
      catch { return null; }
    },
    snapshot: async (folder: string) => snapshotFolder(folder),
    before: async (caseId: string, operationId: string) =>
      readBefore(changeHistoryFolder, caseId, operationId),
    contentBefore: async (caseId: string, operationId: string, relativePath: string) =>
      readContentBefore(changeHistoryFolder, caseId, operationId, relativePath),
    withAdmissionLease: (caseId, folder, owner, action) =>
      host.withFileRestoreLease(caseId, folder, owner, action),
    savePreimage: (caseId, operationId, folder) =>
      saveBefore(changeHistoryFolder, caseId, operationId, folder),
    restore: async (folder: string, relativePath: string, contents: string) => {
      await safeRestoreFile(folder, relativePath, contents);
    }
  });

  /**
   * Keeping an eye on a page, a folder or a routine between visits.
   *
   * It says something only when the change is one he asked to hear about, and
   * only when it is not the middle of the night. An unreachable target is
   * reported once, on the third failure, and then the watch pauses itself
   * rather than filling his phone with the same failure every hour.
   */
  /**
   * What he has used, out of subscriptions he already pays for.
   *
   * Counted from the receipts this app already writes for every session, so
   * nothing new is recorded to answer it and no request is made to any vendor.
   * It counts sessions and the time they took — never tokens, never cost,
   * because this app is not the one billing him and must not imply it knows.
   */
  installUsage({
    assertTrusted: options.assertTrusted,
    receipts: () => {
      const rows = options
        .book()
        .prepare(
          `SELECT t.body AS body, t.at AS at
             FROM case_turn t
            WHERE t.kind = 'receipt' AND t.seat = ?
            ORDER BY t.at DESC
            LIMIT ?`
        )
        .all(WORKSTATION_SESSION_SEAT, WORKSTATION_USAGE_RECEIPT_CAP) as readonly Record<string, unknown>[];
      return rows.map((row) => ({ body: String(row["body"]), at: Number(row["at"]) }));
    },
    known: async () => (await host.providers()).map((one) => ({ id: one.id, label: one.label }))
  });
  installModelOutcomeEvidence({
    assertTrusted: options.assertTrusted,
    book: options.book
  });
  installModelPreferencesIpc({ assertTrusted: options.assertTrusted, book: options.book });
  installModelAdviceIpc({
    assertTrusted: options.assertTrusted,
    book: options.book,
    providers: () => host.providers()
  });

  const watching = installWatch({
    assertTrusted: options.assertTrusted,
    load: () => loadWatches(watchFolder),
    save: async (watches) => {
      const kept = new Set(watches.map((watch) => watch.id));
      const previous = await loadWatches(watchFolder);
      await saveWatches(watchFolder, watches);
      for (const watch of previous) {
        if (!kept.has(watch.id)) {
          await forgetSeen(watchFolder, watch.id);
        }
      }
    },
    look: async (target, signal) => {
      if (target.kind === "page") {
        const fetched = await readPageSource(target.url, signal);
        return fetched.status === "read" ? fetched.source : null;
      }
      if (target.kind === "folder") {
        try {
          const listing = await listWorkspace(target.path);
          // One line per file, which is what "something is added or removed"
          // compares. Contents are deliberately not read: watching a folder is
          // about what is in it.
          return listing.entries
            .filter((entry) => entry.kind === "file")
            .map((entry) => entry.relativePath)
            .sort()
            .join("\n");
        } catch {
          return null;
        }
      }
      const routine = WORKSTATION_ROUTINES.find((item) => item.id === target.routineId);
      return routine === undefined ? null : `${routine.title}\n${routine.prompt}`;
    },
    lastSeen: (watchId) => lastSeen(watchFolder, watchId),
    remember: (watchId, text) => remember(watchFolder, watchId, text),
    tell: async (text: string) => {
      const send = options.telegramSend;
      const chats = options.telegramContacts;
      if (send === undefined || chats === undefined) {
        return;
      }
      // Only chats already on his own contact list, the same list that decides
      // who this Mac will obey.
      for (const chatId of await chats()) {
        await send(chatId, text);
      }
    }
  });

  /**
   * Who has knocked, and saying one of them is him.
   *
   * The pairing is the whole of the grant: before it this Mac obeys nobody, and
   * after it this Mac obeys exactly one chat. It is deliberately a thing he
   * does while looking at the row, not something inferred from whoever wrote
   * first — a bot's username is discoverable, so first-to-write is a race a
   * stranger can win.
   */
  ipcMain.handle(IPC_CHANNELS.workstationPhoneKnocks, async (event): Promise<{
    readonly knocks: readonly { readonly chatId: string; readonly from: string; readonly at: number }[];
    readonly pairedChatId: string | null;
    readonly canPair: boolean;
  }> => {
    options.assertTrusted(event);
    const paired = lastKnownOwnerChat;
    return {
      knocks: [...knocks.values()]
        .filter((knock) => knock.chatId !== paired)
        .sort((a, b) => b.at - a.at),
      pairedChatId: paired,
      canPair: options.telegramAddContact !== undefined
    };
  });

  ipcMain.handle(IPC_CHANNELS.workstationPhonePair, async (event, input: unknown): Promise<{
    readonly paired: boolean;
    readonly said: string;
  }> => {
    options.assertTrusted(event);
    const request = PhonePairInputSchema.parse(input);
    const add = options.telegramAddContact;
    const remove = options.telegramRemoveContact;

    if (request.pair === false) {
      if (remove === undefined) {
        return { paired: false, said: "This build cannot change the list." };
      }
      await remove(request.chatId);
      refreshOwnerChat();
      return { paired: false, said: "That chat is no longer obeyed." };
    }

    if (add === undefined) {
      return { paired: false, said: "This build cannot change the list." };
    }
    const known = knocks.get(request.chatId);
    /**
     * Only a chat that has actually written in. Pairing an arbitrary id typed
     * from anywhere would make this handler a way to point the Mac at a chat
     * nobody on this Mac has ever seen.
     */
    if (known === undefined) {
      return {
        paired: false,
        said: "That chat has not messaged your bot, so there is nothing to recognise."
      };
    }
    await add({ chatId: request.chatId, label: known.from.length > 0 ? known.from : "My phone" });
    knocks.delete(request.chatId);
    refreshOwnerChat();
    return { paired: true, said: "Your Mac now obeys that chat, and no other." };
  });

  /**
   * Telling him something is waiting.
   *
   * Polled rather than pushed, because the host has no event to subscribe to —
   * the window polls for the same thing. Every four seconds is slower than a
   * person walking to their Mac, and fast enough that a session is not left
   * waiting on a timer.
   *
   * Only ever announces. The answer comes back as a message he sends, through
   * the same door every other message uses.
   */
  const announced = new AnnouncedCalls();
  const announcing = new Set<string>();
  const tellHimWhatIsWaiting = async (): Promise<void> => {
    const send = options.telegramSend;
    const chats = options.telegramContacts;
    if (send === undefined || chats === undefined) {
      return;
    }
    const waiting = waitingCalls(host.liveSnapshots());
    announced.keepOnly(waiting);
    const liveKeys = new Set(waiting.map((call) => `${call.operationId}:${call.permissionId}`));
    for (const [key, pending] of phoneApprovals) {
      const current = waiting.find((call) => `${call.operationId}:${call.permissionId}` === key);
      if (!liveKeys.has(key) || current === undefined || current.title !== pending.title || current.detail !== pending.detail || Date.now() > pending.expiresAt) {
        phoneApprovals.delete(key);
        if (current !== undefined) announced.forget(current);
      }
    }
    const fresh = announced.fresh(waiting);
    if (fresh.length === 0) {
      return;
    }
    const owners = await chats();
    const ownerChat = lastKnownOwnerChat;
    if (ownerChat === null || !owners.includes(ownerChat)) return;
    for (const call of fresh) {
      const key = `${call.operationId}:${call.permissionId}`;
      if (announcing.has(key)) continue;
      announcing.add(key);
      try {
      let displayCode: string;
      do {
        displayCode = (randomBytes(4).readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
      } while ([...phoneApprovals.values()].some((one) => one.code === displayCode));
      const message = describeCall(call, displayCode);
      if (message.length > 3500 || sanitiseReply(message, [ownerChat], 3500) !== message) continue;
      await send(ownerChat, message);
      const stillWaiting = waitingCalls(host.liveSnapshots()).some((one) => one.operationId === call.operationId &&
        one.permissionId === call.permissionId && one.title === call.title && one.detail === call.detail);
      if (stillWaiting && lastKnownOwnerChat === ownerChat) {
        phoneApprovals.set(key, { code: displayCode, operationId: call.operationId,
          permissionId: call.permissionId, title: call.title, detail: call.detail,
          expiresAt: Date.now() + 5 * 60_000 });
        announced.markDelivered(call);
      }
      } finally {
        announcing.delete(key);
      }
    }
  };
  const approvalTimer = setInterval(() => {
    void tellHimWhatIsWaiting().catch(() => {
      // A phone that cannot be reached must not stop the session it is about.
    });
  }, 4_000);
  if (typeof approvalTimer.unref === "function") approvalTimer.unref();

  // Book opens lazily. The immediate pass recovers orphan claims before any
  // queue admission; if Book is not ready, the app-alive interval retries.
  schedulePump.start();
  return {
    localBriefHistory: (event) => {
      options.assertTrusted(event);
      return host.localBriefHistory();
    },
    forgetLocalBriefHistory: (event, reviewSha256) => {
      options.assertTrusted(event);
      return host.forgetLocalBriefHistory(reviewSha256);
    },
    runLocalBrief: (event, input) => {
      options.assertTrusted(event);
      recoverOnce();
      localBriefScope.recover(options.book());
      const owner = ownerFor(event);
      return host.runLocalBrief({ ...input, owner, assertOwner: () => {
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) throw new Error("This window changed before the brief completed.");
        input.assertOwner();
      } });
    },
    assertIdle: (caseId: string) => {
      host.assertIdle(caseId);
    },
    runLocalCase: (event, input) => {
      options.assertTrusted(event);
      recoverOnce();
      // A malformed Case receipt is a hard admission failure. The ordinary
      // lazy recovery probe above may defer when Book has not opened yet.
      localCaseScope.recover(options.book());
      return host.runLocalCase({ ...input, owner: ownerFor(event) });
    },
    localCaseState: (event, caseId) => {
      options.assertTrusted(event);
      recoverOnce();
      localCaseScope.recover(options.book());
      return host.localCaseState(caseId, ownerFor(event));
    },
    stopLocalCase: (event, caseId, operationId) => {
      options.assertTrusted(event);
      return host.stopLocalCase(caseId, operationId, ownerFor(event));
    },
    runLocalAgent: (event, input) => {
      options.assertTrusted(event);
      recoverOnce();
      localCaseScope.recover(options.book());
      return host.runLocalAgent({ ...input, owner: ownerFor(event) });
    },
    stopLocalAgent: (event, agentId) => {
      options.assertTrusted(event);
      return host.stopLocalAgent(agentId, ownerFor(event));
    },
    runLocalSuggestion: (event, input) => {
      options.assertTrusted(event);
      recoverOnce();
      localCaseScope.recover(options.book());
      return host.runLocalSuggestion({ ...input, owner: ownerFor(event) });
    },
    prepareGraphNode: (event, input) => {
      options.assertTrusted(event);
      recoverOnce();
      localCaseScope.recover(options.book());
      return host.prepareGraphNode(AutomationPendingHostReviewInputSchema.parse(input), ownerFor(event));
    },
    startGraphNode: (event, input) => {
      options.assertTrusted(event);
      recoverOnce();
      localCaseScope.recover(options.book());
      return host.startGraphNode(WorkstationStartInputSchema.parse(input), ownerFor(event));
    },
    stopGraphNode: (event, caseId, operationId) => {
      options.assertTrusted(event);
      return host.stopGraphNode(caseId, operationId, ownerFor(event));
    },
    reconcileGraphHostRuns: (event) => {
      if (event !== undefined) options.assertTrusted(event);
      return host.reconcileGraphHostRuns();
    },
    answerPhone: (chatId: string, text: string, from?: string) => phone.answerPhone(chatId, text, from),
    shutdown: async () => {
      clearInterval(approvalTimer);
      schedulePump.dispose();
      watching.stop();
      await pairing.shutdown();
      await reviewedDispatch?.shutdown();
      await reviewedAgent?.shutdown();
      await reviewedCrew?.shutdown();
      await reviewedResearch?.shutdown();
      scheduled?.shutdown();
      await host.shutdown();
    }
  };
}
