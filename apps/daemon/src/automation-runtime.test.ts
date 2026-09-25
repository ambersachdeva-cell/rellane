import {
  AUTOMATION_SCHEMA_VERSION,
  AutomationWorkflowSaveInputSchema,
  type AutomationAgentSaveInput,
  type AutomationNode,
  type AutomationRunSnapshot,
  type AutomationWorkflowSaveInput,
  type AutomationWorkspaceSnapshot,
  type LocalChatRequest,
  type LocalChatResult
} from "@cadrane/contracts";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AutomationRuntime,
  EncryptedFileAutomationRepository,
  type AutomationChatBoundary,
  type AutomationRepository
} from "./automation-runtime.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_ID = "55555555-5555-4555-8555-555555555555";
const FOURTH_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = "99999999-9999-4999-8999-999999999999";
const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_RULE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TURN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("automation runtime product journeys", () => {
  it("validates a fan-out DAG and rejects duplicate, missing and cyclic dependencies", () => {
    expect(() => AutomationWorkflowSaveInputSchema.parse(workflow({
      nodes: [
        node(FIRST_ID, []),
        node(SECOND_ID, [FIRST_ID]),
        node(THIRD_ID, [FIRST_ID])
      ]
    }))).not.toThrow();
    expect(() => AutomationWorkflowSaveInputSchema.parse(workflow({
      nodes: [node(FIRST_ID, []), node(FIRST_ID, [])]
    }))).toThrow("unique");
    expect(() => AutomationWorkflowSaveInputSchema.parse(workflow({
      nodes: [node(FIRST_ID, [SECOND_ID])]
    }))).toThrow("reference");
    expect(() => AutomationWorkflowSaveInputSchema.parse(workflow({
      nodes: [node(FIRST_ID, [SECOND_ID]), node(SECOND_ID, [FIRST_ID])]
    }))).toThrow("acyclic");
  });

  it("completes the customer journey from local context through reviewed artifact and connector delivery", async () => {
    const repository = new MemoryRepository();
    const runtime = new FakeChatRuntime([
      Promise.resolve(resultFor("# Rellane launch brief\nShip the useful workflow first."))
    ]);
    const automations = createRuntime(repository, runtime);
    await automations.saveAgent(agent());
    await automations.saveMemory({
      id: MEMORY_ID,
      title: "Shipping rule",
      content: "Prioritize a usable customer workflow over large speculative test matrices.",
      tags: ["shipping", "product"]
    });
    await automations.saveMemory({
      id: OWNER_RULE_ID,
      title: "Owner operating rule",
      content: "Lead with the recommendation and never confuse activity with customer value.",
      tags: ["owner-rule", "standing-instruction"]
    });
    await automations.saveSource({
      id: SOURCE_ID,
      title: "launch-notes.md",
      mediaType: "text/markdown",
      content: "Rellane launch evidence: automations should create reviewed artifacts and deliver them through approved connectors."
    });
    const connector = await automations.ensureLocalConnector({ name: "Connected Inbox" });
    await automations.saveWorkflow(workflow({
      budget: { maxDurationMs: 60_000, maxNodeExecutions: 8, maxOutputCharacters: 30_000 },
      nodes: [
        node(FIRST_ID, [], { kind: "memory.search", instruction: "Find the shipping product rule" }),
        node(SECOND_ID, [FIRST_ID], { kind: "model", instruction: "Create a Rellane launch brief from the shipping rule and launch evidence" }),
        node(THIRD_ID, [SECOND_ID], { kind: "artifact.write", instruction: "Save the launch brief" }),
        node(FOURTH_ID, [SECOND_ID], { kind: "connector.send", instruction: "Deliver the launch brief", connectorId: connector.id })
      ]
    }));

    const started = await automations.start({ workflowId: WORKFLOW_ID });
    let waiting = await waitForRun(automations, started.id, "waiting");
    const artifactApproval = await pendingRequest(automations, started.id, "artifact.write");
    await automations.action({ runId: started.id, action: "approve-tool", requestId: artifactApproval.id });
    waiting = await waitForRun(automations, started.id, "waiting");
    const connectorApproval = await pendingRequest(automations, started.id, "connector.send");
    await automations.action({ runId: started.id, action: "approve-tool", requestId: connectorApproval.id });
    const completed = await waitForRun(automations, started.id, "completed");
    const snapshot = await automations.snapshot();
    const artifact = snapshot.artifacts[0]!;
    await automations.reviewArtifact({ artifactId: artifact.id, action: "request-changes", note: "Lead with the actual product outcome." });
    const learned = await automations.snapshot();
    const revised = await automations.reviewArtifact({ artifactId: artifact.id, action: "revise", content: `${artifact.content}\n\n## Outcome\nThe workflow is usable.`, note: "Outcome added." });
    const accepted = await automations.reviewArtifact({ artifactId: artifact.id, action: "accept", note: "Ready to ship." });

    expect(runtime.requests[0]?.messages[1]?.content).toContain("Prioritize a usable customer workflow");
    expect(runtime.requests[0]?.messages[1]?.content).toContain("never confuse activity with customer value");
    expect(runtime.requests[0]?.messages[1]?.content).toContain("[S1] launch-notes.md");
    expect(completed.steps.map((step) => step.state)).toEqual(["completed", "completed", "completed", "completed"]);
    expect(completed.receipts.at(-1)).toMatchObject({
      outcome: "completed",
      completedNodeIds: [FIRST_ID, SECOND_ID, THIRD_ID, FOURTH_ID],
      configuredTokenCap: 256
    });
    expect(artifact.citations).toHaveLength(1);
    expect(snapshot.deliveries).toHaveLength(1);
    expect(snapshot.outbox).toMatchObject([{ state: "delivered" }]);
    expect(snapshot.leases.find((lease) => lease.runId === started.id)?.state).toBe("released");
    expect(learned.memory).toContainEqual(expect.objectContaining({
      content: expect.stringContaining("Lead with the actual product outcome."),
      tags: ["owner-feedback", "artifact-review"]
    }));
    expect(revised).toMatchObject({ revision: 2, reviewState: "draft" });
    expect(accepted).toMatchObject({ revision: 2, reviewState: "accepted", reviewNote: "Ready to ship." });
    expect(waiting.state).toBe("waiting");
    expect(repository.saves).toBeGreaterThanOrEqual(12);
    await automations.shutdown();
  });

  it("ranks the current project handoff ahead of historical research for status work", async () => {
    const runtime = new FakeChatRuntime([
      Promise.resolve(resultFor("Current product summary"))
    ]);
    const automations = createRuntime(new MemoryRepository(), runtime);
    await automations.saveAgent(agent());
    for (let index = 1; index <= 4; index += 1) {
      await automations.saveSource({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        title: `docs/research/HISTORICAL-PRODUCT-${index}-2026-08-02.md`,
        mediaType: "text/markdown",
        content: "Historical product research discussed current shipping priorities and known limits before implementation."
      });
    }
    await automations.saveSource({
      id: "10000000-0000-4000-8000-000000000005",
      title: "docs/CADRANE-SHIP-HANDOFF.md",
      mediaType: "text/markdown",
      content: "Current Rellane product status, shipping priorities, and known limits. This is the authoritative maintainer handoff."
    });
    await automations.saveWorkflow(workflow({
      nodes: [node(FIRST_ID, [], {
        instruction: "Summarize the current Rellane product, shipping priorities, and known limits."
      })]
    }));

    const started = await automations.start({ workflowId: WORKFLOW_ID });
    await waitForRun(automations, started.id, "completed");

    expect(runtime.requests[0]?.messages[1]?.content)
      .toContain("[S1] docs/CADRANE-SHIP-HANDOFF.md");
    await automations.shutdown();
  });

  it("pauses admission after the active node and resumes pending work", async () => {
    const gate = deferred<LocalChatResult>();
    const runtime = new FakeChatRuntime([gate.promise]);
    const automations = createRuntime(new MemoryRepository(), runtime);
    await seed(automations);

    const started = await automations.start({ workflowId: WORKFLOW_ID });
    await waitForStep(automations, started.id, FIRST_ID, "running");
    await automations.action({ runId: started.id, action: "pause" });
    gate.resolve(result(runtime.requests[0]!, "First done"));
    await waitForStep(automations, started.id, FIRST_ID, "completed");
    expect(runtime.requests).toHaveLength(1);

    await automations.action({ runId: started.id, action: "resume" });
    const completed = await waitForRun(automations, started.id, "completed");
    expect(completed.steps[1]?.output).toBe("Output 2");
    await automations.shutdown();
  });

  it("cancels the active model operation and stores a cancelled receipt", async () => {
    const gate = deferred<LocalChatResult>();
    const runtime = new FakeChatRuntime([gate.promise]);
    const automations = createRuntime(new MemoryRepository(), runtime);
    await seed(automations);
    const started = await automations.start({ workflowId: WORKFLOW_ID });
    await waitForStep(automations, started.id, FIRST_ID, "running");

    const cancelled = await automations.action({
      runId: started.id,
      action: "cancel"
    });
    expect(runtime.cancelled).toEqual([runtime.requests[0]?.operationId]);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.receipts.at(-1)?.outcome).toBe("cancelled");
    gate.reject(new DOMException("cancelled", "AbortError"));
    await automations.shutdown();
  });

  it("withdraws a pending capability decision when its run is cancelled", async () => {
    const automations = createRuntime(
      new MemoryRepository(),
      new FakeChatRuntime([Promise.resolve(resultFor("Grounded draft"))])
    );
    await automations.saveAgent(agent());
    await automations.saveWorkflow(workflow({
      nodes: [
        node(FIRST_ID, []),
        node(THIRD_ID, [FIRST_ID], { kind: "artifact.write", instruction: "Save the draft" })
      ]
    }));
    const started = await automations.start({ workflowId: WORKFLOW_ID });
    const request = await pendingRequest(automations, started.id, "artifact.write");

    await automations.action({ runId: started.id, action: "cancel" });
    const snapshot = await automations.snapshot();

    expect(snapshot.capabilityRequests.find((item) => item.id === request.id))
      .toMatchObject({ state: "denied", decidedAt: expect.any(String) });
    expect(snapshot.capabilityRequests.some((item) =>
      item.runId === started.id && item.state === "pending"
    )).toBe(false);
    await automations.shutdown();
  });

  it("retries a failed node and only its descendants", async () => {
    const runtime = new FakeChatRuntime([
      Promise.resolve(resultFor("Output 1")),
      Promise.reject(new Error("model failed")),
      Promise.resolve(resultFor("Recovered"))
    ]);
    const automations = createRuntime(new MemoryRepository(), runtime);
    await seed(automations);
    const started = await automations.start({ workflowId: WORKFLOW_ID });
    const failed = await waitForRun(automations, started.id, "failed");
    expect(failed.steps.map((step) => [step.state, step.attempt]))
      .toEqual([["completed", 1], ["failed", 1]]);

    await automations.action({
      runId: started.id,
      action: "retry",
      nodeId: SECOND_ID
    });
    const completed = await waitForRun(automations, started.id, "completed");
    expect(completed.steps.map((step) => [step.state, step.attempt]))
      .toEqual([["completed", 1], ["completed", 2]]);
    await automations.shutdown();
  });

  it("recovers an in-flight persisted run as interrupted and can resume it", async () => {
    const repository = new MemoryRepository({
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      agents: [],
      workflows: [],
      runs: [persistedRunningRun()],
      memory: [],
      sources: [],
      artifacts: [],
      capabilityRequests: []
      ,
      leases: [],
      connectors: [],
      outbox: [],
      deliveries: []
    });
    const automations = createRuntime(repository, new FakeChatRuntime());
    const recovered = await automations.snapshot();
    expect(recovered.runs[0]).toMatchObject({
      state: "interrupted",
      activeNodeId: null,
      steps: [{ state: "interrupted", operationId: null }]
    });
    expect(recovered.runs[0]?.receipts.at(-1)?.outcome).toBe("interrupted");
    await automations.shutdown();
  });

  it("runs an overdue interval workflow once and advances its next run", async () => {
    const repository = new MemoryRepository();
    let now = new Date("2026-08-12T00:00:00.000Z");
    const automations = new AutomationRuntime({
      dataDirectory: "/tmp/cadrane-automation-test",
      repository,
      runtime: new FakeChatRuntime(),
      now: () => now,
      enableScheduleTimer: false
    });
    await seed(automations, {
      trigger: { kind: "interval", everyMinutes: 5, runOnceIfOverdue: true }
    });
    now = new Date("2026-08-12T00:06:00.000Z");
    await automations.tickSchedules();
    const snapshot = await automations.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.triggerKind).toBe("interval");
    expect(snapshot.workflows[0]?.nextRunAt).toBe("2026-08-12T00:11:00.000Z");
    await waitForRun(automations, snapshot.runs[0]!.id, "completed");
    await automations.shutdown();
  });

  it("persists only authenticated ciphertext and rejects a tampered workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cadrane-encrypted-automation-"));
    const key = new Uint8Array(32).fill(47);
    const keySource = {
      async withOnlyUnlockedKey<T>(callback: (
        reference: { readonly spaceId: string; readonly keyId: string },
        keyMaterial: Uint8Array
      ) => T | Promise<T>): Promise<T> {
        const owned = new Uint8Array(key);
        try {
          return await callback({
            spaceId: "99999999-9999-4999-8999-999999999999",
            keyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          }, owned);
        } finally {
          owned.fill(0);
        }
      }
    };
    const repository = new EncryptedFileAutomationRepository(directory, keySource);
    const snapshot: AutomationWorkspaceSnapshot = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      agents: [{
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        ...agent(),
        revision: 1,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z"
      }],
      workflows: [],
      runs: [],
      memory: [],
      sources: [],
      artifacts: [],
      capabilityRequests: []
      ,
      leases: [],
      connectors: [],
      outbox: [],
      deliveries: []
    };
    await repository.save(snapshot);
    const file = path.join(directory, "automations", "workspace-v1.json.encrypted");
    const encoded = await readFile(file, "utf8");
    expect(encoded).not.toContain("Research analyst");
    await expect(repository.load()).resolves.toEqual(snapshot);
    const envelope = JSON.parse(encoded) as { ciphertext: string; ciphertextSha256: string };
    // Replacing a random final character with A occasionally changes nothing.
    // Flip an actual byte, then also test a recomputed public digest: the GCM
    // authentication tag must still refuse the altered content.
    const changed = Buffer.from(envelope.ciphertext, "base64url");
    changed[0] = changed[0]! ^ 1;
    const previous = envelope.ciphertext;
    envelope.ciphertext = changed.toString("base64url");
    expect(envelope.ciphertext).not.toBe(previous);
    await writeFile(file, JSON.stringify(envelope), "utf8");
    await expect(repository.load()).rejects.toThrow("invalid");
    envelope.ciphertextSha256 = createHash("sha256").update(changed).digest("hex");
    await writeFile(file, JSON.stringify(envelope), "utf8");
    await expect(repository.load()).rejects.toThrow(/authenticate/u);
  });
});

