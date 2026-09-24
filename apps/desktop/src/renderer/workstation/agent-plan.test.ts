import { describe, expect, it } from "vitest";
import { planAgentRun, type AgentPlanInput } from "./agent-plan.js";

function makeInput(overrides: Partial<AgentPlanInput> = {}): AgentPlanInput {
  return {
    goal: "Summarise the quarterly revenue and growth figures",
    sources: [
      { id: "s1", label: "q1.csv", chars: 1500 },
      { id: "s2", label: "q2.csv", chars: 2500 },
    ],
    toolLabels: ["Table calculator", "Web search"],
    stepsAllowed: 5,
    providerLabel: "Codex",
    ...overrides,
  };
}

describe("planAgentRun", () => {
  it("refuses blank goals with a readable reason", () => {
    const empty = planAgentRun(makeInput({ goal: "" }));
    expect(empty.refusedBecause).toBe("Please provide a goal. The goal cannot be blank.");
    expect(empty.steps).toHaveLength(0);
    expect(empty.leavesThisMac).toBe("Nothing leaves this Mac.");

    const whitespace = planAgentRun(makeInput({ goal: "   " }));
    expect(whitespace.refusedBecause).toBe("Please provide a goal. The goal cannot be blank.");
  });

  it("refuses goals under 3 characters", () => {
    const short = planAgentRun(makeInput({ goal: "hi" }));
    expect(short.refusedBecause).toBe("The goal must be at least 3 characters long.");
    expect(short.steps).toHaveLength(0);
  });

  it("refuses goals longer than 10,000 characters", () => {
    const longGoal = "a".repeat(10001);
    const result = planAgentRun(makeInput({ goal: longGoal }));
    expect(result.refusedBecause).toBe("The goal is too long. Please keep it under 10,000 characters.");
  });

  it("refuses when stepsAllowed is less than 1", () => {
    const zeroSteps = planAgentRun(makeInput({ stepsAllowed: 0 }));
    expect(zeroSteps.refusedBecause).toBe("Steps allowed must be at least 1.");

    const negativeSteps = planAgentRun(makeInput({ stepsAllowed: -3 }));
    expect(negativeSteps.refusedBecause).toBe("Steps allowed must be at least 1.");
  });

  it("lists exactly the source labels passed in order", () => {
    const plan = planAgentRun(
      makeInput({
        sources: [
          { id: "1", label: "sales.xlsx", chars: 100 },
          { id: "2", label: "notes.txt", chars: 200 },
          { id: "3", label: "summary.pdf", chars: 300 },
        ],
      }),
    );
    expect(plan.reads).toEqual(["sales.xlsx", "notes.txt", "summary.pdf"]);
  });

  it("names the subscription in leavesThisMac when provider is set", () => {
    const planWithSources = planAgentRun(makeInput({ providerLabel: "Codex" }));
    expect(planWithSources.leavesThisMac).toBe(
      "Your goal and selected sources will be sent to your Codex subscription.",
    );

    const planWithoutSources = planAgentRun(makeInput({ providerLabel: "Claude", sources: [] }));
    expect(planWithoutSources.leavesThisMac).toBe(
      "Your goal will be sent to your Claude subscription.",
    );
  });

  it("states nothing leaves this Mac when provider is empty or local", () => {
    const emptyProvider = planAgentRun(makeInput({ providerLabel: "" }));
    expect(emptyProvider.leavesThisMac).toBe("Nothing leaves this Mac.");

    const localProvider = planAgentRun(makeInput({ providerLabel: "Local" }));
    expect(localProvider.leavesThisMac).toBe("Nothing leaves this Mac.");
  });

  it("warns when there are no sources", () => {
    const plan = planAgentRun(makeInput({ sources: [] }));
    expect(plan.warnings).toContain("No files are selected, so it can only use what you typed.");
  });

  it("warns when a source exceeds 200,000 characters", () => {
    const plan = planAgentRun(
      makeInput({
        sources: [
          { id: "1", label: "large.csv", chars: 250000 },
          { id: "2", label: "small.csv", chars: 1000 },
        ],
      }),
    );
    expect(plan.warnings).toContain("large.csv is over 200,000 characters and may take longer to read.");
    expect(plan.warnings.some((w) => w.includes("small.csv"))).toBe(false);
  });

  it("does not warn for sources at or under 200,000 characters", () => {
    const plan = planAgentRun(
      makeInput({
        sources: [{ id: "1", label: "exact.csv", chars: 200000 }],
      }),
    );
    expect(plan.warnings.some((w) => w.includes("200,000"))).toBe(false);
  });

  it("warns when stepsAllowed is above 12", () => {
    const highSteps = planAgentRun(makeInput({ stepsAllowed: 13 }));
    expect(highSteps.warnings).toContain("This could take a while and use a lot of your subscription.");

    const normalSteps = planAgentRun(makeInput({ stepsAllowed: 12 }));
    expect(normalSteps.warnings).not.toContain("This could take a while and use a lot of your subscription.");
  });

  it("leads with understanding the question when goal contains a question word", () => {
    const plan = planAgentRun(makeInput({ goal: "What are the key findings in the documents?" }));
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0]!.title).toBe("Understand the question");
  });

  it("leads with reading files when goal mentions files without a question word", () => {
    const plan = planAgentRun(makeInput({ goal: "Summarise the spreadsheet and compare findings" }));
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0]!.title).toBe("Read the selected sources");
  });

  it("ends with producing a draft when asking to write or draft without sources", () => {
    const plan = planAgentRun(makeInput({ goal: "Draft an email thanking the speakers", sources: [] }));
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    const lastStep = plan.steps[plan.steps.length - 1]!;
    expect(lastStep.title).toBe("Produce the draft");
  });

  it("always ends with a checking step when there is at least one source", () => {
    const plan = planAgentRun(
      makeInput({
        goal: "Draft an email thanking the speakers based on the conference notes",
        sources: [{ id: "1", label: "notes.txt", chars: 500 }],
      }),
    );
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    const lastStep = plan.steps[plan.steps.length - 1]!;
    expect(lastStep.title).toBe("Check against sources");

    const previousStep = plan.steps[plan.steps.length - 2]!;
    expect(previousStep.title).toBe("Produce the draft");
  });

  it("preserves tool labels in mayUse", () => {
    const tools = ["Web search", "Code runner", "Calculator"];
    const plan = planAgentRun(makeInput({ toolLabels: tools }));
    expect(plan.mayUse).toEqual(tools);
  });

  it("ensures step count is always between 2 and 6 inclusive", () => {
    const minimal = planAgentRun(makeInput({ goal: "Check status", sources: [] }));
    expect(minimal.steps.length).toBeGreaterThanOrEqual(2);
    expect(minimal.steps.length).toBeLessThanOrEqual(6);

    const comprehensive = planAgentRun(
      makeInput({
        goal: "What are the missing invoices in the files? Draft a follow-up letter.",
        sources: [{ id: "1", label: "invoices.csv", chars: 4000 }],
      }),
    );
    expect(comprehensive.steps.length).toBeGreaterThanOrEqual(2);
    expect(comprehensive.steps.length).toBeLessThanOrEqual(6);
  });
});
