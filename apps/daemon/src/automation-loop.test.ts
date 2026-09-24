/**
 * A flow that feeds itself.
 *
 * The failure this guards is the one that runs all night: a flow files
 * something into the folder that triggers it, so it runs, the folder changes,
 * and it runs again — burning a subscription and filling the record with
 * identical entries while nobody is watching.
 */

import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationAgentSaveInput,
  type AutomationNode,
  type AutomationWorkflowSaveInput,
  type AutomationWorkspaceSnapshot,
  type LocalChatRequest,
  type LocalChatResult
} from "@cadrane/contracts";
import { describe, expect, it } from "vitest";
import {
  AutomationRuntime,
  type AutomationChatBoundary,
  type AutomationRepository
} from "./automation-runtime.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_ID = "33333333-3333-4333-8333-333333333333";
const ROOT = "/Users/amber/Downloads";

class MemoryRepository implements AutomationRepository {
  private value: AutomationWorkspaceSnapshot = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
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
    return structuredClone(this.value);
  }
  async save(snapshot: AutomationWorkspaceSnapshot): Promise<void> {
    this.value = structuredClone(snapshot);
  }
}

/** Answers instantly, so a run finishes and the next trigger can arrive. */
class QuietRuntime implements AutomationChatBoundary {
  calls = 0;
  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    this.calls += 1;
    return {
      operationId: request.operationId,
      runtimeId: request.runtimeId,
      modelId: request.modelId,
      content: "done",
      startedAt: "2026-09-03T00:00:00.000Z",
      finishedAt: "2026-09-03T00:00:01.000Z",
      localOnly: true
    };
  }
  cancel(): boolean {
    return true;
  }
}

const agent = (): AutomationAgentSaveInput => ({
  id: AGENT_ID,
  name: "Filer",
  description: "Files things.",
  systemPrompt: "File it.",
  runtimeId: "ollama",
  modelId: "qwen-test",
  routingMode: "fixed",
  fallbackRoutes: [],
  temperature: 0.2,
  maxTokens: 128
});

const node = (): AutomationNode => ({
  id: FIRST_ID,
  title: "File it",
  instruction: "Put it where it goes.",
  kind: "model",
  agentId: AGENT_ID,
  connectorId: null,
  dependsOn: []
});

const workflow = (
  over: Partial<AutomationWorkflowSaveInput> = {}
): AutomationWorkflowSaveInput => ({
  id: WORKFLOW_ID,
  name: "Tidy Downloads",
  description: "Files whatever lands.",
  enabled: true,
  trigger: { kind: "folder", root: ROOT },
  budget: { maxDurationMs: 60_000, maxNodeExecutions: 6, maxOutputCharacters: 20_000 },
  nodes: [node()],
  ...over
});

async function seeded(over: Partial<AutomationWorkflowSaveInput> = {}) {
  let clock = Date.parse("2026-09-03T10:00:00.000Z");
  const chat = new QuietRuntime();
  const runtime = new AutomationRuntime({
    dataDirectory: "/tmp/cadrane-loop-test",
    repository: new MemoryRepository(),
    runtime: chat,
    now: () => new Date(clock),
    enableScheduleTimer: false
  });
  await runtime.saveAgent(agent());
  await runtime.saveWorkflow(workflow(over));
  return {
    runtime,
    chat,
    tick: (ms: number) => {
      clock += ms;
    },
    at: () => new Date(clock)
  };
}

const flowOf = async (runtime: AutomationRuntime) =>
  (await runtime.snapshot()).workflows.find((entry) => entry.id === WORKFLOW_ID);

describe("a folder-triggered flow", () => {
  it("runs when its folder changes", async () => {
    const { runtime, at } = await seeded();

    await runtime.folderChanged(ROOT, at());

    const runs = (await runtime.snapshot()).runs.filter((run) => run.workflowId === WORKFLOW_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerKind).toBe("folder");
  });

  it("ignores a folder it is not watching", async () => {
    const { runtime, at } = await seeded();

    await runtime.folderChanged("/Users/amber/Documents", at());

    expect((await runtime.snapshot()).runs).toHaveLength(0);
  });

  it("does not stack while one of its own runs is still going", async () => {
    const { runtime, at } = await seeded();

    await runtime.folderChanged(ROOT, at());
    await runtime.folderChanged(ROOT, at());

    expect((await runtime.snapshot()).runs).toHaveLength(1);
  });
});

describe("a flow that keeps re-triggering itself", () => {
  it("switches itself off rather than running all night", async () => {
    // The whole point. Four starts inside two minutes is not somebody working.
    const { runtime, tick, at } = await seeded();

    for (let time = 0; time < 6; time += 1) {
      await runtime.folderChanged(ROOT, at());
      // The run must finish before the next trigger, because a flow that is
      // still running blocks its own re-trigger. That is exactly the shape of
      // the real loop: it finishes, it writes, the folder moves, it starts.
      await runtime.settle();
      tick(10_000);
    }

    const flow = await flowOf(runtime);
    expect(flow?.enabled).toBe(false);
    expect(flow?.pausedReason).toContain("Downloads");
    expect(flow?.pausedReason).toContain("filing into the folder that starts it");
    // It stopped; it did not keep going slowly. A throttle is the same bill
    // arriving later.
    expect(flow?.nextRunAt).toBeNull();
  });

  it("says why, so a flow never just mysteriously stops", async () => {
    const { runtime, tick, at } = await seeded();

    for (let time = 0; time < 6; time += 1) {
      await runtime.folderChanged(ROOT, at());
      await runtime.settle();
      tick(5_000);
    }

    expect((await flowOf(runtime))?.pausedReason).toContain("turn it back on");
  });

  it("leaves ordinary work alone", async () => {
    // Somebody dropping three files into Downloads across ten minutes is
    // working, not looping. A guard that fired on that is one nobody could
    // leave switched on.
    const { runtime, tick, at } = await seeded();

    for (let time = 0; time < 3; time += 1) {
      await runtime.folderChanged(ROOT, at());
      await runtime.settle();
      tick(300_000);
    }

    const flow = await flowOf(runtime);
    expect(flow?.enabled).toBe(true);
    expect(flow?.pausedReason).toBeNull();
  });

  it("does not touch a flow triggered by its interval", async () => {
    // The guard is about a folder feeding a flow. An interval flow running
    // often is doing exactly what it was told to.
    const { runtime, tick, at } = await seeded({
      trigger: { kind: "interval", everyMinutes: 1, runOnceIfOverdue: true }
    });

    for (let time = 0; time < 6; time += 1) {
      await runtime.folderChanged(ROOT, at());
      await runtime.settle();
      tick(5_000);
    }

    expect((await flowOf(runtime))?.enabled).toBe(true);
  });
});