describe("opt-in review-bound automation graph state", () => {
  it.each([
    ["manual", { kind: "manual" } as const],
    ["interval", { kind: "interval", everyMinutes: 5, runOnceIfOverdue: true } as const],
    ["folder", { kind: "folder", root: "/synthetic/inbox" } as const]
  ])("persists the first dependency-ready model attempt for %s without daemon chat", async (kind, trigger) => {
    const repository = new MemoryRepository();
    const chat = new FakeChatRuntime();
    let now = new Date("2026-08-12T00:00:00.000Z");
    const automations = new AutomationRuntime({
      dataDirectory: "/tmp/cadrane-automation-test",
      repository,
      runtime: chat,
      now: () => now,
      enableScheduleTimer: false
    });
    await automations.saveAgent(agent());
    const saved = await automations.saveReviewBoundWorkflow({
      workflow: workflow({ trigger }),
      caseId: CASE_ID,
      sourceTurnIds: [TURN_ID]
    });
    expect(saved.schemaVersion).toBe(2);
    if (kind === "manual") await automations.start({ workflowId: WORKFLOW_ID });
    if (kind === "interval") {
      now = new Date("2026-08-12T00:06:00.000Z");
      await automations.tickSchedules();
      await automations.tickSchedules();
    }
    if (kind === "folder") {
      await automations.folderChanged("/synthetic/inbox");
      await automations.folderChanged("/synthetic/inbox");
    }
    const snapshot = await automations.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    const run = snapshot.runs[0]!;
    expect(run).toMatchObject({
      schemaVersion: 2,
      state: "waiting",
      triggerKind: kind,
      activeNodeId: FIRST_ID,
      reviewBinding: { caseId: CASE_ID, sourceTurnIds: [TURN_ID], reviewRequired: true }
    });
    expect(run.steps.map(step => [step.state, step.attempt])).toEqual([
      ["awaiting-review", 1], ["pending", 0]
    ]);
    expect("attemptId" in run.steps[0]! && run.steps[0]!.attemptId).toEqual(expect.any(String));
    expect(snapshot.leases.filter(lease => lease.runId === run.id && lease.state === "active"))
      .toHaveLength(1);
    expect(chat.requests).toHaveLength(0);
    const lostRepository = new MemoryRepository({ ...snapshot, leases: [] });
    const leaseLost = createRuntime(lostRepository, chat);
    const recovered = (await leaseLost.snapshot()).runs[0]!;
    expect(recovered).toMatchObject({ state: "interrupted", activeNodeId: null });
    expect(recovered.steps[0]).toMatchObject({
      state: "interrupted",
      attempt: 1,
      attemptId: "attemptId" in run.steps[0]! ? run.steps[0]!.attemptId : null
    });
    expect((await leaseLost.snapshot()).leases.filter(lease =>
      lease.runId === run.id && lease.state === "active")).toHaveLength(1);
    await expect(leaseLost.action({ runId: run.id, action: "retry", nodeId: FIRST_ID }))
      .rejects.toThrow("cannot retry");
    await leaseLost.shutdown();
    const afterRecoveryRestart = createRuntime(lostRepository, chat);
    expect((await afterRecoveryRestart.snapshot()).runs[0]).toEqual(recovered);
    await afterRecoveryRestart.action({ runId: run.id, action: "cancel" });
    expect((await afterRecoveryRestart.snapshot()).leases.some(lease =>
      lease.runId === run.id && lease.state === "active")).toBe(false);
    await afterRecoveryRestart.shutdown();
    expect(chat.requests).toHaveLength(0);
    await automations.shutdown();
    const restarted = createRuntime(repository, chat);
    const reloaded = (await restarted.snapshot()).runs[0]!;
    expect(reloaded).toEqual(run);
    expect(chat.requests).toHaveLength(0);
    await expect(restarted.action({ runId: run.id, action: "retry", nodeId: FIRST_ID }))
      .rejects.toThrow("cannot retry");
    await expect(restarted.action({ runId: run.id, action: "pause" }))
      .rejects.toThrow("cannot pause");
    expect((await restarted.snapshot()).runs[0]).toEqual(run);
    const cancelled = await restarted.action({ runId: run.id, action: "cancel" });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.steps.map(step => step.state)).toEqual(["cancelled", "cancelled"]);
    expect((await restarted.snapshot()).leases.some(lease =>
      lease.runId === run.id && lease.state === "active")).toBe(false);
    expect(chat.requests).toHaveLength(0);
    await restarted.shutdown();
  });

  it("keeps legacy v1 record shapes and refuses an uncertain bound retry or revision drift", async () => {
    const repository = new MemoryRepository();
    const chat = new FakeChatRuntime();
    const automations = createRuntime(repository, chat);
    await automations.saveAgent(agent());
    const legacy = await automations.saveWorkflow(workflow({ id: SECOND_ID }));
    expect(JSON.stringify(legacy)).not.toContain("reviewBinding");
    const v1Run = await automations.start({ workflowId: SECOND_ID });
    await waitForRun(automations, v1Run.id, "completed");
    expect(JSON.stringify((await automations.snapshot()).runs[0])).not.toContain("attemptId");
    expect(chat.requests).toHaveLength(2);

    await automations.saveReviewBoundWorkflow({
      workflow: workflow(), caseId: CASE_ID, sourceTurnIds: [TURN_ID]
    });
    const bound = await automations.start({ workflowId: WORKFLOW_ID });
    expect(chat.requests).toHaveLength(2);
    await expect(automations.saveWorkflow(workflow())).rejects.toThrow("cannot be replaced");
    await expect(automations.exportPack(WORKFLOW_ID)).rejects.toThrow("cannot be exported");
    const legacyPack = await automations.exportPack(SECOND_ID);
    await expect(automations.importPack({
      ...legacyPack,
      workflow: { ...legacyPack.workflow, id: WORKFLOW_ID }
    })).rejects.toThrow("cannot replace");
    expect((await automations.snapshot()).agents[0]?.revision).toBe(1);
    const uncertain = await automations.snapshot();
    const run = uncertain.runs.find(item => item.id === bound.id)!;
    run.state = "interrupted";
    run.activeNodeId = null;
    run.steps[0]!.state = "interrupted";
    const restarted = createRuntime(new MemoryRepository(uncertain), chat);
    await expect(restarted.action({ runId: bound.id, action: "resume" }))
      .rejects.toThrow("cannot resume");
    await expect(restarted.action({ runId: bound.id, action: "retry", nodeId: FIRST_ID }))
      .rejects.toThrow("cannot retry");
    expect(chat.requests).toHaveLength(2);
    await restarted.shutdown();
    await automations.shutdown();

    const changed = createRuntime(new MemoryRepository(), new FakeChatRuntime());
    await changed.saveAgent(agent());
    await changed.saveReviewBoundWorkflow({
      workflow: workflow(), caseId: CASE_ID, sourceTurnIds: [TURN_ID]
    });
    await changed.saveAgent({ ...agent(), name: "Changed agent" });
    await expect(changed.start({ workflowId: WORKFLOW_ID })).rejects.toThrow("agent changed");
    expect((await changed.snapshot()).runs).toHaveLength(0);
    await changed.shutdown();
  });

  it("refuses a review-bound opt-in with duplicate sources or automatic tool nodes", async () => {
    const automations = createRuntime(new MemoryRepository(), new FakeChatRuntime());
    await automations.saveAgent(agent());
    await expect(automations.saveReviewBoundWorkflow({
      workflow: workflow(), caseId: CASE_ID, sourceTurnIds: [TURN_ID, TURN_ID]
    })).rejects.toThrow("unique");
    await expect(automations.saveReviewBoundWorkflow({
      workflow: workflow({ nodes: [node(FIRST_ID, [], { kind: "memory.search" })] }),
      caseId: CASE_ID, sourceTurnIds: [TURN_ID]
    })).rejects.toThrow("model nodes only");
    await expect(automations.saveReviewBoundWorkflow({
      workflow: workflow({ nodes: [node(FIRST_ID, []), node(SECOND_ID, [])] }),
      caseId: CASE_ID, sourceTurnIds: [TURN_ID]
    })).rejects.toThrow("exactly one root");
    expect((await automations.snapshot()).workflows).toHaveLength(0);
    await automations.shutdown();
  });

  it("loads an older multi-root v2 record for inspection but refuses to start it", async () => {
    const chat = new FakeChatRuntime();
    const authoring = createRuntime(new MemoryRepository(), chat);
    await authoring.saveAgent(agent());
    await authoring.saveReviewBoundWorkflow({
      workflow: workflow(), caseId: CASE_ID, sourceTurnIds: [TURN_ID]
    });
    const olderRecord = await authoring.snapshot();
    olderRecord.workflows[0]!.nodes = [node(FIRST_ID, []), node(SECOND_ID, [])];
    const loaded = createRuntime(new MemoryRepository(olderRecord), chat);
    expect((await loaded.snapshot()).workflows[0]?.nodes).toHaveLength(2);
    await expect(loaded.start({ workflowId: WORKFLOW_ID })).rejects.toThrow("exactly one root");
    expect((await loaded.snapshot()).runs).toHaveLength(0);
    expect(chat.requests).toHaveLength(0);
    await loaded.shutdown();
    await authoring.shutdown();
  });
});

