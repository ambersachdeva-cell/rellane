import {
  AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION,
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
const OPERATION_ID_1 = "aaaa1111-1111-4111-8111-111111111111";
const OPERATION_ID_2 = "bbbb2222-2222-4222-8222-222222222222";
const ANSWER_TURN_ID = "ffff3333-3333-4333-8333-333333333333";
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

describe("daemon host attempt reservation and terminal reconciliation", () => {
  it("durably reserves an awaiting-review attempt, binds operation, and advances successor on terminal completion without chat", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID], { title: "Follow-up Analysis", instruction: "Synthesize child facts." })
      ]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    expect(started.state).toBe("waiting");
    expect(started.activeNodeId).toBe(ROOT_NODE_ID);
    const rootStep = started.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(rootStep.state).toBe("awaiting-review");
    const rootAttemptId = (rootStep as { attemptId: string }).attemptId;

    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");

    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    expect(reserved.steps.find((s) => s.nodeId === ROOT_NODE_ID)!.state).toBe("host-reserved");
    expect(reserved.intent.descriptorSha256).toBe(descriptorSha256);
    expect(reserved.intent.correlation).toBeDefined();
    const correlation = reserved.intent.correlation;

    await expect(
      runtime.getPendingHostReviewDescriptor({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: rootAttemptId
      })
    ).rejects.toThrow("Automation step is not awaiting review.");

    const bound = await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1,
      correlation
    });
    expect(bound.steps.find((s) => s.nodeId === ROOT_NODE_ID)!.operationId).toBe(OPERATION_ID_1);
    expect(chat.dispatchedCount).toBe(0);

    const stepOutput = "Detailed initial case finding.";
    const outputSha256 = createHash("sha256").update(stepOutput, "utf8").digest("hex");

    const reconciled = await runtime.reconcileHostTerminal({
      correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output: stepOutput,
        outputSha256
      }
    });

    const reconciledRoot = reconciled.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(reconciledRoot.state).toBe("completed");
    expect(reconciledRoot.output).toBe(stepOutput);
    expect((reconciledRoot as { answerTurnId?: string | null }).answerTurnId).toBe(ANSWER_TURN_ID);

    const childStep = reconciled.steps.find((s) => s.nodeId === CHILD_NODE_ID)!;
    expect(childStep.state).toBe("awaiting-review");
    expect(childStep.attempt).toBe(1);
    expect((childStep as { attemptId: string }).attemptId).toBeDefined();
    expect((childStep as { attemptId: string }).attemptId).not.toBe(rootAttemptId);
    expect(reconciled.state).toBe("waiting");
    expect(reconciled.activeNodeId).toBe(CHILD_NODE_ID);
    expect(chat.dispatchedCount).toBe(0);

    const childDescriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: CHILD_NODE_ID,
      attemptId: (childStep as { attemptId: string }).attemptId
    });
    expect(childDescriptor.dependencyOutputs).toHaveLength(1);
    expect(childDescriptor.dependencyOutputs[0]!.output).toBe(stepOutput);
    expect(childDescriptor.context).toBe(`### Node 3333\n${stepOutput}`);
    expect(childDescriptor.sourceTurnIds).toEqual([TURN_ID_1, TURN_ID_2, ANSWER_TURN_ID]);
    expect(childDescriptor.contextPolicy.sourceTurnIds).toEqual([TURN_ID_1, TURN_ID_2, ANSWER_TURN_ID]);
  });

  it("reconciles crash-after-reserve-before-bind as interrupted and releases active lease", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");

    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    const reconciled = await runtime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "interrupted",
        answerTurnId: null,
        output: null,
        outputSha256: null
      }
    });

    expect(reconciled.state).toBe("interrupted");
    expect(reconciled.steps[0]!.state).toBe("interrupted");
    expect(reconciled.steps[0]!.operationId).toBe(OPERATION_ID_1);
    const snap = await runtime.snapshot();
    expect(snap.leases.find((l) => l.runId === started.id)!.state).toBe("released");
  });

  it("produces terminal receipt and releases lease when all nodes complete", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");

    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const output = "Final lone step result.";
    const outputSha256 = createHash("sha256").update(output, "utf8").digest("hex");

    const finished = await runtime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output,
        outputSha256
      }
    });

    expect(finished.state).toBe("completed");
    expect(finished.activeNodeId).toBeNull();
    expect(finished.receipts).toHaveLength(1);
    expect(finished.receipts[0]!.outcome).toBe("completed");

    const snap = await runtime.snapshot();
    const lease = snap.leases.find((l) => l.runId === started.id)!;
    expect(lease.state).toBe("released");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("refuses duplicate reservation and stale or mismatched descriptor hash", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const validSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
    const tamperedSha256 = "0".repeat(64);

    await expect(
      runtime.reserveHostAttempt({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: rootAttemptId,
        descriptorSha256: tamperedSha256
      })
    ).rejects.toThrow("Descriptor SHA256 mismatch or stale descriptor.");

    await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256: validSha256
    });

    await expect(
      runtime.reserveHostAttempt({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: rootAttemptId,
        descriptorSha256: validSha256
      })
    ).rejects.toThrow("already been reserved");
  });

  it("bindHostOperation enforces operation binding invariants", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;

    await expect(
      runtime.bindHostOperation({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: rootAttemptId,
        operationId: OPERATION_ID_1
      })
    ).rejects.toThrow("must be in host-reserved state");

    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
    await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    await expect(
      runtime.bindHostOperation({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: rootAttemptId,
        operationId: OPERATION_ID_1
      })
    ).rejects.toThrow("Duplicate operation binding is refused.");

    await expect(
      runtime.bindHostOperation({
        runId: started.id,
        nodeId: ROOT_NODE_ID,
        attemptId: rootAttemptId,
        operationId: OPERATION_ID_2
      })
    ).rejects.toThrow("Attempt is already bound to a different operation ID.");
  });

  it("reconcileHostTerminal enforces evidence integrity, hash matching, and bound operation requirements", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });
    const correlation = reserved.intent.correlation;

    await expect(
      runtime.reconcileHostTerminal({
        correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: "Valid output text.",
          outputSha256: createHash("sha256").update("Valid output text.", "utf8").digest("hex")
        }
      })
    ).rejects.toThrow("No operation ID has been bound");

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    await expect(
      runtime.reconcileHostTerminal({
        correlation,
        operationId: OPERATION_ID_2,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: "Valid output text.",
          outputSha256: createHash("sha256").update("Valid output text.", "utf8").digest("hex")
        }
      })
    ).rejects.toThrow("Bound operation ID mismatch.");

    await expect(
      runtime.reconcileHostTerminal({
        correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: "Valid output text.",
          outputSha256: "0".repeat(64)
        }
      })
    ).rejects.toThrow("Terminal output SHA256 mismatch.");

    await expect(
      runtime.reconcileHostTerminal({
        correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: null,
          output: "Valid output text.",
          outputSha256: createHash("sha256").update("Valid output text.", "utf8").digest("hex")
        }
      })
    ).rejects.toThrow("Completed terminal outcome requires a non-null answerTurnId.");
  });

  it("handles honest terminal failure, stop, and interruption without replay", async () => {
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
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const failedRun = await runtime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "failed",
        answerTurnId: null,
        output: null,
        outputSha256: null
      }
    });

    expect(failedRun.state).toBe("failed");
    expect(failedRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!.state).toBe("failed");
    expect(failedRun.steps.find((s) => s.nodeId === CHILD_NODE_ID)!.state).toBe("pending");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("cancelling before reservation prevents launch, and cancelling after reservation preserves correlation for Host Stop", async () => {
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

    const run1 = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId1 = (run1.steps[0] as { attemptId: string }).attemptId;
    await runtime.action({ runId: run1.id, action: "cancel" });

    await expect(
      runtime.reserveHostAttempt({
        runId: run1.id,
        nodeId: ROOT_NODE_ID,
        attemptId: attemptId1,
        descriptorSha256: "0".repeat(64)
      })
    ).rejects.toThrow("Automation run is closed or cancelled.");

    const run2 = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId2 = (run2.steps[0] as { attemptId: string }).attemptId;
    const desc2 = await runtime.getPendingHostReviewDescriptor({
      runId: run2.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId2
    });
    const sha2 = createHash("sha256").update(JSON.stringify(desc2), "utf8").digest("hex");
    const reserved2 = await runtime.reserveHostAttempt({
      runId: run2.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId2,
      descriptorSha256: sha2
    });

    await runtime.bindHostOperation({
      runId: run2.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId2,
      operationId: OPERATION_ID_1
    });

    await runtime.action({ runId: run2.id, action: "cancel" });
    expect(chat.cancelCalls).toHaveLength(0);

    const cancelledSnap = await runtime.snapshot();
    const cancelledRun = cancelledSnap.runs.find((r) => r.id === run2.id)!;
    if (cancelledRun.schemaVersion !== AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION) {
      throw new Error("Expected a review-bound run.");
    }
    const cancelledStep = cancelledRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(cancelledStep.operationId).toBe(OPERATION_ID_1);
    expect(cancelledStep.intent?.correlation).toBe(reserved2.intent.correlation);

    const reconciledStop = await runtime.reconcileHostTerminal({
      correlation: reserved2.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "stopped",
        answerTurnId: null,
        output: null,
        outputSha256: null
      }
    });

    expect(reconciledStop.state).toBe("cancelled");
    expect(reconciledStop.steps.find((s) => s.nodeId === CHILD_NODE_ID)!.state).toBe("cancelled");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("preserves attemptId, intent, and operationId on daemon restart and marks unproven dispatch interrupted", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const desc = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const sha = createHash("sha256").update(JSON.stringify(desc), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256: sha
    });

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const restartedRuntime = createTestRuntime(repository, chat);
    const snap = await restartedRuntime.snapshot();
    const interruptedRun = snap.runs.find((r) => r.id === started.id)!;
    if (interruptedRun.schemaVersion !== AUTOMATION_REVIEW_BOUND_SCHEMA_VERSION) {
      throw new Error("Expected a review-bound run.");
    }

    expect(interruptedRun.state).toBe("interrupted");
    const interruptedStep = interruptedRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(interruptedStep.state).toBe("interrupted");
    expect(interruptedStep.attemptId).toBe(rootAttemptId);
    expect(interruptedStep.intent?.correlation).toBe(reserved.intent.correlation);
    expect(interruptedStep.operationId).toBe(OPERATION_ID_1);

    await expect(
      restartedRuntime.action({ runId: started.id, action: "resume" })
    ).rejects.toThrow("Review-bound runs cannot resume");

    await expect(
      restartedRuntime.action({ runId: started.id, action: "retry" })
    ).rejects.toThrow("Review-bound attempts cannot retry");

    expect(chat.dispatchedCount).toBe(0);
  });

  it("refuses duplicate terminal reconciliation on already completed step and preserves state", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID], { title: "Follow-up Analysis", instruction: "Synthesize child facts." })
      ]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps.find((s) => s.nodeId === ROOT_NODE_ID)! as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const stepOutput = "Detailed initial case finding.";
    const outputSha256 = createHash("sha256").update(stepOutput, "utf8").digest("hex");

    const reconciled = await runtime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output: stepOutput,
        outputSha256
      }
    });

    expect(reconciled.state).toBe("waiting");
    expect(reconciled.activeNodeId).toBe(CHILD_NODE_ID);
    const childStep = reconciled.steps.find((s) => s.nodeId === CHILD_NODE_ID)!;
    expect(childStep.state).toBe("awaiting-review");
    const childAttemptId = (childStep as { attemptId: string }).attemptId;

    await expect(
      runtime.reconcileHostTerminal({
        correlation: reserved.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: stepOutput,
          outputSha256
        }
      })
    ).rejects.toThrow("Duplicate terminal reconciliation is refused.");

    const snap = await runtime.snapshot();
    const preservedRun = snap.runs.find((r) => r.id === started.id)!;
    expect(preservedRun.state).toBe("waiting");
    expect(preservedRun.activeNodeId).toBe(CHILD_NODE_ID);
    const rootAfter = preservedRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(rootAfter.state).toBe("completed");
    expect(rootAfter.output).toBe(stepOutput);
    const childAfter = preservedRun.steps.find((s) => s.nodeId === CHILD_NODE_ID)!;
    expect(childAfter.state).toBe("awaiting-review");
    expect((childAfter as { attemptId: string }).attemptId).toBe(childAttemptId);
    expect(childAfter.attempt).toBe(1);
    expect(preservedRun.receipts).toHaveLength(0);
    expect(chat.dispatchedCount).toBe(0);
  });

  it("refuses duplicate terminal reconciliation on final completing step and preserves single receipt", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const descriptor = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const descriptorSha256 = createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256
    });

    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const output = "Final lone step result.";
    const outputSha256 = createHash("sha256").update(output, "utf8").digest("hex");

    const finished = await runtime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output,
        outputSha256
      }
    });

    expect(finished.state).toBe("completed");
    expect(finished.receipts).toHaveLength(1);

    await expect(
      runtime.reconcileHostTerminal({
        correlation: reserved.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output,
          outputSha256
        }
      })
    ).rejects.toThrow("Duplicate terminal reconciliation is refused.");

    const snap = await runtime.snapshot();
    const preservedRun = snap.runs.find((r) => r.id === started.id)!;
    expect(preservedRun.state).toBe("completed");
    expect(preservedRun.receipts).toHaveLength(1);
    expect(chat.dispatchedCount).toBe(0);
  });

  it("refuses duplicate terminal reconciliation on failed, stopped, and interrupted terminal states", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    // Case 1: Failed terminal outcome duplicate
    const run1 = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId1 = (run1.steps[0] as { attemptId: string }).attemptId;
    const desc1 = await runtime.getPendingHostReviewDescriptor({
      runId: run1.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId1
    });
    const reserved1 = await runtime.reserveHostAttempt({
      runId: run1.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId1,
      descriptorSha256: createHash("sha256").update(JSON.stringify(desc1), "utf8").digest("hex")
    });
    await runtime.bindHostOperation({
      runId: run1.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId1,
      operationId: OPERATION_ID_1
    });

    await runtime.reconcileHostTerminal({
      correlation: reserved1.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "failed",
        answerTurnId: null,
        output: null,
        outputSha256: null
      }
    });

    await expect(
      runtime.reconcileHostTerminal({
        correlation: reserved1.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "failed",
          answerTurnId: null,
          output: null,
          outputSha256: null
        }
      })
    ).rejects.toThrow("Duplicate terminal reconciliation is refused.");

    // Case 2: Stopped after cancel duplicate
    const run2 = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId2 = (run2.steps[0] as { attemptId: string }).attemptId;
    const desc2 = await runtime.getPendingHostReviewDescriptor({
      runId: run2.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId2
    });
    const reserved2 = await runtime.reserveHostAttempt({
      runId: run2.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId2,
      descriptorSha256: createHash("sha256").update(JSON.stringify(desc2), "utf8").digest("hex")
    });
    await runtime.bindHostOperation({
      runId: run2.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId2,
      operationId: OPERATION_ID_2
    });
    await runtime.action({ runId: run2.id, action: "cancel" });

    await runtime.reconcileHostTerminal({
      correlation: reserved2.intent.correlation,
      operationId: OPERATION_ID_2,
      terminalEvidence: {
        status: "stopped",
        answerTurnId: null,
        output: null,
        outputSha256: null
      }
    });

    await expect(
      runtime.reconcileHostTerminal({
        correlation: reserved2.intent.correlation,
        operationId: OPERATION_ID_2,
        terminalEvidence: {
          status: "stopped",
          answerTurnId: null,
          output: null,
          outputSha256: null
        }
      })
    ).rejects.toThrow("Duplicate terminal reconciliation is refused.");

    // Case 3: Already reconciled interrupted outcome duplicate is refused
    const repository3 = new MemoryRepository();
    const runtime3 = createTestRuntime(repository3, chat);
    await runtime3.saveAgent(agentFixture());
    await runtime3.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const run3 = await runtime3.start({ workflowId: WORKFLOW_ID });
    const attemptId3 = (run3.steps[0] as { attemptId: string }).attemptId;
    const desc3 = await runtime3.getPendingHostReviewDescriptor({
      runId: run3.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId3
    });
    const reserved3 = await runtime3.reserveHostAttempt({
      runId: run3.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId3,
      descriptorSha256: createHash("sha256").update(JSON.stringify(desc3), "utf8").digest("hex")
    });
    await runtime3.bindHostOperation({
      runId: run3.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptId3,
      operationId: OPERATION_ID_1
    });

    const reconciledInterrupted = await runtime3.reconcileHostTerminal({
      correlation: reserved3.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "interrupted",
        answerTurnId: null,
        output: null,
        outputSha256: null
      }
    });

    const hostInterruptedStep = reconciledInterrupted.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(hostInterruptedStep.state).toBe("interrupted");
    expect(hostInterruptedStep.error).toBe("Host execution was interrupted.");

    await expect(
      runtime3.reconcileHostTerminal({
        correlation: reserved3.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "interrupted",
          answerTurnId: null,
          output: null,
          outputSha256: null
        }
      })
    ).rejects.toThrow("Duplicate terminal reconciliation is refused.");

    expect(chat.dispatchedCount).toBe(0);
  });

  it("reconciles matching completed terminal after unproven restart interruption and refuses duplicate", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const run = await runtime.start({ workflowId: WORKFLOW_ID });
    const attemptId = (run.steps[0] as { attemptId: string }).attemptId;
    const desc = await runtime.getPendingHostReviewDescriptor({
      runId: run.id,
      nodeId: ROOT_NODE_ID,
      attemptId
    });
    const reserved = await runtime.reserveHostAttempt({
      runId: run.id,
      nodeId: ROOT_NODE_ID,
      attemptId,
      descriptorSha256: createHash("sha256").update(JSON.stringify(desc), "utf8").digest("hex")
    });
    await runtime.bindHostOperation({
      runId: run.id,
      nodeId: ROOT_NODE_ID,
      attemptId,
      operationId: OPERATION_ID_1
    });

    // Daemon restarts while attempt was in flight: marked interrupted as unproven dispatch
    const restartedRuntime = createTestRuntime(repository, chat);
    const snap = await restartedRuntime.snapshot();
    const interruptedRun = snap.runs.find((r) => r.id === run.id)!;
    expect(interruptedRun.state).toBe("interrupted");
    const interruptedStep = interruptedRun.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(interruptedStep.state).toBe("interrupted");
    expect(interruptedStep.error).toBe("Unproven Host dispatch was interrupted by restart.");

    // Matching authoritative completed terminal from Host bridge reconciles exactly once without launching another Host operation
    const postRestartOutput = "Authoritative completed outcome delivered after restart.";
    const postRestartSha256 = createHash("sha256").update(postRestartOutput, "utf8").digest("hex");
    const reconciledAfterRestart = await restartedRuntime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output: postRestartOutput,
        outputSha256: postRestartSha256
      }
    });

    const reconciledStep = reconciledAfterRestart.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(reconciledStep.state).toBe("completed");
    expect(reconciledStep.output).toBe(postRestartOutput);
    expect(reconciledStep.error).toBeNull();
    expect(chat.dispatchedCount).toBe(0);

    // Duplicate terminal reconciliation post-restart is refused
    await expect(
      restartedRuntime.reconcileHostTerminal({
        correlation: reserved.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: postRestartOutput,
          outputSha256: postRestartSha256
        }
      })
    ).rejects.toThrow("Duplicate terminal reconciliation is refused.");

    expect(chat.dispatchedCount).toBe(0);
  });

  it("completed single node after restart completes with one terminal receipt and released lease", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const desc = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const sha = createHash("sha256").update(JSON.stringify(desc), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256: sha
    });
    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const restartedRuntime = createTestRuntime(repository, chat);
    const snapBefore = await restartedRuntime.snapshot();
    const interruptedRun = snapBefore.runs.find((r) => r.id === started.id)!;
    expect(interruptedRun.state).toBe("interrupted");
    expect(interruptedRun.receipts).toHaveLength(0);

    const output = "Final lone node output after restart.";
    const outputSha256 = createHash("sha256").update(output, "utf8").digest("hex");
    const reconciled = await restartedRuntime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output,
        outputSha256
      }
    });

    expect(reconciled.state).toBe("completed");
    expect(reconciled.error).toBeNull();
    expect(reconciled.activeNodeId).toBeNull();
    expect(reconciled.receipts).toHaveLength(1);
    expect(reconciled.receipts[0]!.outcome).toBe("completed");

    const snapAfter = await restartedRuntime.snapshot();
    const lease = snapAfter.leases.find((l) => l.runId === started.id)!;
    expect(lease.state).toBe("released");
    expect(chat.dispatchedCount).toBe(0);
  });

  it("completed root advances successor to awaiting-review and waiting state after restart", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID], { title: "Follow-up Node", instruction: "Child work." })
      ]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const desc = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const sha = createHash("sha256").update(JSON.stringify(desc), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256: sha
    });
    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const restartedRuntime = createTestRuntime(repository, chat);
    const rootOutput = "Root findings completed by host.";
    const rootOutputSha256 = createHash("sha256").update(rootOutput, "utf8").digest("hex");

    const reconciled = await restartedRuntime.reconcileHostTerminal({
      correlation: reserved.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output: rootOutput,
        outputSha256: rootOutputSha256
      }
    });

    expect(reconciled.state).toBe("waiting");
    expect(reconciled.error).toBeNull();
    expect(reconciled.activeNodeId).toBe(CHILD_NODE_ID);
    expect(reconciled.receipts).toHaveLength(0);

    const rootStep = reconciled.steps.find((s) => s.nodeId === ROOT_NODE_ID)!;
    expect(rootStep.state).toBe("completed");
    expect(rootStep.output).toBe(rootOutput);

    const childStep = reconciled.steps.find((s) => s.nodeId === CHILD_NODE_ID)!;
    expect(childStep.state).toBe("awaiting-review");
    expect(childStep.attempt).toBe(1);
    expect((childStep as { attemptId: string }).attemptId).toBeDefined();
    expect((childStep as { attemptId: string }).attemptId).not.toBe(rootAttemptId);

    const snap = await restartedRuntime.snapshot();
    const lease = snap.leases.find((l) => l.runId === started.id)!;
    expect(lease.state).toBe("active");

    const childDesc = await restartedRuntime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: CHILD_NODE_ID,
      attemptId: (childStep as { attemptId: string }).attemptId
    });
    expect(childDesc.dependencyOutputs).toHaveLength(1);
    expect(childDesc.dependencyOutputs[0]!.output).toBe(rootOutput);
    expect(childDesc.context).toBe(`### Node 3333\n${rootOutput}`);
    expect(chat.dispatchedCount).toBe(0);
  });

  it("refuses terminal reconciliation after restart when active lease is missing", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    const runtime = createTestRuntime(repository, chat);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const desc = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const sha = createHash("sha256").update(JSON.stringify(desc), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256: sha
    });
    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    const restartedRuntime = createTestRuntime(repository, chat);
    const snap = await restartedRuntime.snapshot();
    const lease = snap.leases.find((l) => l.runId === started.id && l.state === "active")!;
    lease.state = "released";
    await repository.save(snap);

    const freshRuntime = createTestRuntime(repository, chat);

    const validOutput = "Terminal output without lease.";
    const validSha256 = createHash("sha256").update(validOutput, "utf8").digest("hex");

    await expect(
      freshRuntime.reconcileHostTerminal({
        correlation: reserved.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: validOutput,
          outputSha256: validSha256
        }
      })
    ).rejects.toThrow("Active automation lease is required.");
  });

  it("refuses terminal reconciliation after restart when deadline has been exceeded", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();
    let currentTime = new Date(TEST_NOW_ISO).getTime();
    const nowFn = () => new Date(currentTime);
    const runtime = createTestRuntime(repository, chat, nowFn);

    await runtime.saveAgent(agentFixture());
    await runtime.saveReviewBoundWorkflow(reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    }));

    const started = await runtime.start({ workflowId: WORKFLOW_ID });
    const rootAttemptId = (started.steps[0] as { attemptId: string }).attemptId;
    const desc = await runtime.getPendingHostReviewDescriptor({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId
    });
    const sha = createHash("sha256").update(JSON.stringify(desc), "utf8").digest("hex");
    const reserved = await runtime.reserveHostAttempt({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      descriptorSha256: sha
    });
    await runtime.bindHostOperation({
      runId: started.id,
      nodeId: ROOT_NODE_ID,
      attemptId: rootAttemptId,
      operationId: OPERATION_ID_1
    });

    // Advance clock past deadline
    currentTime = Date.parse(started.deadlineAt) + 1_000;
    const restartedRuntime = createTestRuntime(repository, chat, nowFn);

    const validOutput = "Completed outcome after deadline.";
    const validSha256 = createHash("sha256").update(validOutput, "utf8").digest("hex");

    await expect(
      restartedRuntime.reconcileHostTerminal({
        correlation: reserved.intent.correlation,
        operationId: OPERATION_ID_1,
        terminalEvidence: {
          status: "completed",
          answerTurnId: ANSWER_TURN_ID,
          output: validOutput,
          outputSha256: validSha256
        }
      })
    ).rejects.toThrow("Automation run has exceeded its deadline.");
  });

  it("fails run on terminal completion after restart when output budget or attempt budget is exceeded", async () => {
    const repository = new MemoryRepository();
    const chat = new GuardChatBoundary();

    // Subcase A: Output budget exceeded
    const runtimeA = createTestRuntime(repository, chat);
    await runtimeA.saveAgent(agentFixture());
    const fixtureA = reviewBoundFixture({
      nodes: [nodeFixture(ROOT_NODE_ID, [])]
    });
    fixtureA.workflow.budget.maxOutputCharacters = 1000;
    await runtimeA.saveReviewBoundWorkflow(fixtureA);

    const runA = await runtimeA.start({ workflowId: WORKFLOW_ID });
    const attemptIdA = (runA.steps[0] as { attemptId: string }).attemptId;
    const descA = await runtimeA.getPendingHostReviewDescriptor({
      runId: runA.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptIdA
    });
    const shaA = createHash("sha256").update(JSON.stringify(descA), "utf8").digest("hex");
    const reservedA = await runtimeA.reserveHostAttempt({
      runId: runA.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptIdA,
      descriptorSha256: shaA
    });
    await runtimeA.bindHostOperation({
      runId: runA.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptIdA,
      operationId: OPERATION_ID_1
    });

    const restartedRuntimeA = createTestRuntime(repository, chat);
    const oversizedOutput = "A".repeat(1001);
    const oversizedSha256 = createHash("sha256").update(oversizedOutput, "utf8").digest("hex");

    const failedOutputRun = await restartedRuntimeA.reconcileHostTerminal({
      correlation: reservedA.intent.correlation,
      operationId: OPERATION_ID_1,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output: oversizedOutput,
        outputSha256: oversizedSha256
      }
    });

    expect(failedOutputRun.state).toBe("failed");
    expect(failedOutputRun.error).toBe("The automation exceeded its output budget.");
    expect(failedOutputRun.receipts).toHaveLength(1);
    expect(failedOutputRun.receipts[0]!.outcome).toBe("failed");

    const snapA = await restartedRuntimeA.snapshot();
    const leaseA = snapA.leases.find((l) => l.runId === runA.id)!;
    expect(leaseA.state).toBe("released");

    // Subcase B: Node execution attempt budget exceeded
    const repositoryB = new MemoryRepository();
    const runtimeB = createTestRuntime(repositoryB, chat);
    await runtimeB.saveAgent(agentFixture());
    const fixtureB = reviewBoundFixture({
      nodes: [
        nodeFixture(ROOT_NODE_ID, []),
        nodeFixture(CHILD_NODE_ID, [ROOT_NODE_ID])
      ]
    });
    fixtureB.workflow.budget.maxNodeExecutions = 1;
    await runtimeB.saveReviewBoundWorkflow(fixtureB);

    const runB = await runtimeB.start({ workflowId: WORKFLOW_ID });
    const attemptIdB = (runB.steps[0] as { attemptId: string }).attemptId;
    const descB = await runtimeB.getPendingHostReviewDescriptor({
      runId: runB.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptIdB
    });
    const shaB = createHash("sha256").update(JSON.stringify(descB), "utf8").digest("hex");
    const reservedB = await runtimeB.reserveHostAttempt({
      runId: runB.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptIdB,
      descriptorSha256: shaB
    });
    await runtimeB.bindHostOperation({
      runId: runB.id,
      nodeId: ROOT_NODE_ID,
      attemptId: attemptIdB,
      operationId: OPERATION_ID_2
    });

    const restartedRuntimeB = createTestRuntime(repositoryB, chat);
    const validOutputB = "Valid root result.";
    const validSha256B = createHash("sha256").update(validOutputB, "utf8").digest("hex");

    const failedAttemptRun = await restartedRuntimeB.reconcileHostTerminal({
      correlation: reservedB.intent.correlation,
      operationId: OPERATION_ID_2,
      terminalEvidence: {
        status: "completed",
        answerTurnId: ANSWER_TURN_ID,
        output: validOutputB,
        outputSha256: validSha256B
      }
    });

    expect(failedAttemptRun.state).toBe("failed");
    expect(failedAttemptRun.error).toBe("The automation exceeded its node execution budget.");
    expect(failedAttemptRun.receipts).toHaveLength(1);
    expect(failedAttemptRun.receipts[0]!.outcome).toBe("failed");

    const snapB = await restartedRuntimeB.snapshot();
    const leaseB = snapB.leases.find((l) => l.runId === runB.id)!;
    expect(leaseB.state).toBe("released");
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
  cancelCalls: string[] = [];

  async chat(_request: LocalChatRequest): Promise<unknown> {
    this.dispatchedCount += 1;
    throw new Error("Chat dispatch forbidden during review-bound preparation.");
  }

  cancel(operationId: string): boolean {
    this.cancelCalls.push(operationId);
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
