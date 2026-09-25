import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION,
  AutomationHostBindOperationInputSchema,
  AutomationHostBindOperationResultSchema,
  AutomationHostReconcileTerminalInputSchema,
  AutomationHostReconcileTerminalResultSchema,
  AutomationHostReserveAttemptInputSchema,
  AutomationHostReserveAttemptResultSchema,
  AutomationHostReviewDescriptorSchema,
  AutomationPendingHostReviewInputSchema,
  AutomationReviewBoundWorkflowInputSchema,
  AutomationRunActionInputSchema,
  AutomationRunSnapshotSchema,
  AutomationRunStartInputSchema,
  AutomationWorkflowSaveInputSchema,
  AutomationWorkflowSchema,
  AutomationWorkflowV2Schema,
  AutomationWorkspaceSnapshotSchema,
  DAEMON_PROTOCOL_VERSION,
  type AutomationWorkspaceSnapshot,
  type LocalChatRequest,
  type LocalChatResult,
  type WorkstationProvider,
  type WorkstationRoutine
} from "@cadrane/contracts";
import {
  AutomationRuntime,
  type AutomationChatBoundary,
  type AutomationRepository
} from "../../../../daemon/src/automation-runtime.js";
import {
  createDispatcherFromDependencies,
  type DaemonModelInstallBoundary,
  type DaemonWorkRequest
} from "../../../../daemon/src/service.js";
import { MIGRATIONS } from "../book/schema.js";
import { appendTurn, closeCase, openCase, readCase, turnsFor } from "../book/cases.js";
import { LocalWorkroom, type LocalWorkroomDeps } from "../workroom/local.js";
import { LocalCaseRunScope } from "./local-case-run-scope.js";
import { LocalBriefDraftScope } from "./local-brief-draft-scope.js";
import {
  markContextDispatchAttempt,
  readContextSnapshot,
  saveContextSnapshot
} from "./context-snapshot-store.js";
import {
  lookup,
  recordDispatch,
  recordTerminal,
  saveIntent,
  type GraphHostCorrelationKey
} from "./graph-host-correlation-store.js";
import {
  GRAPH_HOST_ANSWER_SEAT,
  readProvenGraphHostTerminal
} from "./graph-host-terminal-evidence.js";
import {
  REVIEW_TTL_MS,
  WorkstationHost,
  type WorkstationHostDeps
} from "./service.js";
import type { WorkstationSessionReceipt } from "./types.js";

const AGENT_M1_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_M2_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_ID = "33333333-3333-4333-8333-333333333333";
const NODE_M1_ID = "44444444-4444-4444-8444-444444444444";
const NODE_M2_ID = "55555555-5555-4555-8555-555555555555";
const MODEL_ID = "Qwen/Qwen2.5-3B-Instruct-GGUF/qwen2.5-3b-instruct-q4_k_m.gguf";

const CODEX_PROVIDER: WorkstationProvider = {
  id: "codex",
  label: "Codex",
  family: "codex",
  state: "detected",
  detail: "Installed.",
  models: [{ id: "gpt-5-codex", label: "Codex" }],
  canResume: true,
  canApproveTools: true
};

const ROUTINES: readonly WorkstationRoutine[] = [];

class MemoryAutomationRepository implements AutomationRepository {
  snapshot: AutomationWorkspaceSnapshot = {
    schemaVersion: 1,
    agents: [],
    workflows: [],
    runs: [],
    memory: [],
    sources: [],
    artifacts: [],
    capabilityRequests: [],
    leases: [],
    connectors: [],
    outbox: [],
    deliveries: []
  };

  async load(): Promise<AutomationWorkspaceSnapshot> {
    return structuredClone(this.snapshot);
  }

