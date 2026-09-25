/** A selected edit is reviewed against the current saved output before the
 * existing append-only artifact writer may save exactly that previewed text. */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CaseArtifactEditPreviewInputSchema, CaseArtifactSaveSchema, type CaseArtifactEditReview, type CaseRoom } from "@cadrane/contracts";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { readCase, turnsFor } from "../book/cases.js";
import { exportReceipts } from "./exports.js";
import { artifactVersions, saveArtifact } from "./artifacts.js";
import {
  previewArtifactEdit,
  sha256Hex
} from "./artifact-edit-preview.js";

const ApplySchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) });
const REVIEW_TTL_MS = 5 * 60_000;
const MAX_REVIEWS = 32;

interface PendingEdit {
  readonly owner: object;
  readonly id: string;
  readonly baseVersionId: string;
  readonly baseSha256: string;
  readonly sourceTurnId: string | null;
  readonly newBody: string;
  readonly expectedSha256: string;
  readonly expiresAt: number;
}

export type ArtifactEditReview = CaseArtifactEditReview;

export interface InstallArtifactEditOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly ownerFor: (event: IpcMainInvokeEvent) => object;
  readonly book: () => DatabaseSync;
  readonly now?: () => number;
}

function requireCurrent(db: DatabaseSync, id: string, versionId: string, bodySha256: string) {
  const room = readCase(db, id);
  if (!room || room.closedAt !== null) throw new Error("Open this workroom before editing its output.");
  const versions = artifactVersions(db, id);
  const latest = versions[0];
  if (!latest) throw new Error("Save an output before editing a selection.");
  if (latest.id !== versionId || sha256Hex(latest.body) !== bodySha256.toLowerCase()) {
    throw new Error("The saved output changed. Reload it and preview the edit again.");
  }
  if (versions.length >= 100) throw new Error("This output has 100 saved versions. Start a new workroom to continue.");
  if (latest.sourceTurnId !== null && !turnsFor(db, id).some(turn =>
    turn.id === latest.sourceTurnId && turn.kind === "verbatim")) {
    throw new Error("The saved output's source draft is no longer valid in this workroom.");
  }
  return latest;
}

export function installArtifactEditIpc(options: InstallArtifactEditOptions) {
  const pending = new Map<string, PendingEdit>();
  const now = options.now ?? Date.now;
  const owner = (event: IpcMainInvokeEvent): object => {
    options.assertTrusted(event);
    return options.ownerFor(event);
  };

  ipcMain.handle(IPC_CHANNELS.casesPreviewArtifactEdit, async (event, raw: unknown): Promise<ArtifactEditReview> => {
    const reviewer = owner(event);
    const request = CaseArtifactEditPreviewInputSchema.parse(raw);
    const db = options.book();
    const latest = requireCurrent(db, request.id, request.baseVersionId, request.baseSha256);
    const result = previewArtifactEdit({
      currentBody: latest.body,
      currentVersionId: latest.id,
      baseVersionId: request.baseVersionId,
      baseSha256: request.baseSha256,
      selectionStart: request.selectionStart,
      selectionEnd: request.selectionEnd,
      replacement: request.replacement,
      schemaMaxBodyLength: 50_000
    });
    // The owner supplies a selection, but the affected scope and unchanged
    // regions are computed from the saved body in main, never from a label.
    CaseArtifactSaveSchema.parse({ id: request.id, baseVersionId: latest.id,
      sourceTurnId: latest.sourceTurnId, body: result.newBody });
    options.assertTrusted(event);
    if (options.ownerFor(event) !== reviewer) throw new Error("The workroom window changed during preview.");
    const token = randomBytes(32).toString("hex");
    const expiresAt = now() + REVIEW_TTL_MS;
    pending.set(token, { owner: reviewer, id: request.id, baseVersionId: latest.id,
      baseSha256: sha256Hex(latest.body), sourceTurnId: latest.sourceTurnId,
      newBody: result.newBody, expectedSha256: result.preview.expectedSha256, expiresAt });
    while (pending.size > MAX_REVIEWS) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
    return { token, expiresAt, caseId: request.id, baseVersionId: latest.id,
      baseSha256: sha256Hex(latest.body), newBody: result.newBody, preview: result.preview };
  });

  ipcMain.handle(IPC_CHANNELS.casesApplyArtifactEdit, async (event, raw: unknown): Promise<CaseRoom> => {
    const reviewer = owner(event);
    const { token } = ApplySchema.parse(raw);
    const edit = pending.get(token);
    pending.delete(token);
    if (!edit || edit.owner !== reviewer || now() >= edit.expiresAt) {
      throw new Error("Artifact edit review expired or belongs to another window.");
    }
    const db = options.book();
    const latest = requireCurrent(db, edit.id, edit.baseVersionId, edit.baseSha256);
    if (latest.sourceTurnId !== edit.sourceTurnId || sha256Hex(edit.newBody) !== edit.expectedSha256) {
      throw new Error("Artifact edit preview changed. Review it again.");
    }
    saveArtifact(db, { id: edit.id, baseVersionId: latest.id,
      sourceTurnId: edit.sourceTurnId, body: edit.newBody });
    return { case: readCase(db, edit.id), turns: turnsFor(db, edit.id),
      artifacts: artifactVersions(db, edit.id), exports: exportReceipts(db, edit.id) };
  });

  return {
    cancelOwner(ownerValue: object): void {
      for (const [token, edit] of pending) if (edit.owner === ownerValue) pending.delete(token);
    },
    cancelAll(): void {
      pending.clear();
    },
    shutdown(): void {
      pending.clear();
      ipcMain.removeHandler(IPC_CHANNELS.casesPreviewArtifactEdit);
      ipcMain.removeHandler(IPC_CHANNELS.casesApplyArtifactEdit);
    }
  };
}
