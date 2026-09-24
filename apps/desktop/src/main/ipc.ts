import { WorkstationContextSuggestionInputSchema } from "@cadrane/contracts";
import { suggestLocalContext } from "./workstation/local-context.js";
import { artifactVersions, saveArtifact, acceptArtifact } from "./workroom/artifacts.js";
import { exportArtifactVersion, exportReceipts, isExporting } from "./workroom/exports.js";
import { LocalWorkroom, type LocalWorkroomDeps } from "./workroom/local.js";
import { installWorkstationIpc, type WorkstationIpc } from "./workstation/ipc.js";
import { WorkroomSourceIntake } from "./workroom/sources.js";
import { reviewData, saveDataReview, addDataSample } from "./workroom/data-review.js";
import { saveEnquiryReview } from "./workroom/enquiry.js";
import { CaseEnquiryRequestSchema, CaseEnquirySaveSchema } from "@cadrane/contracts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import {
  AutomationAgentSaveInputSchema,
  AutomationAgentSchema,
  AutomationArtifactReviewInputSchema,
  AutomationArtifactSchema,
  AutomationConnectorEnsureLocalInputSchema,
  AutomationConnectorSchema,
  AutomationMemoryDocumentSaveInputSchema,
  AutomationMemoryDocumentSchema,
  AutomationRunActionInputSchema,
  AutomationRunSnapshotSchema,
  AutomationDryRunInputSchema,
  AutomationDryRunSchema,
  AutomationRunStartInputSchema,
  AutomationSourceDocumentSchema,
  AutomationWorkflowSaveInputSchema,
  AutomationWorkflowSchema,
  AutomationWorkflowPackExportInputSchema,
  AutomationWorkflowPackFileResultSchema,
  AutomationWorkflowPackSchema,
  AutomationWorkspaceSnapshotSchema,
  ConciergeSnapshotSchema,
  type DaemonRequest,
  GgufInspectionSchema,
  HardwareProfileSchema,
  LicenseAcceptanceIntentSchema,
  LicenseAcknowledgementSchema,
  LocalChatRequestSchema,
  CaseLocalRequestSchema,
  CaseArtifactSaveSchema,
  CaseSourceCommitSchema,
  CaseDataQuerySchema,
  CaseDataSaveSchema,
  CaseArtifactExportSchema,
  LocalChatResultSchema,
  ModelInstallCancelRequestSchema,
  ModelInstallCancelResultSchema,
  ModelInstallSnapshotSchema,
  ModelInstallStartIntentSchema,
  ModelInstallStatusSchema,
  ModelLicenseReviewSchema,
  RuntimeDescriptorSchema,
  type BrainStatus
} from "@cadrane/contracts";
import { z } from "zod";
import { DaemonClient } from "./daemon-client.js";
import { RuntimeBoundaryError, SubscriptionBrain } from "./subscription-brain/index.js";
import { SkillHost } from "./skills/host.js";
import { localRuntimeStatus } from "./runtime-status.js";
import type { Contact, StoredAgent } from "./foundations/settings.js";
import { SettingsStore, withHeldGrants } from "./foundations/settings.js";
import { diagnostics } from "./foundations/diagnostics.js";
import { describePermissions, loadSkills } from "./skills/manifest.js";
import {
  isTrustedRendererUrl,
  resolveRendererTarget
} from "./renderer-trust.js";
import { AGENT_PROGRESS_EVENT, IPC_CHANNELS } from "../shared/ipc-channels.js";
import { readActivity } from "./activity.js";
import { ManifestStore } from "./timeline/manifest-store.js";
import { FolderWatcher } from "./timeline/watcher.js";
import { TimelineService } from "./timeline/timeline-service.js";
import { readEngineRoom } from "./subscription-brain/engine-room.js";
import { agentCards } from "./agents/cards.js";
import { runAgentById, stopAgent, assertAgentWorkroomIdle } from "./agents/service.js";
import { createAgentSourceState, previewAgentSource, consumeAgentSource, discardAgentSource } from "./agents/sources.js";
import { createAgentSourceOwners } from "./agents/source-owner.js";
import { installWorkstationImages } from "./workstation/image-ipc.js";
import { installWorkstationCreative } from "./workstation/creative-ipc.js";
import { fromFile as briefFromFile, toFile as briefToFile } from "./agents/share.js";
import { findAgent, SHIPPED_IDS } from "./agents/roster.js";
import { draftLocalBrief } from "./agents/draft.js";
import { createLocalShortcuts } from "./local-shortcuts.js";
import { BILL_TEXT_LIMIT, LocalShortcutKindSchema, type LocalShortcutKind } from "@cadrane/contracts";
import type { Ceiling } from "./agents/brief.js";
import { declineUnreviewedBench } from "./bench/service.js";
import { remember, routing } from "./bench/corpus.js";
import { say as deskSay } from "./desk/service.js";
import { readDocument, MAX_BYTES } from "./book/read-document.js";
import { stageMessage } from "./dispatch/stage.js";
import { readConnectors } from "./mcp/service.js";
import { isDue, runBackup, whyUnsuitable } from "./book/schedule.js";
import { backupSecret as deriveBackupSecret, openTheBook } from "./book/open.js";
import {
  allCases,
  appendTurn,
  closeCase,
  eraseCase,
  openCase,
  readCase,
  turnsFor
} from "./book/cases.js";
import { addInvoice, addParty, addPayment, billsFor, addEnquiry, addQuotationItem, closeQuotation, counts, draftQuotation, findOrAddParty, bookIsUntouched, deals, outstanding, pastLines, removeQuotationItem, setDealCustomer, triageEnquiry, overdue, owing, readDeal, readDealForQuotation, sendQuotation, today, totalOwedPaise } from "./book/records.js";
import { syncVault } from "./vault/sync.js";
import { whatItHasSeen, type FolderSighting } from "./glossary/memory.js";
import { backtest } from "./flows/backtest.js";
import { fromTemplate, TEMPLATES } from "./flows/templates.js";
import { keyedEngine } from "./subscription-brain/api-key.js";
import { checkForUpdate, RELEASES_URL } from "./foundations/version.js";
import { hideTerm, unhideTerm } from "./glossary/terms.js";
import { vaultFolder } from "./vault/where.js";
import { extractLocalBill } from "./book/extract.js";
import { readEnquiryLocal } from "./book/enquiry-local.js";
import { quotationMessage } from "./book/quotation-message.js";
import { OutboundLock } from "./dispatch/outbound-lock.js";
import { handoffQuotation } from "./dispatch/quotation-handoff.js";
import { isTelegramToken, telegramTokenStore } from "./dispatch/telegram-token.js";
import { whatsAppConfigStore } from "./dispatch/whatsapp-config.js";
import { sendText as sendWhatsAppText } from "./dispatch/whatsapp-cloud.js";
import type { Channel } from "./dispatch/mark.js";
import { describeIntegrity, Ledger } from "./security/ledger.js";
import { SecretStore } from "./security/secrets.js";

export { IPC_CHANNELS } from "../shared/ipc-channels.js";

/**
 * One brain per main process. It holds the docked CLI and serialises calls to
 * it, so it must be shared rather than constructed per request.
 */
const subscriptionBrain = new SubscriptionBrain();

/**
 * Granted folders, live plans and undo snapshots. Main-process only — the
 * renderer receives ids and sentences, never a path it could replay.
 */
export const skillHost = new SkillHost();

/** Settings live beside the app's own data, never in the granted folders. */
let settingsStore: SettingsStore | null = null;

/**
 * The workstation's sessions, held here so quitting can reach them.
 *
 * Set when the handlers are installed. `workstationShutdown` belongs in the
 * app's ordered cleanup *before* the book is closed: a session interrupted by a
 * quit still has a partial answer and an interrupted receipt to write, and a
 * closed book would lose both.
 */
let workstationSessions: WorkstationIpc | null = null;

export async function workstationShutdown(): Promise<void> {
  const sessions = workstationSessions;
  if (sessions === null) return;
  await sessions.shutdown();
}

/**
 * How this Mac says something to his phone, once Telegram is up.
 *
 * Set from `index.ts`, where the client is built, and read through a holder
 * rather than passed in because the handlers are installed before the token
 * has been read. Null until then, and everything that sends checks: a watch
 * that fires before Telegram is ready stays quiet rather than throwing.
 */
let telegramSender: ((chatId: string, text: string) => Promise<void>) | null = null;

export function useTelegramSender(send: (chatId: string, text: string) => Promise<void>): void {
  telegramSender = send;
}

/** One phone message, answered by the workstation. Null when it is not installed. */
export async function answerPhoneMessage(
  chatId: string,
  text: string,
  from?: string
): Promise<{ readonly replied: string } | null> {
  const sessions = workstationSessions;
  if (sessions === null) return null;
  return sessions.answerPhone(chatId, text, from);
}

/**
 * The encrypted record of what the app did. Held here so the diagnostics
 * handler can report whether it still verifies, which is the one thing about
 * the ledger that is safe to put in a bundle someone emails to support.
 */
let ledger: Ledger | null = null;

export function useLedger(directory: string): Ledger {
  ledger = new Ledger(directory, new SecretStore({ directory }));
  skillHost.useLedger(ledger);
  return ledger;
}

/**
 * The folder's own history — what it looked like, as against what Rellane did
 * to it. Held here for the same reason as the ledger: one per main process,
 * because the watcher owns live FSEvents subscriptions.
 */
let manifestStore: ManifestStore | null = null;
let folderWatcher: FolderWatcher | null = null;
let timeline: TimelineService | null = null;
/**
 * Tells the flow runtime a folder moved.
 *
 * Injected rather than imported so `useTimeline` does not need a daemon: the
 * watcher is constructed before the IPC handlers, and a null here simply means
 * nothing is listening yet.
 */
let notifyFolderChanged: ((root: string) => Promise<unknown>) | null = null;

export function useTimeline(directory: string): TimelineService {
  manifestStore = new ManifestStore(path.join(directory, "timeline"));
  folderWatcher = new FolderWatcher(manifestStore, undefined, {
    /**
     * A folder moved, so any flow watching it may be due.
     *
     * Fired from the capture rather than from the raw filesystem event, so a
     * flow starts once per settled change rather than once per `write()` a
     * copying application makes.
     *
     * Failures are swallowed on purpose: the timeline capture has already
     * succeeded by this point, and a locked flow workspace (D-068) must not
     * turn folder history off as well.
     */
    onCaptured: (root) => {
      void notifyFolderChanged?.(root).catch(() => undefined);
    }
  });
  timeline = new TimelineService(manifestStore, folderWatcher, () => skillHost.grantedSandbox());
  return timeline;
}

/** Starts watching every granted root. Called once the grants are restored. */
export async function watchGrantedRoots(): Promise<void> {
  const watcher = folderWatcher;
  if (watcher === null) {
    return;
  }
  for (const root of skillHost.grantedRoots()) {
    await watcher.start(root);
  }
}

export function stopWatchingFolders(): void {
  folderWatcher?.stopAll();
}

function requireTimeline(): TimelineService {
  if (timeline === null) {
    throw new Error("The record of this folder is not ready yet.");
  }
  return timeline;
}

/**
 * The open book, and the key its backups are encrypted with.
 *
 * Held here beside the ledger and the timeline, for the same reason: one open
 * connection for the process, opened once, so nothing has to guess whether the
 * schema has been migrated yet.
 */
let book: DatabaseSync | null = null;
let cachedSecret: Buffer | null = null;

export async function useBook(directory: string): Promise<void> {
  if (book !== null) {
    return;
  }
  const opened = await openTheBook(directory);
  book = opened.db;
}

/** Closed on quit, so WAL is checkpointed rather than left for next launch. */
export function closeBook(): void {
  book?.close();
  book = null;
  cachedSecret = null;
}

async function backupSecret(): Promise<Buffer> {
  if (cachedSecret === null) {
    cachedSecret = await deriveBackupSecret(app.getPath("userData"), safeStorage);
  }
  return cachedSecret;
}

export function useSettingsStore(directory: string): SettingsStore {
  settingsStore = new SettingsStore(directory);
  return settingsStore;
}

/**
 * Makes the window's material agree with the app's theme.
 *
 * There are two appearances here and they were independent, which was a bug the
 * moment the window gained vibrancy. The page theme follows `data-theme`; the
 * window's `NSVisualEffectView` follows the *system* appearance. Choose "Always
 * light" on a Mac in dark mode and you got the light palette's near-black ink
 * painted on a dark translucent ground — unreadable, and exactly the failure
 * DESIGN.md names about colours that only resolve in one theme.
 *
 * `nativeTheme.themeSource` moves the window's appearance with the setting, so
 * the material and the palette can no longer disagree.
 */
export function applyThemeToWindow(theme: "system" | "light" | "dark"): void {
  nativeTheme.themeSource = theme;
}

/** No legacy entry may turn presence or a renderer flag into outbound permission. */
function declineUnreviewedSubscription(): never {
  throw new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message: "Subscription requests need a verified restricted connection and an outgoing review for each message. This connection is not ready here. No model was contacted; use a local workroom for now.",
    retryable: false
  });
}

/** The single shape every brain call returns. */
async function brainStatus(): Promise<BrainStatus> {
  return {
    installations: await subscriptionBrain.available(),
    docked: subscriptionBrain.current,
    capabilities: subscriptionBrain.capabilities(),
    localRuntime: localRuntimeStatus()
  };
}

export const MODEL_INSTALL_TIMEOUT_MS = 12 * 60 * 60_000;
const MODEL_INSTALL_SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
const EmptyObjectSchema = z.object({}).strict();

