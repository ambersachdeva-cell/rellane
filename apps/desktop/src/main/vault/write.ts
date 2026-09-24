/**
 * The Vault: the book, mirrored as plain markdown.
 *
 * The promise is exact and worth stating in one sentence — **delete Rellane and
 * you still have your business, in files you can read.** Not an export you
 * remember to run, not a proprietary archive: a folder of markdown that is
 * written as the book changes and that opens in any text editor on any machine.
 *
 * ## Why this is not just a backup
 *
 * A backup (D-047) is an encrypted blob that protects against loss. This
 * protects against *us* — against this product being abandoned, or becoming
 * something the owner no longer wants to run. Those are different fears and
 * they need different answers, and only one of them can be read by a person.
 *
 * ## The book is the truth; the vault is a view
 *
 * Written one way, always. A note edited outside must never silently change an
 * amount — the reader (6.2) brings prose back as narrative, and never a figure.
 * That is the same ruling as flows: the document is truth, the canvas is a view
 * (D-014).
 *
 * ## Why the shape is what it is
 *
 * Frontmatter and `[[wikilinks]]` because that is what Obsidian reads, and
 * Obsidian is what somebody in this position is most likely to already have.
 * Nothing here *requires* it — the files are plain markdown and the links
 * degrade to text — but a graph of customers and bills that opens for free is
 * worth shaping the output around.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rupees } from "../book/money.js";
import type { Standing } from "../book/records.js";

/**
 * A page this mirror wrote, recognised by its frontmatter and nothing else.
 *
 * Anchored to the top of the file and to the start of a line, because the only
 * thing that may mark a file for deletion is the block this writer produced —
 * never a phrase appearing anywhere in somebody's prose.
 */
const OURS_FRONTMATTER = /^---\r?\n(?:[^\n]*\r?\n)*?cadrane:\s*"/u;

