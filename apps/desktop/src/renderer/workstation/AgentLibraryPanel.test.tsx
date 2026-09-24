import { render, screen, fireEvent } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentLibraryPanel, type AgentCard } from "./AgentLibraryPanel.js";

beforeAll(() => {
  if (typeof HTMLDialogElement !== "undefined") {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement): void {
        this.open = true;
      };
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function (this: HTMLDialogElement): void {
        this.open = false;
      };
    }
  }
});

const sampleAgents: readonly AgentCard[] = [
  {
    id: "agent-mine-1",
    origin: "mine",
    name: "VAT Return Reviewer",
    summary: "Checks quarterly VAT drafts against local invoice ledger.",
    updatedAt: 1_700_000_000_000 - 600_000,
  },
  {
    id: "agent-bundled-1",
    origin: "bundled",
    name: "Contract Auditor",
    summary: "Scans contracts for indemnity clauses and governing law.",
    updatedAt: 1_600_000_000_000,
  },
];

describe("AgentLibraryPanel", () => {
  it("explains what an agent is and offers to start one when the library is empty", () => {
    const onNew = vi.fn();
    render(
      <AgentLibraryPanel
        agents={[]}
        now={1_700_000_000_000}
        onOpen={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onNew={onNew}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(
      screen.getByText("An agent is a page of instructions a bot follows.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You can write your own instructions to guide how a bot works, or start from an existing one."
      )
    ).toBeInTheDocument();

    const startButton = screen.getByRole("button", { name: "Start an agent" });
    fireEvent.click(startButton);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("renders user-written agents before bundled agents under separate headings", () => {
    render(
      <AgentLibraryPanel
        agents={sampleAgents}
        now={1_700_000_000_000}
        onOpen={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onNew={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(headings.length).toBe(2);
    expect(headings[0]!.textContent).toBe("Agents you wrote");
    expect(headings[1]!.textContent).toBe("Came with the app");
  });

  it("renders bundled agents with Open and 'Start my own from this', no delete button, and no date", () => {
    const onOpen = vi.fn();
    const onDuplicate = vi.fn();

    render(
      <AgentLibraryPanel
        agents={[sampleAgents[1]!]}
        now={1_700_000_000_000}
        onOpen={onOpen}
        onDuplicate={onDuplicate}
        onDelete={vi.fn()}
        onNew={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    const openButton = screen.getByRole("button", { name: "Open Contract Auditor" });
    const startMyOwnButton = screen.getByRole("button", {
      name: "Start my own from Contract Auditor",
    });

    expect(openButton).toBeInTheDocument();
    expect(startMyOwnButton).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Updated/i)).not.toBeInTheDocument();

    fireEvent.click(openButton);
    expect(onOpen).toHaveBeenCalledWith("agent-bundled-1");

    fireEvent.click(startMyOwnButton);
    expect(onDuplicate).toHaveBeenCalledWith("agent-bundled-1");
  });

  it("shows relative update time for user agents and asks for confirmation naming the agent before deleting", () => {
    const onDelete = vi.fn();

    render(
      <AgentLibraryPanel
        agents={sampleAgents}
        now={1_700_000_000_000}
        onOpen={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={onDelete}
        onNew={vi.fn()}
        onClose={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByText("10 minutes ago")).toBeInTheDocument();

    const initialDeleteButton = screen.getByRole("button", {
      name: "Delete VAT Return Reviewer",
    });
    fireEvent.click(initialDeleteButton);
    expect(onDelete).not.toHaveBeenCalled();

    expect(screen.getByText("Delete VAT Return Reviewer?")).toBeInTheDocument();

    const cancelButton = screen.getByRole("button", {
      name: "Cancel deleting VAT Return Reviewer",
    });
    fireEvent.click(cancelButton);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete VAT Return Reviewer?")).not.toBeInTheDocument();

    const reDeleteButton = screen.getByRole("button", {
      name: "Delete VAT Return Reviewer",
    });
    fireEvent.click(reDeleteButton);

    const confirmButton = screen.getByRole("button", {
      name: "Confirm delete VAT Return Reviewer",
    });
    fireEvent.click(confirmButton);
    expect(onDelete).toHaveBeenCalledWith("agent-mine-1");
  });

  it("triggers onNew and onClose from header actions and disables controls when busy", () => {
    const onNew = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <AgentLibraryPanel
        agents={sampleAgents}
        now={1_700_000_000_000}
        onOpen={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onNew={onNew}
        onClose={onClose}
        busy={false}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(onNew).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <AgentLibraryPanel
        agents={sampleAgents}
        now={1_700_000_000_000}
        onOpen={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onNew={onNew}
        onClose={onClose}
        busy={true}
      />
    );

    expect(screen.getByRole("button", { name: "New agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open VAT Return Reviewer" })).toBeDisabled();
  });
});