/**
 * Timeline requests.
 *
 * `folder` is checked against the granted roots inside TimelineService rather
 * than here — a schema can say this is a string, only the host knows whether
 * the owner ever granted it. The bounds below are the ones a schema *can*
 * enforce: a checkpoint reason a person will read again, and a relative path.
 */
const AGENT_RUN = z
  .object({ agentId: z.string().min(1).max(120), question: z.string().min(1).max(8_000), sourceToken: z.uuid().optional() })
  .strict();
const BENCH_RUN = z.object({ question: z.string().min(1).max(8_000) }).strict();

/**
 * What may be written into the book.
 *
 * Money is **integer paise** and the schema says so; a float arriving here would
 * be stored and then never quite add up. `.int()` is the whole guard.
 */
/**
 * What may cross the bridge into a Case.
 *
 * Bounded lengths rather than unbounded strings: the renderer is the least
 * trusted thing that talks to this process, and a room is a table that grows.
 * `.strict()` so a field nobody designed cannot arrive and be stored anyway.
 */
const CaseIdInput = z.object({ id: z.string().min(1).max(64) }).strict();
const EnquiryIdInput = z.object({ enquiryId: z.string().min(1).max(64) }).strict();
// `real` and `junk` only. `unsorted` is where an enquiry starts and means
// nobody has looked yet; letting the screen set it back would be a person
// claiming they have not seen something they have.
const TriageEnquiryInput = z
  .object({
    enquiryId: z.string().min(1).max(64),
    triage: z.union([z.literal("real"), z.literal("junk")])
  })
  .strict();
const AddEnquiryInput = z
  .object({
    channel: z.enum(["indiamart", "whatsapp", "telegram", "email", "phone", "walk_in"]),
    // What the customer actually wrote. Generous, because a forwarded email
    // thread is long and truncating evidence is not this product's business.
    rawText: z.string().min(1).max(20_000),
    // Optional: most enquiries arrive from somebody not in the book yet, and
    // making the owner create a customer first is how intake stops being used.
    partyName: z.string().max(200).nullable().default(null),
    // Stored exactly as typed. Normalising here would mean the book holds a
    // number the owner never wrote; the handoff normalises at the moment it
    // needs a `wa.me` address and nowhere earlier.
    partyPhone: z.string().max(40).nullable().default(null)
  })
  .strict();
const QuotationIdInput = z.object({ quotationId: z.string().min(1).max(64) }).strict();
const DealCustomerInput = z
  .object({
    enquiryId: z.string().min(1).max(64),
    name: z.string().max(200),
    // Stored as typed, like intake. Normalising belongs at the moment a
    // `wa.me` address is needed and nowhere earlier.
    phone: z.string().max(40).nullable().default(null)
  })
  .strict();
const PastLinesInput = z.object({ like: z.string().max(200) }).strict();
const RemoveLineInput = z
  .object({
    quotationId: z.string().min(1).max(64),
    itemId: z.string().min(1).max(64)
  })
  .strict();
const AddLineInput = z
  .object({
    quotationId: z.string().min(1).max(64),
    description: z.string().min(1).max(400),
    quantity: z.number().int().positive().max(1_000_000_000),
    // Paise. The owner's figure, never a model's — nothing upstream of this is
    // allowed to propose a price.
    unitPricePaise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    unit: z.string().max(40).nullable().default(null)
  })
  .strict();
const CloseQuotationInput = z
  .object({
    quotationId: z.string().min(1).max(64),
    state: z.enum(["won", "lost", "no_reply"]),
    // The owner's own words. Capped because it is a note, not a document, and
    // trimmed to null so an empty box does not become an empty string that
    // reads as "they gave a reason" in every later query.
    reason: z.string().max(2_000).nullable().default(null)
  })
  .strict();
const OpenCaseInput = z
  .object({
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(10_000)
  })
  .strict();
const SayInput = z
  .object({ id: z.string().min(1).max(64), body: z.string().min(1).max(50_000) })
  .strict();
const CloseInput = z
  .object({ id: z.string().min(1).max(64), verdict: z.string().min(1).max(10_000) })
  .strict();

const PARTY = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(["customer", "supplier", "both"]).optional(),
    phone: z.string().max(32).nullish(),
    gstin: z.string().max(15).nullish(),
    notes: z.string().max(2_000).nullish()
  })
  .strict();
const INVOICE = z
  .object({
    partyId: z.string().min(1).max(64),
    number: z.string().max(64).nullish(),
    issuedOn: z.number().int(),
    dueOn: z.number().int().nullish(),
    subtotalPaise: z.number().int(),
    taxPaise: z.number().int().optional(),
    totalPaise: z.number().int(),
    notes: z.string().max(2_000).nullish()
  })
  .strict();
const PAYMENT = z
  .object({
    partyId: z.string().min(1).max(64),
    receivedOn: z.number().int(),
    amountPaise: z.number().int(),
    method: z.enum(["cash", "upi", "bank", "cheque", "other"]).nullish(),
    reference: z.string().max(120).nullish()
  })
  .strict();
/**
 * A brief arriving from the renderer.
 *
 * Bounded at the boundary, and clamped again in `rehydrate` on the way out.
 * Two layers because they defend different things: this stops a hostile
 * renderer, and the rehydrate stops a hand-edited settings file.
 */
const AGENT_SAVE = z
  .object({
    id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/u),
    name: z.string().min(1).max(60),
    purpose: z.string().max(200),
    instructions: z.string().max(4_000).optional(),
    folders: z.array(z.string()).max(20).optional(),
    capabilities: z.array(z.string().max(60)).max(20).optional(),
    tier: z.string().max(30).optional(),
    maxSteps: z.number().int().min(1).max(60).optional(),
    maxMinutes: z.number().int().min(1).max(60).optional(),
    outbound: z.string().max(10).optional()
  })
  .strict();
const DISPATCH_STAGE = z
  .object({
    agentId: z.string().min(1).max(120),
    channel: z.enum(["telegram", "whatsapp", "email"]),
    address: z.string().min(1).max(320),
    text: z.string().min(1).max(8_000)
  })
  .strict();
const TIMELINE_FOLDER = z.object({ folder: z.string().min(1) }).strict();
const TIMELINE_DIFF = z
  .object({ folder: z.string().min(1), from: z.string().min(1), to: z.string().min(1) })
  .strict();
const TIMELINE_CHECKPOINT = z
  .object({ folder: z.string().min(1), reason: z.string().min(1).max(200) })
  .strict();
const TIMELINE_HASH = z
  .object({ folder: z.string().min(1), path: z.string().min(1).max(4096) })
  .strict();
const PROJECT_IMPORT_FILE_LIMIT = 240;
const PROJECT_IMPORT_TOTAL_BYTES = 24 * 1024 * 1024;
const PROJECT_IMPORT_SINGLE_FILE_BYTES = 1_500_000;
const PROJECT_TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".go", ".graphql", ".h",
  ".hpp", ".html", ".java", ".js", ".json", ".jsx", ".kt", ".kts",
  ".mjs", ".md", ".markdown", ".mts", ".php", ".prisma", ".py", ".rb",
  ".rs", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx",
  ".txt", ".vue", ".xml", ".yaml", ".yml"
]);
const PROJECT_IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".idea", ".next", ".svn", ".turbo", ".venv", ".vscode",
  "build", "coverage", "dist", "node_modules", "out", "target", "vendor"
]);

/**
 * Told when the owner changes who this Mac may talk to.
 *
 * A hook rather than a direct call into the dispatch layer: `index.ts` owns the
 * running Mark, and having this file import it back would make a cycle out of
 * what is really a one-line notification.
 */
let onContactsChanged: ((contacts: readonly Contact[]) => void) | null = null;

/**
 * Starts talking to Telegram with a token that has just been saved.
 *
 * Held the same way the contacts hook is, and for the same reason: the handlers
 * are installed before there is a token, and the part that owns the poller is
 * `index.ts`. Returns whether it actually connected, so the screen can say
 * which of the two things happened rather than guessing.
 */
let onTelegramTokenSaved: ((token: string) => Promise<boolean>) | null = null;

export function whenTelegramTokenSaved(handler: (token: string) => Promise<boolean>): void {
  onTelegramTokenSaved = handler;
}

/**
 * The channels the running app has, supplied by `index.ts`.
 *
 * Same reason as the contacts hook: `index.ts` owns them, and importing it back
 * from here would make a cycle. Empty until it registers, which reads correctly
 * as "Rellane cannot open that on this Mac".
 */
let channels: readonly Channel[] = [];

export function useOutboundChannels(available: readonly Channel[]): void {
  channels = available;
}

function outboundChannels(): readonly Channel[] {
  return channels;
}

export function whenContactsChange(handler: (contacts: readonly Contact[]) => void): void {
  onContactsChanged = handler;
}

/**
 * What an agent may do on this Mac, right now.
 *
 * One builder, because the ceiling has three parts and a handler that forgets
 * one fails quietly: forget `storedAgents` and the owner's own agents vanish
 * from a screen, which reads as data loss rather than a missing argument.
 */
async function currentCeiling(): Promise<Ceiling> {
  const settings = settingsStore === null ? null : await settingsStore.read();
  const paused = new Set(settings?.pausedRoots ?? []);
  return {
    /**
     * Paused folders are subtracted here, at the single point that defines what
     * anything may touch.
     *
     * Enforcing it in one place is the whole reason it can be believed: the
     * sandbox, the context gatherer and every agent's resolved brief all read
     * this list, so "paused" cannot mean "hidden from one screen while a tool
     * still reads it". An off switch with an exception is not an off switch.
     */
    grantedFolders: skillHost.grantedRoots().filter((root) => !paused.has(root)),
    availableCapabilities: ["list_folder", "read_text"],
    storedAgents: settings?.agents ?? []
  };
}

/**
 * Refuses in the owner's words when the flow workspace will not open.
 *
 * Every channel that touches the workspace calls this. The first version put
 * the message on `automation.snapshot` alone, so the Work screen explained
 * itself beautifully and every other flow action still surfaced the daemon's
 * own *"the durable-space control request was rejected"* — true, unreadable,
 * and the thing that made a locked workspace look like a broken product in the
 * first place (D-068).
 */
function assertFlowsUsableWith(reason: string | null): void {
  if (reason !== null) {
    throw new RuntimeBoundaryError({
      code: "STORAGE_UNAVAILABLE",
      message: reason,
      retryable: false
    });
  }
}

