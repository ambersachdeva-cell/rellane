import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  DispatchPanel,
  type DispatchBoard,
  type DispatchLane,
  type DispatchPanelProps,
} from "./DispatchPanel.js";

const testProviders: DispatchPanelProps["providers"] = [
  {
    id: "claude",
    label: "Claude 3.5 Sonnet",
    usable: true,
    detail: "Ready to run",
    models: [{ id: "sonnet", label: "Sonnet" }],
  },
  {
    id: "gemini",
    label: "Gemini 1.5 Pro",
    usable: true,
    detail: "Ready to run",
    models: [{ id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" }],
  },
  {
    id: "codex",
    label: "Codex CLI",
    usable: true,
    detail: "Ready to run",
    models: [],
  },
  {
    id: "local-qwen",
    label: "Local Qwen",
    usable: false,
    detail: "Ollama not running",
    models: [],
  },
];

interface TestHarnessOptions {
  readonly providers?: DispatchPanelProps["providers"];
  readonly board?: DispatchBoard | null;
  readonly answers?: DispatchPanelProps["answers"];
  readonly sourceCount?: number;
  readonly busy?: boolean;
}

function renderPanel(options: TestHarnessOptions = {}) {
  const onSend = vi.fn();
  const onStopLane = vi.fn();
  const onStopAll = vi.fn();
  const onCompare = vi.fn();
  const onKeep = vi.fn();
  const onClose = vi.fn();

  const props: DispatchPanelProps = {
    providers: options.providers ?? testProviders,
    board: options.board !== undefined ? options.board : null,
    answers: options.answers ?? [],
    sourceCount: options.sourceCount ?? 2,
    onSend,
    onStopLane,
    onStopAll,
    onCompare,
    onKeep,
    onClose,
    busy: options.busy ?? false,
  };

  const view = render(<DispatchPanel {...props} />);

  return {
    ...view,
    onSend,
    onStopLane,
    onStopAll,
    onCompare,
    onKeep,
    onClose,
  };
}

describe("DispatchPanel", () => {
  it("names the right count on the send button and disables it with empty brief or no selection", () => {
    const { onSend } = renderPanel();

    const sendButton = screen.getByRole("button", { name: "Send to 0 bots" });
    expect(sendButton).toBeDisabled();

    const claudeCard = screen.getByRole("button", { name: /claude 3\.5 sonnet/i });
    expect(claudeCard).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(claudeCard);
    expect(claudeCard).toHaveAttribute("aria-pressed", "true");

    expect(screen.getByRole("button", { name: "Send to 1 bot" })).toBeDisabled();

    const briefInput = screen.getByRole("textbox", { name: "Brief" });
    fireEvent.change(briefInput, { target: { value: "Review VAT filings" } });

    const enabledSendButton = screen.getByRole("button", { name: "Send to 1 bot" });
    expect(enabledSendButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Claude 3.5 Sonnet model"), { target: { value: "sonnet" } });
    expect(enabledSendButton).not.toBeDisabled();

    const geminiCard = screen.getByRole("button", { name: /gemini 1\.5 pro/i });
    fireEvent.click(geminiCard);

    const multiSendButton = screen.getByRole("button", { name: "Send to 2 bots" });
    fireEvent.change(screen.getByLabelText("Gemini 1.5 Pro model"), { target: { value: "gemini-1.5-pro" } });
    expect(multiSendButton).not.toBeDisabled();

    fireEvent.click(multiSendButton);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Review VAT filings", [
      { providerId: "claude", modelId: "sonnet" },
      { providerId: "gemini", modelId: "gemini-1.5-pro" }
    ]);
  });

  it("excludes an unavailable bot from the count and shows why it cannot run", () => {
    const { onSend } = renderPanel();

    expect(screen.getByText("Ollama not running")).toBeInTheDocument();

    const briefInput = screen.getByRole("textbox", { name: "Brief" });
    fireEvent.change(briefInput, { target: { value: "Check server metrics" } });

    const unusableCard = screen.getByRole("button", { name: /local qwen/i });
    fireEvent.click(unusableCard);
    expect(unusableCard).toHaveAttribute("aria-pressed", "true");

    const sendButton = screen.getByRole("button", { name: "Send to 0 bots" });
    expect(sendButton).toBeDisabled();

    const codexCard = screen.getByRole("button", { name: /codex cli/i });
    fireEvent.click(codexCard);

    const activeSendButton = screen.getByRole("button", { name: "Send to 1 bot" });
    expect(activeSendButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Codex CLI model"), { target: { value: "gpt-5-codex" } });
    expect(activeSendButton).not.toBeDisabled();

    fireEvent.click(activeSendButton);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Check server metrics", [{ providerId: "codex", modelId: "gpt-5-codex" }]);
  });

  it("calls onStopLane with provider id when stop is pressed on a working lane", () => {
    const board: DispatchBoard = {
      runId: "run-101",
      caseId: "case-99",
      brief: "Investigate tax anomalies",
      headline: "Two bots investigating your brief.",
      working: 2,
      answered: 0,
      done: false,
      lanes: [
        {
          providerId: "claude",
          label: "Claude",
          state: "working",
          line: "Reading expense ledger…",
          elapsed: "14s",
          answerTurnId: null,
          chars: 0,
          canStop: true,
        },
        {
          providerId: "gemini",
          label: "Gemini",
          state: "working",
          line: "Cross-referencing supplier invoices…",
          elapsed: "9s",
          answerTurnId: null,
          chars: 0,
          canStop: true,
        },
      ],
    };

    const { onStopLane } = renderPanel({ board });

    const stopClaudeButton = screen.getByRole("button", { name: "Stop Claude" });
    fireEvent.click(stopClaudeButton);

    expect(onStopLane).toHaveBeenCalledTimes(1);
    expect(onStopLane).toHaveBeenCalledWith("claude");
  });

  it("shows compare answers only once two lanes have answered", () => {
    const lane1: DispatchLane = {
      providerId: "claude",
      label: "Claude",
      state: "working",
      line: "Synthesising evidence…",
      elapsed: "11s",
      answerTurnId: null,
      chars: 0,
      canStop: true,
    };
    const lane2: DispatchLane = {
      providerId: "gemini",
      label: "Gemini",
      state: "working",
      line: "Building timeline…",
      elapsed: "10s",
      answerTurnId: null,
      chars: 0,
      canStop: true,
    };
    const lane3: DispatchLane = {
      providerId: "codex",
      label: "Codex",
      state: "working",
      line: "Searching repository…",
      elapsed: "6s",
      answerTurnId: null,
      chars: 0,
      canStop: true,
    };

    const zeroAnsweredBoard: DispatchBoard = {
      runId: "run-200",
      caseId: "case-88",
      brief: "Compare vendor quotes",
      headline: "Three bots working on your brief.",
      working: 3,
      answered: 0,
      done: false,
      lanes: [lane1, lane2, lane3],
    };

    const { rerender, onCompare } = renderPanel({ board: zeroAnsweredBoard });

    expect(screen.getAllByText("Working")).toHaveLength(3);
    expect(
      screen.queryByRole("button", { name: /compare answers/i }),
    ).not.toBeInTheDocument();

    const oneAnsweredBoard: DispatchBoard = {
      ...zeroAnsweredBoard,
      headline: "1 of 3 bots answered.",
      working: 2,
      answered: 1,
      lanes: [
        {
          ...lane1,
          state: "answered",
          line: "Finished vendor analysis",
          elapsed: "18s",
          answerTurnId: "turn-1",
          chars: 350,
          canStop: false,
        },
        lane2,
        lane3,
      ],
    };

    rerender(
      <DispatchPanel
        providers={testProviders}
        board={oneAnsweredBoard}
        answers={[]}
        sourceCount={2}
        onSend={vi.fn()}
        onStopLane={vi.fn()}
        onStopAll={vi.fn()}
        onCompare={onCompare}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByText("Answered")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /compare answers/i }),
    ).not.toBeInTheDocument();

    const twoAnsweredBoard: DispatchBoard = {
      ...zeroAnsweredBoard,
      headline: "2 of 3 bots answered.",
      working: 1,
      answered: 2,
      lanes: [
        {
          ...lane1,
          state: "answered",
          line: "Finished vendor analysis",
          elapsed: "18s",
          answerTurnId: "turn-1",
          chars: 350,
          canStop: false,
        },
        {
          ...lane2,
          state: "answered",
          line: "Completed fee comparison",
          elapsed: "22s",
          answerTurnId: "turn-2",
          chars: 420,
          canStop: false,
        },
        lane3,
      ],
    };

    rerender(
      <DispatchPanel
        providers={testProviders}
        board={twoAnsweredBoard}
        answers={[]}
        sourceCount={2}
        onSend={vi.fn()}
        onStopLane={vi.fn()}
        onStopAll={vi.fn()}
        onCompare={onCompare}
        onKeep={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />,
    );

    const compareButton = screen.getByRole("button", {
      name: /compare answers/i,
    });
    expect(compareButton).toBeInTheDocument();

    fireEvent.click(compareButton);
    expect(onCompare).toHaveBeenCalledTimes(1);
  });

  it("toggles full answer with Read it all and calls onKeep when keeping an answer", () => {
    const fullText =
      "Detailed analysis reveals supplier margins are 14% higher than industry average across hardware components.";
    const board: DispatchBoard = {
      runId: "run-300",
      caseId: "case-77",
      brief: "Audit hardware pricing",
      headline: "All bots finished.",
      working: 0,
      answered: 1,
      done: true,
      lanes: [
        {
          providerId: "claude",
          label: "Claude",
          state: "answered",
          line: "Audit completed",
          elapsed: "15s",
          answerTurnId: "turn-1",
          chars: fullText.length,
          canStop: false,
        },
      ],
    };

    const answers = [{ providerId: "claude", text: fullText }];
    const { onKeep } = renderPanel({ board, answers });

    const readAllButton = screen.getByRole("button", { name: "Read it all" });
    expect(readAllButton).toBeInTheDocument();
    fireEvent.click(readAllButton);
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();

    const keepButton = screen.getByRole("button", {
      name: "Keep answer from Claude",
    });
    fireEvent.click(keepButton);
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledWith("claude");
  });
});
