import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { MIGRATIONS } from "../book/schema.js";
import { appendTurn, closeCase, openCase } from "../book/cases.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { installWorkstationCitations } from "./hermes-citations-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  mockCheck: vi.fn()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

vi.mock("./hermes-citations.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./hermes-citations.js")>();
  return {
    ...mod,
    checkHermesCitations: f.mockCheck
  };
});

describe("Hermes citations IPC", () => {
  let db: DatabaseSync;
  let caseId: string;
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
  const idle = vi.fn();
  const book = () => db;

  const invoke = (channel: string, input: unknown) =>
    Promise.resolve().then(() => f.handlers.get(channel)!(event, input));

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    caseId = openCase(db, { title: "Citation research", question: "Verify draft" });
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    f.mockCheck.mockResolvedValue({
      status: "ok",
      summary: "All citations match",
      disclaimer: "Checks references against selected sources; it does not verify that claims are true.",
      sources: [],
      citedIds: [1],
      unknownReferences: [],
      missingFromSourcesBlock: [],
      unexpectedInSourcesBlock: [],
      mismatchedUrls: [],
      expectedSourcesBlock: "",
      warnings: [],
      errors: []
    });
    installWorkstationCitations({
      book,
      assertIdle: idle,
      assertTrusted: () => {
        if (!trusted) throw new Error("Untrusted sender");
      }
    });
  });

  afterEach(() => db.close());

  it("rejects untrusted sender before database or process operations", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: "Draft",
        sourceTurnIds: []
      })
    ).rejects.toThrow("Untrusted sender");
    expect(f.mockCheck).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong-case source turns before spawn", async () => {
    const foreignCaseId = openCase(db, { title: "Foreign", question: "Foreign question" });
    const foreignTurnId = appendTurn(db, foreignCaseId, {
      seat: "Source · Foreign doc",
      kind: "verbatim",
      body: "Foreign content"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: "Draft referencing foreign [1]",
        sourceTurnIds: [foreignTurnId]
      })
    ).rejects.toThrow("was not found in this work");
    expect(f.mockCheck).not.toHaveBeenCalled();
  });

  it("rejects non-verbatim receipt turns before spawn", async () => {
    const receiptTurnId = appendTurn(db, caseId, {
      seat: "Receipt · Work",
      kind: "receipt",
      body: "Receipt metadata"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: "Draft",
        sourceTurnIds: [receiptTurnId]
      })
    ).rejects.toThrow("not a verbatim source turn");
    expect(f.mockCheck).not.toHaveBeenCalled();
  });

  it("rejects duplicate source turn IDs before spawn", async () => {
    const sourceId = appendTurn(db, caseId, {
      seat: "Source · Valid doc",
      kind: "verbatim",
      body: "Valid body"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: "Draft",
        sourceTurnIds: [sourceId, sourceId]
      })
    ).rejects.toThrow();
    expect(f.mockCheck).not.toHaveBeenCalled();
  });

  it("rejects oversized draft before spawn", async () => {
    const hugeDraft = "x".repeat(51_201);
    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: hugeDraft,
        sourceTurnIds: []
      })
    ).rejects.toThrow();
    expect(f.mockCheck).not.toHaveBeenCalled();
  });

  it("rejects when case is closed or busy", async () => {
    closeCase(db, caseId, { closedAs: "settled", verdict: "Finished" });
    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: "Draft",
        sourceTurnIds: []
      })
    ).rejects.toThrow("This work is closed");
    expect(f.mockCheck).not.toHaveBeenCalled();
  });

  it("enforces single in-flight checker at a time", async () => {
    let finishFirst: () => void = () => {};
    f.mockCheck.mockImplementationOnce(
      () => new Promise((resolve) => { finishFirst = () => resolve({ status: "ok", summary: "done", disclaimer: "", sources: [], citedIds: [], unknownReferences: [], missingFromSourcesBlock: [], unexpectedInSourcesBlock: [], mismatchedUrls: [], expectedSourcesBlock: "", warnings: [], errors: [] }); })
    );

    const firstPromise = invoke(IPC_CHANNELS.workstationCheckCitations, {
      caseId,
      draft: "Draft 1",
      sourceTurnIds: []
    });

    await expect(
      invoke(IPC_CHANNELS.workstationCheckCitations, {
        caseId,
        draft: "Draft 2",
        sourceTurnIds: []
      })
    ).rejects.toThrow("already running");

    finishFirst();
    await firstPromise;
  });

  it("hands the checker the source seat label, not the raw seat", async () => {
    const sourceId = appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}Budget memo`,
      kind: "verbatim",
      body: "Budget body"
    });

    await invoke(IPC_CHANNELS.workstationCheckCitations, {
      caseId,
      draft: "The budget was approved [1].",
      sourceTurnIds: [sourceId]
    });

    expect(f.mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId,
        draft: "The budget was approved [1].",
        sources: [{ sourceTurnId: sourceId, label: "Budget memo", body: "Budget body" }]
      })
    );
  });
});
