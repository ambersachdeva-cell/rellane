/**
 * Turns ledger records into the sentences the Activity view shows.
 *
 * The ledger stores structured facts — counts, folder paths, outcome strings —
 * because that is what survives a schema change and what a machine can verify.
 * A person reading "what did this thing do to my folder" wants a sentence. This
 * is the one place that conversion happens, so the phrasing is consistent and
 * so the renderer never receives the raw record.
 *
 * That last part is deliberate. The ledger holds full paths; the renderer gets
 * a folder's basename and nothing more. A renderer that never receives a
 * replayable path cannot leak one.
 */

import { basename } from "node:path";
import type { ActivityEntry, ActivityLog } from "@cadrane/contracts";
import { describeIntegrity, type Ledger, type SealedRecord } from "./security/ledger.js";
import { plural } from "../shared/copy.js";

/** How many entries the view asks for when it does not say. */
export const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function readActivity(
  ledger: Ledger | null,
  limit = DEFAULT_LIMIT,
  /**
   * Receipts whose snapshots are still held and whose undo window is open.
   * Defaults to none, so a caller that does not know says "nothing can be put
   * back" rather than promising a restore it has not checked.
   */
  restorable: ReadonlySet<string> = new Set()
): Promise<ActivityLog> {
  if (ledger === null) {
    return { entries: [], integrity: "Action history has not opened yet.", trustworthy: false };
  }

  const { integrity, records } = await ledger.snapshot();
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_LIMIT, MAX_LIMIT));

  // Gathered from every record rather than from the page being returned: an
  // undo that falls outside the slice would otherwise leave the run it reversed
  // still offering Restore, which is an offer the app cannot keep.
  const reversed = new Set<string>();
  for (const record of records) {
    const receipt = record.detail["receipt"];
    if (record.kind === "skill.undo" && typeof receipt === "string") {
      reversed.add(receipt);
    }
  }

  return {
    // Newest first: the question is almost always "what just happened", and
    // making someone scroll to the bottom for it is a small daily insult.
    entries: [...records]
      .reverse()
      .slice(0, bounded)
      .map((record) => describeRecord(record, reversed, restorable)),
    integrity: describeIntegrity(integrity),
    trustworthy: integrity.status === "intact"
  };
}

function describeRecord(
  record: SealedRecord,
  reversed: ReadonlySet<string>,
  restorable: ReadonlySet<string>
): ActivityEntry {
  const folder = typeof record.detail["folder"] === "string" ? record.detail["folder"] : null;
  const receiptId = typeof record.detail["receiptId"] === "string" ? record.detail["receiptId"] : null;
  const undone = receiptId !== null && reversed.has(receiptId);
  return {
    seq: record.seq,
    at: record.at,
    kind: record.kind,
    summary: summarise(record),
    where: folder === null ? null : basename(folder),
    receiptId,
    undone,
    // Both conditions, not either: a run that has already been put back has
    // nothing left to restore, and one whose window has closed has nothing left
    // to restore it from.
    restorable: receiptId !== null && !undone && restorable.has(receiptId)
  };
}

/**
 * One sentence per record.
 *
 * The counts come from the receipt rather than the plan, so this says what
 * happened rather than what was intended — a run where two steps were declined
 * says so, instead of reporting the whole plan as done.
 */
function summarise(record: SealedRecord): string {
  const detail = record.detail;
  const skill = typeof detail["skill"] === "string" ? detail["skill"] : "A skill";
  const done = count(detail["done"]);
  const refused = count(detail["refused"]);
  const failed = count(detail["failed"]);

  if (record.kind === "skill.undo") {
    return "Put everything back.";
  }

  if (record.kind !== "skill.run") {
    // An unfamiliar kind is shown rather than hidden. A record we cannot phrase
    // is still a record of something happening, and dropping it would make the
    // list disagree with the count the integrity line quotes.
    const outcome = typeof detail["outcome"] === "string" ? detail["outcome"] : null;
    return outcome ?? record.kind;
  }

  if (done === 0 && refused === 0 && failed === 0) {
    return `${label(skill)} found nothing to do.`;
  }

  const parts: string[] = [];
  if (done > 0) parts.push(`${plural(done, "change")} made`);
  if (refused > 0) parts.push(`${refused} declined`);
  if (failed > 0) parts.push(`${plural(failed, "failure")}`);
  return `${label(skill)}: ${parts.join(", ")}.`;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** "librarian" is an id; "Librarian" is what a person calls it. */
function label(skill: string): string {
  return skill.charAt(0).toUpperCase() + skill.slice(1);
}
