import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { appendTurn, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { readContextSnapshot } from "./context-snapshot-store.js";
import { LocalCaseRunScope } from "./local-case-run-scope.js";
import { suggestLocalContext } from "./local-context.js";

const descriptor: RuntimeDescriptor = { id: "cadrane-local-loopback", name: "Local", kind: "lm-studio",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null, detail: "Ready",
  checkedAt: "2026-09-24T00:00:00Z",
  models: [{ id: "fixture-model", displayName: "Fixture", loaded: true, sizeBytes: 100 }] };
const reply = (request: LocalChatRequest): LocalChatResult => ({ operationId: request.operationId,
  runtimeId: request.runtimeId, modelId: request.modelId, content: '{"relevant":[1]}', localOnly: true,
  startedAt: "2026-09-24T00:00:00Z", finishedAt: "2026-09-24T00:00:01Z" });

let db: DatabaseSync;
let caseId: string;
let selectedId: string;
let scope: LocalCaseRunScope;
const owner = {};
const workspacePath = "/private/tmp/rellane-suggestion-fixture";
const rows = () => turnsFor(db, caseId).filter((turn) => turn.seat === "workstation-local-context-suggestion")
  .map((turn) => JSON.parse(turn.body) as { event: string; contextSnapshotId: string;
    childOperationId: string; requestHash: string; sourceHash: string; selectedSourceTurnIds: string[] | null });

beforeEach(() => {
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  caseId = openCase(db, { title: "Suggestion", question: "Choose saved files" });
  selectedId = appendTurn(db, caseId, { seat: `${CASE_SOURCE_SEAT_PREFIX}Chosen brief`,
    kind: "verbatim", body: "Delivery is 24 September." });
  appendTurn(db, caseId, { seat: `${CASE_SOURCE_SEAT_PREFIX}Other private file`,
    kind: "verbatim", body: "PRIVATE_UNSELECTED_CONTENT" });
  scope = new LocalCaseRunScope();
});
afterEach(() => db.close());

function run(input: { sourceTurnIds?: string[]; chat?: LocalWorkroomDeps["chat"];
  cancel?: LocalWorkroomDeps["cancel"]; signal?: AbortSignal; check?: () => void } = {}) {
  const request = { caseId, handle: randomUUID(), question: "When is delivery?",
    sourceTurnIds: input.sourceTurnIds ?? [selectedId] };
  const runtime: LocalWorkroomDeps = { discover: async () => [descriptor],
    chat: input.chat ?? (async (packet) => reply(packet)),
    cancel: input.cancel ?? (async () => undefined) };
  return { request, promise: scope.runSuggestion({ db, request, owner, workspacePath,
    signal: input.signal ?? new AbortController().signal,
    work: (hooks, signal) => suggestLocalContext(db, request, runtime, signal, input.check ?? (() => {}), hooks) }) };
}

it("stores the exact selected local request and a separate completion receipt, without a conversation turn", async () => {
  let sent: LocalChatRequest | null = null;
  const runCall = run({ chat: async (request) => {
    sent = request;
    expect(rows().map((row) => row.event)).toEqual(["start"]);
    return reply(request);
  } });
  expect(await runCall.promise).toMatchObject({ sourceTurnIds: [selectedId], consideredIds: [selectedId] });
  const [start, finish] = rows();
  expect([start?.event, finish?.event]).toEqual(["start", "completed"]);
  expect(finish?.selectedSourceTurnIds).toEqual([selectedId]);
  expect(start?.requestHash).toBe(createHash("sha256").update(JSON.stringify(sent)).digest("hex"));
  const snapshot = readContextSnapshot(db, start!.contextSnapshotId, caseId, null);
  expect(snapshot?.packet).toBe(JSON.stringify(sent));
  expect(snapshot?.packet).not.toContain("PRIVATE_UNSELECTED_CONTENT");
  expect(snapshot?.dispatchAttemptedAt).not.toBeNull();
  expect(turnsFor(db, caseId).filter((turn) => turn.kind === "verbatim")).toHaveLength(2);
  expect(scope.sessions()).toHaveLength(0);
});

it("refuses a foreign selected source before discovery or dispatch and records no false start", async () => {
  const foreignCase = openCase(db, { title: "Foreign", question: "Private" });
  const foreign = appendTurn(db, foreignCase, { seat: `${CASE_SOURCE_SEAT_PREFIX}Foreign`,
    kind: "verbatim", body: "Do not disclose" });
  const chat = vi.fn(async (request: LocalChatRequest) => reply(request));
  await expect(run({ sourceTurnIds: [foreign], chat }).promise).rejects.toThrow("saved file");
  expect(chat).not.toHaveBeenCalled();
  expect(rows()).toEqual([]);
});

it("keeps Stop owner-bound, cancels the exact child, and rejects a late answer", async () => {
  let release!: (value: LocalChatResult) => void;
  let sent!: LocalChatRequest;
  const cancel = vi.fn(async () => undefined);
  const call = run({ cancel, chat: (request) => {
    sent = request;
    return new Promise((resolve) => { release = resolve; });
  } });
  await vi.waitFor(() => expect(sent).toBeDefined());
  expect(() => scope.stopSuggestion(call.request.handle, {})).toThrow("another window");
  expect(scope.sessions()).toHaveLength(1);
  expect(scope.stopSuggestion(call.request.handle, owner)).toEqual({ stopped: true });
  expect(rows().map((row) => row.event)).toEqual(["start"]);
  release(reply(sent));
  await expect(call.promise).rejects.toThrow("Stopped");
  expect(cancel).toHaveBeenCalledWith(sent.operationId);
  expect(rows().map((row) => row.event)).toEqual(["start", "interrupted"]);
  expect(rows()[1]?.selectedSourceTurnIds).toBeNull();
});

it("refuses a late answer after selected source or owner changes", async () => {
  await expect(run({ chat: async (request) => {
    db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run("Changed source", selectedId);
    return reply(request);
  } }).promise).rejects.toThrow("files changed");
  expect(rows().map((row) => row.event)).toEqual(["start", "interrupted"]);
  let current = true;
  await expect(run({ check: () => { if (!current) throw new Error("Owner changed"); },
    chat: async (request) => { current = false; return reply(request); } }).promise).rejects.toThrow("Owner changed");
  expect(rows().map((row) => row.event)).toEqual(["start", "interrupted", "start", "interrupted"]);
});

it("marks an unfinished attempt interrupted once after restart without replaying model work", async () => {
  const chat = vi.fn(() => new Promise<LocalChatResult>(() => {}));
  run({ chat });
  await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
  expect(rows().map((row) => row.event)).toEqual(["start"]);
  const restarted = new LocalCaseRunScope();
  expect(restarted.recover(db)).toBe(1);
  expect(restarted.recover(db)).toBe(0);
  expect(rows().map((row) => row.event)).toEqual(["start", "interrupted"]);
  expect(chat).toHaveBeenCalledOnce();
});

it("invalidates the Host owner and refuses the late result after navigation", async () => {
  let release!: (value: LocalChatResult) => void;
  let sent!: LocalChatRequest;
  const call = run({ chat: (request) => {
    sent = request;
    return new Promise((resolve) => { release = resolve; });
  } });
  await vi.waitFor(() => expect(sent).toBeDefined());
  scope.invalidate(owner);
  release(reply(sent));
  await expect(call.promise).rejects.toThrow("Stopped");
  expect(rows().map((row) => row.event)).toEqual(["start", "interrupted"]);
});

it("fails closed on malformed suggestion recovery evidence", () => {
  appendTurn(db, caseId, { seat: "workstation-local-context-suggestion", kind: "receipt",
    body: '{"kind":"context-suggestion","event":"completed"}' });
  expect(() => scope.recover(db)).toThrow("wrong scope");
  expect(rows()).toHaveLength(1);
});
