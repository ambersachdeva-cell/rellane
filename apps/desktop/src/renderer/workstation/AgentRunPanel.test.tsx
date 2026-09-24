import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  AgentRunPanel,
  type AgentRunView,
  type AgentStepView,
} from "./AgentRunPanel.js";

/** Generates baseline view objects for test assertions. */
function makeRunView(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: "run-1",
    caseId: "case-1",
    goal: "Review financial statements",
    state: "running",
    steps: [],
    headline: "Working through the steps.",
    stepsUsed: 0,
    stepsAllowed: 5,
    canStop: true,
    ...overrides,
  };
}

describe("AgentRunPanel", () => {
  it("renders awaiting-approval state with Start and Cancel, and does not render Stop", () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const onStop = vi.fn();
    const view = makeRunView({ state: "awaiting-approval" });

    render(
      <AgentRunPanel
        view={view}
        onStart={onStart}
        onStop={onStop}
        onCancel={onCancel}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    const startButton = screen.getByRole("button", { name: "Start" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const stopButton = screen.queryByRole("button", { name: "Stop" });

    expect(startButton).not.toBeNull();
    expect(cancelButton).not.toBeNull();
    expect(stopButton).toBeNull();
  });

  it("calls onStart once when Start is clicked in awaiting-approval", () => {
    const onStart = vi.fn();
    const view = makeRunView({ state: "awaiting-approval" });

    render(
      <AgentRunPanel
        view={view}
        onStart={onStart}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel once when Cancel is clicked in awaiting-approval", () => {
    const onCancel = vi.fn();
    const view = makeRunView({ state: "awaiting-approval" });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={onCancel}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables Stop when canStop is false", () => {
    const view = makeRunView({ state: "running", canStop: false });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    const stopButton = screen.getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(true);
  });

  it("enables Stop and calls onStop once when canStop is true", () => {
    const onStop = vi.fn();
    const view = makeRunView({ state: "running", canStop: true });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={onStop}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    const stopButton = screen.getByRole("button", {
      name: "Stop",
    }) as HTMLButtonElement;
    expect(stopButton.disabled).toBe(false);

    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows failure reason on a failed run", () => {
    const reason = "Process terminated unexpectedly with code 1";
    const view = makeRunView({
      state: "failed",
      headline: reason,
      canStop: false,
    });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByText(reason)).not.toBeNull();
    expect(screen.getByText("Failed")).not.toBeNull();
  });

  it("does not crash when step list is empty and displays plain empty text", () => {
    const view = makeRunView({ steps: [] });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByText("No steps recorded yet.")).not.toBeNull();
  });

  it("renders the goal, progress, and every step title and detail", () => {
    const steps: readonly AgentStepView[] = [
      {
        index: 0,
        kind: "thought",
        title: "Plan the analysis",
        detail: "Identify balance sheet rows and columns",
        toolLabel: null,
        at: 1000,
        durationMs: 320,
        ok: true,
      },
      {
        index: 1,
        kind: "tool",
        title: "Read balance sheet",
        detail: "Parsed spreadsheets/q3.csv into memory",
        toolLabel: "spreadsheets/q3.csv",
        at: 1500,
        durationMs: 850,
        ok: true,
      },
      {
        index: 2,
        kind: "answer",
        title: "Summarise findings",
        detail: "Current ratio is 2.1, indicating solid solvency.",
        toolLabel: null,
        at: 2500,
        durationMs: 400,
        ok: true,
      },
    ];

    const view = makeRunView({
      goal: "Check solvency ratio for Q3",
      steps,
      stepsUsed: 3,
      stepsAllowed: 6,
      state: "done",
    });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByText("Check solvency ratio for Q3")).not.toBeNull();
    expect(screen.getByText("Step 3 of 6")).not.toBeNull();
    expect(screen.getByText("Plan the analysis")).not.toBeNull();
    expect(screen.getByText("Read balance sheet")).not.toBeNull();
    expect(screen.getByText("Summarise findings")).not.toBeNull();
    expect(screen.getByText("spreadsheets/q3.csv")).not.toBeNull();
    expect(screen.getByText("Worked")).not.toBeNull();
  });

  it("marks the live step with aria-current='step' when running", () => {
    const steps: readonly AgentStepView[] = [
      {
        index: 0,
        kind: "thought",
        title: "First step finished",
        detail: "Done thinking",
        toolLabel: null,
        at: 1000,
        durationMs: 200,
        ok: true,
      },
      {
        index: 1,
        kind: "tool",
        title: "Second step in progress",
        detail: "Still reading data",
        toolLabel: "data.csv",
        at: 1200,
        durationMs: null,
        ok: null,
      },
    ];

    const view = makeRunView({
      state: "running",
      steps,
      stepsUsed: 1,
      stepsAllowed: 4,
    });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(2);
    if (items.length >= 2) {
      expect(items[0]!.getAttribute("aria-current")).toBeNull();
      expect(items[1]!.getAttribute("aria-current")).toBe("step");
    }
  });

  it("does not mark any step with aria-current when done", () => {
    const steps: readonly AgentStepView[] = [
      {
        index: 0,
        kind: "thought",
        title: "All done",
        detail: "Finished",
        toolLabel: null,
        at: 1000,
        durationMs: 200,
        ok: true,
      },
    ];

    const view = makeRunView({
      state: "done",
      steps,
      stepsUsed: 1,
      stepsAllowed: 1,
    });

    render(
      <AgentRunPanel
        view={view}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(1);
    if (items.length >= 1) {
      expect(items[0]!.getAttribute("aria-current")).toBeNull();
    }
  });

  it("renders the right buttons for each of the seven states and calls the right callback", () => {
    // 1. planning
    {
      const onStop = vi.fn();
      const view = makeRunView({ state: "planning", canStop: true });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={onStop}
          onCancel={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />,
      );
      const stop = screen.getByRole("button", { name: "Stop" });
      fireEvent.click(stop);
      expect(onStop).toHaveBeenCalledTimes(1);
      unmount();
    }

    // 2. awaiting-approval
    {
      const onStart = vi.fn();
      const onCancel = vi.fn();
      const view = makeRunView({ state: "awaiting-approval" });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={onStart}
          onStop={vi.fn()}
          onCancel={onCancel}
          onClose={vi.fn()}
          busy={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      expect(onStart).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      unmount();
    }

    // 3. running
    {
      const onStop = vi.fn();
      const view = makeRunView({ state: "running", canStop: true });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={onStop}
          onCancel={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(onStop).toHaveBeenCalledTimes(1);
      unmount();
    }

    // 4. stopping
    {
      const view = makeRunView({ state: "stopping", canStop: false });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
          busy={false}
        />,
      );
      const stop = screen.getByRole("button", {
        name: "Stop",
      }) as HTMLButtonElement;
      expect(stop.disabled).toBe(true);
      unmount();
    }

    // 5. done
    {
      const onClose = vi.fn();
      const view = makeRunView({ state: "done", canStop: false });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={onClose}
          busy={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }

    // 6. stopped
    {
      const onClose = vi.fn();
      const view = makeRunView({ state: "stopped", canStop: false });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={onClose}
          busy={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }

    // 7. failed
    {
      const onClose = vi.fn();
      const view = makeRunView({ state: "failed", canStop: false });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={onClose}
          busy={false}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("disables actions when busy prop is true", () => {
    // In running
    {
      const view = makeRunView({ state: "running", canStop: true });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
          busy={true}
        />,
      );
      const stop = screen.getByRole("button", {
        name: "Stop",
      }) as HTMLButtonElement;
      expect(stop.disabled).toBe(true);
      unmount();
    }

    // In awaiting-approval
    {
      const view = makeRunView({ state: "awaiting-approval" });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
          busy={true}
        />,
      );
      const start = screen.getByRole("button", {
        name: "Start",
      }) as HTMLButtonElement;
      const cancel = screen.getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement;
      expect(start.disabled).toBe(true);
      expect(cancel.disabled).toBe(true);
      unmount();
    }

    // In done
    {
      const view = makeRunView({ state: "done", canStop: false });
      const { unmount } = render(
        <AgentRunPanel
          view={view}
          onStart={vi.fn()}
          onStop={vi.fn()}
          onCancel={vi.fn()}
          onClose={vi.fn()}
          busy={true}
        />,
      );
      const close = screen.getByRole("button", {
        name: "Close",
      }) as HTMLButtonElement;
      expect(close.disabled).toBe(true);
      unmount();
    }
  });
});
