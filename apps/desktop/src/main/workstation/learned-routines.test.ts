import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
  proposeRoutine,
  type TurnLike
} from "./learned-routines.js";

describe("learned-routines: proposeRoutine", () => {
  const sampleOwnerTurn: TurnLike = {
    id: "turn-owner-1",
    seat: "owner",
    kind: "verbatim",
    body: "Please summarise the meeting transcripts and compile an executive research brief."
  };

  const sampleSourceTurn: TurnLike = {
    id: "turn-source-1",
    seat: "notes",
    kind: "verbatim",
    body: "Project kick-off notes: The client confirmed the target delivery date is next quarter."
  };

  const sampleAnswerTurn: TurnLike = {
    id: "turn-answer-1",
    seat: "codex",
    kind: "answer",
    body: "# Research Brief\n\n## Executive Summary\nKey findings synthesized from the meeting notes."
  };

  it("returns null when there are no source turns", () => {
    const turns: readonly TurnLike[] = [sampleOwnerTurn, sampleAnswerTurn];
    expect(proposeRoutine(turns)).toBeNull();
  });

  it("returns null when only an owner message is present", () => {
    const turns: readonly TurnLike[] = [sampleOwnerTurn];
    expect(proposeRoutine(turns)).toBeNull();
  });

  it("returns null when there is no answer turn", () => {
    const turns: readonly TurnLike[] = [sampleOwnerTurn, sampleSourceTurn];
    expect(proposeRoutine(turns)).toBeNull();
  });

  it("returns null when owner request is shorter than MIN_PROMPT_CHARS", () => {
    const shortOwnerTurn: TurnLike = {
      id: "turn-owner-short",
      seat: "owner",
      kind: "verbatim",
      body: "Summarise this."
    };
    const turns: readonly TurnLike[] = [
      shortOwnerTurn,
      sampleSourceTurn,
      sampleAnswerTurn
    ];
    expect(proposeRoutine(turns)).toBeNull();
  });

  it("returns null when owner request exceeds MAX_PROMPT_CHARS rather than truncating", () => {
    const hugeBody = "Please analyze the attached notes. ".repeat(300);
    expect(hugeBody.length).toBeGreaterThan(MAX_PROMPT_CHARS);

    const hugeOwnerTurn: TurnLike = {
      id: "turn-owner-huge",
      seat: "owner",
      kind: "verbatim",
      body: hugeBody
    };

    const turns: readonly TurnLike[] = [
      hugeOwnerTurn,
      sampleSourceTurn,
      sampleAnswerTurn
    ];
    expect(proposeRoutine(turns)).toBeNull();
  });

  it("proposes a routine for qualifying work with greeting stripped and valid evidence", () => {
    const ownerWithGreeting: TurnLike = {
      id: "turn-owner-greeting",
      seat: "owner",
      kind: "verbatim",
      body: "Hello Rellane, please synthesise the discovery notes and draft an implementation plan."
    };

    const sourceTurn2: TurnLike = {
      id: "turn-source-2",
      seat: "specs",
      kind: "verbatim",
      body: "Architecture decision record 014: SQLite with WAL mode for local storage."
    };

    const planAnswer: TurnLike = {
      id: "turn-answer-plan",
      seat: "claude",
      kind: "answer",
      body: "# Implementation Plan\n\nPhase 1 focuses on schema migrations."
    };

    const turns: readonly TurnLike[] = [
      sampleSourceTurn,
      ownerWithGreeting,
      sourceTurn2,
      planAnswer
    ];

    const proposal = proposeRoutine(turns);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    // Greeting must be stripped from the proposed prompt.
    expect(proposal.prompt).not.toMatch(/^hello\b/i);
    expect(proposal.prompt).toBe(
      "Please synthesise the discovery notes and draft an implementation plan."
    );

    // Title must be sentence case, within the cap, and cut at a word boundary.
    // Asserted as properties rather than as one literal: the expectation that
    // was here was 63 characters long, which this same file caps at 60.
    expect(proposal.title.length).toBeLessThanOrEqual(60);
    expect(proposal.title).toMatch(/^Synthesise the discovery notes/u);
    expect(proposal.title.endsWith(".")).toBe(false);
    // Whatever survived the cap is whole words from the owner's own request.
    const requested = "Please synthesise the discovery notes and draft an implementation plan.";
    for (const word of proposal.title.split(" ")) {
      expect(requested.toLowerCase()).toContain(word.toLowerCase());
    }

    // Evidence must contain all used turn ids in their appearance order.
    expect(proposal.evidence).toEqual([
      sampleSourceTurn.id,
      ownerWithGreeting.id,
      sourceTurn2.id,
      planAnswer.id
    ]);

    // All evidence ids must exist in the input turns.
    const inputIds = new Set(turns.map((t) => t.id));
    for (const id of proposal.evidence) {
      expect(inputIds.has(id)).toBe(true);
    }

    // Output label derived from primary markdown heading.
    expect(proposal.outputLabel).toBe("Implementation Plan");

    // Source hint reflects both demonstrated source seats.
    expect(proposal.sourceHint).toBe(
      "Select notes or specs to ground this routine."
    );

    // Because clause names the observed source count and output.
    expect(proposal.because).toBe(
      "Observed two sources used to produce an implementation plan."
    );
  });

  it("produces deeply equal proposals for identical inputs", () => {
    const turns: readonly TurnLike[] = [
      sampleSourceTurn,
      sampleOwnerTurn,
      sampleAnswerTurn
    ];

    const proposalA = proposeRoutine(turns);
    const proposalB = proposeRoutine(turns);

    expect(proposalA).not.toBeNull();
    expect(proposalA).toStrictEqual(proposalB);
  });

  it("replaces a quoted proper noun with a neutral placeholder when it appears only once", () => {
    const singleNounOwnerTurn: TurnLike = {
      id: "turn-owner-noun-single",
      seat: "owner",
      kind: "verbatim",
      body: "Please review the quarterly performance metrics for \"Acme Corp\" and summarize key risks."
    };

    const turns: readonly TurnLike[] = [
      sampleSourceTurn,
      singleNounOwnerTurn,
      sampleAnswerTurn
    ];

    const proposal = proposeRoutine(turns);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    expect(proposal.prompt).toBe(
      "Please review the quarterly performance metrics for [subject] and summarize key risks."
    );
  });

  it("does NOT replace a proper noun that appears more than once", () => {
    const repeatedNounOwnerTurn: TurnLike = {
      id: "turn-owner-noun-repeated",
      seat: "owner",
      kind: "verbatim",
      body: "Compare the Q2 results of \"Acme Corp\" against the targets set by \"Acme Corp\" in January."
    };

    const turns: readonly TurnLike[] = [
      sampleSourceTurn,
      repeatedNounOwnerTurn,
      sampleAnswerTurn
    ];

    const proposal = proposeRoutine(turns);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    // Repeated proper noun must not be generalized because it reflects job-specific recurring logic.
    expect(proposal.prompt).toContain('"Acme Corp"');
    expect(proposal.prompt).not.toContain("[subject]");
  });

  it("bounds title to at most 60 characters and ensures no trailing full stop", () => {
    const longRequestOwnerTurn: TurnLike = {
      id: "turn-owner-long",
      seat: "owner",
      kind: "verbatim",
      body: "Please evaluate the entire distributed event bus architecture across all microservices and prepare a report."
    };

    const turns: readonly TurnLike[] = [
      sampleSourceTurn,
      longRequestOwnerTurn,
      sampleAnswerTurn
    ];

    const proposal = proposeRoutine(turns);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    expect(proposal.title.length).toBeLessThanOrEqual(60);
    expect(proposal.title.endsWith(".")).toBe(false);
  });

  it("falls back to 'Draft answer' when output cannot be derived from headings", () => {
    const plainAnswerTurn: TurnLike = {
      id: "turn-answer-plain",
      seat: "gemini1",
      kind: "answer",
      body: "Here is the summary you requested with the action items listed directly below."
    };

    const turns: readonly TurnLike[] = [
      sampleSourceTurn,
      sampleOwnerTurn,
      plainAnswerTurn
    ];

    const proposal = proposeRoutine(turns);
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    expect(proposal.outputLabel).toBe("Draft answer");
    expect(proposal.because).toBe(
      "Observed one source used to produce a draft answer."
    );
  });
});
