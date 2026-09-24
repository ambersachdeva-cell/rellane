import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KnowledgePanel, type Seen } from "./KnowledgePanel.js";

// JSDOM does not provide native showModal and close implementations for dialogs.
if (typeof HTMLDialogElement !== "undefined") {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
}

describe("KnowledgePanel", () => {
  const fixedNow = 1773576000000; // 2026-03-15T12:00:00.000Z

  it("says it is still reading and shows no sections when seen is null", () => {
    render(
      <KnowledgePanel
        seen={null}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={vi.fn()}
        onPauseFolder={vi.fn()}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Still reading what this app has seen.")).toBeDefined();
    expect(screen.queryByText("Folders it watches")).toBeNull();
    expect(screen.queryByText("Words it has learned")).toBeNull();
    expect(screen.queryByText("What it knows about people")).toBeNull();
    expect(screen.queryByText("Your work")).toBeNull();
  });

  it("offers to add a folder when seen.empty is true and triggers onGrantFolder", () => {
    const onGrantFolder = vi.fn();
    const emptySeen: Seen = {
      terms: [],
      folders: [],
      notes: [],
      cases: {
        open: 0,
        closed: 0,
        openTitles: [],
      },
      empty: true,
    };

    render(
      <KnowledgePanel
        seen={emptySeen}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={vi.fn()}
        onPauseFolder={vi.fn()}
        onGrantFolder={onGrantFolder}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText("This app has seen nothing yet. Add a folder to let it read your work.")
    ).toBeDefined();

    const grantButton = screen.getByRole("button", { name: "Add a folder" });
    expect(grantButton).toBeDefined();
    fireEvent.click(grantButton);
    expect(onGrantFolder).toHaveBeenCalledTimes(1);
  });

  it("calls onPauseFolder with folder path and true when pausing an active folder", () => {
    const onPauseFolder = vi.fn();
    const seen: Seen = {
      terms: [],
      folders: [
        {
          path: "/Users/amber/Documents/Invoices",
          name: "Invoices",
          watching: true,
          files: 42,
          lastSeenAt: new Date(fixedNow - 240000).toISOString(), // 4 minutes ago
        },
      ],
      notes: [],
      cases: {
        open: 0,
        closed: 0,
        openTitles: [],
      },
      empty: false,
    };

    render(
      <KnowledgePanel
        seen={seen}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={vi.fn()}
        onPauseFolder={onPauseFolder}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Invoices")).toBeDefined();
    expect(screen.getByText("/Users/amber/Documents/Invoices")).toBeDefined();
    expect(screen.getByText("42 files")).toBeDefined();
    expect(screen.getByText("looked 4 minutes ago")).toBeDefined();

    const pauseButton = screen.getByRole("button", { name: "Stop reading Invoices" });
    fireEvent.click(pauseButton);
    expect(onPauseFolder).toHaveBeenCalledWith("/Users/amber/Documents/Invoices", true);
  });

  it("says plainly that nothing is read from a paused folder and formats null lastSeenAt as never", () => {
    const onPauseFolder = vi.fn();
    const seen: Seen = {
      terms: [],
      folders: [
        {
          path: "/Users/amber/Documents/Archive",
          name: "Archive",
          watching: false,
          files: null,
          lastSeenAt: null,
        },
      ],
      notes: [],
      cases: {
        open: 0,
        closed: 0,
        openTitles: [],
      },
      empty: false,
    };

    render(
      <KnowledgePanel
        seen={seen}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={vi.fn()}
        onPauseFolder={onPauseFolder}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Nothing is read from this folder.")).toBeDefined();
    expect(screen.getByText("never")).toBeDefined();
    expect(screen.getByText("files not yet counted")).toBeDefined();

    const resumeButton = screen.getByRole("button", { name: "Resume reading Archive" });
    fireEvent.click(resumeButton);
    expect(onPauseFolder).toHaveBeenCalledWith("/Users/amber/Documents/Archive", false);
  });

  it("calls onHideTerm with key and true when hiding a word, and stays visibly listed with badge when hidden", () => {
    const onHideTerm = vi.fn();
    const seen: Seen = {
      terms: [
        {
          key: "ebitda",
          word: "EBITDA",
          meaning: "Earnings before interest, taxes, depreciation and amortisation",
          hidden: false,
        },
        {
          key: "kyc",
          word: "KYC",
          meaning: "Know your customer identity check",
          hidden: true,
        },
      ],
      folders: [],
      notes: [],
      cases: {
        open: 0,
        closed: 0,
        openTitles: [],
      },
      empty: false,
    };

    render(
      <KnowledgePanel
        seen={seen}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={onHideTerm}
        onPauseFolder={vi.fn()}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const hideButton = screen.getByRole("button", { name: "Hide EBITDA" });
    fireEvent.click(hideButton);
    expect(onHideTerm).toHaveBeenCalledWith("ebitda", true);

    expect(screen.getByText("KYC")).toBeDefined();
    expect(screen.getByText("Hidden")).toBeDefined();
    const showButton = screen.getByRole("button", { name: "Show KYC" });
    fireEvent.click(showButton);
    expect(onHideTerm).toHaveBeenCalledWith("kyc", false);
  });

  it("renders party notes as plain text and never as markup", () => {
    const seen: Seen = {
      terms: [],
      folders: [],
      notes: [
        {
          partyName: "Acme Logistics",
          note: "Account settles on 14 days credit. <b>Important</b> contact: Alex.",
        },
      ],
      cases: {
        open: 0,
        closed: 0,
        openTitles: [],
      },
      empty: false,
    };

    render(
      <KnowledgePanel
        seen={seen}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={vi.fn()}
        onPauseFolder={vi.fn()}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Acme Logistics")).toBeDefined();
    expect(
      screen.getByText("Account settles on 14 days credit. <b>Important</b> contact: Alex.")
    ).toBeDefined();
  });

  it("displays open case titles and restraint sentence while showing no case body", () => {
    const seen: Seen = {
      terms: [],
      folders: [],
      notes: [],
      cases: {
        open: 2,
        closed: 5,
        openTitles: ["Q3 Corporation Tax Return", "Lease Review 2026"],
      },
      empty: false,
    };

    render(
      <KnowledgePanel
        seen={seen}
        now={fixedNow}
        busy={false}
        problem={null}
        onHideTerm={vi.fn()}
        onPauseFolder={vi.fn()}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("2 open")).toBeDefined();
    expect(screen.getByText("5 closed")).toBeDefined();
    expect(
      screen.getByText("Case titles are listed here, but what was said inside them is not.")
    ).toBeDefined();
    expect(screen.getByText("Q3 Corporation Tax Return")).toBeDefined();
    expect(screen.getByText("Lease Review 2026")).toBeDefined();
    expect(screen.queryByText(/body/i)).toBeNull();
  });

  it("displays an inline alert when problem is provided", () => {
    const seen: Seen = {
      terms: [],
      folders: [],
      notes: [],
      cases: {
        open: 0,
        closed: 0,
        openTitles: [],
      },
      empty: false,
    };

    render(
      <KnowledgePanel
        seen={seen}
        now={fixedNow}
        busy={false}
        problem="Could not connect to the local store."
        onHideTerm={vi.fn()}
        onPauseFolder={vi.fn()}
        onGrantFolder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toBe("Could not connect to the local store.");
  });
});