  async save(snapshot: AutomationWorkspaceSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}

class UnusedInstallBoundary implements DaemonModelInstallBoundary {
  async snapshot(): Promise<unknown> {
    return [];
  }
  async review(): Promise<unknown> {
    throw new Error("Unused in graph execution tests.");
  }
  async acknowledge(): Promise<unknown> {
    throw new Error("Unused in graph execution tests.");
  }
  async start(): Promise<unknown> {
    throw new Error("Unused in graph execution tests.");
  }
  async cancel(): Promise<unknown> {
    throw new Error("Unused in graph execution tests.");
  }
}

function createGraphHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
  }

  const state = {
    clock: Date.parse("2026-08-12T00:00:00.000Z"),
    projectId: null as string | null,
    memoryEpoch: 0,
    chatCalls: [] as LocalChatRequest[],
    cancelledOperations: [] as string[],
    nextChatHandler: null as ((request: LocalChatRequest) => Promise<LocalChatResult>) | null,
    beforeReconcileHook: null as (() => Promise<void> | void) | null,
    beforeReserveHook: null as (() => Promise<void> | void) | null,
    beforeBindHook: null as (() => Promise<void> | void) | null
  };

  const repository = new MemoryAutomationRepository();
  const v1ChatBoundary: AutomationChatBoundary = {
    chat: async (request) => ({
      operationId: request.operationId,
      runtimeId: request.runtimeId,
      modelId: request.modelId,
      content: `v1 output for ${request.messages[1]?.content ?? ""}`,
      startedAt: new Date(state.clock).toISOString(),
      finishedAt: new Date(state.clock + 10).toISOString(),
      localOnly: true as const
    }),
    cancel: () => false
  };

  let automationRuntime = new AutomationRuntime({
    dataDirectory: "/tmp/cadrane-graph-test",
    repository,
    runtime: v1ChatBoundary,
    now: () => new Date(state.clock),
    enableScheduleTimer: false
  });

  const makeDispatcher = () =>
    createDispatcherFromDependencies({
      dataDirectory: "/tmp/cadrane-graph-test",
      runtimeManager: {
        discover: async () => [
          {
            id: "cadrane-local-loopback",
            name: "Managed local runtime",
            kind: "managed-llama",
            baseUrl: null,
            state: "available",
            version: "1.0.0",
            models: [
              {
                id: MODEL_ID,
                displayName: MODEL_ID,
                sizeBytes: 1024,
                loaded: true
              }
            ],
            detail: "Ready",
            checkedAt: "2026-08-12T00:00:00.000Z"
          }
        ],
        chat: async () => {
          throw new Error("Direct daemon runtimeManager.chat not used; localWorkroomDeps used.");
        },
        cancel: () => false,
        shutdown: async () => {}
      },
      automationRuntime,
      installBoundary: new UnusedInstallBoundary(),
      installUnavailableError: null,
      profile: async () => {
        throw new Error("Unused");
      },
      inspect: async () => ({ inspection: null })
    });

  let dispatcher = makeDispatcher();

  const sendDaemon = async <T>(
    request: Omit<DaemonWorkRequest, "protocolVersion" | "requestId">
  ): Promise<T> => {
    const fullRequest = {
      ...request,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: randomUUID()
    } as DaemonWorkRequest;
    return (await dispatcher.dispatch(
      fullRequest,
      new AbortController().signal
    )) as T;
  };

  const restartDaemon = async () => {
    automationRuntime = new AutomationRuntime({
      dataDirectory: "/tmp/cadrane-graph-test",
      repository,
      runtime: v1ChatBoundary,
      now: () => new Date(state.clock),
      enableScheduleTimer: false
    });
    dispatcher = makeDispatcher();
    await sendDaemon({ type: "automation.snapshot", payload: {} });
  };

  const localWorkroom = new LocalWorkroom();
  const localWorkroomDeps: LocalWorkroomDeps = {
    discover: async () => [
      {
        id: "cadrane-local-loopback",
        name: "Managed local runtime",
        kind: "managed-llama",
        baseUrl: null,
        state: "available",
        version: "1.0.0",
        models: [
          {
            id: MODEL_ID,
            displayName: MODEL_ID,
            sizeBytes: 1024,
            loaded: true
          }
        ],
        detail: "Ready",
        checkedAt: "2026-08-12T00:00:00.000Z"
      }
    ],
    chat: async (request) => {
      state.chatCalls.push(request);
      if (state.nextChatHandler !== null) {
        const handler = state.nextChatHandler;
        state.nextChatHandler = null;
        return handler(request);
      }
      return {
        operationId: request.operationId,
        runtimeId: request.runtimeId,
        modelId: request.modelId,
        content: `Model answer for operation ${request.operationId} (${request.messages[0]?.content ?? ""})`,
        startedAt: new Date(state.clock).toISOString(),
        finishedAt: new Date(state.clock + 15).toISOString(),
        localOnly: true as const
      };
    },
    cancel: async (operationId) => {
      state.cancelledOperations.push(operationId);
    }
  };

  let tokenSeq = 0;
  let idSeq = 0;
  const receipts: WorkstationSessionReceipt[] = [];

  const createHost = () => {
    const localCaseScope = new LocalCaseRunScope();
    const localBriefScope = new LocalBriefDraftScope();
    const hostDeps: WorkstationHostDeps = {
      localCaseScope,
      localBriefScope,
      book: () => db,
      readCase: (database, caseId) => readCase(database, caseId),
      turnsFor: (database, caseId) => turnsFor(database, caseId),
      appendTurn: (database, caseId, turn) => appendTurn(database, caseId, turn, state.clock),
      transaction: (database, work) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          work();
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      discoverProviders: async () => [
        { provider: CODEX_PROVIDER, executable: "/usr/local/bin/codex" }
      ],
      buildContext: ({ prompt, sources }) => ({
        packet: JSON.stringify({ prompt, sources }),
        preview: prompt,
        sourceIds: sources.map((s) => s.id),
        sha256: createHash("sha256")
          .update(JSON.stringify({ prompt, sources }), "utf8")
          .digest("hex"),
        omitted: []
      }),
      memory: {
        projectForCase: () => state.projectId,
        epoch: () => state.memoryEpoch,
        constraints: () => [],
        findings: () => [],
        saveSnapshot: (database, input, at) => saveContextSnapshot(database, input, at),
        readSnapshot: (database, id, caseId, projectId) =>
          readContextSnapshot(database, id, caseId, projectId),
        markDispatchAttempt: (database, id, caseId, projectId, at) =>
          markContextDispatchAttempt(database, id, caseId, projectId, at)
      },
      createWorker: () => {
        throw new Error("Native CLI worker must not be created for bundled-local graph nodes.");
      },
      saveReceipt: (_database, _caseId, receipt) => {
        receipts.push(receipt);
      },
      latestReceipt: () => null,
      recoverInterrupted: () => 0,
      routines: () => ROUTINES,
      privateWorkspace: async (caseId) => ({
        id: `case:${caseId}`,
        label: "This case's own folder",
        path: `/tmp/cadrane-workstation/${caseId}`
      }),
      canonicalWorkspacePath: async (workspacePath) => workspacePath,
      onRunStart: async () => true,
      extractArtifacts: () => [],
      now: () => state.clock,
      token: () => {
        tokenSeq += 1;
        return tokenSeq.toString(16).padStart(64, "0");
      },
      newId: () => {
        idSeq += 1;
        return `00000000-0000-4000-8000-${idSeq.toString(16).padStart(12, "0")}`;
      },
      graph: {
        describeReview: async (input) => {
          const payload = AutomationPendingHostReviewInputSchema.parse(input);
          const data = await sendDaemon({
            type: "automation.host-review.describe",
            payload
          });
          return AutomationHostReviewDescriptorSchema.parse(data);
        },
        reserveAttempt: async (input) => {
          if (state.beforeReserveHook) {
            await state.beforeReserveHook();
          }
          const payload = AutomationHostReserveAttemptInputSchema.parse(input);
          const data = await sendDaemon({
            type: "automation.host-attempt.reserve",
            payload
          });
          return AutomationHostReserveAttemptResultSchema.parse(data);
        },
        bindOperation: async (input) => {
          if (state.beforeBindHook) {
            await state.beforeBindHook();
          }
          const payload = AutomationHostBindOperationInputSchema.parse(input);
          const data = await sendDaemon({
            type: "automation.host-attempt.bind",
            payload
          });
          return AutomationHostBindOperationResultSchema.parse(data);
        },
        reconcileTerminal: async (input) => {
          if (state.beforeReconcileHook) {
            await state.beforeReconcileHook();
          }
          const payload = AutomationHostReconcileTerminalInputSchema.parse(input);
          const data = await sendDaemon({
            type: "automation.host-attempt.reconcile",
            payload
          });
          return AutomationHostReconcileTerminalResultSchema.parse(data);
        },
        snapshot: async () => {
          const data = await sendDaemon({
            type: "automation.snapshot",
            payload: {}
          });
          return AutomationWorkspaceSnapshotSchema.parse(data);
        },
        runNode: async (input) => {
          return await localWorkroom.runGraphNode(
            input.db,
            {
              caseId: input.caseId,
              nodeTitle: input.nodeTitle,
              instruction: input.instruction,
              sourceTurnIds: input.sourceTurnIds,
              request: input.request
            },
            localWorkroomDeps,
            input.hooks
          );
        },
        stopNode: async (caseId, operationId) =>
          localWorkroom.stop(caseId, operationId, localWorkroomDeps)
      }
    };
    return {
      host: new WorkstationHost(hostDeps),
      localCaseScope
    };
  };

  const setupCaseAndTwoNodeWorkflow = async (options?: {
    m1SystemPrompt?: string;
    m2SystemPrompt?: string;
    m1Instruction?: string;
    m2Instruction?: string;
  }) => {
    const caseId = openCase(db, {
      title: "Supplier Contract Review",
      question: "What are the delivery risks and payment terms?"
    });
    const sourceTurnId = appendTurn(
      db,
      caseId,
      {
        seat: "Source · Contract.md",
        kind: "verbatim",
        body: "Clause 4: Delivery within 14 days. Penalty of 2% per week. Payment net 30 days."
      },
      state.clock
    );

    const agent1 = await automationRuntime.saveAgent({
      id: AGENT_M1_ID,
      name: "Clause Extractor",
      description: "Extracts clauses from case sources.",
      systemPrompt: options?.m1SystemPrompt ?? "Extract key clauses accurately.",
      runtimeId: "cadrane-local-loopback",
      modelId: MODEL_ID,
      routingMode: "fixed",
      fallbackRoutes: [],
      temperature: 0.2,
      maxTokens: 512
    });

    const agent2 = await automationRuntime.saveAgent({
      id: AGENT_M2_ID,
      name: "Risk Synthesizer",
      description: "Synthesizes contract risks.",
      systemPrompt: options?.m2SystemPrompt ?? "Synthesize risk exposure from extracted clauses.",
      runtimeId: "cadrane-local-loopback",
      modelId: MODEL_ID,
      routingMode: "fixed",
      fallbackRoutes: [],
      temperature: 0.3,
      maxTokens: 512
    });

    const savedWorkflowRaw = await sendDaemon({
      type: "automation.workflow.save-review-bound",
      payload: AutomationReviewBoundWorkflowInputSchema.parse({
        caseId,
        sourceTurnIds: [sourceTurnId],
        workflow: {
          id: WORKFLOW_ID,
          name: "Two-Stage Contract Review",
          description: "Extract clauses in M1 then synthesize risks in M2.",
          enabled: true,
          trigger: { kind: "manual" },
          budget: {
            maxNodeExecutions: 4,
            maxDurationMs: 1_800_000,
            maxOutputCharacters: 48_000
          },
          nodes: [
            {
              id: NODE_M1_ID,
              kind: "model",
              title: "M1: Extract Clauses",
              agentId: AGENT_M1_ID,
              connectorId: null,
              instruction: options?.m1Instruction ?? "List all delivery and payment clauses.",
              dependsOn: []
            },
            {
              id: NODE_M2_ID,
              kind: "model",
              title: "M2: Synthesize Risks",
              agentId: AGENT_M2_ID,
              connectorId: null,
              instruction: options?.m2Instruction ?? "Summarize penalty risks based on M1.",
              dependsOn: [NODE_M1_ID]
            }
          ]
        }
      })
    });
    const workflow = AutomationWorkflowV2Schema.parse(savedWorkflowRaw);

    return { caseId, sourceTurnId, agent1, agent2, workflow };
  };

  return {
    db,
    state,
    repository,
    getRuntime: () => automationRuntime,
    sendDaemon,
    restartDaemon,
    createHost,
    setupCaseAndTwoNodeWorkflow
  };
}