export function installIpcHandlers(
  daemon: DaemonClient,
  getWindow: () => BrowserWindow | null,
  /**
   * Why flows are unavailable, when they are.
   *
   * Passed in rather than read from a module: the reason is decided once at
   * startup, and a second place that recomputed it could disagree with the
   * first — which is how a screen ends up saying a feature works while the
   * feature refuses.
   */
  automationUnavailable: () => string | null = () => null
): void {
  /**
   * The watcher can now reach the flow runtime.
   *
   * Set here rather than in `useTimeline` because that runs before there is a
   * daemon. Not a renderer request, so it goes straight to the client with its
   * own short timeout — a folder that moved is not worth holding a socket open
   * for, and if the runtime is locked (D-068) this simply fails quietly.
   */
  const assertFlowsUsable = (): void => assertFlowsUsableWith(automationUnavailable());
  const agentSourceState = createAgentSourceState();
  const agentSourceOwner = createAgentSourceOwners(owner => { discardAgentSource(agentSourceState, owner); });
  const shortcuts = createLocalShortcuts();
  const shortcutOwner = createAgentSourceOwners(owner => shortcuts.discard(owner));
  const runShortcut = <T>(event: IpcMainInvokeEvent, handle: string, kind: LocalShortcutKind,
    task: (signal: AbortSignal, check: () => void, startFileReading: () => void) => Promise<T>) => {
    assertTrustedSender(event, getWindow);
    const owner = shortcutOwner(event.sender, event.senderFrame);
    return shortcuts.run(owner, handle, kind, task, () => {
      assertTrustedSender(event, getWindow);
      if (shortcutOwner(event.sender, event.senderFrame) !== owner)
        throw new Error("This window changed. Start a new local reading or draft.");
    });
  };
  ipcMain.handle(IPC_CHANNELS.localShortcutBegin, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { kind } = z.object({ kind: LocalShortcutKindSchema }).strict().parse(input);
    return shortcuts.begin(shortcutOwner(event.sender, event.senderFrame), kind);
  });
  ipcMain.handle(IPC_CHANNELS.localShortcutStop, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { handle } = z.object({ handle: z.string().uuid() }).strict().parse(input);
    return shortcuts.stop(shortcutOwner(event.sender, event.senderFrame), handle);
  });
  const agentSourceHost = (event: IpcMainInvokeEvent, owner: object) => ({
    currentGrant: () => skillHost.grantedSandbox(),
    currentCeiling: async () => {
      const assertOwner = () => {
        assertTrustedSender(event, getWindow);
        if (agentSourceOwner(event.sender, event.senderFrame) !== owner)
          throw new Error("This source window changed. Choose the file again.");
      };
      assertOwner();
      const ceiling = await currentCeiling();
      assertOwner();
      return ceiling;
    }
  });

  notifyFolderChanged = (root: string) =>
    daemon.request({ type: "automation.folder-changed", payload: { root } }, 10_000);

  ipcMain.handle(IPC_CHANNELS.systemProfile, async (event) => {
    assertTrustedSender(event, getWindow);
    const data = await requestForRenderer(event, daemon, {
      type: "system.profile",
      payload: { dataDir: getWindow()?.webContents.session.getStoragePath() ?? process.cwd() }
    }, 15_000);
    return HardwareProfileSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.runtimeDiscover, async (event) => {
    assertTrustedSender(event, getWindow);
    const data = await requestForRenderer(event, daemon, {
      type: "runtime.discover",
      payload: {}
    }, 10_000);
    return z.array(RuntimeDescriptorSchema).parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.runtimeChat, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = LocalChatRequestSchema.parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "runtime.chat",
      payload: request
    }, 180_000);
    return LocalChatResultSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.runtimeCancel, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const operationId = z.uuid().parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "runtime.cancel",
      payload: { operationId }
    }, 5_000);
    return z.object({ cancelled: z.boolean() }).parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.automationSnapshot, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const payload = EmptyObjectSchema.parse(input);
    assertFlowsUsable();
    const data = await requestForRenderer(event, daemon, {
      type: "automation.snapshot",
      payload
    }, 15_000);
    return AutomationWorkspaceSnapshotSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.automationAgentSave, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationAgentSaveInputSchema.parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "automation.agent.save",
      payload
    }, 15_000);
    return AutomationAgentSchema.parse(data);
  });

  ipcMain.handle(
    IPC_CHANNELS.automationWorkflowSave,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
    assertFlowsUsable();
      const payload = AutomationWorkflowSaveInputSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "automation.workflow.save",
        payload
      }, 15_000);
      return AutomationWorkflowSchema.parse(data);
    }
  );

  ipcMain.handle(IPC_CHANNELS.automationMemorySave, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationMemoryDocumentSaveInputSchema.parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "automation.memory.save",
      payload
    }, 15_000);
    return AutomationMemoryDocumentSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.automationSourceImport, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    EmptyObjectSchema.parse(input);
    const window = getWindow();
    if (window === null) return [];
    const result = await dialog.showOpenDialog(window, {
      title: "Connect a project folder or add source files",
      buttonLabel: "Add grounded context",
      message: "Rellane imports text and code only. Hidden folders, dependencies, build output, credentials, keys, and binary files are skipped.",
      properties: ["openFile", "openDirectory", "multiSelections", "dontAddToRecent"],
      filters: [{ name: "Project text and code", extensions: [...PROJECT_TEXT_EXTENSIONS].map((extension) => extension.slice(1)) }]
    });
    if (result.canceled) return [];
    const candidates = await collectImportCandidates(result.filePaths);
    const imported = [];
    for (const candidate of candidates) {
      const bytes = await readFile(candidate.filePath);
      if (bytes.includes(0)) continue;
      const content = bytes.toString("utf8");
      if (content.trim() === "") continue;
      imported.push(AutomationSourceDocumentSchema.parse(await requestForRenderer(event, daemon, {
        type: "automation.source.save",
        payload: {
          id: randomUUID(),
          title: candidate.title,
          mediaType: sourceMediaType(candidate.filePath),
          content
        }
      }, 30_000)));
    }
    return imported;
  });

  ipcMain.handle(IPC_CHANNELS.automationArtifactReview, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationArtifactReviewInputSchema.parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "automation.artifact.review",
      payload
    }, 15_000);
    return AutomationArtifactSchema.parse(data);
  });

  ipcMain.handle(
    IPC_CHANNELS.automationConnectorEnsureLocal,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
    assertFlowsUsable();
      const payload = AutomationConnectorEnsureLocalInputSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "automation.connector.ensure-local",
        payload
      }, 15_000);
      return AutomationConnectorSchema.parse(data);
    }
  );

  ipcMain.handle(IPC_CHANNELS.automationPackExport, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationWorkflowPackExportInputSchema.parse(input);
    const pack = AutomationWorkflowPackSchema.parse(await requestForRenderer(event, daemon, {
      type: "automation.pack.export",
      payload
    }, 15_000));
    const window = getWindow();
    if (window === null) return AutomationWorkflowPackFileResultSchema.parse({ completed: false, fileName: null, workflowId: null });
    const result = await dialog.showSaveDialog(window, {
      title: "Export Rellane workflow pack",
      defaultPath: `${safeFileName(pack.name)}.cadrane.json`,
      filters: [{ name: "Rellane workflow pack", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation"]
    });
    if (result.canceled || result.filePath === "") return AutomationWorkflowPackFileResultSchema.parse({ completed: false, fileName: null, workflowId: null });
    const handle = await open(result.filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Choose a new filename; Rellane will not overwrite an existing pack.");
      throw error;
    });
    try { await handle.writeFile(`${JSON.stringify(pack, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return AutomationWorkflowPackFileResultSchema.parse({ completed: true, fileName: path.basename(result.filePath), workflowId: pack.workflow.id });
  });

  ipcMain.handle(IPC_CHANNELS.automationPackImport, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    EmptyObjectSchema.parse(input);
    const window = getWindow();
    if (window === null) return AutomationWorkflowPackFileResultSchema.parse({ completed: false, fileName: null, workflowId: null });
    const result = await dialog.showOpenDialog(window, { title: "Import Rellane workflow pack", properties: ["openFile"], filters: [{ name: "Rellane workflow pack", extensions: ["json"] }] });
    const selected = result.filePaths[0];
    if (result.canceled || selected === undefined) return AutomationWorkflowPackFileResultSchema.parse({ completed: false, fileName: null, workflowId: null });
    const detail = await stat(selected);
    if (!detail.isFile() || detail.size <= 0 || detail.size > 4 * 1024 * 1024) throw new Error("The selected workflow pack is invalid.");
    const pack = AutomationWorkflowPackSchema.parse(JSON.parse(await readFile(selected, "utf8")));
    const workflow = AutomationWorkflowSchema.parse(await requestForRenderer(event, daemon, { type: "automation.pack.import", payload: pack }, 30_000));
    return AutomationWorkflowPackFileResultSchema.parse({ completed: true, fileName: path.basename(selected), workflowId: workflow.id });
  });

  ipcMain.handle(IPC_CHANNELS.automationDryRun, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationDryRunInputSchema.parse(input);
    // Reads only. It walks the flow with the same rule the real run uses and
    // spends nothing — no model call, no file written, no message staged.
    const data = await requestForRenderer(event, daemon, {
      type: "automation.dry-run",
      payload
    }, 15_000);
    return AutomationDryRunSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.engineKeyStatus, async (event) => {
    assertTrustedSender(event, getWindow);
    // No supported keyed engines. Do not read stored credentials for this page.
    return [];
  });

  ipcMain.handle(IPC_CHANNELS.engineKeySave, async (event) => {
    assertTrustedSender(event, getWindow);
    throw new RuntimeBoundaryError({
      code: "BAD_REQUEST",
      message: "API key connections are not supported. No key was stored.",
      retryable: false
    });
  });

  ipcMain.handle(IPC_CHANNELS.engineKeyForget, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { engineId } = z.object({ engineId: z.string().min(1).max(80) }).strict().parse(input);
    const engine = keyedEngine(engineId);
    if (engine === undefined) {
      return { stored: false };
    }
    await new SecretStore({ directory: app.getPath("userData") }).delete(engine.secretName);
    return { stored: false };
  });

  ipcMain.handle(IPC_CHANNELS.flowTemplates, async (event) => {
    assertTrustedSender(event, getWindow);
    // Static, and reads nothing. The gallery is a list of jobs, not a query.
    return TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      says: template.says,
      because: template.because,
      needsFolder: template.needsFolder,
      steps: template.steps.length
    }));
  });

  ipcMain.handle(IPC_CHANNELS.flowFromTemplate, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const { templateId } = z
      .object({ templateId: z.string().min(1).max(80) })
      .strict()
      .parse(input);
    const template = TEMPLATES.find((candidate) => candidate.id === templateId);
    if (template === undefined) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "There is no template with that name.",
        retryable: false
      });
    }
    const snapshot = AutomationWorkspaceSnapshotSchema.parse(
      await requestForRenderer(event, daemon, { type: "automation.snapshot", payload: {} }, 15_000)
    );
    const agent = snapshot.agents[0];
    if (agent === undefined) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message:
          "A flow needs an agent to run its steps, and there are none yet. Write one first — it takes a sentence.",
        retryable: false
      });
    }
    // Saved switched off. `fromTemplate` has no parameter that could arm it,
    // and the ordinary save path is still what validates it.
    const payload = fromTemplate(template, agent.id, () => randomUUID());
    return AutomationWorkflowSchema.parse(
      await requestForRenderer(event, daemon, {
        type: "automation.workflow.save",
        payload
      }, 15_000)
    );
  });

  ipcMain.handle(IPC_CHANNELS.automationBacktest, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const { workflowId } = z
      .object({ workflowId: z.string().min(1).max(200) })
      .strict()
      .parse(input);
    const snapshot = AutomationWorkspaceSnapshotSchema.parse(
      await requestForRenderer(event, daemon, { type: "automation.snapshot", payload: {} }, 15_000)
    );
    const workflow = snapshot.workflows.find((candidate) => candidate.id === workflowId);
    if (workflow === undefined) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "There is no flow with that id.",
        retryable: false
      });
    }
    // The folder's real capture history, read here because the manifest store
    // lives in this process. Timestamps only — never the filenames, which are
    // the owner's business and not needed to count how often a folder moved.
    const moments =
      workflow.trigger.kind === "folder"
        ? ((await manifestStore?.list(workflow.trigger.root)) ?? []).map((capture) => capture.at)
        : [];
    return backtest(workflow, moments);
  });

  ipcMain.handle(IPC_CHANNELS.automationRunStart, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationRunStartInputSchema.parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "automation.run.start",
      payload
    }, 15_000);
    return AutomationRunSnapshotSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.automationRunAction, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    assertFlowsUsable();
    const payload = AutomationRunActionInputSchema.parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "automation.run.action",
      payload
    }, 15_000);
    return AutomationRunSnapshotSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.modelRecommend, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const mode = z.enum(["fast", "balanced", "quality"]).nullable().parse(input);
    const data = await requestForRenderer(event, daemon, {
      type: "model.recommend",
      payload: {
        dataDir: app.getPath("userData"),
        mode
      }
    }, 15_000);
    return ConciergeSnapshotSchema.parse(data);
  });

  ipcMain.handle(IPC_CHANNELS.modelPickGguf, async (event) => {
    assertTrustedSender(event, getWindow);
    const window = getWindow();
    if (window === null) {
      return null;
    }
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a GGUF model",
      buttonLabel: "Inspect model",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "GGUF model", extensions: ["gguf"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || selectedPath === undefined) {
      return null;
    }
    const data = await requestForRenderer(event, daemon, {
      type: "model.inspect",
      payload: { selectedPath }
    }, 10 * 60_000);
    return GgufInspectionSchema.parse(data);
  });

  ipcMain.handle(
    IPC_CHANNELS.modelInstallations,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
      const payload = EmptyObjectSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "model.install.snapshot",
        payload
      }, MODEL_INSTALL_SNAPSHOT_TIMEOUT_MS);
      return ModelInstallSnapshotSchema.parse(data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.modelLicenseReview,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
      const payload = ModelInstallStartIntentSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "model.license.review",
        payload
      }, 15_000);
      return ModelLicenseReviewSchema.parse(data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.modelLicenseAcknowledge,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
      const payload = LicenseAcceptanceIntentSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "model.license.acknowledge",
        payload
      }, 15_000);
      return LicenseAcknowledgementSchema.parse(data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.modelInstall,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
      const payload = ModelInstallStartIntentSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "model.install.start",
        payload
      }, MODEL_INSTALL_TIMEOUT_MS);
      return ModelInstallStatusSchema.parse(data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.modelInstallCancel,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
      const payload = ModelInstallCancelRequestSchema.parse(input);
      const data = await requestForRenderer(event, daemon, {
        type: "model.install.cancel",
        payload
      }, 5_000);
      return ModelInstallCancelResultSchema.parse(data);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.subscriptionAsk,
    async (event) => {
      assertTrustedSender(event, getWindow);
      declineUnreviewedSubscription();
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.subscriptionDock,
    async (event, input: unknown) => {
      assertTrustedSender(event, getWindow);
      const providerId = (input as { providerId?: unknown } | null)?.providerId;
      if (providerId !== "antigravity" && providerId !== "gemini" && providerId !== "claude") {
        throw new RuntimeBoundaryError({
          code: "BAD_REQUEST",
          message: "Choose a CLI to connect.",
          retryable: false
        });
      }
      // Docking used to send capability prompts before any outgoing review.
      declineUnreviewedSubscription();
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.subscriptionStatus,
    async (event) => {
      assertTrustedSender(event, getWindow);
      // Version checks establish tool presence only, not authentication or
      // permission to send a capability probe. This channel dispatches no prompts.
      return await brainStatus();
    }
  );

  ipcMain.handle(IPC_CHANNELS.diagnosticsBundle, async (event) => {
    assertTrustedSender(event, getWindow);
    const profile = await import("node:os");
    return diagnostics.bundle({
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      memoryBytes: profile.totalmem(),
      engine:
        subscriptionBrain.current?.label ??
        (localRuntimeStatus().available ? "bundled local model" : "none"),
      grantedRootCount: skillHost.grantedRoots().length,
      // The verdict only — never entry contents. "Unbroken, 41 entries" tells a
      // reader whether to trust the rest of the bundle; the entries themselves
      // name the owner's clients and belong nowhere near an outbound file.
      ledgerIntegrity:
        ledger === null ? "not started" : describeIntegrity(await ledger.verify())
    });
  });

  ipcMain.handle(IPC_CHANNELS.workspaceLost, async (event) => {
    assertTrustedSender(event, getWindow);
    return skillHost.lostGrants();
  });

  ipcMain.handle(IPC_CHANNELS.activityRead, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const limit =
      typeof input === "object" && input !== null && "limit" in input
        ? Number((input as { limit: unknown }).limit)
        : undefined;
    return readActivity(
      ledger,
      Number.isFinite(limit) ? (limit as number) : undefined,
      skillHost.restorable()
    );
  });

  ipcMain.handle(IPC_CHANNELS.agentsList, async (event) => {
    assertTrustedSender(event, getWindow);
    // Resolved here, never in the renderer: one place decides what an agent may
    // do, and the ceiling is built in one place so a handler cannot forget a
    // part of it.
    return agentCards(await currentCeiling());
  });

  ipcMain.handle(IPC_CHANNELS.agentDraft, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { handle, sentence } = z
      .object({ handle: z.string().uuid(), sentence: z.string().min(1).max(2_000) })
      .strict()
      .parse(input);
    // Drafts, never saves. What comes back goes into the editor for a person to
    // read and change; nothing reaches the roster until they press save. The
    // folders offered are the ones actually granted, read from the host, so a
    // model cannot name its way into somewhere it was not given.
    return runShortcut(event, handle, "agent-brief", signal =>
      draftLocalBrief(sentence, skillHost.grantedRoots(), localWorkroomDeps(event), signal));
  });

  ipcMain.handle(IPC_CHANNELS.agentSave, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = AGENT_SAVE.parse(input);
    // Built field by field rather than spread.
    //
    // `exactOptionalPropertyTypes` distinguishes "the key is absent" from "the
    // key is undefined", and JSON.stringify writes neither — so an object
    // carrying explicit `undefined`s is a shape that cannot round-trip through
    // disk. Naming each field also means adding one to the schema without
    // storing it is a compile error rather than a silently dropped setting.
    const brief: StoredAgent = {
      id: parsed.id,
      name: parsed.name,
      purpose: parsed.purpose,
      ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
      ...(parsed.folders === undefined ? {} : { folders: parsed.folders }),
      ...(parsed.capabilities === undefined ? {} : { capabilities: parsed.capabilities }),
      ...(parsed.tier === undefined ? {} : { tier: parsed.tier }),
      ...(parsed.maxSteps === undefined ? {} : { maxSteps: parsed.maxSteps }),
      ...(parsed.maxMinutes === undefined ? {} : { maxMinutes: parsed.maxMinutes }),
      ...(parsed.outbound === undefined ? {} : { outbound: parsed.outbound })
    };
    if (settingsStore === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "Settings are not ready yet.",
        retryable: true
      });
    }
    if (SHIPPED_IDS.includes(brief.id)) {
      // A shipped id would shadow an agent the owner recognises by name while
      // carrying a different folder and a different outbound policy.
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: `${brief.id} is the id of an agent that ships with Rellane. Choose another name.`,
        retryable: false
      });
    }
    const store = settingsStore;
    const current = await store.read();
    await store.write({
      ...current,
      agents: [...current.agents.filter((entry) => entry.id !== brief.id), brief]
    });
    // The resolved roster, never the stored shape: what the owner sees after
    // saving is what will actually run, clamps and withheld folders included.
    return agentCards(await currentCeiling());
  });

  ipcMain.handle(IPC_CHANNELS.agentDelete, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { id } = z.object({ id: z.string().min(1).max(120) }).strict().parse(input);
    if (settingsStore === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "Settings are not ready yet.",
        retryable: true
      });
    }
    const store = settingsStore;
    const current = await store.read();
    await store.write({ ...current, agents: current.agents.filter((entry) => entry.id !== id) });
    return agentCards(await currentCeiling());
  });

  ipcMain.handle(IPC_CHANNELS.agentPreviewSource, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { agentId } = z.object({ agentId: z.string().min(1).max(120) }).strict().parse(input);
    const owner = agentSourceOwner(event.sender, event.senderFrame);
    const host = agentSourceHost(event, owner);
    const preview = await previewAgentSource(agentSourceState, owner, agentId, host, async () => {
      const window = getWindow();
      if (!window) return null;
      const picked = await dialog.showOpenDialog(window, {
        title: "Choose a required agent source",
        message: "Choose a .txt or .md file inside this agent's granted folders. Up to 32 KB and 8,000 characters. Review the captured text before running.",
        properties: ["openFile"],
        filters: [{ name: "Text sources", extensions: ["txt", "md"] }]
      });
      await host.currentCeiling();
      return picked.canceled ? null : picked.filePaths[0] ?? null;
    });
    try { await host.currentCeiling(); return preview; }
    catch (error) { discardAgentSource(agentSourceState, owner, agentId); throw error; }
  });
  ipcMain.handle(IPC_CHANNELS.agentDiscardSource, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { agentId, token } = z.object({ agentId: z.string().min(1).max(120), token: z.uuid().optional() }).strict().parse(input);
    return discardAgentSource(agentSourceState, agentSourceOwner(event.sender, event.senderFrame), agentId, token);
  });
  ipcMain.handle(IPC_CHANNELS.agentsRun, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { agentId, question, sourceToken } = AGENT_RUN.parse(input);
    // The ceiling is read here, from the host, so the renderer cannot widen
    // what an agent may touch by asking nicely.
    // A live run needs durable local storage before the first file/model read.
    // Its declared sources still decide whether it receives business records.
    const db = theBook();
    const owner = agentSourceOwner(event.sender, event.senderFrame);
    const host = agentSourceHost(event, owner);
    const ceiling = await host.currentCeiling();
    const requiredSource = sourceToken === undefined ? undefined
      : consumeAgentSource(agentSourceState, owner, agentId, sourceToken, ceiling, host);
    return runAgentById(
      agentId,
      question,
      ceiling,
      undefined,
      db,
      // Pushed to the window that asked, so a run can be watched while it
      // happens. Sent on the same one-way channel as every other push: the
      // renderer receives a payload and never a sender.
      (update) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(AGENT_PROGRESS_EVENT, update);
        }
      },
      { ...localWorkroomDeps(event), currentCeiling,
        ...(requiredSource ? { requiredSource } : {}) }
    );
  });

  ipcMain.handle(IPC_CHANNELS.agentExport, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { agentId } = z.object({ agentId: z.string().min(1).max(200) }).strict().parse(input);
    const ceiling = await currentCeiling();
    const brief = findAgent(ceiling.grantedFolders, ceiling.storedAgents, agentId);
    if (brief === undefined) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: `There is no agent called ${agentId}.`,
        retryable: false
      });
    }
    const window = getWindow();
    if (window === null) {
      return { written: false, fileName: null };
    }
    const picked = await dialog.showSaveDialog(window, {
      title: "Save this brief",
      message:
        "The file says what this agent is for. It carries no folders, no keys and no permissions.",
      defaultPath: `${safeFileName(brief.name)}.cadrane-brief.json`,
      filters: [{ name: "Rellane brief", extensions: ["json"] }],
      properties: ["showOverwriteConfirmation"]
    });
    if (picked.canceled || picked.filePath === "") {
      return { written: false, fileName: null };
    }
    // 0o600 and the same no-clobber open the workflow pack uses: a brief is
    // written where the owner chose, and overwriting something they did not
    // mean to would be a worse failure than refusing.
    const handle = await open(
      picked.filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("Choose a new filename; Rellane will not overwrite an existing file.");
      }
      throw error;
    });
    try {
      await handle.writeFile(briefToFile(brief), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { written: true, fileName: path.basename(picked.filePath) };
  });

  ipcMain.handle(IPC_CHANNELS.agentImport, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    EmptyObjectSchema.parse(input);
    const window = getWindow();
    if (window === null) {
      return { ok: false, brief: null, said: "No window." };
    }
    const picked = await dialog.showOpenDialog(window, {
      title: "Open a brief",
      message: "It will be shown for you to read. Nothing is saved until you say so.",
      properties: ["openFile"],
      filters: [{ name: "Rellane brief", extensions: ["json"] }]
    });
    const selected = picked.filePaths[0];
    if (picked.canceled || selected === undefined) {
      return { ok: false, brief: null, said: "Nothing was opened." };
    }
    const detail = await stat(selected);
    if (!detail.isFile() || detail.size <= 0 || detail.size > 256 * 1024) {
      return { ok: false, brief: null, said: "That file is not a brief." };
    }
    // Read and rebuilt from parts we recognise; it is never saved here. The
    // ordinary save channel is the only way an agent enters the roster, so an
    // imported brief is clamped by exactly the same ceiling as a typed one.
    return briefFromFile(await readFile(selected, "utf8"));
  });

  ipcMain.handle(IPC_CHANNELS.agentsStop, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { agentId } = z.object({ agentId: z.string().min(1).max(200) }).strict().parse(input);
    // Aborts the run's own controller, which every await in the loop already
    // honours — the same path the brief's clock takes, so a stopped run is
    // reported as stopped rather than as a failure.
    return { stopped: stopAgent(agentId) };
  });

  ipcMain.handle(IPC_CHANNELS.benchRun, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { question } = BENCH_RUN.parse(input);
    // A question is not approval to choose subscriptions and send subsequent
    // model replies to them. Keep this boundary closed until each leg has a
    // reviewed payload and a verified restricted adapter.
    const result = declineUnreviewedBench(question);

    /**
     * Kept, so model choice can be earned from real work rather than chosen.
     *
     * Written after the argument, never during: a failure to record must not be
     * able to lose an answer somebody already paid for. Nothing here routes —
     * the corpus reports, and which engine answers is unchanged (D-083).
     */
    if (book !== null && result.ok && result.seats !== null) {
      try {
        const gaveWay = result.turns.find((turn) => turn.verdict === "concede");
        remember(book, {
          id: randomUUID(),
          at: Date.now(),
          question: result.question,
          proposerEngine: result.seats.proposer,
          adversaryEngine: result.seats.adversary,
          outcome: result.outcome ?? "unresolved",
          conceded:
            gaveWay?.seat === "proposer" || gaveWay?.seat === "adversary" ? gaveWay.seat : null,
          approxTokens: result.approxTokens
        });
      } catch (error) {
        diagnostics.warn("bench", "an argument could not be recorded", {
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.openLink, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { url } = z.object({ url: z.string().min(1).max(4_000) }).strict().parse(input);
    /**
     * Opens a link the owner is looking at, and only the shapes it expects.
     *
     * An allowlist of schemes rather than a filter, because `shell.openExternal`
     * will happily run `file://` and custom handlers — this is the one channel
     * that hands a string to the operating system, so it takes exactly three
     * kinds of string and refuses everything else. `whatsapp:` and `upi:` are
     * the point: the owner presses send in their own app, and Rellane never
     * does (D-035).
     */
    const allowed = /^(?:https:\/\/(?:wa\.me|api\.whatsapp\.com|github\.com)\/|whatsapp:|upi:)/u;
    if (!allowed.test(url)) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "Rellane will not open that kind of link.",
        retryable: false
      });
    }
    await shell.openExternal(url);
    return { opened: true };
  });

  ipcMain.handle(IPC_CHANNELS.bookReadFile, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { handle } = z.object({ handle: z.string().uuid() }).strict().parse(input);
    return runShortcut(event, handle, "bill-file", async (signal, check, startFileReading) => {
    const window = getWindow();
    if (window === null) {
      return { ok: false, source: "none", text: "", codes: [], said: "No window." };
    }
    // The picker is the grant. A path typed by anything other than a person
    // choosing it in Finder is not one, which is the same rule folders follow.
    const picked = await dialog.showOpenDialog(window, {
      title: "Open a bill",
      message:
        "A photograph, a scan, or a PDF. Rellane reads it on this Mac — nothing is uploaded, and nothing is saved until you check the figures.",
      properties: ["openFile"],
      filters: [{ name: "Bills", extensions: ["pdf", "png", "jpg", "jpeg", "heic", "tiff", "webp"] }]
    });
    check();
    const chosen = picked.filePaths[0];
    if (picked.canceled || chosen === undefined) {
      return { ok: false, source: "none", text: "", codes: [], said: "Nothing was opened." };
    }
    startFileReading();
    const detail = await stat(chosen);
    check();
    if (!detail.isFile() || detail.size <= 0 || detail.size > MAX_BYTES) {
      return {
        ok: false,
        source: "none",
        text: "",
        codes: [],
        said: "That file is empty or larger than Rellane will read in one go."
      };
    }
    const read = await readDocument(chosen, signal);
    check();
    if (read.text.length > BILL_TEXT_LIMIT) return { ok: false, source: read.source, text: "", codes: [],
      said: "This file contains more than 8,000 characters. Choose one bill or paste a shorter excerpt; the file was not sent to a model." };
    if (!read.ok || read.text.trim().length === 0) {
      return read;
    }
    // Straight into the same extractor a paste goes to. A photograph is not
    // more trustworthy than a paste and is treated as exactly as trustworthy:
    // proposals a person confirms, and nothing stored until they do (D-062).
    const bill = await extractLocalBill(read.text, localWorkroomDeps(event), signal);
    return { ...read, bill };
    });
  });

  ipcMain.handle(IPC_CHANNELS.deskSay, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { text } = z.object({ text: z.string().min(1).max(12_000) }).strict().parse(input);
    const ceiling = await currentCeiling();
    // The front door, and only a front door. Every route it can return ends at
    // a channel that already exists and still asks what it always asked — it
    // cannot save a bill, send anything, or reach a folder. `open` names a
    // surface for the renderer to show; it performs nothing itself.
    const settings = settingsStore === null ? null : await settingsStore.read();
    return deskSay(text, {
      book,
      agents: agentCards(ceiling).map((card) => ({ id: card.id, name: card.name })),
      // The owner's own trading name and UPI id, so a reminder is signed by them
      // and paid to them. Rellane never holds either.
      ...(settings === null ? {} : { trading: settings.trading })
    });
  });

  ipcMain.handle(IPC_CHANNELS.benchRouting, async (event) => {
    assertTrustedSender(event, getWindow);
    // Reads only. Counts and engine labels — never a question, never a turn.
    return routing(theBook());
  });

  ipcMain.handle(IPC_CHANNELS.dispatchStage, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = DISPATCH_STAGE.parse(input);
    if (settingsStore === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "Settings are not ready yet.",
        retryable: true
      });
    }
    // Three gates, none of them here: the brief decides whether this agent may
    // send at all, the stored contact list decides who may be reached, and the
    // channel decides whether the address and length are usable. The renderer
    // supplies only the text and a recipient to check — it cannot name a
    // channel that is not registered, widen the list, or claim an agent's
    // outbound policy. Both handoff channels stage rather than send, so the
    // most this can do is open an app with a message in it.
    // Captured after the null check so the closure cannot see it change.
    const store = settingsStore;
    return stageMessage(request, {
      channels: outboundChannels(),
      contacts: async () => (await store.read()).contacts,
      grantedFolders: () => skillHost.grantedRoots(),
      // Read fresh, like contacts: an agent edited a moment ago must be the one
      // that runs, not the one that was loaded at startup.
      storedAgents: async () => (await store.read()).agents
    });
  });

  /** Refuses rather than pretending, when the book is not open. */
  function theBook(): DatabaseSync {
    if (book === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "The book is not open yet.",
        retryable: true
      });
    }
    return book;
  }

  ipcMain.handle(IPC_CHANNELS.vaultSync, async (event) => {
    assertTrustedSender(event, getWindow);
    const db = theBook();
    // Both directions in one pass: notes the owner typed into the markdown come
    // back into the book first, then the whole book is written out. Prose only
    // ever travels inwards — an amount edited in a file cannot reach a balance.
    return syncVault(db, vaultFolder(app.getPath("userData")));
  });

  ipcMain.handle(IPC_CHANNELS.vaultReveal, async (event) => {
    assertTrustedSender(event, getWindow);
    const folder = vaultFolder(app.getPath("userData"));
    // Created on the way, so the button never opens nothing: somebody pressing
    // "show me the files" before the first sync should see the folder, not a
    // Finder error about a path that does not exist.
    await mkdir(folder, { recursive: true });
    shell.showItemInFolder(folder);
    return { folder };
  });

  ipcMain.handle(IPC_CHANNELS.updateCheck, async (event) => {
    assertTrustedSender(event, getWindow);
    // The one outbound request in this app that is not a message, and it happens
    // because somebody pressed a button. Nothing about this Mac is sent: it asks
    // for a list and compares here.
    return checkForUpdate(app.getVersion());
  });

  ipcMain.handle(IPC_CHANNELS.updateOpen, async (event) => {
    assertTrustedSender(event, getWindow);
    // Opens a page. Rellane never downloads or installs anything: a product that
    // can replace its own binary can replace it with anything, and every promise
    // this one makes is a promise about *this* binary.
    await shell.openExternal(RELEASES_URL);
    return { url: RELEASES_URL };
  });

  ipcMain.handle(IPC_CHANNELS.memoryRead, async (event) => {
    assertTrustedSender(event, getWindow);
    const settings = settingsStore === null ? null : await settingsStore.read();
    const granted = skillHost.grantedRoots();

    // Counts, never filenames. Somebody checking what this product knows about
    // them should not have to read a list of their own files on a screen a
    // colleague might be standing behind.
    const sightings: FolderSighting[] = [];
    for (const root of granted) {
      const newest = (await manifestStore?.newest(root)) ?? null;
      sightings.push({
        path: root,
        files: newest === null ? null : newest.manifest.rows.length,
        lastSeenAt: newest === null ? null : new Date(newest.manifest.at).toISOString()
      });
    }

    return whatItHasSeen(book, granted, settings?.pausedRoots ?? [], sightings);
  });

  ipcMain.handle(IPC_CHANNELS.memoryHide, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { key, hidden } = z
      .object({ key: z.string().min(1).max(200), hidden: z.boolean() })
      .strict()
      .parse(input);
    const db = theBook();
    if (hidden) {
      hideTerm(db, key);
    } else {
      unhideTerm(db, key);
    }
    return { key, hidden };
  });

  ipcMain.handle(IPC_CHANNELS.workspacePause, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { path: root, paused } = z
      .object({ path: z.string().min(1), paused: z.boolean() })
      .strict()
      .parse(input);
    // Only a folder that is actually granted can be paused. Accepting any path
    // here would let the renderer write arbitrary strings into a settings list
    // that decides what gets read.
    if (!skillHost.grantedRoots().includes(root)) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "That folder is not one you have granted.",
        retryable: false
      });
    }
    const updated = await settingsStore?.update((current) => ({
      ...current,
      pausedRoots: paused
        ? [...new Set([...current.pausedRoots, root])]
        : current.pausedRoots.filter((entry) => entry !== root)
    }));
    // The watcher stops with the pause rather than merely being ignored: a
    // folder nobody is allowed to read should not still be producing captures
    // that sit on disk waiting to be read later.
    if (paused) {
      folderWatcher?.stop(root);
    } else {
      await folderWatcher?.start(root);
    }
    return { paused: updated?.pausedRoots ?? [] };
  });

  /**
   * Cases — open one, say something into it, close it with a verdict.
   *
   * Waiting is not abandonment (D-096). Today and Cases list are pure reads
   * and never mutate case state or close waiting work. A Case stays open until
   * its owner explicitly closes it with a verdict.
   */
  const localWorkroom = new LocalWorkroom();
  const sourceIntake = new WorkroomSourceIntake();
  /**
   * The workstation, alongside the local workroom rather than instead of it.
   *
   * Both answer inside a case and both write the same kinds of turn; what
   * differs is who does the work. The local workroom asks the bundled model one
   * question with no tools. This drives a native session the owner already pays
   * for, in a folder, with permission prompts — which is why it is the one that
   * needs a reviewed, single-use token before anything is dispatched.
   *
   * It registers its own channels and holds its own state; the only thing this
   * file asks of it is whether a case is busy, which `cases.close` and
   * `cases.erase` below must know before they write.
   */
  const workstation: WorkstationIpc = installWorkstationIpc({
    getWindow,
    assertTrusted: (event) => {
      assertTrustedSender(event, getWindow);
    },
    book: () => theBook(),
    userData: () => app.getPath("userData"),
    // Only chats he has added himself. Empty on a fresh install, which means
    // this Mac obeys nobody until a name is in the list (D-035).
    telegramContacts: async () => {
      if (settingsStore === null) return [];
      const saved = await settingsStore.read();
      return saved.contacts
        .filter((contact) => contact.channel === "telegram")
        .map((contact) => contact.address);
    },
    /**
     * Puts one chat on the list, and applies it now rather than on next launch.
     *
     * The same shape as the WhatsApp contact handler below: write, re-read, and
     * tell the lock. A grant that only takes effect after a restart is a grant
     * he will believe he made and then watch not work.
     */
    telegramAddContact: async ({ chatId, label }) => {
      if (settingsStore === null) return;
      const stored = await settingsStore.read();
      const already = stored.contacts.some(
        (contact) => contact.channel === "telegram" && contact.address === chatId
      );
      if (already) return;
      await settingsStore.write({
        ...stored,
        contacts: [...stored.contacts, { channel: "telegram", address: chatId, label }]
      } as never);
      onContactsChanged?.((await settingsStore.read()).contacts);
    },
    telegramRemoveContact: async (chatId: string) => {
      if (settingsStore === null) return;
      const stored = await settingsStore.read();
      await settingsStore.write({
        ...stored,
        contacts: stored.contacts.filter(
          (contact) => !(contact.channel === "telegram" && contact.address === chatId)
        )
      } as never);
      onContactsChanged?.((await settingsStore.read()).contacts);
    },
    telegramSend: async (chatId: string, text: string) => {
      const send = telegramSender;
      if (send === null) {
        // Telegram is not up. Staying quiet is right: the alternative is a
        // watch that throws every hour because a token was never saved.
        return;
      }
      await send(chatId, text);
    }
  });
  workstationSessions = workstation;
  installWorkstationCreative({
    book: () => theBook(),
    assertTrusted: event => assertTrustedSender(event, getWindow),
    assertIdle: caseId => {
      localWorkroom.assertIdle(caseId);
      assertAgentWorkroomIdle(caseId);
      workstation.assertIdle(caseId);
    }
  });
  installWorkstationImages({
    getWindow, book: () => theBook(),
    assertTrusted: event => assertTrustedSender(event, getWindow),
    assertIdle: caseId => {
      localWorkroom.assertIdle(caseId);
      assertAgentWorkroomIdle(caseId);
      workstation.assertIdle(caseId);
    }
  });
  ipcMain.handle(IPC_CHANNELS.casesPreviewSource, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { id } = CaseIdInput.parse(input);
    const db = theBook();
    const preview = await sourceIntake.preview(db, id, async () => {
        const window = getWindow();
        if (!window) return null;
        const result = await dialog.showOpenDialog(window, {
          title: "Preview a workroom source",
          message: "Read one document or CSV on this Mac. Review it before adding a saved snapshot to this workroom.",
          properties: ["openFile"],
          filters: [{ name: "Workroom sources", extensions: ["docx", "md", "txt", "csv"] }]
        });
        assertTrustedSender(event, getWindow);
        return result.canceled ? null : result.filePaths[0] ?? null;
    });
    try {
      assertTrustedSender(event, getWindow);
      return preview;
    } catch (error) {
      if (preview) sourceIntake.discard(db, id, preview.token);
      throw error;
    }
  });
  ipcMain.handle(IPC_CHANNELS.casesAddSource, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseSourceCommitSchema.parse(input);
    const db = theBook();
    sourceIntake.add(db, request);
    return { case: readCase(db, request.id), turns: turnsFor(db, request.id), artifacts: artifactVersions(db, request.id), exports: exportReceipts(db, request.id) };
  });
  ipcMain.handle(IPC_CHANNELS.casesDiscardSource, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = z.strictObject({ id: z.string().min(1).max(64), token: z.uuid().optional() }).parse(input);
    return { discarded: sourceIntake.discard(theBook(), request.id, request.token) };
  });
  ipcMain.handle(IPC_CHANNELS.casesReviewData, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const query = CaseDataQuerySchema.parse(input);
    return reviewData(theBook(), query);
  });
  ipcMain.handle(IPC_CHANNELS.casesSaveDataReview, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseDataSaveSchema.parse(input);
    const db = theBook();
    const sourceTurnId = saveDataReview(db, request);
    const id = request.query.id;
    return { sourceTurnId, room: { case: readCase(db, id), turns: turnsFor(db, id), artifacts: artifactVersions(db, id), exports: exportReceipts(db, id) } };
  });
  ipcMain.handle(IPC_CHANNELS.casesAddDataSample, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { id } = CaseIdInput.parse(input);
    const db = theBook();
    addDataSample(db, id);
    return { case: readCase(db, id), turns: turnsFor(db, id), artifacts: artifactVersions(db, id), exports: exportReceipts(db, id) };
  });
  const localWorkroomDeps = (event: IpcMainInvokeEvent): LocalWorkroomDeps => ({
    discover: async () => z.array(RuntimeDescriptorSchema).parse(await requestForRenderer(event, daemon, { type: "runtime.discover", payload: {} }, 10_000)),
    chat: async (payload) => LocalChatResultSchema.parse(await requestForRenderer(event, daemon, { type: "runtime.chat", payload }, 180_000)),
    cancel: async (operationId) => { await requestForRenderer(event, daemon, { type: "runtime.cancel", payload: { operationId } }, 5_000); }
  });
  ipcMain.handle(IPC_CHANNELS.workstationContextSuggest, (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = WorkstationContextSuggestionInputSchema.parse(input);
    localWorkroom.assertIdle(request.caseId);
    assertAgentWorkroomIdle(request.caseId);
    workstation.assertIdle(request.caseId);
    return runShortcut(event, request.handle, "context-selection", (signal, check) =>
      suggestLocalContext(theBook(), request, localWorkroomDeps(event), signal, check));
  });
  ipcMain.handle(IPC_CHANNELS.casesSaveArtifact, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseArtifactSaveSchema.parse(input);
    const db = theBook();
    saveArtifact(db, request);
    return { case: readCase(db, request.id), turns: turnsFor(db, request.id), artifacts: artifactVersions(db, request.id), exports: exportReceipts(db, request.id) };
  });
  ipcMain.handle(IPC_CHANNELS.casesAcceptArtifact, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = z.strictObject({ id: z.string().min(1).max(64), versionId: z.uuid() }).parse(input);
    const db = theBook();
    acceptArtifact(db, request.id, request.versionId);
    return { case: readCase(db, request.id), turns: turnsFor(db, request.id), artifacts: artifactVersions(db, request.id), exports: exportReceipts(db, request.id) };
  });
  ipcMain.handle(IPC_CHANNELS.casesExportArtifact, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseArtifactExportSchema.parse(input);
    return exportArtifactVersion(theBook(), request.id, request.versionId, request.format, async ({ defaultName, format }) => {
      const window = getWindow();
      if (!window) return null;
      const result = await dialog.showSaveDialog(window, {
        title: "Export output version", defaultPath: defaultName,
        filters: [{ name: format === "docx" ? "Word document" : "Markdown", extensions: [format] }]
      });
      assertTrustedSender(event, getWindow);
      return result.canceled ? null : result.filePath ?? null;
    });
  });
  ipcMain.handle(IPC_CHANNELS.casesExportTurn, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = z.strictObject({ id: z.string().min(1).max(64), turnId: z.uuid() }).parse(input);
    const db = theBook();
    const room = readCase(db, request.id);
    const turn = turnsFor(db, request.id).find(one => one.id === request.turnId && one.kind === "verbatim");
    if (!room || !turn) throw new Error("That draft is no longer available in this workroom.");
    const window = getWindow();
    if (!window) return { written: false, fileName: null };
    const result = await dialog.showSaveDialog(window, { title: "Export workroom draft", defaultPath: `${safeFileName(room.title)}-draft.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (result.canceled || !result.filePath) return { written: false, fileName: null };
    if (!readCase(db, request.id) || !turnsFor(db, request.id).some(one => one.id === turn.id)) throw new Error("This draft was removed while the export dialog was open.");
    // A new file only: a draft export must never silently replace existing work.
    const handle = await open(result.filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`# ${room.title}\n\nDraft by ${turn.seat}. Owner review required.\nSource workroom: ${room.id}\nSource turn: ${turn.id}\n\n${turn.body}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    return { written: true, fileName: path.basename(result.filePath) };
  });
  ipcMain.handle(IPC_CHANNELS.casesLocalState, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    return localWorkroom.current(CaseIdInput.parse(input).id);
  });
  ipcMain.handle(IPC_CHANNELS.casesAskLocal, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseLocalRequestSchema.parse(input);
    assertAgentWorkroomIdle(request.id);
    const db = theBook();
    await localWorkroom.run(db, request, localWorkroomDeps(event));
    return { case: readCase(db, request.id), turns: turnsFor(db, request.id), artifacts: artifactVersions(db, request.id), exports: exportReceipts(db, request.id) };
  });
  ipcMain.handle(IPC_CHANNELS.casesStopLocal, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = z.strictObject({ id: z.string().min(1).max(64), operationId: z.uuid() }).parse(input);
    return localWorkroom.stop(request.id, request.operationId, localWorkroomDeps(event));
  });
  ipcMain.handle(IPC_CHANNELS.casesPrepareEnquiry, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseEnquiryRequestSchema.parse(input);
    assertAgentWorkroomIdle(request.id);
    const db = theBook();
    await localWorkroom.prepareEnquiry(db, request, localWorkroomDeps(event));
    return { case: readCase(db, request.id), turns: turnsFor(db, request.id), artifacts: artifactVersions(db, request.id), exports: exportReceipts(db, request.id) };
  });
  ipcMain.handle(IPC_CHANNELS.casesSaveEnquiryReview, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = CaseEnquirySaveSchema.parse(input);
    const db = theBook();
    const sourceTurnId = saveEnquiryReview(db, request);
    return { room: { case: readCase(db, request.id), turns: turnsFor(db, request.id), artifacts: artifactVersions(db, request.id), exports: exportReceipts(db, request.id) }, sourceTurnId };
  });

  ipcMain.handle(IPC_CHANNELS.todayRead, async (event) => {
    assertTrustedSender(event, getWindow);
    const db = theBook();
    // Sent with the list so the front door can greet a stranger without a
    // second round trip, and so a quiet morning for an experienced shop never
    // gets mistaken for a first launch.
    // `freshBook`, not "no enquiries yet". A shop that used Rellane before the
    // loop existed has parties, bills and cases; asking only about enquiries
    // would offer it the first-run tour the moment its last case closed.
    return { items: today(db), freshBook: bookIsUntouched(db) };
  });

  /**
   * The loop, D-111. Four verbs, and only three of them change anything.
   *
   * Every one answers with the whole deal rather than a success flag: the room
   * showing a stale price beside a customer's own words is the failure this
   * screen exists to prevent, and a re-read is cheaper than a wrong number.
   */
  /**
   * Step one of the loop, and until now the missing one.
   *
   * `addEnquiry` existed, was tested, and was called by nothing outside its own
   * tests — so no enquiry could exist, Today was permanently empty, and the deal
   * room was unreachable however well it worked (D-043, D-112).
   *
   * The text is stored exactly as it was pasted. A model may read it later; a
   * model does not get to replace it (D-062).
   */
  /**
   * Whether Mark has a bot token, and nothing more.
   *
   * The token is never returned. A renderer that can read a credential is a
   * renderer that can leak one, and there is no screen that needs its value —
   * only whether one is set, so the settings page can say so.
   *
   * Registering it takes effect at the next launch: the channel list is built
   * once at startup, and rebuilding Mark's channels underneath a running poll
   * would be a larger change than this is worth. The screen says so rather than
   * implying it is live.
   */
  ipcMain.handle(IPC_CHANNELS.telegramStatus, async (event) => {
    assertTrustedSender(event, getWindow);
    const store = telegramTokenStore(app.getPath("userData"), safeStorage);
    return { saved: store.read() !== null, encryptionAvailable: safeStorage.isEncryptionAvailable() };
  });

  ipcMain.handle(IPC_CHANNELS.telegramSave, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { token } = z.object({ token: z.string().min(1).max(200) }).strict().parse(input);
    if (!isTelegramToken(token)) {
      // Refused before it reaches the keychain, and the message says what a real
      // one looks like rather than only that this one is wrong.
      return { saved: false, said: "That is not a Telegram bot token. BotFather gives you one like 1234567890:AA…" };
    }
    try {
      telegramTokenStore(app.getPath("userData"), safeStorage).write(token);
      /**
       * Connected now, not on next launch.
       *
       * The token was read once at startup, so saving one told him it was
       * saved and then did nothing until he quit and reopened — which, for
       * somebody setting this up in order to use it from a phone, is the
       * moment the setup appears to have failed.
       */
      const started = onTelegramTokenSaved !== null ? await onTelegramTokenSaved(token) : false;
      return {
        saved: true,
        said: started
          ? "Saved and connected. Message your bot once, then say that chat is yours."
          : "Saved. Mark can use Telegram from the next time Rellane starts."
      };
    } catch (problem) {
      // Not relayed verbatim. The store's own refusals are written for a person
      // to read, but a filesystem or keychain failure underneath carries paths
      // and internals that have no business on a settings screen.
      diagnostics.warn("dispatch", "the telegram token could not be saved", {
        why: problem instanceof Error ? problem.name : "unknown"
      });
      const refusal = problem instanceof Error && /plain text|not a Telegram bot token/.test(problem.message)
        ? problem.message
        : "It was not saved. This Mac would not store it.";
      return { saved: false, said: refusal };
    }
  });

  /**
   * What is configured, never what is stored.
   *
   * The token itself is never handed back to a window, not even masked — the
   * screen needs to know whether WhatsApp is on and what is missing, and there
   * is no question it can ask that a credential answers.
   */
  ipcMain.handle(IPC_CHANNELS.whatsappStatus, async (event) => {
    assertTrustedSender(event, getWindow);
    const store = whatsAppConfigStore(app.getPath("userData"), safeStorage);
    const held = store.read();
    return {
      configured: held !== null,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      // Send-only is a complete state, so this is reported rather than warned about.
      canReceive: held?.mailboxUrl !== undefined,
      phoneNumberId: held?.phoneNumberId ?? null
    };
  });

  ipcMain.handle(IPC_CHANNELS.whatsappSave, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = z
      .object({
        token: z.string().min(1).max(600),
        phoneNumberId: z.string().min(1).max(40),
        businessAccountId: z.string().max(40).default(""),
        mailboxUrl: z.string().max(400).optional(),
        collectSecret: z.string().max(200).optional()
      })
      .strict()
      .parse(input);
    try {
      whatsAppConfigStore(app.getPath("userData"), safeStorage).write({
        token: request.token,
        phoneNumberId: request.phoneNumberId,
        businessAccountId: request.businessAccountId,
        // Absent rather than empty: the poller decides whether to run by asking
        // whether a mailbox exists at all.
        ...(request.mailboxUrl !== undefined && request.mailboxUrl.trim().length > 0
          ? { mailboxUrl: request.mailboxUrl, collectSecret: request.collectSecret ?? "" }
          : {})
      });
      return {
        saved: true,
        said: "Saved. WhatsApp can send from the next time Rellane starts."
      };
    } catch (problem) {
      // The store's refusals are written for a person to read; anything
      // underneath carries paths and internals that have no business on a
      // settings screen.
      diagnostics.warn("dispatch", "the whatsapp configuration could not be saved", {
        why: problem instanceof Error ? problem.name : "unknown"
      });
      return {
        saved: false,
        said:
          problem instanceof Error && problem.message.length < 300
            ? problem.message
            : "It was not saved. This Mac would not store it."
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.whatsappForget, async (event) => {
    assertTrustedSender(event, getWindow);
    whatsAppConfigStore(app.getPath("userData"), safeStorage).clear();
    return { saved: false, said: "Forgotten. WhatsApp is off from the next time Rellane starts." };
  });

  /**
   * One message, to one customer, now.
   *
   * Deliberately not a queue and not a bulk send. Every message here is one the
   * owner is looking at when it goes, which is the whole of what D-033 was
   * protecting when it refused a library that could send on its own.
   */
  ipcMain.handle(IPC_CHANNELS.whatsappSend, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const request = z
      .object({ to: z.string().min(1).max(40), body: z.string().min(1).max(20_000) })
      .strict()
      .parse(input);
    const held = whatsAppConfigStore(app.getPath("userData"), safeStorage).read();
    if (held === null) {
      return { sent: false, said: "WhatsApp is not set up on this Mac yet." };
    }
    const outcome = await sendWhatsAppText({
      token: held.token,
      phoneNumberId: held.phoneNumberId,
      to: request.to,
      body: request.body
    });
    assertTrustedSender(event, getWindow);
    return outcome.status === "sent"
      ? { sent: true, said: "Sent." }
      : { sent: false, said: outcome.reason };
  });

  ipcMain.handle(IPC_CHANNELS.telegramForget, async (event) => {
    assertTrustedSender(event, getWindow);
    telegramTokenStore(app.getPath("userData"), safeStorage).clear();
    return { saved: false, said: "Forgotten. Mark will not use Telegram after the next restart." };
  });

  ipcMain.handle(IPC_CHANNELS.enquiryAdd, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = AddEnquiryInput.parse(input);
    const db = theBook();
    const named = parsed.partyName === null ? "" : parsed.partyName.trim();
    // One transaction. Naming a customer creates a party row, and if recording
    // the enquiry then failed, that party would be left behind with nothing
    // attached to it — a customer in the book who never asked for anything.
    db.exec("BEGIN IMMEDIATE");
    let enquiryId: string;
    try {
      enquiryId = addEnquiry(db, {
        channel: parsed.channel,
        receivedAt: Date.now(),
        rawText: parsed.rawText,
        partyId: named === "" ? null : findOrAddParty(db, named, parsed.partyPhone)
      });
      db.exec("COMMIT");
    } catch (problem) {
      db.exec("ROLLBACK");
      throw problem;
    }
    return { enquiryId, deal: readDeal(db, enquiryId) };
  });

  ipcMain.handle(IPC_CHANNELS.dealRead, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { enquiryId } = EnquiryIdInput.parse(input);
    return { deal: readDeal(theBook(), enquiryId) };
  });

  /**
   * Proposes what the customer asked for, and writes nothing.
   *
   * The reading is `workroom/enquiry.ts`'s, unchanged — thirteen print fields,
   * every one an exact excerpt checked against the message. What comes back is
   * a suggestion beside the words it came from, never a saved quotation, and
   * never a price: no part of this path is allowed to propose one.
   */
  ipcMain.handle(IPC_CHANNELS.dealReadEnquiry, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { enquiryId } = EnquiryIdInput.parse(input);
    const deal = readDeal(theBook(), enquiryId);
    if (deal === null) {
      return { ok: false, enquiry: null, lines: [], said: "That enquiry is no longer here." };
    }
    return readEnquiryLocal(deal.rawText, localWorkroomDeps(event));
  });

  ipcMain.handle(IPC_CHANNELS.dealDraft, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { enquiryId } = EnquiryIdInput.parse(input);
    const db = theBook();
    draftQuotation(db, enquiryId);
    return { deal: readDeal(db, enquiryId) };
  });

  /**
   * What this shop charged for work like this before.
   *
   * A read, and only a read: it writes nothing, proposes nothing, and every
   * figure it returns was typed by the owner on a quotation they sent. The rule
   * it looks like it might break — "Rellane never invents a price" — is about
   * invention, and a shop's own record of what it charged is the opposite.
   */
  ipcMain.handle(IPC_CHANNELS.dealPastLines, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = PastLinesInput.parse(input);
    return { lines: pastLines(theBook(), parsed.like) };
  });

  ipcMain.handle(IPC_CHANNELS.dealRemoveLine, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = RemoveLineInput.parse(input);
    const db = theBook();
    removeQuotationItem(db, parsed.quotationId, parsed.itemId);
    return { deal: readDealForQuotation(db, parsed.quotationId) };
  });

  ipcMain.handle(IPC_CHANNELS.dealAddLine, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = AddLineInput.parse(input);
    const db = theBook();
    const unit = parsed.unit === null ? null : parsed.unit.trim() || null;
    addQuotationItem(db, parsed.quotationId, {
      description: parsed.description,
      quantity: parsed.quantity,
      unitPricePaise: parsed.unitPricePaise,
      unit
    });
    return { deal: readDealForQuotation(db, parsed.quotationId) };
  });

  /**
   * What the customer would read, composed and handed back.
   *
   * Composing is not sending. This opens nothing and contacts nobody: whether
   * the message ever leaves is the outbound lock's decision and the owner's tap
   * (D-033, D-035). Its purpose is that nobody has to guess what a quotation
   * looks like from the other side before deciding to send it.
   */
  ipcMain.handle(IPC_CHANNELS.dealMessage, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { enquiryId } = EnquiryIdInput.parse(input);
    const deal = readDeal(theBook(), enquiryId);
    if (deal === null) {
      return { text: null };
    }
    const store = settingsStore;
    const trading = store === null ? undefined : (await store.read()).trading;
    return { text: quotationMessage(deal, { name: trading?.name ?? "" }) };
  });

  ipcMain.handle(IPC_CHANNELS.dealSend, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { quotationId } = QuotationIdInput.parse(input);
    const db = theBook();
    // `sendQuotation` marks it ready to go; it does not contact anybody. The
    // outbound lock is the only thing that may do that, and it always asks
    // (D-033, D-035).
    const sent = sendQuotation(db, quotationId);
    const deal = readDealForQuotation(db, quotationId);
    return { sent, deal };
  });

  ipcMain.handle(IPC_CHANNELS.dealClose, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = CloseQuotationInput.parse(input);
    const db = theBook();
    const reason = parsed.reason === null ? null : parsed.reason.trim() || null;
    const closed = closeQuotation(db, parsed.quotationId, parsed.state, reason);
    return { closed, deal: readDealForQuotation(db, parsed.quotationId) };
  });

  /**
   * Saying an enquiry is not work.
   *
   * `triageEnquiry` has existed in the book since the loop was built and nothing
   * could call it, so every message that arrived stayed on Today for ever —
   * including the SEO mail, the wrong number and the example this app fills in
   * on somebody's first morning. A queue that only grows is one people stop
   * reading, and then the product has taught them to ignore it.
   *
   * Junk, not deleted. The words stay in the book: an enquiry marked junk by
   * mistake can be put back, and a shop that later wonders what it turned down
   * has an answer.
   */
  ipcMain.handle(IPC_CHANNELS.dealTriage, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = TriageEnquiryInput.parse(input);
    const db = theBook();
    triageEnquiry(db, parsed.enquiryId, parsed.triage);
    return { deal: readDeal(db, parsed.enquiryId) };
  });

  /**
   * Opens WhatsApp with the quotation typed in, and never sends it.
   *
   * The decision — the outbound lock, the staging invariant, what the owner is
   * told and whether they can fix it — is `dispatch/quotation-handoff.ts`, so
   * that it can be exercised without starting an app. This is the wiring.
   */
  ipcMain.handle(IPC_CHANNELS.dealHandoff, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { enquiryId } = EnquiryIdInput.parse(input);
    const deal = readDeal(theBook(), enquiryId);
    if (deal === null) {
      return { opened: false, said: "That enquiry is no longer here.", canAdd: false };
    }
    if (settingsStore === null) {
      // The contact list lives in settings. Without it there is no list to
      // check against, and an unchecked handoff is the one thing this must
      // never do.
      return { opened: false, said: "Rellane is not ready yet, so nothing was opened.", canAdd: false };
    }
    const store = settingsStore;
    return handoffQuotation(deal, {
      channels: outboundChannels(),
      contacts: async () => (await store.read()).contacts,
      shop: async () => ({ name: (await store.read()).trading?.name ?? "" })
    });
  });

  /**
   * Adds this one customer to the outbound list, and nothing else.
   *
   * The lock is right and the friction around it was not. The owner typed this
   * number into the enquiry; making them retype it into Settings is the same
   * decision asked twice, and asking twice is how a person learns to look for
   * the switch that turns the question off. `outbound-lock.ts` says the list is
   * added to "one recipient at a time, by the owner" — this is that, moved to
   * the moment the owner is actually deciding it.
   *
   * ## What it is not
   *
   * It does not run because a message was refused. It runs because somebody
   * pressed a button that names the customer they are adding. Nothing here
   * widens the list beyond that one recipient on that one channel, there is
   * still no allow-everything value, and it is as reversible as any other
   * contact — removed in Settings like the rest.
   *
   * The name and the number are both the owner's own typing, from intake. No
   * part of a customer's message reaches this.
   */
  ipcMain.handle(IPC_CHANNELS.dealAllow, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { enquiryId } = EnquiryIdInput.parse(input);
    if (settingsStore === null) {
      return { added: false, said: "Rellane is not ready yet, so nothing was changed." };
    }
    const deal = readDeal(theBook(), enquiryId);
    if (deal === null) {
      return { added: false, said: "That enquiry is no longer here." };
    }
    const address = deal.partyPhone?.trim() ?? "";
    const label = deal.partyName?.trim() ?? "";
    if (address === "") {
      return { added: false, said: "There is no number on file for this customer." };
    }
    if (label === "") {
      // A row on the contact list reading "918765…" is one nobody can audit
      // later. The list is meant to be read by a person deciding whether it is
      // still right.
      return { added: false, said: "Give this customer a name first, so the list can be read." };
    }

    const stored = await settingsStore.read();
    const already = new OutboundLock(stored.contacts).check("whatsapp", address);
    if (already.allowed) {
      return { added: true, said: `${already.label} is already on your WhatsApp list.` };
    }

    await settingsStore.write({
      ...stored,
      contacts: [...stored.contacts, { channel: "whatsapp", address, label }]
    } as never);
    const saved = await settingsStore.read();
    // Same as the settings screen: applied now, not on next launch.
    onContactsChanged?.(saved.contacts);
    return {
      added: true,
      said: `${label} is on your WhatsApp list. Remove them in Settings whenever you like.`
    };
  });

  /**
   * Who an enquiry is from, written down after it arrived.
   *
   * Intake makes the name and the number optional because an enquiry almost
   * always arrives before anybody has asked for either. What was missing was
   * the other half: the number is learned on the phone call afterwards, and
   * there was nowhere to put it — so the handoff that carries a quotation back
   * to a customer could only be used on the enquiries that needed it least.
   */
  ipcMain.handle(IPC_CHANNELS.dealCustomer, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = DealCustomerInput.parse(input);
    const db = theBook();
    const name = parsed.name.trim();
    if (name === "") {
      return { deal: readDeal(db, parsed.enquiryId), said: "A customer needs a name." };
    }
    setDealCustomer(db, parsed.enquiryId, {
      name,
      phone: parsed.phone === null ? null : parsed.phone.trim() || null
    });
    return { deal: readDeal(db, parsed.enquiryId), said: "Saved." };
  });

  ipcMain.handle(IPC_CHANNELS.dealsList, async (event) => {
    assertTrustedSender(event, getWindow);
    return deals(theBook());
  });

  ipcMain.handle(IPC_CHANNELS.casesList, async (event) => {
    assertTrustedSender(event, getWindow);
    const db = theBook();
    // Bridge compatibility: existing clients expect closedAsAbandoned on the
    // response wire. Since listing is a read and never closes work, this is
    // honestly reported as 0 without invoking any obsolete sweep.
    return { cases: allCases(db), closedAsAbandoned: 0 };
  });

  ipcMain.handle(IPC_CHANNELS.casesOpen, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = OpenCaseInput.parse(input);
    const db = theBook();
    const id = openCase(db, parsed);
    // The question is the first thing said in the room, by the owner, so a
    // transcript read a month later opens with why any of it happened.
    appendTurn(db, id, { seat: "owner", kind: "verbatim", body: parsed.question });
    return { id, case: readCase(db, id), turns: turnsFor(db, id), artifacts: artifactVersions(db, id), exports: exportReceipts(db, id) };
  });

  ipcMain.handle(IPC_CHANNELS.casesRead, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { id } = CaseIdInput.parse(input);
    const db = theBook();
    // This is what a resume replays: the room, in order, from the book.
    return { case: readCase(db, id), turns: turnsFor(db, id), artifacts: artifactVersions(db, id), exports: exportReceipts(db, id) };
  });

  ipcMain.handle(IPC_CHANNELS.casesSay, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = SayInput.parse(input);
    const db = theBook();
    appendTurn(db, parsed.id, { seat: "owner", kind: "verbatim", body: parsed.body });
    return { case: readCase(db, parsed.id), turns: turnsFor(db, parsed.id), artifacts: artifactVersions(db, parsed.id), exports: exportReceipts(db, parsed.id) };
  });

  ipcMain.handle(IPC_CHANNELS.casesClose, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const parsed = CloseInput.parse(input);
    const db = theBook();
    localWorkroom.assertIdle(parsed.id);
    assertAgentWorkroomIdle(parsed.id);
    workstation.assertIdle(parsed.id);
    const closed = closeCase(db, parsed.id, { closedAs: "settled", verdict: parsed.verdict });
    if (closed) sourceIntake.discard(db, parsed.id);
    return { closed, case: readCase(db, parsed.id) };
  });

  ipcMain.handle(IPC_CHANNELS.casesErase, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { id } = CaseIdInput.parse(input);
    const db = theBook();
    // Everything said inside it goes. What it pointed at does not.
    localWorkroom.assertIdle(id);
    assertAgentWorkroomIdle(id);
    workstation.assertIdle(id);
    if (isExporting(db, id)) throw new Error("Finish or cancel this workroom's export before erasing it.");
    sourceIntake.discard(db, id);
    return { erased: eraseCase(db, id) };
  });

  ipcMain.handle(IPC_CHANNELS.bookStanding, async (event) => {
    assertTrustedSender(event, getWindow);
    // Reads only, takes no input. Every figure is derived from the bills at the
    // moment it is asked for — no balance is stored, so none can drift.
    const db = theBook();
    return {
      // Everyone, not just the ones who owe: a customer added a moment ago has
      // no bills yet, and a form that cannot offer them cannot take their first
      // one either.
      parties: outstanding(db),
      owing: owing(db),
      overdue: overdue(db),
      totalOwedPaise: totalOwedPaise(db),
      counts: counts(db)
    };
  });

  ipcMain.handle(IPC_CHANNELS.bookRead, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { handle, text } = z.object({ handle: z.string().uuid(), text: z.string().min(1).max(BILL_TEXT_LIMIT) }).strict().parse(input);
    // Reads a bill out of pasted text and returns a *proposal*. It writes
    // nothing: every figure comes back with the words it was read from, for a
    // person to check, and only the ordinary add-invoice channel can store one.
    // The live read uses only the bundled model; a paste is not upload approval.
    return runShortcut(event, handle, "bill-text", signal => extractLocalBill(text, localWorkroomDeps(event), signal));
  });

  ipcMain.handle(IPC_CHANNELS.bookAddParty, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const party = PARTY.parse(input);
    // Written straight through: this is the owner typing their own customer
    // into their own book, on their own Mac. Nothing leaves.
    return { id: addParty(theBook(), party) };
  });

  ipcMain.handle(IPC_CHANNELS.bookAddInvoice, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const invoice = INVOICE.parse(input);
    return { id: addInvoice(theBook(), invoice) };
  });

  ipcMain.handle(IPC_CHANNELS.bookAddPayment, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const payment = PAYMENT.parse(input);
    return { id: addPayment(theBook(), payment) };
  });

  ipcMain.handle(IPC_CHANNELS.backupPick, async (event) => {
    assertTrustedSender(event, getWindow);
    const window = getWindow();
    if (window === null || settingsStore === null) {
      throw new RuntimeBoundaryError({
        code: "BUSY",
        message: "Rellane is not ready yet.",
        retryable: true
      });
    }
    // The OS picker is the choice. There is no way to pass a path in, for the
    // same reason folder grants work this way: a path chosen by anything other
    // than a person in Finder is not a choice they made.
    const picked = await dialog.showOpenDialog(window, {
      title: "Where should Rellane keep backups?",
      message:
        "An external disk or a synced folder is best. A backup kept beside the original survives a deleted file and nothing else.",
      buttonLabel: "Keep backups here",
      properties: ["openDirectory", "createDirectory"]
    });
    const destination = picked.canceled ? null : picked.filePaths[0];
    if (destination === null || destination === undefined) {
      return (await settingsStore.read()).backup;
    }
    const unsuitable = whyUnsuitable(destination, app.getPath("userData"));
    if (unsuitable !== null) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: unsuitable,
        retryable: false
      });
    }
    const store = settingsStore;
    const current = await store.read();
    await store.write({
      ...current,
      backup: {
        ...current.backup,
        destination,
        // Turned on by choosing a place, because picking one and then having to
        // switch it on separately is a setting people leave half-done.
        cadence: current.backup.cadence === "off" ? "daily" : current.backup.cadence
      }
    });
    // Read back rather than echoed: the store coerces on the way in, so what
    // the screen shows is what is actually on disk.
    return (await store.read()).backup;
  });

  ipcMain.handle(IPC_CHANNELS.backupNow, async (event) => {
    assertTrustedSender(event, getWindow);
    if (settingsStore === null || book === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "The book is not open yet.",
        retryable: true
      });
    }
    const store = settingsStore;
    const current = await store.read();
    if (current.backup.destination === null) {
      return { ok: false, said: "Pick somewhere to keep backups first.", at: null };
    }
    const outcome = await runBackup(book, current.backup.destination, await backupSecret());
    // Recorded either way, and `lastSucceededAt` moves only on a verified
    // success — so a run of failures cannot look like a run of backups.
    //
    // Read again through `update` rather than writing back the `current` read
    // above. A backup is `VACUUM INTO` plus an encrypt of the whole book, so it
    // is one of the few operations here measured in minutes, and the app is
    // fully usable while it runs. Writing the pre-backup snapshot afterwards
    // reverted everything done in that window — a folder paused, a contact
    // edited, a folder revoked — silently, and to the owner it looked like the
    // setting simply had not saved.
    await store.update((latest) => ({
      ...latest,
      backup: {
        ...latest.backup,
        lastSucceededAt: outcome.ok ? outcome.at : latest.backup.lastSucceededAt,
        lastProblem: outcome.ok ? null : outcome.said
      }
    }));
    return { ok: outcome.ok, said: outcome.said, at: outcome.ok ? outcome.at : null };
  });

  ipcMain.handle(IPC_CHANNELS.connectorsRead, async (event) => {
    assertTrustedSender(event, getWindow);
    if (settingsStore === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "Settings are not ready yet.",
        retryable: true
      });
    }
    // Reads only, and takes no input: the connectors and their approvals both
    // come from stored settings, so the renderer cannot name a command to run.
    // Starting a connector process is a side effect, but only of one the owner
    // installed — and each tool still needs its own approval before an agent can
    // call it (D-039).
    const stored = await settingsStore.read();
    return readConnectors(stored.connectors, stored.approvals);
  });

  ipcMain.handle(IPC_CHANNELS.engineRoom, async (event) => {
    assertTrustedSender(event, getWindow);
    // Reads only. Runs each engine's own version check and returns what came
    // back — no credential is touched and nothing is sent anywhere.
    return readEngineRoom();
  });

  ipcMain.handle(IPC_CHANNELS.timelineCaptures, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { folder } = TIMELINE_FOLDER.parse(input);
    return requireTimeline().captures(folder);
  });

  ipcMain.handle(IPC_CHANNELS.timelineDiff, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { folder, from, to } = TIMELINE_DIFF.parse(input);
    return requireTimeline().diff(folder, from, to);
  });

  ipcMain.handle(IPC_CHANNELS.timelineCheckpoint, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { folder, reason } = TIMELINE_CHECKPOINT.parse(input);
    return requireTimeline().checkpoint(folder, reason);
  });

  ipcMain.handle(IPC_CHANNELS.timelineHash, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const { folder, path: file } = TIMELINE_HASH.parse(input);
    return requireTimeline().hash(folder, file);
  });

  ipcMain.handle(IPC_CHANNELS.settingsRead, async (event) => {
    assertTrustedSender(event, getWindow);
    return settingsStore === null ? null : await settingsStore.read();
  });

  ipcMain.handle(IPC_CHANNELS.settingsWrite, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    if (settingsStore === null) {
      throw new RuntimeBoundaryError({
        code: "STORAGE_UNAVAILABLE",
        message: "Settings are not ready yet.",
        retryable: true
      });
    }
    // The store coerces on the way in, so a renderer cannot write a shape that
    // would fail to load on next launch.
    //
    // Shape is not authority, and for two fields that difference is the whole
    // security model. `coerce` accepts any `grantedRoots` entry that is a string
    // beginning with "/", because its job is to keep the file loadable, not to
    // decide who may read what. So a renderer writing `grantedRoots: ["/"]` was
    // written straight to disk — and `index.ts` restores grants from that file
    // on the next launch, calling `skillHost.grant` on every entry. A folder
    // nobody picked became a folder Rellane may read, and it survived a restart.
    //
    // **Which folders are granted is decided by the OS picker and held by
    // `skillHost`, never by the renderer.** `withHeldGrants` puts back what is
    // already stored and discards whatever arrived. This is a floor, not a
    // validation: there is no value the renderer can send that changes them.
    await settingsStore.write(withHeldGrants(input, await settingsStore.read()) as never);
    const saved = await settingsStore.read();
    applyThemeToWindow(saved.theme);
    // Applied immediately, not on next launch. A list you edited that does not
    // take effect until you restart is a list you cannot trust in the moment
    // you most want to shorten it.
    onContactsChanged?.(saved.contacts);
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.workspaceRevoke, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const path = (input as { path?: unknown } | null)?.path;
    if (typeof path !== "string") {
      return skillHost.grantedRoots();
    }
    const roots = await skillHost.revoke(path);
    // The pause goes with the grant. `pausedRoots` was left alone here, so
    // revoking a paused folder left its path written on disk for good — a record
    // of a folder the owner had just asked us to stop looking at, which is the
    // opposite of what revoking means and survives every erasure that works on
    // the book. It also came back to bite: granting the same folder again
    // restored it in a paused state, with nothing on screen saying why it was
    // not being read.
    await settingsStore?.update((current) => ({
      ...current,
      grantedRoots: roots,
      pausedRoots: current.pausedRoots.filter((entry) => entry !== path)
    }));
    // Revoking is the owner withdrawing consent, so the record of that folder
    // goes with it. Keeping a history of a folder someone has just told us to
    // stop looking at would be the exact opposite of what they asked for.
    folderWatcher?.stop(path);
    await manifestStore?.forget(path);
    return roots;
  });

  ipcMain.handle(IPC_CHANNELS.workspaceRoots, async (event) => {
    assertTrustedSender(event, getWindow);
    return skillHost.grantedRoots();
  });

  ipcMain.handle(IPC_CHANNELS.workspaceGrant, async (event) => {
    assertTrustedSender(event, getWindow);
    const window = getWindow();
    if (window === null) {
      return skillHost.grantedRoots();
    }
    // The OS picker is the grant. A path typed by anything other than a person
    // choosing it in Finder is not a grant, so there is no way to pass one in.
    const picked = await dialog.showOpenDialog(window, {
      title: "Choose a folder Rellane may work in",
      message:
        "Skills can read and tidy inside this folder. Nothing outside it is ever touched, and credential folders are refused even if chosen.",
      buttonLabel: "Grant access",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
    });
    if (picked.canceled || picked.filePaths[0] === undefined) {
      return skillHost.grantedRoots();
    }
    const roots = await skillHost.grant(picked.filePaths[0]);
    // Persisted, so a grant survives a restart. Without this the app forgets
    // every folder on quit and asks again on every launch.
    await settingsStore?.update((current) => ({ ...current, grantedRoots: roots }));
    // Watching starts with the grant, which is also what takes the folder's
    // baseline capture. Without it the first thing that changed would have
    // nothing to be compared against.
    await folderWatcher?.start(picked.filePaths[0]);
    return roots;
  });

  ipcMain.handle(IPC_CHANNELS.skillCatalogue, async (event) => {
    assertTrustedSender(event, getWindow);
    // The built-in is described the same way a third-party skill is, so the
    // permission list a user learns to read means the same thing everywhere.
    const builtIn = {
      id: "librarian",
      name: "Desktop Librarian",
      description: "Read a folder and propose where everything should go.",
      version: "1.0.0",
      author: "Rellane",
      permissions: [
        "read files in the folders you grant without asking",
        "move and change files in those folders after asking you each time"
      ],
      triggers: ["organise", "tidy", "sort", "clean up", "downloads"]
    };

    const fromDisk = await loadSkills(path.join(app.getPath("userData"), "skills"));
    return {
      installed: [
        builtIn,
        ...fromDisk.loaded.map((manifest) => ({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          author: manifest.author,
          permissions: describePermissions(manifest),
          triggers: manifest.triggers
        }))
      ],
      rejected: fromDisk.rejected.map((entry) => ({
        folder: entry.folder,
        problems: entry.problems.map((problem) => `${problem.field}: ${problem.problem}`)
      }))
    };
  });

  ipcMain.handle(IPC_CHANNELS.skillPreview, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const payload = (input ?? {}) as { skill?: unknown; path?: unknown };
    if (typeof payload.skill !== "string" || typeof payload.path !== "string") {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "A skill and a folder are both required.",
        retryable: false
      });
    }
    return await skillHost.preview(payload.skill, payload.path);
  });

  ipcMain.handle(IPC_CHANNELS.skillRun, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const payload = (input ?? {}) as { planId?: unknown };
    if (typeof payload.planId !== "string") {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "That run is missing its plan.",
        retryable: false
      });
    }
    // The plan was shown and accepted before this call, which is what approval
    // means here. Per-step prompting is reserved for skills that reach outside
    // the machine, where the gate refuses to be satisfied in advance.
    return await skillHost.run(payload.planId, async () => true);
  });

  ipcMain.handle(IPC_CHANNELS.skillUndo, async (event, input: unknown) => {
    assertTrustedSender(event, getWindow);
    const payload = (input ?? {}) as { receiptId?: unknown };
    if (typeof payload.receiptId !== "string") {
      return { undone: false };
    }
    return await skillHost.undoRun(payload.receiptId);
  });

  ipcMain.handle(
    IPC_CHANNELS.subscriptionUndock,
    async (event) => {
      assertTrustedSender(event, getWindow);
      // Forgets the docked tool. No credential is touched, and the capability
      // list is dimmed rather than cleared so nothing silently disappears.
      subscriptionBrain.undock();
      return await brainStatus();
    }
  );
}

