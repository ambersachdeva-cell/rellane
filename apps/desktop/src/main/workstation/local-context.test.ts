/** Context assistance is local, cancellable and grounded in unchanged source rows. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { MIGRATIONS } from "../book/schema.js";
import { appendTurn, openCase, turnsFor } from "../book/cases.js";
import type { LocalWorkroomDeps } from "../workroom/local.js";
import { suggestLocalContext } from "./local-context.js";

const descriptor: RuntimeDescriptor = { id: "cadrane-local-loopback", name: "Local", kind: "lm-studio", baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  models: [{ id: "fixture-model", displayName: "Fixture", loaded: true, sizeBytes: 100 }], detail: "Ready", checkedAt: "2026-09-14T00:00:00Z" };
const reply = (request: LocalChatRequest, content = '{"relevant":[1]}'): LocalChatResult => ({ ...request, content, localOnly: true, startedAt: "2026-09-14T00:00:00Z", finishedAt: "2026-09-14T00:00:01Z" });
let db: DatabaseSync;
let caseId: string;
let sourceId: string;
let runtime: LocalWorkroomDeps;
const input = () => ({ caseId, handle: randomUUID(), question: "When is delivery?", sourceTurnIds: [sourceId] });
const run = (signal = new AbortController().signal, check = () => {}) => suggestLocalContext(db, input(), runtime, signal, check);
beforeEach(() => {
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  caseId = openCase(db, { title: "Fixture", question: "Review a job" });
  sourceId = appendTurn(db, caseId, { seat: `${CASE_SOURCE_SEAT_PREFIX}Production brief`, kind: "verbatim", body: "Delivery is 24 September. Owner Mira." });
  runtime = { discover: vi.fn(async () => [descriptor]), chat: vi.fn(async request => reply(request)), cancel: vi.fn(async () => {}) };
});
afterEach(() => db.close());

it("returns only saved source identities without adding a turn or dispatching to another runtime", async () => {
  const before = turnsFor(db, caseId);
  expect(await run()).toMatchObject({ sourceTurnIds: [sourceId], consideredIds: [sourceId], omittedIds: [], excerptedIds: [], modelId: "fixture-model" });
  expect(runtime.chat).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: descriptor.id, modelId: "fixture-model", maxTokens: 256, temperature: 0, responseProfile: "local-draft-v1" }));
  expect(turnsFor(db, caseId)).toEqual(before);
});
it("refuses other-task sources, model messages and renderer-supplied paths before discovery", async () => {
  const other = openCase(db, { title: "Other", question: "Other" });
  const foreign = appendTurn(db, other, { seat: `${CASE_SOURCE_SEAT_PREFIX}Other file`, kind: "verbatim", body: "Private other task" });
  const answer = appendTurn(db, caseId, { seat: "Workstation · Codex", kind: "verbatim", body: "An AI draft is not a saved file." });
  for (const id of [foreign, answer, randomUUID()]) await expect(suggestLocalContext(db, { ...input(), sourceTurnIds: [id] }, runtime, new AbortController().signal, () => {})).rejects.toThrow("saved file");
  await expect(suggestLocalContext(db, { ...input(), path: "/private" } as ReturnType<typeof input>, runtime, new AbortController().signal, () => {})).rejects.toThrow();
  expect(runtime.discover).not.toHaveBeenCalled(); expect(runtime.chat).not.toHaveBeenCalled();
});
it("refuses unavailable or impersonated local discovery without a fallback", async () => {
  for (const value of [{ ...descriptor, models: [] }, { ...descriptor, baseUrl: "http://127.0.0.1:1234" }, { ...descriptor, state: "unavailable" }, { ...descriptor, id: "remote" }]) {
    runtime.discover = async () => [value as RuntimeDescriptor];
    await expect(run()).rejects.toThrow("not ready");
  }
  expect(runtime.chat).not.toHaveBeenCalled();
});
it("discards mismatched, malformed and invented model selections without saving evidence", async () => {
  const before = turnsFor(db, caseId);
  for (const changed of [{ operationId: randomUUID() }, { modelId: "wrong" }, { runtimeId: "wrong" }]) {
    runtime.chat = async request => ({ ...reply(request), ...changed });
    await expect(run()).rejects.toThrow("did not match");
  }
  for (const content of ['{"relevant":[999]}', '{"relevant":[1],"send":true}', "I picked all your files"]) {
    runtime.chat = async request => reply(request, content);
    await expect(run()).rejects.toThrow("usable file selection");
  }
  expect(turnsFor(db, caseId)).toEqual(before);
});
it("cancels only its own operation and discards a late answer", async () => {
  const controller = new AbortController();
  let resolve!: (value: LocalChatResult) => void;
  let sent!: LocalChatRequest;
  runtime.chat = vi.fn(request => { sent = request; return new Promise<LocalChatResult>(done => { resolve = done; }); });
  const result = run(controller.signal);
  const rejected = expect(result).rejects.toThrow("Stopped");
  await vi.waitFor(() => expect(runtime.chat).toHaveBeenCalledOnce());
  controller.abort(new Error("Stopped"));
  expect(runtime.cancel).toHaveBeenCalledWith(sent.operationId);
  resolve(reply(sent)); await rejected;
  expect(turnsFor(db, caseId)).toHaveLength(1);
});
it("rechecks source content and document ownership after asynchronous work", async () => {
  let valid = true;
  runtime.chat = async request => { valid = false; return reply(request); };
  await expect(run(undefined, () => { if (!valid) throw new Error("Window changed"); })).rejects.toThrow("Window changed");
  runtime.chat = async request => { db.prepare("UPDATE case_turn SET body = ? WHERE id = ?").run("Altered evidence", sourceId); return reply(request); };
  await expect(run()).rejects.toThrow("files changed");
});
