import Fuse from "fuse.js";

export type CommandKind = "work" | "routine" | "project" | "output" | "source";

export interface CommandItem {
  readonly id: string;
  readonly kind: CommandKind;
  readonly title: string;
  /** Secondary line: the first question, a description, a snippet. May be empty. */
  readonly detail: string;
  /** Milliseconds since the epoch. 0 when the item has no time of its own. */
  readonly at: number;
}

export interface CommandHit {
  readonly item: CommandItem;
  /** Lower is better, as Fuse reports it. */
  readonly score: number;
  /** Character ranges in `title` to mark, [start, end), ascending and non-overlapping. */
  readonly titleRanges: readonly (readonly [number, number])[];
}

export const MAX_COMMAND_HITS = 30;

export function searchCommands(items: readonly CommandItem[], query: string): readonly CommandHit[] {
  if (items.length === 0) {
    return [];
  }

  // An empty or whitespace-only query presents recent items without running search
  if (query.trim().length === 0) {
    const sorted = [...items].sort((a, b) => {
      if (b.at !== a.at) {
        return b.at - a.at;
      }
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return sorted.slice(0, MAX_COMMAND_HITS).map((item) => ({
      item,
      score: 0,
      titleRanges: [],
    }));
  }

  // Fresh instance per search to avoid serving stale results after document mutations
  const fuse = new Fuse(items, {
    includeScore: true,
    includeMatches: true,
    ignoreLocation: true,
    threshold: 0.4,
    minMatchCharLength: 2,
    keys: [
      { name: "title", weight: 0.7 },
      { name: "detail", weight: 0.3 },
    ],
  });

  let results = (() => {
    try {
      return fuse.search(query);
    } catch {
      return [];
    }
  })();

  // When a multi-word query fails as a single phrase, match individual words across fields
  if (results.length === 0 && query.trim().includes(" ")) {
    const words = query.trim().split(/\s+/).filter((w) => w.length >= 2);
    if (words.length > 1) {
      try {
        results = fuse.search({
          $and: words.map((w) => ({
            $or: [
              { title: w },
              { detail: w },
            ],
          })),
        });
      } catch {
        results = [];
      }
    }
  }

  const hits: CommandHit[] = [];

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (!res) continue;

    const item = res.item;
    const titleLen = item.title.length;
    const rawRanges: [number, number][] = [];

    if (res.matches) {
      for (let j = 0; j < res.matches.length; j++) {
        const match = res.matches[j];
        if (!match || match.key !== "title" || !match.indices) continue;

        for (let k = 0; k < match.indices.length; k++) {
          const range = match.indices[k];
          if (!range) continue;
          const start = range[0];
          const end = range[1];
          if (start !== undefined && end !== undefined && start <= end) {
            // Fuse reports inclusive [start, end]; convert to half-open [start, end + 1)
            const s = Math.max(0, Math.min(titleLen, start));
            const e = Math.max(0, Math.min(titleLen, end + 1));
            if (s < e) {
              rawRanges.push([s, e]);
            }
          }
        }
      }
    }

    rawRanges.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));

    const titleRanges: [number, number][] = [];
    for (let j = 0; j < rawRanges.length; j++) {
      const current = rawRanges[j];
      if (!current) continue;
      const last = titleRanges[titleRanges.length - 1];
      if (!last) {
        titleRanges.push([current[0], current[1]]);
      } else if (current[0] <= last[1]) {
        last[1] = Math.max(last[1], current[1]);
      } else {
        titleRanges.push([current[0], current[1]]);
      }
    }

    hits.push({
      item,
      score: res.score ?? 0,
      titleRanges,
    });
  }

  // Stable sort: best score first, tie-break by at descending, then by id
  hits.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    if (b.item.at !== a.item.at) {
      return b.item.at - a.item.at;
    }
    return a.item.id < b.item.id ? -1 : (a.item.id > b.item.id ? 1 : 0);
  });

  return hits.slice(0, MAX_COMMAND_HITS);
}
