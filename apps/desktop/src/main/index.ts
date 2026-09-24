import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  // Electron's Notification, explicitly — without the import this resolves to
  // the DOM's, which exists in the type environment but not in a main process.
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell
} from "electron";
import { DaemonClient } from "./daemon-client.js";
import { diagnostics } from "./foundations/diagnostics.js";
import { resolveHome } from "./foundations/home.js";
import { recordCrash } from "./foundations/crash.js";
import {
  installIpcHandlers,
  useBook,
  closeBook,
  whenContactsChange,
  useOutboundChannels,
  skillHost,
  stopWatchingFolders,
  useLedger,
  useSettingsStore,
  useTimeline,
  watchGrantedRoots,
  applyThemeToWindow,
  answerPhoneMessage,
  useTelegramSender,
  whenTelegramTokenSaved,
  workstationShutdown
} from "./ipc.js";
import { bindHotkey, createOverlay, type OverlayHost } from "./overlay-window.js";
import { markLocalRuntimeChecking, markLocalRuntimeFailed, markLocalRuntimeReady } from "./runtime-status.js";
import { createPasteRuntime, type PasteRuntime } from "./skills/paste-runtime.js";
import { Mark, readIntent } from "./dispatch/mark.js";
import { whatsAppHandoff } from "./dispatch/whatsapp.js";
import { emailHandoff } from "./dispatch/email.js";
import { telegramChannel, TelegramClient } from "./dispatch/telegram.js";
import { startTelegramPoll, type TelegramPoll } from "./dispatch/telegram-poller.js";
import { telegramTokenStore } from "./dispatch/telegram-token.js";
import { whatsAppConfigStore } from "./dispatch/whatsapp-config.js";
import { collectInbound } from "./dispatch/whatsapp-cloud.js";
import { OutboundLock } from "./dispatch/outbound-lock.js";
import { dropAllConnectors } from "./mcp/service.js";
import {
  installApplicationProtocol,
  registerApplicationScheme
} from "./protocol.js";
import {
  isTrustedRendererUrl,
  resolveRendererTarget
} from "./renderer-trust.js";
import {
  FileWrappedWorkspaceKeyStore,
  WorkspaceKeyBroker,
  WorkspaceKeyBrokerError,
  type WorkspaceKeyReference
} from "./workspace-key-broker.js";
import { BundledLocalRuntime } from "./bundled-local-runtime.js";
import { runShutdownSteps } from "./shutdown.js";

registerApplicationScheme();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const daemon = new DaemonClient();
const bundledLocalRuntime = new BundledLocalRuntime();
let mainWindow: BrowserWindow | null = null;
let overlay: OverlayHost | null = null;


/**
 * ⌥Space. Contested — several launchers want it — so a failure to bind is
 * reported rather than swallowed. A hotkey that silently does nothing is worse
 * than one that says it is taken.
 */
const OVERLAY_HOTKEY = "Alt+Space";

/** ⌥V. Beside ⌘V rather than replacing it — the normal paste keeps working. */
const PASTE_HOTKEY = "Alt+V";

let pasteRuntime: PasteRuntime | null = null;
let mark: Mark | null = null;
/** Held so quitting stops the loop rather than leaving it long-polling. */
let telegramPoll: TelegramPoll | null = null;
let whatsAppPoll: TelegramPoll | null = null;
let automationKeyReference: WorkspaceKeyReference | null = null;
/**
 * Why flows are unavailable, when they are.
 *
 * Held so it can be *shown*. This failure has a history: the workspace key is
 * wrapped by macOS against the app's identity, so renaming the app orphaned
 * every flow written before the rename — and the only trace was one line in a
 * diagnostics log nobody reads. A feature that is dead and silent is worse than
 * one that is dead and says so, because the owner concludes the product is
 * broken rather than that a decision is waiting for them.
 */
let automationProblem: string | null = null;
let quitCleanupStarted = false;
let quitCleanupFinished = false;
const rendererTarget = resolveRendererTarget(
  app.isPackaged,
  process.env.SWITCHBOARD_DEV_URL
);

process.on("unhandledRejection", (reason) => {
  // Never die silently. An unhandled rejection during startup previously left
  // a running process with no window and nothing in the log.
  // eslint-disable-next-line no-console
  console.error("[cadrane] unhandled rejection:", reason);
  // Kept on this Mac, redacted, and sent nowhere. The Settings toggle promised
  // "we get the stack trace" for a year without anything being captured at all;
  // this is the honest version of the same value (D-046).
  void recordCrash(app.getPath("userData"), "something failed in the background", reason);
});

