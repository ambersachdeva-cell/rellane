import { describe, expect, it } from "vitest";
import { summariseToolReview, type ReviewToolsLike } from "./tool-review.js";

function createBaselineTools(overrides: Partial<ReviewToolsLike> = {}): ReviewToolsLike {
  return {
    enabled: true,
    toolNames: [
      "rellane_list_sources",
      "rellane_read_source",
      "hermes_list_skills",
      "hermes_read_skill",
      "hermes_check_citations",
    ],
    skillIds: ["hermes/document-to-action-items"],
    sources: [
      { label: "Brief.md", chars: 1200 },
      { label: "Data.csv", chars: 3400 },
    ],
    totalSourceChars: 4600,
    reachNote: "Custom reach note from host.",
    freshSessionNote: "Custom fresh session note from host.",
    ...overrides,
  };
}

describe("summariseToolReview", () => {
  it("returns null when tools are disabled", () => {
    const tools = createBaselineTools({ enabled: false });
    const result = summariseToolReview(tools);
    expect(result).toBeNull();
  });

  it("preserves unrecognised tool names with an explanatory detail rather than dropping them", () => {
    const tools = createBaselineTools({
      toolNames: ["unknown_custom_tool", "rellane_read_source"],
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.toolRows).toHaveLength(2);
    const unknownRow = result.toolRows[0];
    expect(unknownRow).toBeDefined();
    if (!unknownRow) return;
    expect(unknownRow.label).toBe("unknown_custom_tool");
    expect(unknownRow.detail).toContain("does not recognise");
  });

  it("states no tools are available when toolNames is empty and leaves toolRows empty", () => {
    const tools = createBaselineTools({ toolNames: [] });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.heading.toLowerCase()).toContain("no tools");
    expect(result.toolRows).toHaveLength(0);
  });

  it("falls back to Untitled source for empty labels and formats 1 character as singular", () => {
    const tools = createBaselineTools({
      sources: [
        { label: "   ", chars: 1 },
        { label: "Notes.txt", chars: 1500 },
      ],
      totalSourceChars: 1501,
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sourceRows).toHaveLength(2);
    const first = result.sourceRows[0];
    const second = result.sourceRows[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    expect(first.label).toBe("Untitled source");
    expect(first.detail).toBe("1 character");
    expect(second.label).toBe("Notes.txt");
    expect(second.detail).toBe("1,500 characters");
  });

  it("displays the host's totalSourceChars as given even if it differs from the sum of sources", () => {
    const tools = createBaselineTools({
      sources: [{ label: "Document.md", chars: 100 }],
      totalSourceChars: 99999,
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.totalLine).toContain("99,999 characters across 1 source");
  });

  it("provides non-empty fallbacks when reachNote and freshSessionNote are empty or whitespace", () => {
    const tools = createBaselineTools({
      reachNote: "   ",
      freshSessionNote: "",
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.reachLine.trim().length).toBeGreaterThan(0);
    expect(result.reachLine.toLowerCase()).toContain("readable in full");
    expect(result.sessionLine.trim().length).toBeGreaterThan(0);
    expect(result.sessionLine.toLowerCase()).toContain("new native session");
  });

  it("shows no sources selected and empty sourceRows when sources list is empty", () => {
    const tools = createBaselineTools({
      sources: [],
      totalSourceChars: 0,
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.totalLine).toBe("no sources selected");
    expect(result.sourceRows).toHaveLength(0);
  });

  it("maps all five known tools to their exact labels and plain English descriptions", () => {
    const tools = createBaselineTools({
      toolNames: [
        "rellane_list_sources",
        "rellane_read_source",
        "hermes_list_skills",
        "hermes_read_skill",
        "hermes_check_citations",
      ],
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.toolRows).toEqual([
      {
        label: "List your sources",
        detail: "Names the sources you selected and how long each one is.",
      },
      {
        label: "Read a source",
        detail: "Reads one selected source, a page at a time.",
      },
      {
        label: "List bundled procedures",
        detail: "Names the procedures bundled with this app.",
      },
      {
        label: "Read a bundled procedure",
        detail: "Reads one procedure bundled with this app.",
      },
      {
        label: "Check citations",
        detail: "Checks a draft's citations against your selected sources.",
      },
    ]);
  });

  it("formats skillIds into capitalized skill names and preserves empty list", () => {
    const tools = createBaselineTools({
      skillIds: [
        "hermes/document-to-action-items",
        "hermes/extract_key_figures",
      ],
    });
    const result = summariseToolReview(tools);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.skillNames).toEqual([
      "Document To Action Items",
      "Extract Key Figures",
    ]);

    const emptyTools = createBaselineTools({ skillIds: [] });
    const emptyResult = summariseToolReview(emptyTools);
    expect(emptyResult?.skillNames).toEqual([]);
  });

  it("formats singular tool count correctly in heading", () => {
    const tools = createBaselineTools({ toolNames: ["rellane_read_source"] });
    const result = summariseToolReview(tools);
    expect(result?.heading).toBe("1 tool for this session");
  });
});
