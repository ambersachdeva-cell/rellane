/**
 * Every verb in the product, in one list, reachable by typing.
 *
 * ## Why this exists at all
 *
 * The rail names ten *places*. A place is a destination, and a destination is
 * not a verb — you cannot navigate your way to "raise a bill". So the only
 * things a person could reach quickly were the things that happened to be
 * rooms, and everything the product actually *does* was behind a room, then a
 * button, then a form. That is the shape of a website, not of a tool somebody
 * operates all day.
 *
 * A palette inverts it: you say the verb and the room is a consequence.
 *
 * ## Why the matching is a subsequence and not a substring
 *
 * `route()` in command-router.ts matches with `includes`, which is right for
 * the overlay: that is a launcher opened from a global hotkey by somebody who
 * may be typing a filename, and a fuzzy match on unknown text produces
 * confident nonsense. Here the corpus is *closed* — thirty-odd titles this
 * product wrote itself — so a person typing `rab` can only plausibly mean "Raise
 * a bill", and making them type the whole word is the thing that stops a palette
 * feeling fast.
 *
 * The two live side by side deliberately. Different corpus, different rule.
 *
 * ## Nothing here awaits
 *
 * Ranking runs on every keystroke. It is pure, it is synchronous, and no model
 * decides what your keystrokes mean — a fourteen-second round trip to discover
 * you wanted the Timeline would defeat the entire point.
 */

/**
 * The order groups appear in when nothing is typed.
 *
 * Verbs before destinations, because a palette that opens showing a list of
 * rooms has taught the person it is a nav menu, and they will stop reaching for
 * it the moment they learn the rail is faster.
 */
export const GROUP_ORDER = ["Do", "Book", "Crew", "Go"] as const;

export type CommandGroup = (typeof GROUP_ORDER)[number];

export interface Command {
  readonly id: string;
  /** What a person reads. Sentence case, verb first for anything in "Do". */
  readonly title: string;
  readonly group: CommandGroup;
  /** Right-aligned: a shortcut, or where this lands. Never decoration. */
  readonly hint?: string;
  /**
   * Words somebody might type instead of the title.
   *
   * This is where a product's vocabulary and its customer's vocabulary are
   * allowed to differ: the title says "Party" because that is what the book
   * calls it, and `customer`, `supplier` and `client` all find it anyway.
   */
  readonly keywords?: readonly string[];
  /** Set when running this is not currently possible, with the reason shown. */
  readonly unavailable?: string;
}

export interface RankedCommand {
  readonly command: Command;
  readonly score: number;
  /**
   * Which characters of the title matched, as indexes.
   *
   * Returned rather than recomputed in the view, because the ranker already
   * knows and a second pass would be a second matching rule that could
   * disagree with the first — the highlight would then point at characters that
   * are not the reason the row is there.
   */
  readonly marks: readonly number[];
}

/**
 * Case-folded subsequence match, preferring runs and word starts.
 *
 * Returns null when the query is not a subsequence at all. Otherwise a score
 * and the matched indexes. The scoring is deliberately simple — three bonuses,
 * one penalty — because a ranker nobody can predict is one people stop trusting
 * and go back to the mouse for.
 */
function matchSubsequence(title: string, query: string): { score: number; marks: number[] } | null {
  const haystack = title.toLowerCase();
  const needle = query.toLowerCase();

  const marks: number[] = [];
  let score = 0;
  let at = 0;
  let previousIndex = -1;

  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found === -1) {
      return null;
    }

    // A character that follows the previous match with no gap is part of a run,
    // and a run is much stronger evidence than the same characters scattered:
    // "boo" in "Book" should beat "boo" in "Backup, once, now".
    if (found === previousIndex + 1) {
      score += 12;
    }

    // The first letter of a word. Typing initials is how people actually use a
    // palette — "rab" for "Raise a bill" — so this carries the most weight.
    const before = found === 0 ? " " : haystack[found - 1] ?? " ";
    if (found === 0 || before === " " || before === "-") {
      score += 18;
    }

    // Distance costs, so an early tight match sorts above a late scattered one.
    if (previousIndex !== -1) {
      score -= Math.min(found - previousIndex - 1, 10);
    }

    marks.push(found);
    previousIndex = found;
    at = found + 1;
  }

  // Shorter titles win ties: with "book" typed, "Book" is a better answer than
  // "Book a backup for later", and both match identically well up to here.
  score -= Math.min(title.length, 60) / 10;

  return { score, marks };
}

/**
 * The commands that match, best first.
 *
 * An empty query returns everything in group order rather than nothing, so the
 * palette is a menu before it is a search — somebody who does not yet know what
 * this product can do finds out by opening it.
 */
export function rankCommands(query: string, commands: readonly Command[]): readonly RankedCommand[] {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return commands
      .map((command) => ({ command, score: 0, marks: [] as readonly number[] }))
      .sort((a, b) => GROUP_ORDER.indexOf(a.command.group) - GROUP_ORDER.indexOf(b.command.group));
  }

  const ranked: RankedCommand[] = [];

  for (const command of commands) {
    const onTitle = matchSubsequence(command.title, trimmed);

    // An exact prefix is not a fuzzy match that happened to be tidy; it is the
    // person having typed the beginning of the thing they want, and it outranks
    // every cleverness below.
    const prefix = command.title.toLowerCase().startsWith(trimmed.toLowerCase()) ? 400 : 0;

    if (onTitle !== null) {
      ranked.push({ command, score: onTitle.score + prefix, marks: onTitle.marks });
      continue;
    }

    // Keywords are a fallback and score below any title match, so a word the
    // product actually uses always beats a synonym we guessed it might be
    // called. No marks: highlighting nothing is honest when the reason this row
    // is here does not appear in the row.
    const keywordHit = (command.keywords ?? []).some((keyword) =>
      keyword.toLowerCase().includes(trimmed.toLowerCase())
    );
    if (keywordHit) {
      ranked.push({ command, score: -50, marks: [] });
    }
  }

  return ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // A stable, explicable tie-break rather than whatever order the catalogue
    // happened to be written in.
    return a.command.title.localeCompare(b.command.title);
  });
}

/**
 * Rows grouped for display, in `GROUP_ORDER`, empty groups dropped.
 *
 * Grouping is applied after ranking rather than before it, so the best answer is
 * still the first row on screen. Sorting by group first would bury an exact
 * match under a heading, which is the failure that makes people stop reading
 * past row one.
 */
export function groupRanked(
  ranked: readonly RankedCommand[]
): readonly { readonly group: CommandGroup; readonly rows: readonly RankedCommand[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    rows: ranked.filter((row) => row.command.group === group)
  })).filter((section) => section.rows.length > 0);
}
