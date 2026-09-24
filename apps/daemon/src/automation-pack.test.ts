/**
 * A flow is a file that can be diffed and reviewed.
 *
 * That is task 7.1's whole claim, and it is only worth anything if the file
 * that comes out is the flow that goes back in. A round trip that loses a
 * dependency, a budget or a connector produces a document that *looks* like a
 * review of the flow and is a review of something else.
 */

import {
  AUTOMATION_SCHEMA_VERSION,
  AutomationWorkflowPackSchema,
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
const SECOND_ID = "44444444-4444-4444-8444-444444444444";

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

class SilentRuntime implements AutomationChatBoundary {
  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    return {
      operationId: request.operationId,
      runtimeId: request.runtimeId,
      modelId: request.modelId,
      content: "",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:00:01.000Z",
      localOnly: true
    };
  }
  cancel(): boolean {
    return true;
  }
}

const agent = (): AutomationAgentSaveInput => ({
  id: AGENT_ID,
  name: "Researcher",
  description: "Synthesizes local work.",
  systemPrompt: "Work carefully.",
  runtimeId: "ollama",
  modelId: "qwen-test",
  routingMode: "fixed",
  fallbackRoutes: [],
  temperature: 0.2,
  maxTokens: 256
});

const node = (id: string, dependsOn: string[]): AutomationNode => ({
  id,
  title: `Step ${id.slice(0, 1)}`,
  instruction: "Do the thing.",
  kind: "model",
  agentId: AGENT_ID,
  connectorId: null,
  dependsOn
});

const workflow = (): AutomationWorkflowSaveInput => ({
  id: WORKFLOW_ID,
  name: "Brief maker",
  description: "Research and synthesize.",
  enabled: true,
  trigger: { kind: "interval", everyMinutes: 240, runOnceIfOverdue: true },
  budget: { maxDurationMs: 60_000, maxNodeExecutions: 6, maxOutputCharacters: 20_000 },
  nodes: [node(FIRST_ID, []), node(SECOND_ID, [FIRST_ID])]
});

async function seeded(): Promise<AutomationRuntime> {
  const runtime = new AutomationRuntime({
    dataDirectory: "/tmp/cadrane-pack-test",
    repository: new MemoryRepository(),
    runtime: new SilentRuntime(),
    now: () => new Date("2026-09-02T10:00:00.000Z"),
    enableScheduleTimer: false
  });
  await runtime.saveAgent(agent());
  await runtime.saveWorkflow(workflow());
  return runtime;
}

describe("a flow exported as a file", () => {
  it("survives a trip through JSON and back unchanged", async () => {
    const runtime = await seeded();

    const pack = await runtime.exportPack(WORKFLOW_ID);
    // Exactly what the desktop writes to disk: pretty-printed JSON, so a diff
    // is line-by-line rather than one enormous line.
    const onDisk = `${JSON.stringify(pack, null, 2)}\n`;
    const readBack = AutomationWorkflowPackSchema.parse(JSON.parse(onDisk));
    const imported = await runtime.importPack(readBack);

    expect(imported.nodes.map((step) => step.id)).toEqual([FIRST_ID, SECOND_ID]);
    expect(imported.nodes[1]?.dependsOn).toEqual([FIRST_ID]);
    expect(imported.trigger).toEqual({
      kind: "interval",
      everyMinutes: 240,
      runOnceIfOverdue: true
    });
    expect(imported.budget).toEqual(workflow().budget);
    expect(onDisk.split("\n").length).toBeGreaterThan(20);
  });

  it("carries the agents it needs, so the file is reviewable on its own", async () => {
    // A flow whose steps reference agent ids and nothing else is a document
    // nobody can read: the reviewer would be diffing UUIDs. The pack carries
    // the agents, including the prompt each step would actually run.
    const runtime = await seeded();

    const pack = await runtime.exportPack(WORKFLOW_ID);

    expect(pack.agents.map((entry) => entry.name)).toEqual(["Researcher"]);
    expect(pack.agents[0]?.systemPrompt).toBe("Work carefully.");
    expect(pack.schemaVersion).toBe(AUTOMATION_SCHEMA_VERSION);
    expect(pack.kind).toBe("cadrane-workflow-pack");
  });

  it("refuses a pack from a schema version it does not know", async () => {
    // Versioning that decides something. A pack from a future build is refused
    // rather than half-understood — a flow that half-loaded would run with
    // steps missing, which is worse than one that did not load.
    const runtime = await seeded();
    const pack = await runtime.exportPack(WORKFLOW_ID);

    expect(() =>
      AutomationWorkflowPackSchema.parse({ ...pack, schemaVersion: AUTOMATION_SCHEMA_VERSION + 1 })
    ).toThrow();
  });
});
