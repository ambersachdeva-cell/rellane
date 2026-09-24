import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installDictation,
  isWavHeader,
  WORKSTATION_DICTATION_MAX_BASE64_CHARS,
  type InstallDictationOptions
} from "./dictation-ipc.js";

type HandlerFn = (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;

const handlers = new Map<string, HandlerFn>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: HandlerFn) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    })
  }
}));

function createSampleWavBytes(): Uint8Array {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    36, 0, 0, 0,             // Size (36 bytes after chunk)
    0x57, 0x41, 0x56, 0x45, // 'WAVE'
    0x66, 0x6d, 0x74, 0x20, // 'fmt '
    16, 0, 0, 0,             // Subchunk1Size (16 for PCM)
    1, 0,                    // AudioFormat (1 for PCM)
    1, 0,                    // NumChannels (1)
    0x80, 0x3e, 0, 0,        // SampleRate (16000)
    0x00, 0x7d, 0, 0,        // ByteRate (32000)
    2, 0,                    // BlockAlign (2)
    16, 0,                   // BitsPerSample (16)
    0x64, 0x61, 0x74, 0x61, // 'data'
    0, 0, 0, 0               // Subchunk2Size (0)
  ]);
}

const fakeEvent = {
  frameId: 1,
  processId: 1
} as unknown as IpcMainInvokeEvent;

