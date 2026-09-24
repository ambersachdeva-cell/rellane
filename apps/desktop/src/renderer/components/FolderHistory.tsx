/**
 * The folder's own history, above the record of what Rellane did to it.
 *
 * These are one surface on purpose. The ledger answers "what did this app do";
 * the scrubber answers "what happened to my folder", which includes everything
 * the owner did themselves. Someone trying to work out where a file went does
 * not know, or care, which of those two questions they are asking — so putting
 * them on separate screens would make them navigate to find out.
 *
 * The interaction is one click. Pick a moment on the rail and the diff below
 * reads "since then" — which is exactly the question W1.7 is specified against,
 * "what changed in Clients/ this week". A two-handled range would be more
 * capable and would turn a glance into a manipulation.
 */

import { useState } from "react";
import type { ContentDigest, FolderDiff, TimelineCapture } from "@cadrane/contracts";
import { plural, size } from "../../shared/copy.js";
import { Button, Chip } from "./ui";

interface Props {
  folderName: string;
  captures: readonly TimelineCapture[] | null;
  /** The moment being compared against now. Null until one is picked. */
  selectedAt: string | null;
  diff: FolderDiff | null;
  busy: boolean;
  digests: Readonly<Record<string, ContentDigest>>;
  onSelect(at: string): void;
  onCheckpoint(reason: string): void;
  onHash(path: string): void;
}

/**
 * Naming a checkpoint, inline.
 *
 * A checkpoint without a reason is a tick nobody can identify a fortnight
 * later, which is when it matters — so the reason is the whole feature, and it
 * is asked for on the same line as the button rather than in a modal that
 * interrupts a screen the reader is already reading.
 */
function MarkMoment({ busy, onCheckpoint }: { busy: boolean; onCheckpoint(reason: string): void }) {
  const [naming, setNaming] = useState(false);
  const [reason, setReason] = useState("");

  const commit = () => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      return;
    }
    onCheckpoint(trimmed);
    setReason("");
    setNaming(false);
  };

  if (!naming) {
    return (
      <Button className="fh__mark" onClick={() => setNaming(true)} disabled={busy}>
        Mark this moment
      </Button>
    );
  }

  return (
    <span className="fh__naming">
      <input
        className="fh__reasonin"
        autoFocus
        value={reason}
        maxLength={200}
        placeholder="Before the GST filing"
        aria-label="Why this moment matters"
        onChange={(event) => setReason(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setReason("");
            setNaming(false);
          }
        }}
      />
      <Button tone="primary" onClick={commit} disabled={busy || reason.trim().length === 0}>
        Mark
      </Button>
    </span>
  );
}

export function FolderHistory({
  folderName,
  captures,
  selectedAt,
  diff,
  busy,
  digests,
  onSelect,
  onCheckpoint,
  onHash
}: Props) {
  if (captures === null) {
    return (
      <section className="fh">
        <p className="fh__loading">Reading what this folder looked like.</p>
      </section>
    );
  }

  if (captures.length === 0) {
    return (
      <section className="fh">
        <header className="fh__head">
          <h2 className="fh__title">{folderName}</h2>
        </header>
        <p className="fh__empty">
          Nothing recorded yet. Rellane takes a reading when it starts watching a folder, and
          again whenever the folder settles after something changes.
        </p>
      </section>
    );
  }

  // Oldest on the left, so the rail reads the way time does. The list arrives
  // newest first, which is the right order for the record below and the wrong
  // one for a rail.
  const rail = [...captures].reverse();
  const newest = captures[0] as TimelineCapture;

  return (
    <section className="fh">
      <header className="fh__head">
        <h2 className="fh__title">{folderName}</h2>
        <span className="fh__count">
          {plural(captures.length, "reading")} · {plural(newest.files, "file")} now
        </span>
        <MarkMoment busy={busy} onCheckpoint={onCheckpoint} />
      </header>

      <ol className="fh__rail">
        {rail.map((capture) => {
          const picked = capture.at === selectedAt;
          return (
            <li key={capture.at} className="fh__tickwrap">
              <button
                type="button"
                className={tickClass(capture, picked)}
                aria-pressed={picked}
                aria-label={labelFor(capture)}
                title={labelFor(capture)}
                onClick={() => onSelect(capture.at)}
              />
            </li>
          );
        })}
      </ol>

      {selectedAt === null ? (
        <p className="fh__hint">
          Pick a moment on the line to see what has changed in {folderName} since then.
        </p>
      ) : (
        <Diff
          diff={diff}
          selected={captures.find((capture) => capture.at === selectedAt) ?? null}
          busy={busy}
          digests={digests}
          onHash={onHash}
        />
      )}
    </section>
  );
}

