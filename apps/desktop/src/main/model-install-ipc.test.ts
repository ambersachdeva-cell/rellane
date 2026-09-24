import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    exposedBridge: null as unknown,
    exposed: {} as Record<string, unknown>,
    invoke: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(async () => ({
      canceled: true,
      filePaths: []
    }))
  };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => "/tmp/switchboard-main-data"
  },
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      // Captured by name. The preload exposes more than one bridge now, and a
      // single slot silently recorded whichever ran last.
      electron.exposed[name] = value;
      if (name === "cadrane") {
        electron.exposedBridge = value;
      }
    }
  },
  dialog: {
    showOpenDialog: electron.showOpenDialog
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => Promise<unknown>
    ) => {
      electron.handlers.set(channel, handler);
    }
  },
  ipcRenderer: {
    invoke: electron.invoke
  },
  utilityProcess: {
    fork: vi.fn()
  }
}));

import {
  DAEMON_PROTOCOL_VERSION,
  DESKTOP_BRIDGE_VERSION,
  type DesktopBridge,
  type ModelInstallStatus
} from "@cadrane/contracts";
import {
  assertCompatibleDaemonProtocol,
  readProtocolVersion
} from "./daemon-client.js";
import {
  installIpcHandlers,
  IPC_CHANNELS,
  MODEL_INSTALL_TIMEOUT_MS
} from "./ipc.js";
import "../preload/index.js";

const modelId = "qwen3-4b-q4-k-m";
const operationId = "22222222-2222-4222-8222-222222222222";
const status: ModelInstallStatus = {
  modelId,
  state: "installed",
  operationId,
  catalogGeneration: 1,
  artifactSha256:
    "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
  bytesReceived: 2_497_280_256,
  totalBytes: 2_497_280_256,
  resumeAvailable: false,
  detail: "Installed after exact verification.",
  error: null,
  updatedAt: "2026-08-01T00:00:00.000Z"
};

beforeEach(() => {
  electron.handlers.clear();
  electron.invoke.mockClear();
});

