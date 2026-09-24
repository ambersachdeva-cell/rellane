/**
 * Several subscriptions working one Case at once, and stopping when they should.
 *
 * ## What this is, and what it deliberately is not
 *
 * `seats.ts` picks one seat. The Board says who has what. The Governor says who
 * may start. This is the loop that puts those three together: while there is
 * work and somebody may start, give a seat a job, let it speak into the room,
 * and reconcile what it spent.
 *
 * It is **engine-blind**. What actually answers is passed in, for the reason
 * D-030 and D-031 exist: a fake engine returns whatever the test author wrote,
 * so a crew built against one proves the loop and nothing else. The two defects
 * that mattered most in this codebase's history were both found by a real model
 * failing in a way no stub would have.
 *
 * ## Admission is asked for every single seat, every single time
 *
 * Not once at the start. A run that checks the budget once and then fans out is
 * the exact failure the Governor was built to prevent — six seats admitted
 * together on spend that had not been recorded yet. Here, each seat asks
 * immediately before it starts, and a refusal ends the round rather than
 * spinning: if nothing may start now, nothing will start by asking again in a
 * tight loop.
 *
 * ## Every seat's answer lands in the room as data
 *
 * Written through `renderRoom`, so the next seat reads it length-prefixed and
 * attributed and cannot be handed an instruction wearing a colleague's name.
 * A seat that fails writes a turn too — a room that silently omits its failures
 * lies about what was tried, and the next seat needs to know a colleague was
 * asked and could not answer.
 */

import { Board, type Job } from "./claims.js";
import { renderRoom, safeLabel, type Turn } from "./untrusted.js";

export interface CrewSeat {
  /** What a person reads. Also what appears on the turn it writes. */
  readonly label: string;
  /** `accountId:family` — the budget this seat spends. */
  readonly pool: string;
  /** What this seat is for, in its own words. Goes last in its prompt. */
  readonly brief: string;
}

/** What the loop needs from the outside world. All of it injectable. */
export interface FanOutDeps {
  /**
   * Whether this seat may start now, and the ticket to reconcile with.
   * The Governor, or anything shaped like it.
   */
  admit(seat: CrewSeat, estimate: number): { ok: true; ticket: string } | { ok: false; because: string };
  /** Tell the governor what it really cost. */
  finished(ticket: string, actual: number): void;
  /**
   * Ask a real engine. Engine-blind on purpose (D-030): a fake here proves the
   * loop and nothing about whether a model can do the work.
   */
  ask(seat: CrewSeat, prompt: string): Promise<{ readonly text: string; readonly cost: number }>;
  /** Append to the Case's transcript. The room is the record. */
  say(turn: Turn): void;
}

export interface RoundResult {
  readonly worked: number;
  readonly refused: readonly string[];
  readonly failed: number;
  /** True when there is nothing left any seat could pick up. */
  readonly settled: boolean;
  /**
   * What was said this round.
   *
   * Returned rather than only handed to `say`, because the caller has to carry
   * it into the next round — a first version copied history into a local array
   * and threw the additions away, so round two read an empty room and the whole
   * point of a shared transcript was quietly lost.
   */
  readonly saidThisRound: readonly Turn[];
}

/** What a seat is guessed to cost before it runs. It will be wrong. */
export const ESTIMATE = 20_000;

/**
 * One pass: every seat that may start takes a job and answers.
 *
 * Sequential rather than concurrent, and that is a decision rather than a
 * simplification. Seats speak into one shared room, and the value of the second
 * seat is that it read what the first one said. Running them in parallel gives
 * several seats talking over each other about a room none of them saw change —
 * which is the private-conversation shape again, wearing a shared file.
 */
export async function round(
  seats: readonly CrewSeat[],
  board: Board,
  deps: FanOutDeps,
  question: string,
  history: readonly Turn[] = []
): Promise<RoundResult> {
  const turns: Turn[] = [...history];
  const refused: string[] = [];
  let worked = 0;
  let failed = 0;

  for (const seat of seats) {
    if (board.settled) {
      break;
    }

    // Asked per seat, immediately before it starts — never once for the round.
    const verdict = deps.admit(seat, ESTIMATE);
    if (!verdict.ok) {
      refused.push(verdict.because);
      // Nothing may start now; asking the next seat in a tight loop will not
      // change that, and a governor's refusal is information rather than a
      // thing to retry around.
      break;
    }

    const job = board.claim(seat.label);
    if (job === null) {
      // Admitted and then found nothing to do. Give the reservation straight
      // back rather than holding budget for work that does not exist.
      deps.finished(verdict.ticket, 0);
      break;
    }

    let spent = ESTIMATE;
    try {
      const answer = await deps.ask(seat, promptFor(seat, job, question, turns));
      spent = answer.cost;
      const turn: Turn = { seat: safeLabel(seat.label), kind: "verbatim", body: answer.text };
      turns.push(turn);
      deps.say(turn);
      board.finish(job.id, seat.label);
      worked += 1;
    } catch (error) {
      failed += 1;
      // Written down, not swallowed. A room that omits its failures lies about
      // what was tried, and the next seat needs to know a colleague could not
      // answer this.
      const said = error instanceof Error ? error.message : String(error);
      const turn: Turn = {
        seat: safeLabel(seat.label),
        kind: "verbatim",
        body: `This seat could not answer: ${said}`
      };
      turns.push(turn);
      deps.say(turn);
      // Handed back rather than left to time out — five minutes of a lease is
      // five minutes nobody else is working on it.
      board.release(job.id, seat.label);
    } finally {
      deps.finished(verdict.ticket, spent);
    }
  }

  return {
    worked,
    refused,
    failed,
    settled: board.settled,
    saidThisRound: turns.slice(history.length)
  };
}

/**
 * What one seat is sent.
 *
 * Order is deliberate and is the same order the harness uses: the room first as
 * data, then the question, then this seat's own job last — a model weights the
 * end of its prompt most, and the thing it should weight most is what it has
 * been asked to do.
 */
export function promptFor(
  seat: CrewSeat,
  job: Job,
  question: string,
  turns: readonly Turn[]
): string {
  return [
    renderRoom(turns),
    "",
    "# The case",
    "",
    question,
    "",
    "# Your job",
    "",
    job.what,
    "",
    `Done when: ${job.doneWhen}`,
    "",
    seat.brief,
    "",
    "Be concise. Every seat after you pays to read this."
  ].join("\n");
}

/**
 * Rounds until nothing is left, or until nothing may start, or until a ceiling.
 *
 * The ceiling is not optional. A crew that loops while work exists is a crew
 * that will loop forever the day a job cannot be finished — and the Board
 * abandoning a job after three attempts is what makes that terminate, with this
 * as the second guard behind it.
 */
export async function work(
  seats: readonly CrewSeat[],
  board: Board,
  deps: FanOutDeps,
  question: string,
  maxRounds = 6
): Promise<{ readonly rounds: number; readonly settled: boolean; readonly refused: readonly string[] }> {
  const turns: Turn[] = [];
  const refused: string[] = [];
  let rounds = 0;

  while (rounds < maxRounds && !board.settled) {
    const result = await round(seats, board, deps, question, turns);
    rounds += 1;
    // Carried forward, so the next round's seats read what this one said.
    turns.push(...result.saidThisRound);
    refused.push(...result.refused);
    // Nobody worked and nobody could start: another identical round would do
    // the same nothing, more expensively.
    if (result.worked === 0) {
      break;
    }
  }

  return { rounds, settled: board.settled, refused };
}
