/**
 * Downstream test fixtures synthesize completed upstream states and awaiting-review
 * child steps to validate that AutomationRuntime correctly inspects and enforces
 * integrity across saved repository state (including leases, step states, dependency
 * outputs, and snapshot invariants). These tests validate saved-state reading and
 * invariant enforcement; they are not an end-to-end proof of Host execution.
 */
import {
  AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION,
  AutomationHostReviewDescriptorSchema,
  type AutomationAgentSaveInput,
  type AutomationNode,
  type AutomationReviewBoundWorkflowInput,
  type AutomationWorkspaceSnapshot,
  type LocalChatRequest
} from "@cadrane/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AutomationRuntime,
  type AutomationChatBoundary,
  type AutomationRepository
} from "./automation-runtime.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const ROOT_NODE_ID = "33333333-3333-4333-8333-333333333333";
const CHILD_NODE_ID = "44444444-4444-4444-8444-444444444444";
const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TURN_ID_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TURN_ID_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TEST_NOW_ISO = "2026-08-12T00:00:00.000Z";

function createTestRuntime(
  repository: AutomationRepository,
  chat: AutomationChatBoundary,
  now: () => Date = () => new Date(TEST_NOW_ISO)
): AutomationRuntime {
  return new AutomationRuntime({
    dataDirectory: "/tmp/cadrane-test",
    repository,
    runtime: chat,
    now,
    enableScheduleTimer: false
  });
}

