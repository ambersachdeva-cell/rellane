import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { analysePaste, MAX_PASTE_CHARS, type PasteAnalysis } from "./paste-source.js";
import {
  installWorkstationPaste,
  WORKSTATION_PASTE_INPUT_LIMIT
} from "./paste-ipc.js";

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

describe("Workstation paste IPC", () => {
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;

  const invoke = async (
    channel: string,
    input: unknown,
    customEvent: IpcMainInvokeEvent = event
  ): Promise<unknown> => {
    const handler = f.handlers.get(channel);
    if (!handler) {
      throw new Error(`No IPC handler registered for channel: ${channel}`);
    }
    return handler(customEvent, input);
  };

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;

    installWorkstationPaste({
      assertTrusted: () => {
        if (!trusted) {
          throw new Error("Untrusted sender");
        }
      }
    });
  });

  it("rejects untrusted sender before input is processed", async () => {
    trusted = false;
    await expect(
      invoke(IPC_CHANNELS.workstationPasteAnalyse, { text: "Sensitive paste" })
    ).rejects.toThrow("Untrusted sender");
  });

  it("produces the module's own report rather than a schema throw when text is oversize", async () => {
    const oversizeText = "A".repeat(MAX_PASTE_CHARS + 1);
    const result = (await invoke(IPC_CHANNELS.workstationPasteAnalyse, {
      text: oversizeText
    })) as PasteAnalysis;

    expect(result.chars).toBe(MAX_PASTE_CHARS + 1);
    expect(result.warnings).toContain("This paste exceeds the limit of 500,000 characters.");
  });

  it("returns the analysis unmodified for recognized content", async () => {
    const csvContent = "item,price,quantity\nWidget,1200,4\nGadget,2500,2";
    const result = (await invoke(IPC_CHANNELS.workstationPasteAnalyse, {
      text: csvContent
    })) as PasteAnalysis;

    const directAnalysis = analysePaste(csvContent);
    expect(result).toEqual(directAnalysis);
    expect(result.kind).toBe("csv");
    expect(result.title).toBe("item");
  });

  it("writes nothing and does not import filesystem or logging modules in source", () => {
    const source = readFileSync(new URL("./paste-ipc.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:from\s+["']node:fs(?:\/promises)?["']|from\s+["']fs(?:\/promises)?["'])\b/);
    expect(source).not.toMatch(/\b(?:require\(["']fs["']\)|require\(["']node:fs["']\))\b/);
    expect(source).not.toMatch(/\bconsole\.(?:log|info|warn|error|debug)\b/);
  });

  it("ensures secret and key warnings survive to the caller", async () => {
    const tokenText = "api_key = \"sk-proj-abcdefghijklmnopqrstuvwxyz123456\"";
    const tokenResult = (await invoke(IPC_CHANNELS.workstationPasteAnalyse, {
      text: tokenText
    })) as PasteAnalysis;
    expect(tokenResult.warnings).toContain(
      "This paste appears to contain an API token or authentication secret."
    );

    const keyText = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGPCMEAwEHATA=\n-----END PRIVATE KEY-----";
    const keyResult = (await invoke(IPC_CHANNELS.workstationPasteAnalyse, {
      text: keyText
    })) as PasteAnalysis;
    expect(keyResult.warnings).toContain("This paste appears to contain a private key.");
  });

  it("rejects input exceeding the upper boundary schema limit", async () => {
    const runawayText = "x".repeat(WORKSTATION_PASTE_INPUT_LIMIT + 1);
    await expect(
      invoke(IPC_CHANNELS.workstationPasteAnalyse, { text: runawayText })
    ).rejects.toThrow();
  });

  it("rejects malformed non-string payloads at the schema boundary", async () => {
    await expect(
      invoke(IPC_CHANNELS.workstationPasteAnalyse, { text: 12345 })
    ).rejects.toThrow();
    await expect(
      invoke(IPC_CHANNELS.workstationPasteAnalyse, null)
    ).rejects.toThrow();
  });

  it("re-checks sender trust after analysis", async () => {
    let trustCheckCount = 0;
    f.handlers.clear();
    installWorkstationPaste({
      assertTrusted: () => {
        trustCheckCount++;
        if (trustCheckCount > 1) {
          throw new Error("Sender trust revoked after analysis");
        }
      }
    });

    await expect(
      invoke(IPC_CHANNELS.workstationPasteAnalyse, { text: "Plain text" })
    ).rejects.toThrow("Sender trust revoked after analysis");
    expect(trustCheckCount).toBe(2);
  });

  it("rejects when the window navigates mid-operation", async () => {
    let frameAccessCount = 0;
    const dynamicEvent = {
      sender,
      get senderFrame() {
        frameAccessCount++;
        return frameAccessCount <= 1 ? { frameId: 1 } : { frameId: 2 };
      }
    } as unknown as IpcMainInvokeEvent;

    await expect(
      invoke(IPC_CHANNELS.workstationPasteAnalyse, { text: "Hello" }, dynamicEvent)
    ).rejects.toThrow("This window changed while analysing the paste.");
  });
});
