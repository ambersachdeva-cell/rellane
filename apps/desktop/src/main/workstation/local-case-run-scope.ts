/** A Case's bundled model call shares Host admission and durable evidence without becoming a native provider. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LocalChatRequestSchema, type AgentRunResult, type LocalChatRequest,
  type WorkstationContextSuggestion, type WorkstationContextSuggestionInput } from "@cadrane/contracts";
import { z } from "zod";
import { appendTurn, readCase, turnsFor } from "../book/cases.js";
import type { LocalCaseRunHooks } from "../workroom/local.js";
import type { LocalContextSuggestionHooks } from "./local-context.js";
import type { AgentWorkroom } from "../workroom/agent-runs.js";
import { projectForWork } from "./projects.js";
import { projectMemoryEpoch } from "./project-memory-book.js";
import { markContextDispatchAttempt, restoreContextSnapshot, saveContextSnapshot } from "./context-snapshot-store.js";
import type { RunningSession } from "./session-pool.js";
import { GraphHostCorrelationKeySchema, type GraphHostCorrelationKey } from "./graph-host-correlation-store.js";

const SEAT = "workstation-local-run";
const AGENT_SEAT = "workstation-local-agent-run";
const SUGGESTION_SEAT = "workstation-local-context-suggestion";
const PROVIDER = "bundled-local";
type LocalWorkflow = "case-draft" | "print-enquiry" | "graph-node";
const GraphBinding = GraphHostCorrelationKeySchema.extend({
  descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/u)
});
const Receipt = z.strictObject({
  version: z.literal(1), kind: z.enum(["case-draft", "print-enquiry", "graph-node"]),
  event: z.enum(["start", "completed", "failed", "interrupted"]),
  caseId: z.string().min(1).max(64), operationId: z.uuid(),
  modelId: z.string().min(1).max(512), contextSnapshotId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceTurnIds: z.array(z.uuid()).max(128),
  graph: GraphBinding.optional(),
  answerTurnId: z.uuid().nullable(), at: z.number().int().nonnegative().safe()
}).superRefine((receipt, context) => {
  if ((receipt.kind === "graph-node") !== (receipt.graph !== undefined) ||
      (receipt.graph && receipt.graph.caseId !== receipt.caseId) ||
      (receipt.kind !== "graph-node" && receipt.sourceTurnIds.length > 20))
    context.addIssue({ code: "custom", message: "Local receipt graph scope does not match its workflow." });
});
type LocalReceipt = z.infer<typeof Receipt>;
const AgentReceipt = z.strictObject({
  version: z.literal(1), kind: z.literal("legacy-agent"),
  event: z.enum(["start", "step-start", "step-completed", "step-interrupted", "answered", "failed", "interrupted"]),
  caseId: z.uuid(), attemptId: z.uuid(), agentId: z.string().min(1).max(200),
  childOperationId: z.uuid().nullable(), stepIndex: z.number().int().nonnegative().nullable(),
  modelId: z.string().min(1).max(512).nullable(), contextSnapshotId: z.uuid().nullable(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  requiredSourceTurnId: z.uuid().nullable(), answerTurnId: z.uuid().nullable(),
  at: z.number().int().nonnegative().safe()
});
type AgentReceiptRow = z.infer<typeof AgentReceipt>;
const SuggestionReceipt = z.strictObject({
  version: z.literal(1), kind: z.literal("context-suggestion"),
  event: z.enum(["start", "completed", "failed", "interrupted"]),
  caseId: z.string().min(1).max(64), operationId: z.uuid(), childOperationId: z.uuid(),
  modelId: z.string().min(1).max(512), contextSnapshotId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceTurnIds: z.array(z.uuid()).min(1).max(20), selectedSourceTurnIds: z.array(z.uuid()).nullable(),
  at: z.number().int().nonnegative().safe()
});
type SuggestionReceiptRow = z.infer<typeof SuggestionReceipt>;

interface ActiveSuggestion {
  readonly caseId: string; readonly operationId: string; readonly workspacePath: string;
  readonly projectId: string | null; readonly owner: object; readonly startedAt: number;
  readonly controller: AbortController;
  stopping: boolean;
}

export interface LocalSuggestionRunInput {
  readonly db: DatabaseSync;
  readonly request: WorkstationContextSuggestionInput;
  readonly owner: object;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly work: (hooks: LocalContextSuggestionHooks, signal: AbortSignal) => Promise<WorkstationContextSuggestion>;
}

interface ActiveAgent {
  readonly attemptId: string;
  readonly agentId: string;
  readonly owner: object;
  readonly workspacePath: string;
  readonly startedAt: number;
  readonly stop: () => boolean;
  caseId: string | null;
  projectId: string | null;
  requiredSourceTurnId: string | null;
  stopping: boolean;
  stepIndex: number;
  readonly children: Map<string, { index: number; modelId: string; snapshotId: string; hash: string;
    outcome: "completed" | "interrupted" | null }>;
}

export interface LocalAgentRunHooks {
  readonly attemptId: string;
  isStopped(): boolean;
  onStart(room: AgentWorkroom): void;
  beforeChat(request: LocalChatRequest): void;
  afterChat(request: LocalChatRequest, outcome: "completed" | "interrupted"): void;
  onFinish(room: AgentWorkroom, result: AgentRunResult, answerTurnId: string | null): void;
}

export interface LocalAgentRunInput {
  readonly db: DatabaseSync;
  readonly agentId: string;
  readonly owner: object;
  readonly workspacePath: string;
  readonly stop: () => boolean;
  readonly work: (hooks: LocalAgentRunHooks) => Promise<AgentRunResult>;
}

interface ActiveLocalCase {
  readonly kind: LocalWorkflow;
  readonly caseId: string;
  readonly operationId: string;
  readonly modelId: string;
  readonly sourceTurnIds: readonly string[];
  readonly workspacePath: string;
  readonly projectId: string | null;
  readonly owner: object;
  readonly startedAt: number;
  readonly stop: () => Promise<{ readonly stopped: boolean }>;
  stopping: boolean;
  contextSnapshotId: string | null;
  requestHash: string | null;
}

export interface LocalCaseRunInput {
  readonly kind: LocalWorkflow;
  readonly db: DatabaseSync;
  readonly caseId: string;
  readonly operationId: string;
  readonly modelId: string;
  readonly sourceTurnIds: readonly string[];
  readonly workspacePath: string;
  readonly owner: object;
  readonly stop: () => Promise<{ readonly stopped: boolean }>;
  readonly work: (hooks: LocalCaseRunHooks) => Promise<void>;
  /** Only the trusted Host supplies these callbacks after exact owner review. */
  readonly graph?: {
    readonly binding: GraphHostCorrelationKey & { readonly descriptorSha256: string };
    readonly requestSha256: string;
    readonly validate: () => void;
    readonly onFinish: (answerTurnId: string) => void;
    readonly onFailure: (interrupted: boolean) => void;
  };
}

