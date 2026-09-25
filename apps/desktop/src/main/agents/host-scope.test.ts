import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import { allCases, appendTurn, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { readContextSnapshot } from "../workstation/context-snapshot-store.js";
import { LocalCaseRunScope } from "../workstation/local-case-run-scope.js";
import { createSandbox, type Sandbox } from "../tools/sandbox.js";
import { consumeAgentSource, createAgentSourceState, previewAgentSource } from "./sources.js";
import { runAgentById, stopAgent } from "./service.js";
import type { Ceiling } from "./brief.js";
import type { RunProgress } from "./run.js";

const external = vi.hoisted(() => ({ ask: vi.fn(), discover: vi.fn() }));
vi.mock("./ask.js", () => ({ askEngine: external.ask }));
vi.mock("../subscription-brain/engine-room.js", () => ({ readEngineRoom: external.discover }));

const descriptor: RuntimeDescriptor = {
  id: "cadrane-local-loopback", kind: "lm-studio", name: "Bundled",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  detail: "Synthetic", checkedAt: "2026-09-24T00:00:00.000Z",
  models: [{ id: "observed-model", displayName: "Observed model", loaded: true, sizeBytes: null }]
};

let root: string;
let db: DatabaseSync;
let sandbox: Sandbox;
let ceiling: Ceiling;
let scope: LocalCaseRunScope;
const owner = {};
const sourceText = "Synthetic request: 240 invitations; artwork NOT approved.";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rellane-agent-host-")));
  await writeFile(join(root, "source.txt"), sourceText);
  await writeFile(join(root, "tool.txt"), "Tool-only fact: pickup on Tuesday.");
  sandbox = await createSandbox([root]);
  ceiling = { grantedFolders: [root], availableCapabilities: ["read_text"],
    storedAgents: [{ id: "reader", name: "Local reader", purpose: "Read selected work",
      folders: [root], capabilities: ["read_text"], tier: "on-device", outbound: "never" }] };
  db = new DatabaseSync(join(root, "book.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  scope = new LocalCaseRunScope();
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
  expect(external.ask).not.toHaveBeenCalled();
  expect(external.discover).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

function response(request: LocalChatRequest, content: string): LocalChatResult {
  return { operationId: request.operationId, runtimeId: request.runtimeId,
    modelId: request.modelId, localOnly: true, content,
    startedAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:00:01.000Z" };
}

async function fixture(chat: (request: LocalChatRequest) => Promise<LocalChatResult>) {
  const state = createAgentSourceState();
  const sourceHost = { currentCeiling: async () => ceiling, currentGrant: () => sandbox };
  const preview = await previewAgentSource(state, owner, "reader", sourceHost,
    async () => join(root, "source.txt"));
  const requiredSource = consumeAgentSource(state, owner, "reader", preview!.token, ceiling, sourceHost);
  const sent: LocalChatRequest[] = [];
  const cancelled: string[] = [];
  const runtime = {
    discover: async () => [descriptor],
    chat: async (request: LocalChatRequest) => { sent.push(request); return chat(request); },
    cancel: async (id: string) => { cancelled.push(id); },
    currentCeiling: async () => ceiling,
    requiredSource
  };
  const run = (progress?: (update: RunProgress) => void) => scope.runAgent({
    db, agentId: "reader", owner, workspacePath: join(root, "agent-private"),
    stop: () => stopAgent("reader"),
    work: (hooks) => runAgentById("reader", "Read the source and tool file.", ceiling,
      undefined, db, progress, runtime, hooks)
  });
  return { run, sent, cancelled };
}

function agentRows(caseId: string) {
  return turnsFor(db, caseId).filter((turn) => turn.seat === "workstation-local-agent-run")
    .map((turn) => JSON.parse(turn.body) as { event: string; attemptId: string;
      childOperationId: string | null; contextSnapshotId: string | null;
      requestHash: string | null; requiredSourceTurnId: string | null;
      answerTurnId: string | null });
}

describe.runIf(process.platform === "darwin")("Host-owned legacy Agent scope", () => {
  it("links two exact changing model packets and a granted file read to one outer attempt", async () => {
    const fixtureRun = await fixture(async (request) => {
      const index = fixtureRun.sent.length;
      return response(request, index === 1
        ? `Looking.\nTOOL: read_text {"path": ${JSON.stringify(join(root, "tool.txt"))}}`
        : "The source says 240 invitations, and the tool file says pickup on Tuesday.");
    });
    const result = await fixtureRun.run();
    expect(result.outcome).toBe("answered");
    expect(result.recordProblem).toBeNull();
    expect(fixtureRun.sent).toHaveLength(2);
    expect(fixtureRun.sent[0]?.messages[1]?.content).toContain(sourceText);
    expect(fixtureRun.sent[0]?.messages[1]?.content).not.toContain("pickup on Tuesday");
    expect(fixtureRun.sent[1]?.messages[1]?.content).toContain("pickup on Tuesday");
    expect(result.read).toContain("read tool.txt");
    const caseId = result.workroomId!;
    const rows = agentRows(caseId);
    expect(rows.map((row) => row.event)).toEqual([
      "start", "step-start", "step-completed", "step-start", "step-completed", "answered"
    ]);
    expect(new Set(rows.map((row) => row.attemptId)).size).toBe(1);
    expect(rows[0]?.requiredSourceTurnId).toBeTruthy();
    for (const [index, row] of [rows[1], rows[3]].entries()) {
      expect(row?.childOperationId).toBe(fixtureRun.sent[index]?.operationId);
      const snapshot = readContextSnapshot(db, row!.contextSnapshotId!, caseId, null);
      expect(snapshot?.packet).toBe(JSON.stringify(fixtureRun.sent[index]));
      expect(row?.requestHash).toBe(createHash("sha256")
        .update(JSON.stringify(fixtureRun.sent[index])).digest("hex"));
      expect(snapshot?.dispatchAttemptedAt).not.toBeNull();
    }
    expect(rows.at(-1)?.answerTurnId).toBeTruthy();
    expect(turnsFor(db, caseId).at(-2)?.body).toContain("read tool.txt");
    expect(new LocalCaseRunScope().recover(db)).toBe(0);
    expect(fixtureRun.sent).toHaveLength(2);
  });

  it("honours a withdrawn grant between steps without asking a second model prompt", async () => {
    const fixtureRun = await fixture(async (request) => response(request,
      `Looking.\nTOOL: read_text {"path": ${JSON.stringify(join(root, "tool.txt"))}}`));
    const result = await fixtureRun.run((update) => {
      if (update.stage === "reading") ceiling = { ...ceiling, availableCapabilities: [] };
    });
    expect(result.outcome).toBe("failed");
    expect(result.answer).toBe("");
    expect(result.read).toContain("read tool.txt");
    expect(fixtureRun.sent).toHaveLength(1);
    expect(agentRows(result.workroomId!).map((row) => row.event)).toEqual([
      "start", "step-start", "step-completed", "failed"
    ]);
  });

  it("binds Stop to the starting owner and cancels only the current child", async () => {
    const gate: { release?: (value: LocalChatResult) => void } = {};
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    const fixtureRun = await fixture((request) => new Promise((resolve) => {
      gate.release = resolve;
      entered();
      void request;
    }));
    const pending = fixtureRun.run();
    await dispatched;
    const sent = fixtureRun.sent[0]!;
    const caseId = allCases(db)[0]!.id;
    expect(() => scope.assertIdle(caseId)).toThrow(/local/u);
    expect(() => scope.stopAgent("reader", {})).toThrow(/another window/u);
    expect(scope.stopAgent("other-agent", owner)).toEqual({ stopped: false });
    expect(scope.stopAgent("reader", owner)).toEqual({ stopped: true });
    gate.release?.(response(sent, "LATE_ANSWER"));
    const result = await pending;
    expect(result.outcome).toBe("stopped");
    expect(result.answer).toBe("");
    expect(fixtureRun.cancelled).toEqual([sent.operationId]);
    expect(agentRows(caseId).map((row) => row.event)).toEqual([
      "start", "step-start", "step-interrupted", "interrupted"
    ]);
    expect(turnsFor(db, caseId).some((turn) => turn.body === "LATE_ANSWER")).toBe(false);
    expect(scope.sessions()).toHaveLength(0);
  });

  it("recovers an unfinished child and outer Agent attempt once without dispatch", () => {
    const caseId = openCase(db, { title: "Interrupted Agent", question: "Question" });
    const attemptId = randomUUID();
    const childOperationId = randomUUID();
    const base = { version: 1, kind: "legacy-agent", caseId, attemptId, agentId: "reader",
      requiredSourceTurnId: null, answerTurnId: null, at: 1 };
    appendTurn(db, caseId, { seat: "workstation-local-agent-run", kind: "receipt",
      body: JSON.stringify({ ...base, event: "start", childOperationId: null,
        stepIndex: null, modelId: null, contextSnapshotId: null, requestHash: null }) });
    appendTurn(db, caseId, { seat: "workstation-local-agent-run", kind: "receipt",
      body: JSON.stringify({ ...base, event: "step-start", childOperationId,
        stepIndex: 1, modelId: "observed-model", contextSnapshotId: randomUUID(),
        requestHash: "a".repeat(64) }) });
    const restarted = new LocalCaseRunScope();
    expect(restarted.recover(db)).toBe(2);
    expect(restarted.recover(db)).toBe(0);
    expect(agentRows(caseId).map((row) => row.event)).toEqual([
      "start", "step-start", "step-interrupted", "interrupted"
    ]);
    expect(turnsFor(db, caseId).some((turn) => turn.kind === "verbatim")).toBe(false);
  });

  it("never asks the daemon when a step's exact context snapshot cannot be saved", async () => {
    db.exec(`CREATE TRIGGER block_agent_snapshot BEFORE INSERT ON workstation_context_snapshot
      WHEN NEW.provider_id = 'bundled-local' BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END`);
    const fixtureRun = await fixture(async (request) => response(request, "Must not reach the daemon"));
    const result = await fixtureRun.run();
    expect(result.outcome).toBe("failed");
    expect(fixtureRun.sent).toEqual([]);
    expect(agentRows(result.workroomId!).map((row) => row.event)).toEqual(["start", "failed"]);
    expect(turnsFor(db, result.workroomId!).some((turn) => turn.body === "Must not reach the daemon"))
      .toBe(false);
  });

  it("rolls back the whole new Case if its Host start receipt cannot commit", async () => {
    db.exec(`CREATE TRIGGER block_agent_start BEFORE INSERT ON case_turn
      WHEN NEW.seat = 'workstation-local-agent-run'
      BEGIN SELECT RAISE(ABORT, 'agent start unavailable'); END`);
    const fixtureRun = await fixture(async (request) => response(request, "Must not reach the daemon"));
    const result = await fixtureRun.run();
    expect(result.outcome).toBe("refused");
    expect(fixtureRun.sent).toEqual([]);
    expect(allCases(db)).toEqual([]);
  });

  it("rolls back the answer when the Host terminal receipt fails, leaving recovery evidence", async () => {
    db.exec(`CREATE TRIGGER block_agent_answer BEFORE INSERT ON case_turn
      WHEN NEW.seat = 'workstation-local-agent-run' AND NEW.body LIKE '%\"event\":\"answered\"%'
      BEGIN SELECT RAISE(ABORT, 'agent answer unavailable'); END`);
    const fixtureRun = await fixture(async (request) => response(request, "Synthetic answer"));
    const result = await fixtureRun.run();
    expect(result.recordProblem).toContain("could not be saved");
    expect(fixtureRun.sent).toHaveLength(1);
    const caseId = result.workroomId!;
    expect(turnsFor(db, caseId).some((turn) => turn.body === "Synthetic answer")).toBe(false);
    expect(agentRows(caseId).map((row) => row.event)).toEqual([
      "start", "step-start", "step-completed"
    ]);
    expect(new LocalCaseRunScope().recover(db)).toBe(1);
    expect(agentRows(caseId).at(-1)?.event).toBe("interrupted");
  });
});
