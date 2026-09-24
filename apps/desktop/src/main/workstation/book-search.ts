/**
 * Content search over historical turn transcripts using Okapi BM25 ranking,
 * Unicode-aware tokenisation, exact phrase matching, and cluster-centred snippet extraction.
 */

export interface SearchableTurn {
  readonly id: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly seat: string;
  readonly kind: string;
  readonly body: string;
  readonly at: number;
}

export interface ContentHit {
  readonly turnId: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly who: string;
  readonly at: number;
  readonly score: number;
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
}

export interface SearchOutcome {
  readonly hits: readonly ContentHit[];
  readonly scanned: number;
  readonly matched: number;
  /** "18 matches across 4 pieces of work." */
  readonly summary: string;
}

export const MAX_HITS = 50;
export const SNIPPET_CHARS = 220;

const K1 = 1.2;
const B = 0.75;

// Matches Unicode letters, digits, and combining marks (such as Indic matras)
// so Hindi, Hinglish, and Devanagari tokens preserve vowel signs
const TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+/gu;

interface TokenOccurrence {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

function extractTokens(text: string): readonly TokenOccurrence[] {
  const matches: TokenOccurrence[] = [];
  const regex = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    if (raw === undefined) continue;
    matches.push({
      token: raw.toLowerCase(),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return matches;
}

function formatWho(seat: string): string {
  const trimmed = seat.trim();
  const lower = trimmed.toLowerCase();

  // Maps owner seat names to calm second-person address
  if (
    lower === "user" ||
    lower === "owner" ||
    lower === "human" ||
    lower === "you" ||
    lower === "me" ||
    lower === "client" ||
    lower === "self"
  ) {
    return "You";
  }

  const geminiMatch = lower.match(/^gemini(?:[-_ ]?profile)?[-_: ]?([0-9]+)$/);
  if (geminiMatch && geminiMatch[1] !== undefined) {
    return `Gemini (Profile ${geminiMatch[1]})`;
  }
  if (lower === "gemini") {
    return "Gemini";
  }
  if (trimmed.startsWith("Gemini (Profile ") && trimmed.endsWith(")")) {
    return trimmed;
  }

  if (lower === "codex" || lower === "openai" || lower === "openai-codex") {
    return "Codex";
  }
  if (lower.startsWith("claude") || lower === "anthropic") {
    return "Claude";
  }
  if (lower === "local-qwen" || lower === "local_qwen" || lower === "local qwen") {
    return "Local Qwen";
  }
  if (lower === "qwen") {
    return "Qwen";
  }

  return trimmed
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isBookkeepingTurn(turn: SearchableTurn): boolean {
  const kind = turn.kind.toLowerCase().trim();
  return (
    kind.includes("receipt") ||
    kind.includes("permission") ||
    kind.includes("bookkeeping")
  );
}

interface ParsedQuery {
  readonly searchTerms: readonly string[];
  readonly requiredPhrases: readonly (readonly string[])[];
  readonly excludedTerms: readonly string[];
  readonly excludedPhrases: readonly (readonly string[])[];
}

function parseQuery(rawQuery: string): ParsedQuery {
  let query = rawQuery.replace(/[“”]/g, '"');
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    query += '"';
  }

  const searchTerms: string[] = [];
  const requiredPhrases: (readonly string[])[] = [];
  const excludedTerms: string[] = [];
  const excludedPhrases: (readonly string[])[] = [];

  const segmentRegex = /(-?)"([^"]*)"|(-?)([\p{L}\p{N}\p{M}]+)/gu;
  let match: RegExpExecArray | null;

  while ((match = segmentRegex.exec(query)) !== null) {
    const matchIndex = match.index;
    const isLeading = matchIndex === 0 || /\s/.test(query[matchIndex - 1] ?? "");

    const phraseMinus = match[1];
    const phraseBody = match[2];
    const wordMinus = match[3];
    const wordBody = match[4];

    if (phraseBody !== undefined) {
      const phraseTokens = extractTokens(phraseBody).map(t => t.token);
      if (phraseTokens.length > 0) {
        if (phraseMinus === "-" && isLeading) {
          excludedPhrases.push(phraseTokens);
        } else {
          requiredPhrases.push(phraseTokens);
          for (let i = 0; i < phraseTokens.length; i++) {
            const tok = phraseTokens[i];
            if (tok !== undefined) searchTerms.push(tok);
          }
        }
      }
    } else if (wordBody !== undefined) {
      const token = wordBody.toLowerCase();
      if (wordMinus === "-" && isLeading) {
        excludedTerms.push(token);
      } else {
        searchTerms.push(token);
      }
    }
  }

  return {
    searchTerms: Array.from(new Set(searchTerms)),
    requiredPhrases,
    excludedTerms: Array.from(new Set(excludedTerms)),
    excludedPhrases,
  };
}

function findPhraseOccurrences(
  docTokens: readonly TokenOccurrence[],
  phrase: readonly string[]
): readonly TokenOccurrence[] | null {
  if (phrase.length === 0) return [];
  const phraseLen = phrase.length;
  const matchedTokens: TokenOccurrence[] = [];
  let found = false;

  for (let i = 0; i <= docTokens.length - phraseLen; i++) {
    let match = true;
    for (let k = 0; k < phraseLen; k++) {
      const docTok = docTokens[i + k];
      const phraseTok = phrase[k];
      if (!docTok || docTok.token !== phraseTok) {
        match = false;
        break;
      }
    }
    if (match) {
      found = true;
      for (let k = 0; k < phraseLen; k++) {
        const docTok = docTokens[i + k];
        if (docTok !== undefined) matchedTokens.push(docTok);
      }
    }
  }

  return found ? matchedTokens : null;
}

function hasExcludedTerm(
  termFreq: ReadonlyMap<string, number>,
  excludedTerms: readonly string[]
): boolean {
  for (let i = 0; i < excludedTerms.length; i++) {
    const term = excludedTerms[i];
    if (term !== undefined && (termFreq.get(term) ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

function hasExcludedPhrase(
  docTokens: readonly TokenOccurrence[],
  excludedPhrases: readonly (readonly string[])[]
): boolean {
  for (let i = 0; i < excludedPhrases.length; i++) {
    const phrase = excludedPhrases[i];
    if (phrase !== undefined && findPhraseOccurrences(docTokens, phrase) !== null) {
      return true;
    }
  }
  return false;
}

function buildSnippet(
  text: string,
  matchedTokens: readonly TokenOccurrence[]
): {
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
} {
  const textLen = text.length;
  if (textLen <= SNIPPET_CHARS) {
    return {
      snippet: text,
      highlights: collectHighlights(matchedTokens, 0, textLen, 0, textLen),
    };
  }

  if (matchedTokens.length === 0) {
    return {
      snippet: text.slice(0, SNIPPET_CHARS),
      highlights: [],
    };
  }

  const maxRawBudget = SNIPPET_CHARS - 2;
  let bestI = 0;
  let bestJ = 0;
  let bestCount = 1;
  const firstTok = matchedTokens[0];
  let bestSpan = firstTok !== undefined ? firstTok.end - firstTok.start : 0;

  let j = 0;
  for (let i = 0; i < matchedTokens.length; i++) {
    const first = matchedTokens[i];
    if (first === undefined) continue;
    if (j < i) j = i;
    while (j + 1 < matchedTokens.length) {
      const next = matchedTokens[j + 1];
      if (next === undefined || next.end - first.start > maxRawBudget) break;
      j++;
    }
    const last = matchedTokens[j];
    if (last === undefined) continue;
    const count = j - i + 1;
    const span = last.end - first.start;
    if (count > bestCount || (count === bestCount && span < bestSpan)) {
      bestCount = count;
      bestSpan = span;
      bestI = i;
      bestJ = j;
    }
  }

  const tokI = matchedTokens[bestI];
  const tokJ = matchedTokens[bestJ];
  const clusterStart = tokI !== undefined ? tokI.start : 0;
  const clusterEnd = tokJ !== undefined ? tokJ.end : clusterStart;

  const clusterMid = Math.floor((clusterStart + clusterEnd) / 2);
  let rawStart = Math.max(0, clusterMid - Math.floor(maxRawBudget / 2));
  let rawEnd = Math.min(textLen, rawStart + maxRawBudget);

  if (rawEnd - rawStart < maxRawBudget && rawStart > 0) {
    rawStart = Math.max(0, rawEnd - maxRawBudget);
  }
  if (rawStart > clusterStart) rawStart = clusterStart;
  if (rawEnd < clusterEnd) rawEnd = clusterEnd;

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
        if (nextSpace !== -1) rawStart = nextSpace + 1;
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
        if (prevSpace !== -1) rawEnd = prevSpace;
      }
    }
  }

  while (rawStart < clusterStart && /\s/.test(text[rawStart] ?? "")) {
    rawStart++;
  }
  while (rawEnd > clusterEnd && /\s/.test(text[rawEnd - 1] ?? "")) {
    rawEnd--;
  }

  let hasLeading = rawStart > 0;
  let hasTrailing = rawEnd < textLen;
  while (rawEnd - rawStart + (hasLeading ? 1 : 0) + (hasTrailing ? 1 : 0) > SNIPPET_CHARS) {
    if (rawEnd > clusterEnd) {
      rawEnd--;
      hasTrailing = rawEnd < textLen;
    } else if (rawStart < clusterStart) {
      rawStart++;
      hasLeading = rawStart > 0;
    } else {
      rawEnd--;
      hasTrailing = rawEnd < textLen;
    }
  }

  const prefix = hasLeading ? "…" : "";
  const suffix = hasTrailing ? "…" : "";
  const snippet = prefix + text.slice(rawStart, rawEnd) + suffix;

  const highlights = collectHighlights(
    matchedTokens,
    rawStart,
    rawEnd,
    hasLeading ? 1 : 0,
    snippet.length
  );

  return { snippet, highlights };
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
    if (tok === undefined) continue;
    if (tok.start >= rawStart && tok.end <= rawEnd) {
      const hStart = offset + (tok.start - rawStart);
      const hEnd = offset + (tok.end - rawStart);
      if (hStart >= 0 && hEnd <= snippetLength && hStart < hEnd) {
        raw.push([hStart, hEnd]);
      }
    }
  }

  raw.sort((a, b) => {
    const a0 = a[0];
    const b0 = b[0];
    const a1 = a[1];
    const b1 = b[1];
    if (a0 !== undefined && b0 !== undefined && a0 !== b0) {
      return a0 - b0;
    }
    if (a1 !== undefined && b1 !== undefined) {
      return a1 - b1;
    }
    return 0;
  });

  const merged: [number, number][] = [];
  for (let i = 0; i < raw.length; i++) {
    const current = raw[i];
    if (current === undefined) continue;
    const cur0 = current[0];
    const cur1 = current[1];
    if (cur0 === undefined || cur1 === undefined) continue;

    const last = merged[merged.length - 1];
    if (last === undefined) {
      merged.push([cur0, cur1]);
    } else {
      const last1 = last[1];
      if (last1 !== undefined && cur0 <= last1) {
        last[1] = Math.max(last1, cur1);
      } else {
        merged.push([cur0, cur1]);
      }
    }
  }

  return merged;
}

export function searchBook(turns: readonly SearchableTurn[], query: string): SearchOutcome {
  const scanned = turns.length;
  if (scanned === 0) {
    return {
      hits: [],
      scanned: 0,
      matched: 0,
      summary: "0 matches across 0 pieces of work.",
    };
  }

  const parsed = parseQuery(query);
  if (parsed.searchTerms.length === 0 && parsed.requiredPhrases.length === 0) {
    return {
      hits: [],
      scanned,
      matched: 0,
      summary: "0 matches across 0 pieces of work.",
    };
  }

  const candidateTurns: SearchableTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn !== undefined && !isBookkeepingTurn(turn)) {
      candidateTurns.push(turn);
    }
  }

  if (candidateTurns.length === 0) {
    return {
      hits: [],
      scanned,
      matched: 0,
      summary: "0 matches across 0 pieces of work.",
    };
  }

  interface TurnAnalysis {
    readonly turn: SearchableTurn;
    readonly tokens: readonly TokenOccurrence[];
    readonly termFreq: ReadonlyMap<string, number>;
  }

  const analyses: TurnAnalysis[] = [];
  let totalTokens = 0;

  for (let i = 0; i < candidateTurns.length; i++) {
    const turn = candidateTurns[i];
    if (turn === undefined) continue;
    const tokens = extractTokens(turn.body);
    totalTokens += tokens.length;
    const termFreq = new Map<string, number>();
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (tok === undefined) continue;
      termFreq.set(tok.token, (termFreq.get(tok.token) ?? 0) + 1);
    }
    analyses.push({ turn, tokens, termFreq });
  }

  const corpusSize = candidateTurns.length;
  const avgdl = corpusSize > 0 ? totalTokens / corpusSize : 0;

  const docFreq = new Map<string, number>();
  for (let i = 0; i < parsed.searchTerms.length; i++) {
    const term = parsed.searchTerms[i];
    if (term === undefined) continue;
    let count = 0;
    for (let j = 0; j < analyses.length; j++) {
      const a = analyses[j];
      if (a !== undefined && (a.termFreq.get(term) ?? 0) > 0) {
        count++;
      }
    }
    docFreq.set(term, count);
  }

  const queryTermSet = new Set(parsed.searchTerms);

  interface ScoredMatch {
    readonly hit: ContentHit;
    readonly turn: SearchableTurn;
    readonly score: number;
  }

  const scored: ScoredMatch[] = [];

  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    if (a === undefined) continue;

    if (hasExcludedTerm(a.termFreq, parsed.excludedTerms)) {
      continue;
    }
    if (hasExcludedPhrase(a.tokens, parsed.excludedPhrases)) {
      continue;
    }

    let phraseMismatch = false;
    const phraseMatchedTokens: TokenOccurrence[] = [];
    for (let p = 0; p < parsed.requiredPhrases.length; p++) {
      const phrase = parsed.requiredPhrases[p];
      if (phrase === undefined) continue;
      const occurrences = findPhraseOccurrences(a.tokens, phrase);
      if (occurrences === null) {
        phraseMismatch = true;
        break;
      }
      for (let m = 0; m < occurrences.length; m++) {
        const occ = occurrences[m];
        if (occ !== undefined) phraseMatchedTokens.push(occ);
      }
    }
    if (phraseMismatch) {
      continue;
    }

    const matchedTokens: TokenOccurrence[] = [...phraseMatchedTokens];
    for (let t = 0; t < a.tokens.length; t++) {
      const tok = a.tokens[t];
      if (tok !== undefined && queryTermSet.has(tok.token)) {
        matchedTokens.push(tok);
      }
    }

    const seenOffsets = new Set<number>();
    const uniqueMatchedTokens: TokenOccurrence[] = [];
    for (let m = 0; m < matchedTokens.length; m++) {
      const tok = matchedTokens[m];
      if (tok !== undefined && !seenOffsets.has(tok.start)) {
        seenOffsets.add(tok.start);
        uniqueMatchedTokens.push(tok);
      }
    }

    if (parsed.requiredPhrases.length === 0 && uniqueMatchedTokens.length === 0) {
      continue;
    }

    let docScore = 0;
    for (let s = 0; s < parsed.searchTerms.length; s++) {
      const term = parsed.searchTerms[s];
      if (term === undefined) continue;
      const tf = a.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const n = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (corpusSize - n + 0.5) / (n + 0.5));
      const lenNorm = avgdl > 0 ? (1 - B + B * (a.tokens.length / avgdl)) : 1;
      const termScore = idf * ((tf * (K1 + 1)) / (tf + K1 * lenNorm));
      docScore += termScore;
    }

    if (docScore <= 0) {
      continue;
    }

    const { snippet, highlights } = buildSnippet(a.turn.body, uniqueMatchedTokens);

    scored.push({
      hit: {
        turnId: a.turn.id,
        caseId: a.turn.caseId,
        caseTitle: a.turn.caseTitle,
        who: formatWho(a.turn.seat),
        at: a.turn.at,
        score: docScore,
        snippet,
        highlights,
      },
      turn: a.turn,
      score: docScore,
    });
  }

  // Sorts best score first, then breaks ties by recency and stable identifier
  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) {
      return b.score - a.score;
    }
    if (b.turn.at !== a.turn.at) {
      return b.turn.at - a.turn.at;
    }
    if (a.turn.id < b.turn.id) return -1;
    if (a.turn.id > b.turn.id) return 1;
    return 0;
  });

  const matched = scored.length;
  const distinctCases = new Set(scored.map(s => s.turn.caseId)).size;
  const matchLabel = matched === 1 ? "match" : "matches";
  const pieceLabel = distinctCases === 1 ? "piece of work" : "pieces of work";
  const summary = `${matched} ${matchLabel} across ${distinctCases} ${pieceLabel}.`;

  const hits = scored.slice(0, MAX_HITS).map(s => s.hit);

  return {
    hits,
    scanned,
    matched,
    summary,
  };
}
