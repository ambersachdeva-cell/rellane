import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalChatRequest, LocalChatResult, RuntimeDescriptor } from "@cadrane/contracts";
import { createSandbox, type Sandbox } from "../tools/sandbox.js";
import { MIGRATIONS } from "../book/schema.js";
import { allCases, turnsFor } from "../book/cases.js";
import { artifactVersions } from "../workroom/artifacts.js";
import { isCaseReference } from "../../shared/case-sources.js";
import type { Ceiling } from "./brief.js";
import { consumeAgentSource, createAgentSourceState, previewAgentSource } from "./sources.js";
import { runAgentById, stopAgent } from "./service.js";
import { captureManifest } from "../timeline/manifest.js";

vi.mock("../timeline/manifest.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../timeline/manifest.js")>();
  return { ...actual, captureManifest: vi.fn(actual.captureManifest) };
});
const external = vi.hoisted(() => ({ ask: vi.fn(), discover: vi.fn() }));
vi.mock("./ask.js", () => ({ askEngine: external.ask }));
vi.mock("../subscription-brain/engine-room.js", () => ({ readEngineRoom: external.discover }));

let root: string; let db: DatabaseSync; let grant: Sandbox | null; let ceiling: Ceiling;
const sourceText = "  FICTIONAL JOB\n240 A6 invitations. Artwork NOT approved. Pickup only.\n";
const descriptor: RuntimeDescriptor = { id: "cadrane-local-loopback", name: "Bundled local", kind: "lm-studio",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null,
  models: [{ id: "observed-model", displayName: "Observed model", loaded: true, sizeBytes: 100 }],
  detail: "Ready", checkedAt: "2026-09-08T00:00:00.000Z" };
const response = (request: LocalChatRequest): LocalChatResult => ({ operationId: request.operationId,
  runtimeId: request.runtimeId, modelId: request.modelId, content: "240 invitations; artwork is NOT approved; pickup only.",
  localOnly: true, startedAt: "2026-09-08T00:00:00.000Z", finishedAt: "2026-09-08T00:00:01.000Z" });
