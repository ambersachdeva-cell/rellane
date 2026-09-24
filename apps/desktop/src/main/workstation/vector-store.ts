export interface VectorChunk {
  readonly id: string;
  readonly documentId: string;
  readonly text: string;
  readonly embedding?: readonly number[];
  readonly tags?: readonly string[];
  readonly startOffset?: number;
  readonly endOffset?: number;
}

export interface SearchHit {
  readonly chunk: VectorChunk;
  readonly score: number;
  readonly matchType: "vector" | "keyword" | "hybrid";
}

export interface HybridSearchOptions {
  readonly vector?: readonly number[];
  readonly queryText?: string;
  readonly topK?: number;
  readonly tagFilter?: string;
  readonly vectorWeight?: number;
  readonly keywordWeight?: number;
  readonly minScore?: number;
}

export interface VectorStore {
  insertChunk(chunk: VectorChunk): void;
  insertMany(chunks: readonly VectorChunk[]): void;
  deleteDocument(documentId: string): number;
  search(options: HybridSearchOptions): readonly SearchHit[];
  getChunkCount(): number;
  clear(): void;
  serialize(): string;
  deserialize(raw: string): void;
}

interface WordSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface SerializedStore {
  readonly version: number;
  readonly chunks: readonly VectorChunk[];
}

export function cosineSimilarity(vecA: readonly number[], vecB: readonly number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const valA = vecA[i]!;
    const valB = vecB[i]!;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) {
    return 0;
  }

  const similarity = dotProduct / magnitude;
  if (Number.isNaN(similarity)) {
    return 0;
  }

  if (similarity > 1) {
    return 1;
  }
  if (similarity < -1) {
    return -1;
  }

  return similarity;
}

export function chunkDocument(
  documentId: string,
  text: string,
  options?: { readonly targetWords?: number; readonly overlapWords?: number }
): readonly VectorChunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const words: WordSpan[] = [];
  const wordRegex = /\S+/g;
  let match: RegExpExecArray | null = null;
  while ((match = wordRegex.exec(text)) !== null) {
    words.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (words.length === 0) {
    return [];
  }

  const targetWords =
    options?.targetWords !== undefined && options.targetWords > 0
      ? Math.floor(options.targetWords)
      : 100;
  const overlapWords =
    options?.overlapWords !== undefined && options.overlapWords >= 0
      ? Math.floor(options.overlapWords)
      : 0;

  // Overlap cannot equal or exceed target word count to preserve forward progress
  const effectiveOverlap = Math.min(targetWords - 1, overlapWords);
  const step = Math.max(1, targetWords - effectiveOverlap);

  const chunks: VectorChunk[] = [];
  let chunkIndex = 0;

  for (let startWordIdx = 0; startWordIdx < words.length; startWordIdx += step) {
    const endWordIdx = Math.min(startWordIdx + targetWords, words.length);
    const firstWord = words[startWordIdx]!;
    const lastWord = words[endWordIdx - 1]!;
    const startOffset = firstWord.start;
    const endOffset = lastWord.end;
    const chunkText = text.slice(startOffset, endOffset);

    // Optional properties omitted rather than set to undefined to satisfy exactOptionalPropertyTypes
    chunks.push({
      id: `${documentId}_chunk_${chunkIndex}`,
      documentId,
      text: chunkText,
      startOffset,
      endOffset,
    });

    chunkIndex++;

    if (endWordIdx >= words.length) {
      break;
    }
  }

  return chunks;
}

function tokenize(text: string): readonly string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

function sanitizeChunk(raw: unknown): VectorChunk | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const documentId = record["documentId"];
  const text = record["text"];

  if (typeof id !== "string" || typeof documentId !== "string" || typeof text !== "string") {
    return null;
  }

  const rawEmbedding = record["embedding"];
  const hasEmbedding =
    Array.isArray(rawEmbedding) &&
    rawEmbedding.every((v: unknown) => typeof v === "number");
  const rawTags = record["tags"];
  const hasTags =
    Array.isArray(rawTags) &&
    rawTags.every((t: unknown) => typeof t === "string");
  const hasStartOffset = typeof record["startOffset"] === "number";
  const hasEndOffset = typeof record["endOffset"] === "number";

  return {
    id,
    documentId,
    text,
    ...(hasEmbedding ? { embedding: record["embedding"] as readonly number[] } : {}),
    ...(hasTags ? { tags: record["tags"] as readonly string[] } : {}),
    ...(hasStartOffset ? { startOffset: record["startOffset"] as number } : {}),
    ...(hasEndOffset ? { endOffset: record["endOffset"] as number } : {}),
  };
}

