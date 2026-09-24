import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import { runAgentById, stopAgent, assertAgentWorkroomIdle } from "./service.js";
import type { Ceiling } from "./brief.js";
import { MIGRATIONS } from "../book/schema.js";
import { allCases, readCase, turnsFor } from "../book/cases.js";
import { artifactVersions } from "../workroom/artifacts.js";

const external = vi.hoisted(() => ({ ask: vi.fn(), discover: vi.fn() }));
vi.mock("./ask.js", () => ({ askEngine: external.ask }));
vi.mock("../subscription-brain/engine-room.js", () => ({ readEngineRoom: external.discover }));
const directories: string[] = [];
const databases = new Set<DatabaseSync>();
const descriptor: RuntimeDescriptor = { id: "cadrane-local-loopback", name: "Bundled local", kind: "lm-studio",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  models: [{ id: "observed-model", displayName: "Observed model", loaded: true, sizeBytes: 100 }],
  detail: "Ready", checkedAt: "2026-09-08T00:00:00.000Z" };
const response = (request: LocalChatRequest): LocalChatResult => ({ operationId: request.operationId,
  runtimeId: request.runtimeId, modelId: request.modelId, content: "A synthetic draft to review.", localOnly: true,
  startedAt: "2026-09-08T00:00:00.000Z", finishedAt: "2026-09-08T00:00:01.000Z" });
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "cadrane-agent-history-")); directories.push(folder);
  await writeFile(join(folder, "job.txt"), "Fictional work only.");
  const path = join(folder, "history.sqlite");
  const db = new DatabaseSync(path); databases.add(db); db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const ceiling: Ceiling = { grantedFolders: [folder], availableCapabilities: ["list_folder"],
    storedAgents: [{ id: "reader", name: "Fictional reader", purpose: "Read a listing", folders: [folder],
      capabilities: ["list_folder"], tier: "on-device", outbound: "never" }] };
  const runtime = { discover: vi.fn(async (): Promise<readonly RuntimeDescriptor[]> => [descriptor]),
    chat: vi.fn(async (request: LocalChatRequest) => response(request)), cancel: vi.fn(async (_id: string) => undefined),
    currentCeiling: async () => ceiling };
  const run = () => runAgentById("reader", "Name the fictional file.", ceiling, undefined, db, undefined, runtime);
  return { db, path, ceiling, runtime, run };
}
afterEach(async () => {
  for (const db of databases) db.close(); databases.clear();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  expect(external.ask).not.toHaveBeenCalled(); expect(external.discover).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

describe("live agent history", () => {
  it("persists its start before discovery, finishes before returning and reopens without execution", async () => {
    const { db, path, runtime, run } = await fixture();
    runtime.discover.mockImplementation(async () => {
      const rooms = allCases(db); expect(rooms).toHaveLength(1);
      expect(turnsFor(db, rooms[0]!.id)).toHaveLength(2);
      expect(() => assertAgentWorkroomIdle(rooms[0]!.id)).toThrow("still running");
      expect(() => assertAgentWorkroomIdle("unrelated-room")).not.toThrow();
      return [descriptor];
    });
    const result = await run();
    expect(result.outcome).toBe("answered"); expect(result.recordProblem).toBeNull();
    expect(result.workroomId).toBe(allCases(db)[0]?.id);
    const id = result.workroomId!;
    const before = turnsFor(db, id);
    expect(before).toHaveLength(4); expect(before[2]?.body).toBe(result.answer);
    expect(before[3]?.body).toContain(result.read[0]!);
    expect(() => assertAgentWorkroomIdle(id)).not.toThrow();
    db.close(); databases.delete(db);
    const reopened = new DatabaseSync(path); databases.add(reopened);
    expect(turnsFor(reopened, id)).toEqual(before);
    expect(readCase(reopened, id)?.closedAt).toBeNull();
    expect(artifactVersions(reopened, id)).toEqual([]);
    expect(runtime.discover).toHaveBeenCalledTimes(1); expect(runtime.chat).toHaveBeenCalledTimes(1);
  });

  it("keeps Stop and completed read labels, discards a late answer and blocks duplicate admission", async () => {
    const { db, ceiling, runtime, run } = await fixture();
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let finish!: (value: LocalChatResult) => void; let request!: LocalChatRequest;
    runtime.chat.mockImplementation(sent => { request = sent; enter(); return new Promise(resolve => { finish = resolve; }); });
    const pending = run(); await entered;
    const other = await runAgentById("filing-clerk", "Another request", ceiling, undefined, db, undefined, runtime);
    expect(other.problem).toContain("already running"); expect(allCases(db)).toHaveLength(1);
    const id = allCases(db)[0]!.id;
    expect(() => assertAgentWorkroomIdle(id)).toThrow("still running");
    expect(stopAgent("reader")).toBe(true); finish(response(request));
    const result = await pending;
    expect(result.outcome).toBe("stopped"); expect(result.answer).toBe(""); expect(result.recordProblem).toBeNull();
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(request.operationId);
    const turns = turnsFor(db, id);
    expect(turns).toHaveLength(3); expect(turns[2]?.body).toContain("finished — stopped");
    expect(turns[2]?.body).toContain("used listing");
    expect(turns.some(turn => turn.body === response(request).content)).toBe(false);
    expect(() => assertAgentWorkroomIdle(id)).not.toThrow(); expect(stopAgent("reader")).toBe(false);
  });

  it("does no model work or partial room write if the durable start fails", async () => {
    const { db, runtime, run } = await fixture();
    db.exec("CREATE TEMP TRIGGER reject_start BEFORE INSERT ON case_turn WHEN NEW.seat='agent run' BEGIN SELECT RAISE(FAIL,'write refused'); END");
    const refused = await run();
    expect(refused.outcome).toBe("refused"); expect(refused.problem).toContain("workroom could not be saved");
    expect(runtime.discover).not.toHaveBeenCalled(); expect(runtime.chat).not.toHaveBeenCalled();
    expect(allCases(db)).toHaveLength(0); expect(stopAgent("reader")).toBe(false);
    db.exec("DROP TRIGGER reject_start");
    expect((await run()).recordProblem).toBeNull();
  });

  it("returns an explicit unsaved-result warning if the terminal write fails, with no stray saved answer", async () => {
    const { db, runtime, run } = await fixture();
    runtime.chat.mockImplementation(async request => {
      db.exec("CREATE TEMP TRIGGER reject_finish BEFORE INSERT ON case_turn WHEN NEW.body LIKE 'Agent run % finished %' BEGIN SELECT RAISE(FAIL,'write refused'); END");
      return response(request);
    });
    const result = await run();
    expect(result.outcome).toBe("answered"); expect(result.answer).toBe("A synthetic draft to review.");
    expect(result.recordProblem).toContain("could not be saved");
    expect(turnsFor(db, result.workroomId!)).toHaveLength(2);
    expect(artifactVersions(db, result.workroomId!)).toEqual([]);
    expect(() => assertAgentWorkroomIdle(result.workroomId!)).not.toThrow();
  });

  it("records model unavailability and rejects unusable briefs before creating work", async () => {
    const { db, ceiling, runtime, run } = await fixture();
    runtime.discover.mockResolvedValue([]);
    const result = await run();
    expect(result.outcome).toBe("refused"); expect(result.recordProblem).toBeNull();
    expect(turnsFor(db, result.workroomId!)[2]?.body).toContain("No model was asked");
    expect(runtime.chat).not.toHaveBeenCalled();
    const invalid = await runAgentById("reader", "No grant", { ...ceiling, grantedFolders: [] }, undefined, db, undefined, runtime);
    expect(invalid.problem).toContain("no usable folder");
    expect(allCases(db)).toHaveLength(1); expect(runtime.discover).toHaveBeenCalledTimes(1);
  });
});
