import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentEditor, formatSavedAt, extractHeadings } from "./AgentEditor.js";

describe("extractHeadings", () => {
  it("extracts headings with levels and text", () => {
    const markdown = ["# First Heading", "Some intro text", "## Second Heading", "### Third Heading"].join("\n");
    const headings = extractHeadings(markdown);
    expect(headings).toEqual([
      { level: 1, text: "First Heading", line: 1 },
      { level: 2, text: "Second Heading", line: 3 },
      { level: 3, text: "Third Heading", line: 4 },
    ]);
  });

  it("ignores hash symbols inside code blocks", () => {
    const markdown = [
      "# Document Title",
      "```bash",
      "# This is a shell comment",
      "echo 1",
      "```",
      "## Section Two",
    ].join("\n");
    const headings = extractHeadings(markdown);
    expect(headings).toEqual([
      { level: 1, text: "Document Title", line: 1 },
      { level: 2, text: "Section Two", line: 6 },
    ]);
  });
});

describe("formatSavedAt", () => {
  it("returns null when savedAt is null", () => {
    expect(formatSavedAt(null, 1700000000000)).toBeNull();
  });

  it("formats recent timestamps in plain British English", () => {
    const now = 1700000000000;
    expect(formatSavedAt(now - 10000, now)).toBe("saved just now");
    expect(formatSavedAt(now - 60000, now)).toBe("saved 1 minute ago");
    expect(formatSavedAt(now - 120000, now)).toBe("saved 2 minutes ago");
    expect(formatSavedAt(now - 3600000, now)).toBe("saved 1 hour ago");
    expect(formatSavedAt(now - 7200000, now)).toBe("saved 2 hours ago");
  });
});

describe("AgentEditor", () => {
  it("calls onChange with new text when typing in the textarea", () => {
    const onChange = vi.fn();
    render(
      <AgentEditor
        id="researcher"
        origin="mine"
        markdown="Initial draft"
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={onChange}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText("Agent instructions");
    fireEvent.change(textarea, { target: { value: "Updated instructions" } });
    expect(onChange).toHaveBeenCalledWith("Updated instructions");
  });

  it("inserts two spaces when pressing Tab in the textarea", () => {
    const onChange = vi.fn();
    render(
      <AgentEditor
        id="researcher"
        origin="mine"
        markdown="Prefix"
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={onChange}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText("Agent instructions") as HTMLTextAreaElement;
    textarea.selectionStart = 6;
    textarea.selectionEnd = 6;
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(onChange).toHaveBeenCalledWith("Prefix  ");
  });

  it("disables Save and Try it when check has a problem, and displays problem sentence", () => {
    render(
      <AgentEditor
        id="researcher"
        origin="mine"
        markdown="Draft"
        check={{
          ok: false,
          problems: ["The instructions need a clear goal statement."],
          hints: ["Adding bullet points helps readability."],
        }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("The instructions need a clear goal statement.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Try it" })).toBeDisabled();
  });

  it("allows Save when check only has hints", () => {
    render(
      <AgentEditor
        id="researcher"
        origin="mine"
        markdown="Draft"
        check={{
          ok: true,
          problems: [],
          hints: ["Consider stating when not to use this agent."],
        }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Consider stating when not to use this agent.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Try it" })).toBeEnabled();
  });

  it("renders bundled agent read-only with start my own action and no Save", () => {
    const onSave = vi.fn();
    render(
      <AgentEditor
        id="meeting-action-items"
        origin="bundled"
        markdown={"# Meeting Action Items\n\nTurn notes into tickets."}
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={onSave}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText("Agent instructions");
    expect(textarea).toHaveAttribute("readonly");
    expect(screen.getByText(/one of the agents that came with the app/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    const forkButton = screen.getByRole("button", { name: "Start my own from this" });
    expect(forkButton).toBeEnabled();
    fireEvent.click(forkButton);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("renders headings outline from markdown", () => {
    render(
      <AgentEditor
        id="my-agent"
        origin="mine"
        markdown={"# Overview\n\nBody text\n\n## Inputs\n\nDetails"}
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("Inputs")).toBeInTheDocument();
  });

  it("asks before closing when text has unsaved changes", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <AgentEditor
        id="my-agent"
        origin="mine"
        markdown="Initial"
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={onClose}
      />
    );

    rerender(
      <AgentEditor
        id="my-agent"
        origin="mine"
        markdown="Initial with edits"
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes immediately without asking when there are no unsaved changes", () => {
    const onClose = vi.fn();
    render(
      <AgentEditor
        id="my-agent"
        origin="mine"
        markdown="Clean state"
        check={{ ok: true, problems: [], hints: [] }}
        saving={false}
        savedAt={null}
        now={1700000000000}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onRun={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });
});