class MemoryRepository implements AutomationRepository {
  saves = 0;
  constructor(private value: AutomationWorkspaceSnapshot = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    agents: [],
    workflows: [],
    runs: [],
    memory: [],
    sources: [],
    artifacts: [],
    capabilityRequests: []
    ,
    leases: [],
    connectors: [],
    outbox: [],
    deliveries: []
  }) {}
  async load(): Promise<AutomationWorkspaceSnapshot> {
    return structuredClone(this.value);
  }
  async save(snapshot: AutomationWorkspaceSnapshot): Promise<void> {
    this.saves += 1;
    this.value = structuredClone(snapshot);
  }
}

class FakeChatRuntime implements AutomationChatBoundary {
  readonly requests: LocalChatRequest[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly responses: Promise<LocalChatResult>[] = []) {}
  async chat(request: LocalChatRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    return this.responses.shift() ?? result(request, `Output ${this.requests.length}`);
  }
  cancel(operationId: string): boolean {
    this.cancelled.push(operationId);
    return true;
  }
}

function createRuntime(
  repository: AutomationRepository,
  runtime: AutomationChatBoundary
): AutomationRuntime {
  return new AutomationRuntime({
    dataDirectory: "/tmp/cadrane-automation-test",
    repository,
    runtime,
    now: () => new Date(),
    enableScheduleTimer: false
  });
}

