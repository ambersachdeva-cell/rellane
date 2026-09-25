/** The useful promise is scoped, durable work, including cancellation and failure. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CaseLocalRequest,
  LocalChatRequest,
  RuntimeDescriptor
} from "@cadrane/contracts";
import { appendTurn, closeCase, openCase, turnsFor } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { LocalWorkroom, type LocalWorkroomDeps } from "./local.js";
let db: DatabaseSync;
let id: string;
let service: LocalWorkroom;
const runtime: RuntimeDescriptor = {
  id: "cadrane-local-loopback",
  kind: "lm-studio",
  name: "Bundled",
  baseUrl: "http://127.0.0.1:12340",
  state: "available",
  version: null,
  detail: "Observed",
  checkedAt: "2026-09-06T00:00:00.000Z",
  models: [{ id: "qwen", displayName: "Qwen", loaded: true, sizeBytes: null }]
};
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  id = openCase(db, { title: "Campaign", question: "Make a brief" });
  service = new LocalWorkroom();
});
afterEach(() => db.close());
function request(sourceTurnIds: string[] = []): CaseLocalRequest {
  return {
    id,
    sourceTurnIds,
    operationId: randomUUID(),
    modelId: "qwen",
    question: "Draft a grounded campaign"
  };
}
function harness(overrides: Partial<LocalWorkroomDeps> = {}) {
  const prompts: LocalChatRequest[] = [];
  const cancelled: string[] = [];
  const deps: LocalWorkroomDeps = {
    discover: async () => [runtime],
    chat: async (input) => {
      prompts.push(input);
      return {
        operationId: input.operationId,
        runtimeId: input.runtimeId,
        modelId: input.modelId,
        content: "A draft, not a fact.",
        startedAt: "2026-09-06T00:00:00.000Z",
        finishedAt: "2026-09-06T00:00:01.000Z",
        localOnly: true
      };
    },
    cancel: async (operationId) => {
      cancelled.push(operationId);
    },
    ...overrides
  };
  return { deps, prompts, cancelled };
}
describe("local workroom", () => {
  it("sends only selected notes and stores the answer with its real model attribution", async () => {
    const selected = appendTurn(db, id, {
      seat: "owner",
      kind: "verbatim",
      body: "Ceramic, 24 cm."
    });
    appendTurn(db, id, {
      seat: "owner",
      kind: "verbatim",
      body: "PRIVATE_UNSELECTED"
    });
    const other = openCase(db, {
      title: "Other client",
      question: "PRIVATE_OTHER_CLIENT"
    });
    appendTurn(db, other, {
      seat: "owner",
      kind: "verbatim",
      body: "SECRET_OTHER"
    });
    const h = harness();
    await service.run(db, request([selected]), h.deps);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]?.runtimeId).toBe("cadrane-local-loopback");
    const packet = h.prompts[0]?.messages[1]?.content ?? "";
    expect(packet).toContain("Ceramic, 24 cm.");
    expect(packet).toContain(selected);
    expect(packet).not.toContain("PRIVATE");
    expect(packet).not.toContain("SECRET_OTHER");
    const stored = turnsFor(db, id);
    expect(stored.at(-4)).toMatchObject({seat: "owner", kind: "verbatim", body: "Draft a grounded campaign"});
    expect(stored.at(-2)?.seat).toBe("Local · qwen");
    expect(stored.at(-2)?.body).toBe("A draft, not a fact.");
    expect(stored.at(-1)?.body).toContain(`Saved answer: ${stored.at(-2)?.id}`);
  });
  it("refuses foreign or receipt sources before dispatch", async () => {
    const receipt = appendTurn(db, id, {
      seat: "workroom",
      kind: "receipt",
      body: "Not model context"
    });
    const h = harness();
    await expect(service.run(db, request([receipt]), h.deps)).rejects.toThrow(
      "selected source"
    );
    await expect(
      service.run(db, request([randomUUID()]), h.deps)
    ).rejects.toThrow("selected source");
    expect(h.prompts).toHaveLength(0);
    expect(turnsFor(db, id)).toHaveLength(1);
  });
  it("does not fall back to an external loopback or subscription", async () => {
    const h = harness({
      discover: async () => [{ ...runtime, id: "lm-studio-loopback" }]
    });
    await expect(service.run(db, request(), h.deps)).rejects.toThrow(
      "bundled model is not available"
    );
    expect(h.prompts).toHaveLength(0);
    expect(turnsFor(db, id)).toHaveLength(0);
  });
  it("refuses oversized context rather than silently dropping source material", async () => {
    const source = appendTurn(db, id, {
      seat: "owner",
      kind: "verbatim",
      body: "x".repeat(12_000)
    });
    const h = harness();
    await expect(service.run(db, request([source]), h.deps)).rejects.toThrow(
      "too large"
    );
    expect(h.prompts).toHaveLength(0);
  });
  it("records a start before asking and discards an answer arriving after Stop", async () => {
    const input = request();
    const h = harness();
    h.deps.chat = async (payload) => {
      expect(turnsFor(db, id)[0]).toMatchObject({seat: "owner", kind: "verbatim", body: input.question});
      expect(turnsFor(db, id)[1]?.body).toContain(
        `${input.operationId} started`
      );
      expect(service.current(id)).toEqual({
        operationId: input.operationId,
        stopping: false
      });
      expect(service.current("another-room")).toBeNull();
      expect(() => service.assertIdle(id)).toThrow("Stop");
      await expect(service.run(db, request(), h.deps)).rejects.toThrow(
        "already running"
      );
      expect(await service.stop(id, randomUUID(), h.deps)).toEqual({
        stopped: false
      });
      expect(await service.stop(id, input.operationId, h.deps)).toEqual({
        stopped: true
      });
      expect(service.current(id)).toEqual({
        operationId: input.operationId,
        stopping: true
      });
      return {
        operationId: payload.operationId,
        runtimeId: payload.runtimeId,
        modelId: payload.modelId,
        content: "LATE_ANSWER",
        startedAt: "2026-09-06T00:00:00.000Z",
        finishedAt: "2026-09-06T00:00:01.000Z",
        localOnly: true
      };
    };
    await expect(service.run(db, input, h.deps)).rejects.toThrow("late answer");
    expect(turnsFor(db, id).filter(turn => turn.kind === "verbatim")).toEqual([expect.objectContaining({seat: "owner", body: input.question})]);
    expect(turnsFor(db, id).at(-1)?.body).toContain("stop requested; did not complete");
    expect(h.cancelled).toContain(input.operationId);
    expect(() => service.assertIdle(id)).not.toThrow();
    expect(service.current(id)).toBeNull();
  });
  it("does not start inference when cancelled during discovery", async () => {
    const input = request();
    const h = harness();
    h.deps.discover = async () => {
      await service.stop(id, input.operationId, h.deps);
      return [runtime];
    };
    await expect(service.run(db, input, h.deps)).rejects.toThrow(
      "Stopped before"
    );
    expect(h.prompts).toHaveLength(0);
    expect(turnsFor(db, id)).toHaveLength(0);
  });
  it("refuses closed work and recorded operation replay", async () => {
    const h = harness();
    const input = request();
    await service.run(db, input, h.deps);
    await expect(service.run(db, input, h.deps)).rejects.toThrow(
      "already recorded"
    );
    closeCase(db, id, { closedAs: "settled", verdict: "Accepted" });
    await expect(service.run(db, request(), h.deps)).rejects.toThrow(
      "Open work"
    );
    expect(h.prompts).toHaveLength(1);
  });
  it("rolls back the answer if completion cannot be stored", async () => {
    db.exec(
      "CREATE TRIGGER refuse_completion BEFORE INSERT ON case_turn WHEN NEW.body LIKE '%completed. Saved answer:%' BEGIN SELECT RAISE(ABORT, 'receipt refused'); END"
    );
    const h = harness();
    await expect(service.run(db, request(), h.deps)).rejects.toThrow(
      "receipt refused"
    );
    const stored = turnsFor(db, id);
    expect(stored).toHaveLength(3);
    expect(stored.filter(turn => turn.kind === "verbatim")).toEqual([expect.objectContaining({seat: "owner", body: "Draft a grounded campaign"})]);
    expect(stored.at(-1)?.body).toContain("did not complete");
  });
  it("does not dispatch or leave an orphan question if the start receipt cannot be saved", async () => {
    db.exec("CREATE TRIGGER refuse_start BEFORE INSERT ON case_turn WHEN NEW.kind = 'receipt' AND NEW.body LIKE '%started with%' BEGIN SELECT RAISE(ABORT, 'start refused'); END");
    const h = harness();
    await expect(service.run(db, request(), h.deps)).rejects.toThrow("start refused");
    expect(h.prompts).toEqual([]);
    expect(turnsFor(db, id)).toEqual([]);
  });

  it("executes a graph-node request without writing an owner turn and saves a finding turn on graph-host-answer seat", async () => {
    const sourceId = appendTurn(db, id, {
      seat: "owner",
      kind: "verbatim",
      body: "Original case note."
    });
    const operationId = randomUUID();
    const graphChatRequest: LocalChatRequest = {
      operationId,
      runtimeId: "cadrane-local-loopback",
      modelId: "qwen",
      messages: [
        { role: "system", content: "System prompt." },
        { role: "user", content: "User packet with source." }
      ],
      temperature: 0.2,
      maxTokens: 512,
      responseProfile: "graph-node-v1"
    };
    const h = harness();
    const out = await service.runGraphNode(
      db,
      {
        caseId: id,
        nodeTitle: "Node 1",
        instruction: "Analyze the note.",
        sourceTurnIds: [sourceId],
        request: graphChatRequest
      },
      h.deps
    );

    expect(h.prompts).toEqual([graphChatRequest]);
    const stored = turnsFor(db, id);
    expect(stored.filter((t) => t.seat === "owner")).toHaveLength(1);
    const finding = stored.find((t) => t.id === out.answerTurnId);
    expect(finding).toMatchObject({
      seat: "graph-host-answer",
      kind: "finding",
      body: "A draft, not a fact."
    });
    expect(stored.at(-1)).toMatchObject({
      seat: "workroom",
      kind: "receipt"
    });
    expect(stored.at(-1)?.body).toContain(`Saved answer: ${out.answerTurnId}`);
  });

  it("refuses graph-node execution with wrong responseProfile or rolls back finding on onFinish failure", async () => {
    const h = harness();
    const badRequest: LocalChatRequest = {
      operationId: randomUUID(),
      runtimeId: "cadrane-local-loopback",
      modelId: "qwen",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "User" }
      ],
      temperature: 0.2,
      maxTokens: 256,
      responseProfile: "local-draft-v1"
    };
    await expect(
      service.runGraphNode(
        db,
        {
          caseId: id,
          nodeTitle: "Node 1",
          instruction: "Analyze",
          sourceTurnIds: [],
          request: badRequest
        },
        h.deps
      )
    ).rejects.toThrow("graph-node-v1");
    expect(h.prompts).toHaveLength(0);

    const validRequest: LocalChatRequest = {
      ...badRequest,
      operationId: randomUUID(),
      responseProfile: "graph-node-v1"
    };
    let failureInterrupted: boolean | null = null;
    await expect(
      service.runGraphNode(
        db,
        {
          caseId: id,
          nodeTitle: "Node 1",
          instruction: "Analyze",
          sourceTurnIds: [],
          request: validRequest
        },
        h.deps,
        {
          beforeStart: () => {},
          onStart: () => {},
          beforeChat: () => {},
          onFinish: () => {
            throw new Error("Correlation terminal write failed");
          },
          onFailure: (interrupted) => {
            failureInterrupted = interrupted;
          },
          isStopped: () => false
        }
      )
    ).rejects.toThrow("Correlation terminal write failed");

    expect(failureInterrupted).toBe(true);
    expect(turnsFor(db, id).filter((t) => t.seat === "graph-host-answer")).toHaveLength(0);
  });
});