describe("daemon host review descriptor slice", () => {
  it("generates an exact bounded descriptor for a root awaiting-review node without model dispatch", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    expect(started.state).toBe("waiting");
    expect(started.activeNodeId).toBe(ROOT_NODE_ID);

    const step = started.steps[0]!;
    expect(step.state).toBe("awaiting-review");
    expect("attemptId" in step).toBe(true);
    const attemptId = (step as { attemptId: string }).attemptId;

    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId
    });

    expect(descriptor.schemaVersion).toBe(AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION);
    expect(descriptor.runId).toBe(started.id);
    expect(descriptor.nodeId).toBe(ROOT_NODE_ID);
    expect(descriptor.attemptId).toBe(attemptId);
    expect(descriptor.caseId).toBe(CASE_ID);
    expect(descriptor.sourceTurnIds).toEqual([TURN_ID_1, TURN_ID_2]);
    expect(descriptor.instruction).toBe("Synthesize the case facts.");
    expect(descriptor.systemPrompt).toBe("Work systematically.");
    expect(descriptor.contextPolicy).toEqual({
      sourceTurnIds: [TURN_ID_1, TURN_ID_2],
      includeSystemPrompt: true,
      includeInstruction: true,
      includeDependencyOutputs: true,
      allowGlobalMemory: false,
      allowApprovedExamples: false
    });
    expect(descriptor.context).toBe("");
    expect(descriptor.dependencyOutputs).toEqual([]);
    expect(descriptor.runtimeId).toBe("ollama");
    expect(descriptor.modelId).toBe("qwen-test");
    expect(descriptor.temperature).toBe(0.2);
    expect(descriptor.maxTokens).toBe(256);
    expect(descriptor.workflowId).toBe(WORKFLOW_ID);
    expect(descriptor.workflowRevision).toBe(1);
    expect(descriptor.agentId).toBe(AGENT_ID);
    expect(descriptor.agentRevision).toBe(1);
    expect(descriptor.workflowSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(descriptor.agentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(descriptor.provenance.nodeTitle).toBe("Node 3333");
    expect(descriptor.provenance.attempt).toBe(1);

    expect(AutomationHostReviewDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(chat.dispatchedCount).toBe(0);
  });

  it("includes ordered dependency outputs with sha256 hashes and graph context for downstream nodes", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID], { title: "Follow-up", instruction: "Evaluate root output." })
      ]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const snap = await runtime.snapshot();
    const targetRun = snap.runs.find((r) => r.id === started.id)!;

    const rootStep = targetRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    rootStep.state = "completed";
    rootStep.output = "First step completed output.";
    rootStep.finishedAt = TEST_NOW_ISO;

    const childStep = targetRun.steps.find((s) => s.nodeId === CHILD_NODE_ID)! as {
      state: string;
      attempt: number;
      attemptId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      operationId: string | null;
    };
    const childAttemptId = "55555555-5555-4555-8555-555555555555";
    childStep.state = "awaiting-review";
    childStep.attempt = 1;
    childStep.attemptId = childAttemptId;
    childStep.startedAt = TEST_NOW_ISO;
    childStep.finishedAt = null;
    childStep.operationId = null;

    targetRun.activeNodeId = CHILD_NODE_ID;
    targetRun.state = "waiting";
    targetRun.updatedAt = TEST_NOW_ISO;

    await repository.save(snap);

    const reopenedRuntime = createTestRuntime(repository, chat);
    const descriptor = await reopenedRuntime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: CHILD_NODE_ID,
      attemptId: childAttemptId
    });

    expect(descriptor.nodeId).toBe(CHILD_NODE_ID);
    expect(descriptor.dependencyOutputs).toHaveLength(1);
    const expectedSha256 = createHash("sha256").update("First step completed output.", "utf8").digest("hex");
    expect(descriptor.dependencyOutputs[0]).toEqual({
      nodeId: ROOT_NODE_ID,
      title: "Node 3333",
      output: "First step completed output.",
      outputSha256: expectedSha256
    });
    expect(descriptor.context).toBe("### Node 3333\nFirst step completed output.");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects stale IDs, missing steps, and mismatched attempts", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const realAttemptId = (started.steps[0] as { attemptId: string }).attemptId;

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: "99999999-9999-4999-8999-999999999999",
        nodeId: ROOT_NODE_ID,
        attemptId: realAttemptId
      })
    ).rejects.toThrow("Automation run not found.");

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: "99999999-9999-4999-8999-999999999999",
        attemptId: realAttemptId
      })
    ).rejects.toThrow("The specified node is not the active review node.");

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: "99999999-9999-4999-8999-999999999999"
      })
    ).rejects.toThrow("Automation attempt ID is stale or does not match.");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when the workflow or agent was modified after run start", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const realAttemptId = (started.steps[0] as { attemptId: string }).attemptId;

    // Mutate the agent
    await runtime.saveAgent({
      ...agentFixture(),
      name: "Researcher Modified"
    });

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: realAttemptId
      })
    ).rejects.toThrow("Automation agent has changed since the run was started.");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects closed or terminal runs", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const realAttemptId = (started.steps[0] as { attemptId: string }).attemptId;

    await runtime.action({ runId: started.id, action: "cancel" });

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: realAttemptId
      })
    ).rejects.toThrow("Automation run is closed or not awaiting review.");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects missing dependency output and overflow rather than truncating", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID])
      ]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const snap = await runtime.snapshot();
    const targetRun = snap.runs.find((r) => r.id === started.id)!;

    const rootStep = targetRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    rootStep.state = "completed";
    rootStep.output = null;
    rootStep.finishedAt = TEST_NOW_ISO;

    const childStep = targetRun.steps.find((s) => s.nodeId === CHILD_NODE_ID)! as {
      state: string;
      attempt: number;
      attemptId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      operationId: string | null;
    };
    const childAttemptId = "55555555-5555-4555-8555-555555555555";
    childStep.state = "awaiting-review";
    childStep.attempt = 1;
    childStep.attemptId = childAttemptId;
    childStep.startedAt = TEST_NOW_ISO;
    childStep.finishedAt = null;
    childStep.operationId = null;
    targetRun.activeNodeId = CHILD_NODE_ID;
    targetRun.state = "waiting";
    targetRun.updatedAt = TEST_NOW_ISO;

    // 1. Missing output test
    await repository.save(snap);
    const missingRuntime = createTestRuntime(repository, chat);
    await expect(
      missingRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: CHILD_NODE_ID,
        attemptId: childAttemptId
      })
    ).rejects.toThrow("missing");

    // 2. Overflow test (> 8,000 characters)
    rootStep.output = "x".repeat(8_500);
    await repository.save(snap);
    const overflowRuntime = createTestRuntime(repository, chat);

    await expect(
      overflowRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: CHILD_NODE_ID,
        attemptId: childAttemptId
      })
    ).rejects.toThrow("maximum review size");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when workflow snapshot is missing", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (started.steps[0] as { attemptId: string }).attemptId;

    const snap = await runtime.snapshot();
    const run = snap.runs.find((r) => r.id === started.id)! as { workflowSnapshot?: unknown };
    delete run.workflowSnapshot;
    await repository.save(snap);

    const reopenedRuntime = createTestRuntime(repository, chat);
    await expect(
      reopenedRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow("missing required workflow snapshot");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when workflow budget or trigger is mutated after start", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (started.steps[0] as { attemptId: string }).attemptId;

    const snap = await runtime.snapshot();
    const wf = snap.workflows.find((w) => w.id === WORKFLOW_ID)!;
    wf.budget = {
      maxDurationMs: 120_000,
      maxNodeExecutions: 10,
      maxOutputCharacters: 30_000
    };
    await repository.save(snap);

    const budgetRuntime = createTestRuntime(repository, chat);
    await expect(
      budgetRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow("Automation workflow content has changed since the run was started.");

    wf.budget = {
      maxDurationMs: 60_000,
      maxNodeExecutions: 6,
      maxOutputCharacters: 20_000
    };
    wf.trigger = {
      kind: "interval",
      everyMinutes: 15,
      runOnceIfOverdue: true
    };
    await repository.save(snap);

    const triggerRuntime = createTestRuntime(repository, chat);
    await expect(
      triggerRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow("Automation workflow content has changed since the run was started.");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when agent systemPrompt is mutated without revision bump", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (started.steps[0] as { attemptId: string }).attemptId;

    const snap = await runtime.snapshot();
    const agent = snap.agents.find((a) => a.id === AGENT_ID)!;
    agent.systemPrompt = "Mutated system prompt secretly.";
    await repository.save(snap);

    const reopenedRuntime = createTestRuntime(repository, chat);
    await expect(
      reopenedRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow("Automation agent content has changed since the run was started.");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when run deadline has passed without mutating run state", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    let currentTime = new Date("2026-08-12T00:00:00.000Z");
    const runtime = createTestRuntime(repository, chat, () => currentTime);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (started.steps[0] as { attemptId: string }).attemptId;

    currentTime = new Date("2026-08-12T00:02:00.000Z");

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow("Automation run has exceeded its deadline.");

    const snap = await runtime.snapshot();
    const run = snap.runs.find((r) => r.id === started.id)!;
    expect(run.state).toBe("waiting");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when total composed system, instruction, and dependency context exceeds 8000 characters", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    const agent = agentFixture();
    agent.systemPrompt = "s".repeat(3_000);
    await runtime.saveAgent(agent);

    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID], {
          instruction: "i".repeat(3_000)
        })
      ]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const snap = await runtime.snapshot();
    const targetRun = snap.runs.find((r) => r.id === started.id)!;

    const rootStep = targetRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    rootStep.state = "completed";
    rootStep.output = "o".repeat(2_500);
    rootStep.finishedAt = TEST_NOW_ISO;

    const childStep = targetRun.steps.find((s) => s.nodeId === CHILD_NODE_ID)! as {
      state: string;
      attempt: number;
      attemptId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      operationId: string | null;
    };
    const childAttemptId = "66666666-6666-4666-8666-666666666666";
    childStep.state = "awaiting-review";
    childStep.attempt = 1;
    childStep.attemptId = childAttemptId;
    childStep.startedAt = TEST_NOW_ISO;
    childStep.finishedAt = null;
    childStep.operationId = null;
    targetRun.activeNodeId = CHILD_NODE_ID;
    targetRun.state = "waiting";
    targetRun.updatedAt = TEST_NOW_ISO;

    await repository.save(snap);

    const reopenedRuntime = createTestRuntime(repository, chat);
    await expect(
      reopenedRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: CHILD_NODE_ID,
        attemptId: childAttemptId
      })
    ).rejects.toThrow("maximum review size");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when run step instruction is tampered against workflow snapshot", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (started.steps[0] as { attemptId: string }).attemptId;

    const snap = await runtime.snapshot();
    const run = snap.runs.find((r) => r.id === started.id)!;
    run.steps[0]!.instruction = "Tampered instruction differing from snapshot.";
    await repository.save(snap);

    const reopenedRuntime = createTestRuntime(repository, chat);
    await expect(
      reopenedRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow(/instruction|snapshot/i);
    expect(chat.dispatchedCount).toBe(0);
  });

  it("rejects when run source binding is tampered against workflow snapshot", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));
    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (started.steps[0] as { attemptId: string }).attemptId;

    const snap = await runtime.snapshot();
    const run = snap.runs.find((r) => r.id === started.id)!;
    if (run.schemaVersion !== AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION)
      throw new Error("Expected a review-bound run fixture.");
    run.reviewBinding.sourceTurnIds = [TURN_ID_1];
    await repository.save(snap);

    const reopenedRuntime = createTestRuntime(repository, chat);
    await expect(
      reopenedRuntime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId
      })
    ).rejects.toThrow(/source|binding|snapshot/i);
    expect(chat.dispatchedCount).toBe(0);
  });
});