function receipts(db: DatabaseSync, caseId: string): readonly LocalReceipt[] {
  return turnsFor(db, caseId).flatMap((turn) => {
    if (turn.seat !== SEAT || turn.kind !== "receipt") return [];
    let raw: unknown;
    try { raw = JSON.parse(turn.body); }
    catch { throw new Error("A local request receipt is malformed. Recovery is paused."); }
    const parsed = Receipt.safeParse(raw);
    if (!parsed.success || parsed.data.caseId !== caseId)
      throw new Error("A local request receipt has the wrong scope. Recovery is paused.");
    return [parsed.data];
  });
}

function put(db: DatabaseSync, receipt: LocalReceipt): void {
  appendTurn(db, receipt.caseId, { seat: SEAT, kind: "receipt", body: JSON.stringify(Receipt.parse(receipt)) });
}

function putAgent(db: DatabaseSync, receipt: AgentReceiptRow): void {
  appendTurn(db, receipt.caseId, { seat: AGENT_SEAT, kind: "receipt",
    body: JSON.stringify(AgentReceipt.parse(receipt)) });
}

function agentReceipts(db: DatabaseSync, caseId: string): readonly AgentReceiptRow[] {
  return turnsFor(db, caseId).flatMap((turn) => {
    if (turn.seat !== AGENT_SEAT || turn.kind !== "receipt") return [];
    let raw: unknown;
    try { raw = JSON.parse(turn.body); }
    catch { throw new Error("An Agent run receipt is malformed. Recovery is paused."); }
    const parsed = AgentReceipt.safeParse(raw);
    if (!parsed.success || parsed.data.caseId !== caseId)
      throw new Error("An Agent run receipt has the wrong scope. Recovery is paused.");
    return [parsed.data];
  });
}

function suggestionReceipts(db: DatabaseSync, caseId: string): readonly SuggestionReceiptRow[] {
  return turnsFor(db, caseId).flatMap((turn) => {
    if (turn.seat !== SUGGESTION_SEAT || turn.kind !== "receipt") return [];
    let raw: unknown;
    try { raw = JSON.parse(turn.body); }
    catch { throw new Error("A local suggestion receipt is malformed. Recovery is paused."); }
    const parsed = SuggestionReceipt.safeParse(raw);
    if (!parsed.success || parsed.data.caseId !== caseId)
      throw new Error("A local suggestion receipt has the wrong scope. Recovery is paused.");
    return [parsed.data];
  });
}

function putSuggestion(db: DatabaseSync, receipt: SuggestionReceiptRow): void {
  appendTurn(db, receipt.caseId, { seat: SUGGESTION_SEAT, kind: "receipt",
    body: JSON.stringify(SuggestionReceipt.parse(receipt)) });
}

