import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { CaptureOutcome } from "./screen-source.js";
import { installWorkstationCapture } from "./capture-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

function createMockSource(
  id: string,
  name: string,
  pngData = Buffer.from("synthetic-png-data"),
  width = 640,
  height = 360
) {
  return {
    id,
    name,
    thumbnail: {
      toPNG: () => pngData,
      getSize: () => ({ width, height }),
      isEmpty: () => false
    }
  };
}


/**
 * Waits until the handler has actually reached the stub.
 *
 * The resolver is only assigned when the mock is called, and the handler gets
 * there asynchronously — releasing it straight after `invoke` fires the no-op
 * default and the promise never settles, so the test hangs to its timeout
 * instead of failing with a reason. Same for an in-flight guard: asking for a
 * second operation before the first has reached the stub races it.
 */
/** The stub this suite releases has been reached. */
async function untilStubReached(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function untilCalled(mock: { readonly mock: { readonly calls: readonly unknown[] } }): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The handler never reached the stub.");
}

describe("Workstation capture IPC", () => {
  let testDir = "";
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
  const mockListSources = vi.fn();
  const mockCaptureDir = vi.fn();

  const invoke = (channel: string, input?: unknown) =>
    Promise.resolve().then(() => {
      const handler = f.handlers.get(channel);
      if (!handler) {
        throw new Error(`No IPC handler registered for channel ${channel}`);
      }
      return handler(event, input);
    });

  beforeEach(async () => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-capture-test-"));
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    mockListSources.mockResolvedValue([]);
    mockCaptureDir.mockImplementation(async (caseId: string) => path.join(testDir, caseId));

    installWorkstationCapture({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      },
      listSources: mockListSources,
      captureDir: mockCaptureDir
    });
  });

  afterEach(async () => {
    if (testDir.length > 0) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects untrusted sender before any work on list", async () => {
    trusted = false;
    await expect(invoke(IPC_CHANNELS.workstationCaptureList)).rejects.toThrow("Untrusted sender");
    expect(mockListSources).not.toHaveBeenCalled();
  });

  it("rejects untrusted sender before any work on take", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "case-1",
        targetId: "window:1"
      })
    ).rejects.toThrow("Untrusted sender");
    expect(mockListSources).not.toHaveBeenCalled();
    expect(mockCaptureDir).not.toHaveBeenCalled();
  });

  it("refuses take when list was never called for this window", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "case-1",
        targetId: "window:1"
      })
    ).rejects.toThrow("The selected window or screen was not listed");
    expect(mockCaptureDir).not.toHaveBeenCalled();
  });

  it("refuses take with an id that was never listed", async () => {
    mockListSources.mockResolvedValue([
      createMockSource("window:1", "Window One")
    ]);

    await invoke(IPC_CHANNELS.workstationCaptureList);

    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "case-1",
        targetId: "window:unlisted"
      })
    ).rejects.toThrow("The selected window or screen was not listed");
    expect(mockCaptureDir).not.toHaveBeenCalled();
  });

  it("refuses target from an earlier listing that dropped off the most recent list", async () => {
    mockListSources.mockResolvedValueOnce([
      createMockSource("window:first", "First Window")
    ]);
    await invoke(IPC_CHANNELS.workstationCaptureList);

    mockListSources.mockResolvedValueOnce([
      createMockSource("window:second", "Second Window")
    ]);
    await invoke(IPC_CHANNELS.workstationCaptureList);

    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "case-1",
        targetId: "window:first"
      })
    ).rejects.toThrow("The selected window or screen was not listed");
  });

  it("clears the listed set when the window owner changes", async () => {
    mockListSources.mockResolvedValue([
      createMockSource("window:1", "Window One")
    ]);

    const frame1 = {};
    const frame2 = {};
    event = { sender, senderFrame: frame1 } as unknown as IpcMainInvokeEvent;

    await invoke(IPC_CHANNELS.workstationCaptureList);

    // Sender frame navigates to a new owner
    event = { sender, senderFrame: frame2 } as unknown as IpcMainInvokeEvent;

    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "case-1",
        targetId: "window:1"
      })
    ).rejects.toThrow("The selected window or screen was not listed");

    // Switching back to earlier frame confirms its set was cleared upon owner transition
    event = { sender, senderFrame: frame1 } as unknown as IpcMainInvokeEvent;
    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "case-1",
        targetId: "window:1"
      })
    ).rejects.toThrow("The selected window or screen was not listed");
  });

  it("rejects when the window navigates while capture is in progress", async () => {
    let finishCapture: () => void = () => {};
    mockListSources.mockImplementation(async () => [
      createMockSource("window:1", "Active App")
    ]);

    await invoke(IPC_CHANNELS.workstationCaptureList);

    const caseFolder = path.join(testDir, "nav-case");
    await fs.mkdir(caseFolder, { recursive: true });

    mockListSources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCapture = () =>
            resolve([createMockSource("window:1", "Active App")]);
        })
    );

    const takePromise = invoke(IPC_CHANNELS.workstationCaptureTake, {
      caseId: "nav-case",
      targetId: "window:1"
    });

    await untilStubReached();

    // Navigation is what retires the owner. Swapping the test's `event` would
    // instead make the handler refuse on entry — a different check, and one
    // that rejects before the capture is even in flight.
    sender.emit("did-start-navigation", { isMainFrame: true });
    finishCapture();

    await expect(takePromise).rejects.toThrow("This window changed while capturing the screen.");
  });

  it("writes capture only inside the case folder", async () => {
    mockListSources.mockResolvedValue([
      createMockSource("window:invoice", "Quarterly Invoice")
    ]);

    await invoke(IPC_CHANNELS.workstationCaptureList);

    const caseId = "case-budget-2026";
    const caseFolder = path.join(testDir, caseId);
    await fs.mkdir(caseFolder, { recursive: true });

    const result = (await invoke(IPC_CHANNELS.workstationCaptureTake, {
      caseId,
      targetId: "window:invoice"
    })) as CaptureOutcome;

    expect(result.status).toBe("captured");
    if (result.status === "captured") {
      expect(result.pngPath.startsWith(caseFolder)).toBe(true);
      expect(path.dirname(result.pngPath)).toBe(caseFolder);
      expect(result.label).toBe("Quarterly Invoice");
      const stat = await fs.stat(result.pngPath);
      expect(stat.isFile()).toBe(true);
    }
  });

  it("refuses concurrent captures with a plain sentence", async () => {
    let finishFirst: () => void = () => {};
    mockListSources.mockImplementation(async () => [
      createMockSource("window:1", "First Window")
    ]);

    await invoke(IPC_CHANNELS.workstationCaptureList);

    const caseFolder = path.join(testDir, "concurrency-case");
    await fs.mkdir(caseFolder, { recursive: true });

    mockListSources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () =>
            resolve([createMockSource("window:1", "First Window")]);
        })
    );

    const firstPromise = invoke(IPC_CHANNELS.workstationCaptureTake, {
      caseId: "concurrency-case",
      targetId: "window:1"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationCaptureTake, {
        caseId: "concurrency-case",
        targetId: "window:1"
      })
    ).rejects.toThrow("A screen capture is already running. Wait for it to finish.");

    await untilStubReached();

    finishFirst();
    const firstResult = (await firstPromise) as CaptureOutcome;
    expect(firstResult.status).toBe("captured");
  });

  it("returns unavailable status when capture directory fails without leaking paths", async () => {
    mockListSources.mockResolvedValue([
      createMockSource("window:1", "Window One")
    ]);

    await invoke(IPC_CHANNELS.workstationCaptureList);

    mockCaptureDir.mockRejectedValueOnce(new Error("Disk error on /private/secret/path"));

    const result = (await invoke(IPC_CHANNELS.workstationCaptureTake, {
      caseId: "case-error",
      targetId: "window:1"
    })) as CaptureOutcome;

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The destination folder for this work is not available.");
      expect(result.reason).not.toMatch(/Disk error/);
      expect(result.reason).not.toMatch(/secret/);
    }
  });

  it("contains no timer or interval anywhere in the module source", async () => {
    const filePath = fileURLToPath(new URL("./capture-ipc.ts", import.meta.url));
    const source = await fs.readFile(filePath, "utf8");

    expect(source).not.toMatch(/\bsetInterval\b/);
    expect(source).not.toMatch(/\bsetTimeout\b/);
    expect(source).not.toMatch(/\bsetImmediate\b/);
  });
});
