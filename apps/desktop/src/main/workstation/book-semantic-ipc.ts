import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { cosineSimilarity } from "./vector-store.js";

/**
 * Bound query length to guard against runaway payload sizes while
 * providing ample space for conversational search queries.
 */
export const WORKSTATION_SEMANTIC_QUERY_LIMIT = 1_000;

/**
 * Cap turns indexed in memory so the desktop app keeps a predictable,
 * lightweight memory footprint on the owner's Mac.
 */
export const MAX_INDEXED_TURNS = 20_000;

export const WorkstationSemanticSearchInputSchema = z.object({
  query: z.string().max(WORKSTATION_SEMANTIC_QUERY_LIMIT),
});

export type WorkstationSemanticSearchInput = z.infer<typeof WorkstationSemanticSearchInputSchema>;

export const WorkstationSemanticStatusInputSchema = z
  .record(z.string(), z.unknown())
  .optional();

export type SemanticSearchMode = "meaning" | "words";

export interface SemanticSearchHit {
  readonly turnId: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly snippet: string;
  readonly score: number;
  readonly why: string;
}

export interface SemanticSearchResult {
  readonly hits: readonly SemanticSearchHit[];
  readonly mode: SemanticSearchMode;
  readonly summary: string;
}

export interface SemanticSearchStatus {
  readonly ready: boolean;
  readonly detail: string;
  readonly indexed: number;
}

export interface SearchableTurn {
  readonly id: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly body: string;
  readonly at: number;
}

export interface InstallSemanticSearchOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Every turn that may be searched, already filtered to open work. */
  readonly searchable: () => readonly {
    readonly id: string;
    readonly caseId: string;
    readonly caseTitle: string;
    readonly body: string;
    readonly at: number;
  }[];
  /** Turns text into a vector, locally. Null when no model is installed. */
  readonly embed: ((texts: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]>) | null;
}

interface CachedTurn {
  readonly id: string;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly body: string;
  readonly at: number;
  readonly embedding: readonly number[];
}

