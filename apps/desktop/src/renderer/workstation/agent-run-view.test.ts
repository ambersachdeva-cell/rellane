import { describe, expect, it } from "vitest";
import { buildAgentRunView } from "./agent-run-view.js";
import type { RawAgentStep } from "./agent-run-view.js";

describe("buildAgentRunView", () => {
  it("transforms a raw run with malformed JSON, huge thought, unknown tool, and failed step into a safe view", () => {
    const hugeThought = "Thinking about the overall problem carefully and considering all options. ".repeat(40);
    const rawSteps: readonly RawAgentStep[] = [
      {
        index: 1,
        thought: hugeThought,
        toolName: "rellane_read_source",
        toolArgs: "{unclosed: json, name: 'short_name.pdf'",
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 1000,
        endedAt: 1500,
      },
      {
        index: 2,
        thought: "Trying an internal helper that is not known to the UI.",
        toolName: "vector_store_hybrid_search_query",
        toolArgs: '{"query": "revenue 2024"}',
        toolResult: "Found 0 matches",
        toolFailed: true,
        answer: "",
        startedAt: 1500,
        endedAt: 2200,
      },
    ];

    const view = buildAgentRunView({
      runId: "run-1",
      caseId: "case-1",
      goal: "Analyse quarterly accounts",
      state: "failed",
      stepsAllowed: 5,
      steps: rawSteps,
      failure: "a step failed to complete",
      now: 2500,
    });

    expect(view.state).toBe("failed");
    expect(view.canStop).toBe(false);
    expect(view.stepsUsed).toBe(2);
    expect(view.headline).toBe("Could not finish: a step failed to complete.");

    const step1 = view.steps[0];
    expect(step1).toBeDefined();
    if (step1 !== undefined) {
      expect(step1.kind).toBe("tool");
      expect(step1.title).toBe('Read "short_name.pdf"');
      expect(step1.toolLabel).toBe("Source");
      expect(step1.ok).toBe(true);
      expect(step1.durationMs).toBe(500);
      expect(step1.detail.length).toBeLessThanOrEqual(2000);
      expect(step1.detail.endsWith("...")).toBe(true);
      expect(step1.title).not.toContain("{");
      expect(step1.title).not.toContain("}");
    }

    const step2 = view.steps[1];
    expect(step2).toBeDefined();
    if (step2 !== undefined) {
      expect(step2.kind).toBe("tool");
      expect(step2.title).toBe("Used a tool it has");
      expect(step2.toolLabel).toBe("Tool");
      expect(step2.ok).toBe(false);
      expect(step2.durationMs).toBe(700);
      expect(step2.detail).toContain("vector_store_hybrid_search_query");
      expect(step2.title).not.toContain("vector_store");
    }

    for (const step of view.steps) {
      for (const word of step.title.split(/\s+/)) {
        expect(word.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it("sorts out-of-order steps and deduplicates identical indexes, keeping the first occurrence", () => {
    const rawSteps: readonly RawAgentStep[] = [
      {
        index: 3,
        thought: "Step three",
        toolName: "hermes_check_citations",
        toolArgs: "{}",
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 3000,
        endedAt: 3500,
      },
      {
        index: 1,
        thought: "First version of step one",
        toolName: "rellane_list_sources",
        toolArgs: "{}",
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 1000,
        endedAt: 1500,
      },
      {
        index: 2,
        thought: "Step two",
        toolName: "duckdb_query",
        toolArgs: '{"query": "SELECT * FROM sales"}',
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 2000,
        endedAt: 2500,
      },
      {
        index: 1,
        thought: "Duplicate of step one that should be discarded",
        toolName: "rellane_list_sources",
        toolArgs: "{}",
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 1100,
        endedAt: 1600,
      },
    ];

    const view = buildAgentRunView({
      runId: "run-2",
      caseId: "case-2",
      goal: "Verify citations and sales figures",
      state: "running",
      stepsAllowed: 8,
      steps: rawSteps,
      now: 4000,
    });

    expect(view.stepsUsed).toBe(3);
    expect(view.steps.map((s) => s.index)).toEqual([1, 2, 3]);

    const step1 = view.steps[0];
    expect(step1).toBeDefined();
    if (step1 !== undefined) {
      expect(step1.detail).toBe("First version of step one");
      expect(step1.title).toBe("Looked at which files you had chosen");
      expect(step1.toolLabel).toBe("Sources");
    }

    const step2 = view.steps[1];
    expect(step2).toBeDefined();
    if (step2 !== undefined) {
      expect(step2.title).toBe("Asked a question of your spreadsheet");
      expect(step2.toolLabel).toBe("Spreadsheet");
    }

    const step3 = view.steps[2];
    expect(step3).toBeDefined();
    if (step3 !== undefined) {
      expect(step3.title).toBe("Checked every claim against your sources");
      expect(step3.toolLabel).toBe("Citations");
    }
  });

  it("calculates durationMs properly and handles running steps and clock skew without negative values", () => {
    const rawSteps: readonly RawAgentStep[] = [
      {
        index: 1,
        thought: "Normal completed step",
        toolName: "run_sandbox",
        toolArgs: '{"code": "1 + 1"}',
        toolResult: "2",
        toolFailed: false,
        answer: "",
        startedAt: 2000,
        endedAt: 3200,
      },
      {
        index: 2,
        thought: "Currently executing step",
        toolName: "hermes_read_skill",
        toolArgs: '{"skill": "balance_sheet"}',
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 4000,
        endedAt: null,
      },
      {
        index: 3,
        thought: "Step with clock skew where endedAt is before startedAt",
        toolName: "hermes_list_skills",
        toolArgs: "{}",
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 6000,
        endedAt: 5000,
      },
    ];

    const view = buildAgentRunView({
      runId: "run-3",
      caseId: "case-3",
      goal: "Run test computations",
      state: "running",
      stepsAllowed: 4,
      steps: rawSteps,
      now: 5000,
    });

    const step1 = view.steps[0];
    expect(step1).toBeDefined();
    if (step1 !== undefined) {
      expect(step1.durationMs).toBe(1200);
      expect(step1.ok).toBe(true);
      expect(step1.title).toBe("Worked something out in a sealed scratchpad");
      expect(step1.toolLabel).toBe("Scratchpad");
    }

    const step2 = view.steps[1];
    expect(step2).toBeDefined();
    if (step2 !== undefined) {
      expect(step2.durationMs).toBeNull();
      expect(step2.ok).toBeNull();
      expect(step2.title).toBe('Followed the "balance_sheet" procedure');
      expect(step2.toolLabel).toBe("Procedure");
    }

    const step3 = view.steps[2];
    expect(step3).toBeDefined();
    if (step3 !== undefined) {
      expect(step3.durationMs).toBeNull();
      expect(step3.ok).toBe(true);
      expect(step3.title).toBe("Checked which procedures it knows");
      expect(step3.toolLabel).toBe("Procedures");
    }

    expect(view.headline).toBe("Working through step 2 of 4.");
    expect(view.canStop).toBe(true);
  });

  it("strips file paths and prevents long identifier strings from polluting titles", () => {
    const rawSteps: readonly RawAgentStep[] = [
      {
        index: 1,
        thought: "",
        toolName: "rellane_read_source",
        toolArgs: '{"path": "/Users/amber/Documents/Work/ledger_2024.csv"}',
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 1000,
        endedAt: 1200,
      },
      {
        index: 2,
        thought: "",
        toolName: "rellane_read_source",
        toolArgs: '{"id": "c7a8f9024b89e31d560c2b1849a62efd482910fa384920bcde482910fa384920"}',
        toolResult: "",
        toolFailed: false,
        answer: "",
        startedAt: 1300,
        endedAt: 1500,
      },
    ];

    const view = buildAgentRunView({
      runId: "run-4",
      caseId: "case-4",
      goal: "Examine private accounts",
      state: "running",
      stepsAllowed: 2,
      steps: rawSteps,
      now: 1600,
    });

    const step1 = view.steps[0];
    expect(step1).toBeDefined();
    if (step1 !== undefined) {
      expect(step1.title).toBe('Read "ledger_2024.csv"');
      expect(step1.title).not.toContain("/");
    }

    const step2 = view.steps[1];
    expect(step2).toBeDefined();
    if (step2 !== undefined) {
      expect(step2.title).toBe("Read a chosen source");
      expect(step2.title).not.toContain("c7a8f9");
    }
  });

  it("formats headlines correctly across all lifecycle states and handles zero allowed steps", () => {
    const baseInput = {
      runId: "run-5",
      caseId: "case-5",
      goal: "Generate annual financial overview",
      steps: [
        {
          index: 1,
          thought: "Analysed spreadsheet",
          toolName: "duckdb_query",
          toolArgs: "{}",
          toolResult: "",
          toolFailed: false,
          answer: "",
          startedAt: 1000,
          endedAt: 1500,
        },
        {
          index: 2,
          thought: "",
          toolName: null,
          toolArgs: "",
          toolResult: "",
          toolFailed: false,
          answer: "Here is your overview of the annual accounts.",
          startedAt: 1600,
          endedAt: 2000,
        },
      ],
      now: 2500,
    };

    const doneView = buildAgentRunView({
      ...baseInput,
      state: "done",
      stepsAllowed: 5,
    });
    expect(doneView.headline).toBe("Finished in 2 steps.");
    expect(doneView.canStop).toBe(false);

    const planningView = buildAgentRunView({
      ...baseInput,
      state: "planning",
      stepsAllowed: 5,
    });
    expect(planningView.headline).toBe("Planning the steps to take.");
    expect(planningView.canStop).toBe(true);

    const stoppedView = buildAgentRunView({
      ...baseInput,
      state: "stopped",
      stepsAllowed: 5,
    });
    expect(stoppedView.headline).toBe("Stopped at step 2, at your request.");
    expect(stoppedView.canStop).toBe(false);

    const stoppingView = buildAgentRunView({
      ...baseInput,
      state: "stopping",
      stepsAllowed: 5,
    });
    expect(stoppingView.headline).toBe("Stopping at your request.");
    expect(stoppingView.canStop).toBe(false);

    const awaitingApprovalView = buildAgentRunView({
      ...baseInput,
      state: "awaiting-approval",
      stepsAllowed: 5,
    });
    expect(awaitingApprovalView.headline).toBe("Awaiting your approval to continue.");
    expect(awaitingApprovalView.canStop).toBe(false);

    const zeroStepsView = buildAgentRunView({
      ...baseInput,
      state: "running",
      stepsAllowed: 0,
    });
    expect(zeroStepsView.stepsAllowed).toBe(0);
    expect(zeroStepsView.headline).toBe("Working through step 3.");
  });

  it("correctly identifies answer and refusal steps and assigns null toolLabel", () => {
    const rawSteps: readonly RawAgentStep[] = [
      {
        index: 1,
        thought: "Formulating response",
        toolName: null,
        toolArgs: "",
        toolResult: "",
        toolFailed: false,
        answer: "I cannot fulfill this request as it asks for restricted information.",
        startedAt: 1000,
        endedAt: 1200,
      },
    ];

    const view = buildAgentRunView({
      runId: "run-6",
      caseId: "case-6",
      goal: "Restricted question",
      state: "failed",
      stepsAllowed: 1,
      steps: rawSteps,
      now: 1300,
    });

    const step1 = view.steps[0];
    expect(step1).toBeDefined();
    if (step1 !== undefined) {
      expect(step1.kind).toBe("refusal");
      expect(step1.title).toBe("Declined to answer");
      expect(step1.toolLabel).toBeNull();
      expect(step1.ok).toBe(false);
    }
  });
});
