/**
 * Why: Verifies that daemon dispatcher transport for review-bound graph Host attempt
 * reservation and operation binding passes exact request identifiers, returns strictly
 * parsed run snapshots, preserves function-unavailable failures, rejects malformed payloads,
 * refuses caller-supplied completed flags, and never triggers runtime chat or host launch.
 */

import {
  AutomationHostBindOperationResultSchema,
  AutomationHostReserveAttemptResultSchema,
  DaemonRequestSchema,
  type AutomationHostAttemptIntent,
  type AutomationRunSnapshot,
  type HardwareProfile
} from "@cadrane/contracts";
import { describe, expect, it } from "vitest";
import {
  createDispatcherFromDependencies,
  type DaemonAutomationBoundary,
  type DaemonRuntimeBoundary,
  type DaemonWorkRequest
} from "./service.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const nodeId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const workflowId = "55555555-5555-4555-8555-555555555555";
const agentId = "66666666-6666-4666-8666-666666666666";
const caseId = "77777777-7777-4777-8777-777777777777";
const sourceTurnId = "88888888-8888-4888-8888-888888888888";
const operationId = "99999999-9999-4999-8999-999999999999";
const correlation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const correlationId = correlation;
const descriptorSha256 = "b".repeat(64);

const profile: HardwareProfile = {
  platform: "darwin",
  operatingSystem: "macOS test",
  architecture: "arm64",
  chip: "Apple test",
  gpuName: "Apple test",
  dedicatedGpuMemoryBytes: null,
  logicalCores: 8,
  memoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 100 * 1024 ** 3,
  acceleration: "metal",
  recommendation: "balanced",
  recommendationReason: "Fixture recommendation.",
  measuredAt: "2026-08-01T00:00:00.000Z"
};

function createValidRunSnapshot(overrides?: {
  id?: string;
  activeNodeId?: string;
  nodeId?: string;
  attemptId?: string;
  stepState?: "host-reserved" | "awaiting-review" | "pending";
  operationId?: string | null;
  correlation?: string;
  descriptorSha256?: string;
}): AutomationRunSnapshot {
  const currentStepNodeId = overrides?.nodeId ?? nodeId;
  const currentAttemptId = overrides?.attemptId ?? attemptId;
  const currentStepState = overrides?.stepState ?? "host-reserved";
  const currentCorrelation = overrides?.correlation ?? correlation;
  const currentDescriptorSha256 =
    overrides?.descriptorSha256 ?? descriptorSha256;

  return {
    schemaVersion: 2,
    id: overrides?.id ?? runId,
    workflowId,
    workflowRevision: 1,
    workflowName: "Review Workflow",
    triggerKind: "manual",
    state: "running",
    activeNodeId: overrides?.activeNodeId ?? nodeId,
    budget: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 10,
      maxOutputCharacters: 10_000
    },
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
    startedAt: "2026-09-24T10:00:00.000Z",
    finishedAt: null,
    deadlineAt: "2026-09-24T12:00:00.000Z",
    error: null,
    receipts: [],
    reviewBinding: {
      caseId,
      sourceTurnIds: [sourceTurnId],
      reviewRequired: true,
      agentRevisions: [{ agentId, revision: 1 }]
    },
    steps: [
      {
        nodeId: currentStepNodeId,
        title: "Review Node",
        instruction: "Review the plan before executing tool steps.",
        kind: "model",
        dependsOn: [],
        connectorId: null,
        agent: {
          agentId,
          agentRevision: 1,
          name: "Review Agent",
          systemPrompt: "System prompt for host review execution.",
          modelId: "qwen3-4b-q4-k-m",
          runtimeId: "managed-llama-b10182",
          routingMode: "fixed",
          fallbackRoutes: [],
          temperature: 0.2,
          maxTokens: 2048
        },
        state: currentStepState,
        attempt: 1,
        attemptId: currentAttemptId,
        operationId:
          overrides?.operationId !== undefined ? overrides.operationId : null,
        resolvedRoute: null,
        citations: [],
        startedAt: "2026-09-24T10:00:00.000Z",
        finishedAt: null,
        output: null,
        error: null,
        intent:
          currentStepState === "host-reserved"
            ? {
                correlation: currentCorrelation,
                correlationId: currentCorrelation,
                descriptorSha256: currentDescriptorSha256,
                createdAt: "2026-09-24T10:00:00.000Z"
              }
            : null
      }
    ]
  };
}

