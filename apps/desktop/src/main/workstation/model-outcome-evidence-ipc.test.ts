import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { openCase } from "../book/cases.js";
import { MIGRATIONS } from "../book/schema.js";
import { saveSessionReceipt } from "./store.js";
import { installModelOutcomeEvidence } from "./model-outcome-evidence-ipc.js";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
}));

const trusted = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const untrusted = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;

describe("model outcome evidence IPC", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    handlers.clear();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
  });
  afterEach(() => db.close());

  it("rejects untrusted callers before opening Book", async () => {
    let accessed = false;
    installModelOutcomeEvidence({
      assertTrusted: (event) => {
        if (event !== trusted) throw new Error("Untrusted sender");
      },
      book: () => { accessed = true; return db; }
    });
    const handler = handlers.get(IPC_CHANNELS.workstationModelOutcomeEvidence)!;
    await expect(handler(untrusted, {})).rejects.toThrow("Untrusted sender");
    expect(accessed).toBe(false);
  });

  it("returns only measured metadata for a scoped case and rejects extra fields", async () => {
    const caseId = openCase(db, { title: "Work", question: "Private prompt" });
    saveSessionReceipt(db, caseId, {
      version: 1, event: "finish", workspacePath: "/private/work",
      snapshot: {
        operationId: "op-measured", caseId, providerId: "codex", modelId: "gpt-6-sol",
        sessionId: "native-1", status: "completed", startedAt: 1000, updatedAt: 2000,
        text: "PRIVATE_ANSWER", activity: [], permission: null, detail: "PRIVATE_DETAIL"
      }
    });
    installModelOutcomeEvidence({ assertTrusted: () => {}, book: () => db });
    const handler = handlers.get(IPC_CHANNELS.workstationModelOutcomeEvidence)!;
    const result = await handler(trusted, { caseId });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(result).toMatchObject([{
      operationId: "op-measured", caseId, requestedModelId: "gpt-6-sol",
      observedCompleted: true, durationMs: 1000
    }]);
    await expect(handler(trusted, { caseId, extra: true })).rejects.toThrow();
  });
});
