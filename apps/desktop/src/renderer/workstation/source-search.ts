/**
 * Offline source search using Okapi BM25 ranking and cluster-centred snippet extraction.
 */

export interface SearchDocument {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface SearchHit {
  readonly id: string;
  readonly label: string;
  /** Relevance. Higher is better. Only meaningful relative to other hits in the same result. */
  readonly score: number;
  /** A readable window of the source around the best match. */
  readonly snippet: string;
  /** Ranges within `snippet` to mark, as [start, end) character offsets, ascending, non-overlapping. */
  readonly highlights: readonly (readonly [number, number])[];
  /** 0-based character offset of `snippet` within the document's text. */
  readonly snippetOffset: number;
}

export const MAX_SEARCH_HITS = 20;
export const SNIPPET_CHARS = 240;

// BM25 parameters per Okapi specification
const K1 = 1.2;
const B = 0.75;

interface TokenOccurrence {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

// Tokenise letters, digits, and combining marks (e.g. Indic matras in Devanagari) case-insensitively.
const TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+/gu;

function extractTokens(text: string): readonly TokenOccurrence[] {
  const matches: TokenOccurrence[] = [];
  const regex = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    matches.push({
      token: raw.toLowerCase(),
      start,
      end: start + raw.length,
    });
  }
  return matches;
}

/**
 * Rank documents using Okapi BM25 scoring:
 *
 *   score(D, Q) = SUM_{q in Q} IDF(q) * [ f(q, D) * (k1 + 1) ] / [ f(q, D) + k1 * (1 - b + b * (|D| / avgdl)) ]
 *
 * where:
 *   IDF(q) = ln( 1 + (N - n(q) + 0.5) / (n(q) + 0.5) )
 *   N = total documents in corpus
 *   n(q) = documents containing query term q
 *   f(q, D) = term frequency of q in document D
 *   |D| = document length in tokens
 *   avgdl = average document length across corpus
 *   k1 = 1.2, b = 0.75
 */
export function searchSources(documents: readonly SearchDocument[], query: string): readonly SearchHit[] {
  if (documents.length === 0) return [];

  // Query terms shorter than 2 characters are ignored
  const queryTokens = extractTokens(query).filter(t => t.token.length >= 2);
  if (queryTokens.length === 0) return [];

  const uniqueTerms = Array.from(new Set(queryTokens.map(t => t.token)));
  const queryTermSet = new Set(uniqueTerms);

  // Pre-tokenise corpus and compute frequencies
  interface PreparedDoc {
    readonly doc: SearchDocument;
    readonly docIndex: number;
    readonly tokens: readonly TokenOccurrence[];
    readonly termFreq: ReadonlyMap<string, number>;
    readonly matchedTokens: readonly TokenOccurrence[];
  }

  let totalTokens = 0;
  const prepared: PreparedDoc[] = [];

  for (let docIndex = 0; docIndex < documents.length; docIndex++) {
    const doc = documents[docIndex];
    if (!doc) continue;
    const tokens = extractTokens(doc.text);
    totalTokens += tokens.length;

    const termFreq = new Map<string, number>();
    const matched: TokenOccurrence[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      termFreq.set(tok.token, (termFreq.get(tok.token) ?? 0) + 1);
      if (queryTermSet.has(tok.token)) {
        matched.push(tok);
      }
    }

    prepared.push({
      doc,
      docIndex,
      tokens,
      termFreq,
      matchedTokens: matched,
    });
  }

  const corpusSize = documents.length;
  const avgdl = corpusSize > 0 ? totalTokens / corpusSize : 0;

  // Document frequency n(q)
  const docFreq = new Map<string, number>();
  for (const term of uniqueTerms) {
    let count = 0;
    for (const p of prepared) {
      if ((p.termFreq.get(term) ?? 0) > 0) {
        count++;
      }
    }
    docFreq.set(term, count);
  }

  interface ScoredCandidate {
    readonly hit: SearchHit;
    readonly score: number;
    readonly docIndex: number;
  }

  const scored: ScoredCandidate[] = [];

  for (const p of prepared) {
    if (p.matchedTokens.length === 0) continue;

    let docScore = 0;
    for (const term of uniqueTerms) {
      const tf = p.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const n = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (corpusSize - n + 0.5) / (n + 0.5));
      const lenNorm = avgdl > 0 ? (1 - B + B * (p.tokens.length / avgdl)) : 1;
      const termScore = idf * ((tf * (K1 + 1)) / (tf + K1 * lenNorm));
      docScore += termScore;
    }

    if (docScore <= 0) continue;

    const { snippet, highlights, snippetOffset } = buildSnippet(p.doc.text, p.matchedTokens);

    scored.push({
      hit: {
        id: p.doc.id,
        label: p.doc.label,
        score: docScore,
        snippet,
        highlights,
        snippetOffset,
      },
      score: docScore,
      docIndex: p.docIndex,
    });
  }

  // Stable sort: best score first, tie-break by original document order
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.docIndex - b.docIndex;
  });

  return scored.slice(0, MAX_SEARCH_HITS).map(s => s.hit);
}

