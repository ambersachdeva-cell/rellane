/** The production edit bridge must save only the selected change that main previewed. */
import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { appendTurn, closeCase, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { acceptArtifact, artifactLineage, artifactVersions, saveArtifact } from "./artifacts.js";
import { sha256Hex } from "./artifact-edit-preview.js";
import { installArtifactEditIpc, type ArtifactEditReview } from "./artifact-edit-ipc.js";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel)
} }));

const owner = Object.freeze({ id: "owner" });
const foreignOwner = Object.freeze({ id: "foreign" });
const trusted = { owner, allowed: true } as unknown as IpcMainInvokeEvent;
const foreign = { owner: foreignOwner, allowed: true } as unknown as IpcMainInvokeEvent;
const untrusted = { owner: foreignOwner, allowed: false } as unknown as IpcMainInvokeEvent;

function invoke(channel: string, input: unknown, event = trusted): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler(event, input);
}

describe("artifact selection preview production IPC", () => {
  let db: DatabaseSync;
  let caseId: string;
  let at: number;
  let shutdown: () => void;
  let cancelAll: () => void;
  let bookReads: number;

  beforeEach(() => {
    handlers.clear();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    caseId = openCase(db, { title: "Campaign", question: "Prepare launch copy" });
    at = 1000;
    bookReads = 0;
    const lifecycle = installArtifactEditIpc({
      assertTrusted: event => { if (!(event as unknown as { allowed: boolean }).allowed) throw new Error("Untrusted renderer."); },
      ownerFor: event => (event as unknown as { owner: object }).owner,
      book: () => { bookReads++; return db; },
      now: () => at
    });
    shutdown = lifecycle.shutdown;
    cancelAll = lifecycle.cancelAll;
  });

  afterEach(() => {
    shutdown();
    db.close();
  });

  function request(baseVersionId: string, body: string, overrides: Record<string, unknown> = {}) {
    return { id: caseId, baseVersionId, baseSha256: sha256Hex(body),
      selectionStart: 7, selectionEnd: 11, replacement: "clear", ...overrides };
  }

  it("previews producer-computed impact without writing, then appends exactly the reviewed version", async () => {
    const sourceTurnId = appendTurn(db, caseId, { seat: "Designer", kind: "verbatim", body: "Initial direction" });
    const first = saveArtifact(db, { id: caseId, baseVersionId: null, sourceTurnId,
      body: "Start: warm ending." });
    acceptArtifact(db, caseId, first.id);
    const beforeTurns = turnsFor(db, caseId).length;
    const reviewed = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    expect(reviewed.preview.affectedScope).toEqual({ start: 7, end: 11 });
    expect(reviewed.preview.userSuppliedScopeLabel).toBeNull();
    expect(reviewed.preview.excerpts).toEqual({ before: "warm", after: "clear" });
    expect(reviewed.newBody).toBe("Start: clear ending.");
    expect(reviewed.preview.unchangedPrefix.sha256).toBe(sha256Hex("Start: "));
    expect(reviewed.preview.unchangedSuffix.sha256).toBe(sha256Hex(" ending."));
    expect(artifactVersions(db, caseId)).toHaveLength(1);
    expect(turnsFor(db, caseId)).toHaveLength(beforeTurns);

    const room = await invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: reviewed.token }) as { artifacts: ReturnType<typeof artifactVersions> };
    expect(room.artifacts).toHaveLength(2);
    expect(room.artifacts[0]?.body).toBe(reviewed.newBody);
    expect(room.artifacts[0]?.sourceTurnId).toBe(sourceTurnId);
    expect(room.artifacts[0]?.acceptedAt).toBeNull();
    expect(room.artifacts[1]?.id).toBe(first.id);
    expect(room.artifacts[1]?.acceptedAt).not.toBeNull();
    expect(artifactLineage(db, caseId).map(entry => entry.status)).toEqual(["verified", "verified"]);
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit, { token: reviewed.token }))
      .rejects.toThrow(/expired/);
  });

  it("cannot apply a changed body or borrow a base version from another workroom", async () => {
    const first = saveArtifact(db, { id: caseId, baseVersionId: null, sourceTurnId: null,
      body: "Start: warm ending." });
    const otherCase = openCase(db, { title: "Other", question: "Separate output" });
    const other = saveArtifact(db, { id: otherCase, baseVersionId: null, sourceTurnId: null,
      body: first.body });
    await expect(invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(other.id, other.body))).rejects.toThrow(/changed/);
    const reviewed = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: reviewed.token, body: "A forged replacement" })).rejects.toThrow();
    expect(artifactVersions(db, caseId)).toHaveLength(1);
    expect(artifactVersions(db, otherCase)).toHaveLength(1);
  });

  it("rejects untrusted, malformed and caller-invented scope before reading the Book", async () => {
    const first = saveArtifact(db, { id: caseId, baseVersionId: null, sourceTurnId: null,
      body: "Start: warm ending." });
    const before = bookReads;
    await expect(invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body), untrusted)).rejects.toThrow(/Untrusted/);
    expect(bookReads).toBe(before);
    await expect(invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body, { scopeLabel: "Entire project" }))).rejects.toThrow();
    await expect(invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body, { selectionEnd: 7 }))).rejects.toThrow(/empty/);
    await expect(invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body, { baseSha256: "0".repeat(64) }))).rejects.toThrow(/changed/);
    expect(artifactVersions(db, caseId)).toHaveLength(1);
  });

  it("rejects foreign, expired, stale and replayed review tokens without overwriting output", async () => {
    const first = saveArtifact(db, { id: caseId, baseVersionId: null, sourceTurnId: null,
      body: "Start: warm ending." });
    const foreignReview = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: foreignReview.token }, foreign)).rejects.toThrow(/another window/);
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: foreignReview.token })).rejects.toThrow(/expired/);

    const expired = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    at = expired.expiresAt;
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: expired.token })).rejects.toThrow(/expired/);
    at = 1000;
    const stale = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    const concurrent = saveArtifact(db, { id: caseId, baseVersionId: first.id,
      sourceTurnId: null, body: "A concurrent owner edit." });
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: stale.token })).rejects.toThrow(/changed/);
    expect(artifactVersions(db, caseId)[0]?.id).toBe(concurrent.id);
    expect(artifactVersions(db, caseId)).toHaveLength(2);
  });

  it("withdraws an outstanding review on navigation or window teardown", async () => {
    const first = saveArtifact(db, { id: caseId, baseVersionId: null, sourceTurnId: null,
      body: "Start: warm ending." });
    const reviewed = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    cancelAll();
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: reviewed.token })).rejects.toThrow(/expired/);
    expect(artifactVersions(db, caseId)).toHaveLength(1);
  });

  it("preserves output when save receipt fails and refuses a closed workroom", async () => {
    const first = saveArtifact(db, { id: caseId, baseVersionId: null, sourceTurnId: null,
      body: "Start: warm ending." });
    const reviewed = await invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body)) as ArtifactEditReview;
    db.exec("CREATE TRIGGER reject_edit_receipt BEFORE INSERT ON case_turn BEGIN SELECT RAISE(ABORT, 'receipt refused'); END");
    await expect(invoke(IPC_CHANNELS.casesApplyArtifactEdit,
      { token: reviewed.token })).rejects.toThrow(/receipt refused/);
    expect(artifactVersions(db, caseId)).toHaveLength(1);
    db.exec("DROP TRIGGER reject_edit_receipt");
    closeCase(db, caseId, { closedAs: "settled", verdict: "Ready" });
    await expect(invoke(IPC_CHANNELS.casesPreviewArtifactEdit,
      request(first.id, first.body))).rejects.toThrow(/Open this workroom/);
  });
});
