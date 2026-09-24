import type { CaseArtifactFormat, CaseArtifactSave, CaseDataQuery, CaseDataSave, CaseEnquiryRequest, CaseEnquirySave } from "@cadrane/contracts";
import { contextBridge, ipcRenderer } from "electron";
import { writeComposerDraft } from "../renderer/workstation/composer-drafts.js";
import {
  DESKTOP_BRIDGE_VERSION,
  type AutomationAgentSaveInput,
  type AutomationArtifactReviewInput,
  type AutomationConnectorEnsureLocalInput,
  type AutomationRunActionInput,
  type AutomationMemoryDocumentSaveInput,
  type AutomationRunStartInput,
  type AutomationWorkflowSaveInput,
  type AutomationWorkflowPackExportInput,
  type DesktopBridge,
  type LicenseAcceptanceIntent,
  type LocalChatRequest,
  type CaseLocalRequest,
  type HandoffEvent,
  type BenchProgress,
  type RunProgress,
  type WorkstationPrepareInput,
  type WorkstationProjectSaveInput,
  type WorkstationProjectAssignInput,
  type WorkstationProjectCaptureInput,
  type WorkstationRoutineSaveInput,
  type WorkstationCheckCitationsInput
} from "@cadrane/contracts";
import { AGENT_PROGRESS_EVENT, BENCH_PROGRESS_EVENT, IPC_CHANNELS } from "../shared/ipc-channels.js";