async function seed(
  runtime: AutomationRuntime,
  overrides: Partial<AutomationWorkflowSaveInput> = {}
): Promise<void> {
  await runtime.saveAgent(agent());
  await runtime.saveWorkflow(workflow(overrides));
}

function agent(): AutomationAgentSaveInput {
  return {
    id: AGENT_ID,
    name: "Researcher",
    description: "Synthesizes local work.",
    systemPrompt: "Work carefully and return a concise result.",
    runtimeId: "ollama",
    modelId: "qwen-test",
    routingMode: "fixed",
    fallbackRoutes: [],
    temperature: 0.2,
    maxTokens: 256
  };
}

function workflow(
  overrides: Partial<AutomationWorkflowSaveInput> = {}
): AutomationWorkflowSaveInput {
  return {
    id: WORKFLOW_ID,
    name: "Brief maker",
    description: "Research and synthesize.",
    enabled: true,
    trigger: { kind: "manual" },
    budget: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 6,
      maxOutputCharacters: 20_000
    },
    nodes: [node(FIRST_ID, []), node(SECOND_ID, [FIRST_ID])],
    ...overrides
  };
}

function node(id: string, dependsOn: string[], overrides: Partial<AutomationNode> = {}): AutomationNode {
  return { ...baseNode(id, dependsOn), ...overrides };
}