function createAugmentedReserveResult(
  snapshot: AutomationRunSnapshot,
  overrides?: { correlation?: string; intent?: AutomationHostAttemptIntent }
) {
  const intent: AutomationHostAttemptIntent = overrides?.intent ?? {
    correlation,
    correlationId,
    descriptorSha256,
    createdAt: "2026-09-24T10:00:00.000Z"
  };
  return Object.assign({}, snapshot, {
    run: snapshot,
    intent,
    correlation: overrides?.correlation ?? correlation
  });
}

function createAugmentedBindResult(snapshot: AutomationRunSnapshot) {
  return Object.assign({}, snapshot, {
    run: snapshot
  });
}

class FakeAutomationBoundary implements DaemonAutomationBoundary {
  readonly reserveCalls: unknown[] = [];
  readonly bindCalls: unknown[] = [];
  readonly reconcileCalls: unknown[] = [];
  readonly saveReviewBoundCalls: unknown[] = [];
  readonly actionCalls: unknown[] = [];
  readonly startCalls: unknown[] = [];
  reserveResult: unknown = null;
  bindResult: unknown = null;
  reconcileResult: unknown = null;
  saveReviewBoundResult: unknown = null;
  reserveError: Error | null = null;
  bindError: Error | null = null;
  reconcileError: Error | null = null;

