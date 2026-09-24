/**
 * What it has seen — the screen this product shipped before it learned anything.
 *
 * The order is the argument. Every product that quietly accumulates a picture of
 * its user says the page explaining it is coming; this one existed first, and
 * the switch that stops it works before there is anything to stop. That is the
 * only version of the promise worth making, because it is the only version that
 * cannot be quietly not-kept.
 *
 * ## Four lists, and there is no fifth
 *
 * Words, folders, notes, cases. Each row says where it came from — a term carries
 * the bills it was seen on, a folder carries how much was captured and when. A
 * line with no evidence beside it would be an assertion, and this screen exists
 * precisely because assertions are what people are right not to believe.
 *
 * *This said "three lists, and there is no fourth" until 2026-09-05.* Cases
 * arrived, and a Case keeps something nothing else here does: **the text of a
 * conversation.** The Bench refused to store its turns for exactly that reason
 * (D-083); a Case stores them because for a Case the transcript *is* the work,
 * and reopening one is replaying it. That is a real increase in what this
 * product holds, so the list it belongs on grew **before** the table did — which
 * is this screen's own rule, and the only version of it that means anything.
 *
 * ## Counts, never contents
 *
 * A folder says *487 files*, never which. Somebody checking what a product knows
 * about them should not have to read their own filenames on a screen a colleague
 * might be standing behind — and a screen about privacy that leaks while you
 * read it would be worse than not having one.
 *
 * ## Every row can be switched off from where it is read
 *
 * A term is hidden on its own line; a folder is paused on its own line. Not in
 * Settings, not behind a second confirmation. The distance between reading
 * something you dislike and stopping it is the whole measure of whether the
 * control is real.
 */

import type { Seen, VaultSyncResult } from "@cadrane/contracts";
import { Button, Chip, Empty, Notice, Section } from "./ui";

interface Props {
  seen: Seen | null;
  vault: VaultSyncResult | null;
  busy: boolean;
  problem: string | null;
  onHide(key: string, hidden: boolean): void;
  onPause(path: string, paused: boolean): void;
  onSyncVault(): void;
  onRevealVault(): void;
  onGrantFolder(): void;
}

/** A date a person reads, not an ISO string. */
function when(iso: string | null): string {
  if (iso === null) {
    return "not yet looked at";
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "not yet looked at";
  }
  return at.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function MemoryView({
  seen,
  vault,
  busy,
  problem,
  onHide,
  onPause,
  onSyncVault,
  onRevealVault,
  onGrantFolder
}: Props) {
  return (
    <>
      <header className="view__head">
        <h1 className="view__title">What it has seen</h1>
        <p className="view__lede">
          Everything Rellane has picked up, where it picked it up, and a switch beside each one.
          It learns from your own records — nothing here was typed into a form, and nothing
          leaves this Mac.
        </p>
      </header>

      {problem === null ? null : <Notice tone="bad">{problem}</Notice>}

      {seen === null ? (
        <p className="view__lede">Reading…</p>
      ) : (
        <>
          <Section title="Folders">
            {seen.folders.length === 0 ? (
              <Empty
                title="No folders granted"
                body="Rellane can only see a folder you have chosen in Finder. Until you grant one, it is looking at nothing."
                action={<Button onClick={onGrantFolder}>Grant a folder</Button>}
              />
            ) : (
              <ul className="mem__list">
                {seen.folders.map((folder) => (
                  <li className="mem__row" key={folder.path}>
                    <span className="mem__main">
                      <span className="mem__term">{folder.name}</span>
                      <span className="mem__why">
                        {folder.watching
                          ? `${folder.files === null ? "nothing captured yet" : `${folder.files.toLocaleString()} files`} · ${when(folder.lastSeenAt)}`
                          : "Paused — nothing is read from here, by anything."}
                      </span>
                    </span>
                    <span className="mem__act">
                      {folder.watching ? null : <Chip tone="warn">Paused</Chip>}
                      <Button
                        disabled={busy}
                        onClick={() => onPause(folder.path, folder.watching)}
                      >
                        {folder.watching ? "Pause" : "Resume"}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Words it has learned">
            {seen.terms.length === 0 ? (
              <Empty
                title="Nothing learned yet"
                body="Add a customer or a bill and the names and product terms on it appear here by themselves. You will never be asked to fill in a glossary."
              />
            ) : (
              <ul className="mem__list">
                {seen.terms.map((term) => (
                  <li className="mem__row" key={term.key}>
                    <span className="mem__main">
                      <span className="mem__term">
                        {term.term}
                        {term.aliases.length === 0 ? null : (
                          <span className="mem__alias"> also “{term.aliases.join("”, “")}”</span>
                        )}
                      </span>
                      <span className="mem__why">
                        {term.meaning} · {term.evidence}
                      </span>
                    </span>
                    <span className="mem__act">
                      <Button disabled={busy} onClick={() => onHide(term.key, true)}>
                        Forget
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Your own notes">
            {seen.notes.length === 0 ? (
              <Empty
                title="No notes yet"
                body="Write a line on any customer's page in the Vault and it appears here, and in what an agent is told. Amounts written there are never read back."
              />
            ) : (
              <ul className="mem__list">
                {seen.notes.map((note) => (
                  <li className="mem__row" key={note.partyName}>
                    <span className="mem__main">
                      <span className="mem__term">{note.partyName}</span>
                      <span className="mem__why">{note.note}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Cases you have opened">
            {seen.cases.open === 0 && seen.cases.closed === 0 ? (
              <Empty
                title="No cases yet"
                body="A case is work you named — a question, what was said while answering it, and the verdict. Rellane keeps what was said so you can close the lid and come back to it. Erasing a case erases everything said inside it."
              />
            ) : (
              <ul className="mem__list">
                {seen.cases.openTitles.map((title) => (
                  <li className="mem__row" key={title}>
                    <span className="mem__main">
                      <span className="mem__term">{title}</span>
                      <span className="mem__why">open</span>
                    </span>
                  </li>
                ))}
                {seen.cases.closed > 0 && (
                  <li className="mem__row" key="__closed">
                    <span className="mem__main">
                      {/* Counted, not listed. A closed case's title is still
                          something the owner wrote about their own work, and
                          this screen counts rather than quotes wherever it can. */}
                      <span className="mem__term">
                        {seen.cases.closed === 1
                          ? "1 closed case"
                          : `${seen.cases.closed} closed cases`}
                      </span>
                      <span className="mem__why">kept as history</span>
                    </span>
                  </li>
                )}
              </ul>
            )}
          </Section>
        </>
      )}

      <Section title="The Vault">
        <p className="mem__vaultsaid">
          Your book, written out as plain markdown you can read in any editor. Delete Rellane
          and your business is still there, in files. Notes you write in it come back;
          amounts never do.
        </p>
        <div className="mem__vaultacts">
          <Button tone="primary" disabled={busy} onClick={onSyncVault}>
            {busy ? "Writing…" : "Write it out"}
          </Button>
          <Button onClick={onRevealVault}>Show me the files</Button>
        </div>
        {vault === null ? null : (
          <p className="mem__vaultsaid">
            {`${vault.written} ${vault.written === 1 ? "page" : "pages"} written`}
            {vault.removed === 0 ? "" : `, ${vault.removed} removed`}
            {vault.notesSaved === 0
              ? "."
              : `, and ${vault.notesSaved} ${vault.notesSaved === 1 ? "note" : "notes"} taken back into the book.`}
          </p>
        )}
      </Section>
    </>
  );
}
