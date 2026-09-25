import { DESKTOP_BRIDGE_VERSION } from "@cadrane/contracts";

const IPC_PREFIX = `cadrane:v${DESKTOP_BRIDGE_VERSION}` as const;

/**
 * Main and preload import one version-derived channel table. A stale v1
 * preload therefore has no matching handler after the v2 bridge is activated.
 */
export const IPC_CHANNELS = Object.freeze({
  systemProfile: `${IPC_PREFIX}:system-profile`,
  runtimeDiscover: `${IPC_PREFIX}:runtime-discover`,
  runtimeChat: `${IPC_PREFIX}:runtime-chat`,
  runtimeCancel: `${IPC_PREFIX}:runtime-cancel`,
  automationSnapshot: `${IPC_PREFIX}:automation-snapshot`,
  automationAgentSave: `${IPC_PREFIX}:automation-agent-save`,
  automationWorkflowSave: `${IPC_PREFIX}:automation-workflow-save`,
  automationWorkflowSaveReviewBound: `${IPC_PREFIX}:automation-workflow-save-review-bound`,
  automationMemorySave: `${IPC_PREFIX}:automation-memory-save`,
  automationSourceImport: `${IPC_PREFIX}:automation-source-import`,
  automationArtifactReview: `${IPC_PREFIX}:automation-artifact-review`,
  automationConnectorEnsureLocal: `${IPC_PREFIX}:automation-connector-ensure-local`,
  automationPackExport: `${IPC_PREFIX}:automation-pack-export`,
  automationDryRun: `${IPC_PREFIX}:automation-dry-run`,
  automationBacktest: `${IPC_PREFIX}:automation-backtest`,
  engineKeySave: `${IPC_PREFIX}:engine-key-save`,
  engineKeyForget: `${IPC_PREFIX}:engine-key-forget`,
  engineKeyStatus: `${IPC_PREFIX}:engine-key-status`,
  benchRouting: `${IPC_PREFIX}:bench-routing`,
  deskSay: `${IPC_PREFIX}:desk-say`,
  bookReadFile: `${IPC_PREFIX}:book-read-file`,
  openLink: `${IPC_PREFIX}:open-link`,
  flowTemplates: `${IPC_PREFIX}:flow-templates`,
  flowFromTemplate: `${IPC_PREFIX}:flow-from-template`,
  automationPackImport: `${IPC_PREFIX}:automation-pack-import`,
  automationRunStart: `${IPC_PREFIX}:automation-run-start`,
  automationRunAction: `${IPC_PREFIX}:automation-run-action`,
  modelRecommend: `${IPC_PREFIX}:model-recommend`,
  modelPickGguf: `${IPC_PREFIX}:model-pick-gguf`,
  modelInstallations: `${IPC_PREFIX}:model-installations`,
  modelLicenseReview: `${IPC_PREFIX}:model-license-review`,
  modelLicenseAcknowledge: `${IPC_PREFIX}:model-license-acknowledge`,
  modelInstall: `${IPC_PREFIX}:model-install`,
  modelInstallCancel: `${IPC_PREFIX}:model-install-cancel`,
  subscriptionAsk: `${IPC_PREFIX}:subscription-ask`,
  subscriptionDock: `${IPC_PREFIX}:subscription-dock`,
  subscriptionUndock: `${IPC_PREFIX}:subscription-undock`,
  subscriptionStatus: `${IPC_PREFIX}:subscription-status`,
  workspaceGrant: `${IPC_PREFIX}:workspace-grant`,
  workspaceRevoke: `${IPC_PREFIX}:workspace-revoke`,
  diagnosticsBundle: `${IPC_PREFIX}:diagnostics-bundle`,
  settingsRead: `${IPC_PREFIX}:settings-read`,
  settingsWrite: `${IPC_PREFIX}:settings-write`,
  workspaceRoots: `${IPC_PREFIX}:workspace-roots`,
  workspaceLost: `${IPC_PREFIX}:workspace-lost`,
  activityRead: `${IPC_PREFIX}:activity-read`,
  engineRoom: `${IPC_PREFIX}:engine-room`,
  agentsList: `${IPC_PREFIX}:agents-list`,
  agentsRun: `${IPC_PREFIX}:agents-run`,
  agentPreviewSource: `${IPC_PREFIX}:agent-preview-source`,
  agentDiscardSource: `${IPC_PREFIX}:agent-discard-source`,
  benchRun: `${IPC_PREFIX}:bench-run`,
  dispatchStage: `${IPC_PREFIX}:dispatch-stage`,
  connectorsRead: `${IPC_PREFIX}:connectors-read`,
  backupPick: `${IPC_PREFIX}:backup-pick`,
  backupNow: `${IPC_PREFIX}:backup-now`,
  bookRead: `${IPC_PREFIX}:book-read`,
  vaultSync: `${IPC_PREFIX}:vault-sync`,
  vaultReveal: `${IPC_PREFIX}:vault-reveal`,
  agentsStop: `${IPC_PREFIX}:agents-stop`,
  agentExport: `${IPC_PREFIX}:agent-export`,
  agentImport: `${IPC_PREFIX}:agent-import`,
  updateCheck: `${IPC_PREFIX}:update-check`,
  updateOpen: `${IPC_PREFIX}:update-open`,
  memoryRead: `${IPC_PREFIX}:memory-read`,
  memoryHide: `${IPC_PREFIX}:memory-hide`,
  workspacePause: `${IPC_PREFIX}:workspace-pause`,
  bookStanding: `${IPC_PREFIX}:book-standing`,
  bookAddParty: `${IPC_PREFIX}:book-add-party`,
  bookAddInvoice: `${IPC_PREFIX}:book-add-invoice`,
  bookAddPayment: `${IPC_PREFIX}:book-add-payment`,
  todayRead: `${IPC_PREFIX}:today-read`,
  // The loop (D-111): one enquiry's life, and the three things that move it on.
  // Mark's bot token. The token itself never crosses back to the renderer.
  telegramStatus: `${IPC_PREFIX}:telegram-status`,
  telegramSave: `${IPC_PREFIX}:telegram-save`,
  telegramForget: `${IPC_PREFIX}:telegram-forget`,
  // The business number, and where its inbound messages wait. The token is a
  // credential the same way the bot token is: it can say anything, as the
  // business, to every customer it has.
  whatsappStatus: `${IPC_PREFIX}:whatsapp-status`,
  whatsappSave: `${IPC_PREFIX}:whatsapp-save`,
  whatsappForget: `${IPC_PREFIX}:whatsapp-forget`,
  whatsappSend: `${IPC_PREFIX}:whatsapp-send`,
  // Step one of the loop: something a customer asked for a price on.
  enquiryAdd: `${IPC_PREFIX}:enquiry-add`,
  dealRead: `${IPC_PREFIX}:deal-read`,
  // Proposes what the customer asked for. Writes nothing.
  dealReadEnquiry: `${IPC_PREFIX}:deal-read-enquiry`,
  dealDraft: `${IPC_PREFIX}:deal-draft`,
  dealAddLine: `${IPC_PREFIX}:deal-add-line`,
  // Takes one back off, because a price typed wrong could only be typed once.
  dealRemoveLine: `${IPC_PREFIX}:deal-remove-line`,
  // What this shop charged for work like this before. Recall, not a proposal.
  dealPastLines: `${IPC_PREFIX}:deal-past-lines`,
  // The words a customer would read. Composed, never sent.
  dealMessage: `${IPC_PREFIX}:deal-message`,
  dealSend: `${IPC_PREFIX}:deal-send`,
  dealClose: `${IPC_PREFIX}:deal-close`,
  // Not every message is work. Junk leaves Today by this door and no other.
  dealTriage: `${IPC_PREFIX}:deal-triage`,
  // Every deal, closed ones included. The rail's second word.
  dealsList: `${IPC_PREFIX}:deals-list`,
  // Opens WhatsApp with the quotation typed in. It does not send it.
  dealHandoff: `${IPC_PREFIX}:deal-handoff`,
  // Adds this one customer to the outbound list. One recipient, one press.
  dealAllow: `${IPC_PREFIX}:deal-allow`,
  // Who an enquiry turned out to be from. Usually learned after it arrived.
  dealCustomer: `${IPC_PREFIX}:deal-customer`,
  casesList: `${IPC_PREFIX}:cases-list`,
  casesOpen: `${IPC_PREFIX}:cases-open`,
  casesRead: `${IPC_PREFIX}:cases-read`,
  casesArtifactLineage: `${IPC_PREFIX}:cases-artifact-lineage`,
  casesPreviewArtifactEdit: `${IPC_PREFIX}:cases-preview-artifact-edit`,
  casesApplyArtifactEdit: `${IPC_PREFIX}:cases-apply-artifact-edit`,
  casesPreviewSource: `${IPC_PREFIX}:cases-preview-source`,
  casesAddSource: `${IPC_PREFIX}:cases-add-source`,
  casesReviewData: `${IPC_PREFIX}:cases-review-data`,
  casesSaveDataReview: `${IPC_PREFIX}:cases-save-data-review`,
  casesAddDataSample: `${IPC_PREFIX}:cases-add-data-sample`,
  casesDiscardSource: `${IPC_PREFIX}:cases-discard-source`,
  casesSaveArtifact: `${IPC_PREFIX}:cases-save-artifact`,
  casesAcceptArtifact: `${IPC_PREFIX}:cases-accept-artifact`,
  casesExportArtifact: `${IPC_PREFIX}:cases-export-artifact`,
  casesExportTurn: `${IPC_PREFIX}:cases-export-turn`,
  casesLocalState: `${IPC_PREFIX}:cases-local-state`,
  casesAskLocal: `${IPC_PREFIX}:cases-ask-local`,
  casesPrepareEnquiry: `${IPC_PREFIX}:cases-prepare-enquiry`,
  casesSaveEnquiryReview: `${IPC_PREFIX}:cases-save-enquiry-review`,
  casesStopLocal: `${IPC_PREFIX}:cases-stop-local`,
  casesSay: `${IPC_PREFIX}:cases-say`,
  casesClose: `${IPC_PREFIX}:cases-close`,
  casesErase: `${IPC_PREFIX}:cases-erase`,
  /**
   * The workstation: a native subscription session, reviewed before it runs.
   *
   * Seven channels, and only two of them can change anything. `providers`,
   * `routines` and `state` read. `choose-workspace` opens a Finder picker and
   * returns an opaque id — the picker is the grant, so there is no way to pass a
   * path in. `prepare` validates a case, its explicitly selected turns and the
   * provider, and returns the exact outgoing packet with its hash for a person
   * to read; it starts nothing. `start` takes that review's single-use token and
   * nothing else, so no field on the wire can widen what runs. `stop` and
   * `decide` are both bound to one operation id and refuse a stale one.
   */
  workstationProviders: `${IPC_PREFIX}:workstation-providers`,
  workstationChooseWorkspace: `${IPC_PREFIX}:workstation-choose-workspace`,
  workstationRevealWorkspace: `${IPC_PREFIX}:workstation-reveal-workspace`,
  workstationContinuity: `${IPC_PREFIX}:workstation-continuity`,
  workstationContextSuggest: `${IPC_PREFIX}:workstation-context-suggest`,
  workstationImages: `${IPC_PREFIX}:workstation-images`,
  workstationImageImport: `${IPC_PREFIX}:workstation-image-import`,
  workstationImagePreview: `${IPC_PREFIX}:workstation-image-preview`,
  workstationImageExport: `${IPC_PREFIX}:workstation-image-export`,
  workstationCreativeList: `${IPC_PREFIX}:workstation-creative-list`,
  workstationCreativeSave: `${IPC_PREFIX}:workstation-creative-save`,
  workstationCreativeCopy: `${IPC_PREFIX}:workstation-creative-copy`,
  workstationCreativeOpen: `${IPC_PREFIX}:workstation-creative-open`,
  workstationCreativeLink: `${IPC_PREFIX}:workstation-creative-link`,
  workstationRenameWork: `${IPC_PREFIX}:workstation-rename-work`,
  workstationProjectSave: `${IPC_PREFIX}:workstation-project-save`,
  workstationProjectAssign: `${IPC_PREFIX}:workstation-project-assign`,
  workstationProjectCapture: `${IPC_PREFIX}:workstation-project-capture`,
  workstationRoutineSave: `${IPC_PREFIX}:workstation-routine-save`,
  workstationRoutineVersions: `${IPC_PREFIX}:workstation-routine-versions`,
  workstationRoutines: `${IPC_PREFIX}:workstation-routines`,
  workstationPrepare: `${IPC_PREFIX}:workstation-prepare`,
  workstationStart: `${IPC_PREFIX}:workstation-start`,
  workstationState: `${IPC_PREFIX}:workstation-state`,
  workstationRunning: `${IPC_PREFIX}:workstation-running`,
  // Reviewed 2026-09-25. Automation graph v2 nodes run through the single
  // shared WorkstationHost: prepare validates the Case, sources, agent revision
  // and pinned local model without calling any model; start consumes a one-use
  // owner review token; stop cancels the bound operation; reconcile settles
  // interrupted attempts against durable Book evidence without replay.
  workstationGraphPrepare: `${IPC_PREFIX}:workstation-graph-prepare`,
  workstationGraphStart: `${IPC_PREFIX}:workstation-graph-start`,
  workstationGraphStop: `${IPC_PREFIX}:workstation-graph-stop`,
  workstationGraphReconcile: `${IPC_PREFIX}:workstation-graph-reconcile`,
  // The step-by-step agent: start it, watch it, stop it. Three channels rather
  // than one long call, because a run the owner cannot see is a run he cannot
  // judge — and one he cannot stop is not one he authorised.
  workstationAgentPrepare: `${IPC_PREFIX}:workstation-agent-prepare`,
  workstationAgentStart: `${IPC_PREFIX}:workstation-agent-start`,
  workstationAgentPoll: `${IPC_PREFIX}:workstation-agent-poll`,
  workstationAgentStop: `${IPC_PREFIX}:workstation-agent-stop`,
  // Several subscriptions on one brief at once.
  workstationDispatchPrepare: `${IPC_PREFIX}:workstation-dispatch-prepare`,
  workstationDispatchStart: `${IPC_PREFIX}:workstation-dispatch-start`,
  workstationDispatchPoll: `${IPC_PREFIX}:workstation-dispatch-poll`,
  workstationDispatchStop: `${IPC_PREFIX}:workstation-dispatch-stop`,
  // Continuing on a phone. Status is separate from start precisely so a screen
  // can report what is listening rather than what was asked for.
  workstationPairingStatus: `${IPC_PREFIX}:workstation-pairing-status`,
  workstationPairingStart: `${IPC_PREFIX}:workstation-pairing-start`,
  workstationPairingStop: `${IPC_PREFIX}:workstation-pairing-stop`,
  workstationPairingHandoverCandidates: `${IPC_PREFIX}:workstation-pairing-handover-candidates`,
  workstationPairingHandoverPrepare: `${IPC_PREFIX}:workstation-pairing-handover-prepare`,
  workstationPairingHandoverApprove: `${IPC_PREFIX}:workstation-pairing-handover-approve`,
  // Speaking instead of typing. The transcript lands in the composer and is
  // reviewed like anything else; this channel never sends it anywhere.
  workstationDictationStatus: `${IPC_PREFIX}:workstation-dictation-status`,
  workstationDictationWrite: `${IPC_PREFIX}:workstation-dictation-write`,
  workstationDictationStop: `${IPC_PREFIX}:workstation-dictation-stop`,
  // Reading a file the owner picked. Previews only; adding it is a separate step.
  workstationDocumentPick: `${IPC_PREFIX}:workstation-document-pick`,
  workstationDocumentFormats: `${IPC_PREFIX}:workstation-document-formats`,
  // Finding work by what it was about rather than the words it used. Status is
  // separate because the answer is different with and without a local model,
  // and a search that quietly matched words while claiming meaning would be the
  // same lie this wave exists to remove.
  workstationSemanticStatus: `${IPC_PREFIX}:workstation-semantic-status`,
  workstationSemanticSearch: `${IPC_PREFIX}:workstation-semantic-search`,
  // Turning a finished output into a file he can send. Preview and write are
  // separate so nothing reaches the disk before he has seen what will.
  workstationPublishPreview: `${IPC_PREFIX}:workstation-publish-preview`,
  workstationPublishWrite: `${IPC_PREFIX}:workstation-publish-write`,
  // Several bots on one request, each taking a part. Start, watch, stop — the
  // same three the single-bot agent has, because they are the same question
  // asked of one thing or of four.
  workstationCrewPrepare: `${IPC_PREFIX}:workstation-crew-prepare`,
  workstationCrewStart: `${IPC_PREFIX}:workstation-crew-start`,
  workstationCrewPoll: `${IPC_PREFIX}:workstation-crew-poll`,
  workstationCrewStop: `${IPC_PREFIX}:workstation-crew-stop`,
  // Work asked for from his phone. `handle` stages; it never approves, and the
  // Stop that matters does not travel through Telegram.
  workstationTelegramStatus: `${IPC_PREFIX}:workstation-telegram-status`,
  workstationTelegramNotify: `${IPC_PREFIX}:workstation-telegram-notify`,
  // An agent is a page of instructions he can read and edit. These are the shelf.
  workstationAgentsList: `${IPC_PREFIX}:workstation-agents-list`,
  workstationAgentSave: `${IPC_PREFIX}:workstation-agent-save`,
  workstationAgentDelete: `${IPC_PREFIX}:workstation-agent-delete`,
  // What he has actually asked of each subscription. Counted from receipts this
  // app wrote; it cannot see a provider's own quota and does not pretend to.
  workstationUsage: `${IPC_PREFIX}:workstation-usage`,
  workstationModelOutcomeEvidence: `${IPC_PREFIX}:workstation-model-outcome-evidence`,
  workstationModelPreferencesRead: `${IPC_PREFIX}:workstation-model-preferences-read`,
  workstationModelPreferencesSave: `${IPC_PREFIX}:workstation-model-preferences-save`,
  workstationModelPreferencesForget: `${IPC_PREFIX}:workstation-model-preferences-forget`,
  workstationSoloModelAdvice: `${IPC_PREFIX}:workstation-solo-model-advice`,
  workstationTeamModelAdvice: `${IPC_PREFIX}:workstation-team-model-advice`,
  workstationModelAdaptationPropose: `${IPC_PREFIX}:workstation-model-adaptation-propose`,
  workstationModelAdaptationAccept: `${IPC_PREFIX}:workstation-model-adaptation-accept`,
  // Everything probed at once, so a screen can say what is working. A probe
  // that fails reports its fact as unknown, never as a pass.
  workstationSelfCheck: `${IPC_PREFIX}:workstation-self-check`,
  // Going and reading, rather than answering from memory. Start, watch, stop —
  // the same three every long-running thing here has.
  workstationResearchPrepare: `${IPC_PREFIX}:workstation-research-prepare`,
  workstationResearchStart: `${IPC_PREFIX}:workstation-research-start`,
  workstationResearchPoll: `${IPC_PREFIX}:workstation-research-poll`,
  workstationResearchStop: `${IPC_PREFIX}:workstation-research-stop`,
  // What it worked out about a project, and the controls to strike any of it
  // out. The most sensitive store in this app: it is what the app believes
  // about his business, and nothing here sends it anywhere he has not reviewed.
  workstationMemoryRead: `${IPC_PREFIX}:workstation-memory-read`,
  workstationMemoryLearn: `${IPC_PREFIX}:workstation-memory-learn`,
  workstationMemorySet: `${IPC_PREFIX}:workstation-memory-set`,
  workstationMemoryForget: `${IPC_PREFIX}:workstation-memory-forget`,
  workstationMemoryGoverned: `${IPC_PREFIX}:workstation:memory:governed`,
  workstationMemoryConflicts: `${IPC_PREFIX}:workstation:memory:conflicts`,
  // Who has messaged the bot and is not yet obeyed, and saying that one is him.
  // Without these the contact list can never gain its first entry: a fresh
  // install obeys nobody, and nothing told him what his own chat id was.
  workstationPhoneKnocks: `${IPC_PREFIX}:workstation-phone-knocks`,
  workstationPhonePair: `${IPC_PREFIX}:workstation-phone-pair`,
  // Keeping an eye on a page, a folder or a routine between visits, and saying
  // so only when something he would care about actually moved.
  workstationWatchList: `${IPC_PREFIX}:workstation-watch-list`,
  workstationWatchSave: `${IPC_PREFIX}:workstation-watch-save`,
  workstationWatchRemove: `${IPC_PREFIX}:workstation-watch-remove`,
  workstationWatchNow: `${IPC_PREFIX}:workstation-watch-now`,
  workstationScheduleList: `${IPC_PREFIX}:workstation-schedule-list`,
  workstationScheduleSave: `${IPC_PREFIX}:workstation-schedule-save`,
  workstationSchedulePreview: `${IPC_PREFIX}:workstation-schedule-preview`,
  workstationScheduleGrantReview: `${IPC_PREFIX}:workstation-schedule-grant-review`,
  workstationScheduleGrantConfirm: `${IPC_PREFIX}:workstation-schedule-grant-confirm`,
  workstationScheduleRevoke: `${IPC_PREFIX}:workstation-schedule-revoke`,
  workstationScheduleQueue: `${IPC_PREFIX}:workstation-schedule-queue`,
  workstationSchedulePrepare: `${IPC_PREFIX}:workstation-schedule-prepare`,
  workstationScheduleStart: `${IPC_PREFIX}:workstation-schedule-start`,
  workstationSchedulePoll: `${IPC_PREFIX}:workstation-schedule-poll`,
  workstationScheduleStop: `${IPC_PREFIX}:workstation-schedule-stop`,
  // What a session changed on his Mac, and putting it back. Matters more now
  // that a phone can start one.
  workstationChangesList: `${IPC_PREFIX}:workstation-changes-list`,
  workstationChangeContents: `${IPC_PREFIX}:workstation-change-contents`,
  workstationChangeRestore: `${IPC_PREFIX}:workstation-change-restore`,
  workstationStop: `${IPC_PREFIX}:workstation-stop`,
  workstationDecide: `${IPC_PREFIX}:workstation-decide`,
  workstationCheckCitations: `${IPC_PREFIX}:workstation-check-citations`,
  workstationDocumentImport: `${IPC_PREFIX}:workstation-document-import`,
  workstationSpeak: `${IPC_PREFIX}:workstation-speak`,
  // Capabilities that existed as tested modules with nothing able to call them.
  // Every one is trusted-sender-only and bounded; the two that touch the world
  // — a Mac action and a web read — are each described and approved first.
  workstationMacDescribe: `${IPC_PREFIX}:workstation-mac-describe`,
  workstationMacRun: `${IPC_PREFIX}:workstation-mac-run`,
  workstationWebRead: `${IPC_PREFIX}:workstation-web-read`,
  workstationFilesList: `${IPC_PREFIX}:workstation-files-list`,
  workstationFilePreview: `${IPC_PREFIX}:workstation-file-preview`,
  workstationFileChange: `${IPC_PREFIX}:workstation-file-change`,
  workstationTableParse: `${IPC_PREFIX}:workstation-table-parse`,
  workstationTableQuery: `${IPC_PREFIX}:workstation-table-query`,
  workstationBookSearch: `${IPC_PREFIX}:workstation-book-search`,
  workstationAuditExport: `${IPC_PREFIX}:workstation-audit-export`,
  workstationDeliveryPack: `${IPC_PREFIX}:workstation-delivery-pack`,
  workstationPortableWorkspace: `${IPC_PREFIX}:workstation-portable-workspace`,
  workstationRecovery: `${IPC_PREFIX}:workstation-recovery`,
  workstationCaptureList: `${IPC_PREFIX}:workstation-capture-list`,
  workstationCaptureTake: `${IPC_PREFIX}:workstation-capture-take`,
  workstationPasteAnalyse: `${IPC_PREFIX}:workstation-paste-analyse`,
  agentDraft: `${IPC_PREFIX}:agent-draft`,
  agentDraftHistory: `${IPC_PREFIX}:agent-draft-history`,
  agentDraftForget: `${IPC_PREFIX}:agent-draft-forget`,
  localShortcutBegin: `${IPC_PREFIX}:local-shortcut-begin`,
  localShortcutStop: `${IPC_PREFIX}:local-shortcut-stop`,
  agentSave: `${IPC_PREFIX}:agent-save`,
  agentDelete: `${IPC_PREFIX}:agent-delete`,
  timelineCaptures: `${IPC_PREFIX}:timeline-captures`,
  timelineDiff: `${IPC_PREFIX}:timeline-diff`,
  timelineCheckpoint: `${IPC_PREFIX}:timeline-checkpoint`,
  timelineHash: `${IPC_PREFIX}:timeline-hash`,
  skillCatalogue: `${IPC_PREFIX}:skill-catalogue`,
  skillPreview: `${IPC_PREFIX}:skill-preview`,
  skillRun: `${IPC_PREFIX}:skill-run`,
  skillUndo: `${IPC_PREFIX}:skill-undo`
} as const);

/**
 * The push channel for a run in flight.
 *
 * Not in `IPC_CHANNELS` because it is not invokable: nothing calls it, the main
 * process sends on it. Keeping it out of that object is what lets the reviewed
 * inventory test mean "every channel the renderer may call".
 */
export const AGENT_PROGRESS_EVENT = "cadrane:agent-progress";

/** The push channel for a Bench turn landing. Not invokable, same as above. */
export const BENCH_PROGRESS_EVENT = "cadrane:bench-progress";