export class LocalCaseRunScope {
  private readonly active = new Map<string, ActiveLocalCase>();
  private readonly agents = new Map<string, ActiveAgent>();
  private readonly suggestions = new Map<string, ActiveSuggestion>();
  private readonly running = new Set<Promise<unknown>>();
  private recovered = false;

  sessions(): readonly RunningSession[] {
    return [...this.active.values()].map((run) => ({
      operationId: run.operationId, caseId: run.caseId, providerId: PROVIDER,
      workspacePath: run.workspacePath, owner: run.owner, startedAt: run.startedAt
    })).concat([...this.agents.values()].map((run) => ({
      operationId: run.attemptId, caseId: run.caseId ?? `agent:${run.agentId}`,
      providerId: PROVIDER, workspacePath: run.workspacePath,
      owner: run.owner, startedAt: run.startedAt
    })), [...this.suggestions.values()].map((run) => ({
      operationId: run.operationId, caseId: run.caseId, providerId: PROVIDER,
      workspacePath: run.workspacePath, owner: run.owner, startedAt: run.startedAt
    })));
  }

  assertIdle(caseId: string): void {
    if ([...this.active.values()].some((run) => run.caseId === caseId) ||
        [...this.agents.values()].some((run) => run.caseId === caseId) ||
        [...this.suggestions.values()].some((run) => run.caseId === caseId))
      throw new Error("Stop the local request before closing or erasing this case.");
  }

  assertProjectIdle(projectId: string): void {
    if ([...this.active.values()].some((run) => run.projectId === projectId) ||
        [...this.agents.values()].some((run) => run.projectId === projectId) ||
        [...this.suggestions.values()].some((run) => run.projectId === projectId))
      throw new Error("Stop this project's local request, then retry changing memory.");
  }

  current(caseId: string, owner: object): { operationId: string; stopping: boolean } | null {
    const run = [...this.active.values()].find((item) => item.caseId === caseId);
    if (!run) return null;
    if (run.owner !== owner) throw new Error("This local request belongs to another window.");
    return { operationId: run.operationId, stopping: run.stopping };
  }

  async stop(caseId: string, operationId: string, owner: object): Promise<{ stopped: boolean }> {
    const run = this.active.get(operationId);
    if (!run || run.caseId !== caseId) return { stopped: false };
    if (run.owner !== owner) throw new Error("This local request belongs to another window.");
    run.stopping = true;
    // A request to cancel is not a terminal acknowledgement. The workroom
    // discards any late answer; its structured outcome remains interrupted.
    return run.stop();
  }

  stopAgent(agentId: string, owner: object): { stopped: boolean } {
    const run = [...this.agents.values()].find((item) => item.agentId === agentId);
    if (!run) return { stopped: false };
    if (run.owner !== owner) throw new Error("This Agent run belongs to another window.");
    run.stopping = true;
    run.stop();
    return { stopped: true };
  }

  stopSuggestion(operationId: string, owner: object): { stopped: boolean } {
    const run = this.suggestions.get(operationId);
    if (!run) return { stopped: false };
    if (run.owner !== owner) throw new Error("This local suggestion belongs to another window.");
    if (run.stopping) return { stopped: false };
    run.stopping = true;
    run.controller.abort(new Error("Stopped. No suggestion was applied."));
    return { stopped: true };
  }

  async stopSession(operationId: string, owner: object): Promise<boolean> {
    const local = this.active.get(operationId);
    if (local) return (await this.stop(local.caseId, operationId, owner)).stopped;
    if (this.suggestions.has(operationId)) return this.stopSuggestion(operationId, owner).stopped;
    const agent = this.agents.get(operationId);
    if (!agent) return false;
    return this.stopAgent(agent.agentId, owner).stopped;
  }