function baseNode(id: string, dependsOn: string[]): AutomationNode {
  return {
    id,
    title: `Node ${id === FIRST_ID ? 1 : id === SECOND_ID ? 2 : 3}`,
    instruction: `Instruction ${id === FIRST_ID ? 1 : id === SECOND_ID ? 2 : 3}`,
    kind: "model" as const,
    agentId: AGENT_ID,
    connectorId: null,
    dependsOn
  };
}

function result(request: LocalChatRequest, content: string): LocalChatResult {
  return {
    operationId: request.operationId,
    runtimeId: request.runtimeId,
    modelId: request.modelId,
    content,
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:01.000Z",
    localOnly: true
  };
}

function resultFor(content: string): LocalChatResult {
  return {
    operationId: "66666666-6666-4666-8666-666666666666",
    runtimeId: "ollama",
    modelId: "qwen-test",
    content,
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:01.000Z",
    localOnly: true
  };
}

async function waitForRun(
  runtime: AutomationRuntime,
  runId: string,
  state: AutomationRunSnapshot["state"]
): Promise<AutomationRunSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = (await runtime.snapshot()).runs.find((item) => item.id === runId);
    if (run?.state === state) return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Run did not reach ${state}.`);
}

async function waitForStep(
  runtime: AutomationRuntime,
  runId: string,
  nodeId: string,
  state: AutomationRunSnapshot["steps"][number]["state"]
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = (await runtime.snapshot()).runs.find((item) => item.id === runId);
    if (run?.steps.find((step) => step.nodeId === nodeId)?.state === state) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Step did not reach ${state}.`);
}

