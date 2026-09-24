/**
 * What Rellane has seen — assembled in one place, so it can be shown in one.
 *
 * This exists because of the order the plan puts things in: **the screen that
 * shows what a product has learned, and the switch that stops it, ship before
 * the learning does.** Not alongside. Before. A product that learns first and
 * explains later has already taken something it cannot give back, and every
 * such product says the screen is coming.
 *
 * ## What counts as "seen"
 *
 * Four things, and this module refuses to let them be listed anywhere else:
 *
 * - **Words** — the glossary, derived from the book, each with its evidence.
 * - **Folders** — which are watched, which are paused, and how much of each has
 *   actually been captured.
 * - **Notes** — the sentences the owner wrote themselves, which travelled in
 *   from the Vault.
 * - **Cases** — work the owner opened, and the rooms it was worked in. Added
 *   2026-09-05 with the Case itself (D-093).
 *
 * Everything on this screen is either derived from the book or a decision the
 * owner made. There is no fifth category, and there is nowhere else one could
 * hide, because the screen is generated from the same functions the prompts are.
 *
 * ## The fourth category arrived the right way round, and that is the point
 *
 * This note used to end "there is no fourth category". Then Cases were designed,
 * and a Case stores something nothing else here does: **the text of a
 * conversation.** The Bench refused to keep its turns for exactly that reason
 * (D-083) — the full text of every argument would be the most sensitive thing on
 * this Mac — and a Case keeps them because for a Case the transcript *is* the
 * work, and resuming one is replaying it.
 *
 * That is a real increase in what this product holds, so it is declared here
 * **before** the table that holds it was allowed to be written to, which is this
 * module's own rule and the reason it exists. A count of Cases and their titles
 * appears; the turns never do. Somebody checking what a product knows about them
 * should not have to read their own conversations on a screen a colleague might
 * be standing behind — the same reason a folder line says how many files and
 * never which.
 *
 * ## Why the counts are counts and not samples
 *
 * A folder line says how many files were captured, never which ones. Somebody
 * checking what a product knows about them should not have to read a list of
 * their own filenames on a screen a colleague might be standing behind.
 */

import type { DatabaseSync } from "node:sqlite";
import { caseCounts, openCases } from "../book/cases.js";
import { outstanding } from "../book/records.js";
import { glossary, type Term } from "./terms.js";

export interface SeenFolder {
  readonly path: string;
  /** The last component, which is what a person calls it. */
  readonly name: string;
  /** False when the owner has paused it. Nothing is read from a paused folder. */
  readonly watching: boolean;
  /** Files in the most recent capture, or null when nothing has been captured. */
  readonly files: number | null;
  /** When it was last looked at, ISO, or null. */
  readonly lastSeenAt: string | null;
}

export interface SeenNote {
  readonly partyName: string;
  readonly note: string;
}

export interface SeenCases {
  readonly open: number;
  readonly closed: number;
  /**
   * The titles of open Cases, and deliberately nothing that was said inside
   * them. A title is what the owner typed to name their own work; a transcript
   * is the work itself, and this screen counts rather than quotes.
   */
  readonly openTitles: readonly string[];
}

export interface Seen {
  readonly terms: readonly Term[];
  readonly folders: readonly SeenFolder[];
  readonly notes: readonly SeenNote[];
  readonly cases: SeenCases;
  /** True when there is genuinely nothing — a real state, not an empty screen. */
  readonly empty: boolean;
}

export interface FolderSighting {
  readonly path: string;
  readonly files: number | null;
  readonly lastSeenAt: string | null;
}

/**
 * Everything the owner is owed a view of.
 *
 * Takes the folder sightings rather than reading them, because the manifest
 * store lives in the IPC layer and this module is worth being able to test
 * without one.
 */
export function whatItHasSeen(
  db: DatabaseSync | null,
  granted: readonly string[],
  paused: readonly string[],
  sightings: readonly FolderSighting[]
): Seen {
  const pausedSet = new Set(paused);
  const byPath = new Map(sightings.map((sighting) => [sighting.path, sighting]));

  const folders = granted.map((path) => {
    const sighting = byPath.get(path);
    return {
      path,
      name: path.split("/").filter(Boolean).pop() ?? path,
      watching: !pausedSet.has(path),
      files: sighting?.files ?? null,
      lastSeenAt: sighting?.lastSeenAt ?? null
    };
  });

  const terms = db === null ? [] : glossary(db);
  const cases =
    db === null
      ? { open: 0, closed: 0, openTitles: [] }
      : {
          ...caseCounts(db),
          openTitles: openCases(db).map((row) => row.title)
        };
  const notes =
    db === null
      ? []
      : outstanding(db)
          .filter((party) => party.note !== null && party.note.trim().length > 0)
          .map((party) => ({ partyName: party.name, note: party.note ?? "" }));

  return {
    terms,
    folders,
    notes,
    cases,
    empty:
      terms.length === 0 &&
      folders.length === 0 &&
      notes.length === 0 &&
      cases.open === 0 &&
      cases.closed === 0
  };
}
