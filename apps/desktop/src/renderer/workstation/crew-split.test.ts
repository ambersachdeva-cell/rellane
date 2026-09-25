import { describe, expect, it } from "vitest";
import { eligibleCrewIntegrationOwners, splitForCrew, withCrewIntegrationOwner } from "./crew-split.js";
import type { CrewSplitInput } from "./crew-split.js";

const TWO_SEATS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" }
] as const;

const THREE_SEATS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" }
] as const;

describe("Crew integration ownership", () => {
  it("joins parallel packages under the reviewed final owner without changing their work", () => {
    const split = splitForCrew({
      request: "Part A: research the sources. Part B: check the claims. Part C: write the result.",
      seats: THREE_SEATS,
      sourceIds: []
    });
    expect(eligibleCrewIntegrationOwners(split.parts)).toEqual(["part-1", "part-2", "part-3"]);
    const integrated = withCrewIntegrationOwner(split.parts, "part-3");
    expect(integrated[2]?.dependsOn).toEqual(["part-1", "part-2"]);
    expect(integrated[0]?.prompt).toBe(split.parts[0]?.prompt);
    expect(integrated[1]?.prompt).toBe(split.parts[1]?.prompt);
  });

  it("rejects an upstream owner that would create a dependency cycle", () => {
    const split = splitForCrew({
      request: "Research the sources and then write the summary",
      seats: TWO_SEATS,
      sourceIds: []
    });
    expect(eligibleCrewIntegrationOwners(split.parts)).toEqual(["part-2"]);
    expect(() => withCrewIntegrationOwner(split.parts, "part-1")).toThrow(/final-result owner/);
  });
});

describe("splitForCrew", () => {
  it("splits explicit Part A and Part B labels across seats without dependencies", () => {
    const input: CrewSplitInput = {
      request: "Part A: summarise the contract. Part B: list the risks.",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.refusedBecause).toBeNull();
    expect(result.wholeJob).toBe(false);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]?.seatLabel).toBe("Claude");
    expect(result.parts[0]?.title).toBe("Summarise the contract");
    expect(result.parts[0]?.dependsOn).toEqual([]);
    expect(result.parts[1]?.seatLabel).toBe("Codex");
    expect(result.parts[1]?.title).toBe("List the risks");
    expect(result.parts[1]?.dependsOn).toEqual([]);
    expect(result.summary).toBe("Claude will summarise the contract, and Codex will list the risks.");
  });

  it("wires sequential dependency when request uses and then", () => {
    const input: CrewSplitInput = {
      request: "Read the file and then write a summary",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.wholeJob).toBe(false);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]?.seatLabel).toBe("Claude");
    expect(result.parts[0]?.dependsOn).toEqual([]);
    expect(result.parts[1]?.seatLabel).toBe("Codex");
    expect(result.parts[1]?.dependsOn).toEqual(["part-1"]);
    expect(result.summary).toBe("Claude will read the file, then Codex will write a summary.");
  });

  it("assigns entire job to first seat and names spare bots when text has no structure", () => {
    const input: CrewSplitInput = {
      request: "Please help understand our commercial lease terms for the Leeds office.",
      seats: THREE_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.wholeJob).toBe(true);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.seatLabel).toBe("Claude");
    expect(result.summary).toBe("Claude will take the whole job, while Codex and Gemini sit this one out to preserve your quota.");
  });

  it("filters pleasantries and short items from numbered lists", () => {
    const input: CrewSplitInput = {
      request: "1. Summarise the contract terms\n2. List the high risk clauses\n3. thanks!",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]?.title).toBe("Summarise the contract terms");
    expect(result.parts[1]?.title).toBe("List the high risk clauses");
  });

  it("detects inline list letters inside a sentence", () => {
    const input: CrewSplitInput = {
      request: "Please do a) summarise the contract and b) list the risks.",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]?.title).toBe("Summarise the contract");
    expect(result.parts[1]?.title).toBe("List the risks");
  });

  it("caps long lists at six parts and mentions the limit in the summary", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `- review section ${i + 1} of the contract`);
    const input: CrewSplitInput = {
      request: lines.join("\n"),
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.parts).toHaveLength(6);
    expect(result.summary).toContain("capped at 6 from 40 items in your request");
  });

  it("handles mixed sequential and parallel requests with multi-part dependencies", () => {
    const input: CrewSplitInput = {
      request: "do a and b, then c",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.parts).toHaveLength(3);
    expect(result.parts[0]?.dependsOn).toEqual([]);
    expect(result.parts[1]?.dependsOn).toEqual([]);
    expect(result.parts[2]?.dependsOn).toEqual(expect.arrayContaining(["part-1", "part-2"]));
  });

  it("normalises Windows line endings cleanly", () => {
    const input: CrewSplitInput = {
      request: "1. Summarise the contract terms\r\n2. List the high risk clauses",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.parts).toHaveLength(2);
  });

  it("treats entire code blocks as a single job without splitting", () => {
    const input: CrewSplitInput = {
      request: "```python\ndef calculate_margin(revenue, cost):\n    return (revenue - cost) / revenue\n```",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.wholeJob).toBe(true);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.title).toBe("Review code block");
  });

  it("refuses requests that are too short, too long, or have no seats", () => {
    expect(splitForCrew({ request: "hi", seats: TWO_SEATS, sourceIds: [] }).refusedBecause).toBe(
      "Your request must be at least 3 characters long."
    );
    expect(splitForCrew({ request: "a".repeat(10001), seats: TWO_SEATS, sourceIds: [] }).refusedBecause).toBe(
      "Your request is too long to divide. Keep it under 10,000 characters."
    );
    expect(splitForCrew({ request: "valid request", seats: [], sourceIds: [] }).refusedBecause).toBe(
      "Select at least one bot to divide work."
    );
  });

  it("enforces round-robin ordering and same-seat sequential dependencies when parts exceed seats", () => {
    const input: CrewSplitInput = {
      request: "1. Review term one carefully\n2. Review term two carefully\n3. Review term three carefully\n4. Review term four carefully",
      seats: TWO_SEATS,
      sourceIds: []
    };
    const result = splitForCrew(input);
    expect(result.parts).toHaveLength(4);
    expect(result.parts[0]?.seatLabel).toBe("Claude");
    expect(result.parts[1]?.seatLabel).toBe("Codex");
    expect(result.parts[2]?.seatLabel).toBe("Claude");
    expect(result.parts[2]?.dependsOn).toContain("part-1");
    expect(result.parts[3]?.seatLabel).toBe("Codex");
    expect(result.parts[3]?.dependsOn).toContain("part-2");
  });
});
