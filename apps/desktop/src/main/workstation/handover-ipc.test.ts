import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { MIGRATIONS } from "../book/schema.js";
import { appendTurn, closeCase, openCase, readCase, turnsFor } from "../book/cases.js";
import { CASE_SOURCE_SEAT_PREFIX } from "../../shared/case-sources.js";
import { installWorkstationHandover } from "./handover-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  mockWriteFolder: vi.fn()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

describe("Handover IPC", () => {
  let db: DatabaseSync;
  let caseId: string;
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
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
    caseId = openCase(db, { title: "Audit research", question: "Assemble client deliverable" });
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    f.mockWriteFolder.mockResolvedValue("/synthetic/output/pack-folder");

    installWorkstationHandover({
      book,
      readCase,
      turnsFor,
      writeFolder: f.mockWriteFolder,
      assertTrusted: () => {
        if (!trusted) throw new Error("Untrusted sender");
      }
    });
  });

  afterEach(() => db.close());

  it("rejects untrusted sender before database or folder operations", async () => {
    trusted = false;

    await expect(
      invoke(IPC_CHANNELS.workstationAuditExport, { caseId })
    ).rejects.toThrow("Untrusted sender");

    await expect(
      invoke(IPC_CHANNELS.workstationDeliveryPack, { caseId, confirm: true })
    ).rejects.toThrow("Untrusted sender");

    expect(f.mockWriteFolder).not.toHaveBeenCalled();
  });

  it("rejects unknown case for both audit export and delivery pack", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationAuditExport, { caseId: "nonexistent-case-id" })
    ).rejects.toThrow("This work was not found");

    await expect(
      invoke(IPC_CHANNELS.workstationDeliveryPack, { caseId: "nonexistent-case-id" })
    ).rejects.toThrow("This work was not found");

    expect(f.mockWriteFolder).not.toHaveBeenCalled();
  });

  it("rejects closed case for both audit export and delivery pack", async () => {
    closeCase(db, caseId, { closedAs: "settled", verdict: "Completed" });

    await expect(
      invoke(IPC_CHANNELS.workstationAuditExport, { caseId })
    ).rejects.toThrow("This work is closed");

    await expect(
      invoke(IPC_CHANNELS.workstationDeliveryPack, { caseId })
    ).rejects.toThrow("This work is closed");

    expect(f.mockWriteFolder).not.toHaveBeenCalled();
  });

  it("returns delivery pack plan and writes nothing when confirm is not true", async () => {
    appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}Contract draft`,
      kind: "verbatim",
      body: "Contract text"
    });

    const plan = (await invoke(IPC_CHANNELS.workstationDeliveryPack, {
      caseId,
      clientName: "Acme Corp"
    })) as { readonly folderName: string; readonly items: readonly unknown[] };

    expect(f.mockWriteFolder).not.toHaveBeenCalled();
    expect(plan.folderName).toContain("Acme Corp");
    expect(plan.items.length).toBeGreaterThan(0);
  });

  it("writes delivery pack folder only on confirm: true", async () => {
    appendTurn(db, caseId, {
      seat: "Claude",
      kind: "finding",
      body: "Final deliverable document"
    });

    await invoke(IPC_CHANNELS.workstationDeliveryPack, {
      caseId,
      confirm: false
    });
    expect(f.mockWriteFolder).not.toHaveBeenCalled();

    const result = (await invoke(IPC_CHANNELS.workstationDeliveryPack, {
      caseId,
      confirm: true
    })) as { readonly writtenTo: string };

    expect(f.mockWriteFolder).toHaveBeenCalledTimes(1);
    expect(result.writtenTo).toBe("/synthetic/output/pack-folder");
  });

  it("never includes internal sources or notes in written files", async () => {
    appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}Public specifications`,
      kind: "verbatim",
      body: "Public specification content"
    });
    appendTurn(db, caseId, {
      seat: `${CASE_SOURCE_SEAT_PREFIX}Internal briefing`,
      kind: "verbatim",
      body: "Confidential internal notes that client must never see"
    });
    appendTurn(db, caseId, {
      seat: "owner",
      kind: "verbatim",
      body: "Owner private strategy note"
    });

    await invoke(IPC_CHANNELS.workstationDeliveryPack, {
      caseId,
      confirm: true
    });

    expect(f.mockWriteFolder).toHaveBeenCalledTimes(1);
    const writeCalls = f.mockWriteFolder.mock.calls;
    expect(writeCalls.length).toBe(1);
    const firstCall = writeCalls[0];
    expect(firstCall).toBeDefined();
    const callArgs = firstCall!;
    expect(callArgs.length).toBeGreaterThanOrEqual(3);
    expect(callArgs[0]).toBe(caseId);
    const writtenFiles = callArgs[2] as readonly { readonly relativePath: string; readonly contents: string }[];

    for (const file of writtenFiles) {
      expect(file.contents).not.toContain("Confidential internal notes");
      expect(file.contents).not.toContain("Owner private strategy note");
      expect(file.relativePath).not.toContain("Internal briefing");
    }

    const hasPublicSource = writtenFiles.some(
      (file) => file.contents.includes("Public specification content")
    );
    expect(hasPublicSource).toBe(true);
  });

  it("refuses concurrent handover operations", async () => {
    let finishWrite: () => void = () => {};
    f.mockWriteFolder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve("/synthetic/output/pack-folder");
        })
    );

    const firstPromise = invoke(IPC_CHANNELS.workstationDeliveryPack, {
      caseId,
      confirm: true
    });

    await expect(
      invoke(IPC_CHANNELS.workstationDeliveryPack, {
        caseId,
        confirm: true
      })
    ).rejects.toThrow("already in progress");

    finishWrite();
    await firstPromise;
  });

  it("ensures errors do not leak filesystem paths to renderer", async () => {
    f.mockWriteFolder.mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/Users/example/secret/workstation/pack'")
    );

    try {
      await invoke(IPC_CHANNELS.workstationDeliveryPack, {
        caseId,
        confirm: true
      });
      expect.fail("Expected call to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).not.toContain("/Users");
      expect(message).not.toContain("/ambersachdeva");
      expect(message).not.toContain("/secret");
      expect(message).not.toMatch(/[/\\]/);
    }
  });

  it("exports audit document without writing any file", async () => {
    appendTurn(db, caseId, {
      seat: "user",
      kind: "verbatim",
      body: "Can you analyze this project?"
    });
    appendTurn(db, caseId, {
      seat: "Claude",
      kind: "finding",
      body: "Here is the comprehensive analysis."
    });

    const doc = (await invoke(IPC_CHANNELS.workstationAuditExport, {
      caseId
    })) as { readonly title: string; readonly markdown: string; readonly entryCount: number };

    expect(f.mockWriteFolder).not.toHaveBeenCalled();
    expect(doc.markdown).toContain("Can you analyze this project?");
    expect(doc.markdown).toContain("Here is the comprehensive analysis.");
    expect(doc.entryCount).toBe(2);
  });
});
