import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENQUIRY_PROPOSAL_SEAT, type LocalChatRequest, type LocalChatResult,
  type RuntimeDescriptor } from "@cadrane/contracts";
import { appendTurn, closeCase, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { LocalWorkroom, type LocalWorkroomDeps } from "../workroom/local.js";
import { readContextSnapshot } from "./context-snapshot-store.js";
import { assignWorkstationProject, saveWorkstationProject } from "./projects.js";
import { LocalCaseRunScope } from "./local-case-run-scope.js";
import { admit } from "./session-pool.js";

const runtime: RuntimeDescriptor = {
  id: "cadrane-local-loopback", kind: "lm-studio", name: "Bundled",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  detail: "Synthetic", checkedAt: "2026-09-24T00:00:00.000Z",
  models: [{ id: "qwen", displayName: "Qwen", loaded: true, sizeBytes: null }]
};

let db: DatabaseSync;
let caseId: string;
let room: LocalWorkroom;
let scope: LocalCaseRunScope;
const owner = {};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  caseId = openCase(db, { title: "Local draft", question: "Draft from notes" });
  room = new LocalWorkroom();
  scope = new LocalCaseRunScope();
});
afterEach(() => db.close());

function result(input: LocalChatRequest, content = "Grounded draft"): LocalChatResult {
  return { operationId: input.operationId, runtimeId: input.runtimeId,
    modelId: input.modelId, content, localOnly: true,
    startedAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:00:01.000Z" };
}

function run(input: {
  operationId?: string; sourceTurnIds?: string[]; chat?: LocalWorkroomDeps["chat"];
  discover?: LocalWorkroomDeps["discover"]; cancel?: LocalWorkroomDeps["cancel"];
  currentOwner?: object;
} = {}) {
  const operationId = input.operationId ?? randomUUID();
  const request = {
    id: caseId, operationId, modelId: "qwen",
    question: "Draft from these notes", sourceTurnIds: input.sourceTurnIds ?? []
  };
  const deps: LocalWorkroomDeps = {
    discover: input.discover ?? (async () => [runtime]),
    chat: input.chat ?? (async (packet) => result(packet)),
    cancel: input.cancel ?? (async () => undefined)
  };
  return { operationId, promise: scope.run({
    kind: "case-draft", db, caseId, operationId, modelId: "qwen", sourceTurnIds: request.sourceTurnIds,
    workspacePath: `/private/tmp/rellane-local-${caseId}`, owner: input.currentOwner ?? owner,
    stop: () => room.stop(caseId, operationId, deps),
    work: (hooks) => room.run(db, request, deps, hooks)
  }) };
}

function structured() {
  return turnsFor(db, caseId).filter((turn) => turn.seat === "workstation-local-run")
    .map((turn) => JSON.parse(turn.body) as { kind: string; event: string; operationId: string;
      contextSnapshotId: string; requestHash: string; answerTurnId: string | null });
}

const enquirySuggestion = { scope: "one_job", fields: {
  item: "business cards", quantities: null, dimensions: null, printing: null,
  stock: null, finish: null, fulfilment: null, timing: null,
  destination: null, artwork: null, invoice: null, changes: null, other: null
} };

function runEnquiry(sourceTurnId: string, overrides: {
  chat?: LocalWorkroomDeps["chat"]; cancel?: LocalWorkroomDeps["cancel"];
} = {}) {
  const operationId = randomUUID();
  const request = { id: caseId, operationId, modelId: "qwen", sourceTurnId };
  const deps: LocalWorkroomDeps = {
    discover: async () => [runtime],
    chat: overrides.chat ?? (async (packet) => result(packet, JSON.stringify(enquirySuggestion))),
    cancel: overrides.cancel ?? (async () => undefined)
  };
  return { operationId, promise: scope.run({
    kind: "print-enquiry", db, caseId, operationId, modelId: "qwen",
    sourceTurnIds: [sourceTurnId], workspacePath: `/private/tmp/rellane-local-${caseId}`,
    owner, stop: () => room.stop(caseId, operationId, deps),
    work: (hooks) => room.prepareEnquiry(db, request, deps, hooks)
  }) };
}

describe("Host-owned bundled Case scope", () => {
  it("keeps the Enquiry profile and one original source in the exact snapshot and saves only a reviewable suggestion", async () => {
    const source = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Please print business cards." });
    appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "PRIVATE_OTHER_ENQUIRY" });
    let sent: LocalChatRequest | null = null;
    const call = runEnquiry(source, { chat: async (packet) => {
      sent = packet;
      expect(structured().map((entry) => entry.event)).toEqual(["start"]);
      return result(packet, JSON.stringify(enquirySuggestion));
    } });
    await call.promise;
    expect(sent).toMatchObject({ responseProfile: "print-enquiry-v1" });
    const [start, finish] = structured();
    expect([start?.kind, finish?.kind]).toEqual(["print-enquiry", "print-enquiry"]);
    expect([start?.event, finish?.event]).toEqual(["start", "completed"]);
    const snapshot = readContextSnapshot(db, start!.contextSnapshotId, caseId, null);
    expect(snapshot?.packet).toBe(JSON.stringify(sent));
    expect(snapshot?.packet).toContain(source);
    expect(snapshot?.packet).not.toContain("PRIVATE_OTHER_ENQUIRY");
    expect(turnsFor(db, caseId).find((turn) => turn.id === finish?.answerTurnId))
      .toMatchObject({ seat: ENQUIRY_PROPOSAL_SEAT, kind: "finding" });
    expect(turnsFor(db, caseId).some((turn) => turn.seat === "Source · Checked data")).toBe(false);
  });

  it("discards a late Enquiry suggestion after owner Stop", async () => {
    const source = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Please print business cards." });
    const gate: { release?: () => void } = {};
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    const call = runEnquiry(source, { chat: (packet) => new Promise((resolve) => {
      gate.release = () => resolve(result(packet, JSON.stringify(enquirySuggestion)));
      entered();
    }) });
    await dispatched;
    expect(scope.current(caseId, owner)?.operationId).toBe(call.operationId);
    await scope.stop(caseId, call.operationId, owner);
    gate.release?.();
    await expect(call.promise).rejects.toThrow(/late answer/u);
    expect(structured().map((entry) => entry.event)).toEqual(["start", "interrupted"]);
    expect(turnsFor(db, caseId).some((turn) => turn.seat === ENQUIRY_PROPOSAL_SEAT)).toBe(false);
  });

  it("does not dispatch a Case draft as an Enquiry without the Enquiry response profile", async () => {
    const source = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Please print business cards." });
    const operationId = randomUUID();
    let dispatches = 0;
    const deps: LocalWorkroomDeps = {
      discover: async () => [runtime],
      chat: async (packet) => { dispatches += 1; return result(packet); },
      cancel: async () => undefined
    };
    await expect(scope.run({
      kind: "print-enquiry", db, caseId, operationId, modelId: "qwen",
      sourceTurnIds: [source], workspacePath: `/private/tmp/rellane-local-${caseId}`,
      owner, stop: () => room.stop(caseId, operationId, deps),
      work: (hooks) => room.run(db, {
        id: caseId, operationId, modelId: "qwen", sourceTurnIds: [source], question: "Draft"
      }, deps, hooks)
    })).rejects.toThrow(/admitted scope/u);
    expect(dispatches).toBe(0);
    expect(structured()).toEqual([]);
  });
  it("saves the exact selected local request before dispatch and completes beside the answer", async () => {
    const source = appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "Use ceramic, 24 cm." });
    appendTurn(db, caseId, { seat: "owner", kind: "verbatim", body: "PRIVATE_UNSELECTED" });
    let sent: LocalChatRequest | null = null;
    const call = run({ sourceTurnIds: [source], chat: async (packet) => {
      sent = packet;
      const start = structured();
      expect(start.map((entry) => entry.event)).toEqual(["start"]);
      expect(readContextSnapshot(db, start[0]!.contextSnapshotId, caseId, null)?.dispatchAttemptedAt).not.toBeNull();
      return result(packet);
    } });
    await call.promise;
    expect(sent).not.toBeNull();
    const [start, finish] = structured();
    expect([start?.event, finish?.event]).toEqual(["start", "completed"]);
    expect(finish?.answerTurnId).toBeTruthy();
    expect(start?.requestHash).toBe(createHash("sha256").update(JSON.stringify(sent)).digest("hex"));
    const snapshot = readContextSnapshot(db, start!.contextSnapshotId, caseId, null);
    expect(snapshot?.packet).toBe(JSON.stringify(sent));
    expect(snapshot?.packet).toContain(source);
    expect(snapshot?.packet).not.toContain("PRIVATE_UNSELECTED");
    expect(turnsFor(db, caseId).find((turn) => turn.id === finish?.answerTurnId)?.body).toBe("Grounded draft");
    expect(scope.current(caseId, owner)).toBeNull();
  });

  it("binds state and Stop to the owner, blocks another lane, and discards a late answer", async () => {
    const gate: { release?: () => void } = {};
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    const cancelled: string[] = [];
    const call = run({ chat: (packet) => new Promise((resolve) => {
      gate.release = () => resolve(result(packet, "LATE_ANSWER"));
      entered();
    }), cancel: async (id) => { cancelled.push(id); } });
    await dispatched;
    expect(scope.current(caseId, owner)).toEqual({ operationId: call.operationId, stopping: false });
    expect(() => scope.current(caseId, {})).toThrow(/another window/u);
    await expect(scope.stop(caseId, call.operationId, {})).rejects.toThrow(/another window/u);
    expect(admit(scope.sessions(), {
      caseId, providerId: "codex", workspacePath: `/private/tmp/rellane-local-${caseId}`,
      owner: {}
    }, Date.now()).allowed).toBe(false);
    expect(await scope.stop(caseId, randomUUID(), owner)).toEqual({ stopped: false });
    expect(await scope.stop(caseId, call.operationId, owner)).toEqual({ stopped: true });
    expect(scope.current(caseId, owner)?.stopping).toBe(true);
    gate.release?.();
    await expect(call.promise).rejects.toThrow(/late answer/u);
    expect(cancelled).toContain(call.operationId);
    expect(structured().map((entry) => entry.event)).toEqual(["start", "interrupted"]);
    expect(turnsFor(db, caseId).some((turn) => turn.body === "LATE_ANSWER")).toBe(false);
  });

  it("revokes owner authority during discovery before any local packet is sent", async () => {
    const gate: { release?: (value: readonly RuntimeDescriptor[]) => void } = {};
    const discover = new Promise<readonly RuntimeDescriptor[]>((resolve) => { gate.release = resolve; });
    let dispatches = 0;
    const call = run({ discover: () => discover,
      chat: async (packet) => { dispatches += 1; return result(packet); } });
    await Promise.resolve();
    scope.invalidate(owner);
    gate.release?.([runtime]);
    await expect(call.promise).rejects.toThrow(/Stopped/u);
    expect(dispatches).toBe(0);
    expect(structured()).toEqual([]);
    expect(scope.sessions()).toHaveLength(0);
  });

  it("declines dispatch if its exact snapshot cannot be saved", async () => {
    db.exec(`CREATE TRIGGER block_local_context BEFORE INSERT ON workstation_context_snapshot
      WHEN NEW.provider_id = 'bundled-local' BEGIN SELECT RAISE(ABORT, 'blocked snapshot'); END`);
    let dispatches = 0;
    const call = run({ chat: async (packet) => { dispatches += 1; return result(packet); } });
    await expect(call.promise).rejects.toThrow(/blocked snapshot/u);
    expect(dispatches).toBe(0);
    expect(structured()).toEqual([]);
  });

  it("rolls back the owner's question and readable start when the structured start cannot commit", async () => {
    db.exec(`CREATE TRIGGER block_local_start BEFORE INSERT ON case_turn
      WHEN NEW.seat = 'workstation-local-run' BEGIN SELECT RAISE(ABORT, 'blocked start'); END`);
    let dispatches = 0;
    const call = run({ chat: async (packet) => { dispatches += 1; return result(packet); } });
    await expect(call.promise).rejects.toThrow(/blocked start/u);
    expect(dispatches).toBe(0);
    expect(turnsFor(db, caseId)).toEqual([]);
  });

  it("rolls back an answer if its structured finish cannot commit", async () => {
    db.exec(`CREATE TRIGGER block_local_finish BEFORE INSERT ON case_turn
      WHEN NEW.seat = 'workstation-local-run' AND NEW.body LIKE '%\"event\":\"completed\"%'
      BEGIN SELECT RAISE(ABORT, 'blocked finish'); END`);
    const call = run();
    await expect(call.promise).rejects.toThrow(/blocked finish/u);
    expect(structured().map((entry) => entry.event)).toEqual(["start", "interrupted"]);
    expect(turnsFor(db, caseId).some((turn) => turn.body === "Grounded draft")).toBe(false);
  });

  it("refuses a late answer after its Case or project scope changes", async () => {
    const changedProject = saveWorkstationProject(db, { title: "New project", brief: "Brief" });
    const projectCall = run({ chat: async (packet) => {
      assignWorkstationProject(db, { caseId, projectId: changedProject.id });
      return result(packet, "WRONG_PROJECT_ANSWER");
    } });
    await expect(projectCall.promise).rejects.toThrow(/changed|scope/u);
    expect(turnsFor(db, caseId).some((turn) => turn.body === "WRONG_PROJECT_ANSWER")).toBe(false);
    expect(structured().map((entry) => entry.event)).toEqual(["start", "interrupted"]);

    const nextCase = openCase(db, { title: "Close during work", question: "Question" });
    caseId = nextCase;
    const closedCall = run({ chat: async (packet) => {
      closeCase(db, caseId, { closedAs: "abandoned", verdict: "Closed while testing" });
      return result(packet, "CLOSED_CASE_ANSWER");
    } });
    await expect(closedCall.promise).rejects.toThrow(/closed/u);
    expect(turnsFor(db, nextCase).some((turn) => turn.body === "CLOSED_CASE_ANSWER")).toBe(false);
  });

  it("settles an unmatched start once on restart without replaying the model", () => {
    const operationId = randomUUID();
    const snapshotId = randomUUID();
    appendTurn(db, caseId, { seat: "workstation-local-run", kind: "receipt", body: JSON.stringify({
      version: 1, kind: "case-draft", event: "start", caseId, operationId,
      modelId: "qwen", contextSnapshotId: snapshotId, requestHash: "a".repeat(64),
      sourceTurnIds: [], answerTurnId: null, at: 1
    }) });
    const restarted = new LocalCaseRunScope();
    expect(restarted.recover(db)).toBe(1);
    expect(restarted.recover(db)).toBe(0);
    expect(structured().map((entry) => entry.event)).toEqual(["start", "interrupted"]);
  });

  it("settles an unfinished Enquiry as interrupted without manufacturing a suggestion", () => {
    const operationId = randomUUID();
    appendTurn(db, caseId, { seat: "workstation-local-run", kind: "receipt", body: JSON.stringify({
      version: 1, kind: "print-enquiry", event: "start", caseId, operationId,
      modelId: "qwen", contextSnapshotId: randomUUID(), requestHash: "b".repeat(64),
      sourceTurnIds: [randomUUID()], answerTurnId: null, at: 1
    }) });
    expect(new LocalCaseRunScope().recover(db)).toBe(1);
    expect(structured().map((entry) => [entry.kind, entry.event]))
      .toEqual([["print-enquiry", "start"], ["print-enquiry", "interrupted"]]);
    expect(turnsFor(db, caseId).some((turn) => turn.seat === ENQUIRY_PROPOSAL_SEAT)).toBe(false);
  });

  it("pauses recovery on malformed local evidence rather than silently skipping it", () => {
    appendTurn(db, caseId, { seat: "workstation-local-run", kind: "receipt", body: "{bad" });
    const restarted = new LocalCaseRunScope();
    expect(() => restarted.recover(db)).toThrow(/malformed/u);
    expect(() => restarted.recover(db)).toThrow(/malformed/u);
  });

  it("rejects a terminal receipt that names a different request snapshot", () => {
    const operationId = randomUUID();
    const base = { version: 1, kind: "case-draft", caseId, operationId,
      modelId: "qwen", requestHash: "a".repeat(64), sourceTurnIds: [], answerTurnId: null, at: 1 };
    appendTurn(db, caseId, { seat: "workstation-local-run", kind: "receipt",
      body: JSON.stringify({ ...base, event: "start", contextSnapshotId: randomUUID() }) });
    appendTurn(db, caseId, { seat: "workstation-local-run", kind: "receipt",
      body: JSON.stringify({ ...base, event: "interrupted", contextSnapshotId: randomUUID() }) });
    expect(() => new LocalCaseRunScope().recover(db)).toThrow(/inconsistent/u);
  });
});
