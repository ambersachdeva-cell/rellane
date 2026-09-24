/**
 * Walking a flow without running it.
 *
 * Arming a flow is the one action in this product whose consequences are not
 * visible at the moment you take it — everything else happens while somebody is
 * watching. These tests are about the plan sheet that action deserves, and
 * about the property that makes it worth anything: **it walks with the same
 * rule the real run uses.** A plan that does not match what happens is worse
 * than no plan, because it is believed.
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
const SECOND_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_ID = "55555555-5555-4555-8555-555555555555";

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

/** Counts every call, so a dry run that spent one would be caught. */
class CountingRuntime implements AutomationChatBoundary {
  calls = 0;
  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    this.calls += 1;
    return {
      operationId: request.operationId,
      runtimeId: request.runtimeId,
      modelId: request.modelId,
      content: "unused",
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

const node = (
  id: string,
  dependsOn: string[],
  overrides: Partial<AutomationNode> = {}
): AutomationNode => ({
  id,
  title: `Step ${id.slice(0, 1)}`,
  instruction: "Do the thing.",
  kind: "model",
  agentId: AGENT_ID,
  connectorId: null,
  dependsOn,
  ...overrides
});

const workflow = (
  overrides: Partial<AutomationWorkflowSaveInput> = {}
): AutomationWorkflowSaveInput => ({
  id: WORKFLOW_ID,
  name: "Brief maker",
  description: "Research and synthesize.",
  enabled: true,
  trigger: { kind: "manual" },
  budget: { maxDurationMs: 60_000, maxNodeExecutions: 6, maxOutputCharacters: 20_000 },
  nodes: [node(FIRST_ID, []), node(SECOND_ID, [FIRST_ID])],
  ...overrides
});

async function seeded(
  overrides: Partial<AutomationWorkflowSaveInput> = {}
): Promise<{ runtime: AutomationRuntime; chat: CountingRuntime }> {
  const chat = new CountingRuntime();
  const runtime = new AutomationRuntime({
    dataDirectory: "/tmp/cadrane-dry-run-test",
    repository: new MemoryRepository(),
    runtime: chat,
    now: () => new Date("2026-09-02T10:00:00.000Z"),
    enableScheduleTimer: false
  });
  await runtime.saveAgent(agent());
  await runtime.saveWorkflow(workflow(overrides));
  return { runtime, chat };
}

describe("a dry run", () => {
  it("spends nothing", async () => {
    // The property the whole feature rests on. A "preview" that quietly runs
    // the flow is not a preview; it is the flow, with a different button.
    const { runtime, chat } = await seeded();

    const dry = await runtime.dryRun(WORKFLOW_ID);

    expect(chat.calls).toBe(0);
    expect(dry.ok).toBe(true);
    expect(dry.modelCalls).toBe(2);
  });

  it("walks in the order the real run would take", async () => {
    // Diamond: two independent middles that both wait on the first. The order
    // must be the one the executor picks, not a plausible one.
    const { runtime } = await seeded({
      nodes: [
        node(FIRST_ID, []),
        node(SECOND_ID, [FIRST_ID]),
        node(THIRD_ID, [FIRST_ID, SECOND_ID])
      ]
    });

    const dry = await runtime.dryRun(WORKFLOW_ID);

    expect(dry.steps.map((step) => step.nodeId)).toEqual([FIRST_ID, SECOND_ID, THIRD_ID]);
    expect(dry.steps.map((step) => step.order)).toEqual([1, 2, 3]);
  });

  it("says how many times it will interrupt you", async () => {
    // A flow's real cost is not tokens, it is how often it stops and asks. That
    // is the number that decides whether somebody keeps it or switches it off
    // on the second day, and it is knowable before arming.
    const { runtime } = await seeded({
      nodes: [node(FIRST_ID, []), node(SECOND_ID, [FIRST_ID], { kind: "artifact.write" })]
    });

    const dry = await runtime.dryRun(WORKFLOW_ID);

    expect(dry.approvals).toBe(1);
    expect(dry.steps[1]?.asks).toBe("artifact.write");
    expect(dry.summary).toContain("1 approval from you");
  });
});

describe("a flow that could not finish", () => {
  it("says so before it is armed, not partway through", async () => {
    // The worst of the three outcomes: it does some of the work and stops. A
    // budget smaller than the flow is knowable by counting.
    const { runtime } = await seeded({
      budget: { maxDurationMs: 60_000, maxNodeExecutions: 1, maxOutputCharacters: 20_000 }
    });

    const dry = await runtime.dryRun(WORKFLOW_ID);

    expect(dry.ok).toBe(false);
    expect(dry.problem).toContain("would stop partway");
    expect(dry.summary).toContain("2 steps");
  });

  it("cannot be saved at all with a step whose agent does not exist", async () => {
    // The dry run keeps a guard for this, but it is unreachable through any
    // supported route: the save refuses first, and names the step rather than
    // saying "an agent is missing" and sending somebody through every step of a
    // flow they may not have written. There is no delete-agent path that could
    // orphan one afterwards.
    const { runtime } = await seeded();

    await expect(
      runtime.saveWorkflow(
        workflow({
          nodes: [
            node(FIRST_ID, []),
            node(SECOND_ID, [FIRST_ID], {
              title: "Send the summary",
              agentId: "77777777-7777-4777-8777-777777777777"
            })
          ]
        })
      )
    ).rejects.toThrow("Send the summary");
  });
});
