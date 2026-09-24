/**
 * Every argument the Bench has held, kept so model choice can be earned.
 *
 * ## Why keep them at all
 *
 * The Bench is the most expensive thing this product does — two subscriptions,
 * several turns, minutes of waiting — and its output today is one answer that
 * gets read once. The *arguments themselves* are the more valuable artefact:
 * they are the only record anywhere of which engine was right when two engines
 * disagreed, on this owner's actual work.
 *
 * That is what turns "which model should answer this?" from a preference into a
 * finding. Not a benchmark somebody else ran on somebody else's tasks — this
 * shop's quotes, this shop's bills, this shop's questions.
 *
 * ## What is stored, and what is deliberately not
 *
 * Stored: the question, the seats, the outcome, the tokens, and **who moved**.
 * The last is the whole point — an engine that concedes has been shown wrong by
 * another engine, and that is a fact about the two of them.
 *
 * Not stored by default: the turns themselves. They are the owner's business
 * discussed at length, and a corpus that quietly accumulated the full text of
 * every argument would be the most sensitive file on the Mac, sitting there to
 * be read by anything that could read a file. Counting is enough to route with.
 *
 * ## It never routes on its own
 *
 * The corpus reports; nothing here changes which engine gets picked. A product
 * that silently re-routed on the strength of eleven arguments would be making a
 * decision the owner cannot see, and the evidence is thin for a long time —
 * `enoughToSay` exists so a screen can say *"not yet"* rather than dress up
 * three data points as a finding.
 */

import type { DatabaseSync } from "node:sqlite";

/** Below this, a difference between two engines is noise wearing a percentage. */
export const ENOUGH = 8;

export type BenchSeatName = "proposer" | "adversary";

export interface CorpusEntry {
  readonly id: string;
  readonly at: number;
  readonly question: string;
  readonly proposerEngine: string;
  readonly adversaryEngine: string;
  readonly outcome: string;
  /** Which seat gave way, when one did. Null when neither moved. */
  readonly conceded: BenchSeatName | null;
  readonly approxTokens: number;
}

/** What the record says about one engine, across every argument it was in. */
export interface EngineRecord {
  readonly engine: string;
  readonly arguments: number;
  /** Times the *other* side conceded to this one. */
  readonly wonOver: number;
  /** Times this one conceded. */
  readonly gaveWay: number;
  readonly approxTokens: number;
}

export interface Routing {
  readonly total: number;
  /** True once there is enough to say anything without embarrassment. */
  readonly enoughToSay: boolean;
  readonly engines: readonly EngineRecord[];
  /** What the record supports, in the owner's words. Always set. */
  readonly said: string;
}

/** Records one argument. Called after the Bench finishes, never during. */
export function remember(
  db: DatabaseSync,
  entry: Omit<CorpusEntry, "id" | "at"> & { id: string; at: number }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO bench_argument
       (id, at, question, proposer_engine, adversary_engine, outcome, conceded, approx_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    entry.at,
    // Trimmed hard. The question is kept because a routing finding is useless
    // without knowing what kind of question it was about, but the whole of
    // somebody's prompt is more than that needs.
    entry.question.slice(0, 300),
    entry.proposerEngine,
    entry.adversaryEngine,
    entry.outcome,
    entry.conceded,
    entry.approxTokens
  );
}

export function argumentsHeld(db: DatabaseSync): readonly CorpusEntry[] {
  const rows = db
    .prepare(`SELECT * FROM bench_argument ORDER BY at DESC`)
    .all() as readonly Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row["id"]),
    at: Number(row["at"]),
    question: String(row["question"]),
    proposerEngine: String(row["proposer_engine"]),
    adversaryEngine: String(row["adversary_engine"]),
    outcome: String(row["outcome"]),
    conceded:
      row["conceded"] === "proposer" || row["conceded"] === "adversary"
        ? (row["conceded"] as BenchSeatName)
        : null,
    approxTokens: Number(row["approx_tokens"] ?? 0)
  }));
}

