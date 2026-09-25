import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTurn, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { LocalBriefDraftScope, MAX_LOCAL_BRIEF_ATTEMPTS } from "./local-brief-draft-scope.js";

const descriptor: RuntimeDescriptor = {
  id: "cadrane-local-loopback", name: "Bundled", kind: "lm-studio",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  detail: "Synthetic", checkedAt: "2026-09-24T00:00:00Z",
  models: [{ id: "local-model", displayName: "Local", loaded: true, sizeBytes: 100 }]
};
function answer(request: LocalChatRequest): LocalChatResult {
  return { operationId: request.operationId, runtimeId: request.runtimeId,
    modelId: request.modelId, content: JSON.stringify({ name: "File reader",
      purpose: "Read the chosen file", instructions: "Keep source limits.",
      folders: ["/synthetic"], capabilities: ["read_text"], tier: "on-device",
      maxSteps: 3, maxMinutes: 2, outbound: "never" }), localOnly: true,
    startedAt: "2026-09-24T00:00:00Z", finishedAt: "2026-09-24T00:00:01Z" };
}
function runtime(): LocalWorkroomDeps {
  return { discover: vi.fn(async () => [descriptor]),
    chat: vi.fn(async (request) => answer(request)), cancel: vi.fn(async () => undefined) };
}

