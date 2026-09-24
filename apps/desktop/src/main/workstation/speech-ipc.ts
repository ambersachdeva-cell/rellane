import type { IpcMainInvokeEvent } from "electron";
import { app, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DESKTOP_BRIDGE_VERSION } from "@cadrane/contracts";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import {
  MAX_SPEECH_CHARS,
  speak,
  type SpeechResult,
  type SpeechRuntimeOptions
} from "./speech.js";

export const WORKSTATION_SPEECH_CHANNEL =
  `cadrane:v${DESKTOP_BRIDGE_VERSION}:workstation-speech` as const;

export const WorkstationSpeechInputSchema = z.union([
  z.object({
    text: z.string().min(1).max(MAX_SPEECH_CHARS)
  }),
  z.string().min(1).max(MAX_SPEECH_CHARS).transform((text) => ({ text }))
]);

export function defaultSpeechRuntimeOptions(): SpeechRuntimeOptions {
  return {
    executablePath: app.isPackaged
      ? path.join(process.resourcesPath, "llama-b10182", "llama-tts")
      : path.join(app.getAppPath(), "vendor", "llama-b10182", "llama-tts")
  };
}

export function installWorkstationSpeech(options: {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly userData: () => string;
  readonly runtimeOptions?: SpeechRuntimeOptions;
}): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;

  const getRuntimeOptions = (): SpeechRuntimeOptions => {
    const defaults = defaultSpeechRuntimeOptions();
    if (!options.runtimeOptions) {
      return defaults;
    }
    return {
      ...(defaults.executablePath ? { executablePath: defaults.executablePath } : {}),
      ...options.runtimeOptions
    };
  };

  ipcMain.handle(WORKSTATION_SPEECH_CHANNEL, async (event, input: unknown) => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("Speech synthesis is already running. Wait for it to finish.");
    }

    const request = WorkstationSpeechInputSchema.parse(input);

    const outputDir = path.join(options.userData(), "speech");
    await fs.mkdir(outputDir, { recursive: true });

    inFlight = true;
    try {
      const result = await speak({
        text: request.text,
        outputDir,
        runtimeOptions: getRuntimeOptions()
      });

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while reading aloud.");
      }

      if (result.status === "unavailable") {
        const sanitizedReason =
          result.reason.includes("/") || result.reason.includes("\\")
            ? "The speech synthesiser could not complete the request."
            : result.reason;
        return {
          status: "unavailable",
          reason: sanitizedReason
        };
      }

      return result;
    } finally {
      inFlight = false;
    }
  });
}
