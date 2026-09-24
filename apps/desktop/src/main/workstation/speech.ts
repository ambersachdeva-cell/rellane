/**
 * Speech synthesis via local vendored llama-tts.
 *
 * Runs bounded on this Mac with no cloud calls, accounts, or telemetry.
 * Preconditions are verified before spawning: text bounds, output directory,
 * executable availability, and voice model presence.
 *
 * Temporary input text is written to the output directory and cleaned up
 * on all paths. Produced audio files are validated for size and RIFF header
 * integrity before reporting success.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface SpeechRuntimeOptions {
  /** Absolute path to the vendored llama-tts. Supplied by the host; never guessed here. */
  readonly executablePath?: string;
  /** Absolute path to the voice model. Absent means no voice is installed. */
  readonly modelPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type SpeechResult =
  | { readonly status: "spoken"; readonly wavPath: string; readonly bytes: number; readonly runtime: string }
  | { readonly status: "unavailable"; readonly reason: string };

export const MAX_SPEECH_CHARS = 8_000;
export const MAX_WAV_BYTES = 33_554_432;
export const SPEECH_TIMEOUT_MS = 120_000;

function unavailable(reason: string): SpeechResult {
  return { status: "unavailable", reason };
}

export async function speak(input: {
  readonly text: string;
  readonly outputDir: string;
  readonly runtimeOptions?: SpeechRuntimeOptions;
}): Promise<SpeechResult> {
  if (input.text.trim().length === 0) {
    return unavailable("No text was provided to read aloud.");
  }
  if (input.text.length > MAX_SPEECH_CHARS) {
    return unavailable("The text is too long to read aloud in one go.");
  }

  const executablePath = input.runtimeOptions?.executablePath;
  if (!executablePath || !existsSync(executablePath)) {
    return unavailable("The speech synthesiser is not available on this Mac.");
  }

  const modelPath = input.runtimeOptions?.modelPath;
  if (!modelPath || !existsSync(modelPath)) {
    return unavailable("No voice is installed on this Mac yet.");
  }

  try {
    const dirStat = await fs.stat(input.outputDir);
    if (!dirStat.isDirectory()) {
      return unavailable("The output directory does not exist or is not a directory.");
    }
  } catch {
    return unavailable("The output directory does not exist or is not a directory.");
  }

  const timeoutMs = input.runtimeOptions?.timeoutMs ?? SPEECH_TIMEOUT_MS;
  const maxOutputBytes = input.runtimeOptions?.maxOutputBytes ?? MAX_WAV_BYTES;
  const wavPath = path.join(input.outputDir, "output.wav");
  const tempInputPath = path.join(
    input.outputDir,
    `speech-input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );

  try {
    await fs.rm(wavPath, { force: true }).catch(() => {});
    await fs.writeFile(tempInputPath, input.text, "utf8");

    const childResult = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly timedOut: boolean;
      readonly startError: boolean;
    }>((resolve) => {
      let timedOut = false;
      let startError = false;
      let timer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (result: {
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly timedOut: boolean;
        readonly startError: boolean;
      }): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (killTimer !== null) clearTimeout(killTimer);
        resolve(result);
      };

      const child = spawn(
        executablePath,
        ["--model", modelPath, "--file", tempInputPath, "--output", wavPath],
        {
          cwd: input.outputDir,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );

      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 500);
      }, timeoutMs);

      child.stdout?.on("data", () => {});
      child.stderr?.on("data", () => {});

      child.on("error", () => {
        startError = true;
      });

      child.on("close", (code, signal) => {
        finish({ exitCode: code, signal, timedOut, startError });
      });
    });

    if (childResult.startError) {
      return unavailable("The speech synthesiser could not be started.");
    }
    if (childResult.timedOut) {
      return unavailable("The speech synthesiser ran out of time and was stopped.");
    }
    if (childResult.exitCode !== 0 || childResult.signal !== null) {
      return unavailable("The speech synthesiser did not finish cleanly.");
    }

    let stat;
    try {
      stat = await fs.stat(wavPath);
    } catch {
      return unavailable("The speech synthesiser did not produce an audio file.");
    }

    if (!stat.isFile()) {
      return unavailable("The speech output is not a regular file.");
    }
    if (stat.size === 0) {
      return unavailable("The speech output file was empty.");
    }
    if (stat.size > maxOutputBytes) {
      return unavailable("The speech output exceeded the maximum allowed file size.");
    }

    let header = "";
    try {
      const fd = await fs.open(wavPath, "r");
      try {
        const buffer = Buffer.alloc(4);
        const { bytesRead } = await fd.read(buffer, 0, 4, 0);
        if (bytesRead === 4) {
          header = buffer.toString("ascii");
        }
      } finally {
        await fd.close();
      }
    } catch {
      return unavailable("The speech output was not a valid audio file.");
    }

    if (header !== "RIFF") {
      return unavailable("The speech output was not a valid audio file.");
    }

    return {
      status: "spoken",
      wavPath,
      bytes: stat.size,
      runtime: executablePath
    };
  } catch {
    return unavailable("The speech synthesiser could not complete the request.");
  } finally {
    await fs.rm(tempInputPath, { force: true }).catch(() => {});
  }
}