/**
 * What the record supports about which engine to trust.
 *
 * Deliberately says nothing until there is something to say. Three arguments
 * can make one engine look twice as good as another, and a product that
 * reported that as a finding would be teaching its owner to trust noise — after
 * which the real finding, when it arrives, is worth nothing.
 */
export function routing(db: DatabaseSync, enough = ENOUGH): Routing {
  const entries = argumentsHeld(db);
  const byEngine = new Map<string, { arguments: number; wonOver: number; gaveWay: number; approxTokens: number }>();

  const touch = (engine: string) =>
    byEngine.get(engine) ??
    byEngine.set(engine, { arguments: 0, wonOver: 0, gaveWay: 0, approxTokens: 0 }).get(engine)!;

  for (const entry of entries) {
    // An engine can sit in both seats — two models from one subscription, or a
    // room with only one ready engine. Counting it twice inflated its argument
    // total, doubled its tokens, and recorded it as having both conceded and
    // won the same argument.
    const sameEngine = entry.proposerEngine === entry.adversaryEngine;
    const proposer = touch(entry.proposerEngine);
    const adversary = touch(entry.adversaryEngine);
    proposer.arguments += 1;
    // Tokens are attributed to both seats, because the argument cost that much
    // and neither side spent it alone. Splitting it would invent a number.
    proposer.approxTokens += entry.approxTokens;
    if (!sameEngine) {
      adversary.arguments += 1;
      adversary.approxTokens += entry.approxTokens;
      if (entry.conceded === "proposer") {
        proposer.gaveWay += 1;
        adversary.wonOver += 1;
      } else if (entry.conceded === "adversary") {
        adversary.gaveWay += 1;
        proposer.wonOver += 1;
      }
    }
    // An engine arguing with itself says nothing about which engine to trust,
    // so it contributes a count and no verdict.
  }

  const engines = [...byEngine.entries()]
    .map(([engine, counts]) => ({ engine, ...counts }))
    .sort((a, b) => b.wonOver - a.wonOver || a.engine.localeCompare(b.engine));

  const total = entries.length;
  if (total < enough) {
    return {
      total,
      enoughToSay: false,
      engines,
      said: `${total} ${total === 1 ? "argument" : "arguments"} so far. Rellane will not read anything into fewer than ${enough} — a handful can make one engine look twice as good as another, and that is noise wearing a percentage.`
    };
  }

  const best = engines[0];
  const runnerUp = engines[1];
  const moved = entries.filter((entry) => entry.conceded !== null).length;
  // A tie is a tie. Sorting breaks one alphabetically, and presenting the
  // alphabetically-first engine as "the one still standing" would dress a
  // coin-flip as a finding — the exact failure the eight-argument floor exists
  // to prevent, arriving by a different door.
  const tied = best !== undefined && runnerUp !== undefined && best.wonOver === runnerUp.wonOver;
  // And the floor applies to the engine being named, not to the corpus. Four
  // engines with two arguments each clears a total of eight while telling you
  // nothing about any of them.
  const enoughAboutBest = best !== undefined && best.arguments >= enough;

  return {
    total,
    enoughToSay: true,
    engines,
    said:
      // Order matters. "Not enough data about any one engine" is checked first
      // because it is the stronger statement: eight engines tied at one
      // argument each are not evenly matched, they are unmeasured, and calling
      // that a tie implies a comparison that was never made.
      !enoughAboutBest
        ? `${total} arguments, but no single engine has been in ${enough} of them yet. Rellane will not name one on less than that.`
        : best === undefined || best.wonOver === 0 || tied
          ? `${total} arguments, and neither engine has come out ahead of the other. On this work they are evenly matched, which is a real finding and not a failure to find one.`
          : `${total} arguments, ${moved} of which somebody gave way. ${best.engine} was the one still standing ${best.wonOver} times. That is what this Mac's own work says — it is not a benchmark, and it does not change which engine answers unless you change it.`
  };
}
