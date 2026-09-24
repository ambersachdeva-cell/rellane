import { describe, expect, it } from "vitest";
import { availableActions, matchActions } from "./quick-actions.js";
import type { ActionContext, QuickAction } from "./quick-actions.js";

describe("availableActions", () => {
  it("gates each action behind its specific rule with an explanatory reason", () => {
    const coldContext: ActionContext = {
      hasOpenWork: false,
      workClosed: false,
      hasOutput: false,
      hasSources: false,
      sessionRunning: false,
      inProject: false,
      providersDetected: 0
    };

    const coldActions = availableActions(coldContext);
    const byId = new Map(coldActions.map((a) => [a.id, a]));

    expect(byId.get("stop-session")?.disabledBecause).toBe(
      "You do not have a session running right now."
    );
    expect(byId.get("export-output")?.disabledBecause).toBe(
      "Generate an output first."
    );
    expect(byId.get("check-citations")?.disabledBecause).toBe(
      "Generate an output and attach sources first."
    );
    expect(byId.get("capture-screen")?.disabledBecause).toBe(
      "Open a piece of work first."
    );
    expect(byId.get("add-file")?.disabledBecause).toBe(
      "Open a piece of work first."
    );
    expect(byId.get("new-in-project")?.disabledBecause).toBe(
      "Open a project first."
    );
    expect(byId.get("switch-ai")?.disabledBecause).toBe(
      "Connect at least one AI provider first."
    );
    expect(byId.get("new-work")?.disabledBecause).toBeNull();
    expect(byId.get("run-routine")?.disabledBecause).toBeNull();
    expect(byId.get("open-folder")?.disabledBecause).toBeNull();
    expect(byId.get("show-record")?.disabledBecause).toBeNull();

    const warmContext: ActionContext = {
      hasOpenWork: true,
      workClosed: false,
      hasOutput: true,
      hasSources: true,
      sessionRunning: true,
      inProject: true,
      providersDetected: 2
    };

    const warmActions = availableActions(warmContext);
    for (const action of warmActions) {
      expect(action.disabledBecause).toBeNull();
    }
  });

  it("distinguishes closed work from missing work for file attachment and screen capture", () => {
    const closedContext: ActionContext = {
      hasOpenWork: true,
      workClosed: true,
      hasOutput: false,
      hasSources: false,
      sessionRunning: false,
      inProject: false,
      providersDetected: 1
    };

    const actions = availableActions(closedContext);
    const byId = new Map(actions.map((a) => [a.id, a]));

    expect(byId.get("add-file")?.disabledBecause).toBe(
      "Reopen this piece of work first."
    );
    expect(byId.get("capture-screen")?.disabledBecause).toBe(
      "Reopen this piece of work first."
    );
  });

  it("explains specific prerequisites when checking citations", () => {
    const missingSourcesOnly: ActionContext = {
      hasOpenWork: true,
      workClosed: false,
      hasOutput: true,
      hasSources: false,
      sessionRunning: false,
      inProject: false,
      providersDetected: 1
    };
    const withOutput = availableActions(missingSourcesOnly);
    const citationWithOutput = withOutput.find((a) => a.id === "check-citations");
    expect(citationWithOutput?.disabledBecause).toBe("Attach sources first.");

    const missingOutputOnly: ActionContext = {
      hasOpenWork: true,
      workClosed: false,
      hasOutput: false,
      hasSources: true,
      sessionRunning: false,
      inProject: false,
      providersDetected: 1
    };
    const withSources = availableActions(missingOutputOnly);
    const citationWithSources = withSources.find((a) => a.id === "check-citations");
    expect(citationWithSources?.disabledBecause).toBe("Generate an output first.");
  });

  it("retains all disabled actions in the returned list rather than hiding them", () => {
    const coldContext: ActionContext = {
      hasOpenWork: false,
      workClosed: false,
      hasOutput: false,
      hasSources: false,
      sessionRunning: false,
      inProject: false,
      providersDetected: 0
    };

    const actions = availableActions(coldContext);
    expect(actions).toHaveLength(11);
    const disabledCount = actions.filter((a) => a.disabledBecause !== null).length;
    expect(disabledCount).toBe(7);
  });
});

describe("matchActions", () => {
  const sampleContext: ActionContext = {
    hasOpenWork: true,
    workClosed: false,
    hasOutput: true,
    hasSources: true,
    sessionRunning: false,
    inProject: false,
    providersDetected: 1
  };

  it("finds add-file by pdf keyword and export by docx keyword", () => {
    const actions = availableActions(sampleContext);

    const pdfMatches = matchActions(actions, "pdf");
    expect(pdfMatches.length).toBeGreaterThan(0);
    const firstPdf = pdfMatches[0];
    expect(firstPdf?.id).toBe("add-file");

    const docxMatches = matchActions(actions, "docx");
    expect(docxMatches.length).toBeGreaterThan(0);
    const firstDocx = docxMatches[0];
    expect(firstDocx?.id).toBe("export-output");
  });

  it("ranks exact title match above prefix, substring, and keyword matches", () => {
    const customActions: readonly QuickAction[] = [
      {
        id: "export-output",
        title: "Send file",
        hint: "Send output to Mac",
        keywords: ["doc"],
        disabledBecause: null
      },
      {
        id: "add-file",
        title: "Document",
        hint: "Attach document",
        keywords: [],
        disabledBecause: null
      },
      {
        id: "capture-screen",
        title: "Doc",
        hint: "Capture screen",
        keywords: [],
        disabledBecause: null
      },
      {
        id: "new-work",
        title: "Doctor review",
        hint: "Start doctor review",
        keywords: [],
        disabledBecause: null
      }
    ];

    const results = matchActions(customActions, "doc");
    expect(results.map((a) => a.id)).toEqual([
      "capture-screen",
      "add-file",
      "new-work",
      "export-output"
    ]);
  });

  it("places enabled actions first when query is empty", () => {
    const mixedContext: ActionContext = {
      hasOpenWork: true,
      workClosed: false,
      hasOutput: false,
      hasSources: false,
      sessionRunning: false,
      inProject: false,
      providersDetected: 0
    };

    const actions = availableActions(mixedContext);
    const emptyResults = matchActions(actions, "");

    expect(emptyResults).toHaveLength(actions.length);

    let seenDisabled = false;
    for (const action of emptyResults) {
      if (action.disabledBecause !== null) {
        seenDisabled = true;
      } else {
        expect(seenDisabled).toBe(false);
      }
    }
  });

  it("produces deterministic ordering across repeated calls and independent of input order", () => {
    const actions = availableActions(sampleContext);

    const firstRun = matchActions(actions, "work");
    const secondRun = matchActions(actions, "work");
    expect(firstRun.map((a) => a.id)).toEqual(secondRun.map((a) => a.id));

    const reversedActions = [...actions].reverse();
    const fromReversed = matchActions(reversedActions, "work");
    expect(fromReversed.map((a) => a.id)).toEqual(firstRun.map((a) => a.id));
  });
});