async function pendingRequest(
  runtime: AutomationRuntime,
  runId: string,
  capability: "artifact.write" | "connector.send"
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = (await runtime.snapshot()).capabilityRequests.find((item) =>
      item.runId === runId && item.capability === capability && item.state === "pending"
    );
    if (request !== undefined) return request;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`No pending ${capability} request.`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function persistedRunningRun(): AutomationRunSnapshot {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: "77777777-7777-4777-8777-777777777777",
    workflowId: WORKFLOW_ID,
    workflowRevision: 1,
    workflowName: "Interrupted",
    state: "running",
    triggerKind: "manual",
    budget: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 2,
      maxOutputCharacters: 10_000
    },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: null,
    deadlineAt: "2099-08-12T00:00:00.000Z",
    activeNodeId: FIRST_ID,
    error: null,
    steps: [{
      nodeId: FIRST_ID,
      title: "Node 1",
      instruction: "Instruction 1",
      kind: "model",
      dependsOn: [],
      connectorId: null,
      agent: {
        agentId: AGENT_ID,
        agentRevision: 1,
        name: "Researcher",
        systemPrompt: "Work carefully.",
        runtimeId: "ollama",
        modelId: "qwen-test",
        routingMode: "fixed",
        fallbackRoutes: [],
        temperature: 0.2,
        maxTokens: 256
      },
      state: "running",
      attempt: 1,
      operationId: "88888888-8888-4888-8888-888888888888",
      resolvedRoute: { runtimeId: "ollama", modelId: "qwen-test" },
      citations: [],
      startedAt: "2026-08-12T00:00:00.000Z",
      finishedAt: null,
      output: null,
      error: null
    }],
    receipts: []
  };
}
