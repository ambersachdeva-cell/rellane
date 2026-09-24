/**
 * Reading back what the owner wrote in the Vault — task 6.2.
 *
 * The writer mirrors the book out as markdown (D-061). This brings one thing
 * back, and one thing only: **prose the owner added themselves.** A note like
 * *"agreed 45 days from October, ring Rakesh not the office"* is knowledge the
 * book has nowhere to put and that nobody will retype into a form.
 *
 * ## An amount never comes back. Not once, not ever
 *
 * This is the whole safety argument and it is worth being blunt about. If a
 * figure edited in a text file could change a balance, then the book would have
 * two authorities that can silently disagree — and the one that wins would be a
 * file the owner might have edited months ago, or that a sync client resolved a
 * conflict in, or that an agent tidied.
 *
 * So the reader is **structurally incapable** of it: it returns a single string
 * of prose, and the caller has nowhere to put it except a notes field. There is
 * no code path here that produces a number.
 *
 * ## What counts as the owner's writing
 *
 * Everything that is not ours. The writer emits a known shape — frontmatter, a
 * heading, a standing sentence, a bills table, a footer rule — so anything the
 * owner adds sits outside those, and that is what comes back. This is why the
 * writer keeps its shape stable: the reader's correctness depends on being able
 * to recognise its own output.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The line the writer puts before its footer. Everything after it is ours. */
const FOOTER = "---";

/** Lines the writer produces, which are therefore not the owner's. */
const OURS = [
  /^#\s/u,
  /^\*\*.*outstanding\*\* across/u,
  /^In credit by /u,
  /^Settled\.$/u,
  /^##\s/u,
  /^\|/u,
  /^_No bills recorded\._$/u,
  /^_Written by Rellane/u,
  /^_amounts never do/u,
  /^_Delete the app/u,
  /^-\s\[\[/u
];

export interface VaultNote {
  readonly file: string;
  /** Which party the page is for, from the frontmatter rather than the name. */
  readonly partyId: string;
  /** The party this page is about, from the frontmatter. */
  readonly partyName: string;
  /** Only what the owner wrote. Never a figure, never one of our lines. */
  readonly note: string;
}

/** The frontmatter block, or empty when the file has none. */
function frontmatterOf(body: string): string {
  // CRLF tolerated: a vault synced through iCloud or edited on another machine
  // comes back with Windows line endings, and a reader that only knows \n
  // silently decides the file has no frontmatter — after which every key it
  // looks for is missing and the whole document reads as the owner's prose.
  const found = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(body);
  return found?.[1] ?? "";
}

/**
 * Pulls a quoted frontmatter value without parsing YAML.
 *
 * Searches **only the frontmatter block.** It used to search the whole file,
 * which meant a document containing the line `cadrane: "party"` anywhere in its
 * prose was treated as one of ours and read — exactly the promise that a
 * person's own notes are never hoovered up, broken by a substring match.
 */
export function frontmatterValue(body: string, key: string): string | null {
  const found = new RegExp(`^${key}:\\s*(".*")\\s*$`, "mu").exec(frontmatterOf(body));
  if (found?.[1] === undefined) {
    return null;
  }
  // Parsed rather than pattern-matched, because the writer produced it with
  // `JSON.stringify` and that is the only exact inverse. A quote inside a
  // customer's name — `Acme "Widgets" Ltd` — is escaped on the way out, and a
  // regex reading up to the next or the last quote gets it wrong in a different
  // way each time.
  try {
    const value: unknown = JSON.parse(found[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The owner's own prose from one page.
 *
 * Deliberately conservative: a line that even looks like ours is dropped. The
 * cost of dropping a line of somebody's note is that they write it again; the
 * cost of keeping one of our own lines is a note that grows a copy of the
 * balance every time the vault is written, which then looks like a figure the
 * owner asserted.
 */
export function noteFrom(body: string): string {
  const afterFrontmatter = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");

  // Every line is judged on its own rather than everything after the last rule
  // being discarded.
  //
  // Slicing at the footer threw away anything written below it, and writing
  // underneath is exactly what somebody does when they add a note to a page
  // that already ends in a signature. It also mistook a horizontal rule in the
  // owner's own prose for our footer and truncated the rest of their writing.
  // The `OURS` patterns already recognise every line the footer contains, so
  // there was never anything for the slice to catch that they do not.
  return afterFrontmatter
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      // The rule itself is ours wherever it appears. Keeping it would put a
      // stray `---` at the top of somebody's note, which in markdown turns the
      // line above into a heading.
      return (
        trimmed.length > 0 &&
        trimmed !== FOOTER &&
        !OURS.some((pattern) => pattern.test(trimmed))
      );
    })
    .join("\n")
    .trim();
}

/**
 * Every note the owner has written in the vault.
 *
 * Pages Rellane did not write are skipped — a person's own separate notes file
 * is theirs, and hoovering it into the book would be reading something they
 * never offered.
 */
export async function readNotes(folder: string): Promise<readonly VaultNote[]> {
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".md"));

  const notes: VaultNote[] = [];
  for (const name of names) {
    const body = await readFile(join(folder, name), "utf8").catch(() => null);
    if (body === null || frontmatterValue(body, "cadrane") !== "party") {
      continue;
    }
    const partyId = frontmatterValue(body, "id");
    if (partyId === null) {
      // Ours, but from a version that did not stamp the id. Better to skip than
      // to guess which customer it belongs to; the next write restores it.
      continue;
    }
    const note = noteFrom(body);
    if (note.length === 0) {
      continue;
    }
    notes.push({
      file: name,
      partyId,
      partyName: frontmatterValue(body, "name") ?? name.replace(/\.md$/u, ""),
      note
    });
  }
  return notes;
}
