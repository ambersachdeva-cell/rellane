import { describe, expect, it } from "vitest";
import {
  chunkDocument,
  cosineSimilarity,
  createVectorStore,
} from "./vector-store.js";
import type { VectorChunk } from "./vector-store.js";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors and 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("handles zero-magnitude vectors, empty inputs, and dimension mismatches", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("clamps results within [-1, 1] range to avoid floating-point drift", () => {
    const unitA = [0.6, 0.8];
    const unitB = [0.6, 0.8];
    const similarity = cosineSimilarity(unitA, unitB);
    expect(similarity).toBeLessThanOrEqual(1.0);
    expect(similarity).toBeGreaterThanOrEqual(-1.0);
  });
});

describe("chunkDocument", () => {
  it("chunks document with word count and overlap verification", () => {
    const words = [
      "one", "two", "three", "four", "five",
      "six", "seven", "eight", "nine", "ten",
      "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    ];
    const text = words.join(" ");
    const chunks = chunkDocument("doc-alpha", text, {
      targetWords: 5,
      overlapWords: 2,
    });

    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      expect(chunk.documentId).toBe("doc-alpha");
      expect(chunk.startOffset).toBeDefined();
      expect(chunk.endOffset).toBeDefined();

      const sliced = text.slice(chunk.startOffset!, chunk.endOffset!);
      expect(sliced).toBe(chunk.text);

      const chunkWords = chunk.text.split(/\s+/);
      expect(chunkWords.length).toBeLessThanOrEqual(5);

      if (i > 0) {
        const prevChunk = chunks[i - 1]!;
        const prevWords = prevChunk.text.split(/\s+/);
        expect(prevWords.length).toBeGreaterThanOrEqual(2);
        expect(chunkWords.length).toBeGreaterThanOrEqual(2);

        const prevTail = prevWords.slice(-2);
        const currHead = chunkWords.slice(0, 2);
        expect(currHead).toEqual(prevTail);
      }
    }
  });

  it("returns empty array for empty or whitespace-only documents", () => {
    expect(chunkDocument("doc-empty", "")).toEqual([]);
    expect(chunkDocument("doc-empty", "   \n\t  ")).toEqual([]);
  });
});

