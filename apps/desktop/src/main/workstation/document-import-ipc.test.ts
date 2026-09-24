import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { DocumentImportResult } from "./document-import.js";
import { installWorkstationDocumentImport } from "./document-import-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  mockImport: vi.fn()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

vi.mock("./document-import.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./document-import.js")>();
  return {
    ...mod,
    importDocument: f.mockImport
  };
});


/**
 * Waits until the handler has actually reached the stub.
 *
 * The resolver below is only assigned when the mock is called, and the handler
 * reaches it asynchronously — calling it straight after `invoke` fires the
 * no-op default, the promise never settles, and the test hangs until the
 * timeout rather than failing with a reason.
 */
async function untilCalled(mock: { mock: { calls: readonly unknown[] } }): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The handler never reached the stub.");
}

describe("Workstation document import IPC", () => {
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;

  const invoke = (channel: string, input: unknown) =>
    Promise.resolve().then(() => f.handlers.get(channel)!(event, input));

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    f.mockImport.mockResolvedValue({
      status: "converted",
      markdown: "# Converted Document\n\nBody content.",
      bytes: 36,
      truncated: false,
      runtime: "python-markitdown"
    });

    installWorkstationDocumentImport({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      }
    });
  });

  it("refuses untrusted sender before any work is performed", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationDocumentImport, "/synthetic/document.pdf")
    ).rejects.toThrow("Untrusted sender");
    expect(f.mockImport).not.toHaveBeenCalled();
  });

  it("refuses relative path before spawning", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationDocumentImport, "relative/document.pdf")
    ).rejects.toThrow();
    expect(f.mockImport).not.toHaveBeenCalled();
  });

  it("refuses path containing a null byte before spawning", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationDocumentImport, "/synthetic/bad\0path.pdf")
    ).rejects.toThrow();
    expect(f.mockImport).not.toHaveBeenCalled();
  });

  it("refuses second concurrent call while first is in flight", async () => {
    let finishFirst: () => void = () => {};
    f.mockImport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () =>
            resolve({
              status: "converted",
              markdown: "First doc",
              bytes: 9,
              truncated: false,
              runtime: "python-markitdown"
            });
        })
    );

    const firstPromise = invoke(
      IPC_CHANNELS.workstationDocumentImport,
      "/synthetic/first.pdf"
    );

    await expect(
      invoke(IPC_CHANNELS.workstationDocumentImport, "/synthetic/second.pdf")
    ).rejects.toThrow("already running");

    await untilCalled(f.mockImport);

    finishFirst();
    await firstPromise;
  });

  it("refuses if owner changed mid-conversion", async () => {
    let completeImport: () => void = () => {};
    f.mockImport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeImport = () => {
            (event as { sender: unknown; senderFrame: unknown }).sender = Object.assign(
              new EventEmitter(),
              { isDestroyed: () => false }
            );
            (event as { senderFrame: unknown }).senderFrame = {};
            resolve({
              status: "converted",
              markdown: "Content",
              bytes: 7,
              truncated: false,
              runtime: "python-markitdown"
            });
          };
        })
    );

    const promise = invoke(
      IPC_CHANNELS.workstationDocumentImport,
      "/synthetic/document.pdf"
    );
    await untilCalled(f.mockImport);
    completeImport();
    await expect(promise).rejects.toThrow("This window changed while converting the document.");
  });

  it("refuses if sender becomes untrusted mid-conversion", async () => {
    let completeImport: () => void = () => {};
    f.mockImport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeImport = () => {
            trusted = false;
            resolve({
              status: "converted",
              markdown: "Content",
              bytes: 7,
              truncated: false,
              runtime: "python-markitdown"
            });
          };
        })
    );

    const promise = invoke(
      IPC_CHANNELS.workstationDocumentImport,
      "/synthetic/document.pdf"
    );
    await untilCalled(f.mockImport);
    completeImport();
    await expect(promise).rejects.toThrow("Untrusted sender");
  });

  it("returns a successful conversion unchanged", async () => {
    const expectedResult: DocumentImportResult = {
      status: "converted",
      markdown: "# Financial Statement\n\nQ3 profit: £42,000",
      bytes: 42,
      truncated: false,
      runtime: "python-markitdown"
    };
    f.mockImport.mockResolvedValueOnce(expectedResult);

    const result = await invoke(
      IPC_CHANNELS.workstationDocumentImport,
      "/synthetic/statement.pdf"
    );

    expect(result).toEqual(expectedResult);
    expect(f.mockImport).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/synthetic/statement.pdf"
      })
    );
  });

  it("accepts object input with filePath property", async () => {
    const result = await invoke(IPC_CHANNELS.workstationDocumentImport, {
      filePath: "/synthetic/document.pdf"
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "converted"
      })
    );
    expect(f.mockImport).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/synthetic/document.pdf"
      })
    );
  });

  it("passes an unavailable result through as a value, not a throw", async () => {
    const unavailableResult: DocumentImportResult = {
      status: "unavailable",
      reason: "This document format is not supported."
    };
    f.mockImport.mockResolvedValueOnce(unavailableResult);

    const result = await invoke(
      IPC_CHANNELS.workstationDocumentImport,
      "/synthetic/document.xyz"
    );

    expect(result).toEqual(unavailableResult);
  });

  it("ensures no returned string contains a / path when unavailable", async () => {
    f.mockImport.mockResolvedValueOnce({
      status: "unavailable",
      reason: "The converter failed on /Users/owner/private/report.pdf with exit code 1."
    });

    const result = (await invoke(
      IPC_CHANNELS.workstationDocumentImport,
      "/synthetic/report.pdf"
    )) as DocumentImportResult;

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).not.toContain("/");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("passes runtime options to the underlying importer", async () => {
    installWorkstationDocumentImport({
      assertTrusted: () => {},
      runtimeOptions: {
        scriptPath: "/custom/bridge.py",
        timeoutMs: 15_000
      }
    });

    await invoke(IPC_CHANNELS.workstationDocumentImport, "/synthetic/custom.pdf");

    expect(f.mockImport).toHaveBeenCalledWith({
      filePath: "/synthetic/custom.pdf",
      runtimeOptions: expect.objectContaining({
        scriptPath: "/custom/bridge.py",
        timeoutMs: 15_000
      })
    });
  });
});
