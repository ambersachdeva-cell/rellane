import { describe, expect, it } from "vitest";
import { groupRanked, rankCommands, type Command } from "./commands";

const CATALOGUE: readonly Command[] = [
  { id: "bill.raise", title: "Raise a bill", group: "Do", keywords: ["invoice", "charge"] },
  { id: "payment.record", title: "Record a payment", group: "Do", keywords: ["received", "paid"] },
  { id: "backup.now", title: "Back up the book now", group: "Do" },
  { id: "go.book", title: "Records", group: "Go", keywords: ["book", "ledger"] },
  { id: "go.timeline", title: "Timeline", group: "Go" },
  { id: "go.bench", title: "Bench", group: "Go" },
  { id: "party.new", title: "Add a party", group: "Book", keywords: ["customer", "supplier", "client"] },
  { id: "crew.stop", title: "Stop every seat", group: "Crew", keywords: ["halt", "kill"] }
];

function titles(query: string): readonly string[] {
  return rankCommands(query, CATALOGUE).map((row) => row.command.title);
}

describe("the palette is a menu before it is a search", () => {
  it("returns everything when nothing is typed", () => {
    expect(rankCommands("", CATALOGUE)).toHaveLength(CATALOGUE.length);
  });

  it("puts verbs before destinations on an empty query", () => {
    // Somebody who opens the palette and sees a list of rooms has learned it is
    // a nav menu, and will go back to using the rail.
    const groups = rankCommands("", CATALOGUE).map((row) => row.command.group);
    expect(groups.indexOf("Do")).toBeLessThan(groups.indexOf("Go"));
  });

  it("whitespace alone counts as nothing typed", () => {
    expect(rankCommands("   ", CATALOGUE)).toHaveLength(CATALOGUE.length);
  });
});

describe("typing initials is how a palette is actually used", () => {
  it("finds “Raise a bill” from rab", () => {
    expect(titles("rab")[0]).toBe("Raise a bill");
  });

  it("finds “Record a payment” from rap", () => {
    expect(titles("rap")[0]).toBe("Record a payment");
  });

  it("prefers a word-start match over the same letters buried mid-word", () => {
    // "ses" is a subsequence of both, but only one of them is three word starts.
    expect(titles("ses")[0]).toBe("Stop every seat");
  });
});

describe("an exact prefix beats every cleverness", () => {
  it("ranks the title that starts with what was typed first", () => {
    // "Bench" and "Back up the book now" both begin with b; only one continues.
    expect(titles("ben")[0]).toBe("Bench");
  });

  it("is case-insensitive in both directions", () => {
    expect(titles("TIMELINE")[0]).toBe("Timeline");
    expect(titles("timeline")[0]).toBe("Timeline");
  });

  it("prefers the shorter of two titles that match equally well", () => {
    // Both start with the whole query, so every bonus below the length penalty
    // is identical and the shorter title is the better answer.
    const pair: readonly Command[] = [
      { id: "a", title: "Bench", group: "Go" },
      { id: "b", title: "Bench, with the adjudicator seated", group: "Go" }
    ];
    expect(rankCommands("bench", pair)[0]?.command.title).toBe("Bench");
  });

  it("ranks a real title match above a row found only by keyword", () => {
    // "book" is the word the customer uses; "Records" is the word the product
    // uses. Both belong in the result, and the one whose text actually matched
    // goes first.
    const ranked = titles("book");
    expect(ranked[0]).toBe("Back up the book now");
    expect(ranked).toContain("Records");
  });
});

describe("a word the product uses beats a synonym we guessed", () => {
  it("finds a command by a keyword that is nowhere in its title", () => {
    expect(titles("customer")).toContain("Add a party");
  });

  it("scores a keyword hit below any title match", () => {
    // "invoice" is a keyword of "Raise a bill" and appears in no title, so the
    // row is present but must not outrank a real title match when one exists.
    const ranked = rankCommands("re", CATALOGUE);
    const keywordRows = ranked.filter((row) => row.marks.length === 0);
    const titleRows = ranked.filter((row) => row.marks.length > 0);
    for (const keywordRow of keywordRows) {
      for (const titleRow of titleRows) {
        expect(titleRow.score).toBeGreaterThan(keywordRow.score);
      }
    }
  });
});

describe("what does not match", () => {
  it("returns nothing rather than everything when there is no match", () => {
    // An empty result is a real answer. Falling back to the whole list would
    // teach people the palette ignores what they type.
    expect(rankCommands("zzzz", CATALOGUE)).toHaveLength(0);
  });

  it("refuses a query whose letters are out of order", () => {
    // Subsequence, not anagram: "lbi" is not "bill".
    expect(titles("lbi")).not.toContain("Raise a bill");
  });
});

describe("the marks point at the reason the row is there", () => {
  it("returns one index per typed character, in order", () => {
    const [top] = rankCommands("rab", CATALOGUE);
    expect(top?.marks).toHaveLength(3);
    const marks = [...(top?.marks ?? [])];
    expect(marks).toEqual([...marks].sort((a, b) => a - b));
  });

  it("indexes characters that really are the typed ones", () => {
    const [top] = rankCommands("rab", CATALOGUE);
    const title = top?.command.title ?? "";
    const picked = (top?.marks ?? []).map((index) => title[index]?.toLowerCase()).join("");
    expect(picked).toBe("rab");
  });
});

describe("grouping happens after ranking, never before", () => {
  it("keeps the best answer as the first row of the first group", () => {
    // Sorting by group first would bury an exact match under a heading, which
    // is what stops people reading past row one.
    const sections = groupRanked(rankCommands("rab", CATALOGUE));
    expect(sections[0]?.rows[0]?.command.title).toBe("Raise a bill");
  });

  it("drops groups that matched nothing", () => {
    const sections = groupRanked(rankCommands("rab", CATALOGUE));
    expect(sections.every((section) => section.rows.length > 0)).toBe(true);
  });

  it("keeps every matched row when regrouped", () => {
    const ranked = rankCommands("a", CATALOGUE);
    const regrouped = groupRanked(ranked).flatMap((section) => section.rows);
    expect(regrouped).toHaveLength(ranked.length);
  });
});
