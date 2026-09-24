import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SPEECH_CHARS } from "./speech.js";
import {
  WORKSTATION_SPEECH_CHANNEL,
  defaultSpeechRuntimeOptions,
  installWorkstationSpeech
} from "./speech-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  mockSpeak: vi.fn()
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/synthetic/desktop" },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      f.handlers.set(name, handler);
    }
  }
}));

vi.mock("./speech.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./speech.js")>();
  return {
    ...mod,
    speak: f.mockSpeak
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

describe("Workstation speech IPC", () => {
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let trusted: boolean;
  let tempUserDataDir: string;

  const invoke = (input: unknown) =>
    Promise.resolve().then(() => f.handlers.get(WORKSTATION_SPEECH_CHANNEL)!(event, input));

  beforeEach(() => {
    vi.resetAllMocks();
    f.handlers.clear();
    trusted = true;
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "speech-ipc-test-"));
    sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    f.mockSpeak.mockResolvedValue({
      status: "spoken",
      wavPath: path.join(tempUserDataDir, "speech", "output.wav"),
      bytes: 1024,
      runtime: "/synthetic/desktop/vendor/llama-b10182/llama-tts"
    });
    installWorkstationSpeech({
      userData: () => tempUserDataDir,
      assertTrusted: () => {
        if (!trusted) throw new Error("Untrusted sender");
      }
    });
  });

  afterEach(() => {
    fs.rmSync(tempUserDataDir, { recursive: true, force: true });
  });

  it("rejects untrusted sender before speaking or writing files", async () => {
    trusted = false;
    await expect(invoke({ text: "Read this aloud" })).rejects.toThrow("Untrusted sender");
    expect(f.mockSpeak).not.toHaveBeenCalled();
  });

  it("rejects oversize text by the schema before speaking", async () => {
    const oversize = "a".repeat(MAX_SPEECH_CHARS + 1);
    await expect(invoke({ text: oversize })).rejects.toThrow();
    expect(f.mockSpeak).not.toHaveBeenCalled();
  });

  it("enforces single in-flight speech synthesis request at a time", async () => {
    let finishFirst: () => void = () => {};
    f.mockSpeak.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () =>
            resolve({
              status: "spoken",
              wavPath: path.join(tempUserDataDir, "speech", "output.wav"),
              bytes: 1024,
              runtime: "/synthetic/desktop/vendor/llama-b10182/llama-tts"
            });
        })
    );

    const firstPromise = invoke({ text: "First utterance" });

    // The guard is set by the handler, not by `invoke` returning. Asking for a
    // second utterance before the first has reached the stub races it, and the
    // second one wins often enough to hang the suite rather than fail it.
    await untilCalled(f.mockSpeak);

    await expect(invoke({ text: "Second utterance" })).rejects.toThrow(
      "Speech synthesis is already running. Wait for it to finish."
    );

    finishFirst();
    await firstPromise;
  });

  it("refuses if sender window owner changes mid-run", async () => {
    f.mockSpeak.mockImplementationOnce(async () => {
      (event as { senderFrame: unknown }).senderFrame = {};
      return {
        status: "spoken",
        wavPath: path.join(tempUserDataDir, "speech", "output.wav"),
        bytes: 1024,
        runtime: "/synthetic/desktop/vendor/llama-b10182/llama-tts"
      };
    });

    await expect(invoke({ text: "Speech text" })).rejects.toThrow(
      "This window changed while reading aloud."
    );
  });

  it("passes through a successful spoken result", async () => {
    const expected = {
      status: "spoken" as const,
      wavPath: path.join(tempUserDataDir, "speech", "output.wav"),
      bytes: 2048,
      runtime: "/synthetic/desktop/vendor/llama-b10182/llama-tts"
    };
    f.mockSpeak.mockResolvedValueOnce(expected);

    const result = await invoke({ text: "Valid speech text" });
    expect(result).toEqual(expected);
  });

  it("passes through unavailable status as a value rather than throwing", async () => {
    f.mockSpeak.mockResolvedValueOnce({
      status: "unavailable" as const,
      reason: "No voice is installed on this Mac yet."
    });

    const result = await invoke({ text: "Valid speech text" });
    expect(result).toEqual({
      status: "unavailable",
      reason: "No voice is installed on this Mac yet."
    });
  });

  it("sanitises reason strings containing filesystem paths", async () => {
    f.mockSpeak.mockResolvedValueOnce({
      status: "unavailable" as const,
      reason: "Executable not found at /usr/local/bin/llama-tts"
    });

    const result = (await invoke({ text: "Valid speech text" })) as {
      status: string;
      reason: string;
    };
    expect(result.status).toBe("unavailable");
    expect(result.reason).not.toContain("/");
    expect(result.reason).not.toContain("\\");
  });

  it("references no network APIs anywhere in the speech-ipc module", () => {
    const sourcePath = new URL("./speech-ipc.ts", import.meta.url);
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).not.toMatch(/\b(fetch|http|https|net|dgram|tls|websocket|axios|undici)\b/i);
    expect(source).not.toContain("fetch(");
  });

  it("resolves default runtime options dev-versus-packaged without guessing outside paths", () => {
    const devOptions = defaultSpeechRuntimeOptions();
    expect(devOptions.executablePath).toBe(
      path.join("/synthetic/desktop", "vendor", "llama-b10182", "llama-tts")
    );
    expect(devOptions.modelPath).toBeUndefined();
  });
});
