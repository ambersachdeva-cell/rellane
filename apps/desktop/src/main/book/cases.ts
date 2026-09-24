/**
 * Cases — the one thing in this app a person can point at.
 *
 * Until now the app had ten destinations and no atom (D-093). An agent run, a
 * Bench session, a flow execution, a Desk conversation and a bill extraction were
 * five unrelated containers, and none of them was *the thing I am working on*.
 * Every tool that reads as finished has one object work happens inside — an
 * Issue, a File, a commit — because that object is what a link points at, what
 * search returns, what history accrues to, and what gets **reopened**.
 *
 * ## The definition earns its keep by what it excludes
 *
 * **A Case is work that finishes.** It opens with a question and closes with a
 * verdict. The first draft of this design said everything becomes a Case with no
 * exception; a reviewer pointed out that an invoice is a persistent record with a
 * counterparty and a due date while a Bench debate is a transient computation,
 * and that forcing both into one container produces a drawer that fills with
 * zombies. So a Party is not a Case, an Invoice is not a Case, and "a month of
 * receivables" is a query. `link` points at those; nothing here copies them.
 *
 * ## Sequence is assigned inside the write
 *
 * `seq` comes from `MAX(seq) + 1` **in the same statement that inserts the row**,
 * not from a read followed by a write. Two seats finishing within a millisecond
 * of each other is the normal case in a room, not a rare one, and a read-then-write
 * would give them the same number — after which `UNIQUE (case_id, seq)` rejects
 * the loser and a seat's work is gone. Letting SQLite compute it means the
 * transaction serialises them and both land.
 *
 * ## Compaction never sees what it must not lose
 *
 * `verbatimFor` returns the turns a compactor may read: `verbatim` only. Findings
 * and receipts are excluded at the query, not by asking a model to preserve them.
 * A 4B model cannot be structurally forced to keep an identifier it was merely
 * told to keep, so the safe design never hands it one — and a receipt that has
 * been summarised is not a receipt, which matters in a product whose whole claim
 * is a receipt for everything it touched.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type TurnKind = "verbatim" | "finding" | "receipt" | "compacted";
export type ClosedAs = "settled" | "abandoned" | "dropped";
export type LinkKind = "party" | "invoice" | "payment" | "document";

export interface CaseTurn {
  readonly id: string;
  readonly seq: number;
  /** A seat label, or `owner`. Never an account, never a credential. */
  readonly seat: string;
  readonly kind: TurnKind;
  readonly body: string;
  readonly at: number;
  /** The turns a compacted turn stands in for, so a reader can always ask. */
  readonly compactedFrom: readonly string[] | null;
}

export interface CaseRow {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly closedAs: ClosedAs | null;
  readonly verdict: string | null;
  readonly turns: number;
  /** When anything last happened in the room. The open-Case list sorts on it. */
  readonly lastActivityAt: number;
}

function now(): number {
  return Date.now();
}

/** Opens a Case. The question is the owner's words and is not rewritten. */
export function openCase(
  db: DatabaseSync,
  input: { readonly title: string; readonly question: string },
  at: number = now()
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO work_case (id, title, question, opened_at) VALUES (?, ?, ?, ?)`
  ).run(id, input.title.trim(), input.question.trim(), at);
  return id;
}

/**
 * Appends a turn to the room.
 *
 * Refuses a closed Case rather than reopening one silently: a Case that has a
 * verdict and then grew three more turns is a record that cannot be trusted to
 * mean what it says.
 */
export function appendTurn(
  db: DatabaseSync,
  caseId: string,
  turn: {
    readonly seat: string;
    readonly kind: TurnKind;
    readonly body: string;
    readonly compactedFrom?: readonly string[];
  },
  at: number = now()
): string {
  const open = db
    .prepare(`SELECT closed_at AS closedAt FROM work_case WHERE id = ?`)
    .get(caseId) as Record<string, unknown> | undefined;
  if (open === undefined) {
    throw new Error("No such case.");
  }
  if (open["closedAt"] !== null) {
    throw new Error("That case is closed. A closed case does not grow.");
  }

  const compacted = turn.kind === "compacted";
  if (compacted !== (turn.compactedFrom !== undefined && turn.compactedFrom.length > 0)) {
    // The schema asserts this too. Saying it here means the caller gets a
    // sentence rather than a constraint name.
    throw new Error(
      "A compacted turn must say which turns it replaced, and only a compacted turn may."
    );
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO case_turn (id, case_id, seq, seat, kind, body, at, compacted_from)
     VALUES (
       ?, ?,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM case_turn WHERE case_id = ?),
       ?, ?, ?, ?, ?
     )`
  ).run(
    id,
    caseId,
    caseId,
    turn.seat,
    turn.kind,
    turn.body,
    at,
    compacted ? JSON.stringify(turn.compactedFrom) : null
  );
  return id;
}

