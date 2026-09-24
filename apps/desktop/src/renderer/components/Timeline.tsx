/**
 * The Timeline — the record, as the main surface of the app.
 *
 * It used to be a drawer behind a link reading "What it has done…". That put
 * the one thing this product can claim and its competitors cannot — it did the
 * work, here is the receipt, and you can put it back — three clicks away, while
 * the middle of the window held a paragraph apologising that nothing had
 * happened yet.
 *
 * The horizon rule is the organising idea. `--horizon` is defined in tokens.css
 * as "the line between what happened and what is coming", so the timeline draws
 * exactly that: work in flight above the line, the sealed record below it,
 * newest first. It is one marigold hairline and it is the only place in the
 * interface that colour appears at rest.
 *
 * Restore is offered per row and only when `entry.restorable` says the
 * snapshots are still held. Undo is time-boxed, so most rows are history — and
 * a button that would fail is the thing DESIGN.md §8 forbids by name.
 */

import type { ActivityEntry, ActivityLog, RestoreSubject, SkillRunResult } from "@cadrane/contracts";
import { plural } from "../../shared/copy.js";
import { Button, Chip } from "./ui";

interface Props {
  log: ActivityLog | null;
  /**
   * Step-level detail for runs made in this session, keyed by receipt. Rows
   * without an entry here are older than the session and show their one-line
   * record, which is all the ledger keeps.
   */
  details: Readonly<Record<string, SkillRunResult>>;
  /** True while a folder is being read or a plan is running. */
  busy: boolean;
  canGrant: boolean;
  onRestore(entry: RestoreSubject): void;
  onGrantFolder(): void;
}

