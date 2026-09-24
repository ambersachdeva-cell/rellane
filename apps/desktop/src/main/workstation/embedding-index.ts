import { createHash } from "node:crypto";

export interface TextChunk {
  /** Stable across runs for identical input: sha256 of `${sourceId}:${offset}:${text}`, hex. */
  readonly id: string;
  readonly sourceId: string;
  /** 0-based character offset of this chunk in the original text. */
  readonly offset: number;
  readonly text: string;
}

export interface ScoredChunk {
  readonly id: string;
  readonly sourceId: string;
  readonly offset: number;
  readonly score: number;
}

export const CHUNK_TARGET_CHARS = 1_000;
export const CHUNK_OVERLAP_CHARS = 150;
export const MAX_CHUNKS_PER_SOURCE = 400;

function hashChunkId(sourceId: string, offset: number, text: string): string {
  return createHash("sha256")
    .update(`${sourceId}:${offset}:${text}`)
    .digest("hex");
}

function addChunk(
  chunks: TextChunk[],
  sourceId: string,
  offset: number,
  text: string
): void {
  if (text.trim().length === 0) {
    return;
  }
  const chunk: TextChunk = {
    id: hashChunkId(sourceId, offset, text),
    sourceId,
    offset,
    text,
  };

  if (chunks.length === 0) {
    chunks.push(chunk);
    return;
  }

  const prev = chunks[chunks.length - 1]!;
  const prevEnd = prev.offset + prev.text.length;
  const chunkEnd = chunk.offset + chunk.text.length;

  // Overlap never produces a chunk that is a strict substring of its neighbour
  if (chunk.offset >= prev.offset && chunkEnd <= prevEnd) {
    return;
  }
  if (prev.offset >= chunk.offset && prevEnd <= chunkEnd) {
    chunks[chunks.length - 1] = chunk;
    return;
  }

  chunks.push(chunk);
}

export function chunkText(sourceId: string, text: string): readonly TextChunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  const textLength = text.length;
  let cursor = 0;

  // Skip leading whitespace to prevent whitespace-only prefixes
  while (cursor < textLength && /\s/.test(text[cursor]!)) {
    cursor++;
  }

  const paragraphSeparatorRegex = /\r?\n(?:[ \t]*\r?\n)+/g;
  const sentenceSeparatorRegex = /([.!?]+["']?)(\s+)/g;

  while (cursor < textLength && chunks.length < MAX_CHUNKS_PER_SOURCE) {
    const chunkStart = cursor;
    const maxEnd = Math.min(textLength, chunkStart + CHUNK_TARGET_CHARS);

    if (maxEnd === textLength) {
      const chunkTextContent = text.slice(chunkStart, maxEnd);
      if (chunkTextContent.trim().length > 0) {
        addChunk(chunks, sourceId, chunkStart, chunkTextContent);
      }
      break;
    }

    // Split on paragraph boundaries first (blank line)
    paragraphSeparatorRegex.lastIndex = chunkStart;
    let lastParagraphMatch: { start: number; end: number } | null = null;
    let match: RegExpExecArray | null = null;

    while ((match = paragraphSeparatorRegex.exec(text)) !== null) {
      if (match.index >= maxEnd) {
        break;
      }
      if (match.index > chunkStart) {
        lastParagraphMatch = {
          start: match.index,
          end: match.index + match[0].length,
        };
      }
    }

    if (lastParagraphMatch !== null) {
      const chunkEnd = lastParagraphMatch.start;
      const chunkTextContent = text.slice(chunkStart, chunkEnd);
      if (chunkTextContent.trim().length > 0) {
        addChunk(chunks, sourceId, chunkStart, chunkTextContent);
      }

      // Check if an earlier paragraph boundary fits within the overlap allowance
      const earliestOverlap = chunkEnd - CHUNK_OVERLAP_CHARS;
      paragraphSeparatorRegex.lastIndex = chunkStart;
      let overlapParagraphStart: number | null = null;

      while ((match = paragraphSeparatorRegex.exec(text)) !== null) {
        if (match.index >= chunkEnd) {
          break;
        }
        const candidateStart = match.index + match[0].length;
        if (candidateStart >= earliestOverlap && candidateStart < chunkEnd) {
          overlapParagraphStart = candidateStart;
          break;
        }
      }

      let nextStart = overlapParagraphStart !== null ? overlapParagraphStart : lastParagraphMatch.end;
      while (nextStart < textLength && /\s/.test(text[nextStart]!)) {
        nextStart++;
      }
      cursor = nextStart > chunkStart ? nextStart : maxEnd;
      continue;
    }

    // Split on sentence boundaries next
    sentenceSeparatorRegex.lastIndex = chunkStart;
    let lastSentenceMatch: { end: number; nextStart: number } | null = null;

    while ((match = sentenceSeparatorRegex.exec(text)) !== null) {
      const punct = match[1]!;
      const sentenceEnd = match.index + punct.length;
      if (sentenceEnd > maxEnd) {
        break;
      }
      if (sentenceEnd > chunkStart) {
        lastSentenceMatch = {
          end: sentenceEnd,
          nextStart: match.index + match[0].length,
        };
      }
    }

    if (lastSentenceMatch !== null) {
      const chunkEnd = lastSentenceMatch.end;
      const chunkTextContent = text.slice(chunkStart, chunkEnd);
      if (chunkTextContent.trim().length > 0) {
        addChunk(chunks, sourceId, chunkStart, chunkTextContent);
      }

      // Check if an earlier sentence boundary fits within the overlap allowance
      const earliestOverlap = chunkEnd - CHUNK_OVERLAP_CHARS;
      sentenceSeparatorRegex.lastIndex = chunkStart;
      let overlapSentenceStart: number | null = null;

      while ((match = sentenceSeparatorRegex.exec(text)) !== null) {
        const candidateStart = match.index + match[0].length;
        if (candidateStart >= chunkEnd) {
          break;
        }
        if (candidateStart >= earliestOverlap && candidateStart < chunkEnd) {
          overlapSentenceStart = candidateStart;
          break;
        }
      }

      let nextStart = overlapSentenceStart !== null ? overlapSentenceStart : lastSentenceMatch.nextStart;
      while (nextStart < textLength && /\s/.test(text[nextStart]!)) {
        nextStart++;
      }
      cursor = nextStart > chunkStart ? nextStart : maxEnd;
      continue;
    }

    // Mid-word split only if a single sentence exceeds the target length
    const chunkEnd = maxEnd;
    const chunkTextContent = text.slice(chunkStart, chunkEnd);
    if (chunkTextContent.trim().length > 0) {
      addChunk(chunks, sourceId, chunkStart, chunkTextContent);
    }

    const nextStart = Math.max(chunkStart + 1, chunkEnd - CHUNK_OVERLAP_CHARS);
    cursor = nextStart;
  }

  return chunks;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
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

export function rankBySimilarity(
  query: readonly number[],
  candidates: readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly offset: number;
    readonly vector: readonly number[];
  }[],
  limit: number
): readonly ScoredChunk[] {
  if (limit <= 0 || candidates.length === 0 || query.length === 0) {
    return [];
  }

  const scored: ScoredChunk[] = [];
  for (const candidate of candidates) {
    if (candidate.vector.length !== query.length) {
      continue;
    }
    const score = cosineSimilarity(query, candidate.vector);
    scored.push({
      id: candidate.id,
      sourceId: candidate.sourceId,
      offset: candidate.offset,
      score,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return scored.slice(0, limit);
}
