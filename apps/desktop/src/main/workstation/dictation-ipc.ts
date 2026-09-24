import { Buffer } from "node:buffer";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";

/**
 * Maximum accepted base64 string length for audio intake across the IPC bridge.
 *
 * 25 MB of base64 represents roughly 18.75 MB of decoded audio, providing ample room
 * for several minutes of 16-bit uncompressed WAV recording without stressing host memory.
 */
export const WORKSTATION_DICTATION_MAX_BASE64_CHARS = 25 * 1024 * 1024;

export const WorkstationDictationWriteInputSchema = z.object({
  wavBase64: z.string()
});

export type WorkstationDictationWriteInput = z.infer<typeof WorkstationDictationWriteInputSchema>;

export type WorkstationDictationStatusResult = {
  readonly ready: boolean;
  readonly detail: string;
};

export type WorkstationDictationWriteResult =
  | {
      readonly status: "transcribed";
      readonly text: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export type WorkstationDictationStopResult = {
  readonly status: "stopped";
};

export interface InstallDictationOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  /** Transcribes WAV bytes locally. Resolves with the text and its segments. */
  readonly transcribe: (wav: Uint8Array, signal: AbortSignal) => Promise<{
    readonly text: string;
    readonly durationMs: number;
    readonly segments: readonly { readonly text: string }[];
  }>;
  /** Whether a local speech model is installed, checked now rather than assumed. */
  readonly modelReady: () => Promise<{ readonly ready: boolean; readonly detail: string }>;
}

/**
 * Verifies that the buffer starts with the standard RIFF/WAVE container signature.
 *
 * Audio is validated at the container boundary to catch malformed payloads before
 * passing bytes to the native transcription runtime.
 */
export function isWavHeader(buffer: Uint8Array): boolean {
  if (buffer.length < 12) {
    return false;
  }

  // Containers that do not declare the RIFF form type cannot be decoded by the PCM pipeline.
  if (
    buffer[0]! !== 0x52 ||
    buffer[1]! !== 0x49 ||
    buffer[2]! !== 0x46 ||
    buffer[3]! !== 0x46
  ) {
    return false;
  }

  // Sub-format must declare WAVE; non-audio RIFF forms (such as AVI) are rejected here.
  if (
    buffer[8]! !== 0x57 ||
    buffer[9]! !== 0x41 ||
    buffer[10]! !== 0x56 ||
    buffer[11]! !== 0x45
  ) {
    return false;
  }

  return true;
}

export function installDictation(options: InstallDictationOptions): void {
  let activeController: AbortController | null = null;

  ipcMain.handle(
    IPC_CHANNELS.workstationDictationStatus,
    async (event: IpcMainInvokeEvent): Promise<WorkstationDictationStatusResult> => {
      options.assertTrusted(event);

      try {
        const status = await options.modelReady();
        return {
          ready: status.ready,
          detail: status.detail
        };
      } catch {
        return {
          ready: false,
          detail: "The speech model is currently unavailable."
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationDictationWrite,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<WorkstationDictationWriteResult> => {
      options.assertTrusted(event);

      const parsed = WorkstationDictationWriteInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "unavailable",
          reason: "That did not look like a recording."
        };
      }

      const { wavBase64 } = parsed.data;

      if (wavBase64.length > WORKSTATION_DICTATION_MAX_BASE64_CHARS) {
        return {
          status: "unavailable",
          reason: "That is longer than this can take in one go. Try a shorter recording."
        };
      }

      let buffer: Buffer;
      try {
        buffer = Buffer.from(wavBase64, "base64");
      } catch {
        return {
          status: "unavailable",
          reason: "That did not look like a recording."
        };
      }

      if (!isWavHeader(buffer)) {
        return {
          status: "unavailable",
          reason: "That did not look like a recording."
        };
      }

      if (activeController !== null) {
        return {
          status: "unavailable",
          reason: "A recording is already being transcribed. Wait for it to finish before starting another."
        };
      }

      let modelStatus: { readonly ready: boolean; readonly detail: string };
      try {
        modelStatus = await options.modelReady();
      } catch {
        return {
          status: "unavailable",
          reason: "The speech model is currently unavailable."
        };
      }

      if (!modelStatus.ready) {
        return {
          status: "unavailable",
          reason:
            modelStatus.detail.length > 0
              ? modelStatus.detail
              : "No speech model is installed on this Mac. Please install a model to dictate."
        };
      }

      if (activeController !== null) {
        return {
          status: "unavailable",
          reason: "A recording is already being transcribed. Wait for it to finish before starting another."
        };
      }

      const controller = new AbortController();
      activeController = controller;

      try {
        const wavBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const result = await options.transcribe(wavBytes, controller.signal);

        return {
          status: "transcribed",
          text: result.text,
          durationMs: result.durationMs
        };
      } catch {
        if (controller.signal.aborted) {
          return {
            status: "unavailable",
            reason: "Transcription was stopped."
          };
        }
        return {
          status: "unavailable",
          reason: "The recording could not be transcribed."
        };
      } finally {
        if (activeController === controller) {
          activeController = null;
        }
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.workstationDictationStop,
    async (event: IpcMainInvokeEvent): Promise<WorkstationDictationStopResult> => {
      options.assertTrusted(event);

      if (activeController !== null) {
        activeController.abort();
        activeController = null;
      }

      return {
        status: "stopped"
      };
    }
  );
}