// Reciprocal Rank Fusion constant established by Cormack et al. (SIGIR 2009)
const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

class LocalVectorStore implements VectorStore {
  private readonly chunks = new Map<string, VectorChunk>();

  insertChunk(chunk: VectorChunk): void {
    this.chunks.set(chunk.id, chunk);
  }

  insertMany(chunks: readonly VectorChunk[]): void {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
  }

  deleteDocument(documentId: string): number {
    let deletedCount = 0;
    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.documentId === documentId) {
        this.chunks.delete(id);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  getChunkCount(): number {
    return this.chunks.size;
  }

  clear(): void {
    this.chunks.clear();
  }

  serialize(): string {
    const payload: SerializedStore = {
      version: 1,
      chunks: Array.from(this.chunks.values()),
    };
    return JSON.stringify(payload);
  }

  deserialize(raw: string): void {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      const data = parsed as { readonly chunks?: unknown };
      if (!Array.isArray(data.chunks)) {
        return;
      }
      this.chunks.clear();
      for (const item of data.chunks) {
        const sanitized = sanitizeChunk(item);
        if (sanitized !== null) {
          this.chunks.set(sanitized.id, sanitized);
        }
      }
    } catch {
      // Retains existing state when serialized payload is invalid JSON
      return;
    }
  }

  search(options: HybridSearchOptions): readonly SearchHit[] {
    if (this.chunks.size === 0) {
      return [];
    }

    const topK = options.topK !== undefined && options.topK > 0 ? options.topK : 5;
    const tagFilter = options.tagFilter;

    // Filter candidate chunks by tag before scoring
    const candidates: VectorChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (tagFilter !== undefined) {
        if (chunk.tags === undefined || !chunk.tags.includes(tagFilter)) {
          continue;
        }
      }
      candidates.push(chunk);
    }

    if (candidates.length === 0) {
      return [];
    }

    const hasVector = options.vector !== undefined && options.vector.length > 0;
    const hasQueryText = options.queryText !== undefined && options.queryText.trim().length > 0;

    if (!hasVector && !hasQueryText) {
      return [];
    }