process.on("uncaughtException", (error) => {
  // eslint-disable-next-line no-console
  console.error("[cadrane] uncaught exception:", error);
  void recordCrash(app.getPath("userData"), "the app hit an error it could not handle", error);
});

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  /**
   * Pin where the records live, before anything reads them.
   *
   * Electron derives `userData` from the package `name`, so the owner's book,
   * settings, contacts, connector approvals, saved agents and backup key all sit
   * under a directory named after a package — and renaming that package moves
   * every one of them. The app would then start, find nothing, and behave
   * exactly like a fresh install: no error, no warning, a completely normal
   * first run with the business's ledger gone.
   *
   * First thing, because everything below takes `app.getPath("userData")` and a
   * later call would leave half the app pointed at the old address.
   */
  app.setPath("userData", await resolveHome(app.getPath("appData")));

  installApplicationProtocol();
  hardenSession();
  // The local model failing must not take the app down with it. Before this
  // was guarded, a runtime that could not start rejected the whole startup
  // chain: no IPC, no window, no explanation — just an unhandled rejection and
  // a Dock icon that did nothing. Rellane is still useful without it (docked
  // CLI, and every file skill needs no model at all), and the UI already has
  // states for a runtime that needs attention. They were simply unreachable.
  //
  // `start()` returns a boolean and never throws — every path inside it is
  // wrapped. That boolean used to be discarded and `markLocalRuntimeReady()`
  // ran unconditionally, so the failure branch below was unreachable and the
  // Engine Room reported "Answered on the private loopback port" for a model
  // whose file did not exist. Two rules were in tension: never report a
  // readiness that was not observed, and never block the window at startup.
  // Waiting for the health probe would have honoured the first and broken the
  // second, so the light now has a third state — it says it is checking, and
  // settles when the probe answers.
  try {
    const started = await bundledLocalRuntime.start({
      applicationPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      packaged: app.isPackaged
    });

    if (started) {
      markLocalRuntimeChecking();
      // Deliberately not awaited: the model takes up to ninety seconds to load
      // and the window must draw now.
      void bundledLocalRuntime
        .whenReady()
        .then((ready) => {
          if (ready) {
            markLocalRuntimeReady();
            return;
          }
          markLocalRuntimeFailed(
            bundledLocalRuntime.whyRefused() ??
              "The model on this Mac did not answer, so nothing here has been checked against it."
          );
        })
        .catch(() => {
          markLocalRuntimeFailed("The model on this Mac could not be reached.");
        });
    } else {
      markLocalRuntimeFailed(
        bundledLocalRuntime.whyRefused() ??
          "The model on this Mac could not be started."
      );
    }
  } catch (error) {
    const problem =
      error instanceof Error ? error.message : "The local model could not be started.";
    markLocalRuntimeFailed(problem);
    // eslint-disable-next-line no-console
    console.warn(`[cadrane] local runtime unavailable: ${problem}`);
  }
  daemon.configureBundledLocalRuntime(
    bundledLocalRuntime.authorizationBearer,
    bundledLocalRuntime.runtimeBaseUrl
  );
  /**
   * The automation workspace key, and a failure here is not fatal.
   *
   * This threw `RECOVERY_REQUIRED` after the records moved to their permanent
   * home, the rejection went unhandled, and **the app started with no window** —
   * the same failure shape as the bundler bug, from a completely different
   * cause. That is twice in one day that a startup step nobody can see took the
   * whole interface down.
   *
   * So the rule from D-043 is enforced here rather than restated: nothing at
   * startup may stop the window appearing. Automation is one feature; a black
   * screen is the whole app, and it is the state in which the owner cannot even
   * read what went wrong.
   */
  automationKeyReference = await unlockAutomationWorkspace().catch((error: unknown) => {
    diagnostics.warn("automation", "the workspace key needs recovery; automation is unavailable", {
      error: error instanceof Error ? error.message : "unknown"
    });
    automationProblem =
      error instanceof WorkspaceKeyBrokerError && error.code === "RECOVERY_REQUIRED"
        ? "Flows are locked. Their workspace was encrypted by an earlier version of this app, and macOS ties that encryption to the app's identity — so renaming it left the key unusable. The flows themselves are still on this Mac and nothing has been deleted."
        : "Flows are unavailable: this Mac would not unlock their workspace.";
    return null;
  });
  const settings = useSettingsStore(app.getPath("userData"));
  useLedger(app.getPath("userData"));
  useTimeline(app.getPath("userData"));
  const stored = await settings.read();
  // Before the window is built, so it opens in the right material rather than
  // flashing the system appearance and correcting itself.
  applyThemeToWindow(stored.theme);
  // Folders granted in a previous session are restored, one at a time, so a
  // folder that has since been deleted or moved is skipped rather than taking
  // the whole restore down with it.
  for (const root of stored.grantedRoots) {
    // Not swallowed. A grant that will not restore is the ordinary case after
    // an update — Rellane is ad-hoc signed, so macOS treats every build as a
    // different app and withdraws its folder permissions — and a folder that
    // silently vanishes from the rail is indistinguishable from a bug.
    await skillHost.grant(root).catch((error: unknown) => {
      const reason =
        error instanceof Error ? error.message : `${path.basename(root)} could not be opened.`;
      skillHost.recordLostGrant(root, reason);
      diagnostics.warn("workspace", "a granted folder did not come back", { root, reason });
    });
  }

  // After the restore loop, so only folders that actually came back are
  // watched. A folder whose grant an update withdrew is reported as lost
  // rather than watched into a stream of permission errors.
  await watchGrantedRoots();

  installIpcHandlers(daemon, () => mainWindow, automationUnavailable);

  /**
   * The book, opened once — and deliberately **not** awaited.
   *
   * Everything under `book/` existed, was tested, and had never been called:
   * the app had nowhere to put an invoice. Wiring it in, the first version
   * awaited this before creating the window, and the app started with no window
   * at all. Whatever the cause, awaiting was the mistake: **nothing about
   * opening a database should be able to stop the window appearing.** An app
   * that will not draw itself cannot show the owner the diagnostics that would
   * explain why, which is the worst possible failure mode for a startup step.
   *
   * Every handler that needs the book already treats `book === null` as a
   * retryable "not ready yet", so a slow or failed open degrades to a feature
   * that is briefly unavailable rather than to a black screen.
   */
  void useBook(app.getPath("userData")).catch((error: unknown) => {
    diagnostics.warn("book", "could not open the book", {
      error: error instanceof Error ? error.message : "unknown"
    });
  });
  mainWindow = createMainWindow();

  await mainWindow.loadURL(rendererTarget.url);

  // Built once and kept hidden: constructing a window per press is slow enough
  // to feel like a stall, and instant is the whole point of this surface.
  overlay = createOverlay({
    target: rendererTarget,
    accelerator: OVERLAY_HOTKEY,
    onEscalate: (request) => {
      // The overlay triggers; the window is where you approve. Approval is a
      // decision that deserves a real surface, not a 680px strip — but the
      // overlay does the reading first, so the plan is already on screen by
      // the time the window comes forward. Waiting for a folder scan *after*
      // the window appears would make the handoff feel like a stall.
      void handOff(request);
    }
  });

  pasteRuntime = createPasteRuntime({
    accelerator: PASTE_HOTKEY,
    notify: (result) => {
      // Always says what it did, including when it did nothing. A hotkey that
      // sometimes silently changes the clipboard and sometimes silently does
      // not is one nobody trusts enough to use.
      new Notification({
        title: result.unchanged ? "Pasted as-is" : "Reshaped",
        body: result.summary,
        silent: true
      }).show();
    }
  });

  // Mark answers from a phone. Presence is reported honestly rather than
  // assumed: a queued task must be able to say "your Mac is asleep".
  // WhatsApp is registered as a *handoff*: it composes the message and opens
  // WhatsApp with it prefilled, and a person presses send (D-033). It is the
  // one channel that can ship before any account setup exists, because it needs
  // no token, no verification and no session — which is also why it is the one
  // that cannot send behind the owner's back.
  // openExternal is the only place this app hands a URL to the OS. Both links
  // are built by their own module, which encodes every field, so nothing here
  // is assembled from renderer input.
  const openExternally = async (url: string): Promise<void> => {
    await shell.openExternal(url);
  };
  /**
   * Telegram joins the list only when a token has been saved.
   *
   * `telegram.ts` has been complete and tested since September and nothing ever
   * constructed it (D-112), so Mark could not answer a phone. Reading the token
   * is a small synchronous read that answers null on any failure — a missing
   * file, a Mac that will not decrypt, a rotated key — because nothing at
   * startup may block the window, and "Telegram is off" is a state the settings
   * screen can explain.
   */
  const telegramToken = telegramTokenStore(app.getPath("userData"), safeStorage).read();
  // One client for both directions. Its poll offset only matters to the poll,
  // and two clients would each hold their own — which is the same fight two
  // pollers have, for no benefit.
  const telegram = telegramToken === null ? null : new TelegramClient({ token: telegramToken });
  const channels = [
    whatsAppHandoff(openExternally),
    emailHandoff(openExternally),
    ...(telegram === null ? [] : [telegramChannel(telegram)])
  ];
  // The same channel objects Mark replies through, so an agent's draft and a
  // reply to a phone cannot diverge in how they open or what they log.
  useOutboundChannels(channels);
  mark = new Mark({
    host: skillHost,
    channels,
    // Built from what the owner has actually saved. Empty on a fresh install,
    // which means this Mac contacts nobody and obeys nobody until a name is
    // added — closed by default, in the one direction that cannot be undone.
    lock: new OutboundLock(stored.contacts)
  });

  // Mark can now hear a phone. `Mark.receive` enforces the contact list before
  // any work is queued (N10, D-035), and the workstation checks the owner chat
  // again on its own side. A stranger gets silence, which does not confirm this
  // Mac is listening.
  const connectTelegram = (client: TelegramClient): void => {
    /**
     * How this Mac talks back, for everything that is not a reply to a message
     * — a watch that found a price change, a session that finished.
     */
    useTelegramSender(async (chatId: string, text: string) => {
      const numericChatId = Number(chatId);
      if (!Number.isSafeInteger(numericChatId)) {
        // A chat id that is not a number is a configuration mistake. Refusing
        // beats posting into whatever NaN resolves to.
        throw new Error(`"${chatId}" is not a Telegram chat id.`);
      }
      await client.send(numericChatId, text);
    });

    /**
     * The workstation hears the phone first, and Mark keeps what it does not
     * claim.
     *
     * Every message used to go only to Mark, which knows one thing: tidying a
     * folder. So "how's it going", "stop", and every request for work were all
     * answered "I do not know how to do that yet" — the entire phone surface
     * this app had built was unreachable from an actual phone. Mark still gets
     * the folder work, because that is the one thing it does that the
     * workstation does not.
     */
    telegramPoll = startTelegramPoll({
      poll: (signal) => client.poll(signal),
      deliver: async (message) => {
        const chatId = String(message.chatId);

        /**
         * Mark is asked first, and only about what it knows.
         *
         * Its table is one skill wide — tidying a folder — and the workstation's
         * last branch claims anything at all, so asking the workstation first
         * would have quietly taken folder work away from the half that can
         * actually do it. Asking Mark first, and only when it recognises the
         * words, keeps each side's knowledge where it lives.
         */
        if (readIntent(message.text) !== null) {
          await mark!.receive({ channel: "telegram", from: chatId, text: message.text });
          return;
        }

        let claimed = false;
        try {
          const answer = await answerPhoneMessage(chatId, message.text, message.from);
          claimed = answer !== null;
        } catch {
          // A failure answering must not end the loop, and must not swallow the
          // message either — Mark gets its turn below.
          claimed = false;
        }
        if (claimed) {
          return;
        }
        await mark!.receive({ channel: "telegram", from: chatId, text: message.text });
      },
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          // Cleared on abort, so quitting does not wait out a backoff that only
          // exists because Telegram was already unreachable.
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        })
    });
  };

  if (telegram !== null) {
    connectTelegram(telegram);
  }

  /**
   * A token saved from the settings screen connects straight away.
   *
   * Building the client here rather than reusing the one above, because there
   * was no client above when this Mac started without a token — which is
   * exactly the case this exists for.
   */
  whenTelegramTokenSaved(async (token: string) => {
    if (telegramPoll !== null) {
      // Already polling. A second poller on one token is the fight described in
      // telegram.ts, and both lose.
      return true;
    }
    try {
      const client = new TelegramClient({ token });
      const outbound = telegramChannel(client);
      useOutboundChannels([...channels, outbound]);
      mark?.setChannels([...channels, outbound]);
      connectTelegram(client);
      return true;
    } catch {
      return false;
    }
  });

  /**
   * WhatsApp, collected rather than received.
   *
   * Meta only delivers by POSTing to a public address, which this Mac does not
   * have, so a Worker holds the messages and this collects them — outbound,
   * like the Telegram poll, so nothing listens here either.
   *
   * Absent configuration is the ordinary state and means send-only, which is
   * complete and useful on its own. No mailbox, no loop, no complaint.
   */
  const whatsAppConfig = whatsAppConfigStore(app.getPath("userData"), safeStorage).read();
  if (whatsAppConfig !== null && whatsAppConfig.mailboxUrl !== undefined && whatsAppConfig.collectSecret !== undefined) {
    const mailboxUrl = whatsAppConfig.mailboxUrl;
    const collectSecret = whatsAppConfig.collectSecret;
    const seen = new Set<string>();
    whatsAppPoll = startTelegramPoll({
      poll: async (signal) => {
        const inbound = await collectInbound({ mailboxUrl, collectSecret, signal });
        /**
         * The mailbox deletes after handing over, so a repeat means a
         * collection that failed in flight and was retried. Answering the
         * customer twice is worse than not answering the retry.
         */
        const fresh = inbound.filter((message) => !seen.has(message.id));
        for (const message of fresh) {
          seen.add(message.id);
        }
        // Bounded: a long-running Mac must not grow a set for every message it
        // has ever seen.
        while (seen.size > 2_000) {
          const oldest = seen.values().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
        return fresh.map((message) => ({
          updateId: 0,
          chatId: Number(message.from),
          from: message.name,
          text: message.text,
          messageId: 0
        }));
      },
      deliver: async (message) => {
        /**
         * The same door every other message uses. A customer is not the owner,
         * so the workstation's own owner-chat check refuses to act on it and
         * answers nothing — which is the correct behaviour until there is a
         * screen for reading customer enquiries.
         */
        await answerPhoneMessage(String(message.chatId), message.text, message.from);
      },
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        })
    });
  }

  // Re-locked the moment the list is edited, rather than on next launch.
  whenContactsChange((contacts) => mark?.setLock(new OutboundLock(contacts)));
  mark.setPresence("awake");
  powerMonitor.on("suspend", () => mark?.setPresence("asleep"));
  powerMonitor.on("resume", () => {
    mark?.setPresence("awake");
    void mark?.drain();
  });

  if (!bindHotkey(OVERLAY_HOTKEY, () => overlay?.toggle())) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cadrane] ${OVERLAY_HOTKEY} is already taken by another app; the overlay can still be opened from the app.`
    );
  }
});

app.on("second-instance", () => {
  if (mainWindow === null) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

/** Why flows are unavailable, for the screen that has to say so. */
export function automationUnavailable(): string | null {
  return automationProblem;
}

// A cancelled close must leave the app usable. Electron asks renderers about
// unsaved work before will-quit, so shutdown begins only after that decision.
app.on("will-quit", (event) => {
  // Stop listening before anything else winds down. The loop is holding an
  // open request to Telegram, and a quit that leaves it is a quit that hangs.
  telegramPoll?.stop();
  telegramPoll = null;
  // The same for the mailbox collection, which is holding its own request.
  whatsAppPoll?.stop();
  whatsAppPoll = null;
  if (quitCleanupFinished) {
    return;
  }
  event.preventDefault();
  if (quitCleanupStarted) {
    return;
  }
  quitCleanupStarted = true;
  const reference = automationKeyReference;
  void runShutdownSteps([
    { name: "workspace lock", run: () => reference === null ? undefined : daemon.lockDurableSpace(reference) },
    { name: "local service", run: () => daemon.disable() },
    { name: "local model", run: () => bundledLocalRuntime.stop() },
    { name: "presence", run: () => mark?.setPresence("offline") },
    { name: "connectors", run: () => dropAllConnectors() },
    { name: "folder watches", run: () => stopWatchingFolders() },
    { name: "file skills", run: () => skillHost.dispose() },
    // Before the book, and deliberately: a native session interrupted by the
    // quit still has a partial answer and an interrupted receipt to write, and
    // a closed book would lose both — which is the difference between a session
    // that was stopped and one that appears never to have happened.
    { name: "workstation", run: () => workstationShutdown() },
    { name: "book", run: () => closeBook() },
    { name: "paste", run: () => pasteRuntime?.dispose() },
    { name: "overlay", run: () => overlay?.destroy() }
  ], name => diagnostics.error("shutdown", `Could not finish cleanup for ${name}.`)).finally(() => {
    mark = null;
    pasteRuntime = null;
    overlay = null;
    automationKeyReference = null;
    quitCleanupFinished = true;
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
    void mainWindow.loadURL(rendererTarget.url);
  }
});

/**
 * Carries an overlay action into the main window.
 *
 * A skill is previewed here rather than in the renderer so the plan travels
 * with the event: the window opens with the sheet already up. Anything that
 * goes wrong travels too, as a sentence, because an overlay that silently
 * opens an empty window is worse than one that says what happened.
 */
async function handOff(request: { kind: string; id: string; query: string }): Promise<void> {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    return;
  }

  const show = () => {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  };

  if (request.kind !== "skill") {
    show();
    window.webContents.send("cadrane:handoff", { kind: request.kind, query: request.query });
    return;
  }

  const skill = request.id.startsWith("skill:") ? request.id.slice("skill:".length) : request.id;
  const folder = skillHost.grantedRoots()[0];
  if (folder === undefined) {
    show();
    window.webContents.send("cadrane:handoff", {
      kind: "skill",
      query: request.query,
      problem: "Grant a folder first — a skill cannot touch a file until you choose where."
    });
    return;
  }

  try {
    const preview = await skillHost.preview(skill, folder);
    show();
    window.webContents.send("cadrane:handoff", {
      kind: "skill",
      query: request.query,
      preview,
      folder
    });
  } catch (error) {
    show();
    window.webContents.send("cadrane:handoff", {
      kind: "skill",
      query: request.query,
      problem: error instanceof Error ? error.message : "That folder could not be read."
    });
  }
}

function createMainWindow(): BrowserWindow {
  const platformTitleBar = process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset" as const,
        trafficLightPosition: { x: 18, y: 18 }
      }
    : {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: {
          color: "#f1efe9",
          symbolColor: "#1a1d24",
          height: 44
        }
      };
  /**
   * The window's material.
   *
   * `vibrancy` is what makes this feel like a macOS application rather than a
   * web page in a frame, and it cannot be faked in CSS: `backdrop-filter` can
   * only blur what is inside the page, while `under-window` samples the desktop
   * behind the window. The two work together — this provides the ground, and
   * the renderer's blurred surfaces sit on top of it.
   *
   * `visualEffectState: "active"` keeps the material lit when the window is not
   * focused. The default greys it out, which on a tool somebody glances at
   * while working in another app makes it look disabled.
   *
   * The background must be transparent for any of it to show. It used to be
   * `#f2f0eb` — an opaque light colour on a dark-first application, which was
   * both wrong in dark mode and enough to hide the material entirely.
   */
  const material = process.platform === "darwin"
    ? {
        vibrancy: "under-window" as const,
        visualEffectState: "active" as const,
        backgroundColor: "#00000000"
      }
    : { backgroundColor: "#14100B" };

  const window = new BrowserWindow({
    ...platformTitleBar,
    ...material,
    title: "Rellane",
    width: 1420,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedRendererUrl(destination, rendererTarget)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      title: "Keep your unfinished work",
      message: "Some changes haven’t been saved.",
      detail: "Keep editing to save your output or copy an unsaved message before closing. Your saved work stays on this Mac.",
      buttons: ["Keep editing", "Close without saving"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice === 1) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  return window;
}

function hardenSession(): void {
  const appSession = session.defaultSession;
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  appSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url, rendererTarget)) {
      callback({ cancel: false });
      return;
    }
    const csp = rendererTarget.development
      ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp]
      }
    });
  });
}

const AUTOMATION_SPACE_ID = "85b9e9f2-b1af-4e4b-a9ef-6b4a767b4d10";

async function unlockAutomationWorkspace(): Promise<WorkspaceKeyReference> {
  const store = new FileWrappedWorkspaceKeyStore(app.getPath("userData"));
  const broker = new WorkspaceKeyBroker({
    safeStorage,
    store
  });
  let reference = await store.reference(AUTOMATION_SPACE_ID);
  if (reference === undefined) {
    reference = await broker.createWorkspaceKey(AUTOMATION_SPACE_ID);
  }
  await broker.withUnlockedKey(reference, async (keyMaterial) => {
    await daemon.unlockDurableSpace({
      ...reference,
      keyMaterial
    });
  });
  return reference;
}
