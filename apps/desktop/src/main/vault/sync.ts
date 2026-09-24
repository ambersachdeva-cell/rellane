/**
 * One pass of the Vault: read the owner's notes back, then write the book out.
 *
 * The order is the whole design. Reading first means a sentence typed into a
 * markdown file is in the book *before* the file that carried it is rewritten —
 * so nothing the owner wrote is ever overwritten by a mirror of the state that
 * existed before they wrote it.
 *
 * ## Why this is safe to run whenever
 *
 * The only thing that travels inwards is prose (6.2). A figure edited in a text
 * file cannot reach a balance, because the reader has no code path that produces
 * a number — so the worst a corrupted, half-synced or maliciously-edited vault
 * can do is put the wrong sentence on a customer's card. Wrong prose is a
 * correction; a wrong balance is a business decision made on a lie.
 *
 * ## It settles
 *
 * The writer emits the note verbatim, and the reader returns everything that is
 * not the writer's own shape. So a second sync over an untouched vault reads
 * back exactly what it wrote, changes nothing, and reports zero — which is what
 * makes it safe to run on a schedule later.
 */

import type { DatabaseSync } from "node:sqlite";
import { billsFor, outstanding, setNote, totalOwedPaise } from "../book/records.js";
import { diagnostics } from "../foundations/diagnostics.js";
import { readNotes } from "./read.js";
import { mirror, type MirrorResult } from "./write.js";

export interface SyncResult extends MirrorResult {
  /** Notes found in the folder, whether or not they were new. */
  readonly notesFound: number;
  /** Notes that changed something in the book. */
  readonly notesSaved: number;
}

/**
 * Reads notes in, writes the book out.
 *
 * Never partial in a way that loses: if the write fails, the notes are already
 * saved; if the read fails, it throws before anything is written and the folder
 * is left exactly as the owner left it.
 */
export async function syncVault(db: DatabaseSync, folder: string): Promise<SyncResult> {
  const notes = await readNotes(folder);

  let notesSaved = 0;
  for (const note of notes) {
    if (setNote(db, note.partyId, note.note)) {
      notesSaved += 1;
    }
  }

  const written = await mirror(
    folder,
    outstanding(db),
    (partyId) => billsFor(db, partyId),
    totalOwedPaise(db)
  );

  if (notesSaved > 0) {
    // Counts only. What somebody wrote about a customer is the most personal
    // thing in this book, and a log is the one file most likely to be handed to
    // a stranger while debugging.
    diagnostics.info("book", "took notes back from the vault", { notesSaved });
  }

  return { ...written, notesFound: notes.length, notesSaved };
}
