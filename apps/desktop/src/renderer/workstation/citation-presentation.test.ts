import { describe, expect, it } from "vitest";
import { presentCitationCheck } from "./citation-presentation.js";
import type { CitationCheckLike } from "./citation-presentation.js";

describe("presentCitationCheck", () => {
  const baseCheck: CitationCheckLike = {
    status: "ok",
    summary: "Citation check passed.",
    sources: [],
    citedIds: [],
    unknownReferences: [],
    missingFromSourcesBlock: [],
    unexpectedInSourcesBlock: [],
    expectedSourcesBlock: "",
    errors: [],
    warnings: []
  };

  it("handles [99] cited with no Sources block and two sources selected", () => {
    const rawError = "render --cited-in ... missing sources";
    const rawWarning = "checker warning: reference [99] unmatched";
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "mismatch",
      summary: rawError,
      sources: [
        { id: 1, label: "First source", uri: "https://example.com/1" },
        { id: 2, label: "Second source", uri: "https://example.com/2" }
      ],
      citedIds: [99],
      unknownReferences: ["[99]"],
      expectedSourcesBlock: "",
      errors: [rawError],
      warnings: [rawWarning]
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.badge).toBe("mismatch");
    expect(presentation.expectedBlockOrigin).toBe("derived");
    expect(presentation.expectedSourcesBlock).toBe(
      "Sources\n[1] First source — https://example.com/1\n[2] Second source — https://example.com/2"
    );
    expect(presentation.technicalDetail).toEqual([rawError, rawWarning]);
    expect(presentation.headline).toBe("The citations do not match the selected sources.");
    expect(presentation.headline).not.toContain("render --cited-in");
    expect(presentation.headline).not.toContain("99");
    // Asserted by what each line must SAY, not by its exact wording: the copy on
    // this screen is expected to improve, and a test that pins the sentence turns
    // every improvement into a failure.
    expect(presentation.guidance).toHaveLength(2);
    expect(presentation.guidance[0]).toContain("worked this block out");
    expect(presentation.guidance[0]).toContain("you selected");
    expect(presentation.guidance[0]).not.toContain("the owner");
    expect(presentation.guidance[1]).toContain("[99]");
    expect(presentation.guidance[1]).toContain("not in this work");
  });

  it("passes through populated engine block byte-identically with origin engine", () => {
    const engineBlock = "Sources\n[1] Source Alpha — https://example.com/alpha\n";
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "ok",
      summary: "References verified.",
      sources: [{ id: 1, label: "Source Alpha", uri: "https://example.com/alpha" }],
      citedIds: [1],
      expectedSourcesBlock: engineBlock
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.badge).toBe("ok");
    expect(presentation.expectedBlockOrigin).toBe("engine");
    expect(presentation.expectedSourcesBlock).toBe(engineBlock);
    expect(presentation.guidance).toEqual(["The citations match the selected sources."]);
  });

  it("returns origin none and empty block when there are no sources and no engine block", () => {
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "uncited",
      summary: "No references found.",
      sources: [],
      expectedSourcesBlock: ""
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.expectedBlockOrigin).toBe("none");
    expect(presentation.expectedSourcesBlock).toBe("");
    expect(presentation.guidance).toEqual([
      "No sources were selected, so there is nothing to check the citations against."
    ]);
  });

  it("numbers derived block from source ids rather than array indices", () => {
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "mismatch",
      sources: [
        { id: 7, label: "Seventh source", uri: "https://example.com/7" },
        { id: 2, label: "Second source", uri: "https://example.com/2" }
      ],
      expectedSourcesBlock: ""
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.expectedBlockOrigin).toBe("derived");
    expect(presentation.expectedSourcesBlock).toBe(
      "Sources\n[2] Second source — https://example.com/2\n[7] Seventh source — https://example.com/7"
    );
    expect(presentation.expectedSourcesBlock).not.toContain("[1]");
  });

  it("asserts headline mapping for all four statuses without raw text or numbers", () => {
    const okPresentation = presentCitationCheck({ ...baseCheck, status: "ok" });
    const mismatchPresentation = presentCitationCheck({ ...baseCheck, status: "mismatch" });
    const uncitedPresentation = presentCitationCheck({ ...baseCheck, status: "uncited" });
    const unavailablePresentation = presentCitationCheck({ ...baseCheck, status: "unavailable" });

    expect(okPresentation.headline).toBe("Every numbered reference matches a selected source.");
    expect(mismatchPresentation.headline).toBe("The citations do not match the selected sources.");
    expect(uncitedPresentation.headline).toBe("No numbered citations were found in this draft.");
    expect(unavailablePresentation.headline).toBe("The citation check could not run.");
  });

  it("preserves technicalDetail byte-identical to errors then warnings including shell commands", () => {
    const shellDiagnostic = "python3 -m checker --cited-in /tmp/sources.json --draft /tmp/draft.txt";
    const warningMsg = "warning: line 4 quote has no citation tag";
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "unavailable",
      errors: [shellDiagnostic],
      warnings: [warningMsg]
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.technicalDetail).toEqual([shellDiagnostic, warningMsg]);
  });

  it("replaces whitespace-only labels with Untitled source and trims labels", () => {
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "mismatch",
      sources: [
        { id: 1, label: "   ", uri: "https://example.com/empty" },
        { id: 3, label: "  Padded label  ", uri: "https://example.com/padded" }
      ]
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.expectedSourcesBlock).toBe(
      "Sources\n[1] Untitled source — https://example.com/empty\n[3] Padded label — https://example.com/padded"
    );
  });

  it("caps guidance at 3 sentences according to relevance ordering", () => {
    const input: CitationCheckLike = {
      ...baseCheck,
      status: "mismatch",
      sources: [{ id: 1, label: "Source 1", uri: "https://example.com/1" }],
      unknownReferences: ["[99]"],
      missingFromSourcesBlock: [42],
      unexpectedInSourcesBlock: [1],
      expectedSourcesBlock: ""
    };

    const presentation = presentCitationCheck(input);

    expect(presentation.guidance).toHaveLength(3);
    expect(presentation.guidance[0]).toContain("worked this block out");
    expect(presentation.guidance[1]).toContain("[99]");
    expect(presentation.guidance[2]).toContain("[42]");
    expect(presentation.guidance[2]).toContain("absent from the Sources list");
    // Nothing on this screen talks about the reader in the third person.
    for (const line of presentation.guidance) expect(line).not.toContain("the owner");
  });

  it("does not mutate input", () => {
    const sources = Object.freeze([
      Object.freeze({ id: 5, label: "Frozen B", uri: "https://example.com/b" }),
      Object.freeze({ id: 2, label: "Frozen A", uri: "https://example.com/a" })
    ]);
    const errors = Object.freeze(["err1"]);
    const warnings = Object.freeze(["warn1"]);
    const input = Object.freeze({
      ...baseCheck,
      status: "mismatch" as const,
      sources,
      errors,
      warnings
    });

    expect(() => presentCitationCheck(input)).not.toThrow();
    expect(sources[0]?.id).toBe(5);
  });
});
