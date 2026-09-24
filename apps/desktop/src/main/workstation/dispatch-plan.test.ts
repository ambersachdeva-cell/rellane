import { describe, expect, it } from "vitest";
import {
  planDispatch,
  MAX_STEPS,
  type AvailableProvider
} from "./dispatch-plan.js";

const CODEX: AvailableProvider = {
  id: "codex",
  label: "Codex",
  canApproveTools: true
};

const CLAUDE: AvailableProvider = {
  id: "claude",
  label: "Claude",
  canApproveTools: true
};

const GEMINI_1: AvailableProvider = {
  id: "gemini1",
  label: "Gemini 1",
  canApproveTools: false
};

const GEMINI_2: AvailableProvider = {
  id: "gemini2",
  label: "Gemini 2",
  canApproveTools: false
};

const GEMINI_3: AvailableProvider = {
  id: "gemini3",
  label: "Gemini 3",
  canApproveTools: false
};

const LOCAL_QWEN: AvailableProvider = {
  id: "qwen",
  label: "Local Qwen",
  canApproveTools: false
};

const EXTRA_PROVIDER: AvailableProvider = {
  id: "extra",
  label: "Extra Provider",
  canApproveTools: false
};

describe("planDispatch refusal conditions", () => {
  it("refuses when goal is empty", () => {
    const plan = planDispatch({
      goal: "",
      sourceIds: ["source-1"],
      providers: [CODEX]
    });
    expect(plan.steps).toEqual([]);
    expect(plan.parallel).toEqual([]);
    expect(plan.refusal).not.toBeNull();
    expect(plan.refusal?.length).toBeGreaterThan(0);
    expect(plan.summary).toBe("No steps can run.");
  });

  it("refuses when goal has only 5 characters", () => {
    const plan = planDispatch({
      goal: "Draft",
      sourceIds: ["source-1"],
      providers: [CODEX]
    });
    expect(plan.steps).toEqual([]);
    expect(plan.parallel).toEqual([]);
    expect(plan.refusal).not.toBeNull();
    expect(plan.refusal?.length).toBeGreaterThan(0);
  });

  it("refuses when goal is under 12 characters after trimming", () => {
    const plan = planDispatch({
      goal: "   Short goal   ",
      sourceIds: [],
      providers: [CODEX]
    });
    expect(plan.steps).toEqual([]);
    expect(plan.refusal).not.toBeNull();
  });

  it("refuses when no providers are available", () => {
    const plan = planDispatch({
      goal: "Research the market and then draft a summary",
      sourceIds: ["source-1"],
      providers: []
    });
    expect(plan.steps).toEqual([]);
    expect(plan.parallel).toEqual([]);
    expect(plan.refusal).not.toBeNull();
    expect(plan.refusal?.length).toBeGreaterThan(0);
  });
});

