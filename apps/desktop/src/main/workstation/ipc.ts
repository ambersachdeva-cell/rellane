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
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  WorkstationDecideInputSchema,
  WorkstationPrepareInputSchema,
  WorkstationRevealWorkspaceInputSchema,
  WorkstationStartInputSchema,
  WorkstationStateInputSchema,
  WorkstationStopInputSchema,
  type WorkstationProviderId,
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
import { WorkstationHost, workspaceFolderName } from "./service.js";
import type { NativeWorker, NativeWorkerOptions } from "./types.js";
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
import { installDispatchRun } from "./dispatch-run-ipc.js";
import { installAgentStream } from "./agent-stream-ipc.js";
import { installCrewRun } from "./crew-run-ipc.js";
import { installAgentStore } from "./agent-store-ipc.js";
import { installTelegramWork } from "./telegram-work-ipc.js";
import { installResearch } from "./research-run-ipc.js";
import { installProjectMemory } from "./project-memory-ipc.js";
import { installFileHistory } from "./file-history-ipc.js";
import { installWatch } from "./watch-runner-ipc.js";
import { installUsage, WORKSTATION_USAGE_RECEIPT_CAP } from "./usage-ipc.js";
import { readBefore, readContentBefore, saveBefore, snapshotFolder } from "./change-store.js";
import { AnnouncedCalls, describeCall, waitingCalls } from "./phone-approvals.js";
import { forgetSeen, lastSeen, loadWatches, remember, saveWatches } from "./watch-store.js";
import { readPageSource } from "./web-read.js";
import { listWorkspace, previewFile } from "./workspace-files.js";
import { listHermesSkills, readHermesSkill } from "./upstream-skills.js";
import { runHermesLoop, type HermesToolDefinition } from "./hermes-agent-loop.js";
import { tmpdir } from "node:os";
import { artifactVersions } from "../workroom/artifacts.js";
import { createRemoteDispatchServer } from "./remote-dispatch-server.js";
import { parseDocument } from "./universal-parser.js";
import { transcribeAudio } from "./whisper-dictation.js";

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
  /** Refuses to close or erase a case with a session still working in it. */
  assertIdle(caseId: string): void;
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
  const owners = createAgentSourceOwners((owner) => {
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
    now: () => Date.now(),
    onRunStart: ({ caseId, operationId, workspacePath }) => {
      // Not awaited: a session starts whether or not its folder could be
      // written down, and the panel says "not recorded" rather than inventing
      // a before it never took.
      void saveBefore(changeHistoryFolder, caseId, operationId, workspacePath);
    },
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
    } catch {
      // No book yet. The next read tries again.
    }
  };

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
    decidePending: async (allow: boolean) => {
      const waiting = waitingCalls(host.liveSnapshots());
      const oldest = waiting[0];
      if (oldest === undefined) {
        return { decided: false, detail: "Nothing is waiting on an answer right now." };
      }
      await host.decide(oldest.operationId, oldest.permissionId, allow, PHONE_OWNER);
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
        detail: `${allow ? "Allowed once" : "Declined"}: ${oldest.title}.${more}`
      };
    },
    startWork: async ({ request, seats }) => {
      const wantsTools = WANTS_TOOLS.test(request);
      const available = await host.providers();
      const detected = available.filter((one) => one.state === "detected");
      if (detected.length === 0) {
        return {
          started: false,
          detail: "No subscription is signed in on your Mac right now, so there is nothing to ask."
        };
      }

      /**
       * Tools are Codex-only, because Codex is the connection that reviews each
       * call. Said out loud rather than silently switching: being moved to a
       * different subscription without being told is worse than being refused.
       */
      const named = seats
        .map((seat) => detected.find((one) => one.id === seat))
        .find((one) => one !== undefined);
      let provider = named ?? detected[0]!;
      let switchNote = "";
      if (wantsTools) {
        const codex = detected.find((one) => one.id === "codex");
        if (codex === undefined) {
          return {
            started: false,
            detail: "Working on files needs Codex, which is not signed in on your Mac. Send it again without files, or sign in there."
          };
        }
        if (provider.id !== "codex") {
          switchNote = ` Using Codex rather than ${provider.label}, because it is the one that checks each file with you.`;
        }
        provider = codex;
      }

      const db = options.book();
      const title = titleFromRequest(request);
      let caseId: string;
      db.exec("BEGIN IMMEDIATE");
      try {
        caseId = openCase(db, { title, question: request });
        appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: request });
        db.exec("COMMIT");
      } catch (problem) {
        db.exec("ROLLBACK");
        throw problem;
      }

      const review = await host.prepare(
        {
          caseId,
          providerId: provider.id,
          prompt: request,
          sourceTurnIds: [],
          enableTools: wantsTools
        },
        PHONE_OWNER
      );
      await host.start({ token: review.token }, PHONE_OWNER);

      const toolNote = wantsTools
        ? " It will ask you here before it touches any file."
        : "";
      return {
        started: true,
        detail: `Started on ${provider.label}, in "${title}".${switchNote}${toolNote} Say stop to halt it.`
      };
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
      const live = host.liveSnapshots();
      for (const snapshot of live) {
        try {
          await host.stop(snapshot.caseId, snapshot.operationId, noChosenWorkspace);
        } catch {
          // A session that has already finished is not a failure to stop it.
        }
      }
      return { detail: live.length === 0 ? "Nothing was running." : "Stopped." };
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
  installRemotePairing({
    assertTrusted: options.assertTrusted,
    startServer: async ({ host: bindHost }) => {
      const server = createRemoteDispatchServer({ host: bindHost, port: 0 });
      const session = await server.start();
      return {
        url: session.serverUrl,
        pin: session.pin,
        // Long enough to walk to the other device, short enough that a code
        // left on screen is not a standing key to this Mac.
        expiresAt: Date.now() + 10 * 60_000,
        stop: () => server.stop()
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

  /**
   * A scratch folder for an ask that is not a session.
   *
   * A worker still needs somewhere to be started from, and it must not be a
   * case's own folder: `admit` refuses two sessions sharing one, and a lane is
   * explicitly allowed to run beside others. Nothing is written here.
   */
  const askScratch = async (): Promise<string> => {
    const folder = path.join(tmpdir(), "rellane-ask", randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return folder;
  };

  /**
   * Several subscriptions on one brief, at once.
   *
   * Each lane is an `askOnce` — read-only, no workspace, no tools — so three of
   * them may work one piece of work without the session rules that exist to stop
   * two of them corrupting a folder. Each answer lands as a turn attributed to
   * the subscription that gave it, which is what makes comparing them afterwards
   * mean anything.
   */
  installDispatchRun({
    assertTrusted: options.assertTrusted,
    providers: async () => {
      const found = await host.providers();
      return found.map((provider) => ({
        id: provider.id,
        label: provider.label,
        usable: provider.state === "detected"
      }));
    },
    askProvider: async ({ providerId, caseId, brief, sourceTurnIds, signal, onActivity }) => {
      const db = options.book();
      const chosen = new Set(sourceTurnIds);
      const sources = turnsFor(db, caseId)
        .filter((turn) => chosen.has(turn.id))
        .map((turn) => ({ id: turn.id, label: turn.seat, text: turn.body }));
      const context = buildWorkstationContext({ prompt: brief, sources });
      const cwd = await askScratch();
      const answer = await host.askOnce({
        providerId: providerId as WorkstationProviderId,
        prompt: context.packet,
        cwd,
        signal,
        // Built by assignment below rather than spread, so an absent listener
        // is absent rather than present-and-undefined.
        ...(onActivity === undefined ? {} : { onActivity })
      });
      const label =
        (await host.providers()).find((provider) => provider.id === providerId)?.label ?? providerId;
      let turnId = "";
      db.exec("BEGIN IMMEDIATE");
      try {
        turnId = appendTurn(db, caseId, {
          seat: `Workstation \u00b7 ${label}`,
          kind: "verbatim",
          body: answer.text
        });
        db.exec("COMMIT");
      } catch (problem) {
        db.exec("ROLLBACK");
        throw problem;
      }
      return { text: answer.text, turnId };
    }
  });

  /**
   * The step-by-step agent, against a real model this time.
   *
   * Its two tools cannot change anything: list the sources this piece of work
   * already has, and read one of them. A tool that writes belongs behind the
   * per-call approval the ordinary session flow has, and this loop does not have
   * that yet, so the capability is absent rather than unguarded.
   */
  installAgentStream({
    assertTrusted: options.assertTrusted,
    startRun: async ({ caseId, goal, sourceTurnIds, onStep, signal }) => {
      const db = options.book();
      const chosen = new Set(sourceTurnIds);
      const sources = turnsFor(db, caseId)
        .filter((turn) => turn.kind === "verbatim")
        .filter((turn) => chosen.size === 0 || chosen.has(turn.id));

      const tools: readonly HermesToolDefinition[] = [
        {
          name: "rellane_list_sources",
          description: "List the files and notes already chosen for this piece of work.",
          parameters: { type: "object", properties: {} }
        },
        {
          name: "rellane_read_source",
          description: "Read one of those sources in full, by its id.",
          parameters: {
            type: "object",
            properties: { sourceId: { type: "string", description: "The id of the source to read." } },
            required: ["sourceId"]
          }
        }
      ];

      const cwd = await askScratch();
      const provider = (await host.providers()).find((one) => one.state === "detected");
      if (provider === undefined) throw new Error("No subscription is available on this Mac right now.");

      let index = 0;
      let startedAt = Date.now();
      const result = await runHermesLoop(
        goal,
        tools,
        async (prompt: string) => {
          startedAt = Date.now();
          const answer = await host.askOnce({ providerId: provider.id, prompt, cwd, signal });
          return answer.text;
        },
        async (call) => {
          index += 1;
          const at = startedAt;
          let text: string;
          let failed = false;
          if (call.name === "rellane_list_sources") {
            text = sources.map((turn) => `${turn.id}: ${turn.seat}`).join("\n") || "No sources are attached.";
          } else if (call.name === "rellane_read_source") {
            const wanted = String((call.arguments as Record<string, unknown>)["sourceId"] ?? "");
            const found = sources.find((turn) => turn.id === wanted);
            text = found?.body ?? "That source is not attached to this piece of work.";
            failed = found === undefined;
          } else {
            text = "That tool is not available.";
            failed = true;
          }
          onStep({
            index,
            thought: "",
            toolName: call.name,
            toolArgs: JSON.stringify(call.arguments ?? {}),
            toolResult: text,
            toolFailed: failed,
            answer: "",
            startedAt: at,
            endedAt: Date.now()
          });
          return { callId: call.id, name: call.name, result: text, isError: failed };
        },
        { maxSteps: 6, stepTimeoutMs: 120_000 }
      );

      if (result.finalAnswer.trim().length > 0) {
        db.exec("BEGIN IMMEDIATE");
        try {
          appendTurn(db, caseId, {
            seat: `Workstation \u00b7 ${provider.label}`,
            kind: "verbatim",
            body: result.finalAnswer
          });
          db.exec("COMMIT");
        } catch (problem) {
          db.exec("ROLLBACK");
          throw problem;
        }
      }
      return result.finishReason === "completed"
        ? { answer: result.finalAnswer }
        : { answer: result.finalAnswer, failure: `The agent stopped early (${result.finishReason}).` };
    }
  });

  /**
   * Several bots on one request, each taking a part.
   *
   * The same `askOnce` a dispatch lane uses — read-only, no workspace, no tools
   * — so several may work one piece of work at once without the session rules
   * that exist to stop two of them corrupting a folder. Each answer lands as a
   * turn attributed to the bot that gave it, which is what makes the comparison
   * afterwards mean anything.
   */
  installCrewRun({
    assertTrusted: options.assertTrusted,
    ask: async ({ seatId, prompt, signal, onActivity }) => {
      const cwd = await askScratch();
      const answer = await host.askOnce({
        providerId: seatId as WorkstationProviderId,
        prompt,
        cwd,
        signal,
        ...(onActivity === undefined ? {} : { onActivity })
      });
      return { text: answer.text };
    },
    record: async ({ caseId, seatLabel, body }) => {
      const db = options.book();
      db.exec("BEGIN IMMEDIATE");
      try {
        const turnId = appendTurn(db, caseId, {
          seat: `Workstation \u00b7 ${seatLabel}`,
          kind: "verbatim",
          body
        });
        db.exec("COMMIT");
        return turnId;
      } catch (problem) {
        db.exec("ROLLBACK");
        throw problem;
      }
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
    bundled: () =>
      listHermesSkills().map((skill) => ({
        id: skill.id,
        markdown: (() => {
          try {
            return readHermesSkill(skill.id).content;
          } catch {
            // A skill this build cannot read is simply not offered, rather than
            // failing the whole shelf.
            return "";
          }
        })()
      })).filter((entry) => entry.markdown.length > 0)
  });

  /**
   * Going and reading, rather than answering from what a model happens to
   * remember.
   *
   * Every page goes out through the same guards the owner's own web read uses:
   * the address is validated, private and loopback hosts are refused, every
   * redirect hop is re-checked, and the read is capped. Following a link is the
   * part that makes this worth having and also the part that could wander, so a
   * discovered link is only queued when its parent actually yielded notes, and
   * only within the hosts he started from.
   */
  installResearch({
    assertTrusted: options.assertTrusted,
    fetchPage: async (url: string, signal: AbortSignal) => {
      const fetched = await readPageSource(url, signal);
      if (fetched.status === "refused") {
        return null;
      }
      return { html: fetched.source, finalUrl: fetched.finalUrl };
    },
    files: async (caseId: string) => {
      const folder = await caseFolder(caseId);
      if (folder === null) {
        return [];
      }
      const listing = await listWorkspace(folder);
      const out: { readonly id: string; readonly label: string; readonly text: string }[] = [];
      for (const entry of listing.entries) {
        // Reading is what research does; ten files is what it can hold at once.
        if (entry.kind !== "file" || !entry.textual || out.length >= 10) {
          continue;
        }
        const preview = await previewFile(folder, entry.relativePath);
        if (preview.status === "text") {
          out.push({ id: entry.relativePath, label: entry.name, text: preview.text });
        }
      }
      return out;
    },
    ask: async ({ prompt, signal }) => {
      const cwd = await askScratch();
      // Whichever subscription this Mac actually has. Asked fresh each step so
      // that a run started before a sign-in expired does not keep asking a
      // subscription that has since stopped answering.
      const provider = (await host.providers()).find((one) => one.state === "detected");
      if (provider === undefined) {
        throw new Error("No subscription is available on this Mac right now.");
      }
      const answer = await host.askOnce({ providerId: provider.id, prompt, cwd, signal });
      return answer.text;
    },
    record: async ({ caseId, body }) => {
      const db = options.book();
      db.exec("BEGIN IMMEDIATE");
      try {
        const turnId = appendTurn(db, caseId, {
          seat: "Workstation \u00b7 Research",
          kind: "verbatim",
          body
        });
        db.exec("COMMIT");
        return turnId;
      } catch (problem) {
        db.exec("ROLLBACK");
        throw problem;
      }
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
    folder: () => memoryFolder
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
    folderFor: caseFolder,
    snapshot: async (folder: string) => snapshotFolder(folder),
    before: async (caseId: string, operationId: string) =>
      readBefore(changeHistoryFolder, caseId, operationId),
    contentBefore: async (caseId: string, operationId: string, relativePath: string) =>
      readContentBefore(changeHistoryFolder, caseId, operationId, relativePath),
    restore: async (folder: string, relativePath: string, contents: string) => {
      // The installer has already refused anything that resolves outside the
      // folder; this only writes where it is told.
      const target = path.join(folder, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
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
  const tellHimWhatIsWaiting = async (): Promise<void> => {
    const send = options.telegramSend;
    const chats = options.telegramContacts;
    if (send === undefined || chats === undefined) {
      return;
    }
    const waiting = waitingCalls(host.liveSnapshots());
    announced.keepOnly(waiting);
    const fresh = announced.fresh(waiting);
    if (fresh.length === 0) {
      return;
    }
    const owners = await chats();
    for (const call of fresh) {
      for (const chatId of owners) {
        await send(chatId, describeCall(call));
      }
    }
  };
  const approvalTimer = setInterval(() => {
    void tellHimWhatIsWaiting().catch(() => {
      // A phone that cannot be reached must not stop the session it is about.
    });
  }, 4_000);
  if (typeof approvalTimer.unref === "function") approvalTimer.unref();

  return {
    assertIdle: (caseId: string) => {
      host.assertIdle(caseId);
    },
    answerPhone: (chatId: string, text: string, from?: string) => phone.answerPhone(chatId, text, from),
    shutdown: async () => {
      clearInterval(approvalTimer);
      watching.stop();
      await host.shutdown();
    }
  };
}