  invalidate(owner: object): void {
    for (const run of this.active.values())
      if (run.owner === owner) void this.stop(run.caseId, run.operationId, owner).catch(() => undefined);
    for (const run of this.agents.values())
      if (run.owner === owner) this.stopAgent(run.agentId, owner);
    for (const run of this.suggestions.values())
      if (run.owner === owner) this.stopSuggestion(run.operationId, owner);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((run) =>
      this.stop(run.caseId, run.operationId, run.owner)));
    for (const run of this.agents.values()) this.stopAgent(run.agentId, run.owner);
    for (const run of this.suggestions.values()) this.stopSuggestion(run.operationId, run.owner);
    await Promise.race([
      Promise.allSettled([...this.running]).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4_000);
        if (typeof timer.unref === "function") timer.unref();
      })
    ]);
  }

  /** Once per launch: a start without a terminal is evidence of interruption, never an instruction to retry. */
  recover(db: DatabaseSync): number {
    if (this.recovered) return 0;
    let count = 0;
    const cases = db.prepare("SELECT DISTINCT case_id AS caseId FROM case_turn WHERE seat = ? AND kind = 'receipt'")
      .all(SEAT) as unknown as readonly { caseId: string }[];
    for (const { caseId } of cases) {
      const room = readCase(db, caseId);
      if (!room) throw new Error("A local request receipt has no case. Recovery is paused.");
      const byOperation = new Map<string, LocalReceipt[]>();
      for (const receipt of receipts(db, caseId)) {
        const group = byOperation.get(receipt.operationId) ?? [];
        group.push(receipt);
        byOperation.set(receipt.operationId, group);
      }
      for (const group of byOperation.values()) {
        const starts = group.filter((entry) => entry.event === "start");
        const terminals = group.filter((entry) => entry.event !== "start");
        const start = starts[0];
        if (starts.length !== 1 || !start || terminals.length > 1 || start.answerTurnId !== null ||
            terminals.some((entry) => entry.contextSnapshotId !== start.contextSnapshotId ||
              entry.requestHash !== start.requestHash || entry.modelId !== start.modelId ||
              entry.kind !== start.kind ||
              JSON.stringify(entry.graph) !== JSON.stringify(start.graph) ||
              JSON.stringify(entry.sourceTurnIds) !== JSON.stringify(start.sourceTurnIds) ||
              (entry.event === "completed") !== (entry.answerTurnId !== null)))
          throw new Error("A local request has inconsistent receipts. Recovery is paused.");
        if (terminals.length === 1) continue;
        if (room.closedAt !== null)
          throw new Error("A closed case has an unfinished local request. Recovery is paused.");
        db.exec("BEGIN IMMEDIATE");
        try {
          put(db, { ...start, event: "interrupted", answerTurnId: null, at: Date.now() });
          db.exec("COMMIT");
          count += 1;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    }
    count += this.recoverAgents(db);
    count += this.recoverSuggestions(db);
    this.recovered = true;
    return count;
  }

  private recoverSuggestions(db: DatabaseSync): number {
    const cases = db.prepare("SELECT DISTINCT case_id AS caseId FROM case_turn WHERE seat = ? AND kind = 'receipt'")
      .all(SUGGESTION_SEAT) as unknown as readonly { caseId: string }[];
    let count = 0;
    for (const { caseId } of cases) {
      const room = readCase(db, caseId);
      if (!room) throw new Error("A local suggestion receipt has no case. Recovery is paused.");
      const groups = new Map<string, SuggestionReceiptRow[]>();
      for (const receipt of suggestionReceipts(db, caseId)) {
        const group = groups.get(receipt.operationId) ?? [];
        group.push(receipt);
        groups.set(receipt.operationId, group);
      }
      for (const group of groups.values()) {
        const start = group[0];
        const terminal = group[1];
        if (!start || start.event !== "start" || start.selectedSourceTurnIds !== null || group.length > 2 ||
            (terminal && (terminal.event === "start" || terminal.caseId !== start.caseId ||
              terminal.childOperationId !== start.childOperationId || terminal.modelId !== start.modelId ||
              terminal.contextSnapshotId !== start.contextSnapshotId || terminal.requestHash !== start.requestHash ||
              terminal.sourceHash !== start.sourceHash ||
              JSON.stringify(terminal.sourceTurnIds) !== JSON.stringify(start.sourceTurnIds) ||
              (terminal.event === "completed") !== (terminal.selectedSourceTurnIds !== null) ||
              terminal.selectedSourceTurnIds?.some((id) => !start.sourceTurnIds.includes(id)))))
          throw new Error("A local suggestion has inconsistent receipts. Recovery is paused.");
        if (terminal) continue;
        if (room.closedAt !== null)
          throw new Error("A closed case has an unfinished local suggestion. Recovery is paused.");
        db.exec("BEGIN IMMEDIATE");
        try {
          putSuggestion(db, { ...start, event: "interrupted", at: Date.now() });
          db.exec("COMMIT"); count += 1;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    }
    return count;
  }

  /** Preparatory advice has an exact packet and receipt, but no conversation turn. */
  runSuggestion(input: LocalSuggestionRunInput): Promise<WorkstationContextSuggestion> {
    const { caseId, handle: operationId } = input.request;
    const sourceTurnIds = [...input.request.sourceTurnIds];
    if (this.suggestions.has(operationId) ||
        [...this.suggestions.values()].some((item) => item.caseId === caseId))
      throw new Error("A local suggestion is already active for this case or handle.");
    const room = readCase(input.db, caseId);
    if (!room || room.closedAt !== null) throw new Error("Open work is required for a local suggestion.");
    const controller = new AbortController();
    const run: ActiveSuggestion = { caseId, operationId, owner: input.owner,
      workspacePath: input.workspacePath, projectId: projectForWork(input.db, caseId)?.id ?? null,
      startedAt: Date.now(), controller, stopping: false };
    const onAbort = () => { this.stopSuggestion(operationId, input.owner); };
    this.suggestions.set(operationId, run);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    let start: SuggestionReceiptRow | null = null;
    let settled = false;
    const hooks: LocalContextSuggestionHooks = {
      beforeChat: (request, sourceHash) => {
        if (run.stopping || controller.signal.aborted) throw new Error("Stopped before asking the local model.");
        if ((projectForWork(input.db, caseId)?.id ?? null) !== run.projectId)
          throw new Error("The suggestion's project changed before dispatch.");
        const exact = LocalChatRequestSchema.parse(request);
        if (exact.runtimeId !== "cadrane-local-loopback" || exact.responseProfile !== "local-draft-v1" ||
            exact.messages.length !== 2 || exact.messages[1]?.role !== "user" || start)
          throw new Error("The suggestion did not match its local scope.");
        const packet = JSON.stringify(exact);
        const snapshot = saveContextSnapshot(input.db, { id: randomUUID(), caseId,
          projectId: run.projectId, memoryEpoch: run.projectId ? projectMemoryEpoch(input.db, run.projectId) : 0,
          providerId: PROVIDER, modelId: exact.modelId, packet,
          manifest: { preview: "Exact bundled-local context suggestion", sourceIds: [...sourceTurnIds],
            omitted: [], constraints: [] } });
        const row: SuggestionReceiptRow = { version: 1, kind: "context-suggestion", event: "start",
          caseId, operationId, childOperationId: exact.operationId, modelId: exact.modelId,
          contextSnapshotId: snapshot.id, requestHash: createHash("sha256").update(packet).digest("hex"),
          sourceHash, sourceTurnIds: [...sourceTurnIds], selectedSourceTurnIds: null, at: Date.now() };
        putSuggestion(input.db, row);
        start = row;
        markContextDispatchAttempt(input.db, snapshot.id, caseId,
          projectForWork(input.db, caseId)?.id ?? null, Date.now(), PROVIDER, exact.modelId);
      },
      onFinish: (result) => {
        if (!start || settled || run.stopping || controller.signal.aborted ||
            readCase(input.db, caseId)?.closedAt !== null ||
            (projectForWork(input.db, caseId)?.id ?? null) !== run.projectId ||
            result.modelId !== start.modelId || result.sourceHash !== start.sourceHash ||
            JSON.stringify(result.consideredIds) !== JSON.stringify(sourceTurnIds) ||
            result.sourceTurnIds.some((id) => !sourceTurnIds.includes(id)))
          throw new Error("The suggestion changed before its result could be accepted.");
        restoreContextSnapshot(input.db, { id: start.contextSnapshotId, caseId,
          projectId: run.projectId, providerId: PROVIDER, modelId: start.modelId });
        putSuggestion(input.db, { ...start, event: "completed",
          selectedSourceTurnIds: [...result.sourceTurnIds], at: Date.now() });
        settled = true;
      }
    };
    const task = Promise.resolve().then(() => input.work(hooks, controller.signal)).then((result) => {
      if (!settled) throw new Error("The local suggestion did not record its outcome.");
      return result;
    }).catch((error: unknown) => {
      if (start && !settled) {
        // The start is durable before daemon handoff; a thrown adapter does not
        // prove whether the daemon received the call, even if Stop was requested.
        putSuggestion(input.db, { ...start, event: "interrupted",
          at: Date.now() });
        settled = true;
      }
      throw error;
    }).finally(() => {
      input.signal.removeEventListener("abort", onAbort);
      this.suggestions.delete(operationId);
      this.running.delete(task);
    });
    this.running.add(task);
    return task;
  }

  private recoverAgents(db: DatabaseSync): number {
    const cases = db.prepare("SELECT DISTINCT case_id AS caseId FROM case_turn WHERE seat = ? AND kind = 'receipt'")
      .all(AGENT_SEAT) as unknown as readonly { caseId: string }[];
    let count = 0;
    for (const { caseId } of cases) {
      const room = readCase(db, caseId);
      if (!room) throw new Error("An Agent run receipt has no case. Recovery is paused.");
      const groups = new Map<string, AgentReceiptRow[]>();
      for (const receipt of agentReceipts(db, caseId)) {
        const group = groups.get(receipt.attemptId) ?? [];
        group.push(receipt);
        groups.set(receipt.attemptId, group);
      }
      for (const group of groups.values()) {
        const starts = group.filter((entry) => entry.event === "start");
        const outer = group.filter((entry) => ["answered", "failed", "interrupted"].includes(entry.event));
        const start = starts[0];
        if (starts.length !== 1 || !start || outer.length > 1 ||
            start.childOperationId !== null || start.stepIndex !== null ||
            start.contextSnapshotId !== null || start.requestHash !== null ||
            start.modelId !== null || start.answerTurnId !== null ||
            outer.some((entry) => entry.childOperationId !== null || entry.stepIndex !== null ||
              entry.contextSnapshotId !== null || entry.requestHash !== null || entry.modelId !== null ||
              (entry.event === "answered") !== (entry.answerTurnId !== null)) ||
            group.some((entry) => entry.agentId !== start.agentId ||
              entry.requiredSourceTurnId !== start.requiredSourceTurnId))
          throw new Error("An Agent run has inconsistent receipts. Recovery is paused.");
        const steps = new Map<string, AgentReceiptRow[]>();
        const indexes = new Map<number, string>();
        for (const entry of group.filter((item) => item.event.startsWith("step-"))) {
          if (!entry.childOperationId || !entry.contextSnapshotId || !entry.requestHash ||
              !entry.modelId || entry.stepIndex === null || entry.stepIndex < 1 ||
              entry.answerTurnId !== null)
            throw new Error("An Agent step receipt is incomplete. Recovery is paused.");
          const prior = indexes.get(entry.stepIndex);
          if (prior && prior !== entry.childOperationId)
            throw new Error("An Agent step index was reused. Recovery is paused.");
          indexes.set(entry.stepIndex, entry.childOperationId);
          const child = steps.get(entry.childOperationId) ?? [];
          child.push(entry);
          steps.set(entry.childOperationId, child);
        }
        const unfinished: AgentReceiptRow[] = [];
        for (const child of steps.values()) {
          const first = child.find((entry) => entry.event === "step-start");
          const ends = child.filter((entry) => entry.event !== "step-start");
          if (!first || child[0] !== first || child.filter((entry) => entry.event === "step-start").length !== 1 ||
              ends.length > 1 || ends.some((entry) => entry.contextSnapshotId !== first.contextSnapshotId ||
                entry.requestHash !== first.requestHash || entry.modelId !== first.modelId ||
                entry.stepIndex !== first.stepIndex))
            throw new Error("An Agent step has inconsistent receipts. Recovery is paused.");
          if (ends.length === 0) unfinished.push(first);
        }
        if (outer[0]?.event === "answered" && (unfinished.length > 0 || steps.size === 0 ||
            [...steps.values()].some((child) => child[1]?.event !== "step-completed")))
          throw new Error("An answered Agent run has an unfinished model step. Recovery is paused.");
        if (outer.length > 0 && unfinished.length === 0) continue;
        if (room.closedAt !== null)
          throw new Error("A closed case has an unfinished Agent run. Recovery is paused.");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const child of unfinished)
            putAgent(db, { ...child, event: "step-interrupted", at: Date.now() });
          if (outer.length === 0) putAgent(db, { ...start, event: "interrupted", at: Date.now() });
          db.exec("COMMIT");
          count += unfinished.length + (outer.length === 0 ? 1 : 0);
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    }
    return count;
  }

  run(input: LocalCaseRunInput): Promise<void> {
    if ((input.kind === "graph-node") !== (input.graph !== undefined))
      throw new Error("Graph requests require their exact reviewed Host scope.");
    const graph = input.graph;
    if (graph && (GraphBinding.parse(graph.binding).caseId !== input.caseId ||
        !/^[a-f0-9]{64}$/u.test(graph.requestSha256)))
      throw new Error("Graph review binding does not match this Case.");
    if (this.active.has(input.operationId) ||
        [...this.active.values()].some((run) => run.caseId === input.caseId))
      throw new Error("A local request is already running for this case or operation.");
    const room = readCase(input.db, input.caseId);
    if (!room || room.closedAt !== null)
      throw new Error("Open work is required for a local request.");
    const projectId = projectForWork(input.db, input.caseId)?.id ?? null;
    const run: ActiveLocalCase = {
      kind: input.kind, caseId: input.caseId, operationId: input.operationId, modelId: input.modelId,
      sourceTurnIds: [...input.sourceTurnIds], workspacePath: input.workspacePath,
      projectId, owner: input.owner, startedAt: Date.now(), stop: input.stop, stopping: false,
      contextSnapshotId: null, requestHash: null
    };
    this.active.set(run.operationId, run);
    const evidence = (): Pick<LocalReceipt, "contextSnapshotId" | "requestHash"> => {
      if (!run.contextSnapshotId || !run.requestHash) throw new Error("The local request snapshot is missing.");
      return { contextSnapshotId: run.contextSnapshotId, requestHash: run.requestHash };
    };
    const makeReceipt = (event: LocalReceipt["event"], answerTurnId: string | null): LocalReceipt => ({
      version: 1, kind: run.kind, event, caseId: run.caseId,
      operationId: run.operationId, modelId: run.modelId,
      sourceTurnIds: [...run.sourceTurnIds], ...evidence(), answerTurnId, at: Date.now(),
      ...(graph ? { graph: GraphBinding.parse(graph.binding) } : {})
    });
    const hooks: LocalCaseRunHooks = {
      isStopped: () => run.stopping,
      beforeStart: (request: LocalChatRequest) => {
        if (run.stopping) throw new Error("Stopped before the local model was asked.");
        const exact = LocalChatRequestSchema.parse(request);
        if (exact.operationId !== run.operationId || exact.modelId !== run.modelId ||
            exact.runtimeId !== "cadrane-local-loopback" ||
            exact.responseProfile !== (run.kind === "graph-node" ? "graph-node-v1" :
              run.kind === "print-enquiry" ? "print-enquiry-v1" : "local-draft-v1") ||
            exact.messages.length !== 2 || exact.messages[1]?.role !== "user")
          throw new Error("The local request did not match its admitted scope.");
        if (graph) {
          graph.validate();
          if (createHash("sha256").update(JSON.stringify(exact), "utf8").digest("hex") !== graph.requestSha256)
            throw new Error("The graph request changed after review.");
        } else {
        let selected: unknown;
        try { selected = JSON.parse(exact.messages[1].content); } catch { /* Fail closed below. */ }
        if (!selected || typeof selected !== "object" || !("sources" in selected) ||
            !Array.isArray(selected.sources) ||
            JSON.stringify(selected.sources.map((source: unknown) =>
              source && typeof source === "object" && "sourceId" in source ? source.sourceId : null)) !==
              JSON.stringify(run.sourceTurnIds))
          throw new Error("The local request sources changed before admission.");
        if (run.kind === "print-enquiry" && run.sourceTurnIds.length !== 1)
          throw new Error("An enquiry must name exactly one original source.");
        }
        const packet = JSON.stringify(exact);
        if ((projectForWork(input.db, run.caseId)?.id ?? null) !== run.projectId)
          throw new Error("The local request's project changed before admission.");
        const memoryEpoch = run.projectId === null ? 0 : projectMemoryEpoch(input.db, run.projectId);
        const snapshot = saveContextSnapshot(input.db, {
          id: randomUUID(), caseId: run.caseId, projectId: run.projectId, memoryEpoch,
          providerId: PROVIDER, modelId: run.modelId, packet,
          manifest: { preview: "Exact bundled-local Case request", sourceIds: [...run.sourceTurnIds],
            omitted: [], constraints: [] }
        });
        run.contextSnapshotId = snapshot.id;
        run.requestHash = createHash("sha256").update(packet, "utf8").digest("hex");
      },
      onStart: () => put(input.db, makeReceipt("start", null)),
      beforeChat: () => {
        if (run.stopping) throw new Error("Stopped before the local model was asked.");
        graph?.validate();
        markContextDispatchAttempt(input.db, evidence().contextSnapshotId,
          run.caseId, projectForWork(input.db, run.caseId)?.id ?? null,
          Date.now(), PROVIDER, run.modelId);
      },
      onFinish: (answerTurnId) => {
        if (run.stopping || (projectForWork(input.db, run.caseId)?.id ?? null) !== run.projectId)
          throw new Error("The local request changed before its answer could be saved.");
        graph?.validate();
        restoreContextSnapshot(input.db, {
          id: evidence().contextSnapshotId, caseId: run.caseId, projectId: run.projectId,
          providerId: PROVIDER, modelId: run.modelId
        });
        put(input.db, makeReceipt("completed", answerTurnId));
        graph?.onFinish(answerTurnId);
      },
      onFailure: (interrupted) => {
        put(input.db, makeReceipt(interrupted || run.stopping ? "interrupted" : "failed", null));
        graph?.onFailure(interrupted || run.stopping);
      }
    };
    const task = Promise.resolve().then(() => input.work(hooks)).finally(() => {
      this.active.delete(run.operationId);
      this.running.delete(task);
    });
    this.running.add(task);
    return task;
  }

  /** One outer Agent attempt; each changing model step receives its own immutable packet. */
  runAgent(input: LocalAgentRunInput): Promise<AgentRunResult> {
    if ([...this.agents.values()].some((run) => run.agentId === input.agentId))
      throw new Error("An Agent run is already active.");
    const run: ActiveAgent = {
      attemptId: randomUUID(), agentId: input.agentId, owner: input.owner,
      workspacePath: input.workspacePath, startedAt: Date.now(), stop: input.stop,
      caseId: null, projectId: null, requiredSourceTurnId: null,
      stopping: false, stepIndex: 0, children: new Map()
    };
    this.agents.set(run.attemptId, run);
    const base = (event: AgentReceiptRow["event"], values: Partial<AgentReceiptRow> = {}): AgentReceiptRow => {
      if (!run.caseId) throw new Error("The Agent's Case was not saved.");
      return { version: 1, kind: "legacy-agent", event, caseId: run.caseId,
        attemptId: run.attemptId, agentId: run.agentId,
        childOperationId: null, stepIndex: null, modelId: null,
        contextSnapshotId: null, requestHash: null,
        requiredSourceTurnId: run.requiredSourceTurnId,
        answerTurnId: null, at: Date.now(), ...values };
    };
    const hooks: LocalAgentRunHooks = {
      attemptId: run.attemptId,
      isStopped: () => run.stopping,
      onStart: (room) => {
        if (run.stopping || room.attemptId !== run.attemptId || room.agentId !== run.agentId)
          throw new Error("This Agent run lost its owner before its Case was saved.");
        run.caseId = room.caseId;
        run.requiredSourceTurnId = room.requiredSourceTurnId;
        run.projectId = projectForWork(input.db, room.caseId)?.id ?? null;
        putAgent(input.db, base("start"));
      },
      beforeChat: (request) => {
        if (run.stopping || !run.caseId || readCase(input.db, run.caseId)?.closedAt !== null)
          throw new Error("This Agent run is no longer active. Nothing was sent.");
        if ((projectForWork(input.db, run.caseId)?.id ?? null) !== run.projectId)
          throw new Error("The Agent's project changed before dispatch.");
        const exact = LocalChatRequestSchema.parse(request);
        if (exact.runtimeId !== "cadrane-local-loopback" || exact.responseProfile !== "local-draft-v1" ||
            exact.messages.length !== 2 || exact.messages[1]?.role !== "user" ||
            run.children.has(exact.operationId))
          throw new Error("The Agent step did not match its local scope. Nothing was sent.");
        const packet = JSON.stringify(exact);
        const memoryEpoch = run.projectId === null ? 0 : projectMemoryEpoch(input.db, run.projectId);
        const snapshot = saveContextSnapshot(input.db, {
          id: randomUUID(), caseId: run.caseId, projectId: run.projectId,
          memoryEpoch, providerId: PROVIDER, modelId: exact.modelId, packet,
          manifest: { preview: `Exact bundled-local Agent step ${run.stepIndex + 1}`,
            sourceIds: run.requiredSourceTurnId ? [run.requiredSourceTurnId] : [],
            omitted: [], constraints: [] }
        });
        const child = { index: run.stepIndex + 1, modelId: exact.modelId,
          snapshotId: snapshot.id,
          hash: createHash("sha256").update(packet, "utf8").digest("hex"), outcome: null as "completed" | "interrupted" | null };
        const fields = { childOperationId: exact.operationId, stepIndex: child.index,
          modelId: child.modelId, contextSnapshotId: child.snapshotId,
          requestHash: child.hash };
        input.db.exec("BEGIN IMMEDIATE");
        try { putAgent(input.db, base("step-start", fields)); input.db.exec("COMMIT"); }
        catch (error) { input.db.exec("ROLLBACK"); throw error; }
        run.children.set(exact.operationId, child);
        run.stepIndex += 1;
        try {
          if (run.stopping) throw new Error("Stopped before the Agent model was asked.");
          markContextDispatchAttempt(input.db, child.snapshotId, run.caseId,
            projectForWork(input.db, run.caseId)?.id ?? null, Date.now(), PROVIDER, child.modelId);
        } catch (error) {
          input.db.exec("BEGIN IMMEDIATE");
          try {
            putAgent(input.db, base("step-interrupted", fields));
            input.db.exec("COMMIT");
            child.outcome = "interrupted";
          } catch (writeError) { input.db.exec("ROLLBACK"); throw writeError; }
          throw error;
        }
      },
      afterChat: (request, outcome) => {
        const child = run.children.get(request.operationId);
        if (!child || child.outcome !== null || !run.caseId || child.modelId !== request.modelId)
          throw new Error("The Agent step outcome did not match its start.");
        input.db.exec("BEGIN IMMEDIATE");
        try {
          putAgent(input.db, base(outcome === "completed" ? "step-completed" : "step-interrupted", {
            childOperationId: request.operationId, stepIndex: child.index,
            modelId: child.modelId, contextSnapshotId: child.snapshotId, requestHash: child.hash
          }));
          input.db.exec("COMMIT");
          child.outcome = outcome;
        } catch (error) { input.db.exec("ROLLBACK"); throw error; }
      },
      onFinish: (room, result, answerTurnId) => {
        if (!run.caseId || room.caseId !== run.caseId || room.attemptId !== run.attemptId ||
            result.agentId !== run.agentId)
          throw new Error("The Agent result did not match its admitted Case.");
        if (result.outcome === "answered") {
          if (run.stopping || (projectForWork(input.db, run.caseId)?.id ?? null) !== run.projectId ||
              run.children.size === 0 || [...run.children.values()].some((child) => child.outcome !== "completed"))
            throw new Error("The Agent's answer was not within its completed local scope.");
          for (const child of run.children.values())
            restoreContextSnapshot(input.db, { id: child.snapshotId, caseId: run.caseId,
              projectId: run.projectId, providerId: PROVIDER, modelId: child.modelId });
        }
        const event = result.outcome === "answered" ? "answered" :
          result.outcome === "stopped" || run.stopping ? "interrupted" : "failed";
        putAgent(input.db, base(event, { answerTurnId }));
      }
    };
    const task = Promise.resolve().then(() => input.work(hooks)).finally(() => {
      this.agents.delete(run.attemptId);
      this.running.delete(task);
    });
    this.running.add(task);
    return task;
  }
}
