import { describe, expect, it } from "vitest";
import { searchCommands, type CommandItem, MAX_COMMAND_HITS } from "./command-search.js";

describe("searchCommands", () => {
  it("finds items despite a single-character typo", () => {
    const item: CommandItem = {
      id: "1",
      kind: "work",
      title: "Quotation",
      detail: "Customer quote details",
      at: 1000,
    };
    const hits = searchCommands([item], "quotaton");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item.id).toBe("1");
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.score).toBeLessThanOrEqual(0.4);
  });

  it("finds items when words are given in a different order", () => {
    const item: CommandItem = {
      id: "1",
      kind: "work",
      title: "Quotation reply",
      detail: "Client negotiation",
      at: 1000,
    };
    const hits = searchCommands([item], "reply quotation");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item.id).toBe("1");
  });

  it("extracts titleRanges that land exactly on the matched characters", () => {
    const item: CommandItem = {
      id: "1",
      kind: "work",
      title: "Quotation reply",
      detail: "Draft",
      at: 1000,
    };
    const hits = searchCommands([item], "reply quotation");
    expect(hits).toHaveLength(1);
    const ranges = hits[0]?.titleRanges ?? [];
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    // Asserted as the invariant rather than as two separate ranges: the module
    // is asked to merge ranges that touch, so a match covering the whole title
    // legitimately comes back as one range, and demanding two would be testing
    // Fuse's reporting shape instead of what the marks must do.
    const marked = ranges.map(([start, end]) => item.title.slice(start, end)).join("");
    expect(marked).toContain("Quotation");
    expect(marked).toContain("reply");
    for (const [start, end] of ranges) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(item.title.length);
      expect(end).toBeGreaterThan(start);
    }
    // Ascending and non-overlapping, so the renderer can walk them in one pass.
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1]);
    }
  });

  it("returns half-open ranges [start, end) where end is exclusive", () => {
    const item: CommandItem = {
      id: "1",
      kind: "work",
      title: "Quotation",
      detail: "",
      at: 1000,
    };
    const hits = searchCommands([item], "Quo");
    expect(hits).toHaveLength(1);
    const firstRange = hits[0]?.titleRanges[0];
    expect(firstRange).toBeDefined();
    expect(firstRange).toEqual([0, 3]);
    expect(firstRange).not.toEqual([0, 2]);
    if (firstRange) {
      expect(item.title.slice(firstRange[0], firstRange[1])).toBe("Quo");
    }
  });

  it("returns recent items first with score 0 and empty ranges for empty or whitespace-only queries", () => {
    const items: CommandItem[] = [
      { id: "old", kind: "work", title: "Old work", detail: "", at: 100 },
      { id: "newest", kind: "project", title: "Newest project", detail: "", at: 300 },
      { id: "middle", kind: "routine", title: "Middle routine", detail: "", at: 200 },
    ];

    const emptyHits = searchCommands(items, "");
    expect(emptyHits.map((h) => h.item.id)).toEqual(["newest", "middle", "old"]);
    expect(emptyHits.every((h) => h.score === 0)).toBe(true);
    expect(emptyHits.every((h) => h.titleRanges.length === 0)).toBe(true);

    const whitespaceHits = searchCommands(items, "   \t\n  ");
    expect(whitespaceHits.map((h) => h.item.id)).toEqual(["newest", "middle", "old"]);
    expect(whitespaceHits.every((h) => h.score === 0)).toBe(true);
    expect(whitespaceHits.every((h) => h.titleRanges.length === 0)).toBe(true);
  });

  it("caps results at MAX_COMMAND_HITS", () => {
    const items: CommandItem[] = Array.from({ length: 45 }, (_, i) => ({
      id: `item-${i.toString().padStart(2, "0")}`,
      kind: "work",
      title: `Project report ${i}`,
      detail: "",
      at: 1000 + i,
    }));

    const hits = searchCommands(items, "report");
    expect(hits).toHaveLength(MAX_COMMAND_HITS);
    expect(MAX_COMMAND_HITS).toBe(30);

    const emptyHits = searchCommands(items, "");
    expect(emptyHits).toHaveLength(MAX_COMMAND_HITS);
  });

  it("breaks ties with equal score by at descending then id in a stable order", () => {
    const itemA: CommandItem = {
      id: "item-b",
      kind: "work",
      title: "Audit notes",
      detail: "",
      at: 500,
    };
    const itemB: CommandItem = {
      id: "item-a",
      kind: "work",
      title: "Audit notes",
      detail: "",
      at: 500,
    };
    const itemC: CommandItem = {
      id: "item-c",
      kind: "work",
      title: "Audit notes",
      detail: "",
      at: 800,
    };

    const list1 = [itemA, itemB, itemC];
    const list2 = [itemB, itemC, itemA];

    const hits1 = searchCommands(list1, "Audit notes");
    const hits2 = searchCommands(list2, "Audit notes");

    const expectedIds = ["item-c", "item-a", "item-b"];
    expect(hits1.map((h) => h.item.id)).toEqual(expectedIds);
    expect(hits2.map((h) => h.item.id)).toEqual(expectedIds);
  });

  it("handles empty lists, empty titles, and punctuation queries without throwing", () => {
    expect(searchCommands([], "test")).toEqual([]);
    expect(searchCommands([], "")).toEqual([]);

    const emptyTitleItems: CommandItem[] = [
      { id: "empty-title", kind: "output", title: "", detail: "Contains detailed notes", at: 100 },
    ];
    expect(() => searchCommands(emptyTitleItems, "detailed")).not.toThrow();
    const detailHits = searchCommands(emptyTitleItems, "detailed");
    expect(detailHits).toHaveLength(1);
    expect(detailHits[0]?.titleRanges).toEqual([]);

    const normalItems: CommandItem[] = [
      { id: "1", kind: "work", title: "General discussion", detail: "Notes", at: 100 },
    ];
    expect(() => searchCommands(normalItems, "!@#$%^&*()")).not.toThrow();
    expect(searchCommands(normalItems, "!@#$%^&*()")).toEqual([]);
    expect(() => searchCommands(normalItems, "???")).not.toThrow();
    expect(() => searchCommands(normalItems, "...")).not.toThrow();
  });

  it("weights title matches higher than detail matches", () => {
    const titleMatch: CommandItem = {
      id: "title-hit",
      kind: "work",
      title: "Quarterly accounts",
      detail: "General correspondence",
      at: 100,
    };
    const detailMatch: CommandItem = {
      id: "detail-hit",
      kind: "work",
      title: "General correspondence",
      detail: "Quarterly accounts",
      at: 100,
    };

    const hits = searchCommands([detailMatch, titleMatch], "accounts");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.item.id).toBe("title-hit");
    expect(hits[1]?.item.id).toBe("detail-hit");
    expect((hits[0]?.score ?? 0)).toBeLessThan(hits[1]?.score ?? 1);
  });

  it("never mutates the input array", () => {
    const items: readonly CommandItem[] = Object.freeze([
      Object.freeze({ id: "2", kind: "work" as const, title: "Beta", detail: "", at: 200 }),
      Object.freeze({ id: "1", kind: "work" as const, title: "Alpha", detail: "", at: 100 }),
    ]);
    const snapshot = items.map((i) => i.id);
    searchCommands(items, "");
    searchCommands(items, "Alpha");
    expect(items.map((i) => i.id)).toEqual(snapshot);
  });
});
