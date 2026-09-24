import { describe, expect, it } from "vitest";
import { addToScratchpad } from "./research-notes.js";
import type { SourceRef } from "./research-notes.js";

describe("addToScratchpad", () => {
  const sourceA: SourceRef = {
    id: "src-page-1",
    kind: "page",
    label: "Supplier Contract",
    url: "https://supplier.example/contract",
    readAt: 1700000000000,
  };

  const sourceB: SourceRef = {
    id: "src-page-2",
    kind: "page",
    label: "Termination Terms",
    url: "https://supplier.example/terms",
    readAt: 1700000005000,
  };

  it("stores verbatim non-empty quotes that match the input text", () => {
    const text = "The contract renews automatically on 1 January. The price is £500 per month.";
    const pad = addToScratchpad({
      existing: [],
      text,
      source: sourceA,
      subQuestions: [],
      at: 1700000010000,
    });

    expect(pad.notes.length).toBe(2);
    for (const note of pad.notes) {
      expect(note.quote.length).toBeGreaterThan(0);
      expect(text.includes(note.quote)).toBe(true);
    }
  });

  it("places a claim and its negation in conflicting and never in agreed", () => {
    const pad1 = addToScratchpad({
      existing: [],
      text: "The contract renews automatically.",
      source: sourceA,
      subQuestions: [],
      at: 1700000010000,
    });

    const pad2 = addToScratchpad({
      existing: pad1.notes,
      text: "The contract does not renew automatically.",
      source: sourceB,
      subQuestions: [],
      at: 1700000020000,
    });

    expect(pad2.conflicting.length).toBe(1);
    expect(pad2.agreed.length).toBe(0);
    const conflict = pad2.conflicting[0]!;
    expect(conflict.saidBy).toContain("Supplier Contract");
    expect(conflict.contradictedBy).toContain("Termination Terms");
  });

  it("records agreement when two distinct sources assert the same proposition", () => {
    const pad1 = addToScratchpad({
      existing: [],
      text: "The supplier delivers orders on Tuesdays.",
      source: sourceA,
      subQuestions: [],
      at: 1700000010000,
    });

    const pad2 = addToScratchpad({
      existing: pad1.notes,
      text: "The supplier delivers on Tuesdays.",
      source: sourceB,
      subQuestions: [],
      at: 1700000020000,
    });

    expect(pad2.agreed.length).toBe(1);
    expect(pad2.conflicting.length).toBe(0);
    const agreement = pad2.agreed[0]!;
    expect(agreement.sources).toContain("Supplier Contract");
    expect(agreement.sources).toContain("Termination Terms");
  });

  it("lists unanswered sub-questions in thin", () => {
    const pad = addToScratchpad({
      existing: [],
      text: "The contract renews automatically on 1 January.",
      source: sourceA,
      subQuestions: [
        { id: "q-renew", question: "When does the contract renew?" },
        { id: "q-penalty", question: "What is the penalty fee for early exit?" },
      ],
      at: 1700000010000,
    });

    expect(pad.thin).toContain("What is the penalty fee for early exit?");
    expect(pad.thin).not.toContain("When does the contract renew?");
  });

  it("does not duplicate findings when a single source repeats a claim", () => {
    const text = "The contract renews automatically. We noted that the contract renews automatically.";
    const pad = addToScratchpad({
      existing: [],
      text,
      source: sourceA,
      subQuestions: [],
      at: 1700000010000,
    });

    expect(pad.notes.length).toBe(1);
    expect(pad.bySource[0]!.count).toBe(1);
  });

  it("handles messy edge cases gracefully: empty text, null url, identical labels, and long quotes", () => {
    const sourceSameLabel1: SourceRef = {
      id: "src-doc-1",
      kind: "file",
      label: "Price List",
      url: null,
      readAt: 1700000000000,
    };

    const sourceSameLabel2: SourceRef = {
      id: "src-doc-2",
      kind: "file",
      label: "Price List",
      url: null,
      readAt: 1700000001000,
    };

    const emptyPad = addToScratchpad({
      existing: [],
      text: "   ",
      source: sourceSameLabel1,
      subQuestions: [{ id: "q-open", question: "What is the unit cost?" }],
      at: 1700000002000,
    });
    expect(emptyPad.notes.length).toBe(0);
    expect(emptyPad.thin).toContain("What is the unit cost?");
    expect(emptyPad.headline).toBe("No notes recorded yet; 1 question remain unanswered.");

    const clausePart = "The primary supplier requires a full security deposit prior to shipping";
    const longParagraph =
      `${clausePart}; furthermore, any additional handling will incur administrative surcharges of five percent on the gross invoice amount, payable within fourteen business days of dispatch unless an alternative schedule has been mutually agreed in writing by both parties beforehand, including insurance contingencies and customs clearance obligations under existing regional trade frameworks, all of which are subject to annual audit.` +
      " Extra padding to guarantee the paragraph length safely exceeds the four hundred character threshold for testing.";
    expect(longParagraph.length).toBeGreaterThan(400);

    const padLong = addToScratchpad({
      existing: [],
      text: longParagraph,
      source: sourceSameLabel1,
      subQuestions: [],
      at: 1700000003000,
    });
    expect(padLong.notes.length).toBeGreaterThan(0);
    const quote = padLong.notes[0]!.quote;
    expect(quote.length).toBeLessThanOrEqual(400);
    expect(longParagraph.includes(quote)).toBe(true);

    const padWithSecondSource = addToScratchpad({
      existing: padLong.notes,
      text: "Security deposits are required before shipping.",
      source: sourceSameLabel2,
      subQuestions: [],
      at: 1700000004000,
    });
    expect(padWithSecondSource.bySource.length).toBe(2);
    expect(padWithSecondSource.agreed.length).toBe(1);
  });
});