  async snapshot(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveAgent(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveWorkflow(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveReviewBoundWorkflow(input: unknown): Promise<unknown> {
    this.saveReviewBoundCalls.push(input);
    return this.saveReviewBoundResult;
  }
  async saveMemory(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveSource(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async reviewArtifact(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async ensureLocalConnector(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async exportPack(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async importPack(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async dryRun(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async folderChanged(): Promise<void> {}
  async start(input: unknown): Promise<unknown> {
    this.startCalls.push(input);
    throw new Error("Should not start");
  }
  async action(input: unknown): Promise<unknown> {
    this.actionCalls.push(input);
    throw new Error("Should not action");
  }
  async reserveHostAttempt(input: unknown): Promise<unknown> {
    this.reserveCalls.push(input);
    if (this.reserveError !== null) {
      throw this.reserveError;
    }
    return this.reserveResult;
  }
  async bindHostOperation(input: unknown): Promise<unknown> {
    this.bindCalls.push(input);
    if (this.bindError !== null) {
      throw this.bindError;
    }
    return this.bindResult;
  }
  async reconcileHostTerminal(input: unknown): Promise<unknown> {
    this.reconcileCalls.push(input);
    if (this.reconcileError !== null) {
      throw this.reconcileError;
    }
    return this.reconcileResult;
  }
  async shutdown(): Promise<void> {}
}

class FakeAutomationBoundaryWithoutHandlers
  implements DaemonAutomationBoundary {
  readonly actionCalls: unknown[] = [];
  readonly startCalls: unknown[] = [];

  async snapshot(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveAgent(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveWorkflow(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveMemory(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async saveSource(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async reviewArtifact(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async ensureLocalConnector(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async exportPack(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async importPack(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async dryRun(): Promise<unknown> {
    throw new Error("Boundary method not invoked");
  }
  async folderChanged(): Promise<void> {}
  async start(input: unknown): Promise<unknown> {
    this.startCalls.push(input);
    throw new Error("Should not start");
  }
  async action(input: unknown): Promise<unknown> {
    this.actionCalls.push(input);
    throw new Error("Should not action");
  }
  async shutdown(): Promise<void> {}
}

interface FakeRuntimeManagerWithTracking extends DaemonRuntimeBoundary {
  readonly chatCalls: unknown[];
}

function fakeRuntimeManager(): FakeRuntimeManagerWithTracking {
  const chatCalls: unknown[] = [];
  return {
    chatCalls,
    discover: async () => [],
    chat: async (
      request: Parameters<DaemonRuntimeBoundary["chat"]>[0]
    ): Promise<unknown> => {
      chatCalls.push(request);
      throw new Error("Chat is not used in this fixture.");
    },
    cancel: () => false,
    shutdown: async () => {}
  };
}

function createTestDispatcher(automationRuntime?: DaemonAutomationBoundary) {
  const runtimeManager = fakeRuntimeManager();
  const dispatcher = createDispatcherFromDependencies({
    dataDirectory: "/tmp/switchboard-trusted",
    runtimeManager,
    ...(automationRuntime === undefined ? {} : { automationRuntime }),
    installBoundary: null,
    installUnavailableError: null,
    profile: async () => profile,
    inspect: async () => ({ inspection: null })
  });
  return Object.assign(dispatcher, { runtimeManager });
}

function makeReserveRequest(payload: unknown): DaemonWorkRequest {
  return DaemonRequestSchema.parse({
    protocolVersion: 5,
    requestId,
    type: "automation.host-attempt.reserve",
    payload
  }) as DaemonWorkRequest;
}

function makeBindRequest(payload: unknown): DaemonWorkRequest {
  return DaemonRequestSchema.parse({
    protocolVersion: 5,
    requestId,
    type: "automation.host-attempt.bind",
    payload
  }) as DaemonWorkRequest;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("automation host attempt transport", () => {
  it("forwards exact ids and sha to automation boundary and returns parsed run and reservation intent for reserve", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot();
    const reserveResult = createAugmentedReserveResult(snapshot);
    boundary.reserveResult = reserveResult;
    const dispatcher = createTestDispatcher(boundary);

    const reservePayload = {
      runId,
      nodeId,
      attemptId,
      descriptorSha256
    };

    const result = await dispatcher.dispatch(
      makeReserveRequest(reservePayload),
      signal()
    );

    expect(boundary.reserveCalls).toEqual([reservePayload]);
    expect(boundary.startCalls).toHaveLength(0);
    expect(boundary.actionCalls).toHaveLength(0);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
    expect(result).toEqual({
      run: snapshot,
      intent: {
        correlation,
        correlationId,
        descriptorSha256,
        createdAt: "2026-09-24T10:00:00.000Z"
      },
      correlation
    });
    expect(
      AutomationHostReserveAttemptResultSchema.safeParse(result).success
    ).toBe(true);
  });

  it("forwards exact ids, operationId and correlation to automation boundary and returns parsed run for bind", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot({ operationId });
    boundary.bindResult = createAugmentedBindResult(snapshot);
    const dispatcher = createTestDispatcher(boundary);

    const bindPayload = {
      runId,
      nodeId,
      attemptId,
      operationId,
      correlation,
      correlationId
    };

    const result = await dispatcher.dispatch(
      makeBindRequest(bindPayload),
      signal()
    );

    expect(boundary.bindCalls).toEqual([bindPayload]);
    expect(boundary.startCalls).toHaveLength(0);
    expect(boundary.actionCalls).toHaveLength(0);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
    expect(result).toEqual({
      run: snapshot
    });
    expect(
      AutomationHostBindOperationResultSchema.safeParse(result).success
    ).toBe(true);
  });

  it("rejects reserve when runtime result has mismatched run id", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    boundary.reserveResult = createAugmentedReserveResult(snapshot);
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects reserve when runtime result has mismatched active node id", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot({
      activeNodeId: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    boundary.reserveResult = createAugmentedReserveResult(snapshot);
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects reserve when runtime result has mismatched attempt id", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot({
      attemptId: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    boundary.reserveResult = createAugmentedReserveResult(snapshot);
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects reserve when runtime result has unexpected step state or already bound operation", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshotWrongState = createValidRunSnapshot({
      stepState: "awaiting-review"
    });
    boundary.reserveResult = createAugmentedReserveResult(snapshotWrongState);
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();

    const snapshotBound = createValidRunSnapshot({ operationId });
    boundary.reserveResult = createAugmentedReserveResult(snapshotBound);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects reserve when correlation or descriptor SHA mismatches", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot();
    boundary.reserveResult = createAugmentedReserveResult(snapshot, {
      correlation: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();

    const wrongSha = "c".repeat(64);
    const intentWrongSha: AutomationHostAttemptIntent = {
      correlation,
      correlationId,
      descriptorSha256: wrongSha,
      createdAt: "2026-09-24T10:00:00.000Z"
    };
    boundary.reserveResult = createAugmentedReserveResult(snapshot, {
      intent: intentWrongSha
    });

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects bind when runtime result has mismatched operationId or correlation", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshotWrongOp = createValidRunSnapshot({
      operationId: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    boundary.bindResult = createAugmentedBindResult(snapshotWrongOp);
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeBindRequest({ runId, nodeId, attemptId, operationId }),
        signal()
      )
    ).rejects.toThrow();

    const snapshotWrongCorr = createValidRunSnapshot({
      operationId,
      correlation: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    boundary.bindResult = createAugmentedBindResult(snapshotWrongCorr);

    await expect(
      dispatcher.dispatch(
        makeBindRequest({
          runId,
          nodeId,
          attemptId,
          operationId,
          correlation
        }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects reserve and bind when runtime result is missing nested run", async () => {
    const boundary = new FakeAutomationBoundary();
    boundary.reserveResult = {
      id: runId,
      state: "running"
    };
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();

    boundary.bindResult = {
      id: runId,
      state: "running"
    };

    await expect(
      dispatcher.dispatch(
        makeBindRequest({ runId, nodeId, attemptId, operationId }),
        signal()
      )
    ).rejects.toThrow();
  });

  it("rejects invalid reserve request payload via request schema", () => {
    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: { runId, nodeId, attemptId }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: { runId: "not-a-uuid", nodeId, attemptId, descriptorSha256 }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: { runId, nodeId, attemptId, descriptorSha256: "not-a-valid-sha" }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: {
          runId,
          nodeId,
          attemptId,
          descriptorSha256,
          completed: true
        }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: {
          runId,
          nodeId,
          attemptId,
          descriptorSha256,
          callerSuppliedCompleted: true
        }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: {}
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 4,
        requestId,
        type: "automation.host-attempt.reserve",
        payload: { runId, nodeId, attemptId, descriptorSha256 }
      }).success
    ).toBe(false);
  });

  it("rejects invalid bind request payload via request schema", () => {
    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.bind",
        payload: { runId, nodeId, attemptId }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.bind",
        payload: { runId, nodeId, attemptId, operationId: "invalid-uuid" }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.bind",
        payload: {
          runId,
          nodeId,
          attemptId,
          operationId,
          completed: true
        }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-attempt.bind",
        payload: {}
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 4,
        requestId,
        type: "automation.host-attempt.bind",
        payload: { runId, nodeId, attemptId, operationId }
      }).success
    ).toBe(false);
  });

  it("rejects malformed snapshot result via output schema", async () => {
    const boundary = new FakeAutomationBoundary();
    boundary.reserveResult = {
      schemaVersion: 2,
      runId,
      nodeId
    };
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow();

    boundary.bindResult = {
      schemaVersion: 2,
      id: "incomplete"
    };

    await expect(
      dispatcher.dispatch(
        makeBindRequest({ runId, nodeId, attemptId, operationId }),
        signal()
      )
    ).rejects.toThrow();

    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });

  it("propagates boundary errors for wrong, unknown, or v1 attempts without synthesizing success", async () => {
    const boundary = new FakeAutomationBoundary();
    const dispatcher = createTestDispatcher(boundary);

    boundary.reserveError = new Error(
      "Host attempt reservation is only available for review-bound runs."
    );

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow(
      "Host attempt reservation is only available for review-bound runs."
    );

    boundary.reserveError = new Error(
      "Automation attempt ID is stale or does not match."
    );

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toThrow(
      "Automation attempt ID is stale or does not match."
    );

    boundary.bindError = new Error("Automation run not found.");

    await expect(
      dispatcher.dispatch(
        makeBindRequest({ runId, nodeId, attemptId, operationId }),
        signal()
      )
    ).rejects.toThrow("Automation run not found.");

    boundary.bindError = new Error("Correlation mismatch.");

    await expect(
      dispatcher.dispatch(
        makeBindRequest({
          runId,
          nodeId,
          attemptId,
          operationId,
          correlation
        }),
        signal()
      )
    ).rejects.toThrow("Correlation mismatch.");

    expect(boundary.startCalls).toHaveLength(0);
    expect(boundary.actionCalls).toHaveLength(0);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });

  it("rejects clearly when boundary lacks reserveHostAttempt without fallback", async () => {
    const boundary = new FakeAutomationBoundaryWithoutHandlers();
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeReserveRequest({ runId, nodeId, attemptId, descriptorSha256 }),
        signal()
      )
    ).rejects.toMatchObject({
      detail: {
        code: "RUNTIME_UNAVAILABLE",
        retryable: false
      }
    });

    expect(boundary.actionCalls).toHaveLength(0);
    expect(boundary.startCalls).toHaveLength(0);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });

  it("rejects clearly when boundary lacks bindHostOperation without fallback", async () => {
    const boundary = new FakeAutomationBoundaryWithoutHandlers();
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeBindRequest({ runId, nodeId, attemptId, operationId }),
        signal()
      )
    ).rejects.toMatchObject({
      detail: {
        code: "RUNTIME_UNAVAILABLE",
        retryable: false
      }
    });

    expect(boundary.actionCalls).toHaveLength(0);
    expect(boundary.startCalls).toHaveLength(0);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });

  it("rejects output envelopes with caller-supplied completed flags via strict schema", () => {
    const snapshot = createValidRunSnapshot();
    const reserveEnvelope = {
      run: snapshot,
      intent: {
        correlation,
        correlationId,
        descriptorSha256,
        createdAt: "2026-09-24T10:00:00.000Z"
      },
      correlation,
      completed: true
    };
    expect(
      AutomationHostReserveAttemptResultSchema.safeParse(reserveEnvelope).success
    ).toBe(false);

    const bindEnvelope = {
      run: createValidRunSnapshot({ operationId }),
      completed: true
    };
    expect(
      AutomationHostBindOperationResultSchema.safeParse(bindEnvelope).success
    ).toBe(false);
  });

  it("enforces cross-field consistency and rejects invalid step state or mismatch in result schemas", () => {
    const validSnapshot = createValidRunSnapshot();
    const validIntent: AutomationHostAttemptIntent = {
      correlation,
      correlationId,
      descriptorSha256,
      createdAt: "2026-09-24T10:00:00.000Z"
    };

    expect(
      AutomationHostReserveAttemptResultSchema.safeParse({
        run: validSnapshot,
        intent: validIntent,
        correlation: "ffffffff-ffff-4fff-8fff-ffffffffffff"
      }).success
    ).toBe(false);

    const reservedWithOp = createValidRunSnapshot({ operationId });
    expect(
      AutomationHostReserveAttemptResultSchema.safeParse({
        run: reservedWithOp,
        intent: validIntent,
        correlation
      }).success
    ).toBe(false);

    const stepAwaiting = createValidRunSnapshot({
      stepState: "awaiting-review"
    });
    expect(
      AutomationHostReserveAttemptResultSchema.safeParse({
        run: stepAwaiting,
        intent: validIntent,
        correlation
      }).success
    ).toBe(false);

    const boundWithoutOp = createValidRunSnapshot({ operationId: null });
    expect(
      AutomationHostBindOperationResultSchema.safeParse({
        run: boundWithoutOp
      }).success
    ).toBe(false);

    const mismatchedStepCorr = createValidRunSnapshot({
      correlation: "ffffffff-ffff-4fff-8fff-ffffffffffff"
    });
    expect(
      AutomationHostReserveAttemptResultSchema.safeParse({
        run: mismatchedStepCorr,
        intent: validIntent,
        correlation
      }).success
    ).toBe(false);
  });

  it("forwards reconcileHostTerminal and saveReviewBoundWorkflow through daemon dispatcher without invoking chat", async () => {
    const boundary = new FakeAutomationBoundary();
    const snapshot = createValidRunSnapshot({ operationId });
    boundary.reconcileResult = snapshot;
    const dispatcher = createTestDispatcher(boundary);

    const reconcilePayload = {
      correlation,
      operationId,
      terminalEvidence: {
        status: "completed" as const,
        answerTurnId: sourceTurnId,
        output: "Verified finding output.",
        outputSha256: "a".repeat(64)
      }
    };

    const reconcileReq = DaemonRequestSchema.parse({
      protocolVersion: 5,
      requestId,
      type: "automation.host-attempt.reconcile",
      payload: reconcilePayload
    }) as DaemonWorkRequest;

    const reconcileRes = await dispatcher.dispatch(reconcileReq, signal());
    expect(boundary.reconcileCalls).toEqual([reconcilePayload]);
    expect(reconcileRes).toEqual({ run: snapshot });
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);

    const workflowPayload = {
      caseId,
      sourceTurnIds: [sourceTurnId],
      workflow: {
        id: workflowId,
        name: "Review Bound Flow",
        description: "Test workflow.",
        enabled: true,
        trigger: { kind: "manual" as const },
        budget: {
          maxDurationMs: 60_000,
          maxNodeExecutions: 4,
          maxOutputCharacters: 10_000
        },
        nodes: [
          {
            id: nodeId,
            title: "Node 1",
            instruction: "Analyze sources.",
            kind: "model" as const,
            agentId,
            connectorId: null,
            dependsOn: []
          }
        ]
      }
    };
    boundary.saveReviewBoundResult = {
      schemaVersion: 2,
      ...workflowPayload.workflow,
      revision: 1,
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:00.000Z",
      lastRunAt: null,
      nextRunAt: null,
      pausedReason: null,
      reviewBinding: {
        caseId,
        sourceTurnIds: [sourceTurnId],
        reviewRequired: true,
        agentRevisions: [{ agentId, revision: 1 }]
      }
    };

    const saveReq = DaemonRequestSchema.parse({
      protocolVersion: 5,
      requestId,
      type: "automation.workflow.save-review-bound",
      payload: workflowPayload
    }) as DaemonWorkRequest;

    const saveRes = await dispatcher.dispatch(saveReq, signal());
    expect(boundary.saveReviewBoundCalls).toEqual([workflowPayload]);
    expect(saveRes).toEqual(boundary.saveReviewBoundResult);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });

  it("rejects clearly when boundary lacks reconcileHostTerminal or saveReviewBoundWorkflow without fallback", async () => {
    const boundary = new FakeAutomationBoundaryWithoutHandlers();
    const dispatcher = createTestDispatcher(boundary);

    const reconcileReq = DaemonRequestSchema.parse({
      protocolVersion: 5,
      requestId,
      type: "automation.host-attempt.reconcile",
      payload: {
        correlation,
        operationId,
        terminalEvidence: {
          status: "failed",
          answerTurnId: null,
          output: null,
          outputSha256: null
        }
      }
    }) as DaemonWorkRequest;

    await expect(
      dispatcher.dispatch(reconcileReq, signal())
    ).rejects.toMatchObject({
      detail: {
        code: "RUNTIME_UNAVAILABLE",
        retryable: false
      }
    });
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });
});