export function Timeline({ log, details, busy, canGrant, onRestore, onGrantFolder }: Props) {
  if (log === null) {
    return (
      <div className="tl">
        <p className="tl__loading">Reading the record.</p>
      </div>
    );
  }

  const days = groupByDay(log.entries);
  const sessionResults = Object.values(details).filter(result =>
    !log.entries.some(entry => entry.receiptId === result.receiptId));

  return (
    <div className="tl">
      {/**
       * The integrity verdict sits above everything, because a list of past
       * actions is worth exactly as much as the guarantee that it has not been
       * edited. When the record is intact the line is quiet — no green tick,
       * no reassurance. Software that congratulates itself for working is
       * training you to skim past the moment it stops.
       */}
      <p className={log.trustworthy ? "tl__seal" : "tl__seal tl__seal--broken"} role="status">
        <span className="tl__sealmark" aria-hidden="true" />
        <span>
          {log.integrity}
          {log.trustworthy ? null : (
            <strong> Everything below should be read with that in mind.</strong>
          )}
        </span>
      </p>

      {busy ? (
        <div className="tl__coming">
          <span className="tl__pulse" aria-hidden="true" />
          <span className="tl__comingtext">Reading the folder. Nothing has moved yet.</span>
        </div>
      ) : null}

      <div className="tl__horizon" role="separator" aria-label="now">
        <span className="tl__horizonlabel">now</span>
      </div>

      {sessionResults.length === 0 ? null : (
        <section className="tl__day" aria-label="Results from this session">
          <h2 className="tl__daylabel">Results from this session</h2>
          <p className="tl__loading">These results are kept in this open window. They are not proof of saved history.</p>
          <ol className="tl__rows">
            {sessionResults.map(result => (
              <li className="tlrow" key={result.receiptId}>
                <div className="tlrow__body">
                  <p className="tlrow__what">{result.headline}</p>
                  {result.historyWarning === undefined ? null : <p className="tlrow__error">{result.historyWarning}</p>}
                </div>
                {result.canUndo && result.undoableUntil !== null && Date.parse(result.undoableUntil) >= Date.now() ? (
                  <Button className="tlrow__restore" onClick={() => onRestore({
                    receiptId: result.receiptId, summary: result.headline,
                    where: result.where ?? null, at: result.finishedAt ?? null
                  })}>Restore</Button>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      )}

      {log.entries.length === 0 ? (
        log.trustworthy ? (sessionResults.length === 0 ? <FirstRun canGrant={canGrant} onGrantFolder={onGrantFolder} /> : null) :
          <section className="firstrun" aria-label="History unavailable">
            <h2 className="firstrun__title">History is unavailable</h2>
            <p className="firstrun__lede">Stored entries could not be verified. This does not mean that no actions took place.
              Keep the original records while the problem is investigated.</p>
          </section>
      ) : (
        days.map((day) => (
          <section key={day.key} className="tl__day">
            <h2 className="tl__daylabel">{day.label}</h2>
            <ol className="tl__rows">
              {day.entries.map((entry) => (
                <Row
                  key={entry.seq}
                  entry={log.trustworthy ? entry : { ...entry, restorable: false }}
                  detail={entry.receiptId === null ? undefined : details[entry.receiptId]}
                  onRestore={onRestore}
                />
              ))}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

function Row({
  entry,
  detail,
  onRestore
}: {
  entry: ActivityEntry;
  detail: SkillRunResult | undefined;
  onRestore(entry: RestoreSubject): void;
}) {
  const receiptId = entry.receiptId;
  return (
    <li className={entry.undone ? "tlrow tlrow--undone" : "tlrow"}>
      <time className="tlrow__at" dateTime={entry.at} title={entry.at}>
        {clock(entry.at)}
      </time>
      <div className="tlrow__body">
        <p className="tlrow__what">{entry.summary}</p>
        <p className="tlrow__meta">
          {entry.where === null ? null : <span className="tlrow__where">{entry.where}</span>}
          {entry.undone ? <Chip tone="muted">put back</Chip> : null}
        </p>

        {detail === undefined ? null : (
          /**
           * Collapsed by default. The summary line above already answers "what
           * happened"; this answers "in what order, and how long did each part
           * take", which is a question you only have after the first one.
           */
          <details className="tlrow__detail">
            <summary className="tlrow__disclosure">
              {plural(detail.steps.length, "step")}
            </summary>
            <ol className="tlrow__steps">
              {detail.steps.map((step, index) => (
                <li key={`${detail.receiptId}-${index}`} className="tlrow__step">
                  {/**
                   * Colour on the exception, never on the expectation. Eighty-three
                   * identical green chips made green the loudest thing on the
                   * screen while carrying no information — the failure §3 names
                   * by that description. "Done" is what the reader already
                   * assumes from the row above; what they are scanning for is
                   * the one line that is not done.
                   */}
                  {step.outcome === "done" ? (
                    <span className="tlrow__bullet" aria-hidden="true" />
                  ) : (
                    <Chip tone={toneFor(step.outcome)}>{step.outcome}</Chip>
                  )}
                  <span className="tlrow__stepline">{step.summary}</span>
                  {step.error === undefined ? null : (
                    <span className="tlrow__error">{step.error}</span>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      {entry.restorable && receiptId !== null ? (
        <Button className="tlrow__restore" onClick={() => onRestore(entry)}>
          Restore
        </Button>
      ) : null}
    </li>
  );
}

function toneFor(outcome: string): "ok" | "warn" | "bad" | "muted" {
  switch (outcome) {
    case "done":
      return "ok";
    case "refused":
      return "warn";
    case "failed":
      return "bad";
    default:
      return "muted";
  }
}

/**
 * The first-run centre.
 *
 * It replaces "Nothing has happened yet", which stated a fact nobody needed and
 * taught nothing. A person opening this for the first time has one question —
 * what is this going to do to my files — and the answer is the three steps, in
 * order, in the app's own nouns.
 */
function FirstRun({
  canGrant,
  onGrantFolder
}: {
  canGrant: boolean;
  onGrantFolder(): void;
}) {
  return (
    <div className="firstrun">
      <h2 className="firstrun__title">The record starts here</h2>
      <p className="firstrun__lede">
        Everything Rellane does to your files lands on this line — what it did, which folder,
        and when. It is sealed as it is written, so it can tell you if it was edited afterwards.
      </p>

      <ol className="firstrun__steps">
        <li className="firstrun__step">
          <span className="firstrun__n">1</span>
          <span className="firstrun__stepname">Plan</span>
          <span className="firstrun__stepbody">
            A skill reads the folder and writes down what it intends to change. Nothing has
            moved at this point, and you see the list before anything does.
          </span>
        </li>
        <li className="firstrun__step">
          <span className="firstrun__n">2</span>
          <span className="firstrun__stepname">Run</span>
          <span className="firstrun__stepbody">
            You approve it. Rellane snapshots the folder first, then does the work, then
            writes what actually happened — not what it meant to happen.
          </span>
        </li>
        <li className="firstrun__step">
          <span className="firstrun__n">3</span>
          <span className="firstrun__stepname">Restore</span>
          <span className="firstrun__stepbody">
            While the snapshot is held, one button puts the folder back exactly as it was.
            Rows that can be restored say so; the rest are history and say that instead.
          </span>
        </li>
      </ol>

      {canGrant ? (
        <Button tone="primary" onClick={onGrantFolder}>
          Grant a folder to begin
        </Button>
      ) : null}
    </div>
  );
}

interface Day {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly ActivityEntry[];
}

/**
 * Entries arrive newest first and stay that way; this only inserts the day
 * headings, so the order the main process chose is never re-sorted here.
 */
function groupByDay(entries: readonly ActivityEntry[]): readonly Day[] {
  const days: Day[] = [];
  let current: { key: string; label: string; entries: ActivityEntry[] } | null = null;

  for (const entry of entries) {
    const at = new Date(entry.at);
    const key = Number.isNaN(at.getTime())
      ? "unknown"
      : `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    if (current === null || current.key !== key) {
      current = { key, label: dayLabel(at), entries: [] };
      days.push(current);
    }
    current.entries.push(entry);
  }

  return days;
}

/**
 * "Today" and "Yesterday" carry real meaning to someone working out whether the
 * app touched a folder before or after they did. Anything older gets a date,
 * because "5 days ago" makes that same person do arithmetic.
 */
function dayLabel(at: Date): string {
  if (Number.isNaN(at.getTime())) {
    return "Undated";
  }
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const daysBack = Math.round((midnight - day) / 86_400_000);

  if (daysBack === 0) return "Today";
  if (daysBack === 1) return "Yesterday";
  return at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** 24-hour, zero-padded, so the column stays a column. */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "—";
  }
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
