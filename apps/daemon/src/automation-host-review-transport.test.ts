/**
 * Why: Verifies that daemon dispatcher transport for automation host review descriptor
 * queries passes exact request identifiers, returns strictly parsed descriptor records,
 * fails closed on schema violations or missing boundaries, and never triggers runtime chat.
 */

import {
  DaemonRequestSchema,
  type AutomationHostReviewDescriptor,
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
const dependencyNodeId = "99999999-9999-4999-8999-999999999999";
const stepOutput = "Completed output from step 1.";

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

function createValidDescriptor(): AutomationHostReviewDescriptor {
  return {
    schemaVersion: 2,
    runId,
    nodeId,
    attemptId,
    workflowId,
    workflowRevision: 1,
    workflowSha256: "a".repeat(64),
    agentId,
    agentRevision: 1,
    agentSha256: "b".repeat(64),
    caseId,
    sourceTurnIds: [sourceTurnId],
    contextPolicy: {
      sourceTurnIds: [sourceTurnId],
      includeSystemPrompt: true,
      includeInstruction: true,
      includeDependencyOutputs: true,
      allowGlobalMemory: false,
      allowApprovedExamples: false
    },
    instruction: "Review the plan before executing tool steps.",
    systemPrompt: "System prompt for host review execution.",
    context: `### Previous Step\n${stepOutput}`,
    dependencyOutputs: [
      {
        nodeId: dependencyNodeId,
        title: "Previous Step",
        output: stepOutput,
        outputSha256: "c".repeat(64)
      }
    ],
    runtimeId: "managed-llama-b10182",
    modelId: "qwen3-4b-q4-k-m",
    routingMode: "fixed",
    fallbackRoutes: [],
    temperature: 0.2,
    maxTokens: 2048,
    provenance: {
      workflowId,
      workflowRevision: 1,
      workflowName: "Review Workflow",
      runId,
      runCreatedAt: "2026-09-24T10:00:00.000Z",
      triggerKind: "manual",
      nodeId,
      nodeTitle: "Review Node",
      dependsOn: [dependencyNodeId],
      attempt: 1,
      attemptId
    }
  };
}

class FakeAutomationBoundary implements DaemonAutomationBoundary {
  readonly descriptorCalls: unknown[] = [];
  readonly actionCalls: unknown[] = [];
  readonly startCalls: unknown[] = [];
  descriptorResult: unknown = null;

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
  async getPendingHostReviewDescriptor(input: unknown): Promise<unknown> {
    this.descriptorCalls.push(input);
    return this.descriptorResult;
  }
  async shutdown(): Promise<void> {}
}

class FakeAutomationBoundaryWithoutHandler
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

function makeRequest(payload: unknown): DaemonWorkRequest {
  return DaemonRequestSchema.parse({
    protocolVersion: 5,
    requestId,
    type: "automation.host-review.describe",
    payload
  }) as DaemonWorkRequest;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("automation host review descriptor transport", () => {
  it("forwards exact ids to automation boundary and returns parsed descriptor", async () => {
    const boundary = new FakeAutomationBoundary();
    const descriptor = createValidDescriptor();
    boundary.descriptorResult = descriptor;
    const dispatcher = createTestDispatcher(boundary);

    const result = await dispatcher.dispatch(
      makeRequest({ runId, nodeId, attemptId }),
      signal()
    );

    expect(boundary.descriptorCalls).toEqual([{ runId, nodeId, attemptId }]);
    expect(boundary.startCalls).toHaveLength(0);
    expect(boundary.actionCalls).toHaveLength(0);
    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
    expect(result).toEqual(descriptor);
  });

  it("rejects invalid request payload via request schema", () => {
    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-review.describe",
        payload: { runId, nodeId }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-review.describe",
        payload: { runId: "not-a-uuid", nodeId, attemptId }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-review.describe",
        payload: { runId, nodeId, attemptId, extra: "invalid" }
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 5,
        requestId,
        type: "automation.host-review.describe",
        payload: {}
      }).success
    ).toBe(false);

    expect(
      DaemonRequestSchema.safeParse({
        protocolVersion: 4,
        requestId,
        type: "automation.host-review.describe",
        payload: { runId, nodeId, attemptId }
      }).success
    ).toBe(false);
  });

  it("rejects malformed descriptor result via output schema", async () => {
    const boundary = new FakeAutomationBoundary();
    boundary.descriptorResult = {
      schemaVersion: 2,
      runId,
      nodeId
    };
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeRequest({ runId, nodeId, attemptId }),
        signal()
      )
    ).rejects.toThrow();

    const valid = createValidDescriptor();
    boundary.descriptorResult = {
      ...valid,
      unauthorizedOutput: "rogue completion"
    };

    await expect(
      dispatcher.dispatch(
        makeRequest({ runId, nodeId, attemptId }),
        signal()
      )
    ).rejects.toThrow();

    expect(dispatcher.runtimeManager.chatCalls).toHaveLength(0);
  });

  it("rejects clearly when boundary lacks getPendingHostReviewDescriptor without fallback", async () => {
    const boundary = new FakeAutomationBoundaryWithoutHandler();
    const dispatcher = createTestDispatcher(boundary);

    await expect(
      dispatcher.dispatch(
        makeRequest({ runId, nodeId, attemptId }),
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
});