describe("G01 end-to-end review-bound graph Host execution and reconciliation", () => {
  it("executes a 2-node M1 -> M2 review-bound workflow end-to-end through WorkstationHost with separate review tokens and durable Book proof", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    const { caseId, sourceTurnId } = await h.setupCaseAndTwoNodeWorkflow();

    // 1. Start run via daemon transport: M1 enters awaiting-review, M2 is pending, zero model calls.
    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: AutomationRunStartInputSchema.parse({
          workflowId: WORKFLOW_ID
        })
      })
    );
    expect(startedRun.schemaVersion).toBe(AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION);
    expect(startedRun.state).toBe("waiting");
    expect(startedRun.activeNodeId).toBe(NODE_M1_ID);
    const m1Initial = startedRun.steps.find((s) => s.nodeId === NODE_M1_ID)!;
    const m2Initial = startedRun.steps.find((s) => s.nodeId === NODE_M2_ID)!;
    expect(m1Initial.state).toBe("awaiting-review");
    expect(m2Initial.state).toBe("pending");
    expect(h.state.chatCalls).toHaveLength(0);
    if (!("attemptId" in m1Initial) || m1Initial.attemptId === null) {
      throw new Error("Expected M1 attemptId");
    }

    // 2. Prepare M1 review in WorkstationHost: still zero model calls.
    const reviewM1 = await host.prepareGraphNode(
      {
        runId: startedRun.id,
        nodeId: NODE_M1_ID,
        attemptId: m1Initial.attemptId
      },
      owner
    );
    expect(reviewM1.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(reviewM1.caseId).toBe(caseId);
    expect(reviewM1.runId).toBe(startedRun.id);
    expect(reviewM1.nodeId).toBe(NODE_M1_ID);
    expect(reviewM1.attemptId).toBe(m1Initial.attemptId);
    expect(reviewM1.sourceTurnIds).toEqual([sourceTurnId]);
    expect(h.state.chatCalls).toHaveLength(0);

    // 3. Start M1 with its one-use review token.
    h.state.nextChatHandler = async (req) => ({
      operationId: req.operationId,
      runtimeId: req.runtimeId,
      modelId: req.modelId,
      content: "M1 Finding: Delivery is 14 days with a 2% weekly penalty; payment is net 30.",
      startedAt: new Date(h.state.clock).toISOString(),
      finishedAt: new Date(h.state.clock + 20).toISOString(),
      localOnly: true
    });

    const afterM1 = await host.startGraphNode({ token: reviewM1.token }, owner);
    expect(h.state.chatCalls).toHaveLength(1);
    expect(h.state.chatCalls[0]!.operationId).toBe(reviewM1.operationId);

    // Verify durable Book proof for M1
    const keyM1: GraphHostCorrelationKey = {
      caseId,
      graphRunId: startedRun.id,
      nodeId: NODE_M1_ID,
      attemptId: m1Initial.attemptId
    };
    const m1Record = lookup(h.db, keyM1);
    expect(m1Record).not.toBeNull();
    expect(m1Record?.status).toBe("terminal");
    expect(m1Record?.outcome).toBe("completed");
    expect(m1Record?.answerTurnId).toBeTruthy();
    const m1Proven = readProvenGraphHostTerminal(h.db, keyM1, reviewM1.operationId);
    expect(m1Proven?.status).toBe("completed");
    expect(m1Proven?.output).toContain(
      "M1 Finding: Delivery is 14 days with a 2% weekly penalty; payment is net 30."
    );

    // Verify daemon state after M1: M1 is completed, M2 is awaiting-review with a fresh attemptId, and M2 has NOT been dispatched.
    expect(afterM1.run.state).toBe("waiting");
    expect(afterM1.run.activeNodeId).toBe(NODE_M2_ID);
    const m1After = afterM1.run.steps.find((s) => s.nodeId === NODE_M1_ID)!;
    const m2After = afterM1.run.steps.find((s) => s.nodeId === NODE_M2_ID)!;
    expect(m1After.state).toBe("completed");
    expect(m1After.answerTurnId).toBe(m1Record?.answerTurnId);
    expect(m2After.state).toBe("awaiting-review");
    expect(m2After.attemptId).toBeTruthy();
    expect(m2After.attemptId).not.toBe(m1Initial.attemptId);
    expect(h.state.chatCalls).toHaveLength(1);

    // 4. Prepare M2 review: includes M1's completed output and M1's finding turn ID in sourceTurnIds!
    const reviewM2 = await host.prepareGraphNode(
      {
        runId: startedRun.id,
        nodeId: NODE_M2_ID,
        attemptId: m2After.attemptId!
      },
      owner
    );
    expect(reviewM2.token).not.toBe(reviewM1.token);
    expect(reviewM2.requestSha256).not.toBe(reviewM1.requestSha256);
    expect(reviewM2.sourceTurnIds).toEqual([sourceTurnId, m1Record!.answerTurnId!]);
    expect(reviewM2.contextPreview).toContain("M1: Extract Clauses");
    expect(reviewM2.contextPreview).toContain("2% weekly penalty");
    expect(h.state.chatCalls).toHaveLength(1);

    // 5. Start M2 with its fresh one-use review token.
    h.state.nextChatHandler = async (req) => ({
      operationId: req.operationId,
      runtimeId: req.runtimeId,
      modelId: req.modelId,
      content: "M2 Synthesis: Cap the 2% weekly delay penalty at 10% total contract value.",
      startedAt: new Date(h.state.clock).toISOString(),
      finishedAt: new Date(h.state.clock + 18).toISOString(),
      localOnly: true
    });

    const afterM2 = await host.startGraphNode({ token: reviewM2.token }, owner);
    expect(h.state.chatCalls).toHaveLength(2);
    expect(afterM2.run.state).toBe("completed");
    expect(afterM2.run.activeNodeId).toBeNull();
    const m2Completed = afterM2.run.steps.find((s) => s.nodeId === NODE_M2_ID)!;
    expect(m2Completed.state).toBe("completed");
    expect(m2Completed.output).toContain("Cap the 2% weekly delay penalty at 10%");
    expect(afterM2.run.receipts).toHaveLength(1);
    expect(afterM2.run.receipts[0]!.outcome).toBe("completed");
    expect(afterM2.run.receipts[0]!.completedNodeIds).toEqual([NODE_M1_ID, NODE_M2_ID]);

    // Verify Case turns contain both finding turns with seat "graph-host-answer"
    const findingTurns = turnsFor(h.db, caseId).filter(
      (t) => t.seat === GRAPH_HOST_ANSWER_SEAT && t.kind === "finding"
    );
    expect(findingTurns).toHaveLength(2);

    // Verify active lease was released on run completion
    const snapshot = await h.getRuntime().snapshot();
    const lease = snapshot.leases.find((l) => l.runId === startedRun.id);
    expect(lease?.state).toBe("released");
  });

  it("refuses reused, expired, wrong-owner, or invalidated-owner review tokens before any model call", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner1 = { id: "window-1" };
    const owner2 = { id: "window-2" };
    await h.setupCaseAndTwoNodeWorkflow();

    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    const m1 = startedRun.steps[0]!;
    if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

    // Wrong owner cannot start
    const review1 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner1
    );
    await expect(
      host.startGraphNode({ token: review1.token }, owner2)
    ).rejects.toThrow(/This window changed|another window/iu);
    expect(h.state.chatCalls).toHaveLength(0);

    // Token was consumed by the failed start attempt; reusing it must fail closed
    await expect(
      host.startGraphNode({ token: review1.token }, owner1)
    ).rejects.toThrow(/review has expired|Review the step again|Review the request again/iu);
    expect(h.state.chatCalls).toHaveLength(0);

    // Expired token cannot start
    const review2 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner1
    );
    h.state.clock += REVIEW_TTL_MS + 1_000;
    await expect(
      host.startGraphNode({ token: review2.token }, owner1)
    ).rejects.toThrow(/review has expired|Review the step again|Review the request again/iu);
    expect(h.state.chatCalls).toHaveLength(0);

    // Invalidated owner cannot start
    const review3 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner1
    );
    host.invalidate(owner1);
    await expect(
      host.startGraphNode({ token: review3.token }, owner1)
    ).rejects.toThrow(/authority ended|review has expired|Review the request again/iu);
    expect(h.state.chatCalls).toHaveLength(0);
  });

  it("refuses startGraphNode when Case sources, Case open status, governed project memory, or pinned agent revision change after prepareGraphNode", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    const { caseId, sourceTurnId } = await h.setupCaseAndTwoNodeWorkflow();
    h.state.projectId = "proj-1";
    h.state.memoryEpoch = 1;

    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    const m1 = startedRun.steps[0]!;
    if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

    // 1. Governed memory epoch changes after prepare
    const reviewMemory = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );
    h.state.memoryEpoch = 2;
    await expect(
      host.startGraphNode({ token: reviewMemory.token }, owner)
    ).rejects.toThrow(/project memory changed/iu);
    expect(h.state.chatCalls).toHaveLength(0);

    // 2. Source turn body mutates in SQLite after prepare
    const reviewSource = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );
    h.db
      .prepare("UPDATE case_turn SET body = ? WHERE id = ?")
      .run("Tampered source text after review", sourceTurnId);
    await expect(
      host.startGraphNode({ token: reviewSource.token }, owner)
    ).rejects.toThrow(/changed since you looked at them|changed since you reviewed/iu);
    expect(h.state.chatCalls).toHaveLength(0);

    // Restore source text and test closed-case refusal before agent mutation
    h.db
      .prepare("UPDATE case_turn SET body = ? WHERE id = ?")
      .run(
        "Clause 4: Delivery within 14 days. Penalty of 2% per week. Payment net 30 days.",
        sourceTurnId
      );
    const reviewAgent = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );

    // 3. Closed case refuses prepareGraphNode
    closeCase(h.db, caseId, { closedAs: "settled", verdict: "Closed." });
    await expect(
      host.prepareGraphNode(
        { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
        owner
      )
    ).rejects.toThrow(/closed or missing|Open work is required/iu);

    // Reopen case to verify agent revision drift refusal on startGraphNode
    h.db.prepare("UPDATE work_case SET closed_at = NULL, closed_as = NULL WHERE id = ?").run(caseId);
    await h.getRuntime().saveAgent({
      id: AGENT_M1_ID,
      name: "Clause Extractor Mutated",
      description: "Mutated agent.",
      systemPrompt: "Different prompt after review.",
      runtimeId: "cadrane-local-loopback",
      modelId: MODEL_ID,
      routingMode: "fixed",
      fallbackRoutes: [],
      temperature: 0.2,
      maxTokens: 512
    });
    await expect(
      host.startGraphNode({ token: reviewAgent.token }, owner)
    ).rejects.toThrow(/Automation agent has changed|review-bound agent has changed/iu);
    expect(h.state.chatCalls).toHaveLength(0);
  });

  it("fails closed when dependency context exceeds the 24,000-character review limit", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    await h.setupCaseAndTwoNodeWorkflow({
      m2SystemPrompt: "S".repeat(3_500),
      m2Instruction: "I".repeat(1_900)
    });

    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    const m1 = startedRun.steps[0]!;
    if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

    const reviewM1 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );
    // Produce an M1 output that makes M2's composed system + instruction + context > 24,000 chars
    h.state.nextChatHandler = async (req) => ({
      operationId: req.operationId,
      runtimeId: req.runtimeId,
      modelId: req.modelId,
      content: "X".repeat(20_000),
      startedAt: new Date(h.state.clock).toISOString(),
      finishedAt: new Date(h.state.clock + 50).toISOString(),
      localOnly: true
    });

    const afterM1 = await host.startGraphNode({ token: reviewM1.token }, owner);
    expect(afterM1.run.state).toBe("failed");
    expect(afterM1.run.error).toMatch(/exceeded maximum review size/iu);
    const m2After = afterM1.run.steps.find((s) => s.nodeId === NODE_M2_ID)!;
    expect(m2After.state).toBe("pending");
    expect(h.state.chatCalls).toHaveLength(1);
  });

  it("cancels a waiting review-bound run before review without model calls and refuses later review or start", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    await h.setupCaseAndTwoNodeWorkflow();

    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    const m1 = startedRun.steps[0]!;
    if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

    const reviewM1 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );

    const cancelledRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.action",
        payload: AutomationRunActionInputSchema.parse({
          runId: startedRun.id,
          action: "cancel"
        })
      })
    );
    expect(cancelledRun.state).toBe("cancelled");
    expect(cancelledRun.steps[0]!.state).toBe("cancelled");
    expect(cancelledRun.steps[1]!.state).toBe("cancelled");
    expect(h.state.chatCalls).toHaveLength(0);

    await expect(
      host.startGraphNode({ token: reviewM1.token }, owner)
    ).rejects.toThrow(/closed or not awaiting review|closed or cancelled/iu);
    expect(h.state.chatCalls).toHaveLength(0);
  });

  it("stops an in-flight M1 execution via stopGraphNode, records stopped in Book, reconciles daemon to cancelled, and skips M2", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    const { caseId } = await h.setupCaseAndTwoNodeWorkflow();

    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    const m1 = startedRun.steps[0]!;
    if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

    const reviewM1 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );

    h.state.nextChatHandler = async (req) => {
      const stopOutcome = await host.stopGraphNode(caseId, req.operationId, owner);
      expect(stopOutcome.stopped).toBe(true);
      return {
        operationId: req.operationId,
        runtimeId: req.runtimeId,
        modelId: req.modelId,
        content: "Late answer after stop that must be discarded",
        startedAt: new Date(h.state.clock).toISOString(),
        finishedAt: new Date(h.state.clock + 10).toISOString(),
        localOnly: true
      };
    };

    await expect(
      host.startGraphNode({ token: reviewM1.token }, owner)
    ).rejects.toThrow(/Stopped/iu);

    expect(h.state.cancelledOperations).toContain(reviewM1.operationId);

    const keyM1: GraphHostCorrelationKey = {
      caseId,
      graphRunId: startedRun.id,
      nodeId: NODE_M1_ID,
      attemptId: m1.attemptId
    };
    const proven = readProvenGraphHostTerminal(h.db, keyM1, reviewM1.operationId);
    expect(proven).toEqual({
      status: "stopped",
      answerTurnId: null,
      output: null,
      outputSha256: null
    });

    const workspace = await h.getRuntime().snapshot();
    const runAfterStop = workspace.runs.find((r) => r.id === startedRun.id)!;
    expect(runAfterStop.state).toBe("cancelled");
    expect(runAfterStop.steps[0]!.state).toBe("cancelled");
    expect(runAfterStop.steps[1]!.state).toBe("pending");
    expect(h.state.chatCalls).toHaveLength(1);
  });

  it("reconciles all cross-store crash cuts truth-preservingly without re-dispatching completed or interrupted nodes", async () => {
    // Cut 1: Crash after Book saveIntent before daemon reserveAttempt
    {
      const h = createGraphHarness();
      const { host } = h.createHost();
      const owner = { id: "window-1" };
      const { caseId } = await h.setupCaseAndTwoNodeWorkflow();

      const startedRun = AutomationRunSnapshotSchema.parse(
        await h.sendDaemon({
          type: "automation.run.start",
          payload: { workflowId: WORKFLOW_ID }
        })
      );
      const m1 = startedRun.steps[0]!;
      if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

      const reviewM1 = await host.prepareGraphNode(
        { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
        owner
      );

      saveIntent(h.db, {
        caseId,
        graphRunId: startedRun.id,
        nodeId: NODE_M1_ID,
        attemptId: m1.attemptId,
        descriptorSha256: reviewM1.descriptorSha256,
        workflowSha256: reviewM1.workflowSha256,
        agentSha256: reviewM1.agentSha256,
        sourceTurnIds: reviewM1.sourceTurnIds,
        runtimeId: reviewM1.runtimeId,
        modelId: reviewM1.modelId,
        createdAt: h.state.clock
      });

      const { host: restartedHost } = h.createHost();
      const reconciledCount = await restartedHost.reconcileGraphHostRuns();
      expect(reconciledCount).toBe(1);
      expect(h.state.chatCalls).toHaveLength(0);

      const snapshot = await h.getRuntime().snapshot();
      const run = snapshot.runs.find((r) => r.id === startedRun.id)!;
      expect(run.state).toBe("interrupted");
      expect(run.steps[0]!.state).toBe("interrupted");
      expect(run.steps[1]!.state).toBe("pending");
    }

    // Cut 2: Crash after daemon reserveAttempt before daemon bindOperation / Book recordDispatch
    {
      const h = createGraphHarness();
      const { host } = h.createHost();
      const owner = { id: "window-1" };
      await h.setupCaseAndTwoNodeWorkflow();

      const startedRun = AutomationRunSnapshotSchema.parse(
        await h.sendDaemon({
          type: "automation.run.start",
          payload: { workflowId: WORKFLOW_ID }
        })
      );
      const m1 = startedRun.steps[0]!;
      if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

      const reviewM1 = await host.prepareGraphNode(
        { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
        owner
      );

      await h.sendDaemon({
        type: "automation.host-attempt.reserve",
        payload: {
          runId: startedRun.id,
          nodeId: NODE_M1_ID,
          attemptId: m1.attemptId,
          descriptorSha256: reviewM1.descriptorSha256
        }
      });

      await h.restartDaemon();
      const { host: restartedHost } = h.createHost();
      const reconciledCount = await restartedHost.reconcileGraphHostRuns();
      expect(reconciledCount).toBe(1);
      expect(h.state.chatCalls).toHaveLength(0);

      const snapshot = await h.getRuntime().snapshot();
      const run = snapshot.runs.find((r) => r.id === startedRun.id)!;
      expect(run.state).toBe("interrupted");
      expect(run.steps[0]!.state).toBe("interrupted");
      expect(run.steps[1]!.state).toBe("pending");
      const lease = snapshot.leases.find((l) => l.runId === startedRun.id);
      expect(lease?.state).toBe("released");
    }

    // Cut 3: Crash after daemon bindOperation & Book recordDispatch while model call is in flight
    {
      const h = createGraphHarness();
      const { host } = h.createHost();
      const owner = { id: "window-1" };
      const { caseId } = await h.setupCaseAndTwoNodeWorkflow();

      const startedRun = AutomationRunSnapshotSchema.parse(
        await h.sendDaemon({
          type: "automation.run.start",
          payload: { workflowId: WORKFLOW_ID }
        })
      );
      const m1 = startedRun.steps[0]!;
      if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

      const reviewM1 = await host.prepareGraphNode(
        { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
        owner
      );

      saveIntent(h.db, {
        caseId,
        graphRunId: startedRun.id,
        nodeId: NODE_M1_ID,
        attemptId: m1.attemptId,
        descriptorSha256: reviewM1.descriptorSha256,
        workflowSha256: reviewM1.workflowSha256,
        agentSha256: reviewM1.agentSha256,
        sourceTurnIds: reviewM1.sourceTurnIds,
        runtimeId: reviewM1.runtimeId,
        modelId: reviewM1.modelId,
        createdAt: h.state.clock
      });
      const reserved = AutomationHostReserveAttemptResultSchema.parse(
        await h.sendDaemon({
          type: "automation.host-attempt.reserve",
          payload: {
            runId: startedRun.id,
            nodeId: NODE_M1_ID,
            attemptId: m1.attemptId,
            descriptorSha256: reviewM1.descriptorSha256
          }
        })
      );
      await h.sendDaemon({
        type: "automation.host-attempt.bind",
        payload: {
          runId: startedRun.id,
          nodeId: NODE_M1_ID,
          attemptId: m1.attemptId,
          operationId: reviewM1.operationId,
          correlation: reserved.correlation
        }
      });
      recordDispatch(h.db, {
        caseId,
        graphRunId: startedRun.id,
        nodeId: NODE_M1_ID,
        attemptId: m1.attemptId,
        operationId: reviewM1.operationId,
        dispatchedAt: h.state.clock
      });

      await h.restartDaemon();
      const { host: restartedHost } = h.createHost();
      const reconciledCount = await restartedHost.reconcileGraphHostRuns();
      expect(reconciledCount).toBe(1);

      const record = lookup(h.db, {
        caseId,
        graphRunId: startedRun.id,
        nodeId: NODE_M1_ID,
        attemptId: m1.attemptId
      });
      expect(record?.status).toBe("terminal");
      expect(record?.outcome).toBe("interrupted");

      const snapshot = await h.getRuntime().snapshot();
      const run = snapshot.runs.find((r) => r.id === startedRun.id)!;
      expect(run.state).toBe("interrupted");
      expect(run.steps[0]!.state).toBe("interrupted");
      expect(run.steps[0]!.error).toBe("Host execution was interrupted.");
    }

    // Cut 4: Crash after Book recordTerminal("completed") and finding turn commit, BEFORE daemon reconcileTerminal
    {
      const h = createGraphHarness();
      const { host } = h.createHost();
      const owner = { id: "window-1" };
      const { caseId } = await h.setupCaseAndTwoNodeWorkflow();

      const startedRun = AutomationRunSnapshotSchema.parse(
        await h.sendDaemon({
          type: "automation.run.start",
          payload: { workflowId: WORKFLOW_ID }
        })
      );
      const m1 = startedRun.steps[0]!;
      if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

      const reviewM1 = await host.prepareGraphNode(
        { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
        owner
      );

      // Simulate crash right before reconcileTerminal is sent to daemon
      h.state.beforeReconcileHook = async () => {
        throw new Error("Simulated crash after Book commit before daemon reconcile.");
      };

      await expect(
        host.startGraphNode({ token: reviewM1.token }, owner)
      ).rejects.toThrow(/Simulated crash after Book commit before daemon reconcile/u);

      expect(h.state.chatCalls).toHaveLength(1);
      h.state.beforeReconcileHook = null;

      // Book already has completed terminal proof for M1!
      const provenM1 = readProvenGraphHostTerminal(
        h.db,
        {
          caseId,
          graphRunId: startedRun.id,
          nodeId: NODE_M1_ID,
          attemptId: m1.attemptId
        },
        reviewM1.operationId
      );
      expect(provenM1?.status).toBe("completed");

      // Restart daemon (which marks unproven host-reserved as interrupted) and run reconcileGraphHostRuns()
      await h.restartDaemon();
      const { host: restartedHost } = h.createHost();
      const reconciledCount = await restartedHost.reconcileGraphHostRuns();
      expect(reconciledCount).toBe(1);
      // Must NOT have re-dispatched M1!
      expect(h.state.chatCalls).toHaveLength(1);

      // Verify M1 is now completed in daemon and M2 advanced to awaiting-review!
      const snapshot = await h.getRuntime().snapshot();
      const runAfterReconcile = snapshot.runs.find((r) => r.id === startedRun.id)!;
      expect(runAfterReconcile.state).toBe("waiting");
      expect(runAfterReconcile.activeNodeId).toBe(NODE_M2_ID);
      const m1Step = runAfterReconcile.steps.find((s) => s.nodeId === NODE_M1_ID)!;
      const m2Step = runAfterReconcile.steps.find((s) => s.nodeId === NODE_M2_ID)!;
      expect(m1Step.state).toBe("completed");
      expect(m2Step.state).toBe("awaiting-review");
      if (!("attemptId" in m2Step) || m2Step.attemptId === null) {
        throw new Error("Expected M2 attemptId after reconciliation");
      }

      // Now prepare and start M2 on the restarted host to complete the workflow!
      const reviewM2 = await restartedHost.prepareGraphNode(
        {
          runId: startedRun.id,
          nodeId: NODE_M2_ID,
          attemptId: m2Step.attemptId
        },
        owner
      );
      const finished = await restartedHost.startGraphNode(
        { token: reviewM2.token },
        owner
      );
      expect(finished.run.state).toBe("completed");
      expect(h.state.chatCalls).toHaveLength(2);
    }
  });

  it("preserves v1 workflow save and run execution unchanged", async () => {
    const h = createGraphHarness();
    const agent = await h.getRuntime().saveAgent({
      id: AGENT_M1_ID,
      name: "V1 Agent",
      description: "V1 worker agent.",
      systemPrompt: "Answer concisely.",
      runtimeId: "cadrane-local-loopback",
      modelId: MODEL_ID,
      routingMode: "fixed",
      fallbackRoutes: [],
      temperature: 0.2,
      maxTokens: 256
    });

    const savedV1 = AutomationWorkflowSchema.parse(
      await h.sendDaemon({
        type: "automation.workflow.save",
        payload: AutomationWorkflowSaveInputSchema.parse({
          id: WORKFLOW_ID,
          name: "Legacy V1 Flow",
          description: "Runs v1 model node directly.",
          enabled: true,
          trigger: { kind: "manual" },
          budget: {
            maxNodeExecutions: 2,
            maxDurationMs: 120_000,
            maxOutputCharacters: 12_000
          },
          nodes: [
            {
              id: NODE_M1_ID,
              kind: "model",
              title: "V1 Step",
              agentId: agent.id,
              connectorId: null,
              instruction: "Summarize v1 status.",
              dependsOn: []
            }
          ]
        })
      })
    );
    expect(savedV1.id).toBe(WORKFLOW_ID);

    const v1Started = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    let v1Run = v1Started;
    for (let i = 0; i < 20 && v1Run.state !== "completed"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const snap = await h.getRuntime().snapshot();
      v1Run = snap.runs.find((r) => r.id === v1Started.id)!;
    }
    expect(v1Run.state).toBe("completed");
    expect(v1Run.steps[0]!.state).toBe("completed");
    expect(v1Run.steps[0]!.output).toContain("v1 output");
  });

  it("refuses wrong operation terminal evidence and fails closed on corrupted Book history", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    const { caseId } = await h.setupCaseAndTwoNodeWorkflow();

    const startedRun = AutomationRunSnapshotSchema.parse(
      await h.sendDaemon({
        type: "automation.run.start",
        payload: { workflowId: WORKFLOW_ID }
      })
    );
    const m1 = startedRun.steps[0]!;
    if (!("attemptId" in m1) || m1.attemptId === null) throw new Error("Missing attemptId");

    const reviewM1 = await host.prepareGraphNode(
      { runId: startedRun.id, nodeId: NODE_M1_ID, attemptId: m1.attemptId },
      owner
    );

    let capturedCorrelation = "";
    h.state.beforeReconcileHook = async () => {
      const snap = await h.getRuntime().snapshot();
      const run = snap.runs.find((r) => r.id === startedRun.id)!;
      const step = run.steps[0]!;
      if ("intent" in step && step.intent !== null) {
        capturedCorrelation = step.intent.correlation;
      }
      throw new Error("Pause before daemon reconcile to test wrong operation and corrupt history.");
    };

    await expect(
      host.startGraphNode({ token: reviewM1.token }, owner)
    ).rejects.toThrow(/Pause before daemon reconcile/u);
    h.state.beforeReconcileHook = null;

    const keyM1: GraphHostCorrelationKey = {
      caseId,
      graphRunId: startedRun.id,
      nodeId: NODE_M1_ID,
      attemptId: m1.attemptId
    };

    // 1. Wrong operationId is rejected by both readProvenGraphHostTerminal and daemon reconcile
    const wrongOperationId = "99999999-9999-4999-8999-999999999999";
    expect(() =>
      readProvenGraphHostTerminal(h.db, keyM1, wrongOperationId)
    ).toThrow(/does not match the bound dispatch/iu);

    const validEvidence = readProvenGraphHostTerminal(h.db, keyM1, reviewM1.operationId)!;
    expect(validEvidence.status).toBe("completed");

    await expect(
      h.sendDaemon({
        type: "automation.host-attempt.reconcile",
        payload: {
          runId: startedRun.id,
          nodeId: NODE_M1_ID,
          attemptId: m1.attemptId,
          correlation: capturedCorrelation,
          operationId: wrongOperationId,
          terminalEvidence: validEvidence
        }
      })
    ).rejects.toThrow(/Bound operation ID mismatch/iu);

    // 2. Corrupting the finding turn body in SQLite causes readProvenGraphHostTerminal to fail closed on SHA-256 mismatch
    const record = lookup(h.db, keyM1)!;
    h.db
      .prepare("UPDATE case_turn SET body = ? WHERE id = ?")
      .run("Corrupted finding turn body after commit", record.answerTurnId!);

    expect(() =>
      readProvenGraphHostTerminal(h.db, keyM1, reviewM1.operationId)
    ).toThrow(/hash does not match/iu);
  });

  it("converges manual, interval, and folder triggers onto the same review-bound waiting boundary with zero daemon model calls", async () => {
    const h = createGraphHarness();
    const { host } = h.createHost();
    const owner = { id: "window-1" };
    const { caseId, sourceTurnId } = await h.setupCaseAndTwoNodeWorkflow();

    const intervalWorkflowId = "66666666-6666-4666-8666-666666666666";
    const folderWorkflowId = "77777777-7777-4777-8777-777777777777";

    await h.sendDaemon({
      type: "automation.workflow.save-review-bound",
      payload: AutomationReviewBoundWorkflowInputSchema.parse({
        caseId,
        sourceTurnIds: [sourceTurnId],
        workflow: {
          id: intervalWorkflowId,
          name: "Interval Review Flow",
          description: "Interval triggered v2 workflow.",
          enabled: true,
          trigger: { kind: "interval", everyMinutes: 15, runOnceIfOverdue: true },
          budget: {
            maxNodeExecutions: 2,
            maxDurationMs: 600_000,
            maxOutputCharacters: 24_000
          },
          nodes: [
            {
              id: NODE_M1_ID,
              kind: "model",
              title: "Interval M1",
              agentId: AGENT_M1_ID,
              connectorId: null,
              instruction: "Check interval updates.",
              dependsOn: []
            }
          ]
        }
      })
    });

    await h.sendDaemon({
      type: "automation.workflow.save-review-bound",
      payload: AutomationReviewBoundWorkflowInputSchema.parse({
        caseId,
        sourceTurnIds: [sourceTurnId],
        workflow: {
          id: folderWorkflowId,
          name: "Folder Review Flow",
          description: "Folder triggered v2 workflow.",
          enabled: true,
          trigger: { kind: "folder", root: "/tmp/cadrane-watched-folder" },
          budget: {
            maxNodeExecutions: 2,
            maxDurationMs: 600_000,
            maxOutputCharacters: 24_000
          },
          nodes: [
            {
              id: NODE_M1_ID,
              kind: "model",
              title: "Folder M1",
              agentId: AGENT_M1_ID,
              connectorId: null,
              instruction: "Check folder updates.",
              dependsOn: []
            }
          ]
        }
      })
    });

    // Trigger interval and folder flows
    const intervalRun = await h.getRuntime().start({ workflowId: intervalWorkflowId }, "interval");
    await h.getRuntime().folderChanged("/tmp/cadrane-watched-folder", new Date(h.state.clock));
    const snap = await h.getRuntime().snapshot();
    const folderRun = snap.runs.find((r) => r.workflowId === folderWorkflowId)!;

    expect(intervalRun.triggerKind).toBe("interval");
    expect(intervalRun.state).toBe("waiting");
    expect(intervalRun.steps[0]!.state).toBe("awaiting-review");

    expect(folderRun.triggerKind).toBe("folder");
    expect(folderRun.state).toBe("waiting");
    expect(folderRun.steps[0]!.state).toBe("awaiting-review");

    // Zero model calls across both triggers before explicit owner prepare + start
    expect(h.state.chatCalls).toHaveLength(0);

    // Both can be prepared and started only through WorkstationHost with separate review tokens
    const intervalStep = intervalRun.steps[0]!;
    const folderStep = folderRun.steps[0]!;
    if (!("attemptId" in intervalStep) || !intervalStep.attemptId) throw new Error("Missing interval attemptId");
    if (!("attemptId" in folderStep) || !folderStep.attemptId) throw new Error("Missing folder attemptId");

    const revInterval = await host.prepareGraphNode(
      { runId: intervalRun.id, nodeId: NODE_M1_ID, attemptId: intervalStep.attemptId },
      owner
    );
    const revFolder = await host.prepareGraphNode(
      { runId: folderRun.id, nodeId: NODE_M1_ID, attemptId: folderStep.attemptId },
      owner
    );
    expect(revInterval.token).not.toBe(revFolder.token);
    expect(h.state.chatCalls).toHaveLength(0);
  });
});