/** The room, in order. This is what a resume replays. */
export function turnsFor(db: DatabaseSync, caseId: string): readonly CaseTurn[] {
  const rows = db
    .prepare(
      `SELECT id, seq, seat, kind, body, at, compacted_from AS compactedFrom
         FROM case_turn WHERE case_id = ? ORDER BY seq`
    )
    .all(caseId) as readonly Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row["id"]),
    seq: Number(row["seq"]),
    seat: String(row["seat"]),
    kind: String(row["kind"]) as TurnKind,
    body: String(row["body"]),
    at: Number(row["at"]),
    compactedFrom:
      row["compactedFrom"] === null
        ? null
        : (JSON.parse(String(row["compactedFrom"])) as readonly string[])
  }));
}

/**
 * The turns a compactor is allowed to read.
 *
 * Findings and receipts are absent by construction — see this module's opening
 * note. `keepRecent` turns at the end stay out of reach as well, because the
 * newest part of a conversation is the part still being worked on.
 */
export function verbatimFor(
  db: DatabaseSync,
  caseId: string,
  keepRecent: number
): readonly CaseTurn[] {
  const all = turnsFor(db, caseId);
  const eligible = keepRecent > 0 ? all.slice(0, Math.max(0, all.length - keepRecent)) : all;
  return eligible.filter((turn) => turn.kind === "verbatim");
}

/**
 * Closes a Case with its verdict.
 *
 * Returns false rather than throwing when the Case is already closed, and does
 * **not** overwrite the verdict that was reached. A second close is usually two
 * things racing to finish the same work, not a mistake worth an exception — but
 * the first verdict is the one that was actually argued to, so it stands.
 */
export function closeCase(
  db: DatabaseSync,
  caseId: string,
  outcome: { readonly closedAs: ClosedAs; readonly verdict: string },
  at: number = now()
): boolean {
  const result = db
    .prepare(
      `UPDATE work_case SET closed_at = ?, closed_as = ?, verdict = ?
        WHERE id = ? AND closed_at IS NULL`
    )
    .run(at, outcome.closedAs, outcome.verdict.trim(), caseId);
  return Number(result.changes) > 0;
}

