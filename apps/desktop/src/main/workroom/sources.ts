/** Import is a reviewed snapshot, not a standing permission to reread a file.
 * A preview stays in memory until explicitly added; its receipt lands atomically. */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CaseSourceCommitSchema,
  type CaseSourcePreview,
  type CaseSourceCommit,
} from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX, CASE_DATA_SEAT_PREFIX } from "../../shared/case-sources.js";
import { appendTurn, readCase } from "../book/cases.js";
import { readSourceDocument } from "./source-document.js";

interface IntakeState {
  active: { db: DatabaseSync; caseId: string; cancelled: boolean } | null;
  preview: {
    db: DatabaseSync;
    caseId: string;
    value: CaseSourcePreview;
  } | null;
  expiry: ReturnType<typeof setTimeout> | null;
}
function requireOpen(db: DatabaseSync, caseId: string): void {
  const room = readCase(db, caseId);
  if (!room || room.closedAt !== null)
    throw new Error("Open this workroom before adding a source.");
}
function clearPreview(state: IntakeState): void {
  if (state.expiry) clearTimeout(state.expiry);
  state.expiry = null;
  state.preview = null;
}

export class WorkroomSourceIntake {
  private readonly state: IntakeState = {
    active: null,
    preview: null,
    expiry: null,
  };
  preview(
    db: DatabaseSync,
    caseId: string,
    choose: () => Promise<string | null>,
  ): Promise<CaseSourcePreview | null> {
    return previewSource(this.state, db, caseId, choose);
  }
  add(db: DatabaseSync, input: CaseSourceCommit): string {
    return addSource(this.state, db, input);
  }
  discard(db: DatabaseSync, caseId: string, token?: string): boolean {
    return discardSource(this.state, db, caseId, token);
  }
}

export async function previewSource(
  state: IntakeState,
  db: DatabaseSync,
  caseId: string,
  choose: () => Promise<string | null>,
): Promise<CaseSourcePreview | null> {
  if (state.active)
    throw new Error(
      "A source is already being opened. Wait for that preview to finish.",
    );
  requireOpen(db, caseId);
  clearPreview(state);
  const active = { db, caseId, cancelled: false };
  state.active = active;
  try {
    const chosen = await choose();
    if (chosen === null || active.cancelled) return null;
    requireOpen(db, caseId);
    const document = await readSourceDocument(chosen);
    if (active.cancelled) return null;
    requireOpen(db, caseId);
    const value: CaseSourcePreview = {
      ...document,
      token: randomUUID(),
      expiresAt: Date.now() + 10 * 60_000,
    };
    state.preview = { db, caseId, value };
    state.expiry = setTimeout(() => clearPreview(state), 10 * 60_000);
    state.expiry.unref();
    return value;
  } finally {
    if (state.active === active) state.active = null;
  }
}

export function addSource(
  state: IntakeState,
  db: DatabaseSync,
  raw: CaseSourceCommit,
): string {
  const input = CaseSourceCommitSchema.parse(raw);
  const preview = state.preview;
  if (
    !preview ||
    preview.db !== db ||
    preview.caseId !== input.id ||
    preview.value.token !== input.token ||
    preview.value.expiresAt <= Date.now()
  ) {
    throw new Error(
      "This source preview is no longer available in this workroom. Choose the file again.",
    );
  }
  const source = preview.value;
  if (source.format === "csv" && input.startOffset !== undefined)
    throw new Error("Add the complete CSV snapshot so its header and row references stay intact.");
  const start = input.startOffset ?? 0;
  const end = input.endOffset ?? source.text.length;
  if (start >= end || end > source.text.length)
    throw new Error("Select a valid excerpt from this preview.");
  const text = source.text.slice(start, end);
  if (!text.trim() || /[\uD800-\uDFFF]/u.test(text))
    throw new Error("Select a nonempty excerpt with complete characters.");
  const textHash = createHash("sha256").update(text).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  let turnId: string;
  try {
    requireOpen(db, input.id);
    turnId = appendTurn(db, input.id, {
      seat: `${source.format === "csv" ? CASE_DATA_SEAT_PREFIX : CASE_SOURCE_SEAT_PREFIX}${source.fileName}`,
      kind: "verbatim",
      body: text,
    });
    appendTurn(db, input.id, {
      seat: "workroom",
      kind: "receipt",
      body: `Source snapshot added by you. Source turn: ${turnId}.\nFile: ${source.fileName}. Format: ${source.format}. Bytes: ${source.bytes}.\nFile SHA-256: ${source.fileSha256}. Extracted text SHA-256: ${source.textSha256}. Saved text SHA-256: ${textHash}.\nSaved range: ${start}–${end} of ${source.text.length} UTF-16 units.\nCoverage: ${source.coverage}\nThe file is not watched. This source is used only when selected for a request.`,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  clearPreview(state);
  return turnId;
}

export function discardSource(
  state: IntakeState,
  db: DatabaseSync,
  caseId: string,
  token?: string,
): boolean {
  let discarded = false;
  if (
    token === undefined &&
    state.active?.db === db &&
    state.active.caseId === caseId
  ) {
    state.active.cancelled = true;
    discarded = true;
  }
  if (
    state.preview?.db === db &&
    state.preview.caseId === caseId &&
    (token === undefined || state.preview.value.token === token)
  ) {
    clearPreview(state);
    discarded = true;
  }
  return discarded;
}