describe("projectless local brief draft admission", () => {
  let db: DatabaseSync;
  let scope: LocalBriefDraftScope;
  const owner = {};
  const workspacePath = "/synthetic/private/workspace";
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    scope = new LocalBriefDraftScope();
    expect(scope.recover(db)).toBe(0);
  });
  afterEach(() => db.close());

  it("pins the exact request before the bundled runtime call and records only an editable draft receipt", async () => {
    const local = runtime();
    const handle = randomUUID();
    local.chat = vi.fn(async (request) => {
      const snapshot = db.prepare(`SELECT request_json AS packet, request_sha256 AS digest, model_id AS modelId
        FROM workstation_local_brief_request WHERE attempt_id = ?`).get(handle) as {
          packet: string; digest: string; modelId: string
        };
      expect(JSON.parse(snapshot.packet)).toEqual(request);
      expect(snapshot.modelId).toBe("local-model");
      expect(db.prepare(`SELECT event FROM workstation_local_brief_receipt
        WHERE attempt_id = ? ORDER BY sequence`).all(handle)).toEqual([
        { event: "admitted" }, { event: "dispatch_attempt" }
      ]);
      return answer(request);
    });
    const result = await scope.run({ db, handle, sentence: "Read one file",
      folders: ["/synthetic"], owner, workspacePath, assertOwner: () => undefined,
      grantedFolders: () => ["/synthetic"], runtime: local });
    expect(result.ok).toBe(true);
    expect(result.draft?.name).toBe("File reader");
    expect(db.prepare(`SELECT event FROM workstation_local_brief_receipt
      WHERE attempt_id = ? ORDER BY sequence`).all(handle)).toEqual([
      { event: "admitted" }, { event: "dispatch_attempt" }, { event: "completed" }
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_case").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM case_turn").get()).toEqual({ count: 0 });
    expect(new LocalBriefDraftScope().recover(db)).toBe(0);
  });

  it("rejects another window's Stop and discards a late answer after owner Stop", async () => {
    const local = runtime();
    let complete!: (reply: LocalChatResult) => void;
    let sent!: LocalChatRequest;
    local.chat = vi.fn((request) => { sent = request;
      return new Promise<LocalChatResult>((resolve) => { complete = resolve; }); });
    const handle = randomUUID();
    const pending = scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local });
    await vi.waitFor(() => expect(local.chat).toHaveBeenCalled(), { timeout: 500 });
    expect(() => scope.stop(handle, {})).toThrow(/another window/);
    expect(scope.stop(handle, owner)).toEqual({ stopped: true });
    complete(answer(sent));
    await expect(pending).rejects.toThrow();
    expect(local.cancel).toHaveBeenCalledWith(sent.operationId);
    expect(db.prepare(`SELECT event FROM workstation_local_brief_receipt
      WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1`).get(handle))
      .toEqual({ event: "interrupted" });
  });

  it("marks an interrupted dispatch on restart without replaying it", async () => {
    const local = runtime();
    let complete!: (reply: LocalChatResult) => void;
    let sent!: LocalChatRequest;
    local.chat = vi.fn((request) => { sent = request;
      return new Promise<LocalChatResult>((resolve) => { complete = resolve; }); });
    const handle = randomUUID();
    const pending = scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local });
    await vi.waitFor(() => expect(local.chat).toHaveBeenCalled(), { timeout: 500 });
    const afterRestart = new LocalBriefDraftScope();
    expect(afterRestart.recover(db)).toBe(1);
    expect(afterRestart.recover(db)).toBe(0);
    expect(local.chat).toHaveBeenCalledTimes(1);
    scope.stop(handle, owner);
    complete(answer(sent));
    await expect(pending).rejects.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM workstation_local_brief_receipt
      WHERE attempt_id = ? AND event = 'interrupted'`).get(handle)).toEqual({ count: 1 });
  });

  it("fails before dispatch when a listed grant or exact request changes", async () => {
    const local = runtime();
    let granted = ["/synthetic"];
    local.discover = vi.fn(async () => { granted = []; return [descriptor]; });
    const handle = randomUUID();
    await expect(scope.run({ db, handle, sentence: "Read one file",
      folders: ["/synthetic"], owner, workspacePath, assertOwner: () => undefined,
      grantedFolders: () => granted, runtime: local })).rejects.toThrow(/folder grant changed/);
    expect(local.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_request").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT event FROM workstation_local_brief_receipt
      WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1`).get(handle))
      .toEqual({ event: "failed" });
  });

  it("fails closed on a missing or malformed exact snapshot at restart", async () => {
    const local = runtime();
    const handle = randomUUID();
    await scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local });
    db.prepare("DELETE FROM workstation_local_brief_request WHERE attempt_id = ?").run(handle);
    expect(() => new LocalBriefDraftScope().recover(db)).toThrow(/receipts disagree/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM workstation_local_brief_receipt
      WHERE attempt_id = ? AND event = 'interrupted'`).get(handle)).toEqual({ count: 0 });
  });

  it("adds the preparatory tables to synthetic V15 without changing existing Case data", () => {
    const old = new DatabaseSync(":memory:");
    try {
      old.exec("PRAGMA foreign_keys = ON");
      for (const migration of MIGRATIONS.filter((one) => one.version <= 15)) old.exec(migration.sql);
      const caseId = openCase(old, { title: "Existing", question: "Keep this" });
      appendTurn(old, caseId, { seat: "owner", kind: "verbatim", body: "Existing private text" });
      const before = turnsFor(old, caseId);
      const next = MIGRATIONS.find((one) => one.version === 16)!;
      old.exec(next.sql);
      expect(turnsFor(old, caseId)).toEqual(before);
      expect(old.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_attempt").get())
        .toEqual({ count: 0 });
    } finally { old.close(); }
  });

  it("refuses new admission at the bounded projectless history limit", () => {
    db.exec(`WITH RECURSIVE numbers(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ${MAX_LOCAL_BRIEF_ATTEMPTS}
    ) INSERT INTO workstation_local_brief_attempt
      (id, input_json, input_sha256, created_at)
      SELECT 'seed-' || n, '{"sentence":"x","folders":[]}',
        '${"0".repeat(64)}', 1 FROM numbers`);
    expect(() => scope.run({ db, handle: randomUUID(), sentence: "Read one file",
      folders: [], owner, workspacePath, assertOwner: () => undefined,
      grantedFolders: () => [], runtime: runtime() }))
      .toThrow(/history exceeds admission bound/);
  });

  it("reserves an active session during draft and releases it upon completion", async () => {
    const local = runtime();
    let completeChat!: (reply: LocalChatResult) => void;
    let sentRequest!: LocalChatRequest;
    local.chat = vi.fn((request) => {
      sentRequest = request;
      return new Promise<LocalChatResult>((resolve) => {
        completeChat = resolve;
      });
    });
    const handle = randomUUID();
    expect(scope.sessions()).toEqual([]);

    const pending = scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local });

    await vi.waitFor(() => expect(local.chat).toHaveBeenCalled(), { timeout: 500 });
    const reserved = scope.sessions();
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({
      operationId: handle,
      caseId: "agent-brief",
      providerId: "bundled-local",
      workspacePath,
      owner
    });
    expect(typeof reserved[0]?.startedAt).toBe("number");

    expect(() => scope.run({ db, handle: randomUUID(), sentence: "Another file", folders: [],
      owner, workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local }))
      .toThrow(/already running/);

    completeChat(answer(sentRequest));
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(scope.sessions()).toEqual([]);
  });

  it("rejects forgetting history when provided review digest is stale or mismatched", async () => {
    const handle1 = randomUUID();
    await scope.run({ db, handle: handle1, sentence: "Read one file", folders: ["/synthetic"], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => ["/synthetic"], runtime: runtime() });

    const initialReview = scope.history(db);
    expect(initialReview.count).toBe(1);
    expect(initialReview.unfinished).toBe(0);
    const oldDigest = initialReview.reviewSha256;

    const handle2 = randomUUID();
    await scope.run({ db, handle: handle2, sentence: "Read another file", folders: ["/synthetic"], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => ["/synthetic"], runtime: runtime() });

    expect(() => scope.forget(db, oldDigest)).toThrow(/Draft history changed/);
    expect(scope.history(db).count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_attempt").get())
      .toEqual({ count: 2 });

    const latestReview = scope.history(db);
    expect(latestReview.count).toBe(2);
    expect(latestReview.reviewSha256).not.toBe(oldDigest);
    expect(scope.forget(db, latestReview.reviewSha256)).toEqual({ removed: 2 });
    expect(scope.history(db).count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_attempt").get())
      .toEqual({ count: 0 });
  });

  it("refuses to forget history while a brief draft is actively running", async () => {
    const local = runtime();
    let completeChat!: (reply: LocalChatResult) => void;
    let sentRequest!: LocalChatRequest;
    local.chat = vi.fn((request) => {
      sentRequest = request;
      return new Promise<LocalChatResult>((resolve) => { completeChat = resolve; });
    });
    const handle = randomUUID();
    const pending = scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local });

    await vi.waitFor(() => expect(local.chat).toHaveBeenCalled(), { timeout: 500 });
    expect(() => scope.forget(db, "0".repeat(64))).toThrow(/Stop the active brief before forgetting/);

    completeChat(answer(sentRequest));
    await pending;
  });

  it("erases draft history with cascade while preserving unrelated Case turns", async () => {
    const caseId = openCase(db, { title: "Unrelated Case", question: "Keep this turn" });
    appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Private case note" });
    const beforeTurns = turnsFor(db, caseId);

    const handle = randomUUID();
    await scope.run({ db, handle, sentence: "Read one file", folders: ["/synthetic"], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => ["/synthetic"], runtime: runtime() });

    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_attempt").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_request").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_receipt").get())
      .toEqual({ count: 3 });

    const review = scope.history(db);
    expect(review.count).toBe(1);

    const result = scope.forget(db, review.reviewSha256);
    expect(result).toEqual({ removed: 1 });

    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_attempt").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_request").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM workstation_local_brief_receipt").get())
      .toEqual({ count: 0 });
    expect(turnsFor(db, caseId)).toEqual(beforeTurns);
  });

  it("admits a new brief draft after forgetting previous history", async () => {
    const handle1 = randomUUID();
    await scope.run({ db, handle: handle1, sentence: "First brief", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: runtime() });

    const review = scope.history(db);
    expect(scope.forget(db, review.reviewSha256)).toEqual({ removed: 1 });
    expect(scope.history(db).count).toBe(0);

    const handle2 = randomUUID();
    const result = await scope.run({ db, handle: handle2, sentence: "Second brief", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: runtime() });
    expect(result.ok).toBe(true);
    expect(scope.history(db).count).toBe(1);
    expect(db.prepare(`SELECT sequence, event FROM workstation_local_brief_receipt
      WHERE attempt_id = ? ORDER BY sequence`).all(handle2)).toEqual([
      { sequence: 1, event: "admitted" },
      { sequence: 2, event: "dispatch_attempt" },
      { sequence: 3, event: "completed" }
    ]);
  });

  it("rejects late completion and preserves interrupted receipt when another scope recovers mid-flight", async () => {
    const local = runtime();
    let completeChat!: (reply: LocalChatResult) => void;
    let sentRequest!: LocalChatRequest;
    local.chat = vi.fn((request) => {
      sentRequest = request;
      return new Promise<LocalChatResult>((resolve) => {
        completeChat = resolve;
      });
    });
    const handle = randomUUID();
    const pending = scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: local });

    await vi.waitFor(() => expect(local.chat).toHaveBeenCalled(), { timeout: 500 });

    const otherScope = new LocalBriefDraftScope();
    expect(otherScope.recover(db)).toBe(1);

    completeChat(answer(sentRequest));
    await expect(pending).rejects.toThrow(/already terminal/);

    const receipts = db.prepare(`SELECT sequence, event FROM workstation_local_brief_receipt
      WHERE attempt_id = ? ORDER BY sequence`).all(handle) as Array<{ sequence: number; event: string }>;
    expect(receipts).toEqual([
      { sequence: 1, event: "admitted" },
      { sequence: 2, event: "dispatch_attempt" },
      { sequence: 3, event: "interrupted" }
    ]);
    const terminalReceipts = receipts.filter((r) => ["completed", "failed", "interrupted"].includes(r.event));
    expect(terminalReceipts).toHaveLength(1);
  });

  it("returns stopped: false when Stop is called after completion", async () => {
    const handle = randomUUID();
    const result = await scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner: () => undefined, grantedFolders: () => [], runtime: runtime() });
    expect(result.ok).toBe(true);
    expect(scope.stop(handle, owner)).toEqual({ stopped: false });
  });

  it("rechecks AbortSignal after owner callback and interrupts rather than completing", async () => {
    const handle = randomUUID();
    let assertOwnerCount = 0;
    const assertOwner = () => {
      assertOwnerCount += 1;
      if (assertOwnerCount > 1) {
        scope.stop(handle, owner);
      }
    };

    await expect(scope.run({ db, handle, sentence: "Read one file", folders: [], owner,
      workspacePath, assertOwner, grantedFolders: () => [], runtime: runtime() }))
      .rejects.toThrow();

    expect(db.prepare(`SELECT event FROM workstation_local_brief_receipt
      WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1`).get(handle))
      .toEqual({ event: "interrupted" });
  });
});
