/**
 * The workstation host: a native subscription session somebody reviewed first.
 *
 * The organising rule is that **consent is a token, not a flag**. `prepare`
 * assembles the exact bytes that would leave this Mac, hashes them, and hands
 * back a review carrying that hash, the provider, the model and the folder. The
 * token in that review is thirty-two random bytes, lives five minutes, is bound
 * to the window and document that asked, and is consumed *before* a process is
 * launched. Nothing in this module can reach a provider by any other route, so
 * "it ran without being approved" is not a bug that can be introduced by
 * forgetting a check somewhere — there is no second door.
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
import type {
  ContextSource,
  ExtractedArtifact,
  NativeEvent,
  NativeProviderLaunch,
  NativeWorker,
  NativeWorkerFactory,
  NativeWorkerOptions,
  NativeWorkerResult,
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

/**
 * Everything with a side effect, named.
 *
 * The worker modules (`codex.ts`, `claude.ts`, `gemini.ts`, `context.ts`,
 * `store.ts`, `routines.ts`) are reached only through these, so this file
 * imports none of them and the host's decisions can be exercised on their own.
 */
export interface WorkstationHostDeps {
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
  }) => WorkstationContext;
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
  /** What an answer appears to contain. Named in the receipt; nothing is saved. */
  readonly extractArtifacts: (text: string) => readonly ExtractedArtifact[];
  readonly now: () => number;
  /**
   * A session is about to touch this folder.
   *
   * Called once, immediately before the worker is launched, so that whatever
   * wants to know what the folder looked like beforehand gets its chance while
   * "beforehand" is still true. Never awaited and never allowed to throw
   * outward: a snapshot that fails must not stop work from starting.
   */
  readonly onRunStart?: (input: {
    readonly caseId: string;
    readonly operationId: string;
    readonly workspacePath: string;
  }) => void;
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
}

const TERMINAL_STATUSES = new Set<WorkstationStatus>(["completed", "stopped", "failed", "interrupted"]);

interface RunState {
  readonly operationId: string;
  readonly caseId: string;
  readonly providerId: WorkstationProviderId;
  readonly providerLabel: string;
  readonly modelId: string | null;
  readonly workspace: WorkstationWorkspace;
  readonly owner: object;
  readonly startedAt: number;
  sessionId: string | null;
  reportedModelId: string | null;
  status: WorkstationStatus;
  updatedAt: number;
  text: string;
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
  private readonly pending = new Map<string, PendingReview>();
  private readonly workspaces = new Map<string, { readonly workspace: WorkstationWorkspace; readonly owner: object }>();
  private readonly finished = new Map<string, WorkstationSnapshot>();
  private readonly attempts = new Map<WorkstationProviderId, AttemptOutcome>();
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
  private readonly running = new Map<string, Promise<void>>();
  private recovered = false;

