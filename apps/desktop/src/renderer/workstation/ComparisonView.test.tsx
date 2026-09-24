import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ComparisonView,
  type Comparison,
} from "./ComparisonView.js";

// Native dialog polyfill for test environments where showModal is not implemented.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

describe("ComparisonView", () => {
  it("displays differences, agreements, and unique points under headings in words and keeps a chosen answer", () => {
    const onKeep = vi.fn();
    const onClose = vi.fn();

    const comparison: Comparison = {
      headline: "The bots agree on core facts but differ on timing.",
      differences: [
        {
          point: "Whether rollout should start in April or June",
          agreedBy: ["Claude"],
          missingFrom: ["Codex"],
        },
      ],
      agreements: [
        {
          point: "Budget remains fixed at ten thousand pounds",
          agreedBy: ["Claude", "Codex"],
          missingFrom: [],
        },
        {
          point: "Existing team will run initial testing",
          agreedBy: ["Claude", "Codex"],
          missingFrom: [],
        },
      ],
      only: [
        {
          label: "Claude",
          points: ["Recommend phased training before launch"],
        },
      ],
      lengths: [
        { label: "Claude", words: 420 },
        { label: "Codex", words: 310 },
      ],
      shortest: "Codex",
      longest: "Claude",
    };

    render(
      <ComparisonView
        comparison={comparison}
        onKeep={onKeep}
        onClose={onClose}
      />
    );

    // Section headings in words
    expect(screen.getByRole("heading", { name: "Where they differ" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "What they agree on" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Only one bot said this" })).toBeDefined();

    // The headline sentence appears
    expect(
      screen.getByText("The bots agree on core facts but differ on timing.")
    ).toBeDefined();

    // All four points appear under their respective sections
    expect(
      screen.getByText("Whether rollout should start in April or June")
    ).toBeDefined();
    expect(
      screen.getByText("Budget remains fixed at ten thousand pounds")
    ).toBeDefined();
    expect(
      screen.getByText("Existing team will run initial testing")
    ).toBeDefined();
    expect(
      screen.getByText("Recommend phased training before launch")
    ).toBeDefined();

    // Keep button calls onKeep with the provider label
    const keepClaudeBtn = screen.getByRole("button", { name: /keep claude/i });
    fireEvent.click(keepClaudeBtn);
    expect(onKeep).toHaveBeenCalledWith("Claude");
  });

  it("says plainly when there is nothing to compare and offers to close", () => {
    const onKeep = vi.fn();
    const onClose = vi.fn();

    const emptyComparison: Comparison = {
      headline: "",
      agreements: [],
      differences: [],
      only: [],
      lengths: [],
      shortest: "",
      longest: "",
    };

    render(
      <ComparisonView
        comparison={emptyComparison}
        onKeep={onKeep}
        onClose={onClose}
      />
    );

    expect(screen.getByText(/nothing to compare/i)).toBeDefined();

    const closeButton = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("shows bot chips for who said and who did not say each difference", () => {
    const comparison: Comparison = {
      headline: "Comparing findings",
      differences: [
        {
          point: "On-premise deployment timeline",
          agreedBy: ["Claude", "Gemini"],
          missingFrom: ["Codex"],
        },
      ],
      agreements: [],
      only: [],
      lengths: [
        { label: "Claude", words: 100 },
        { label: "Gemini", words: 110 },
        { label: "Codex", words: 90 },
      ],
      shortest: "Codex",
      longest: "Gemini",
    };

    render(
      <ComparisonView
        comparison={comparison}
        onKeep={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Said by")).toBeDefined();
    expect(screen.getByText("Not said by")).toBeDefined();
    // A bot is named on its chip and again in the lengths row, so asking for
    // exactly one of each would be asserting a layout, not that it is named.
    for (const label of ["Claude", "Gemini", "Codex"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("displays answer lengths in words and identifies the shortest and longest", () => {
    const onKeep = vi.fn();
    const comparison: Comparison = {
      headline: "Length summary",
      differences: [
        {
          point: "Contract length preference",
          agreedBy: ["Claude"],
          missingFrom: ["Codex"],
        },
      ],
      agreements: [],
      only: [],
      lengths: [
        { label: "Claude", words: 850 },
        { label: "Codex", words: 210 },
      ],
      shortest: "Codex",
      longest: "Claude",
    };

    render(
      <ComparisonView
        comparison={comparison}
        onKeep={onKeep}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("850 words")).toBeDefined();
    expect(screen.getByText("210 words")).toBeDefined();
    expect(screen.getByText("Shortest")).toBeDefined();
    expect(screen.getByText("Longest")).toBeDefined();

    const keepCodexBtn = screen.getByRole("button", { name: /keep codex/i });
    fireEvent.click(keepCodexBtn);
    expect(onKeep).toHaveBeenCalledWith("Codex");
  });
});
