import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryPanel, type Learned } from "./MemoryPanel.js";

if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal =
    HTMLDialogElement.prototype.showModal || function () {};
  HTMLDialogElement.prototype.close =
    HTMLDialogElement.prototype.close || function () {};
}

describe("MemoryPanel", () => {
  it("renders the explaining sentence and empty state when there are no memories", () => {
    render(
      <MemoryPanel
        facts={[]}
        stale={[]}
        projectTitle="Billing System"
        now={100_000}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
      />
    );

    expect(
      screen.getByText(
        /These are things worked out from your work, which are put in front of your subscriptions/
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing is remembered yet/)).toBeInTheDocument();
  });

  it("groups facts under headings in words with source and occurrence count", () => {
    const facts: readonly Learned[] = [
      {
        id: "f1",
        kind: "business",
        text: "Acme sells bespoke wholesale furniture",
        source: "company handbook",
        count: 3,
        pinned: false,
        hidden: false,
        lastSeen: 90_000,
      },
      {
        id: "f2",
        kind: "people",
        text: "Sarah leads warehouse logistics",
        source: "team roster",
        count: 1,
        pinned: false,
        hidden: false,
        lastSeen: 80_000,
      },
      {
        id: "f3",
        kind: "decision",
        text: "Deliveries run only on Tuesday and Thursday",
        source: "case turn 4",
        count: 2,
        pinned: true,
        hidden: false,
        lastSeen: 70_000,
      },
      {
        id: "f4",
        kind: "preference",
        text: "Summaries must always be bullet points",
        source: "client briefing",
        count: 5,
        pinned: false,
        hidden: false,
        lastSeen: 60_000,
      },
      {
        id: "f5",
        kind: "constraint",
        text: "Maximum load per van is 800 kilograms",
        source: "fleet spec",
        count: 1,
        pinned: false,
        hidden: false,
        lastSeen: 50_000,
      },
    ];

    render(
      <MemoryPanel
        facts={facts}
        stale={[]}
        projectTitle="Dispatch Project"
        now={100_000}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("About the business")).toBeInTheDocument();
    expect(screen.getByText("About people")).toBeInTheDocument();
    expect(screen.getByText("Decisions you made")).toBeInTheDocument();
    expect(screen.getByText("How you like things")).toBeInTheDocument();
    expect(screen.getByText("Things that constrain you")).toBeInTheDocument();

    expect(screen.getByText("Acme sells bespoke wholesale furniture")).toBeInTheDocument();
    expect(screen.getByText("Learned from company handbook")).toBeInTheDocument();
    expect(screen.getByText("Came up 3 times")).toBeInTheDocument();
    // Two of these facts came up once, so the singular wording is expected twice.
    expect(screen.getAllByText("Came up once")).toHaveLength(2);
  });

  it("keeps a hidden fact visible and marked without deleting it", () => {
    const facts: readonly Learned[] = [
      {
        id: "f1",
        kind: "preference",
        text: "Only reply after 10am",
        source: "past conversation",
        count: 2,
        pinned: false,
        hidden: true,
        lastSeen: 90_000,
      },
    ];

    render(
      <MemoryPanel
        facts={facts}
        stale={[]}
        projectTitle="General"
        now={100_000}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Only reply after 10am")).toBeInTheDocument();
    expect(screen.getByText("Stopped using")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'Resume using "Only reply after 10am"' })
    ).toBeInTheDocument();
  });

  it("calls different callbacks for hide and forget", () => {
    const onHide = vi.fn();
    const onForget = vi.fn();

    const facts: readonly Learned[] = [
      {
        id: "fact-99",
        kind: "decision",
        text: "Always invoice on delivery",
        source: "invoice rule",
        count: 1,
        pinned: false,
        hidden: false,
        lastSeen: 90_000,
      },
    ];

    render(
      <MemoryPanel
        facts={facts}
        stale={[]}
        projectTitle="Accounts"
        now={100_000}
        busy={false}
        onPin={() => {}}
        onHide={onHide}
        onForget={onForget}
        onClose={() => {}}
      />
    );

    const hideButton = screen.getByRole("button", {
      name: 'Stop using "Always invoice on delivery"',
    });
    fireEvent.click(hideButton);

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledWith("fact-99", true);
    expect(onForget).not.toHaveBeenCalled();

    const forgetButton = screen.getByRole("button", {
      name: 'Forget "Always invoice on delivery"',
    });
    fireEvent.click(forgetButton);

    expect(onForget).toHaveBeenCalledTimes(1);
    expect(onForget).toHaveBeenCalledWith("fact-99");
  });

  it("calls onPin with inverted pinned state", () => {
    const onPin = vi.fn();

    const facts: readonly Learned[] = [
      {
        id: "fact-pinned",
        kind: "business",
        text: "VAT registration is GB123456789",
        source: "tax letter",
        count: 4,
        pinned: true,
        hidden: false,
        lastSeen: 90_000,
      },
    ];

    render(
      <MemoryPanel
        facts={facts}
        stale={[]}
        projectTitle="Tax"
        now={100_000}
        busy={false}
        onPin={onPin}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
      />
    );

    const keepButton = screen.getByRole("button", {
      name: 'Stop keeping "VAT registration is GB123456789"',
    });
    fireEvent.click(keepButton);

    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith("fact-pinned", false);
  });

  it("renders stale section with last seen in plain words and offers to clear", () => {
    const onForget = vi.fn();
    const onPin = vi.fn();
    // A real clock, because two days before 100_000 is before 1970.
    const STALE_NOW = 1_760_000_000_000;

    const staleFacts: readonly Learned[] = [
      {
        id: "stale-1",
        kind: "people",
        text: "David is the interim manager",
        source: "old memo",
        count: 1,
        pinned: false,
        hidden: false,
        lastSeen: STALE_NOW - 86_400_000 * 2,
      },
    ];

    render(
      <MemoryPanel
        facts={[]}
        stale={staleFacts}
        projectTitle="Archive"
        now={STALE_NOW}
        busy={false}
        onPin={onPin}
        onHide={() => {}}
        onForget={onForget}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Stale memories")).toBeInTheDocument();
    expect(screen.getByText("David is the interim manager")).toBeInTheDocument();
    expect(screen.getByText("Last seen 2 days ago")).toBeInTheDocument();

    const clearButton = screen.getByRole("button", {
      name: 'Clear stale memory "David is the interim manager"',
    });
    fireEvent.click(clearButton);

    expect(onForget).toHaveBeenCalledWith("stale-1");

    const keepButton = screen.getByRole("button", {
      name: 'Keep "David is the interim manager"',
    });
    fireEvent.click(keepButton);

    expect(onPin).toHaveBeenCalledWith("stale-1", true);
  });

  it("does not call an unrecorded last-seen time recent", () => {
    const staleFacts: readonly Learned[] = [
      {
        id: "stale-nodate",
        kind: "business",
        text: "The old supplier was based in Leeds",
        source: "an import",
        count: 1,
        pinned: false,
        hidden: false,
        lastSeen: 0,
      },
    ];

    render(
      <MemoryPanel
        facts={[]}
        stale={staleFacts}
        projectTitle="Archive"
        now={1_760_000_000_000}
        busy={false}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("Last seen at an unknown time")).toBeInTheDocument();
    expect(screen.queryByText(/Last seen recently/)).not.toBeInTheDocument();
  });

  it("disables mutation buttons when busy", () => {
    const facts: readonly Learned[] = [
      {
        id: "f1",
        kind: "business",
        text: "Cash only on arrival",
        source: "policy",
        count: 1,
        pinned: false,
        hidden: false,
        lastSeen: 90_000,
      },
    ];

    render(
      <MemoryPanel
        facts={facts}
        stale={[]}
        projectTitle="Cash Policy"
        now={100_000}
        busy={true}
        onPin={() => {}}
        onHide={() => {}}
        onForget={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: 'Keep "Cash only on arrival"' })).toBeDisabled();
    expect(screen.getByRole("button", { name: 'Stop using "Cash only on arrival"' })).toBeDisabled();
    expect(screen.getByRole("button", { name: 'Forget "Cash only on arrival"' })).toBeDisabled();
  });
});