const bridge: DesktopBridge = Object.freeze({
  version: DESKTOP_BRIDGE_VERSION,
  system: Object.freeze({
    profile: () => ipcRenderer.invoke(IPC_CHANNELS.systemProfile)
  }),
  runtimes: Object.freeze({
    discover: () => ipcRenderer.invoke(IPC_CHANNELS.runtimeDiscover),
    chat: (request: LocalChatRequest) => ipcRenderer.invoke(IPC_CHANNELS.runtimeChat, request),
    cancel: (operationId: string) => ipcRenderer.invoke(IPC_CHANNELS.runtimeCancel, operationId)
  }),
  automations: Object.freeze({
    snapshot: () => ipcRenderer.invoke(IPC_CHANNELS.automationSnapshot, {}),
    saveAgent: (input: AutomationAgentSaveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationAgentSave, input),
    saveWorkflow: (input: AutomationWorkflowSaveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationWorkflowSave, input),
    saveMemory: (input: AutomationMemoryDocumentSaveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationMemorySave, input),
    importSources: () => ipcRenderer.invoke(IPC_CHANNELS.automationSourceImport, {}),
    reviewArtifact: (input: AutomationArtifactReviewInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationArtifactReview, input),
    ensureLocalConnector: (input: AutomationConnectorEnsureLocalInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationConnectorEnsureLocal, input),
    exportPack: (input: AutomationWorkflowPackExportInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationPackExport, input),
    importPack: () => ipcRenderer.invoke(IPC_CHANNELS.automationPackImport, {}),
    /** Flows somebody can start from, without opening the canvas. */
    templates: () => ipcRenderer.invoke(IPC_CHANNELS.flowTemplates),
    /** Makes a flow from a template. It arrives switched off, always. */
    fromTemplate: (input: { templateId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.flowFromTemplate, input),
    /** Replays a flow against its folder's own history before it is armed. */
    backtest: (input: { workflowId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationBacktest, input),
    dryRun: (input: { workflowId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationDryRun, input),
    start: (input: AutomationRunStartInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationRunStart, input),
    action: (input: AutomationRunActionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationRunAction, input)
  }),
  models: Object.freeze({
    recommend: (mode: "fast" | "balanced" | "quality" | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelRecommend, mode),
    pickAndInspectGguf: () => ipcRenderer.invoke(IPC_CHANNELS.modelPickGguf),
    installations: () =>
      ipcRenderer.invoke(IPC_CHANNELS.modelInstallations, {}),
    licenseReview: (modelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelLicenseReview, { modelId }),
    acknowledgeLicense: (intent: LicenseAcceptanceIntent) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelLicenseAcknowledge, intent),
    install: (modelId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelInstall, { modelId }),
    cancelInstall: (operationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelInstallCancel, { operationId })
  }),
  events: Object.freeze({
    /**
     * The only push channel in the bridge. It carries one event shape and hands
     * the listener nothing but that payload — never the IpcRendererEvent, which
     * would expose a sender the renderer has no business holding.
     */
    onHandoff: (listener: (event: HandoffEvent) => void): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as HandoffEvent);
      ipcRenderer.on("cadrane:handoff", wrapped);
      // A block body: removeListener returns the IpcRenderer, and letting that
      // escape would hand the renderer the very object contextIsolation exists
      // to keep away from it.
      return () => {
        ipcRenderer.removeListener("cadrane:handoff", wrapped);
      };
    },
    /**
     * What a running agent is doing, as it does it.
     *
     * Same shape as the handoff listener and for the same reason: the payload
     * only, never the IpcRendererEvent.
     */
    onAgentProgress: (listener: (event: RunProgress) => void): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as RunProgress);
      ipcRenderer.on(AGENT_PROGRESS_EVENT, wrapped);
      return () => {
        ipcRenderer.removeListener(AGENT_PROGRESS_EVENT, wrapped);
      };
    },
    /** A Bench turn landing, while the argument is still running. */
    onBenchProgress: (listener: (event: BenchProgress) => void): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload as BenchProgress);
      ipcRenderer.on(BENCH_PROGRESS_EVENT, wrapped);
      return () => {
        ipcRenderer.removeListener(BENCH_PROGRESS_EVENT, wrapped);
      };
    }
  }),
  diagnostics: Object.freeze({
    bundle: () => ipcRenderer.invoke(IPC_CHANNELS.diagnosticsBundle)
  }),
  settings: Object.freeze({
    read: () => ipcRenderer.invoke(IPC_CHANNELS.settingsRead),
    write: (next: unknown) => ipcRenderer.invoke(IPC_CHANNELS.settingsWrite, next)
  }),
  workspace: Object.freeze({
    roots: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceRoots),
    grant: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGrant),
    revoke: (input: { path: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceRevoke, input),
    lost: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceLost)
  }),
  activity: Object.freeze({
    read: (input?: { limit?: number }) => ipcRenderer.invoke(IPC_CHANNELS.activityRead, input)
  }),
  vault: Object.freeze({
    /** Reads notes back, then writes the book out. Both directions, one call. */
    sync: () => ipcRenderer.invoke(IPC_CHANNELS.vaultSync),
    reveal: () => ipcRenderer.invoke(IPC_CHANNELS.vaultReveal)
  }),
  engineKeys: Object.freeze({
    /** Which engines have a key stored. Never returns the key itself. */
    status: () => ipcRenderer.invoke(IPC_CHANNELS.engineKeyStatus),
    save: (input: { engineId: string; key: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.engineKeySave, input),
    forget: (input: { engineId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.engineKeyForget, input)
  }),
  updates: Object.freeze({
    /** Asks once, because somebody pressed the button. Never on a timer. */
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    /** Opens the releases page. Rellane never installs anything itself. */
    open: () => ipcRenderer.invoke(IPC_CHANNELS.updateOpen),
    /**
     * Opens one link the owner is looking at — a WhatsApp chat or a UPI
     * request. Three schemes only; everything else is refused.
     */
    openLink: (input: { url: string }) => ipcRenderer.invoke(IPC_CHANNELS.openLink, input)
  }),
  memory: Object.freeze({
    /** Everything Rellane has seen: words, folders, notes, cases. */
    read: () => ipcRenderer.invoke(IPC_CHANNELS.memoryRead),
    /** Hide a learned term, or bring it back. */
    hide: (input: { key: string; hidden: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryHide, input),
    /** The per-folder off switch. Paused folders are read by nothing. */
    pause: (input: { path: string; paused: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspacePause, input)
  }),
  book: Object.freeze({
    standing: () => ipcRenderer.invoke(IPC_CHANNELS.bookStanding),
    read: (input: { handle: string; text: string }) => ipcRenderer.invoke(IPC_CHANNELS.bookRead, input),
    /**
     * Reads a bill from a photograph, a scan or a PDF the owner picks.
     *
     * On this Mac, with macOS's own frameworks: nothing is uploaded, and what
     * comes back is a proposal to check rather than a record.
     */
    readFile: (input: { handle: string }) => ipcRenderer.invoke(IPC_CHANNELS.bookReadFile, input),
    addParty: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.bookAddParty, input),
    addInvoice: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.bookAddInvoice, input),
    addPayment: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.bookAddPayment, input)
  }),
  /**
   * Cases — the thing a person points at.
   *
   * Ids cross this bridge; nothing else about where a case lives does. The
   * renderer gets ids and sentences, never a path it could replay.
   */
  /**
   * What needs you today — the front door.
   *
   * Read-only and derived at the moment it is asked for. Nothing here is a
   * stored total, so nothing here can quietly disagree with the records.
   */
  /** Mark's Telegram token. Status never carries the token itself. */
  telegram: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.telegramStatus),
    save: (input: { token: string }) => ipcRenderer.invoke(IPC_CHANNELS.telegramSave, input),
    forget: () => ipcRenderer.invoke(IPC_CHANNELS.telegramForget)
  }),
  /** The business number. Sending lives here; receiving needs a mailbox. */
  whatsapp: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappStatus),
    save: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.whatsappSave, input),
    forget: () => ipcRenderer.invoke(IPC_CHANNELS.whatsappForget),
    send: (input: { to: string; body: string }) => ipcRenderer.invoke(IPC_CHANNELS.whatsappSend, input)
  }),
  /** Step one: an enquiry arrives. */
  enquiries: Object.freeze({
    add: (input: {
      channel: string;
      rawText: string;
      partyName: string | null;
      partyPhone: string | null;
    }) => ipcRenderer.invoke(IPC_CHANNELS.enquiryAdd, input)
  }),
  /** The loop: read a deal, price it, send it, close it. */
  deals: Object.freeze({
    read: (input: { enquiryId: string }) => ipcRenderer.invoke(IPC_CHANNELS.dealRead, input),
    readEnquiry: (input: { enquiryId: string }) => ipcRenderer.invoke(IPC_CHANNELS.dealReadEnquiry, input),
    message: (input: { enquiryId: string }) => ipcRenderer.invoke(IPC_CHANNELS.dealMessage, input),
    draft: (input: { enquiryId: string }) => ipcRenderer.invoke(IPC_CHANNELS.dealDraft, input),
    addLine: (input: {
      quotationId: string;
      description: string;
      quantity: number;
      unitPricePaise: number;
      unit: string | null;
    }) => ipcRenderer.invoke(IPC_CHANNELS.dealAddLine, input),
    removeLine: (input: { quotationId: string; itemId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dealRemoveLine, input),
    pastLines: (input: { like: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dealPastLines, input),
    send: (input: { quotationId: string }) => ipcRenderer.invoke(IPC_CHANNELS.dealSend, input),
    close: (input: {
      quotationId: string;
      state: "won" | "lost" | "no_reply";
      reason: string | null;
    }) => ipcRenderer.invoke(IPC_CHANNELS.dealClose, input),
    triage: (input: { enquiryId: string; triage: "real" | "junk" }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dealTriage, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.dealsList),
    handoff: (input: { enquiryId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dealHandoff, input),
    allowCustomer: (input: { enquiryId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dealAllow, input),
    setCustomer: (input: { enquiryId: string; name: string; phone: string | null }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dealCustomer, input)
  }),
  today: Object.freeze({
    read: () => ipcRenderer.invoke(IPC_CHANNELS.todayRead)
  }),
  cases: Object.freeze({
    previewSource: (input: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesPreviewSource, input),
    addSource: (input: { id: string; token: string; startOffset?: number; endOffset?: number }) => ipcRenderer.invoke(IPC_CHANNELS.casesAddSource, input),
    discardSource: (input: { id: string; token?: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesDiscardSource, input),
    reviewData: (input: CaseDataQuery) => ipcRenderer.invoke(IPC_CHANNELS.casesReviewData, input),
    saveDataReview: (input: CaseDataSave) => ipcRenderer.invoke(IPC_CHANNELS.casesSaveDataReview, input),
    addDataSample: (input: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesAddDataSample, input),
    saveArtifact: (input: CaseArtifactSave) => ipcRenderer.invoke(IPC_CHANNELS.casesSaveArtifact, input),
    acceptArtifact: (input: { id: string; versionId: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesAcceptArtifact, input),
    exportArtifact: (input: { id: string; versionId: string; format?: CaseArtifactFormat }) => ipcRenderer.invoke(IPC_CHANNELS.casesExportArtifact, input),
    exportTurn: (input: { id: string; turnId: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesExportTurn, input),
    localState: (input: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesLocalState, input),
    askLocal: (input: CaseLocalRequest) => ipcRenderer.invoke(IPC_CHANNELS.casesAskLocal, input),
    prepareEnquiry: (input: CaseEnquiryRequest) => ipcRenderer.invoke(IPC_CHANNELS.casesPrepareEnquiry, input),
    saveEnquiryReview: (input: CaseEnquirySave) => ipcRenderer.invoke(IPC_CHANNELS.casesSaveEnquiryReview, input),
    stopLocal: (input: { id: string; operationId: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesStopLocal, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.casesList),
    open: (input: { title: string; question: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.casesOpen, input),
    read: (input: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.casesRead, input),
    say: (input: { id: string; body: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.casesSay, input),
    close: (input: { id: string; verdict: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.casesClose, input),
    erase: async (input: { id: string }) => {
      const result: { erased: boolean } = await ipcRenderer.invoke(IPC_CHANNELS.casesErase, input);
      // A successful erasure must also remove the unsent local draft. A retry
      // can finish this cleanup even if the book row has already gone.
      try { writeComposerDraft(localStorage, input.id, { text: "", selected: [] }); localStorage.removeItem("rellane.workstation.creative-draft.v1." + input.id); }
      catch { throw new Error("The work was erased, but its saved message could not be removed. Try erasing it again."); }
      window.dispatchEvent(new CustomEvent("rellane:case-erased", { detail: input.id }));
      return result;
    }
  }),
  /**
   * A native subscription session, reviewed before it runs.
   *
   * `prepare` returns the exact packet, its hash, the provider, the model and
   * the folder, plus a single-use token that expires in five minutes. `start`
   * takes that token and nothing else — there is deliberately no way to pass a
   * prompt, a path, a model or an approval flag to it, so the thing that runs is
   * the thing the review showed. `stop` and `decide` name one operation id and
   * are refused when it is not the one in flight.
   */
  workstation: Object.freeze({
    creativeBriefs: (input: {caseId: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationCreativeList, input),
    saveCreativeBrief: (input: import("@cadrane/contracts").CreativeBriefInput) => ipcRenderer.invoke(IPC_CHANNELS.workstationCreativeSave, input),
    copyCreativeBrief: (input: {caseId: string; id: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationCreativeCopy, input),
    openCreativeProduct: (input: {caseId: string; id: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationCreativeOpen, input),
    linkCreativeImage: (input: {caseId: string; id: string; imageId: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationCreativeLink, input),
    suggestContext: (input: import("@cadrane/contracts").WorkstationContextSuggestionInput) => ipcRenderer.invoke(IPC_CHANNELS.workstationContextSuggest, input),
    images: (input: {caseId: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationImages, input),
    importImage: (input: {caseId: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationImageImport, input),
    previewImage: (input: {caseId: string; id: string; size: "thumbnail" | "detail"}) => ipcRenderer.invoke(IPC_CHANNELS.workstationImagePreview, input),
    exportImage: (input: {caseId: string; id: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationImageExport, input),
    continuity: () => ipcRenderer.invoke(IPC_CHANNELS.workstationContinuity),
    renameWork: (input: {caseId: string; title: string; expectedTitle: string}) => ipcRenderer.invoke(IPC_CHANNELS.workstationRenameWork, input),
    saveProject: (input: WorkstationProjectSaveInput) => ipcRenderer.invoke(IPC_CHANNELS.workstationProjectSave, input),
    assignProject: (input: WorkstationProjectAssignInput) => ipcRenderer.invoke(IPC_CHANNELS.workstationProjectAssign, input),
    captureProjectBrief: (input: WorkstationProjectCaptureInput) => ipcRenderer.invoke(IPC_CHANNELS.workstationProjectCapture, input),
    saveRoutine: (input: WorkstationRoutineSaveInput) => ipcRenderer.invoke(IPC_CHANNELS.workstationRoutineSave, input),
    routineVersions: (input: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.workstationRoutineVersions, input),
    providers: () => ipcRenderer.invoke(IPC_CHANNELS.workstationProviders, {}),
    /** Opens a Finder picker. The picker is the grant; no path goes in. */
    chooseWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.workstationChooseWorkspace, {}),
    revealWorkspace: (input: { caseId: string; workspaceId?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.workstationRevealWorkspace, input),
    routines: () => ipcRenderer.invoke(IPC_CHANNELS.workstationRoutines, {}),
    prepare: (input: WorkstationPrepareInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.workstationPrepare, input),
    start: (input: { token: string }) => ipcRenderer.invoke(IPC_CHANNELS.workstationStart, input),
    state: (input: { caseId: string }) => ipcRenderer.invoke(IPC_CHANNELS.workstationState, input),
    stop: (input: { caseId: string; operationId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.workstationStop, input),
    decide: (input: { operationId: string; permissionId: string; allow: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.workstationDecide, input),
    checkCitations: (input: WorkstationCheckCitationsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.workstationCheckCitations, input),
    // The newer capabilities. Each is a pass-through and nothing more: the
    // preload decides nothing, so there is one place — the host — where every
    // rule about what may happen actually lives.
    running: () => ipcRenderer.invoke(IPC_CHANNELS.workstationRunning, {}),
    agentStart: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationAgentStart, input),
    agentPoll: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationAgentPoll, input),
    agentStop: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationAgentStop, input),
    dispatchStart: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationDispatchStart, input),
    dispatchPoll: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationDispatchPoll, input),
    dispatchStop: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationDispatchStop, input),
    pairingStatus: () => ipcRenderer.invoke(IPC_CHANNELS.workstationPairingStatus, {}),
    pairingStart: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationPairingStart, input),
    pairingStop: () => ipcRenderer.invoke(IPC_CHANNELS.workstationPairingStop, {}),
    dictationStatus: () => ipcRenderer.invoke(IPC_CHANNELS.workstationDictationStatus, {}),
    dictationWrite: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationDictationWrite, input),
    dictationStop: () => ipcRenderer.invoke(IPC_CHANNELS.workstationDictationStop, {}),
    pickDocument: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationDocumentPick, input),
    documentFormats: () => ipcRenderer.invoke(IPC_CHANNELS.workstationDocumentFormats, {}),
    semanticStatus: () => ipcRenderer.invoke(IPC_CHANNELS.workstationSemanticStatus, {}),
    semanticSearch: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationSemanticSearch, input),
    publishPreview: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationPublishPreview, input),
    publishWrite: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationPublishWrite, input),
    crewStart: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationCrewStart, input),
    crewPoll: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationCrewPoll, input),
    crewStop: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationCrewStop, input),
    telegramWorkStatus: () => ipcRenderer.invoke(IPC_CHANNELS.workstationTelegramStatus, {}),
    telegramNotify: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationTelegramNotify, input),
    agentsList: () => ipcRenderer.invoke(IPC_CHANNELS.workstationAgentsList, {}),
    agentSave: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationAgentSave, input),
    agentDelete: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationAgentDelete, input),
    describeMacAction: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationMacDescribe, input),
    runMacAction: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationMacRun, input),
    readWebPage: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationWebRead, input),
    listFiles: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationFilesList, input),
    previewFile: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationFilePreview, input),
    fileChange: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationFileChange, input),
    parseTable: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationTableParse, input),
    queryTable: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationTableQuery, input),
    searchBook: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationBookSearch, input),
    exportAudit: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationAuditExport, input),
    deliveryPack: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationDeliveryPack, input),
    listCaptureTargets: () => ipcRenderer.invoke(IPC_CHANNELS.workstationCaptureList, {}),
    captureTarget: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationCaptureTake, input),
    analysePaste: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationPasteAnalyse, input),
    researchStart: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationResearchStart, input),
    researchPoll: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationResearchPoll, input),
    researchStop: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationResearchStop, input),
    memoryRead: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationMemoryRead, input),
    memoryLearn: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationMemoryLearn, input),
    memorySet: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationMemorySet, input),
    memoryForget: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationMemoryForget, input),
    changesList: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationChangesList, input),
    changeContents: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationChangeContents, input),
    changeRestore: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationChangeRestore, input),
    watchList: () => ipcRenderer.invoke(IPC_CHANNELS.workstationWatchList, {}),
    watchSave: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationWatchSave, input),
    watchRemove: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationWatchRemove, input),
    watchNow: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationWatchNow, input),
    usage: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationUsage, input),
    phoneKnocks: () => ipcRenderer.invoke(IPC_CHANNELS.workstationPhoneKnocks, {}),
    phonePair: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.workstationPhonePair, input),
  }),
  backup: Object.freeze({
    pickDestination: () => ipcRenderer.invoke(IPC_CHANNELS.backupPick),
    now: () => ipcRenderer.invoke(IPC_CHANNELS.backupNow)
  }),
  connectors: Object.freeze({
    read: () => ipcRenderer.invoke(IPC_CHANNELS.connectorsRead)
  }),
  dispatch: Object.freeze({
    stage: (input: { agentId: string; channel: string; address: string; text: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.dispatchStage, input)
  }),
  desk: Object.freeze({
    /**
     * Says one thing to Rellane and gets an answer.
     *
     * A front door, not a new authority: what comes back is either words or the
     * name of a surface to open. It cannot itself store, send or touch anything.
     */
    say: (input: { text: string }) => ipcRenderer.invoke(IPC_CHANNELS.deskSay, input)
  }),
  bench: Object.freeze({
    run: (input: { question: string }) => ipcRenderer.invoke(IPC_CHANNELS.benchRun, input),
    /**
     * What this Mac's own arguments say about which engine to trust.
     *
     * Reports; it does not route. Counts and engine labels only — never a
     * question and never a turn.
     */
    routing: () => ipcRenderer.invoke(IPC_CHANNELS.benchRouting)
  }),
  localShortcuts: Object.freeze({
    begin: (input: { kind: import("@cadrane/contracts").LocalShortcutKind }) => ipcRenderer.invoke(IPC_CHANNELS.localShortcutBegin, input),
    stop: (input: { handle: string }) => ipcRenderer.invoke(IPC_CHANNELS.localShortcutStop, input)
  }),
  agents: Object.freeze({
    list: () => ipcRenderer.invoke(IPC_CHANNELS.agentsList),
    run: (input: { agentId: string; question: string; sourceToken?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsRun, input),
    previewSource: (input: { agentId: string }) => ipcRenderer.invoke(IPC_CHANNELS.agentPreviewSource, input),
    discardSource: (input: { agentId: string; token?: string }) => ipcRenderer.invoke(IPC_CHANNELS.agentDiscardSource, input),
    draft: (input: { handle: string; sentence: string }) => ipcRenderer.invoke(IPC_CHANNELS.agentDraft, input),
    save: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.agentSave, input),
    /** Writes the brief to a file that carries no folders and no permissions. */
    exportOne: (input: { agentId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentExport, input),
    /** Reads a brief somebody sent. Shows it; saves nothing. */
    importOne: () => ipcRenderer.invoke(IPC_CHANNELS.agentImport),
    /** Stops a run in flight. The record shows it as stopped, not failed. */
    stop: (input: { agentId: string }) => ipcRenderer.invoke(IPC_CHANNELS.agentsStop, input),
    remove: (input: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.agentDelete, input)
  }),
  engines: Object.freeze({
    room: () => ipcRenderer.invoke(IPC_CHANNELS.engineRoom)
  }),
  timeline: Object.freeze({
    captures: (input: { folder: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.timelineCaptures, input),
    diff: (input: { folder: string; from: string; to: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.timelineDiff, input),
    checkpoint: (input: { folder: string; reason: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.timelineCheckpoint, input),
    hash: (input: { folder: string; path: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.timelineHash, input)
  }),
  skills: Object.freeze({
    catalogue: () => ipcRenderer.invoke(IPC_CHANNELS.skillCatalogue),
    preview: (input: { skill: string; path: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.skillPreview, input),
    run: (input: { planId: string }) => ipcRenderer.invoke(IPC_CHANNELS.skillRun, input),
    undo: (input: { receiptId: string }) => ipcRenderer.invoke(IPC_CHANNELS.skillUndo, input)
  }),
  subscription: Object.freeze({
    status: () => ipcRenderer.invoke(IPC_CHANNELS.subscriptionStatus, {}),
    dock: (input: { providerId: "claude" | "antigravity" | "gemini" }) =>
      ipcRenderer.invoke(IPC_CHANNELS.subscriptionDock, input),
    undock: () => ipcRenderer.invoke(IPC_CHANNELS.subscriptionUndock, {}),
    ask: (input: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      modelId?: string;
    }) => ipcRenderer.invoke(IPC_CHANNELS.subscriptionAsk, input)
  })
});

// `window.cadrane`. Renamed with the packages: this is a runtime-only name with
// nothing persisted under it, unlike the `switchboard://` scheme below, which is
// the origin localStorage is keyed to and therefore cannot be renamed safely.
contextBridge.exposeInMainWorld("cadrane", bridge);

/**
 * The overlay's own bridge, kept separate and minimal.
 *
 * The overlay is a global hotkey surface, so its attack surface deserves to be
 * as small as it can be: two calls, no state, no filesystem, no models.
 */
const overlayBridge = Object.freeze({
  hide: () => ipcRenderer.invoke("cadrane:overlay:hide"),
  run: (input: { kind: string; id: string; query: string }) =>
    ipcRenderer.invoke("cadrane:overlay:run", input)
});

contextBridge.exposeInMainWorld("cadraneOverlay", overlayBridge);