describe("desktop model installation IPC v4 boundary", () => {
  it("registers only version-derived v4 channels for the current bridge", () => {
    const { daemon, getWindow } = fixture(async () => [status]);
    installIpcHandlers(daemon, getWindow);

    expect(DAEMON_PROTOCOL_VERSION).toBe(5);
    expect(DESKTOP_BRIDGE_VERSION).toBe(4);
    // The reviewed attack surface, written out.
    //
    // This was a count, and a count is a bad guard: it fails with "expected 35,
    // got 36", which tells a reviewer that the surface grew but not what got
    // added, and the cheapest way to make it pass is to edit the number. Naming
    // every channel means the diff *is* the review — adding one shows up as a
    // new line with its name on it, and nobody can widen the bridge by touching
    // an integer.
    //
    // Last review 2026-08-25. Every channel below is sender-checked, and none
    // accepts a filesystem path the renderer did not obtain from a Finder
    // picker. activity-read is the newest: it returns already-phrased sentences
    // and folder basenames, never a path the renderer could replay, and never
    // the ledger's own entry contents. Add a line here only after deciding the
    // channel belongs.
    expect(new Set(Object.values(IPC_CHANNELS))).toEqual(new Set([
      "cadrane:v4:system-profile",
      "cadrane:v4:runtime-discover",
      "cadrane:v4:runtime-chat",
      "cadrane:v4:runtime-cancel",
      "cadrane:v4:automation-snapshot",
      "cadrane:v4:automation-agent-save",
      "cadrane:v4:automation-workflow-save",
      "cadrane:v4:automation-memory-save",
      "cadrane:v4:automation-source-import",
      "cadrane:v4:automation-artifact-review",
      "cadrane:v4:automation-connector-ensure-local",
      "cadrane:v4:automation-pack-export",
      // Reviewed 2026-09-02. Takes one workflow id and returns a walk of that
      // flow: order, agents, and which steps would stop to ask. Spends nothing,
      // writes nothing, sends nothing, and persists nothing.
      "cadrane:v4:automation-dry-run",
      // Reviewed 2026-09-03. Takes one workflow id and replays it against the
      // trigger folder's capture history. Reads timestamps only — never the
      // filenames, which are not needed to count how often a folder moved.
      "cadrane:v4:automation-backtest",
      // Reviewed 2026-09-03. `flow-templates` returns a static list and reads
      // nothing. `flow-from-template` takes one template name, builds the flow
      // switched off — there is no parameter that could arm it — and saves it
      // through the ordinary workflow save, which is still what validates it.
      // Neither carries a folder path.
      /**
       * Reviewed 2026-09-03. The BYO-key fallback (D-022's third position).
       * `engine-key-status` reports only *whether* a key is stored, never what
       * it is — a status channel that could return one would be a way to read a
       * key out of the app. `engine-key-save` writes to the encrypted secret
       * store and logs the engine only, never the key or its length. Nothing
       * here reads a key back to the renderer.
       */
      /**
       * Reviewed 2026-09-03. Reads only, takes no input, and returns counts and
       * engine labels — never a question and never a turn. The corpus behind it
       * keeps no turn text at all: those are the owner's business discussed at
       * length, and counting is enough to route with.
       */
      /**
       * Reviewed 2026-09-03. The front door. Takes one bounded string and
       * returns words, or the *name* of a surface for the renderer to open. It
       * performs nothing: it cannot store a bill, send a message, or reach a
       * folder, and every surface it can name still asks what it always asked.
       * Spends one call on the cheapest ready engine, and only when nothing
       * cheaper could answer.
       */
      /**
       * Reviewed 2026-09-03. Opens a Finder picker — the picker is the grant,
       * the same rule folders follow — and reads one file with macOS's own
       * Vision and PDFKit through a helper binary that inherits none of this
       * app's environment. Nothing is uploaded. What comes back is a proposal
       * from the same extractor a paste uses, and the ordinary add-invoice
       * channel is still the only thing that can store one.
       */
      /**
       * Reviewed 2026-09-03. The one channel that hands a string to the
       * operating system. It takes an allowlist of three schemes — a WhatsApp
       * chat, a UPI request, and this project's releases page — and refuses
       * everything else, because `shell.openExternal` will otherwise run
       * `file://` and any registered custom handler. It opens; it never sends.
       */
      "cadrane:v4:open-link",
      "cadrane:v4:book-read-file",
      "cadrane:v4:desk-say",
      "cadrane:v4:bench-routing",
      "cadrane:v4:engine-key-status",
      "cadrane:v4:engine-key-save",
      "cadrane:v4:engine-key-forget",
      "cadrane:v4:flow-templates",
      "cadrane:v4:flow-from-template",
      "cadrane:v4:automation-pack-import",
      "cadrane:v4:automation-run-start",
      "cadrane:v4:automation-run-action",
      "cadrane:v4:model-recommend",
      "cadrane:v4:model-pick-gguf",
      "cadrane:v4:model-installations",
      "cadrane:v4:model-license-review",
      "cadrane:v4:model-license-acknowledge",
      "cadrane:v4:model-install",
      "cadrane:v4:model-install-cancel",
      "cadrane:v4:subscription-ask",
      "cadrane:v4:subscription-dock",
      "cadrane:v4:subscription-undock",
      "cadrane:v4:subscription-status",
      "cadrane:v4:workspace-grant",
      // Reads only, and returns folder paths the renderer already receives from
      // workspace-roots plus a sentence explaining why each will not open.
      "cadrane:v4:workspace-lost",
      "cadrane:v4:workspace-revoke",
      "cadrane:v4:workspace-roots",
      "cadrane:v4:diagnostics-bundle",
      "cadrane:v4:settings-read",
      "cadrane:v4:settings-write",
      "cadrane:v4:activity-read",
      "cadrane:v4:skill-catalogue",
      "cadrane:v4:skill-preview",
      "cadrane:v4:skill-run",
      "cadrane:v4:skill-undo",
      // Reviewed 2026-09-01. Reads only, takes no input, and returns each
      // agent's brief resolved against the ceiling plus the prompt generated
      // from it. Folder names appear inside a sentence; no replayable path
      // crosses, and the resolution happens here rather than in the renderer so
      // one place decides what an agent may do.
      "cadrane:v4:agents-list",
      // Reviewed 2026-09-01. The one channel here that starts a process. It
      // takes an agent id and a question, both bounded; the ceiling is read
      // from the host rather than accepted from the renderer, so the caller
      // cannot widen what an agent may touch by asking. It returns a result
      // rather than rejecting, and it cannot send anything outbound — no
      // capability it can reach has that power.
      "cadrane:v4:agents-run",
      // Reviewed 2026-09-08. The native picker reads one bounded text file only
      // within this agent's resolved host grants. A document/agent/scope-bound
      // one-use token selects the snapshot for Run; no renderer file path or
      // source text is accepted as authority. Discard performs no model work.
      "cadrane:v4:agent-preview-source",
      "cadrane:v4:agent-discard-source",
      // Reviewed 2026-09-01. Writes a brief the owner wrote into settings. The
      // shape is bounded here by zod and clamped *again* by `rehydrate` on the
      // way out — two layers because they stop different things: this one stops
      // a hostile renderer, the other stops a hand-edited settings file. The id
      // is restricted to `[a-z0-9-]` and the three shipped ids are refused
      // outright, so a saved brief cannot shadow an agent the owner recognises
      // by name while carrying a different folder and a different outbound
      // policy. Folder paths are accepted but grant nothing: what an agent may
      // actually reach is resolved against real grants at run time, so naming a
      // folder here that was never granted produces a withheld-permission line
      // rather than access. It returns the resolved roster, never the stored
      // shape, so the screen shows what will run.
      // Reviewed 2026-09-02. Takes one bounded sentence and returns a brief for
      // the editor — it never saves. The folders offered to the model are read
      // from the host, so a draft cannot name its way into somewhere that was
      // not granted, and every value comes back through the same clamping a
      // hand-written brief gets. Spends one call on the cheapest ready engine.
      /**
       * Reviewed 2026-09-02. The book's four channels, and the first way any
       * business data has ever been able to enter or leave it.
       *
       * `book-standing` reads only and takes no input; every figure it returns
       * is derived from the bills at the moment it is asked for, so no balance
       * is stored and none can drift. The three writers accept the owner typing
       * their own customers and bills into their own book on their own Mac —
       * nothing here reaches a network, and a `.strict()` schema with `.int()`
       * on every amount is what keeps a float out of a ledger that is defined
       * in integer paise. A bill carrying a `confidence` (read off a document
       * rather than typed) is stored as a draft and cannot reach a balance
       * until a person confirms it.
       */
      /**
       * Reviewed 2026-09-02. The Vault's two channels and the memory screen's
       * three.
       *
       * `vault-sync` takes no input. It reads the owner's own prose back out of
       * the markdown and then writes the whole book out into the app's storage —
       * never into a folder granted for work, where the agents this product
       * ships would tidy it. The inbound half is prose only: the reader has no
       * code path that produces a number, so an amount edited in a text file
       * cannot reach a balance. `vault-reveal` takes no input either and opens
       * one fixed path in Finder.
       *
       * `memory-read` returns what has been seen — learned words with their
       * evidence, folder counts (never filenames), and the owner's own notes.
       * `memory-hide` takes a term key, and `workspace-pause` takes a path that
       * must already be granted, refusing anything else: it writes into the list
       * that decides what may be read, so a path the renderer invented must not
       * survive it.
       */
      "cadrane:v4:vault-sync",
      "cadrane:v4:vault-reveal",
      /**
       * Reviewed 2026-09-03. The only outbound request in this app that is not
       * a message, and it is owner-pressed: no timer, no launch ping. It sends
       * nothing about this Mac — no version, no identifier, no query — and the
       * comparison happens here on what came back. `update-open` opens one fixed
       * page in the browser; Rellane never downloads or installs anything.
       */
      // Reviewed 2026-09-03. Takes an agent id and aborts that run's own
      // controller — the same path the brief's clock takes, so the record shows
      // it as stopped rather than failed. It cannot start anything.
      "cadrane:v4:agents-stop",
      /**
       * Reviewed 2026-09-03. `agent-export` writes one brief to a path chosen
       * in a Finder save box, 0o600, refusing to overwrite. The file carries
       * what the agent is *for* and never what it may *touch*: no folder paths,
       * no keys, no permissions — a pinned engine survives as a preference the
       * receiving Engine Room may ignore. `agent-import` reads one file the
       * owner picked, rebuilds it from fields this build recognises, and saves
       * nothing; the ordinary save channel is still the only way an agent
       * enters the roster, so an imported brief is clamped by the same ceiling
       * as a typed one. There is no route from a document to a folder grant.
       */
      "cadrane:v4:agent-export",
      "cadrane:v4:agent-import",
      "cadrane:v4:update-check",
      "cadrane:v4:update-open",
      "cadrane:v4:memory-read",
      "cadrane:v4:memory-hide",
      "cadrane:v4:workspace-pause",
      "cadrane:v4:book-standing",
      // Reviewed 2026-09-02. Takes bounded pasted text and returns a *proposal*
      // — it writes nothing. Every figure comes back with the words it was read
      // from so a person can check it, and only the ordinary add-invoice channel
      // can store anything. Spends one call on the cheapest ready engine, and
      // the pasted text is never logged.
      "cadrane:v4:book-read",
      "cadrane:v4:book-add-party",
      "cadrane:v4:book-add-invoice",
      "cadrane:v4:book-add-payment",
      "cadrane:v4:today-read",
      "cadrane:v4:cases-list",
      "cadrane:v4:cases-open",
      "cadrane:v4:cases-read",
      "cadrane:v4:cases-say",
      // A native picker grants one preview; only its scoped token and optional
      // excerpt offsets can commit it. No renderer path or source body is accepted.
      "cadrane:v4:cases-preview-source",
      "cadrane:v4:cases-add-source",
      "cadrane:v4:cases-discard-source",
      // Data review resolves a saved CSV inside one room. Only typed count/total,
      // filter and group choices cross the bridge; no SQL, path or result body.
      "cadrane:v4:cases-review-data",
      "cadrane:v4:cases-save-data-review",
      "cadrane:v4:cases-add-data-sample",
      // Selected in-room context to the bundled runtime only; cancellation is
      // bound to case + operation, and export writes a new owner-chosen file.
      "cadrane:v4:cases-local-state",
      "cadrane:v4:cases-ask-local",
      "cadrane:v4:cases-prepare-enquiry",
      "cadrane:v4:cases-save-enquiry-review",
      "cadrane:v4:cases-stop-local",
      "cadrane:v4:cases-export-turn",
      "cadrane:v4:cases-save-artifact",
      "cadrane:v4:cases-accept-artifact",
      "cadrane:v4:cases-export-artifact",
      "cadrane:v4:cases-close",
      "cadrane:v4:cases-erase",
      /**
       * Reviewed 2026-09-14. The workstation: one native subscription session,
       * inside one case, reviewed before it runs.
       *
       * Three of the eight only read — `workstation-providers` reports which
       * CLIs are on disk (never whether an account works, which is only
       * knowable from a real attempt), `workstation-routines` returns a fixed
       * list of prompts, and `workstation-state` returns one case's snapshot.
       *
       * `workstation-choose-workspace` takes no input and opens a Finder
       * picker, returning an opaque id; the picker is the grant, so there is no
       * way to pass a path in. `workstation-prepare` validates the open case,
       * the explicitly selected source turns, the provider and the model, and
       * returns the *exact* outgoing packet with its SHA-256 for a person to
       * read; it starts nothing. `workstation-start` takes a single-use token
       * bound to that review, to this window and to this document, and nothing
       * else — there is no field on it for a prompt, a path, a model or an
       * approval flag, so what runs is what was reviewed. `workstation-stop`
       * and `workstation-decide` each name one operation id and are refused
       * when it is not the one in flight; a decision is for one request only
       * and is written into the case as a receipt.
       *
       * No credential, auth file or keychain item is read by anything behind
       * these channels, and the API-key environment fallbacks are removed from
       * every child process so a session cannot quietly become pay-per-token.
       */
      "cadrane:v4:workstation-providers",
      "cadrane:v4:workstation-choose-workspace",
      // Reviewed 2026-09-14 after the installed file-building check. Takes a
      // case id and optional current-window folder handle, never a path. The
      // host resolves an existing directory; Finder selects it without opening
      // a model-provided file or URL. This does not restore a native tool grant.
      "cadrane:v4:workstation-reveal-workspace",
      // Reviewed 2026-09-14: local continuity, no execution. All six require
      // the trusted renderer; strict bounded inputs reject path/tool/grant fields.
      // Saves append immutable versions with stale-update rejection. Assignment
      // and verbatim capture require an idle, existing open case. Captured text
      // enters the ordinary selected-source review; it cannot grant a run.
      "cadrane:v4:workstation-continuity",
      // Reviewed 2026-09-14: local original image storage. Import takes only a
      // task id and uses a native picker; bounded reads, header preflight and
      // native decoding precede storage. Preview returns a resized data URL.
      // Export scopes the asset to its task and uses a native save dialog,
      // preserving bytes and refusing replacement. Dialogs are document-bound;
      // no renderer paths, remote URLs, execution grants or automatic sends.
      // Local-only file relevance: same-document one-use shortcut, bounded saved
      // source IDs, no paths/tool grants/remote destination or implicit selection.
      "cadrane:v4:workstation-context-suggest",
      "cadrane:v4:workstation-images",
      "cadrane:v4:workstation-image-import",
      "cadrane:v4:workstation-image-preview",
      "cadrane:v4:workstation-image-export",
      "cadrane:v4:workstation-creative-list",
      "cadrane:v4:workstation-creative-save",
      "cadrane:v4:workstation-creative-copy",
      "cadrane:v4:workstation-creative-open",
      "cadrane:v4:workstation-creative-link",
      // Explicit local reference checking over selected saved sources only.
      "cadrane:v4:workstation-check-citations",
      // Reviewed 2026-09-14 after native use exposed indistinguishable titles.
      // Strict, trusted, idle-only metadata edit. Expected title prevents stale
      // updates; original question, turns, source versions and grants are untouched.
      "cadrane:v4:workstation-rename-work",
      "cadrane:v4:workstation-project-save",
      "cadrane:v4:workstation-project-assign",
      "cadrane:v4:workstation-project-capture",
      "cadrane:v4:workstation-routine-save",
      "cadrane:v4:workstation-routine-versions",
      "cadrane:v4:workstation-routines",
      "cadrane:v4:workstation-prepare",
      "cadrane:v4:workstation-speak",
      "cadrane:v4:workstation-start",
      "cadrane:v4:workstation-state",
      "cadrane:v4:workstation-running",
      "cadrane:v4:workstation-agent-start",
      "cadrane:v4:workstation-agent-poll",
      "cadrane:v4:workstation-agent-stop",
      "cadrane:v4:workstation-dispatch-start",
      "cadrane:v4:workstation-dispatch-poll",
      "cadrane:v4:workstation-dispatch-stop",
      "cadrane:v4:workstation-pairing-status",
      "cadrane:v4:workstation-pairing-start",
      "cadrane:v4:workstation-pairing-stop",
      "cadrane:v4:workstation-dictation-status",
      "cadrane:v4:workstation-dictation-write",
      "cadrane:v4:workstation-dictation-stop",
      "cadrane:v4:workstation-document-pick",
      "cadrane:v4:workstation-document-formats",
      "cadrane:v4:workstation-semantic-status",
      "cadrane:v4:workstation-semantic-search",
      "cadrane:v4:workstation-publish-preview",
      "cadrane:v4:workstation-publish-write",
      "cadrane:v4:workstation-crew-start",
      "cadrane:v4:workstation-crew-poll",
      "cadrane:v4:workstation-crew-stop",
      "cadrane:v4:workstation-telegram-status",
      "cadrane:v4:workstation-telegram-notify",
      "cadrane:v4:workstation-agents-list",
      "cadrane:v4:workstation-agent-save",
      "cadrane:v4:workstation-agent-delete",
      // Going and reading, rather than answering from memory. Only the start
      // leaves this Mac, and only through the same private-network guards the
      // owner's own web read uses.
      "cadrane:v4:workstation-research-start",
      "cadrane:v4:workstation-research-poll",
      "cadrane:v4:workstation-research-stop",
      // What the app worked out about a project, and striking any of it out.
      // Read and written on this Mac only; nothing here is sent anywhere.
      "cadrane:v4:workstation-memory-read",
      "cadrane:v4:workstation-memory-learn",
      "cadrane:v4:workstation-memory-set",
      "cadrane:v4:workstation-memory-forget",
      // What a session changed in a folder, and putting a file back. The
      // restore refuses any path that resolves outside the folder it was given.
      "cadrane:v4:workstation-changes-list",
      "cadrane:v4:workstation-change-contents",
      "cadrane:v4:workstation-change-restore",
      // Watching a page, a folder or a routine between visits.
      "cadrane:v4:workstation-watch-list",
      "cadrane:v4:workstation-watch-save",
      "cadrane:v4:workstation-watch-remove",
      "cadrane:v4:workstation-watch-now",
      // Who has knocked, and saying one of them is him. The only path by which a
      // fresh install ever gains its first obeyed chat.
      "cadrane:v4:workstation-phone-knocks",
      "cadrane:v4:workstation-phone-pair",
      "cadrane:v4:workstation-usage",
      "cadrane:v4:workstation-self-check",
      "cadrane:v4:workstation-stop",
      "cadrane:v4:workstation-decide",
      // Reaching the document converter and the vendored voice. Both are
      // one-at-a-time, trusted-sender-only, and neither reaches the network.
      // The capabilities that had tested modules and no way in. Each is
      // trusted-sender-only; the two that touch the world — a Mac action and a
      // web read — are each described and approved before anything happens.
      "cadrane:v4:workstation-audit-export",
      "cadrane:v4:workstation-book-search",
      "cadrane:v4:workstation-capture-list",
      "cadrane:v4:workstation-capture-take",
      "cadrane:v4:workstation-delivery-pack",
      "cadrane:v4:workstation-document-import",
      "cadrane:v4:workstation-file-change",
      "cadrane:v4:workstation-file-preview",
      "cadrane:v4:workstation-files-list",
      "cadrane:v4:workstation-mac-describe",
      "cadrane:v4:workstation-mac-run",
      "cadrane:v4:workstation-paste-analyse",
      "cadrane:v4:workstation-table-parse",
      "cadrane:v4:workstation-table-query",
      "cadrane:v4:workstation-web-read",
      "cadrane:v4:agent-draft",
      // Reviewed 2026-09-09: one-use host handles bound to actual document and
      // kind, local-only work, exact Stop; no file path or runtime selector.
      "cadrane:v4:local-shortcut-begin",
      "cadrane:v4:local-shortcut-stop",
      "cadrane:v4:agent-save",
      // Reviewed 2026-09-01. Takes one bounded id and removes a stored brief.
      // Cannot remove a shipped agent, because those are not stored. Returns
      // the resolved roster like the save does.
      "cadrane:v4:agent-delete",
      // Reviewed 2026-09-01. Spends two subscriptions, so the review is about
      // cost as much as reach. It accepts a bounded question and nothing else:
      // the engines, the models, the seats and the round and token ceilings are
      // all chosen in the main process from the engine room, so a compromised
      // renderer can neither aim the pair at an engine of its choosing nor
      // uncap the budget. It touches no folder, file or tool — the Bench argues
      // about a question, it does not act on the Mac — and it returns a result
      // rather than rejecting, so a failure is a screen and not an exception.
      "cadrane:v4:bench-run",
      // Reviewed 2026-09-01. The only channel that can reach outside this Mac,
      // and it cannot send. Three gates, none of them here: the agent's brief
      // decides whether it may send at all (an agent whose row reads "sends
      // nothing" is refused even if this is called directly), the owner's stored
      // contact list decides who may be reached and is re-read on every call so
      // a removal is immediate, and the channel validates the address and length
      // before anything opens. Both registered channels declare
      // `delivery: "stages"` — they open the owner's own WhatsApp or Mail with
      // the message in it, so the most a compromised renderer achieves is a
      // window the owner is looking at, addressed to somebody they approved.
      // The text is capped and the channel name is an enum, so neither can be
      // used to reach an unregistered transport.
      "cadrane:v4:dispatch-stage",
      // Reviewed 2026-09-01. Takes no input at all. Both the connector list and
      // the per-tool approvals are read from stored settings, so the renderer
      // cannot name a command to execute — it can only ask what the owner has
      // already installed. Reading does start those processes, which is a real
      // side effect, but only of software the owner installed deliberately, and
      // every tool inside still needs its own approval pinned to its description
      // before an agent may call it (D-039). Tool descriptions come back as
      // untrusted text, already screened for injection, and are rendered as a
      // quote rather than as the app's own words.
      "cadrane:v4:connectors-read",
      "cadrane:v4:deal-add-line",
      "cadrane:v4:deal-allow",
      "cadrane:v4:deal-close",
      "cadrane:v4:deal-customer",
      "cadrane:v4:enquiry-add",
      "cadrane:v4:deal-draft",
      "cadrane:v4:deal-handoff",
      "cadrane:v4:deal-past-lines",
      "cadrane:v4:deal-read",
      "cadrane:v4:deal-message",
      "cadrane:v4:telegram-forget",
      // The business number. Sending is one message at a time, at the moment it
      // is approved; there is deliberately no queue and no bulk send.
      "cadrane:v4:whatsapp-status",
      "cadrane:v4:whatsapp-save",
      "cadrane:v4:whatsapp-forget",
      "cadrane:v4:whatsapp-send",
      "cadrane:v4:telegram-save",
      "cadrane:v4:telegram-status",
      "cadrane:v4:deal-read-enquiry",
      "cadrane:v4:deal-remove-line",
      "cadrane:v4:deal-send",
      "cadrane:v4:deal-triage",
      "cadrane:v4:deals-list",
      // Reviewed 2026-09-01. Opens a Finder dialog and takes no input at all —
      // the chosen path is the choice, and there is no way to pass one in, for
      // the same reason folder grants work this way. A destination inside
      // Rellane's own storage is refused with the reason, because a backup kept
      // beside the original survives a deleted file and nothing else.
      "cadrane:v4:backup-pick",
      // Reviewed 2026-09-01. Takes no input. Writes an encrypted archive to the
      // folder the owner already chose, then restores it into a temp copy and
      // opens it before recording success — so `lastSucceededAt` can never move
      // on an archive that would not open. The key comes from the Keychain via
      // safeStorage and is never written beside the data; a machine that cannot
      // provide one is refused rather than given an unencrypted copy under the
      // same file extension.
      "cadrane:v4:backup-now",
      // Reviewed 2026-08-31. Reads only, takes no input at all, and returns
      // what each engine's own version check printed. No credential is read or
      // forwarded; the executable path it returns is a CLI the owner installed
      // themselves, not a path into their files.
      "cadrane:v4:engine-room",
      // Timeline, reviewed 2026-08-31. All four take a `folder`, which is the
      // one place these differ from the rule above — but it is checked against
      // the granted roots inside TimelineService before anything is read, and a
      // granted root only ever came from a Finder picker. A folder the owner
      // never granted is refused rather than read.
      //
      // captures and diff return counts, timestamps and paths relative to the
      // granted root: legible to the person who granted the folder, and useless
      // to anything that does not already hold the root.
      "cadrane:v4:timeline-captures",
      "cadrane:v4:timeline-diff",
      // Writes, but only a capture of a folder already being watched, with a
      // reason bounded to 200 characters.
      "cadrane:v4:timeline-checkpoint",
      // The one that reads file contents. It takes a relative path and refuses
      // an absolute one or any path that resolves outside the granted root, and
      // it returns a digest — never the bytes it hashed.
      "cadrane:v4:timeline-hash"
    ]));
    expect(electron.handlers.has(
      // Deliberately the old spelling: this asserts a *legacy* channel is not
      // registered, so it is a historical fact and not a name to keep current.
      "switchboard:v1:model-installations"
    )).toBe(false);
  });

  it("rejects untrusted renderers and malformed privileged inputs before daemon dispatch", async () => {
    const request = vi.fn(async () => status);
    const { daemon, getWindow, event } = fixture(request);
    installIpcHandlers(daemon, getWindow);

    const install = handler(IPC_CHANNELS.modelInstall);
    await expect(install({
      ...event,
      senderFrame: { url: "https://evil.invalid/" }
    }, { modelId })).rejects.toThrow("Rejected untrusted renderer request");
    await expect(install(event, {
      modelId,
      destinationPath: "/tmp/private.gguf",
      downloadUrl: "https://private.invalid/model.gguf"
    })).rejects.toMatchObject({ name: "ZodError" });

    const acknowledge = handler(IPC_CHANNELS.modelLicenseAcknowledge);
    await expect(acknowledge(event, {
      modelId,
      artifactSha256: status.artifactSha256,
      catalogGeneration: 1,
      licenseNoticeVersion: "Apache-2.0-2004-static-beta-1",
      licenseNoticeSha256: "b".repeat(64),
      accepted: true,
      acceptedAt: "2026-08-01T00:00:00.000Z"
    })).rejects.toMatchObject({ name: "ZodError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects forged source paths, bodies and untrusted source-preview callers", async () => {
    const { daemon, getWindow, event } = fixture(async () => status);
    installIpcHandlers(daemon, getWindow);
    const preview = handler(IPC_CHANNELS.casesPreviewSource);
    await expect(preview({ ...event, senderFrame: { url: "https://evil.invalid/" } }, { id: "room" })).rejects.toThrow("Rejected untrusted renderer");
    await expect(preview(event, { id: "room", path: "/private/secret.txt" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(handler(IPC_CHANNELS.casesAddSource)(event, { id: "room", token: operationId, body: "forged source" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(handler(IPC_CHANNELS.casesDiscardSource)(event, { id: "room", token: "invalid" })).rejects.toMatchObject({ name: "ZodError" });
  });

  it("uses a bounded long install timeout and strictly parses daemon output", async () => {
    const request = vi.fn(async () => status);
    const { daemon, getWindow, event } = fixture(request);
    installIpcHandlers(daemon, getWindow);
    const result = await handler(IPC_CHANNELS.modelInstall)(
      event,
      { modelId }
    );

    expect(result).toEqual(status);
    expect(request).toHaveBeenCalledWith({
      type: "model.install.start",
      payload: { modelId }
    }, MODEL_INSTALL_TIMEOUT_MS, expect.any(AbortSignal));
    expect(MODEL_INSTALL_TIMEOUT_MS).toBe(12 * 60 * 60_000);

    request.mockResolvedValueOnce({
      ...status,
      modelPath: "/tmp/private/model.gguf",
      downloadUrl: "https://private.invalid/signed"
    } as unknown as ModelInstallStatus);
    await expect(handler(IPC_CHANNELS.modelInstall)(
      event,
      { modelId }
    )).rejects.toMatchObject({ name: "ZodError" });
  });

  it("aborts only the matching in-flight invoke when its renderer is destroyed", async () => {
    let capturedSignal: AbortSignal | undefined;
    const request = vi.fn((
      _request: unknown,
      _timeout: number,
      signal?: AbortSignal
    ) => {
      capturedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
    });
    const { daemon, getWindow, event, sender } = fixture(request);
    installIpcHandlers(daemon, getWindow);
    const pending = handler(IPC_CHANNELS.modelInstall)(
      event,
      { modelId }
    );
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    sender.emit("destroyed");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("parses snapshot, review, acknowledgement, and stale cancel results", async () => {
    const acknowledgement = {
      acknowledgementVersion: 1,
      modelId,
      artifactSha256: status.artifactSha256,
      licenseNoticeVersion: "Apache-2.0-2004-static-beta-1",
      licenseNoticeSha256: "b".repeat(64),
      catalogGeneration: 1,
      acceptedAt: "2026-08-01T00:00:00.000Z"
    } as const;
    const review = {
      modelId,
      displayName: "Qwen3 4B (Q4_K_M)",
      artifactSha256: status.artifactSha256,
      downloadBytes: status.totalBytes,
      catalogGeneration: 1,
      licenseId: "Apache-2.0",
      licenseName: "Apache License 2.0",
      licenseNoticeVersion: acknowledgement.licenseNoticeVersion,
      licenseNoticeSha256: acknowledgement.licenseNoticeSha256,
      noticeText: "Apache fixture notice.",
      sourceHost: "huggingface.co", repository: "Qwen/Test-GGUF",
      acknowledgementCurrent: false
    };
    const request = vi.fn(async (daemonRequest: { type: string }) => {
      switch (daemonRequest.type) {
        case "model.install.snapshot":
          return [status];
        case "model.license.review":
          return review;
        case "model.license.acknowledge":
          return acknowledgement;
        case "model.install.cancel":
          return { cancelRequested: false, status: null };
        default:
          throw new Error("Unexpected fixture route.");
      }
    });
    const { daemon, getWindow, event } = fixture(request);
    installIpcHandlers(daemon, getWindow);

    await expect(handler(IPC_CHANNELS.modelInstallations)(
      event,
      {}
    )).resolves.toEqual([status]);
    await expect(handler(IPC_CHANNELS.modelLicenseReview)(
      event,
      { modelId }
    )).resolves.toEqual(review);
    await expect(handler(IPC_CHANNELS.modelLicenseAcknowledge)(
      event,
      {
        modelId,
        artifactSha256: status.artifactSha256,
        catalogGeneration: 1,
        licenseNoticeVersion: acknowledgement.licenseNoticeVersion,
        licenseNoticeSha256: acknowledgement.licenseNoticeSha256,
        accepted: true
      }
    )).resolves.toEqual(acknowledgement);
    await expect(handler(IPC_CHANNELS.modelInstallCancel)(
      event,
      { operationId }
    )).resolves.toEqual({
      cancelRequested: false,
      status: null
    });
  });

  it("fails protocol version inspection closed for stale daemon messages", () => {
    expect(readProtocolVersion({ protocolVersion: 1 })).toBe(1);
    expect(readProtocolVersion({ protocolVersion: 3 })).toBe(3);
    expect(readProtocolVersion({ protocolVersion: "2" })).toBeNull();
    expect(() => assertCompatibleDaemonProtocol({
      protocolVersion: 1
    })).toThrow("does not match this desktop build");
    expect(() => assertCompatibleDaemonProtocol({
      protocolVersion: DAEMON_PROTOCOL_VERSION
    })).not.toThrow();
  });
});

describe("frozen preload model bridge", () => {
  it("exposes only typed product methods and no generic IPC surface", async () => {
    const bridge = electron.exposedBridge as DesktopBridge & {
      send?: unknown;
      on?: unknown;
      invoke?: unknown;
    };
    expect(bridge.version).toBe(4);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.models)).toBe(true);
    expect(Object.isFrozen(bridge.automations)).toBe(true);
    expect(bridge.send).toBeUndefined();
    expect(bridge.on).toBeUndefined();
    expect(bridge.invoke).toBeUndefined();
    // The overlay is a global-hotkey surface, so its bridge is held to a
    // tighter bound than the main one: two calls, nothing else, frozen.
    const overlay = electron.exposed["cadraneOverlay"] as Record<string, unknown>;
    expect(Object.isFrozen(overlay)).toBe(true);
    expect(Object.keys(overlay).sort()).toEqual(["hide", "run"]);

    expect(Object.keys(bridge.models).sort()).toEqual([
      "acknowledgeLicense",
      "cancelInstall",
      "install",
      "installations",
      "licenseReview",
      "pickAndInspectGguf",
      "recommend"
    ]);
    expect(Object.keys(bridge.bench).sort()).toEqual(["routing", "run"]);
    expect(Object.keys(bridge.automations).sort()).toEqual([
      "action",
      "backtest",
      // Reads only, and spends nothing: it walks a flow with the same rule the
      // executor uses and returns what would happen.
      "dryRun",
      "ensureLocalConnector",
      "exportPack",
      "fromTemplate",
      "importPack",
      "importSources",
      "reviewArtifact",
      "saveAgent",
      "saveMemory",
      "saveWorkflow",
      "snapshot",
      "start",
      "templates"
    ]);

    await bridge.models.installations();
    await bridge.models.licenseReview(modelId);
    await bridge.models.install(modelId);
    await bridge.models.cancelInstall(operationId);

    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.modelInstallations, {}],
      [IPC_CHANNELS.modelLicenseReview, { modelId }],
      [IPC_CHANNELS.modelInstall, { modelId }],
      [IPC_CHANNELS.modelInstallCancel, { operationId }]
    ]);
  });
});

function fixture(
  request: (...args: any[]) => Promise<unknown>
) {
  const sender = new EventEmitter() as EventEmitter & {
    getURL(): string;
    mainFrame: unknown;
    session: { getStoragePath(): string };
  };
  const frame = { url: "switchboard://app/index.html" };
  sender.getURL = () => frame.url;
  sender.mainFrame = frame;
  sender.session = {
    getStoragePath: () => "/tmp/switchboard-main-data"
  };
  const window = {
    webContents: sender
  };
  const event = {
    sender,
    senderFrame: frame
  };
  return {
    daemon: { request } as never,
    getWindow: () => window as never,
    event,
    sender
  };
}

function handler(channel: string) {
  const registered = electron.handlers.get(channel);
  if (registered === undefined) {
    throw new Error(`Missing fixture IPC handler for ${channel}.`);
  }
  return registered;
}