describe("planDispatch structural decomposition", () => {
  it("splits 'Research the market and then draft a summary' into two steps where the second depends on the first", () => {
    const plan = planDispatch({
      goal: "Research the market and then draft a summary",
      sourceIds: ["src-1", "src-2"],
      providers: [CODEX, CLAUDE]
    });

    expect(plan.refusal).toBeNull();
    expect(plan.steps).toHaveLength(2);

    const step1 = plan.steps[0]!;
    const step2 = plan.steps[1]!;

    expect(step1.id).toBe("step-1");
    expect(step1.title).toBe("Research the market");
    expect(step1.prompt).toBe("Research the market");
    expect(step1.providerId).toBe("codex");
    expect(step1.providerLabel).toBe("Codex");
    expect(step1.dependsOn).toEqual([]);

    expect(step2.id).toBe("step-2");
    expect(step2.title).toBe("Draft a summary");
    expect(step2.prompt).toBe("draft a summary");
    expect(step2.providerId).toBe("claude");
    expect(step2.providerLabel).toBe("Claude");
    expect(step2.dependsOn).toEqual(["step-1"]);

    expect(plan.parallel).toEqual(["step-1"]);
    expect(plan.summary).toBe(
      "2 steps planned across Codex and Claude, with 1 able to start at once."
    );
  });

  it("splits semicolon-separated goals into three parallel steps across three different providers", () => {
    const plan = planDispatch({
      goal: "Draft a reply; check the numbers; list the risks",
      sourceIds: ["src-1"],
      providers: [CODEX, CLAUDE, GEMINI_1]
    });

    expect(plan.refusal).toBeNull();
    expect(plan.steps).toHaveLength(3);

    const step1 = plan.steps[0]!;
    const step2 = plan.steps[1]!;
    const step3 = plan.steps[2]!;

    expect(step1.id).toBe("step-1");
    expect(step1.prompt).toBe("Draft a reply");
    expect(step1.providerId).toBe("codex");
    expect(step1.dependsOn).toEqual([]);

    expect(step2.id).toBe("step-2");
    expect(step2.prompt).toBe("check the numbers");
    expect(step2.providerId).toBe("claude");
    expect(step2.dependsOn).toEqual([]);

    expect(step3.id).toBe("step-3");
    expect(step3.prompt).toBe("list the risks");
    expect(step3.providerId).toBe("gemini1");
    expect(step3.dependsOn).toEqual([]);

    const assignedProviders = new Set(plan.steps.map((s) => s.providerId));
    expect(assignedProviders.size).toBe(3);

    expect(plan.parallel).toEqual(["step-1", "step-2", "step-3"]);
    expect(plan.summary).toBe(
      "3 steps planned across Codex, Claude and Gemini 1, with 3 able to start at once."
    );
  });

  it("caps steps at the provider count when there are more clauses than providers", () => {
    const plan = planDispatch({
      goal: "Draft a reply; check the numbers; list the risks",
      sourceIds: [],
      providers: [CODEX, CLAUDE]
    });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.providerId).toBe("codex");
    expect(plan.steps[1]!.providerId).toBe("claude");
    expect(plan.summary).toBe(
      "2 steps planned across Codex and Claude, with 2 able to start at once."
    );
  });

  it("caps steps at MAX_STEPS when there are more clauses than MAX_STEPS", () => {
    expect(MAX_STEPS).toBe(6);

    const goal =
      "Step one; step two; step three; step four; step five; step six; step seven; step eight";
    const providers = [
      CODEX,
      CLAUDE,
      GEMINI_1,
      GEMINI_2,
      GEMINI_3,
      LOCAL_QWEN,
      EXTRA_PROVIDER
    ];

    const plan = planDispatch({
      goal,
      sourceIds: [],
      providers
    });

    expect(plan.steps).toHaveLength(MAX_STEPS);
    expect(plan.steps.map((s) => s.id)).toEqual([
      "step-1",
      "step-2",
      "step-3",
      "step-4",
      "step-5",
      "step-6"
    ]);
  });

  it("produces exactly one step carrying the whole goal unchanged for an unstructured goal", () => {
    const goal =
      "Synthesise customer interviews from last month into three clear product recommendations";
    const plan = planDispatch({
      goal,
      sourceIds: ["source-abc"],
      providers: [CODEX, CLAUDE]
    });

    expect(plan.refusal).toBeNull();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.id).toBe("step-1");
    expect(plan.steps[0]!.prompt).toBe(goal);
    expect(plan.steps[0]!.providerId).toBe("codex");
    expect(plan.steps[0]!.providerLabel).toBe("Codex");
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.parallel).toEqual(["step-1"]);
    expect(plan.summary).toBe("1 step planned on Codex, with 1 able to start at once.");
  });

  it("ensures no step prompt contains text absent from the goal", () => {
    const goal = "Research the market and then draft a summary";
    const plan = planDispatch({
      goal,
      sourceIds: [],
      providers: [CODEX, CLAUDE]
    });

    expect(plan.steps.length).toBeGreaterThan(0);
    for (const step of plan.steps) {
      expect(goal).toContain(step.prompt);
    }
  });

  it("ensures every step carries every source id", () => {
    const sourceIds = ["doc-1", "doc-2", "doc-3"];
    const plan = planDispatch({
      goal: "Draft a reply; check the numbers; list the risks",
      sourceIds,
      providers: [CODEX, CLAUDE, GEMINI_1]
    });

    expect(plan.steps).toHaveLength(3);
    for (const step of plan.steps) {
      expect(step.sourceIds).toEqual(sourceIds);
    }
  });

  it("generates stable step-1..step-n ids identical across repeated calls", () => {
    const input = {
      goal: "Draft a reply; check the numbers; list the risks",
      sourceIds: ["doc-1"],
      providers: [CODEX, CLAUDE, GEMINI_1]
    };

    const plan1 = planDispatch(input);
    const plan2 = planDispatch(input);

    expect(plan1.steps.map((s) => s.id)).toEqual(["step-1", "step-2", "step-3"]);
    expect(plan2.steps.map((s) => s.id)).toEqual(["step-1", "step-2", "step-3"]);
    expect(plan1.steps.map((s) => s.id)).toEqual(plan2.steps.map((s) => s.id));
  });

  it("parses numbered line goals and detects dependencies from wording", () => {
    const goal = "1. Research the market\n2. Then draft from that";
    const plan = planDispatch({
      goal,
      sourceIds: [],
      providers: [CODEX, CLAUDE]
    });

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.prompt).toBe("Research the market");
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.steps[1]!.prompt).toBe("Then draft from that");
    expect(plan.steps[1]!.dependsOn).toEqual(["step-1"]);
    expect(plan.parallel).toEqual(["step-1"]);
  });

  it("parses bulleted lines as parallel when no dependency wording is present", () => {
    const goal =
      "- Audit the access logs\n- Check database permissions\n- Verify backup status";
    const plan = planDispatch({
      goal,
      sourceIds: [],
      providers: [CODEX, CLAUDE, GEMINI_1]
    });

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.steps[1]!.dependsOn).toEqual([]);
    expect(plan.steps[2]!.dependsOn).toEqual([]);
    expect(plan.parallel).toEqual(["step-1", "step-2", "step-3"]);
  });

  it("never assigns two steps to the same provider even if duplicate providers are provided", () => {
    const plan = planDispatch({
      goal: "Draft a reply; check the numbers; list the risks",
      sourceIds: [],
      providers: [CODEX, CODEX, CLAUDE]
    });

    expect(plan.steps).toHaveLength(2);
    const providerIds = plan.steps.map((s) => s.providerId);
    expect(new Set(providerIds).size).toBe(providerIds.length);
  });

  it("does not mutate input arguments", () => {
    const sourceIds = Object.freeze(["doc-1", "doc-2"]);
    const providers = Object.freeze([CODEX, CLAUDE]);
    const input = Object.freeze({
      goal: "Research the market and then draft a summary",
      sourceIds,
      providers
    });

    expect(() => planDispatch(input)).not.toThrow();
  });
});