class MemoryRepository implements AutomationRepository {
  private snapshot: AutomationWorkspaceSnapshot = {
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

class GuardChatBoundary implements AutomationChatBoundary {
  dispatchedCount = 0;

  async chat(_request: LocalChatRequest): Promise<unknown> {
    this.dispatchedCount += 1;
    throw new Error("Chat dispatch forbidden during review preparation.");
  }

  cancel(_operationId: string): boolean {
    return true;
  }
}

function agentFixture(): AutomationAgentSaveInput {
  return {
    id: AGENT_ID,
    name: "Researcher",
    description: "Reviews case materials.",
    systemPrompt: "Work systematically.",
    runtimeId: "ollama",
    modelId: "qwen-test",
    routingMode: "fixed",
    fallbackRoutes: [],
    temperature: 0.2,
    maxTokens: 256
  };
}

function nodeFixture(
  id: string,
  dependsOn: string[],
  overrides: Partial<AutomationNode> = {}
): AutomationNode {
  return {
    id,
    title: `Node ${id.slice(0, 4)}`,
    instruction: "Synthesize the case facts.",
    kind: "model",
    agentId: AGENT_ID,
    connectorId: null,
    dependsOn,
    ...overrides
  };
}

function reviewBoundFixture(
  overrides: { nodes?: AutomationNode[] } = {}
): AutomationReviewBoundWorkflowInput {
  return {
    caseId: CASE_ID,
    sourceTurnIds: [TURN_ID_1, TURN_ID_2],
    workflow: {
      id: WORKFLOW_ID,
      name: "Case Analysis Flow",
      description: "Step-by-step case analysis.",
      enabled: true,
      trigger: { kind: "manual" },
      budget: {
        maxDurationMs: 60_000,
        maxNodeExecutions: 6,
        maxOutputCharacters: 20_000
      },
      nodes: overrides.nodes ?? [nodeFixture(ROOT_NODE_ID, [])]
    }
  };
}