function buildSnippet(
  text: string,
  matchedTokens: readonly TokenOccurrence[]
): {
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
  readonly snippetOffset: number;
} {
  const textLen = text.length;
  if (textLen <= SNIPPET_CHARS) {
    const rawHighlights = collectHighlights(matchedTokens, 0, textLen, 0, textLen);
    return {
      snippet: text,
      highlights: rawHighlights,
      snippetOffset: 0,
    };
  }

  // Maximum characters for the raw text slice, reserving room for ellipses
  const maxRawBudget = SNIPPET_CHARS - 2;

  // Find the densest cluster of matches via two-pointer search
  let bestI = 0;
  let bestJ = 0;
  let bestCount = 1;
  let bestSpan = (matchedTokens[0]?.end ?? 0) - (matchedTokens[0]?.start ?? 0);

  let j = 0;
  for (let i = 0; i < matchedTokens.length; i++) {
    const first = matchedTokens[i];
    if (!first) continue;
    if (j < i) j = i;
    while (j + 1 < matchedTokens.length) {
      const next = matchedTokens[j + 1];
      if (!next || next.end - first.start > maxRawBudget) break;
      j++;
    }
    const last = matchedTokens[j];
    if (!last) continue;
    const count = j - i + 1;
    const span = last.end - first.start;
    if (count > bestCount || (count === bestCount && span < bestSpan)) {
      bestCount = count;
      bestSpan = span;
      bestI = i;
      bestJ = j;
    }
  }

  const clusterStart = matchedTokens[bestI]?.start ?? 0;
  const clusterEnd = matchedTokens[bestJ]?.end ?? clusterStart;

  // Centre window on the chosen cluster
  const clusterMid = Math.floor((clusterStart + clusterEnd) / 2);
  let rawStart = Math.max(0, clusterMid - Math.floor(maxRawBudget / 2));
  let rawEnd = Math.min(textLen, rawStart + maxRawBudget);

  // If clamped at end, pull start backward to fill available budget
  if (rawEnd - rawStart < maxRawBudget && rawStart > 0) {
    rawStart = Math.max(0, rawEnd - maxRawBudget);
  }

  // Ensure cluster boundaries remain inside the window
  if (rawStart > clusterStart) rawStart = clusterStart;
  if (rawEnd < clusterEnd) rawEnd = clusterEnd;

  // Extend or snap to word boundaries where possible without cutting cluster matches
  if (rawStart > 0) {
    const isBoundary = /\s/.test(text[rawStart - 1] ?? "") || /\s/.test(text[rawStart] ?? "");
    if (!isBoundary) {
      let prevSpace = -1;
      for (let p = rawStart - 1; p >= 0; p--) {
        if (/\s/.test(text[p] ?? "")) { prevSpace = p; break; }
      }
      if (prevSpace !== -1 && (rawEnd - (prevSpace + 1)) + 2 <= SNIPPET_CHARS) {
        rawStart = prevSpace + 1;
      } else {
        let nextSpace = -1;
        for (let p = rawStart; p < clusterStart; p++) {
          if (/\s/.test(text[p] ?? "")) { nextSpace = p; break; }
        }
        if (nextSpace !== -1) {
          rawStart = nextSpace + 1;
        }
      }
    }
  }

  if (rawEnd < textLen) {
    const isBoundary = /\s/.test(text[rawEnd - 1] ?? "") || /\s/.test(text[rawEnd] ?? "");
    if (!isBoundary) {
      let nextSpace = -1;
      for (let p = rawEnd; p < textLen; p++) {
        if (/\s/.test(text[p] ?? "")) { nextSpace = p; break; }
      }
      if (nextSpace !== -1 && (nextSpace - rawStart) + 2 <= SNIPPET_CHARS) {
        rawEnd = nextSpace;
      } else {
        let prevSpace = -1;
        for (let p = rawEnd - 1; p >= clusterEnd; p--) {
          if (/\s/.test(text[p] ?? "")) { prevSpace = p; break; }
        }
        if (prevSpace !== -1) {
          rawEnd = prevSpace;
        }
      }
    }
  }

  // Trim leading/trailing whitespace outside the cluster
  while (rawStart < clusterStart && /\s/.test(text[rawStart] ?? "")) {
    rawStart++;
  }
  while (rawEnd > clusterEnd && /\s/.test(text[rawEnd - 1] ?? "")) {
    rawEnd--;
  }

  const hasLeading = rawStart > 0;
  const hasTrailing = rawEnd < textLen;
  const prefix = hasLeading ? "…" : "";
  const suffix = hasTrailing ? "…" : "";
  const snippet = prefix + text.slice(rawStart, rawEnd) + suffix;
  const snippetOffset = rawStart;

  const highlights = collectHighlights(
    matchedTokens,
    rawStart,
    rawEnd,
    hasLeading ? 1 : 0,
    snippet.length
  );

  return {
    snippet,
    highlights,
    snippetOffset,
  };
}

function collectHighlights(
  matchedTokens: readonly TokenOccurrence[],
  rawStart: number,
  rawEnd: number,
  offset: number,
  snippetLength: number
): readonly (readonly [number, number])[] {
  const raw: [number, number][] = [];

  for (let i = 0; i < matchedTokens.length; i++) {
    const tok = matchedTokens[i];
    if (!tok) continue;
    if (tok.start >= rawStart && tok.end <= rawEnd) {
      const hStart = offset + (tok.start - rawStart);
      const hEnd = offset + (tok.end - rawStart);
      if (hStart >= 0 && hEnd <= snippetLength && hStart < hEnd) {
        raw.push([hStart, hEnd]);
      }
    }
  }

  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: [number, number][] = [];
  for (let i = 0; i < raw.length; i++) {
    const current = raw[i];
    if (!current) continue;
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push([current[0], current[1]]);
    } else if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push([current[0], current[1]]);
    }
  }

  return merged;
}
