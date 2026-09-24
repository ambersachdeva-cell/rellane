import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CrewPlanReview,
  type CrewPlanReviewProps,
  type PlanPart,
} from "./CrewPlanReview.js";

// Native HTMLDialogElement methods throw in standard jsdom unless stubbed.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal =
    HTMLDialogElement.prototype.showModal ||
    function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  HTMLDialogElement.prototype.close =
    HTMLDialogElement.prototype.close ||
    function close(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    };
}

afterEach(() => {
  cleanup();
});

function createDefaultProps(
  overrides: Partial<CrewPlanReviewProps> = {},
): CrewPlanReviewProps {
  const defaultParts: readonly PlanPart[] = [
    {
      id: "part-1",
      title: "Check VAT filings",
      prompt: "Inspect the quarterly VAT return for arithmetic discrepancies.",
      seatLabel: "Claude",
      dependsOnTitles: [],
    },
    {
      id: "part-2",
      title: "Summarise transactions",
      prompt: "Draft an executive summary of the ledger items.",
      seatLabel: "Gemini",
      dependsOnTitles: ["Check VAT filings"],
    },
  ];

  return {
    request: overrides.request !== undefined ? overrides.request : "Review our Q3 accounts and summarise the VAT positions.",
    parts: overrides.parts !== undefined ? overrides.parts : defaultParts,
    idleSeats: overrides.idleSeats !== undefined ? overrides.idleSeats : [],
    sourceLabels: overrides.sourceLabels !== undefined ? overrides.sourceLabels : ["q3-ledger.csv"],
    wholeJob: overrides.wholeJob !== undefined ? overrides.wholeJob : false,
    refusedBecause: overrides.refusedBecause !== undefined ? overrides.refusedBecause : null,
    estimatedCalls: overrides.estimatedCalls !== undefined ? overrides.estimatedCalls : 4,
    onSend: overrides.onSend !== undefined ? overrides.onSend : vi.fn(),
    onEditPart: overrides.onEditPart !== undefined ? overrides.onEditPart : vi.fn(),
    onClose: overrides.onClose !== undefined ? overrides.onClose : vi.fn(),
    busy: overrides.busy !== undefined ? overrides.busy : false,
  };
}

describe("CrewPlanReview", () => {
  it("renders two parts with their bots, editable prompts, and dependency titles", () => {
    const props = createDefaultProps();
    render(<CrewPlanReview {...props} />);

    expect(screen.getByRole("heading", { name: "Check VAT filings" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Summarise transactions" })).toBeDefined();
    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.getByText("Gemini")).toBeDefined();

    expect(
      screen.getByDisplayValue(
        "Inspect the quarterly VAT return for arithmetic discrepancies.",
      ),
    ).toBeDefined();
    expect(
      screen.getByDisplayValue(
        "Draft an executive summary of the ledger items.",
      ),
    ).toBeDefined();

    expect(screen.getByText("Check VAT filings", { selector: ".ws-plan-part-waits-list" })).toBeDefined();
    expect(screen.getByText("Starts immediately")).toBeDefined();
  });

  it("calls onEditPart with the part id and new text when a prompt is changed", () => {
    const onEditPart = vi.fn();
    const props = createDefaultProps({ onEditPart });
    render(<CrewPlanReview {...props} />);

    const textarea = screen.getByDisplayValue(
      "Inspect the quarterly VAT return for arithmetic discrepancies.",
    );
    fireEvent.change(textarea, {
      target: { value: "Updated instructions for VAT review." },
    });

    expect(onEditPart).toHaveBeenCalledTimes(1);
    expect(onEditPart).toHaveBeenCalledWith(
      "part-1",
      "Updated instructions for VAT review.",
    );
    expect(
      screen.getByDisplayValue("Updated instructions for VAT review."),
    ).toBeDefined();
  });

  it("names idle seats plainly when a selected bot receives no assignment", () => {
    const props = createDefaultProps({
      idleSeats: ["Gemini (Profile 2)"],
    });
    render(<CrewPlanReview {...props} />);

    expect(
      screen.getByText("Gemini (Profile 2) will not be used for this one."),
    ).toBeDefined();
  });

  it("states the call count in plain terms counting subscription requests", () => {
    const props = createDefaultProps({ estimatedCalls: 5 });
    render(<CrewPlanReview {...props} />);

    expect(
      screen.getByText("This will ask your subscriptions 5 times."),
    ).toBeDefined();
  });

  it("states singular subscription calls accurately when only one call is planned", () => {
    const props = createDefaultProps({ estimatedCalls: 1 });
    render(<CrewPlanReview {...props} />);

    expect(
      screen.getByText("This will ask your subscriptions 1 time."),
    ).toBeDefined();
  });

  it("explains clearly when a job cannot be split and one bot handles the whole request", () => {
    const props = createDefaultProps({ wholeJob: true });
    render(<CrewPlanReview {...props} />);

    expect(
      screen.getByText(
        "This request could not usefully be split, so one bot will take all of it.",
      ),
    ).toBeDefined();
  });

  it("replaces the whole body and renders no send button when refused", () => {
    const onClose = vi.fn();
    const props = createDefaultProps({
      refusedBecause: "The request cannot be split without source files.",
      onClose,
    });
    render(<CrewPlanReview {...props} />);

    expect(
      screen.getByText("The request cannot be split without source files."),
    ).toBeDefined();

    const sendButtons = screen.queryAllByRole("button", {
      name: /send/i,
    });
    expect(sendButtons.length).toBe(0);

    const closeButton = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names the bot count on the send button and invokes onSend when clicked", () => {
    const onSend = vi.fn();
    const props = createDefaultProps({ onSend });
    render(<CrewPlanReview {...props} />);

    const sendButton = screen.getByRole("button", { name: "Send to 2 bots" });
    fireEvent.click(sendButton);

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disables send and cancel actions while busy", () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    const props = createDefaultProps({ busy: true, onSend, onClose });
    render(<CrewPlanReview {...props} />);

    const sendButton = screen.getByRole("button", { name: "Send to 2 bots" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });

    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(cancelButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(sendButton);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(cancelButton);
    expect(onClose).not.toHaveBeenCalled();
  });
});