/**
 * A checkpoint is the one thing on this rail a person put there themselves, so
 * it is the one thing marked. Everything else is an automatic reading and looks
 * like one.
 */
function tickClass(capture: TimelineCapture, picked: boolean): string {
  const classes = ["fh__tick"];
  if (capture.checkpoint !== null) classes.push("fh__tick--marked");
  if (picked) classes.push("fh__tick--picked");
  return classes.join(" ");
}

function labelFor(capture: TimelineCapture): string {
  const when = moment(capture.at);
  return capture.checkpoint === null
    ? `${when} · ${plural(capture.files, "file")}`
    : `${when} · ${capture.checkpoint}`;
}

function Diff({
  diff,
  selected,
  busy,
  digests,
  onHash
}: {
  diff: FolderDiff | null;
  selected: TimelineCapture | null;
  busy: boolean;
  digests: Readonly<Record<string, ContentDigest>>;
  onHash(path: string): void;
}) {
  if (busy && diff === null) {
    return <p className="fh__loading">Comparing.</p>;
  }
  if (diff === null || selected === null) {
    return null;
  }

  return (
    <div className="fh__diff">
      <p className="fh__since">
        Since {moment(diff.from)}
        {selected.checkpoint === null ? null : (
          <span className="fh__reason"> — {selected.checkpoint}</span>
        )}
      </p>
      <p className="fh__summary">{diff.summary}</p>

      {diff.partial ? (
        <p className="fh__caveat">
          One of these two readings stopped at its limit, so this is a floor rather than a
          total. It happens on folders with more than 250,000 files.
        </p>
      ) : null}

      {diff.changes.length === 0 ? null : (
        <ul className="fh__changes">
          {diff.changes.map((change) => {
            const digest = digests[change.path];
            return (
              <li key={`${change.kind}-${change.path}`} className="fh__change">
                <Chip tone={toneFor(change.kind)}>{change.kind}</Chip>
                <span className="fh__path">
                  {change.path}
                  {change.movedTo === null ? null : (
                    <span className="fh__moved"> → {change.movedTo}</span>
                  )}
                </span>
                <span className="fh__bytes">
                  {change.bytesDelta === null ? size(change.bytes) : delta(change.bytesDelta)}
                </span>
                {/**
                 * Only offered where it can answer something. A removed file
                 * cannot be hashed, and a moved one is already proven identical
                 * by its inode — the filesystem's own answer, and a stronger
                 * one than a checksum of a copy.
                 */}
                {change.kind === "changed" || change.kind === "added" ? (
                  digest === undefined ? (
                    <button
                      type="button"
                      className="fh__check"
                      onClick={() => onHash(change.path)}
                    >
                      Check contents
                    </button>
                  ) : (
                    <span className={digest.digest === null ? "fh__digest fh__problem" : "fh__digest"}
                      role="status" title={digest.digest ?? undefined}>
                      {digest.digest === null
                        ? digest.problem
                        : `sha256 ${digest.digest.slice(0, 12)}`}
                    </span>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {diff.capped ? (
        <p className="fh__caveat">
          Showing {plural(diff.changes.length, "change")} of {totalOf(diff)}. The counts above are
          complete.
        </p>
      ) : null}
    </div>
  );
}

function totalOf(diff: FolderDiff): number {
  return diff.counts.added + diff.counts.removed + diff.counts.changed + diff.counts.moved;
}

function toneFor(kind: string): "ok" | "warn" | "bad" | "muted" {
  switch (kind) {
    case "moved":
      return "muted";
    case "added":
      return "ok";
    case "changed":
      return "warn";
    default:
      return "bad";
  }
}

/** "+1.2 KB" reads as a change; "1.2 KB" reads as a size. */
export function delta(bytes: number): string {
  if (bytes === 0) {
    return "same size";
  }
  return bytes > 0 ? `+${size(bytes)}` : `−${size(Math.abs(bytes))}`;
}

/**
 * A time a person can place without doing arithmetic.
 *
 * Today gets a clock, yesterday says so, anything older gets a date. "5 days
 * ago" makes the reader work out which day that was.
 */
export function moment(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "an unknown time";
  }
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const daysBack = Math.round((midnight - day) / 86_400_000);

  if (daysBack === 0) return clock;
  if (daysBack === 1) return `yesterday ${clock}`;
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${clock}`;
}