function extractQueryWords(text: string): readonly string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!matches) {
    return [];
  }
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of matches) {
    if (!seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

function extractSnippet(text: string, targetWords: readonly string[]): string {
  const trimmed = text.trim();
  if (trimmed.length <= 160) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();
  let earliestPos = -1;

  for (const word of targetWords) {
    const pos = lower.indexOf(word.toLowerCase());
    if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
      earliestPos = pos;
    }
  }

  if (earliestPos === -1) {
    return `${trimmed.slice(0, 157)}...`;
  }

  const start = Math.max(0, earliestPos - 40);
  const end = Math.min(trimmed.length, start + 140);

  let snippet = trimmed.slice(start, end);
  if (start > 0) {
    snippet = `...${snippet}`;
  }
  if (end < trimmed.length) {
    snippet = `${snippet}...`;
  }
  return snippet;
}

function formatWordMatchWhy(matchedWords: readonly string[]): string {
  if (matchedWords.length === 0) {
    return "matches query words";
  }
  if (matchedWords.length === 1) {
    return `mentions '${matchedWords[0]!}'`;
  }
  if (matchedWords.length === 2) {
    return `mentions '${matchedWords[0]!}' and '${matchedWords[1]!}'`;
  }
  const first = matchedWords.slice(0, 2).map((w) => `'${w}'`).join(", ");
  const last = `'${matchedWords[2]!}'`;
  return `mentions ${first} and ${last}`;
}

export class SemanticSearchEngine {
  private readonly cache = new Map<string, CachedTurn>();
  private isIndexCapped = false;
  private pendingBuildPromise: Promise<void> | null = null;
  private readonly searchable: () => readonly SearchableTurn[];
  private readonly embed: ((texts: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]>) | null;

  constructor(options: {
    readonly searchable: () => readonly SearchableTurn[];
    readonly embed: ((texts: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]>) | null;
  }) {
    this.searchable = options.searchable;
    this.embed = options.embed;
  }

  public getStatus(): SemanticSearchStatus {
    if (this.embed === null) {
      return {
        ready: false,
        detail: "No local language model installed. Searches will match on exact words.",
        indexed: 0,
      };
    }

    if (this.pendingBuildPromise !== null) {
      return {
        ready: false,
        detail: "Indexing turns for meaning search.",
        indexed: this.cache.size,
      };
    }

    const count = this.cache.size;
    if (count === 0) {
      return {
        ready: true,
        detail: "Ready to search by meaning. Turns will be indexed on your first search.",
        indexed: 0,
      };
    }

    const detail = this.isIndexCapped
      ? `Ready to search by meaning across ${count} turns (index capped at 20,000).`
      : `Ready to search by meaning across ${count} turns.`;

    return {
      ready: true,
      detail,
      indexed: count,
    };
  }

  public async search(
    query: string,
    onAwait?: () => void
  ): Promise<SemanticSearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return {
        hits: [],
        mode: this.embed === null ? "words" : "meaning",
        summary: "Type words or a question to search your work.",
      };
    }

    if (this.embed === null) {
      return this.searchWords(trimmed);
    }

    try {
      await this.ensureIndexed(onAwait);

      const abortController = new AbortController();
      const queryVectors = await this.embed([trimmed], abortController.signal);
      onAwait?.();

      if (queryVectors.length === 0) {
        return this.searchWords(trimmed);
      }
      const firstVector = queryVectors[0]!;
      if (firstVector.length === 0) {
        return this.searchWords(trimmed);
      }

      const hits: SemanticSearchHit[] = [];

      for (const item of this.cache.values()) {
        const score = cosineSimilarity(firstVector, item.embedding);
        if (score > 0.1) {
          hits.push({
            turnId: item.id,
            caseId: item.caseId,
            caseTitle: item.caseTitle,
            snippet: extractSnippet(item.body, extractQueryWords(trimmed)),
            score: Math.round(score * 1000) / 1000,
            why: "close in meaning to your question",
          });
        }
      }

      hits.sort((a, b) => b.score - a.score);
      const topHits = hits.slice(0, 50);

      const isCapped = this.isIndexCapped;
      let summary: string;
      if (topHits.length === 0) {
        summary = isCapped
          ? "No turns matched the meaning of your question. Index capped at 20,000 turns."
          : "No turns matched the meaning of your question.";
      } else if (topHits.length === 1) {
        summary = isCapped
          ? "Found 1 result matching your question. Index capped at 20,000 turns."
          : "Found 1 result matching your question.";
      } else {
        summary = isCapped
          ? `Found ${topHits.length} results matching your question. Index capped at 20,000 turns.`
          : `Found ${topHits.length} results matching your question.`;
      }

      return {
        hits: topHits,
        mode: "meaning",
        summary,
      };
    } catch {
      const wordResult = this.searchWords(trimmed);
      return {
        hits: wordResult.hits,
        mode: "words",
        summary:
          "Could not search by meaning because the local model was unavailable. Matched on the words you typed instead.",
      };
    }
  }

  public searchWords(query: string): SemanticSearchResult {
    const rawTurns = this.searchable();
    const isCapped = rawTurns.length > MAX_INDEXED_TURNS;
    const turns = isCapped
      ? [...rawTurns].sort((a, b) => b.at - a.at).slice(0, MAX_INDEXED_TURNS)
      : rawTurns;

    const queryWords = extractQueryWords(query);
    if (queryWords.length === 0) {
      return {
        hits: [],
        mode: "words",
        summary: isCapped
          ? "No turns matched the words you typed. Install a local language model to search by meaning. Index capped at 20,000 turns."
          : "No turns matched the words you typed. Install a local language model to search by meaning.",
      };
    }

    const lowerQuery = query.toLowerCase();
    const scoredHits: SemanticSearchHit[] = [];

    for (const turn of turns) {
      const lowerBody = turn.body.toLowerCase();
      const lowerTitle = turn.caseTitle.toLowerCase();

      const matchedWords: string[] = [];
      for (const word of queryWords) {
        if (lowerBody.includes(word) || lowerTitle.includes(word)) {
          matchedWords.push(word);
        }
      }

      if (matchedWords.length === 0) {
        continue;
      }

      const wordCoverage = matchedWords.length / queryWords.length;
      const phraseBonus = lowerBody.includes(lowerQuery) ? 0.3 : 0;
      const titleBonus = matchedWords.some((w) => lowerTitle.includes(w)) ? 0.1 : 0;

      let occurrences = 0;
      for (const word of matchedWords) {
        let idx = 0;
        while ((idx = lowerBody.indexOf(word, idx)) !== -1) {
          occurrences++;
          idx += word.length;
          if (occurrences >= 10) {
            break;
          }
        }
      }
      const frequencyBonus = Math.min(0.2, occurrences * 0.02);
      const score = Math.min(
        1,
        Math.max(
          0.01,
          Math.round((wordCoverage * 0.5 + phraseBonus + titleBonus + frequencyBonus) * 1000) / 1000
        )
      );

      scoredHits.push({
        turnId: turn.id,
        caseId: turn.caseId,
        caseTitle: turn.caseTitle,
        snippet: extractSnippet(turn.body, matchedWords),
        score,
        why: formatWordMatchWhy(matchedWords),
      });
    }

    scoredHits.sort((a, b) => b.score - a.score);
    const topHits = scoredHits.slice(0, 50);

    let summary: string;
    if (topHits.length === 0) {
      summary = isCapped
        ? "No turns matched the words you typed. Install a local language model to search by meaning. Index capped at 20,000 turns."
        : "No turns matched the words you typed. Install a local language model to search by meaning.";
    } else {
      summary = isCapped
        ? "Matched on the words you typed. Install a local language model to search by meaning. Index capped at 20,000 turns."
        : "Matched on the words you typed. Install a local language model to search by meaning.";
    }

    return {
      hits: topHits,
      mode: "words",
      summary,
    };
  }

  private async ensureIndexed(onAwait?: () => void): Promise<boolean> {
    if (this.embed === null) {
      return false;
    }

    while (this.pendingBuildPromise !== null) {
      await this.pendingBuildPromise;
      onAwait?.();
    }

    const rawTurns = this.searchable();
    const capped = rawTurns.length > MAX_INDEXED_TURNS;
    this.isIndexCapped = capped;

    const turns = capped
      ? [...rawTurns].sort((a, b) => b.at - a.at).slice(0, MAX_INDEXED_TURNS)
      : rawTurns;

    const activeIds = new Set<string>();
    for (const turn of turns) {
      activeIds.add(turn.id);
    }
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) {
        this.cache.delete(id);
      }
    }

    const turnsToEmbed: SearchableTurn[] = [];
    for (const turn of turns) {
      const existing = this.cache.get(turn.id);
      if (!existing || existing.body !== turn.body) {
        turnsToEmbed.push(turn);
      }
    }

    if (turnsToEmbed.length === 0) {
      return this.isIndexCapped;
    }

    const buildPromise = (async () => {
      const BATCH_SIZE = 128;
      const abortController = new AbortController();

      for (let i = 0; i < turnsToEmbed.length; i += BATCH_SIZE) {
        const batch = turnsToEmbed.slice(i, i + BATCH_SIZE);
        const texts = batch.map((t) => t.body);
        const vectors = await this.embed!(texts, abortController.signal);

        for (let j = 0; j < batch.length; j++) {
          const turn = batch[j]!;
          if (j < vectors.length) {
            const vector = vectors[j]!;
            if (vector.length > 0) {
              this.cache.set(turn.id, {
                id: turn.id,
                caseId: turn.caseId,
                caseTitle: turn.caseTitle,
                body: turn.body,
                at: turn.at,
                embedding: vector,
              });
            }
          }
        }
      }
    })();

    this.pendingBuildPromise = buildPromise;
    try {
      await buildPromise;
    } finally {
      if (this.pendingBuildPromise === buildPromise) {
        this.pendingBuildPromise = null;
      }
    }
    onAwait?.();

    return this.isIndexCapped;
  }
}

export function installSemanticSearch(options: InstallSemanticSearchOptions): void {
  const engine = new SemanticSearchEngine({
    searchable: options.searchable,
    embed: options.embed,
  });

  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);

  ipcMain.handle(
    IPC_CHANNELS.workstationSemanticStatus,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<SemanticSearchStatus> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      WorkstationSemanticStatusInputSchema.parse(
        input === undefined || input === null ? {} : input
      );

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while checking search status.");
      }

      return engine.getStatus();
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationSemanticSearch,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<SemanticSearchResult> => {
      options.assertTrusted(event);
      const owner = ownerFor(event);

      let request: WorkstationSemanticSearchInput;
      try {
        request = WorkstationSemanticSearchInputSchema.parse(
          typeof input === "string" ? { query: input } : input
        );
      } catch (err) {
        if (err instanceof z.ZodError) {
          throw new Error("Search query must be 1,000 characters or fewer.");
        }
        throw new Error("Invalid search request.");
      }

      const checkOwner = () => {
        options.assertTrusted(event);
        if (ownerFor(event) !== owner) {
          throw new Error("This window changed while searching.");
        }
      };

      checkOwner();

      const result = await engine.search(request.query, checkOwner);

      checkOwner();

      return result;
    }
  );
}