async function requestForRenderer<T>(
  event: IpcMainInvokeEvent,
  daemon: DaemonClient,
  request: Omit<DaemonRequest, "protocolVersion" | "requestId">,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
  };
  event.sender.once("destroyed", cancel);
  try {
    return await daemon.request<T>(request, timeoutMs, controller.signal);
  } finally {
    event.sender.removeListener("destroyed", cancel);
  }
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null
): void {
  const expectedWindow = getWindow();
  const sourceUrl = event.senderFrame?.url ?? event.sender.getURL();
  const target = resolveRendererTarget(app.isPackaged, process.env.SWITCHBOARD_DEV_URL);
  if (
    expectedWindow === null ||
    event.sender !== expectedWindow.webContents ||
    event.senderFrame !== expectedWindow.webContents.mainFrame ||
    !isTrustedRendererUrl(sourceUrl, target)
  ) {
    throw new Error(`Rejected untrusted renderer request ${randomUUID()}.`);
  }
}

function safeFileName(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/[^a-zA-Z0-9._ -]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 80);
  return normalized === "" ? "cadrane-workflow" : normalized;
}

interface ImportCandidate {
  readonly filePath: string;
  readonly title: string;
  readonly bytes: number;
}

async function collectImportCandidates(selectedPaths: readonly string[]): Promise<ImportCandidate[]> {
  const candidates: ImportCandidate[] = [];
  let totalBytes = 0;
  for (const selectedPath of selectedPaths) {
    if (candidates.length >= PROJECT_IMPORT_FILE_LIMIT || totalBytes >= PROJECT_IMPORT_TOTAL_BYTES) break;
    const selected = await lstat(selectedPath).catch(() => null);
    if (selected === null || selected.isSymbolicLink()) continue;
    if (selected.isFile()) {
      const candidate = await importCandidateForFile(selectedPath, path.basename(selectedPath), 4 * 1024 * 1024);
      if (candidate !== null && totalBytes + candidate.bytes <= PROJECT_IMPORT_TOTAL_BYTES) {
        candidates.push(candidate);
        totalBytes += candidate.bytes;
      }
      continue;
    }
    if (!selected.isDirectory()) continue;
    const root = await realpath(selectedPath);
    const rootName = path.basename(root);
    const discovered = await walkProjectDirectory(root, root, rootName);
    for (const candidate of discovered) {
      if (candidates.length >= PROJECT_IMPORT_FILE_LIMIT || totalBytes + candidate.bytes > PROJECT_IMPORT_TOTAL_BYTES) break;
      candidates.push(candidate);
      totalBytes += candidate.bytes;
    }
  }
  return candidates;
}

