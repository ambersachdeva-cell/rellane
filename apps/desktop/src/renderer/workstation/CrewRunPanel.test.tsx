import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  CrewRunPanel,
  type CrewRunView,
  type CrewPartView,
} from "./CrewRunPanel.js";

describe("CrewRunPanel", () => {
  it("renders both parts with their bots, titles, elapsed times, and states", () => {
    const view: CrewRunView = {
      runId: "run-1",
      caseId: "case-1",
      request: "Split company research and proposal drafting",
      round: "working",
      headline: "Two bots, one job each, so neither repeats the other.",
      canStop: true,
      parts: [
        {
          id: "part-a",
          title: "Part A",
          seatLabel: "Claude",
          state: "answered",
          line: "Market research finished.",
          elapsed: "45 sec",
          answerTurnId: "turn-1",
          refinedFrom: [],
          canStop: false,
        },
        {
          id: "part-b",
          title: "Part B",
          seatLabel: "Gemini",
          state: "working",
          line: "Drafting the proposal.",
          elapsed: "12 sec",
          answerTurnId: null,
          refinedFrom: [],
          canStop: true,
        },
      ],
    };

    const answers = [
      {
        partId: "part-a",
        text: "The market is growing by eight percent annually across Europe.",
      },
    ];

    render(
      <CrewRunPanel
        view={view}
        answers={answers}
        onStopPart={vi.fn()}
        onStopAll={vi.fn()}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(
      screen.getByText("Split company research and proposal drafting")
    ).toBeTruthy();
    // "Working" is both the round at the top and this part's own state, so
    // asking for exactly one of them is asserting a layout, not a state.
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Two bots, one job each, so neither repeats the other."
      )
    ).toBeTruthy();

    expect(screen.getByText("Part A")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getByText("45 sec")).toBeTruthy();

    expect(screen.getByText("Part B")).toBeTruthy();
    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Drafting the proposal.")).toBeTruthy();
    expect(screen.getByText("12 sec")).toBeTruthy();
  });

  it("calls onStopPart with part id when stopping an active part and disables stop when canStop is false", () => {
    const handleStopPart = vi.fn();

    const view: CrewRunView = {
      runId: "run-1",
      caseId: "case-1",
      request: "Evaluate two suppliers",
      round: "working",
      headline: "Two bots active.",
      canStop: true,
      parts: [
        {
          id: "part-a",
          title: "Part A",
          seatLabel: "Claude",
          state: "answered",
          line: "Finished supplier review.",
          elapsed: "1 min",
          answerTurnId: "turn-1",
          refinedFrom: [],
          canStop: false,
        },
        {
          id: "part-b",
          title: "Part B",
          seatLabel: "Gemini",
          state: "working",
          line: "Checking terms.",
          elapsed: "20 sec",
          answerTurnId: null,
          refinedFrom: [],
          canStop: true,
        },
      ],
    };

    render(
      <CrewRunPanel
        view={view}
        answers={[]}
        onStopPart={handleStopPart}
        onStopAll={vi.fn()}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    const stopButtons = screen.getAllByRole("button", { name: "Stop" });
    expect(stopButtons.length).toBe(2);

    // Claude is already answered and cannot be stopped
    const claudeStop = stopButtons[0]!;
    expect((claudeStop as HTMLButtonElement).disabled).toBe(true);

    // Gemini is still working and can be stopped
    const geminiStop = stopButtons[1]!;
    expect((geminiStop as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(geminiStop);
    expect(handleStopPart).toHaveBeenCalledTimes(1);
    expect(handleStopPart).toHaveBeenCalledWith("part-b");
  });

  it("names the part it waits for by title rather than by raw identifier", () => {
    const view: CrewRunView = {
      runId: "run-1",
      caseId: "case-1",
      request: "Draft contract after research",
      round: "working",
      headline: "One bot waiting for another.",
      canStop: true,
      parts: [
        {
          id: "id-research",
          title: "Vendor Research",
          seatLabel: "Claude",
          state: "working",
          line: "Gathering pricing tables.",
          elapsed: "30 sec",
          answerTurnId: null,
          refinedFrom: [],
          canStop: true,
        },
        {
          id: "id-contract",
          title: "Contract Drafting",
          seatLabel: "Gemini",
          state: "waiting",
          line: "Waiting for id-research",
          elapsed: "30 sec",
          answerTurnId: null,
          refinedFrom: [],
          canStop: false,
          dependsOn: ["id-research"],
        },
      ],
    };

    render(
      <CrewRunPanel
        view={view}
        answers={[]}
        onStopPart={vi.fn()}
        onStopAll={vi.fn()}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    // What must hold is that the id is resolved to a title. The exact sentence
    // is the caller's — in the app the line already arrives phrased, and this
    // component resolves ids inside it rather than rewriting it.
    expect(screen.queryByText(/id-research/u)).toBeNull();
    expect(
      screen.getByText(/Waiting for Vendor Research/u)
    ).toBeTruthy();
    expect(screen.queryByText(/id-research/)).toBeNull();
  });

  it("shows when a part read another before revising", () => {
    const view: CrewRunView = {
      runId: "run-1",
      caseId: "case-1",
      request: "Review and refine plan",
      round: "reading-each-other",
      headline: "Comparing notes.",
      canStop: true,
      parts: [
        {
          id: "part-1",
          title: "Part A",
          seatLabel: "Claude",
          state: "done",
          line: "Completed initial outline.",
          elapsed: "1 min",
          answerTurnId: "turn-1",
          refinedFrom: [],
          canStop: false,
        },
        {
          id: "part-2",
          title: "Part B",
          seatLabel: "Gemini",
          state: "refining",
          line: "Revising recommendations.",
          elapsed: "40 sec",
          answerTurnId: "turn-2",
          refinedFrom: ["part-1"],
          canStop: true,
        },
      ],
    };

    render(
      <CrewRunPanel
        view={view}
        answers={[]}
        onStopPart={vi.fn()}
        onStopAll={vi.fn()}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("Read Part A before revising.")).toBeTruthy();
  });

  it("allows reading full answer and keeping answer as output", () => {
    const handleKeep = vi.fn();
    const longAnswer = "Line one of the analysis. ".repeat(20);

    const view: CrewRunView = {
      runId: "run-1",
      caseId: "case-1",
      request: "Full analysis",
      round: "done",
      headline: "Finished all parts.",
      canStop: false,
      parts: [
        {
          id: "part-1",
          title: "Analysis",
          seatLabel: "Claude",
          state: "answered",
          line: "Finished analysis.",
          elapsed: "2 min",
          answerTurnId: "turn-1",
          refinedFrom: [],
          canStop: false,
        },
      ],
    };

    const answers = [
      {
        partId: "part-1",
        text: longAnswer,
      },
    ];

    render(
      <CrewRunPanel
        view={view}
        answers={answers}
        onStopPart={vi.fn()}
        onStopAll={vi.fn()}
        onKeep={handleKeep}
        onClose={vi.fn()}
        busy={false}
      />
    );

    const toggleButton = screen.getByRole("button", {
      name: "Read full answer",
    });
    fireEvent.click(toggleButton);

    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();

    const keepButton = screen.getByRole("button", { name: "Keep answer" });
    fireEvent.click(keepButton);

    expect(handleKeep).toHaveBeenCalledTimes(1);
    expect(handleKeep).toHaveBeenCalledWith("part-1");
  });

  it("handles stop all and close actions from header controls", () => {
    const handleStopAll = vi.fn();
    const handleClose = vi.fn();

    const view: CrewRunView = {
      runId: "run-1",
      caseId: "case-1",
      request: "Review draft",
      round: "working",
      headline: "Working on parts.",
      canStop: true,
      parts: [],
    };

    render(
      <CrewRunPanel
        view={view}
        answers={[]}
        onStopPart={vi.fn()}
        onStopAll={handleStopAll}
        onClose={handleClose}
        onKeep={vi.fn()}
        busy={false}
      />
    );

    const stopAllBtn = screen.getByRole("button", {
      name: "Stop everything",
    });
    fireEvent.click(stopAllBtn);
    expect(handleStopAll).toHaveBeenCalledTimes(1);

    const closeBtn = screen.getByRole("button", { name: "Close panel" });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("renders a calm empty state when no parts are assigned yet", () => {
    const view: CrewRunView = {
      runId: "run-empty",
      caseId: "case-empty",
      request: "Empty run",
      round: "splitting",
      headline: "Preparing plan.",
      canStop: false,
      parts: [],
    };

    render(
      <CrewRunPanel
        view={view}
        answers={[]}
        onStopPart={vi.fn()}
        onStopAll={vi.fn()}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("No work has been divided yet.")).toBeTruthy();
  });
});