  constructor(deps: WorkstationHostDeps) {
    this.deps = deps;
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
      readonly modelId?: string | undefined;
      readonly prompt: string;
      readonly sourceTurnIds: readonly string[];
      readonly workspaceId?: string | undefined;
      readonly enableTools?: boolean | undefined;
    },
    owner: object
  ): Promise<WorkstationReview> {
    this.expireReviews();
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("Write what you want done before reviewing it.");

    const db = this.deps.book();
    const room = this.deps.readCase(db, input.caseId);
    if (room === null || room.closedAt !== null)
      throw new Error("Open this case before starting a workstation session.");

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
    const workspace = await this.resolveWorkspace(input.caseId, input.workspaceId, owner);
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
      maxChars: MAX_PACKET_CHARS
    });
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
    const resumeSessionId = enableTools
      ? null
      : this.resumableSession(db, input.caseId, input.providerId, workspace);
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
      enableTools
    });
    return review;
  }

  /**
   * Spends the token and starts. Returns as soon as the record is durable.
   *
   * The token is removed from the map on the first line, before anything else is
   * checked, so a replay races against nothing — the second caller finds an
   * empty slot whatever happens next. The window that asked must be the window
   * that reviewed, the case and its sources must be exactly as they were shown,
   * and only then is a process created. What comes back is a snapshot; the
   * answer arrives through `state`.
   */
  async start(input: { readonly token: string }, owner: object): Promise<WorkstationSnapshot> {
    const reviewed = this.pending.get(input.token);
    this.pending.delete(input.token);
    if (reviewed === undefined)
      throw new Error("That review has already been used or is no longer valid. Review the request again.");
    if (reviewed.owner !== owner)
      throw new Error("This window changed since that review. Review the request again.");
    if (this.deps.now() > reviewed.review.expiresAt)
      throw new Error("That review expired. Review the request again.");

    const db = this.deps.book();
    const room = this.deps.readCase(db, reviewed.review.caseId);
    if (room === null || room.closedAt !== null)
      throw new Error("This case is no longer open. Nothing was sent.");
    const sources = this.selectSources(db, reviewed.review.caseId, reviewed.sourceIds);
    if (fingerprintOf(room, sources) !== reviewed.fingerprint)
      throw new Error("This case changed after that review. Review the request again before sending it.");
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

    const startedAt = this.deps.now();
    const run: RunState = {
      operationId: this.deps.newId(),
      caseId: review.caseId,
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
      lastCheckpointAt: startedAt
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

    // Durable before dispatch, and all three in one transaction: a prompt
    // recorded without its start receipt would read as something the owner said
    // to nobody, a start receipt without the prompt is a session about nothing,
    // and a durable session record committed separately from either can outlive
    // a failure that rolled the other two back.
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

    this.active.set(run.operationId, run);
    if (this.deps.onRunStart !== undefined) {
      try {
        this.deps.onRunStart({
          caseId: run.caseId,
          operationId: run.operationId,
          workspacePath: review.workspace.path
        });
      } catch {
        // Recording what a folder looked like is not a reason to refuse to work in it.
      }
    }
    // Built by assignment rather than by spreading conditionals: an absent
    // model, profile or resume id must be *absent*, not present and undefined,
    // or an adapter cannot tell "use the default" from "use nothing".
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
    this.running.set(run.operationId, this.execute(run, reviewed.packet, options));
    return this.snapshot(run);
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

  /**
   * One provider, one question, no workspace, no tools, no session.
   *
   * Deliberately not a run: `admit` refuses a second session in a case because
   * two of them writing files and interleaving answers corrupts both, and that
   * is right for sessions. This writes nothing and holds nothing — it asks, and
   * the caller decides what to do with the text — so several may go at once in
   * one case, which is the whole point of asking three subscriptions the same
   * question. It is also why there is no tool scope here and no way to pass one:
   * the capability is absent rather than forbidden.
   *
   * The caller is responsible for having had the question reviewed. This is a
   * seam, not a door around the review.
   */
  async askOnce(input: {
    readonly providerId: WorkstationProviderId;
    readonly prompt: string;
    readonly cwd: string;
    readonly modelId?: string;
    readonly signal: AbortSignal;
    readonly onActivity?: (text: string) => void;
  }): Promise<{ readonly text: string; readonly sessionId: string | null }> {
    const launch = await this.launchFor(input.providerId);
    if (launch.executable === null) throw new Error("That provider is not installed on this Mac.");
    if (input.signal.aborted) throw new Error("Stopped before the provider was asked.");

    const options: MutableWorkerOptions = {
      executable: launch.executable,
      cwd: input.cwd,
      onEvent: (event) => {
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
      if (input.signal.aborted) throw new Error("Stopped.");
      return { text: result.text, sessionId: result.sessionId };
    } finally {
      input.signal.removeEventListener("abort", stop);
      await worker.dispose().catch(() => undefined);
    }
  }

  /** Closing or erasing a case while it is working would strand the session. */
  assertIdle(caseId: string): void {
    if (this.liveRuns().some((run) => run.caseId === caseId))
      throw new Error("Stop the workstation session before closing or erasing this case.");
  }

  /**
   * A navigation or a destroyed window ends that window's authority.
   *
   * Reviews it holds are dropped — a token that outlived the document it was
   * shown in is a token nobody read — and a session it started is asked to stop,
   * because there is no longer anywhere to show what it is doing.
   */
  invalidate(owner: object): void {
    for (const [token, review] of this.pending)
      if (review.owner === owner) this.pending.delete(token);
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
      const current = this.selectSources(db, run.caseId, reviewed.sourceIds);
      return fingerprintOf(room, current) === reviewed.fingerprint;
    } catch {
      return false;
    }
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
      this.liveRuns().map((run) => ({
        operationId: run.operationId,
        caseId: run.caseId,
        providerId: run.providerId,
        workspacePath: run.workspace.path,
        owner: run.owner,
        startedAt: run.startedAt
      })),
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
    workspace: WorkstationWorkspace
  ): string | null {
    const receipt = this.deps.latestReceipt(db, caseId, providerId);
    if (receipt === null) return null;
    if (receipt.workspacePath !== workspace.path) return null;
    if (receipt.snapshot.providerId !== providerId) return null;
    const sessionId = receipt.snapshot.sessionId;
    return sessionId === null || sessionId === "" ? null : sessionId;
  }

  private expireReviews(): void {
    const now = this.deps.now();
    for (const [token, review] of this.pending)
      if (now > review.review.expiresAt) this.pending.delete(token);
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

  private fail(run: RunState, error: unknown): void {
    const reason = error instanceof Error ? error.message : "The session failed.";
    const status: WorkstationStatus = run.stopping ? "interrupted" : "failed";
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
    this.finished.set(run.caseId, this.snapshot(run));
    while (this.finished.size > MAX_REMEMBERED_CASES) {
      const oldest = this.finished.keys().next();
      if (oldest.done) break;
      this.finished.delete(oldest.value);
    }
    this.active.delete(run.operationId);
    this.running.delete(run.operationId);
  }

  private receipt(run: RunState, event: WorkstationSessionReceipt["event"]): WorkstationSessionReceipt {
    const receipt: WorkstationSessionReceipt = {
      version: 1,
      event,
      snapshot: this.snapshot(run),
      workspacePath: run.workspace.path
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

function chosenModel(provider: WorkstationProvider, requested: string | undefined): string | null {
  if (requested === undefined || requested.trim() === "") return null;
  const wanted = requested.trim();
  // Only a model the provider itself advertised. A name this host has never
  // heard of is a string on its way to a command line.
  if (!provider.models.some((model) => model.id === wanted))
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