async function walkProjectDirectory(
  root: string,
  current: string,
  rootName: string
): Promise<ImportCandidate[]> {
  const candidates: ImportCandidate[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.length >= PROJECT_IMPORT_FILE_LIMIT) break;
    if (entry.name.startsWith(".") || isSensitiveProjectFile(entry.name)) continue;
    const filePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (PROJECT_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      candidates.push(...await walkProjectDirectory(root, filePath, rootName));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!PROJECT_TEXT_EXTENSIONS.has(extension)) continue;
    const canonical = await realpath(filePath).catch(() => null);
    if (canonical === null || !pathIsInside(root, canonical)) continue;
    const relative = path.relative(root, canonical).split(path.sep).join("/");
    const candidate = await importCandidateForFile(
      canonical,
      projectSourceTitle(rootName, relative),
      PROJECT_IMPORT_SINGLE_FILE_BYTES
    );
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates.slice(0, PROJECT_IMPORT_FILE_LIMIT);
}

async function importCandidateForFile(
  filePath: string,
  title: string,
  byteLimit: number
): Promise<ImportCandidate | null> {
  if (isSensitiveProjectFile(path.basename(filePath))) return null;
  const detail = await stat(filePath).catch(() => null);
  if (detail === null || !detail.isFile() || detail.size <= 0 || detail.size > byteLimit) return null;
  if (!PROJECT_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
  return { filePath, title, bytes: detail.size };
}

function isSensitiveProjectFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") ||
    lower === ".npmrc" || lower === ".pypirc" || lower === "credentials" ||
    lower === "id_rsa" || lower === "id_ed25519" ||
    lower.endsWith(".key") || lower.endsWith(".pem") || lower.endsWith(".p12") ||
    lower.includes("credential") || lower.includes("secret") ||
    lower.endsWith(".lock") || lower.endsWith("-lock.json");
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function projectSourceTitle(rootName: string, relative: string): string {
  const full = `${rootName}/${relative}`;
  if (full.length <= 120) return full;
  const tail = relative.slice(Math.max(0, relative.length - 96));
  return `${rootName.slice(0, 20)}/…/${tail}`.slice(-120);
}

function sourceMediaType(filePath: string): "text/plain" | "text/markdown" | "text/csv" | "application/json" {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".csv") return "text/csv";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "text/plain";
}