describe("dictation-ipc", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("imports no network modules and makes no network calls", async () => {
    const currentFile = fileURLToPath(import.meta.url);
    const targetFile = path.resolve(path.dirname(currentFile), "dictation-ipc.ts");
    const content = await fs.readFile(targetFile, "utf-8");

    const forbiddenModules = [
      "http",
      "https",
      "net",
      "dgram",
      "tls",
      "dns",
      "fetch",
      "axios",
      "got",
      "node-fetch",
      "undici",
      "ws",
      "child_process"
    ];

    for (const mod of forbiddenModules) {
      expect(content).not.toMatch(new RegExp(`from\\s+["'](node:)?${mod}["']`));
      expect(content).not.toMatch(new RegExp(`require\\(["'](node:)?${mod}["']\\)`));
    }

    const importLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));

    for (const line of importLines) {
      const isApproved =
        line.includes("electron") ||
        line.includes("zod") ||
        line.includes("node:buffer") ||
        line.includes("./") ||
        line.includes("../");
      expect(isApproved).toBe(true);
    }
  });

  it("identifies valid and invalid WAV headers", () => {
    expect(isWavHeader(createSampleWavBytes())).toBe(true);

    const shortBuffer = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    expect(isWavHeader(shortBuffer)).toBe(false);

    const wrongRiff = createSampleWavBytes();
    const wrongRiffMutated = new Uint8Array(wrongRiff);
    expect(wrongRiffMutated.length).toBeGreaterThan(0);
    wrongRiffMutated[0] = 0x58;
    expect(isWavHeader(wrongRiffMutated)).toBe(false);

    const wrongWave = createSampleWavBytes();
    const wrongWaveMutated = new Uint8Array(wrongWave);
    expect(wrongWaveMutated.length).toBeGreaterThan(8);
    wrongWaveMutated[8] = 0x58;
    expect(isWavHeader(wrongWaveMutated)).toBe(false);
  });

  it("observes speech model status on status channel", async () => {
    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: true,
        detail: "Local whisper model is ready."
      }),
      transcribe: vi.fn()
    };

    installDictation(options);

    const statusHandler = handlers.get(IPC_CHANNELS.workstationDictationStatus);
    expect(statusHandler).toBeDefined();

    const result = await statusHandler!(fakeEvent);
    expect(options.assertTrusted).toHaveBeenCalledWith(fakeEvent);
    expect(result).toEqual({
      ready: true,
      detail: "Local whisper model is ready."
    });
  });

  it("transcribes a small valid WAV through stub and returns text", async () => {
    const sampleWav = createSampleWavBytes();
    const wavBase64 = Buffer.from(sampleWav).toString("base64");

    const transcribeMock = vi.fn().mockResolvedValue({
      text: "Please review the quarterly report.",
      durationMs: 1800,
      segments: [{ text: "Please review the quarterly report." }]
    });

    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: true,
        detail: "Model ready."
      }),
      transcribe: transcribeMock
    };

    installDictation(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    expect(writeHandler).toBeDefined();

    const result = await writeHandler!(fakeEvent, { wavBase64 });
    expect(options.assertTrusted).toHaveBeenCalledWith(fakeEvent);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "transcribed",
      text: "Please review the quarterly report.",
      durationMs: 1800
    });
  });

  it("refuses non-WAV payload without calling transcription stub", async () => {
    const transcribeMock = vi.fn();
    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: true,
        detail: "Model ready."
      }),
      transcribe: transcribeMock
    };

    installDictation(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    expect(writeHandler).toBeDefined();

    const invalidBase64 = Buffer.from("Plain text content that is not audio").toString("base64");
    const result = await writeHandler!(fakeEvent, { wavBase64: invalidBase64 });

    expect(result).toEqual({
      status: "unavailable",
      reason: "That did not look like a recording."
    });
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("refuses audio when no model is installed without calling transcription stub", async () => {
    const transcribeMock = vi.fn();
    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: false,
        detail: "No speech model is installed on this Mac. Download the model in settings before dictating."
      }),
      transcribe: transcribeMock
    };

    installDictation(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    expect(writeHandler).toBeDefined();

    const wavBase64 = Buffer.from(createSampleWavBytes()).toString("base64");
    const result = await writeHandler!(fakeEvent, { wavBase64 });

    expect(result).toEqual({
      status: "unavailable",
      reason: "No speech model is installed on this Mac. Download the model in settings before dictating."
    });
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("refuses oversize base64 audio above 25 MB", async () => {
    const transcribeMock = vi.fn();
    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: true,
        detail: "Model ready."
      }),
      transcribe: transcribeMock
    };

    installDictation(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    expect(writeHandler).toBeDefined();

    const oversizePayload = "A".repeat(WORKSTATION_DICTATION_MAX_BASE64_CHARS + 1);
    const result = await writeHandler!(fakeEvent, { wavBase64: oversizePayload });

    expect(result).toEqual({
      status: "unavailable",
      reason: "That is longer than this can take in one go. Try a shorter recording."
    });
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("refuses concurrent transcription requests while one is in flight", async () => {
    let resolveTranscription: ((
      value: {
        readonly text: string;
        readonly durationMs: number;
        readonly segments: readonly { readonly text: string }[];
      }
    ) => void) | null = null;

    const transcribePromise = new Promise<{
      readonly text: string;
      readonly durationMs: number;
      readonly segments: readonly { readonly text: string }[];
    }>((resolve) => {
      resolveTranscription = resolve;
    });

    const transcribeMock = vi.fn().mockImplementation(() => transcribePromise);
    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: true,
        detail: "Model ready."
      }),
      transcribe: transcribeMock
    };

    installDictation(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    expect(writeHandler).toBeDefined();

    const wavBase64 = Buffer.from(createSampleWavBytes()).toString("base64");

    const firstCall = writeHandler!(fakeEvent, { wavBase64 });
    const secondCallResult = await writeHandler!(fakeEvent, { wavBase64 });

    expect(secondCallResult).toEqual({
      status: "unavailable",
      reason: "A recording is already being transcribed. Wait for it to finish before starting another."
    });

    expect(resolveTranscription).not.toBeNull();
    resolveTranscription!({
      text: "Transcription complete",
      durationMs: 950,
      segments: [{ text: "Transcription complete" }]
    });

    const firstResult = await firstCall;
    expect(firstResult).toEqual({
      status: "transcribed",
      text: "Transcription complete",
      durationMs: 950
    });
  });

  it("aborts in-flight transcription when stop is called", async () => {
    let observedSignal: AbortSignal | null = null;

    const transcribeMock = vi.fn().mockImplementation((_wav: Uint8Array, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<{
        readonly text: string;
        readonly durationMs: number;
        readonly segments: readonly { readonly text: string }[];
      }>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("Transcription aborted"));
        });
      });
    });

    const options: InstallDictationOptions = {
      assertTrusted: vi.fn(),
      modelReady: vi.fn().mockResolvedValue({
        ready: true,
        detail: "Model ready."
      }),
      transcribe: transcribeMock
    };

    installDictation(options);

    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    const stopHandler = handlers.get(IPC_CHANNELS.workstationDictationStop);
    expect(writeHandler).toBeDefined();
    expect(stopHandler).toBeDefined();

    const wavBase64 = Buffer.from(createSampleWavBytes()).toString("base64");
    const writePromise = writeHandler!(fakeEvent, { wavBase64 });

    // The signal is only handed over once the handler has validated the audio
    // and reached the stub, which it does asynchronously. Reading it straight
    // after `invoke` races that, and the race is usually lost.
    for (let attempt = 0; attempt < 400 && observedSignal === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(false);

    const stopResult = await stopHandler!(fakeEvent);
    expect(stopResult).toEqual({
      status: "stopped"
    });
    expect(observedSignal!.aborted).toBe(true);

    const writeResult = await writePromise;
    expect(writeResult).toEqual({
      status: "unavailable",
      reason: "Transcription was stopped."
    });
  });

  it("enforces trusted caller check on all channels", async () => {
    const assertTrustedMock = vi.fn().mockImplementation(() => {
      throw new Error("Untrusted caller rejected");
    });

    const options: InstallDictationOptions = {
      assertTrusted: assertTrustedMock,
      modelReady: vi.fn().mockResolvedValue({ ready: true, detail: "Ready." }),
      transcribe: vi.fn()
    };

    installDictation(options);

    const statusHandler = handlers.get(IPC_CHANNELS.workstationDictationStatus);
    const writeHandler = handlers.get(IPC_CHANNELS.workstationDictationWrite);
    const stopHandler = handlers.get(IPC_CHANNELS.workstationDictationStop);

    expect(statusHandler).toBeDefined();
    expect(writeHandler).toBeDefined();
    expect(stopHandler).toBeDefined();

    await expect(statusHandler!(fakeEvent)).rejects.toThrow("Untrusted caller rejected");
    await expect(writeHandler!(fakeEvent, { wavBase64: "dGVzdA==" })).rejects.toThrow("Untrusted caller rejected");
    await expect(stopHandler!(fakeEvent)).rejects.toThrow("Untrusted caller rejected");
  });
});