/** Characters a filename cannot carry, and that a customer's name might. */
const UNSAFE = /[\/\\:*?"<>|\n\r]/gu;

/**
 * A file name for a party.
 *
 * Their name, kept readable, because the whole point is that a person opening
 * this folder in five years recognises what they are looking at. An id would be
 * stable and useless.
 */
export function fileNameFor(name: string): string {
  const safe = name.replace(UNSAFE, "-").replace(/\s+/gu, " ").trim().slice(0, 80);
  return `${safe.length === 0 ? "unnamed" : safe}.md`;
}

/** YAML frontmatter, quoted so a colon in a name cannot break the document. */
function frontmatter(fields: Readonly<Record<string, string | number>>): string {
  const lines = Object.entries(fields).map(([key, value]) =>
    typeof value === "number" ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

function onDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

/** One party's page. */
export function partyPage(
  standing: Standing,
  bills: readonly { number: string | null; issuedOn: number; totalPaise: number }[]
): string {
  const head = frontmatter({
    cadrane: "party",
    // The id, so a note read back lands on the right party even after a rename.
    // Matching on the name would send somebody's note to a stranger the first
    // time two customers were spelled alike.
    id: standing.partyId,
    name: standing.name,
    // Rupees for a reader, paise for anything that has to be exact. Writing
    // only the formatted figure would make this file pretty and unusable.
    owed: rupees(standing.owedPaise),
    owed_paise: standing.owedPaise,
    billed_paise: standing.billedPaise,
    paid_paise: standing.paidPaise,
    ...(standing.phone === null ? {} : { phone: standing.phone })
  });

  const rows =
    bills.length === 0
      ? "_No bills recorded._"
      : [
          "| Bill | Issued | Amount |",
          "| --- | --- | --- |",
          ...bills.map(
            (bill) =>
              `| ${bill.number ?? "—"} | ${onDay(bill.issuedOn)} | ${rupees(bill.totalPaise)} |`
          )
        ].join("\n");

  return [
    head,
    `# ${standing.name}`,
    "",
    standing.owedPaise > 0
      ? `**${rupees(standing.owedPaise)} outstanding** across ${standing.openBills} ${
          standing.openBills === 1 ? "bill" : "bills"
        }.`
      : standing.owedPaise < 0
        ? `In credit by ${rupees(-standing.owedPaise)}.`
        : "Settled.",
    "",
    // The owner's own sentence, written back exactly as they typed it.
    //
    // Without this the round trip loses: a note read out of the file would be
    // saved into the book and then wiped from the file by the next write, and
    // watching your own writing disappear is the end of trusting a folder. It
    // is emitted verbatim, so reading the page again returns the same string
    // and the sync settles.
    ...(standing.note === null || standing.note.trim().length === 0
      ? []
      : [standing.note.trim(), ""]),
    "## Bills",
    "",
    rows,
    "",
    "---",
    "",
    // Said in the file itself, because the file will outlive any explanation
    // given elsewhere — and somebody finding it later needs to know it is a
    // mirror, not the original.
    "_Written by Rellane from its book. Edit freely: notes here flow back, but_",
    "_amounts never do — the book stays the record._",
    ""
  ].join("\n");
}

/** The index, so a folder of pages has a front door. */
export function indexPage(parties: readonly Standing[], totalOwedPaise: number): string {
  const owing = parties.filter((party) => party.owedPaise > 0);
  return [
    frontmatter({ cadrane: "index", outstanding_paise: totalOwedPaise }),
    "# The book",
    "",
    `**${rupees(totalOwedPaise)} outstanding** across ${owing.length} ${
      owing.length === 1 ? "customer" : "customers"
    }.`,
    "",
    ...(owing.length === 0
      ? ["Nothing outstanding."]
      : owing.map(
          (party) => `- [[${fileNameFor(party.name).replace(/\.md$/u, "")}]] — ${rupees(party.owedPaise)}`
        )),
    "",
    "---",
    "",
    "_Written by Rellane. Delete the app and this folder still reads._",
    ""
  ].join("\n");
}

export interface MirrorResult {
  readonly written: number;
  readonly removed: number;
  readonly folder: string;
}

/**
 * Writes the whole vault.
 *
 * Rewritten in full rather than patched: the book is small enough that a
 * complete write is instant, and a diff-based mirror is where stale pages come
 * from — a customer renamed or archived leaves a file nobody deletes, and the
 * folder slowly stops matching the business.
 *
 * Files Rellane did not write are left alone. Somebody keeping their own notes
 * beside these pages is exactly the use this format exists for, and a mirror
 * that tidies away a person's own writing would be the last time they trusted
 * it with a folder.
 */
export async function mirror(
  folder: string,
  parties: readonly Standing[],
  billsFor: (partyId: string) => readonly { number: string | null; issuedOn: number; totalPaise: number }[],
  totalOwedPaise: number
): Promise<MirrorResult> {
  await mkdir(folder, { recursive: true });

  const wanted = new Map<string, string>();
  const INDEX = "The book.md";
  wanted.set(INDEX, indexPage(parties, totalOwedPaise));
  for (const party of parties) {
    // Names collide. Two customers can be spelled the same, two different
    // spellings can sanitise to one filename, and a customer called "The book"
    // would land on the index itself — each of which silently dropped a page
    // and the bills on it. A suffix costs an ugly filename and saves a record.
    let name = fileNameFor(party.name);
    if (name === INDEX || wanted.has(name)) {
      const stem = name.replace(/\.md$/u, "");
      let n = 2;
      while (wanted.has(`${stem} (${n}).md`)) {
        n += 1;
      }
      name = `${stem} (${n}).md`;
    }
    wanted.set(name, partyPage(party, billsFor(party.partyId)));
  }

  for (const [name, body] of wanted) {
    await writeFile(join(folder, name), body, "utf8");
  }

  // Only pages this mirror produced are candidates for removal, and only ones
  // it no longer wants.
  let removed = 0;
  for (const name of await readdir(folder).catch(() => [])) {
    if (!name.endsWith(".md") || wanted.has(name)) {
      continue;
    }
    const body = await import("node:fs/promises")
      .then((fs) => fs.readFile(join(folder, name), "utf8"))
      .catch(() => "");
    // Only a page whose *frontmatter* declares it ours.
    //
    // This was a substring search over the whole file, so any note of the
    // owner's that happened to contain the words `cadrane: ` — a reminder to
    // themselves about this very format, say — was deleted. Of every failure in
    // this module that is the one that cannot be undone, and it was one line.
    if (OURS_FRONTMATTER.test(body)) {
      await rm(join(folder, name), { force: true });
      removed += 1;
    }
  }

  return { written: wanted.size, removed, folder };
}

/**
 * A Case, as one readable page.
 *
 * This is where the vault's promise gets its hardest test. A party page is
 * figures, and figures survive being written down. A Case is a **conversation**,
 * and the sentence *"delete Rellane and you still have your business, in files
 * you can read"* is only true if the reasoning survives too — not just what was
 * decided, but who said what on the way to deciding it.
 *
 * It is also the honest test of 6.5. Obsidian is not installed on this Mac, so
 * nobody here can tick "the vault opens as a graph"; what *can* be checked is
 * that a case folder is plain markdown that degrades to text, and a person with
 * Obsidian can answer the rest in a minute.
 *
 * The verdict goes at the top, above the transcript. A reader who has already
 * been persuaded does not revise on a footnote — the same reasoning that put the
 * Bench's adjudication above its transcript (D-084).
 */
export function casePage(
  one: {
    readonly id: string;
    readonly title: string;
    readonly question: string;
    readonly openedAt: number;
    readonly closedAt: number | null;
    readonly closedAs: string | null;
    readonly verdict: string | null;
  },
  turns: readonly {
    readonly seat: string;
    readonly kind: string;
    readonly body: string;
    readonly at: number;
    readonly compactedFrom: readonly string[] | null;
  }[]
): string {
  const head = frontmatter({
    cadrane: "case",
    id: one.id,
    title: one.title,
    opened: onDay(one.openedAt),
    state: one.closedAt === null ? "open" : (one.closedAs ?? "closed"),
    turns: turns.length,
    ...(one.closedAt === null ? {} : { closed: onDay(one.closedAt) })
  });

  const body = turns.map((turn) => {
    const who = turn.seat === "owner" ? "You" : turn.seat;
    // A summary is labelled in the file too. Somebody reading this folder in
    // five years, with Rellane long gone, must still be able to tell what was
    // said from what a model said about what was said.
    const note =
      turn.kind === "compacted"
        ? ` _(summary of ${turn.compactedFrom?.length ?? 0} earlier turns)_`
        : turn.kind === "verbatim"
          ? ""
          : ` _(${turn.kind})_`;
    return `### ${who} · ${onDay(turn.at)}${note}\n\n${turn.body}\n`;
  });

  return [
    head,
    `# ${one.title}\n`,
    `> ${one.question}\n`,
    one.verdict === null
      ? "_Still open._\n"
      : `**Verdict.** ${one.verdict}\n`,
    "## The room\n",
    body.length === 0 ? "_Nothing was said._\n" : body.join("\n"),
    `\nBack to [[The book]].\n`
  ].join("\n");
}

/**
 * Mirrors cases into their own folder.
 *
 * Separate from `mirror` and separately pruned, so the two cannot delete each
 * other's pages — the party mirror removes any `.md` it did not write, and a
 * case landing beside a party would be swept away on the next pass.
 */
export async function mirrorCases(
  folder: string,
  cases: readonly {
    readonly id: string;
    readonly title: string;
    readonly question: string;
    readonly openedAt: number;
    readonly closedAt: number | null;
    readonly closedAs: string | null;
    readonly verdict: string | null;
  }[],
  turnsFor: (caseId: string) => readonly {
    readonly seat: string;
    readonly kind: string;
    readonly body: string;
    readonly at: number;
    readonly compactedFrom: readonly string[] | null;
  }[]
): Promise<{ readonly written: number; readonly removed: number; readonly folder: string }> {
  const into = join(folder, "Cases");
  await mkdir(into, { recursive: true });

  const wanted = new Map<string, string>();
  for (const one of cases) {
    let name = fileNameFor(one.title);
    if (wanted.has(name)) {
      const stem = name.replace(/\.md$/u, "");
      let n = 2;
      while (wanted.has(`${stem} (${n}).md`)) {
        n += 1;
      }
      name = `${stem} (${n}).md`;
    }
    wanted.set(name, casePage(one, turnsFor(one.id)));
  }

  for (const [name, page] of wanted) {
    await writeFile(join(into, name), page, "utf8");
  }

  // An erased case must not survive in the vault. Erasure that misses a copy is
  // not erasure, and this folder is the copy most likely to be forgotten.
  let removed = 0;
  for (const name of await readdir(into).catch(() => [])) {
    if (!name.endsWith(".md") || wanted.has(name)) {
      continue;
    }
    await rm(join(into, name), { force: true });
    removed += 1;
  }

  return { written: wanted.size, removed, folder: into };
}