    // Pure dense vector search
    if (hasVector && !hasQueryText) {
      const queryVec = options.vector!;
      const scored: { chunk: VectorChunk; score: number }[] = [];

      for (const chunk of candidates) {
        if (chunk.embedding === undefined || chunk.embedding.length !== queryVec.length) {
          continue;
        }
        const score = cosineSimilarity(queryVec, chunk.embedding);
        if (options.minScore !== undefined && score < options.minScore) {
          continue;
        }
        scored.push({ chunk, score });
      }

      scored.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
      });

      return scored.slice(0, topK).map((item) => ({
        chunk: item.chunk,
        score: item.score,
        matchType: "vector" as const,
      }));
    }

    // Pure lexical BM25 search
    if (!hasVector && hasQueryText) {
      const queryTokens = Array.from(new Set(tokenize(options.queryText!)));
      if (queryTokens.length === 0) {
        return [];
      }

      const bm25Hits = this.computeBM25Scores(candidates, queryTokens);
      const filtered: { chunk: VectorChunk; score: number }[] = [];

      for (const hit of bm25Hits) {
        if (options.minScore !== undefined && hit.score < options.minScore) {
          continue;
        }
        filtered.push(hit);
      }

      filtered.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
      });

      return filtered.slice(0, topK).map((item) => ({
        chunk: item.chunk,
        score: item.score,
        matchType: "keyword" as const,
      }));
    }

    // Hybrid search fusing dense vector and lexical rankings
    const queryVec = options.vector!;
    const queryTokens = Array.from(new Set(tokenize(options.queryText!)));

    const vectorScored: { chunk: VectorChunk; score: number }[] = [];
    for (const chunk of candidates) {
      if (chunk.embedding === undefined || chunk.embedding.length !== queryVec.length) {
        continue;
      }
      const sim = cosineSimilarity(queryVec, chunk.embedding);
      if (sim > 0) {
        vectorScored.push({ chunk, score: sim });
      }
    }

    vectorScored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });

    const vectorRankMap = new Map<string, number>();
    for (let i = 0; i < vectorScored.length; i++) {
      const item = vectorScored[i]!;
      vectorRankMap.set(item.chunk.id, i + 1);
    }

    const keywordScored =
      queryTokens.length > 0 ? this.computeBM25Scores(candidates, queryTokens) : [];

    keywordScored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });

    const keywordRankMap = new Map<string, number>();
    for (let i = 0; i < keywordScored.length; i++) {
      const item = keywordScored[i]!;
      keywordRankMap.set(item.chunk.id, i + 1);
    }

    const candidateMap = new Map<string, VectorChunk>();
    for (const chunk of candidates) {
      candidateMap.set(chunk.id, chunk);
    }

    const allMatchedIds = new Set<string>([
      ...vectorRankMap.keys(),
      ...keywordRankMap.keys(),
    ]);

    const vectorWeight = options.vectorWeight ?? 0.6;
    const keywordWeight = options.keywordWeight ?? 0.4;

    const hybridHits: SearchHit[] = [];

    for (const id of allMatchedIds) {
      const chunk = candidateMap.get(id);
      if (chunk === undefined) {
        continue;
      }

      const vRank = vectorRankMap.get(id);
      const kRank = keywordRankMap.get(id);

      let rrfScore = 0;
      if (vRank !== undefined) {
        rrfScore += vectorWeight / (RRF_K + vRank);
      }
      if (kRank !== undefined) {
        rrfScore += keywordWeight / (RRF_K + kRank);
      }

      if (options.minScore !== undefined && rrfScore < options.minScore) {
        continue;
      }

      const matchType: "vector" | "keyword" | "hybrid" =
        vRank !== undefined && kRank !== undefined
          ? "hybrid"
          : vRank !== undefined
            ? "vector"
            : "keyword";

      hybridHits.push({
        chunk,
        score: rrfScore,
        matchType,
      });
    }

    hybridHits.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });

    return hybridHits.slice(0, topK);
  }

  private computeBM25Scores(
    candidates: readonly VectorChunk[],
    queryTokens: readonly string[]
  ): { chunk: VectorChunk; score: number }[] {
    const n = candidates.length;
    if (n === 0 || queryTokens.length === 0) {
      return [];
    }

    const chunkTokensMap = new Map<string, readonly string[]>();
    const docTermFreqMap = new Map<string, Map<string, number>>();
    const docFreq = new Map<string, number>();
    let totalLength = 0;

    for (const chunk of candidates) {
      const tokens = tokenize(chunk.text);
      chunkTokensMap.set(chunk.id, tokens);
      totalLength += tokens.length;

      const tfMap = new Map<string, number>();
      const seenInDoc = new Set<string>();

      for (const token of tokens) {
        tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
        if (!seenInDoc.has(token)) {
          seenInDoc.add(token);
          docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
        }
      }
      docTermFreqMap.set(chunk.id, tfMap);
    }

    const avgdl = totalLength / n || 1;
    const results: { chunk: VectorChunk; score: number }[] = [];

    for (const chunk of candidates) {
      const tfMap = docTermFreqMap.get(chunk.id);
      const docLen = chunkTokensMap.get(chunk.id)?.length ?? 0;
      if (tfMap === undefined || docLen === 0) {
        continue;
      }

      let score = 0;
      for (const qToken of queryTokens) {
        const tf = tfMap.get(qToken) ?? 0;
        if (tf === 0) {
          continue;
        }
        const df = docFreq.get(qToken) ?? 0;
        // Lucene variant of BM25 IDF adds 1 inside log to prevent negative values on common terms
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgdl));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        results.push({ chunk, score });
      }
    }

    return results;
  }
}

export function createVectorStore(): VectorStore {
  return new LocalVectorStore();
}
