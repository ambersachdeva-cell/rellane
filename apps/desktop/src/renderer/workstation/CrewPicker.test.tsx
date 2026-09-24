import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CrewPicker, CrewStrip, type CrewSeatChoice } from "./CrewPicker.js";

const testSeats: readonly CrewSeatChoice[] = [
  {
    id: "claude",
    label: "Claude",
    family: "claude",
    detail: "Claude 3.7 Sonnet via CLI",
    usable: true,
  },
  {
    id: "codex",
    label: "Codex",
    family: "codex",
    detail: "OpenAI Codex via CLI",
    usable: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    family: "gemini",
    detail: "Gemini 2.5 Flash via CLI",
    usable: true,
  },
  {
    id: "local",
    label: "Local",
    family: "local",
    detail: "CLI tool not installed on this Mac",
    usable: false,
  },
];

describe("CrewPicker", () => {
  it("calls onToggle with seat id when toggling a subscription", () => {
    const handleToggle = vi.fn();
    const handleClear = vi.fn();

    render(
      <CrewPicker
        seats={testSeats}
        chosen={[]}
        onToggle={handleToggle}
        onClear={handleClear}
        max={2}
      />
    );

    const claudeButton = screen.getByRole("button", { name: /claude/i });
    fireEvent.click(claudeButton);

    expect(handleToggle).toHaveBeenCalledTimes(1);
    expect(handleToggle).toHaveBeenCalledWith("claude");
  });

  it("calls onToggle to deselect an already chosen subscription", () => {
    const handleToggle = vi.fn();
    const handleClear = vi.fn();

    render(
      <CrewPicker
        seats={testSeats}
        chosen={["claude"]}
        onToggle={handleToggle}
        onClear={handleClear}
        max={2}
      />
    );

    const claudeButton = screen.getByRole("button", { name: /claude/i });
    fireEvent.click(claudeButton);

    expect(handleToggle).toHaveBeenCalledTimes(1);
    expect(handleToggle).toHaveBeenCalledWith("claude");
  });

  it("refuses choosing past max with a plain sentence and does not call onToggle", () => {
    const handleToggle = vi.fn();
    const handleClear = vi.fn();

    render(
      <CrewPicker
        seats={testSeats}
        chosen={["claude", "codex"]}
        onToggle={handleToggle}
        onClear={handleClear}
        max={2}
      />
    );

    const geminiButton = screen.getByRole("button", { name: /gemini/i });
    fireEvent.click(geminiButton);

    expect(handleToggle).not.toHaveBeenCalled();
    expect(screen.getByText("You can choose up to 2 subscriptions.")).toBeDefined();
  });

  it("disables an unusable seat and presents its reason in the document", () => {
    const handleToggle = vi.fn();
    const handleClear = vi.fn();

    render(
      <CrewPicker
        seats={testSeats}
        chosen={[]}
        onToggle={handleToggle}
        onClear={handleClear}
        max={2}
      />
    );

    const localButton = screen.getByRole("button", { name: /local/i }) as HTMLButtonElement;
    expect(localButton.disabled).toBe(true);
    expect(screen.getByText("CLI tool not installed on this Mac")).toBeDefined();

    fireEvent.click(localButton);
    expect(handleToggle).not.toHaveBeenCalled();
  });

  it("announces chosen count and order through role status", () => {
    render(
      <CrewPicker
        seats={testSeats}
        chosen={["claude", "codex"]}
        onToggle={vi.fn()}
        onClear={vi.fn()}
        max={3}
      />
    );

    const statusElement = screen.getByRole("status");
    expect(statusElement.textContent).toContain("2 subscriptions chosen in order: Claude, Codex.");
  });

  it("calls onClear when clear button is clicked", () => {
    const handleClear = vi.fn();

    render(
      <CrewPicker
        seats={testSeats}
        chosen={["claude"]}
        onToggle={vi.fn()}
        onClear={handleClear}
        max={3}
      />
    );

    const clearButton = screen.getByRole("button", { name: /clear selection/i });
    fireEvent.click(clearButton);

    expect(handleClear).toHaveBeenCalledTimes(1);
  });
});

describe("CrewStrip", () => {
  it("renders chosen bots in order with positions and order hint", () => {
    render(
      <CrewStrip
        seats={testSeats}
        chosen={["gemini", "claude"]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        disabled={false}
      />
    );

    expect(screen.getByText("The first bot takes the first part.")).toBeDefined();
    expect(screen.getByText("Position 1")).toBeDefined();
    expect(screen.getByText("Position 2")).toBeDefined();
  });

  it("shows both bots in chosen order with positions and removes the first when clicked", () => {
    const handleRemove = vi.fn();
    const handleOpen = vi.fn();

    render(
      <CrewStrip
        seats={testSeats}
        chosen={["codex", "claude"]}
        onOpen={handleOpen}
        onRemove={handleRemove}
        disabled={false}
      />
    );

    const removeCodexButton = screen.getByRole("button", { name: /remove codex/i });
    fireEvent.click(removeCodexButton);

    expect(handleRemove).toHaveBeenCalledTimes(1);
    expect(handleRemove).toHaveBeenCalledWith("codex");
    expect(handleOpen).not.toHaveBeenCalled();
  });

  it("reads as a single bot when exactly one subscription is chosen", () => {
    const handleRemove = vi.fn();
    const handleOpen = vi.fn();

    render(
      <CrewStrip
        seats={testSeats}
        chosen={["claude"]}
        onOpen={handleOpen}
        onRemove={handleRemove}
        disabled={false}
      />
    );

    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.queryByText("The first bot takes the first part.")).toBeNull();
    expect(screen.queryByText("Position 1")).toBeNull();

    // The strip has two buttons naming this bot: the one that opens the picker
    // and the one that removes it. Match the opener by what it does.
    const triggerButton = screen.getByRole("button", { name: /choose subscriptions/i });
    fireEvent.click(triggerButton);
    expect(handleOpen).toHaveBeenCalledTimes(1);

    const removeButton = screen.getByRole("button", { name: /remove claude/i });
    fireEvent.click(removeButton);
    expect(handleRemove).toHaveBeenCalledWith("claude");
  });

  it("provides an open button when no bots are chosen", () => {
    const handleOpen = vi.fn();

    render(
      <CrewStrip
        seats={testSeats}
        chosen={[]}
        onOpen={handleOpen}
        onRemove={vi.fn()}
        disabled={false}
      />
    );

    const openButton = screen.getByRole("button", { name: /choose bots/i });
    fireEvent.click(openButton);
    expect(handleOpen).toHaveBeenCalledTimes(1);
  });
});
