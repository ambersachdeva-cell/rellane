import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelMenu, type Capability, type ProviderMenu } from "./ModelMenu.js";

// Provide showModal/close shims for jsdom environments where HTMLDialogElement is stubbed.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal =
    HTMLDialogElement.prototype.showModal ||
    function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  HTMLDialogElement.prototype.close =
    HTMLDialogElement.prototype.close ||
    function close(this: HTMLDialogElement) {
      this.open = false;
    };
}

const observedCap: Capability = {
  id: "long-context",
  title: "Long context",
  line: "Holds a full project in working memory",
  observed: true,
  because: "Observed in your recent case runs",
};

const unobservedCap: Capability = {
  id: "picks-effort",
  title: "Thinking effort",
  line: "Adjusts reasoning depth for harder problems",
  observed: false,
  because: "Not yet observed on this Mac",
};

const claudeMenu: ProviderMenu = {
  id: "claude",
  label: "Claude",
  family: "claude",
  usable: true,
  unusableBecause: null,
  capabilities: [observedCap, unobservedCap],
  models: [
    {
      id: "claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
      note: "Standard subscription model",
    },
    {
      id: "claude-3-5-haiku",
      label: "Claude 3.5 Haiku",
      note: "Fast answers",
    },
  ],
  effortLevels: [
    {
      id: "low",
      label: "Low effort",
      line: "Quick responses with minimal thinking time",
    },
    {
      id: "high",
      label: "High effort",
      line: "Deep thinking before answering difficult questions",
    },
  ],
  summary: "Anthropic Claude subscription on your Mac",
};

const codexMenu: ProviderMenu = {
  id: "codex",
  label: "Codex",
  family: "codex",
  usable: false,
  unusableBecause: "Not signed in on this Mac",
  capabilities: [],
  models: [],
  effortLevels: [],
  summary: "OpenAI Codex CLI runner",
};

const noEffortMenu: ProviderMenu = {
  id: "gemini",
  label: "Gemini",
  family: "gemini",
  usable: true,
  unusableBecause: null,
  capabilities: [observedCap],
  models: [
    {
      id: "gemini-2-5-pro",
      label: "Gemini 2.5 Pro",
      note: "Frontier reasoning",
    },
  ],
  effortLevels: [],
  summary: "Google Gemini Advanced subscription",
};

describe("ModelMenu", () => {
  it("calls onChoose with provider id when a usable card is clicked", () => {
    const onChoose = vi.fn();
    render(
      <ModelMenu
        menus={[claudeMenu, codexMenu]}
        chosenId={null}
        chosenModelId=""
        chosenEffort={null}
        onChoose={onChoose}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onClose={vi.fn()}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude/i }));
    expect(onChoose).toHaveBeenCalledWith("claude");
  });

  it("displays the unusable reason and does not call onChoose when clicking an unusable card", () => {
    const onChoose = vi.fn();
    render(
      <ModelMenu
        menus={[claudeMenu, codexMenu]}
        chosenId={null}
        chosenModelId=""
        chosenEffort={null}
        onChoose={onChoose}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onClose={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.getByText("Not signed in on this Mac")).toBeInTheDocument();
    const codexButton = screen.getByRole("button", { name: /Codex/i });
    fireEvent.click(codexButton);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("carries because in the document for unobserved capabilities and distinguishes them from observed", () => {
    render(
      <ModelMenu
        menus={[claudeMenu]}
        chosenId="claude"
        chosenModelId="claude-3-7-sonnet"
        chosenEffort={null}
        onChoose={vi.fn()}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onClose={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.getByText("Not yet observed on this Mac")).toBeInTheDocument();
    expect(screen.getByText("Observed")).toBeInTheDocument();
    expect(screen.getByText("Unchecked")).toBeInTheDocument();
  });

  it("calls onModel when a model option is chosen", () => {
    const onModel = vi.fn();
    render(
      <ModelMenu
        menus={[claudeMenu]}
        chosenId="claude"
        chosenModelId="claude-3-7-sonnet"
        chosenEffort={null}
        onChoose={vi.fn()}
        onModel={onModel}
        onEffort={vi.fn()}
        onClose={vi.fn()}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude 3.5 Haiku/i }));
    expect(onModel).toHaveBeenCalledWith("claude-3-5-haiku");
  });

  it("renders no effort controls when effortLevels is empty", () => {
    render(
      <ModelMenu
        menus={[noEffortMenu]}
        chosenId="gemini"
        chosenModelId="gemini-2-5-pro"
        chosenEffort={null}
        onChoose={vi.fn()}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onClose={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.queryByText("Thinking effort")).toBeNull();
    expect(screen.queryByRole("button", { name: /effort/i })).toBeNull();
  });

  it("renders effort levels and calls onEffort when one is clicked", () => {
    const onEffort = vi.fn();
    render(
      <ModelMenu
        menus={[claudeMenu]}
        chosenId="claude"
        chosenModelId="claude-3-7-sonnet"
        chosenEffort="low"
        onChoose={vi.fn()}
        onModel={vi.fn()}
        onEffort={onEffort}
        onClose={vi.fn()}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /High effort/i }));
    expect(onEffort).toHaveBeenCalledWith("high");
  });

  it("calls onClose when the close dialog button is pressed", () => {
    const onClose = vi.fn();
    render(
      <ModelMenu
        menus={[claudeMenu]}
        chosenId={null}
        chosenModelId=""
        chosenEffort={null}
        onChoose={vi.fn()}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onClose={onClose}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not trigger onChoose when disabled is true", () => {
    const onChoose = vi.fn();
    render(
      <ModelMenu
        menus={[claudeMenu]}
        chosenId={null}
        chosenModelId=""
        chosenEffort={null}
        onChoose={onChoose}
        onModel={vi.fn()}
        onEffort={vi.fn()}
        onClose={vi.fn()}
        disabled={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude/i }));
    expect(onChoose).not.toHaveBeenCalled();
  });
});