describe("VectorStore lexical BM25 search", () => {
  it("retrieves exact keyword matches using BM25 ranking", () => {
    const store = createVectorStore();
    const chunkA: VectorChunk = {
      id: "chunk-postgres",
      documentId: "doc-db",
      text: "PostgreSQL relational database indexing and replication optimisation",
    };
    const chunkB: VectorChunk = {
      id: "chunk-typography",
      documentId: "doc-ui",
      text: "Calm monochrome interface typography and graphite styling",
    };
    store.insertMany([chunkA, chunkB]);

    const hits = store.search({ queryText: "postgresql replication" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.chunk.id).toBe("chunk-postgres");
    expect(hits[0]!.matchType).toBe("keyword");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });
});

describe("VectorStore dense vector search", () => {
  it("retrieves nearest semantic neighbours using cosine similarity", () => {
    const store = createVectorStore();
    const chunkA: VectorChunk = {
      id: "vec-target",
      documentId: "doc-v",
      text: "Target vector topic",
      embedding: [1.0, 0.0, 0.0],
    };
    const chunkB: VectorChunk = {
      id: "vec-ortho",
      documentId: "doc-v",
      text: "Orthogonal vector topic",
      embedding: [0.0, 1.0, 0.0],
    };
    const chunkC: VectorChunk = {
      id: "vec-near",
      documentId: "doc-v",
      text: "Near vector topic",
      embedding: [0.8, 0.2, 0.0],
    };
    store.insertMany([chunkA, chunkB, chunkC]);

    const hits = store.search({ vector: [1.0, 0.0, 0.0], topK: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0]!.chunk.id).toBe("vec-target");
    expect(hits[0]!.score).toBeCloseTo(1.0, 5);
    expect(hits[0]!.matchType).toBe("vector");
    expect(hits[1]!.chunk.id).toBe("vec-near");
  });
});

describe("VectorStore hybrid search", () => {
  it("combines dense vector and lexical rankings via Reciprocal Rank Fusion", () => {
    const store = createVectorStore();
    const chunkBoth: VectorChunk = {
      id: "chunk-both",
      documentId: "doc-h",
      text: "Graphite palette design tokens for calm desktop interfaces",
      embedding: [0.95, 0.05],
    };
    const chunkKeyword: VectorChunk = {
      id: "chunk-kw",
      documentId: "doc-h",
      text: "Graphite palette color specification and contrast tokens",
      embedding: [0.0, 1.0],
    };
    const chunkVector: VectorChunk = {
      id: "chunk-vec",
      documentId: "doc-h",
      text: "Unrelated audio digital signal synthesis and frequency filters",
      embedding: [0.9, 0.1],
    };
    store.insertMany([chunkBoth, chunkKeyword, chunkVector]);

    const hits = store.search({
      vector: [1.0, 0.0],
      queryText: "graphite palette design",
      vectorWeight: 0.6,
      keywordWeight: 0.4,
    });

    expect(hits.length).toBe(3);
    expect(hits[0]!.chunk.id).toBe("chunk-both");
    expect(hits[0]!.matchType).toBe("hybrid");
    expect(hits[0]!.score).toBeGreaterThan(0);

    const matchTypes = new Set(hits.map((h) => h.matchType));
    expect(matchTypes.has("hybrid")).toBe(true);
    expect(matchTypes.has("vector")).toBe(true);
    expect(matchTypes.has("keyword")).toBe(true);
  });
});

describe("VectorStore document lifecycle and serialization", () => {
  it("deletes documents by documentId and performs full serialization roundtrip", () => {
    const store = createVectorStore();
    const chunk1: VectorChunk = {
      id: "c1",
      documentId: "doc-alpha",
      text: "First chunk content",
      embedding: [0.5, 0.5],
      tags: ["notes"],
    };
    const chunk2: VectorChunk = {
      id: "c2",
      documentId: "doc-alpha",
      text: "Second chunk content",
      tags: ["notes"],
    };
    const chunk3: VectorChunk = {
      id: "c3",
      documentId: "doc-beta",
      text: "Third chunk content",
      tags: ["system"],
    };
    store.insertMany([chunk1, chunk2, chunk3]);
    expect(store.getChunkCount()).toBe(3);

    const serialized = store.serialize();
    const restoredStore = createVectorStore();
    restoredStore.deserialize(serialized);
    expect(restoredStore.getChunkCount()).toBe(3);

    const restoredHits = restoredStore.search({ queryText: "First" });
    expect(restoredHits.length).toBe(1);
    expect(restoredHits[0]!.chunk.id).toBe("c1");

    const deleted = store.deleteDocument("doc-alpha");
    expect(deleted).toBe(2);
    expect(store.getChunkCount()).toBe(1);
    expect(store.deleteDocument("doc-alpha")).toBe(0);

    const remainingHits = store.search({ queryText: "Third" });
    expect(remainingHits.length).toBe(1);
    expect(remainingHits[0]!.chunk.id).toBe("c3");
  });

  it("filters search results by tagFilter when provided", () => {
    const store = createVectorStore();
    store.insertMany([
      {
        id: "t1",
        documentId: "d1",
        text: "Financial statement ledger balance",
        tags: ["finance"],
      },
      {
        id: "t2",
        documentId: "d2",
        text: "Financial audit compliance report",
        tags: ["compliance"],
      },
    ]);

    const hits = store.search({
      queryText: "financial",
      tagFilter: "finance",
    });
    expect(hits.length).toBe(1);
    expect(hits[0]!.chunk.id).toBe("t1");
  });

  it("handles clear and malformed deserialization input gracefully without throwing", () => {
    const store = createVectorStore();
    store.insertChunk({
      id: "tmp",
      documentId: "d-tmp",
      text: "Sample content",
    });
    expect(store.getChunkCount()).toBe(1);
    store.clear();
    expect(store.getChunkCount()).toBe(0);
    expect(store.search({})).toEqual([]);

    expect(() => store.deserialize("")).not.toThrow();
    expect(() => store.deserialize("invalid-json{")).not.toThrow();
    expect(() => store.deserialize("{}")).not.toThrow();
    expect(store.getChunkCount()).toBe(0);
  });
});
