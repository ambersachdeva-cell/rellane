import { describe, expect, it } from "vitest";
import { MAX_SEARCH_HITS, SNIPPET_CHARS, searchSources, type SearchDocument } from "./source-search.js";

describe("searchSources", () => {
  it("scores rare terms higher than terms common to every document (proves IDF)", () => {
    const docA: SearchDocument = { id: "docA", label: "Doc A", text: "special verdict" };
    const docB: SearchDocument = { id: "docB", label: "Doc B", text: "general verdict" };
    const docC: SearchDocument = { id: "docC", label: "Doc C", text: "general archive" };
    const docD: SearchDocument = { id: "docD", label: "Doc D", text: "general records" };

    const hits = searchSources([docA, docB, docC, docD], "special general");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.id).toBe("docA");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("ranks shorter documents higher given identical term frequency (proves length normalisation)", () => {
    const shortDoc: SearchDocument = { id: "short", label: "Short", text: "quantum" };
    const longDoc: SearchDocument = {
      id: "long",
      label: "Long",
      text: "quantum apple banana cherry date elderberry fig grape honeydew kiwi lemon mango",
    };

    const hits = searchSources([longDoc, shortDoc], "quantum");
    expect(hits.length).toBe(2);
    expect(hits[0]?.id).toBe("short");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("matches whole tokens only so searching act does not match contract", () => {
    const docWithContract: SearchDocument = {
      id: "contract-only",
      label: "Contract Only",
      text: "The signed contract was delivered yesterday.",
    };

    const hits = searchSources([docWithContract], "act");
    expect(hits).toEqual([]);

    const docWithBoth: SearchDocument = {
      id: "both",
      label: "Both",
      text: "We must act promptly before the contract expires.",
    };

    const bothHits = searchSources([docWithBoth], "act");
    expect(bothHits).toHaveLength(1);
    const hit = bothHits[0]!;
    expect(hit.highlights).toHaveLength(1);
    const [start, end] = hit.highlights[0]!;
    expect(hit.snippet.slice(start, end).toLowerCase()).toBe("act");
  });

  it("tokenises and searches Devanagari text correctly", () => {
    const doc: SearchDocument = {
      id: "hindi",
      label: "Hindi Source",
      text: "यह भारतीय संविधान का एक महत्वपूर्ण दस्तावेज है जिसमें नागरिक अधिकारों की रक्षा की गई है",
    };

    const hits = searchSources([doc], "संविधान");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.highlights).toHaveLength(1);
    const [start, end] = hit.highlights[0]!;
    expect(hit.snippet.slice(start, end)).toBe("संविधान");
  });

  it("centres snippet on match at document end with leading ellipsis", () => {
    const filler = "introductory background material ".repeat(25);
    const text = filler + "at the absolute conclusion lies the evidence";
    const doc: SearchDocument = { id: "end-match", label: "End Match", text };

    const hits = searchSources([doc], "evidence");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(false);
    expect(hit.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
  });

  it("lands highlight ranges exactly on matched words including with leading ellipsis", () => {
    const filler = "preceding paragraph content ".repeat(25);
    const text = filler + "crucial milestone reached here " + "trailing paragraph content ".repeat(25);
    const doc: SearchDocument = { id: "highlight-doc", label: "Highlight Doc", text };

    const hits = searchSources([doc], "milestone");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.highlights).toHaveLength(1);
    const [start, end] = hit.highlights[0]!;
    expect(hit.snippet.slice(start, end)).toBe("milestone");
    // The real invariant, rather than a guess at where the window opens: strip
    // the ellipses the window added and what is left must be exactly the text
    // that lives at `snippetOffset`. That holds wherever the densest cluster
    // happens to put the window, which is the whole point of centring on it.
    const body = hit.snippet.replace(/^…/u, "").replace(/…$/u, "");
    expect(text.slice(hit.snippetOffset, hit.snippetOffset + body.length)).toBe(body);
    expect(text.slice(hit.snippetOffset).startsWith(body)).toBe(true);
    // And the highlight still points at the same word in the document itself.
    const leading = hit.snippet.startsWith("…") ? 1 : 0;
    expect(text.slice(hit.snippetOffset + start - leading, hit.snippetOffset + end - leading)).toBe("milestone");
  });

  it("returns empty array and does not throw for empty or punctuation inputs", () => {
    const doc: SearchDocument = { id: "valid", label: "Valid", text: "Some meaningful document text" };

    expect(searchSources([doc], "")).toEqual([]);
    expect(searchSources([doc], "   \t\n  ")).toEqual([]);
    expect(searchSources([doc], "!!! ??? ... --- ,,,")).toEqual([]);
    expect(searchSources([doc], "a b c")).toEqual([]);
    expect(searchSources([], "meaningful")).toEqual([]);
    expect(searchSources([{ id: "empty", label: "Empty", text: "" }], "meaningful")).toEqual([]);
  });

  it("caps results at MAX_SEARCH_HITS returning best first", () => {
    const docs: SearchDocument[] = Array.from({ length: 25 }, (_, i) => ({
      id: `doc-${i}`,
      label: `Document ${i}`,
      text: `beacon ${"filler words ".repeat(i)}`,
    }));

    const hits = searchSources(docs, "beacon");
    expect(hits).toHaveLength(MAX_SEARCH_HITS);
    expect(MAX_SEARCH_HITS).toBe(20);

    for (let i = 0; i < hits.length - 1; i++) {
      const current = hits[i]!;
      const next = hits[i + 1]!;
      expect(current.score).toBeGreaterThanOrEqual(next.score);
    }
  });

  it("prioritises the densest cluster over isolated earlier mentions", () => {
    const toc = "Table of contents: audit section ... ";
    const body = "audit findings confirm the audit was conducted according to audit standards with full audit compliance.";
    const text = toc + "padding text ".repeat(40) + body;
    const doc: SearchDocument = { id: "cluster-doc", label: "Cluster Doc", text };

    const hits = searchSources([doc], "audit");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.highlights.length).toBeGreaterThanOrEqual(4);
    for (const [start, end] of hit.highlights) {
      expect(hit.snippet.slice(start, end).toLowerCase()).toBe("audit");
    }
  });

  it("preserves stable document order on tied scores", () => {
    const doc1: SearchDocument = { id: "alpha", label: "Alpha", text: "identical text" };
    const doc2: SearchDocument = { id: "beta", label: "Beta", text: "identical text" };

    const hits = searchSources([doc1, doc2], "identical");
    expect(hits).toHaveLength(2);
    expect(hits[0]?.id).toBe("alpha");
    expect(hits[1]?.id).toBe("beta");
  });
});