/** Points a Case at a record. The record is untouched; only the reference is stored. */
export function link(db: DatabaseSync, caseId: string, kind: LinkKind, refId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO case_link (case_id, kind, ref_id) VALUES (?, ?, ?)`
  ).run(caseId, kind, refId);
}

/** Which Cases touched this record — the reverse question, and the useful one. */
export function casesAbout(
  db: DatabaseSync,
  kind: LinkKind,
  refId: string
): readonly CaseRow[] {
  const ids = db
    .prepare(`SELECT case_id AS id FROM case_link WHERE kind = ? AND ref_id = ?`)
    .all(kind, refId) as readonly Record<string, unknown>[];
  return ids
    .map((row) => readCase(db, String(row["id"])))
    .filter((row): row is CaseRow => row !== null);
}

const CASE_COLUMNS = `
  c.id                AS id,
  c.title             AS title,
  c.question          AS question,
  c.opened_at         AS openedAt,
  c.closed_at         AS closedAt,
  c.closed_as         AS closedAs,
  c.verdict           AS verdict,
  COALESCE(t.n, 0)    AS turns,
  COALESCE(t.last, c.opened_at) AS lastActivityAt
`;

const CASE_FROM = `
  FROM work_case c
  LEFT JOIN (
    SELECT case_id, COUNT(*) AS n, MAX(at) AS last FROM case_turn GROUP BY case_id
  ) t ON t.case_id = c.id
`;

/**
 * One row, narrowed by hand.
 *
 * `node:sqlite` hands back `Record<string, SQLOutputValue>`, and asserting that
 * is already the shape we want is the kind of cast that is right until a column
 * is renamed. Reading each field by name costs four lines and fails loudly.
 */
function toCaseRow(row: Record<string, unknown>): CaseRow {
  const closedAt = row["closedAt"];
  const closedAs = row["closedAs"];
  const verdict = row["verdict"];
  return {
    id: String(row["id"]),
    title: String(row["title"]),
    question: String(row["question"]),
    openedAt: Number(row["openedAt"]),
    closedAt: closedAt === null ? null : Number(closedAt),
    closedAs: closedAs === null ? null : (String(closedAs) as ClosedAs),
    verdict: verdict === null ? null : String(verdict),
    turns: Number(row["turns"] ?? 0),
    lastActivityAt: Number(row["lastActivityAt"])
  };
}

export function readCase(db: DatabaseSync, caseId: string): CaseRow | null {
  const row = db
    .prepare(`SELECT ${CASE_COLUMNS} ${CASE_FROM} WHERE c.id = ?`)
    .get(caseId) as Record<string, unknown> | undefined;
  return row === undefined ? null : toCaseRow(row);
}

/** Open Cases, most recently active first — which is the order a person works in. */
export function openCases(db: DatabaseSync): readonly CaseRow[] {
  return db
    .prepare(
      `SELECT ${CASE_COLUMNS} ${CASE_FROM} WHERE c.closed_at IS NULL ORDER BY lastActivityAt DESC`
    )
    .all()
    .map((row) => toCaseRow(row as Record<string, unknown>));
}

/** Everything, newest first. Closed Cases are history worth keeping, not clutter. */
export function allCases(db: DatabaseSync, limit = 200): readonly CaseRow[] {
  return db
    .prepare(
      `SELECT ${CASE_COLUMNS} ${CASE_FROM} ORDER BY lastActivityAt DESC LIMIT ?`
    )
    .all(limit)
    .map((row) => toCaseRow(row as Record<string, unknown>));
}

/**
 * Erases a Case and everything said inside it.
 *
 * The scope DPDP (10.3) previously had to invent for itself. Turns and links go
 * with it through `ON DELETE CASCADE`; the records it *pointed at* are untouched,
 * because deleting a Case about an invoice must never delete the invoice.
 */
export function eraseCase(db: DatabaseSync, caseId: string): boolean {
  // `ON DELETE CASCADE` is only honoured when foreign keys are on for the
  // connection. `open.ts` turns them on; a caller that did not would silently
  // orphan every turn, so this does not depend on being asked nicely.
  db.exec("PRAGMA foreign_keys = ON");
  const result = db.prepare(`DELETE FROM work_case WHERE id = ?`).run(caseId);
  return Number(result.changes) > 0;
}

/** How many Cases there are, open and closed. For the "what it has seen" screen. */
export function caseCounts(db: DatabaseSync): { readonly open: number; readonly closed: number } {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN closed_at IS NULL THEN 0 ELSE 1 END) AS closed
         FROM work_case`
    )
    .get() as Record<string, unknown>;
  return { open: Number(row["open"] ?? 0), closed: Number(row["closed"] ?? 0) };
}
