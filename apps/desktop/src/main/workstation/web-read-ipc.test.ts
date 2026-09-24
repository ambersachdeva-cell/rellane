import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { WebReadOutcome, WebReadResult } from "./web-read.js";
import { installWorkstationWebRead } from "./web-read-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
  mockRead: vi.fn<(raw: string, now: number) => Promise<WebReadOutcome>>()
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => {
      f.handlers.set(name, handler);
    }
  }
}));

vi.mock("./web-read.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./web-read.js")>();
  return {
    ...mod,
    readWebPage: f.mockRead
  };
});

describe("Workstation web read IPC", () => {
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;

  const invoke = (channel: string, input: unknown): Promise<unknown> => {
    const handler = f.handlers.get(channel);
    if (!handler) {
      throw new Error(`Handler for channel ${channel} is not registered.`);
    }
    return Promise.resolve().then(() => handler(event, input));
  };

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    f.mockRead.mockResolvedValue({
      status: "read",
      url: "https://example.com/article",
      title: "Sample Article",
      text: "Article text content",
      bytes: 1024,
      truncated: false,
      fetchedAt: 1700000000000
    });

    installWorkstationWebRead({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      }
    });
  });

  it("rejects untrusted sender before any work is performed", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationWebRead, { url: "https://example.com/article" })
    ).rejects.toThrow("Untrusted sender");
    expect(f.mockRead).not.toHaveBeenCalled();
  });

  it("refuses an oversize url via the schema before reading", async () => {
    const hugeUrl = `https://example.com/${'x'.repeat(2001)}`;
    await expect(
      invoke(IPC_CHANNELS.workstationWebRead, { url: hugeUrl })
    ).rejects.toThrow();
    expect(f.mockRead).not.toHaveBeenCalled();
  });

  it("refuses an oversize string payload via the schema before reading", async () => {
    const hugeUrl = `https://example.com/${'x'.repeat(2001)}`;
    await expect(
      invoke(IPC_CHANNELS.workstationWebRead, hugeUrl)
    ).rejects.toThrow();
    expect(f.mockRead).not.toHaveBeenCalled();
  });

  it("refuses input objects containing unexpected parameters", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationWebRead, {
        url: "https://example.com/article",
        allowPrivate: true
      })
    ).rejects.toThrow();
    expect(f.mockRead).not.toHaveBeenCalled();
  });

  it("enforces a single in-flight read at a time and refuses a second concurrent read", async () => {
    let finishFirst: () => void = () => {};
    f.mockRead.mockImplementationOnce(
      () =>
        new Promise<WebReadResult>((resolve) => {
          finishFirst = () =>
            resolve({
              status: "read",
              url: "https://example.com/page1",
              title: "Page One",
              text: "Content one",
              bytes: 256,
              truncated: false,
              fetchedAt: 1700000000000
            });
        })
    );

    const firstPromise = invoke(IPC_CHANNELS.workstationWebRead, {
      url: "https://example.com/page1"
    });

    await expect(
      invoke(IPC_CHANNELS.workstationWebRead, {
        url: "https://example.com/page2"
      })
    ).rejects.toThrow("already running");

    finishFirst();
    const result = await firstPromise;
    expect(result).toEqual(
      expect.objectContaining({
        status: "read",
        url: "https://example.com/page1"
      })
    );
  });

  it("refuses completion if the window changed while reading the web page", async () => {
    f.mockRead.mockImplementationOnce(async () => {
      // Simulate frame or window navigation mid-operation by assigning new sender and frame references.
      (event as { sender: unknown }).sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
      (event as { senderFrame: unknown }).senderFrame = {};
      return {
        status: "read",
        url: "https://example.com/sensitive",
        title: "Sensitive Page",
        text: "Private text that must not reach navigated window",
        bytes: 512,
        truncated: false,
        fetchedAt: 1700000000000
      };
    });

    await expect(
      invoke(IPC_CHANNELS.workstationWebRead, {
        url: "https://example.com/sensitive"
      })
    ).rejects.toThrow("This window changed while reading the web page.");
  });

  it("returns a refusal as a value and does not throw", async () => {
    f.mockRead.mockResolvedValueOnce({
      status: "refused",
      reason: "Web addresses pointing to your local network are not allowed."
    });

    const result = await invoke(IPC_CHANNELS.workstationWebRead, {
      url: "http://127.0.0.1/admin"
    });

    expect(result).toEqual({
      status: "refused",
      reason: "Web addresses pointing to your local network are not allowed."
    });
  });

  it("returns the final url after redirects rather than the requested url", async () => {
    f.mockRead.mockResolvedValueOnce({
      status: "read",
      url: "https://destination.org/final-destination",
      title: "Final Destination",
      text: "Redirected body text",
      bytes: 2048,
      truncated: false,
      fetchedAt: 1700000000000
    });

    const result = await invoke(IPC_CHANNELS.workstationWebRead, {
      url: "https://short.link/hop"
    });

    expect(result).toEqual({
      status: "read",
      url: "https://destination.org/final-destination",
      title: "Final Destination",
      text: "Redirected body text",
      bytes: 2048,
      truncated: false,
      fetchedAt: 1700000000000
    });
  });

  it("contains no option, parameter, or configuration in source that could permit a private or local host", () => {
    const sourcePath = fileURLToPath(new URL("./web-read-ipc.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");

    // Why: The channel must expose zero mechanisms or options to bypass private network protection.
    expect(source).not.toMatch(/allowPrivate|allowLocal|allowLoopback|bypassPrivate|insecure|disableDns/i);
    expect(source).toMatch(/readWebPage/);
    expect(source).toMatch(/private/i);
  });
});
