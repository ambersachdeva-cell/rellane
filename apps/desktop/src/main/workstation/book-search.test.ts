import { describe, expect, it } from "vitest";
import { MAX_HITS, SNIPPET_CHARS, searchBook, type SearchableTurn } from "./book-search.js";

interface TurnOptions {
  readonly id: string;
  readonly body: string;
  readonly caseId?: string;
  readonly caseTitle?: string;
  readonly seat?: string;
  readonly kind?: string;
  readonly at?: number;
}

function createTurn(opts: TurnOptions): SearchableTurn {
  return {
    id: opts.id,
    caseId: opts.caseId ?? "case-1",
    caseTitle: opts.caseTitle ?? "General Project",
    seat: opts.seat ?? "user",
    kind: opts.kind ?? "message",
    body: opts.body,
    at: opts.at ?? 1000,
  };
}

describe("searchBook", () => {
  it("a rare term outranks a common one", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t-rare", body: "unusualterm quarterly review", at: 100 }),
      createTurn({ id: "t-common-1", body: "quarterly review notes", at: 200 }),
      createTurn({ id: "t-common-2", body: "quarterly review planning", at: 300 }),
      createTurn({ id: "t-common-3", body: "quarterly review feedback", at: 400 }),
    ];
    const outcome = searchBook(turns, "unusualterm quarterly");
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits[0]!.turnId).toBe("t-rare");
  });

  it("a short turn beats a long one containing the same term the same number of times", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({
        id: "t-long",
        body: "the annual budget document contains detailed expenditure records for all departments across multiple fiscal years without omitting anything",
        at: 100,
      }),
      createTurn({
        id: "t-short",
        body: "budget",
        at: 100,
      }),
    ];
    const outcome = searchBook(turns, "budget");
    expect(outcome.hits.length).toBe(2);
    expect(outcome.hits[0]!.turnId).toBe("t-short");
    expect(outcome.hits[1]!.turnId).toBe("t-long");
  });

  it("a quoted phrase requires adjacency", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t-adjacent", body: "print budget approved today", at: 100 }),
      createTurn({ id: "t-separated", body: "print the preliminary monthly budget", at: 200 }),
    ];
    const outcome = searchBook(turns, '"print budget"');
    expect(outcome.hits.length).toBe(1);
    expect(outcome.hits[0]!.turnId).toBe("t-adjacent");
  });

  it("-term excludes", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t-draft", body: "print budget draft copy", at: 100 }),
      createTurn({ id: "t-final", body: "print budget final approved", at: 200 }),
    ];
    const outcome = searchBook(turns, "budget -draft");
    expect(outcome.hits.length).toBe(1);
    expect(outcome.hits[0]!.turnId).toBe("t-final");
  });

  it("Devanagari is searchable", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t-hindi", body: "यहाँ हमारा नया बजट है", at: 100 }),
      createTurn({ id: "t-other", body: "पुरानी योजना और नियम", at: 200 }),
    ];
    const outcome = searchBook(turns, "बजट");
    expect(outcome.hits.length).toBe(1);
    expect(outcome.hits[0]!.turnId).toBe("t-hindi");
    expect(outcome.hits[0]!.highlights.length).toBeGreaterThan(0);
  });

  it('highlights slice exactly onto the matched words including with a leading "…"', () => {
    const filler = "The quick brown fox jumps over the lazy dog repeatedly to lengthen this statement. ";
    const longBody = `${filler}${filler}${filler}Essential concurrence secured. ${filler}`;
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t-highlight", body: longBody, at: 100 }),
    ];
    const outcome = searchBook(turns, "concurrence");
    expect(outcome.hits.length).toBe(1);
    const hit = outcome.hits[0]!;
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
    expect(hit.highlights.length).toBe(1);
    const range = hit.highlights[0]!;
    const matchedWord = hit.snippet.slice(range[0], range[1]);
    expect(matchedWord.toLowerCase()).toBe("concurrence");
  });

  it("receipts excluded", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t-work", kind: "message", body: "subscription payment approved", at: 100 }),
      createTurn({ id: "t-receipt", kind: "receipt", body: "subscription payment receipt", at: 200 }),
      createTurn({ id: "t-permission", kind: "permission_record", body: "subscription payment permission", at: 300 }),
    ];
    const outcome = searchBook(turns, "payment");
    expect(outcome.hits.length).toBe(1);
    expect(outcome.hits[0]!.turnId).toBe("t-work");
    expect(outcome.matched).toBe(1);
    expect(outcome.summary).toBe("1 match across 1 piece of work.");
  });

  it("stable ordering", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "b-older", body: "identical match query", at: 1000 }),
      createTurn({ id: "a-newer", body: "identical match query", at: 2000 }),
      createTurn({ id: "z-same-time", body: "identical match query", at: 3000 }),
      createTurn({ id: "m-same-time", body: "identical match query", at: 3000 }),
    ];
    const outcome = searchBook(turns, "identical match");
    expect(outcome.hits.length).toBe(4);
    expect(outcome.hits[0]!.turnId).toBe("m-same-time");
    expect(outcome.hits[1]!.turnId).toBe("z-same-time");
    expect(outcome.hits[2]!.turnId).toBe("a-newer");
    expect(outcome.hits[3]!.turnId).toBe("b-older");
  });

  it("empty query", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t1", body: "active work", at: 100 }),
    ];
    const outcomeEmpty = searchBook(turns, "");
    expect(outcomeEmpty.hits).toEqual([]);
    expect(outcomeEmpty.matched).toBe(0);
    expect(outcomeEmpty.summary).toBe("0 matches across 0 pieces of work.");

    const outcomeSpaces = searchBook(turns, "   ");
    expect(outcomeSpaces.hits).toEqual([]);
    expect(outcomeSpaces.matched).toBe(0);
  });

  it("formats seat labels to human names in the owner's language", () => {
    const turns: readonly SearchableTurn[] = [
      createTurn({ id: "t1", seat: "user", body: "common conversation", at: 100 }),
      createTurn({ id: "t2", seat: "codex", body: "common conversation", at: 200 }),
      createTurn({ id: "t3", seat: "claude", body: "common conversation", at: 300 }),
      createTurn({ id: "t4", seat: "gemini-profile-1", body: "common conversation", at: 400 }),
    ];
    const outcome = searchBook(turns, "conversation");
    const names = outcome.hits.map(h => h.who);
    expect(names).toContain("You");
    expect(names).toContain("Codex");
    expect(names).toContain("Claude");
    expect(names).toContain("Gemini (Profile 1)");
  });

  it("caps results at MAX_HITS and accurately reports matched count", () => {
    const turns: SearchableTurn[] = [];
    for (let i = 0; i < 60; i++) {
      turns.push(createTurn({ id: `turn-${i}`, body: "frequent item across turns", at: i }));
    }
    const outcome = searchBook(turns, "frequent");
    expect(outcome.hits.length).toBe(MAX_HITS);
    expect(outcome.matched).toBe(60);
  });
});