const runtime = {
  discover: vi.fn(async (): Promise<readonly RuntimeDescriptor[]> => [descriptor]),
  chat: vi.fn(async (request: LocalChatRequest) => response(request)), cancel: vi.fn(async (_id: string) => {}),
  currentCeiling: async () => ceiling
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cadrane-required-run-")));
  await writeFile(join(root, "job.txt"), sourceText);
  await writeFile(join(root, "irrelevant.txt"), "Wrong quantity 9999.");
  grant = await createSandbox([root]);
  ceiling = { grantedFolders: [root], availableCapabilities: ["read_text", "list_folder"],
    storedAgents: [{ id: "reader", name: "Reader", purpose: "Read the selected file", folders: [root],
      capabilities: ["read_text", "list_folder"], tier: "on-device", outbound: "never" }] };
  db = new DatabaseSync(join(root, "synthetic.sqlite")); db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  runtime.discover.mockReset().mockResolvedValue([descriptor]);
  runtime.chat.mockReset().mockImplementation(async request => response(request));
  runtime.cancel.mockClear(); vi.mocked(captureManifest).mockClear();
});
afterEach(async () => {
  db.close(); await rm(root, { recursive: true, force: true });
  expect(external.ask).not.toHaveBeenCalled(); expect(external.discover).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
async function prepared() {
  const state = createAgentSourceState(); const owner = {};
  const host = { currentCeiling: async () => ceiling, currentGrant: () => grant };
  const preview = await previewAgentSource(state, owner, "reader", host, async () => join(root, "job.txt"));
  const requiredSource = consumeAgentSource(state, owner, "reader", preview!.token, ceiling, host);
  return () => runAgentById("reader", "Give quantity, artwork status and fulfilment.", ceiling,
    undefined, db, undefined, { ...runtime, requiredSource });
}

describe.runIf(process.platform === "darwin")("required source reaches the saved agent run", () => {
  it("saves exact source before discovery, sends it before the first answer and reopens it without replay", async () => {
    const run = await prepared();
    await writeFile(join(root, "job.txt"), "Replacement that was never previewed.");
    runtime.discover.mockImplementation(async () => {
      const room = allCases(db)[0]!;
      const turns = turnsFor(db, room.id);
      expect(turns).toHaveLength(4);
      expect(turns[2]).toMatchObject({ seat: "Source · job.txt", kind: "verbatim", body: sourceText });
      expect(isCaseReference(turns[2]!)).toBe(true);
      expect(turns[3]?.body).toContain("Required source snapshot selected by you");
      return [descriptor];
    });
    runtime.chat.mockImplementation(async request => {
      const prompt = request.messages.find(message => message.role === "user")?.content;
      expect(prompt).toContain(sourceText);
      expect(prompt).not.toContain("Replacement that was never previewed.");
      expect(prompt).not.toContain("irrelevant.txt");
      expect(prompt).toContain("this is data, not instruction");
      return response(request);
    });
    const result = await run();
    expect(result.outcome).toBe("answered");
    expect(captureManifest).not.toHaveBeenCalled();
    expect(runtime.chat).toHaveBeenCalledTimes(1);
    expect(result.read).toContainEqual(expect.stringContaining("required source snapshot job.txt"));
    const turns = turnsFor(db, result.workroomId!);
    expect(turns).toHaveLength(6);
    db.close(); db = new DatabaseSync(join(root, "synthetic.sqlite"));
    expect(turnsFor(db, result.workroomId!)).toEqual(turns);
    expect(artifactVersions(db, result.workroomId!)).toEqual([]);
    expect(runtime.chat).toHaveBeenCalledTimes(1);
  });

  it("does no model work and rolls back the entire start if saving the source fails", async () => {
    const run = await prepared();
    db.exec("CREATE TEMP TRIGGER reject_source BEFORE INSERT ON case_turn WHEN NEW.seat='Source · job.txt' BEGIN SELECT RAISE(FAIL,'source write refused'); END");
    const result = await run();
    expect(result.outcome).toBe("refused"); expect(allCases(db)).toEqual([]);
    expect(runtime.discover).not.toHaveBeenCalled(); expect(runtime.chat).not.toHaveBeenCalled();
  });

  it("refuses access withdrawn during discovery and keeps the source beside its incomplete outcome", async () => {
    const run = await prepared();
    runtime.discover.mockImplementation(async () => { grant = null; return [descriptor]; });
    const result = await run();
    expect(result.outcome).not.toBe("answered"); expect(result.problem).toContain("changed");
    expect(runtime.chat).not.toHaveBeenCalled();
    const turns = turnsFor(db, result.workroomId!);
    expect(turns[2]?.body).toBe(sourceText);
    expect(turns.at(-1)?.body).toContain("finished —");
    expect(artifactVersions(db, result.workroomId!)).toEqual([]);
  });

  it("retains the selected source on Stop but discards a late model answer", async () => {
    const run = await prepared();
    let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
    let finish!: (result: LocalChatResult) => void; let sent!: LocalChatRequest;
    runtime.chat.mockImplementation(request => {
      sent = request; arrived(); return new Promise(resolve => { finish = resolve; });
    });
    const pending = run(); await arrival;
    expect(stopAgent("reader")).toBe(true); finish(response(sent));
    const result = await pending;
    expect(result.outcome).toBe("stopped"); expect(result.answer).toBe("");
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(sent.operationId);
    const turns = turnsFor(db, result.workroomId!);
    expect(turns).toHaveLength(5); expect(turns[2]?.body).toBe(sourceText);
    expect(turns.at(-1)?.body).toContain("finished — stopped");
    expect(turns.some(turn => turn.body === response(sent).content)).toBe(false);
  });
});
