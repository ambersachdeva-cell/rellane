import { describe, expect, it } from "vitest";
import {
  chunkText,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  cosineSimilarity,
  MAX_CHUNKS_PER_SOURCE,
  rankBySimilarity,
} from "./embedding-index.js";

describe("embedding-index", () => {
  describe("chunkText", () => {
    it("splits a 3-paragraph document cleanly on blank lines rather than mid-sentence", () => {
      const p1 = "First paragraph outlines the financial ledger in full detail. ".repeat(8).trim();
      const p2 = "Second paragraph discusses the print shop invoices and overdue debt. ".repeat(8).trim();
      const p3 = "Third paragraph clarifies who actually owes the printer for the run. ".repeat(8).trim();
      const doc = `${p1}\n\n${p2}\n\n${p3}`;

      const chunks = chunkText("src-1", doc);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(doc.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
        const startsAtP1 = chunk.offset === 0;
        const startsAtP2 = chunk.offset === doc.indexOf(p2);
        const startsAtP3 = chunk.offset === doc.indexOf(p3);
        expect(startsAtP1 || startsAtP2 || startsAtP3).toBe(true);

        const endsAtP1 = chunk.offset + chunk.text.length === p1.length;
        const endsAtP2 = chunk.offset + chunk.text.length === doc.indexOf(p2) + p2.length;
        const endsAtP3 = chunk.offset + chunk.text.length === doc.length;
        expect(endsAtP1 || endsAtP2 || endsAtP3).toBe(true);
      }
    });

    it("splits a single sentence longer than CHUNK_TARGET_CHARS so no chunk exceeds the target", () => {
      const longSentence = "A".repeat(2_500);
      const chunks = chunkText("src-2", longSentence);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
        expect(longSentence.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      }
    });

    it("round-trips chunk offsets through text.slice exactly for all chunks in multi-paragraph input", () => {
      const paragraphs = [
        "Alpha section about equipment maintenance and scheduling.",
        "Beta section reviewing supplier accounts and paper orders.",
        "Gamma section tracking customer receipts and deposits.",
        "Delta section summarising quarter-end closing figures.",
      ];
      const text = paragraphs.join("\n\n");
      const chunks = chunkText("src-roundtrip", text);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
      }
    });

    it("produces byte-identical chunk IDs for identical input across multiple runs", () => {
      const text = "A repeatable note about print workshop expenditure.\n\nSecond line with exact figures.";
      const run1 = chunkText("source-stable", text);
      const run2 = chunkText("source-stable", text);
      expect(run1.length).toBe(run2.length);
      for (let i = 0; i < run1.length; i++) {
        expect(run1[i]!.id).toBe(run2[i]!.id);
        expect(run1[i]!.offset).toBe(run2[i]!.offset);
        expect(run1[i]!.text).toBe(run2[i]!.text);
      }
    });

    it("returns an empty array for empty or whitespace-only text", () => {
      expect(chunkText("src-empty", "")).toEqual([]);
      expect(chunkText("src-spaces", "   \t\r\n   \n\n  ")).toEqual([]);
    });

    it("caps output at exactly MAX_CHUNKS_PER_SOURCE when input is excessively long", () => {
      const paragraphs: string[] = [];
      for (let i = 0; i < 500; i++) {
        paragraphs.push(`Paragraph ${i} with enough distinct words to warrant its own chunk. `.repeat(12));
      }
      const hugeDoc = paragraphs.join("\n\n");
      const chunks = chunkText("src-huge", hugeDoc);
      expect(chunks.length).toBe(MAX_CHUNKS_PER_SOURCE);
    });
  });

  describe("cosineSimilarity", () => {
    it("computes cosine similarity accurately across typical and edge cases", () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 9);
      expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 9);
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
      expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
    });
  });

  describe("rankBySimilarity", () => {
    it("ranks candidates by similarity, skips wrong dimensions, breaks ties by id, and respects limit", () => {
      const query = [1, 0, 0];
      const candidates = [
        { id: "c-wrong-dim", sourceId: "s1", offset: 0, vector: [1, 0] },
        { id: "c-low", sourceId: "s1", offset: 10, vector: [0, 1, 0] },
        { id: "c-tie-2", sourceId: "s1", offset: 20, vector: [1, 0, 0] },
        { id: "c-tie-1", sourceId: "s1", offset: 30, vector: [1, 0, 0] },
        { id: "c-mid", sourceId: "s1", offset: 40, vector: [0.707, 0.707, 0] },
      ];

      const ranked = rankBySimilarity(query, candidates, 2);
      expect(ranked.length).toBe(2);
      expect(ranked[0]!.id).toBe("c-tie-1");
      expect(ranked[1]!.id).toBe("c-tie-2");

      const rankedAll = rankBySimilarity(query, candidates, 10);
      expect(rankedAll.map((r) => r.id)).not.toContain("c-wrong-dim");
      expect(rankedAll.length).toBe(4);

      expect(rankBySimilarity(query, [], 5)).toEqual([]);
      expect(rankBySimilarity(query, candidates, 0)).toEqual([]);
    });
  });
});
