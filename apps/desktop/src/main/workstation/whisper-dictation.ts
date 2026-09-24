/**
 * Speech intake, voice activity detection, silence trimming and Whisper CLI bridge for Rellane workstation sessions.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AudioWavHeader {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  readonly durationSeconds: number;
}

export interface TranscriptSegment {
  readonly id: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  readonly confidence?: number;
}

export interface TranscriptionResult {
  readonly success: boolean;
  readonly text: string;
  readonly durationSeconds: number;
  readonly segments: readonly TranscriptSegment[];
  readonly language?: string;
  readonly errorDetail?: string;
}

interface WhisperJsonSegment {
  readonly timestamps?: {
    readonly from?: string;
    readonly to?: string;
  };
  readonly offsets?: {
    readonly from?: number;
    readonly to?: number;
  };
  readonly text?: string;
}

interface WhisperJsonOutput {
  readonly result?: {
    readonly language?: string;
  };
  readonly transcription?: readonly WhisperJsonSegment[];
}

/**
 * Parses and validates a RIFF WAV container, enforcing 16-bit PCM at 16kHz or 44.1kHz.
 */
export function parseWavHeader(buffer: Uint8Array): AudioWavHeader | null {
  if (buffer.length < 20) {
    return null;
  }

  // Magic byte validation ensures unrecognised containers fail before chunk traversal
  if (
    buffer[0]! !== 0x52 || // 'R'
    buffer[1]! !== 0x49 || // 'I'
    buffer[2]! !== 0x46 || // 'F'
    buffer[3]! !== 0x46    // 'F'
  ) {
    return null;
  }

  if (
    buffer[8]! !== 0x57 ||  // 'W'
    buffer[9]! !== 0x41 ||  // 'A'
    buffer[10]! !== 0x56 || // 'V'
    buffer[11]! !== 0x45    // 'E'
  ) {
    return null;
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let offset = 12;
  let fmtParsed = false;
  let dataParsed = false;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  while (offset + 8 <= buffer.length) {
    const c0 = buffer[offset]!;
    const c1 = buffer[offset + 1]!;
    const c2 = buffer[offset + 2]!;
    const c3 = buffer[offset + 3]!;
    const chunkSize = view.getUint32(offset + 4, true);

    offset += 8;

    // 'fmt ' chunk: 0x66, 0x6d, 0x74, 0x20
    if (c0 === 0x66 && c1 === 0x6d && c2 === 0x74 && c3 === 0x20) {
      if (chunkSize < 16 || offset + chunkSize > buffer.length) {
        return null;
      }
      const audioFormat = view.getUint16(offset, true);
      if (audioFormat !== 1) {
        return null;
      }
      channels = view.getUint16(offset + 2, true);
      if (channels < 1 || channels > 8) {
        return null;
      }
      sampleRate = view.getUint32(offset + 4, true);
      if (sampleRate !== 16000 && sampleRate !== 44100) {
        return null;
      }
      bitsPerSample = view.getUint16(offset + 14, true);
      if (bitsPerSample !== 16) {
        return null;
      }
      fmtParsed = true;
      offset += chunkSize;
      // RIFF specification mandates 2-byte word boundary alignment
      if (chunkSize % 2 !== 0) {
        offset += 1;
      }
    } else if (c0 === 0x64 && c1 === 0x61 && c2 === 0x74 && c3 === 0x61) {
      // 'data' chunk: 0x64, 0x61, 0x74, 0x61
      if (!fmtParsed || offset + chunkSize > buffer.length) {
        return null;
      }
      dataBytes = chunkSize;
      dataParsed = true;
      offset += chunkSize;
      if (chunkSize % 2 !== 0) {
        offset += 1;
      }
    } else {
      if (offset + chunkSize > buffer.length) {
        return null;
      }
      offset += chunkSize;
      if (chunkSize % 2 !== 0) {
        offset += 1;
      }
    }
  }

  if (!fmtParsed || !dataParsed) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = channels * bytesPerSample;
  if (bytesPerFrame === 0 || dataBytes % bytesPerFrame !== 0) {
    return null;
  }

  const durationSeconds = dataBytes / (bytesPerFrame * sampleRate);

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    durationSeconds,
  };
}

/**
 * Evaluates root-mean-square energy over 20ms phoneme windows to distinguish speech from ambient noise.
 */
export function detectVoiceActivity(
  pcmSamples: Int16Array,
  sampleRate: number,
  energyThreshold?: number
): { readonly speechDurationSeconds: number; readonly hasSpeech: boolean; readonly voiceFramesCount: number } {
  if (pcmSamples.length === 0 || sampleRate <= 0) {
    return {
      speechDurationSeconds: 0,
      hasSpeech: false,
      voiceFramesCount: 0,
    };
  }

  // 20ms frames match human vocal tract transition periods
  const frameLength = Math.max(1, Math.floor(sampleRate * 0.02));
  const effectiveThreshold =
    energyThreshold !== undefined
      ? energyThreshold > 0 && energyThreshold <= 1.0
        ? energyThreshold * 32767
        : energyThreshold
      : 300;

  const totalFrames = Math.floor(pcmSamples.length / frameLength);
  let voiceFramesCount = 0;

  if (totalFrames === 0) {
    let sumSquares = 0;
    for (let i = 0; i < pcmSamples.length; i++) {
      const s = pcmSamples[i]!;
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / pcmSamples.length);
    if (rms >= effectiveThreshold) {
      voiceFramesCount = 1;
    }
  } else {
    for (let i = 0; i < totalFrames; i++) {
      const start = i * frameLength;
      let sumSquares = 0;
      for (let j = 0; j < frameLength; j++) {
        const s = pcmSamples[start + j]!;
        sumSquares += s * s;
      }
      const rms = Math.sqrt(sumSquares / frameLength);
      if (rms >= effectiveThreshold) {
        voiceFramesCount++;
      }
    }
  }

  const speechDurationSeconds = Number((voiceFramesCount * (frameLength / sampleRate)).toFixed(4));
  const hasSpeech = voiceFramesCount > 0;

  return {
    speechDurationSeconds,
    hasSpeech,
    voiceFramesCount,
  };
}

/**
 * Removes leading and trailing zero-amplitude audio frames from raw PCM buffers.
 */
export function trimSilence(pcmBuffer: Uint8Array, header: AudioWavHeader): Uint8Array {
  const bytesPerSample = Math.max(1, Math.floor(header.bitsPerSample / 8));
  const bytesPerFrame = header.channels * bytesPerSample;

  if (bytesPerFrame <= 0 || pcmBuffer.byteLength < bytesPerFrame) {
    return new Uint8Array(0);
  }

  const totalFrames = Math.floor(pcmBuffer.byteLength / bytesPerFrame);
  let firstFrame = 0;

  while (firstFrame < totalFrames) {
    const offset = firstFrame * bytesPerFrame;
    let isNull = true;
    for (let b = 0; b < bytesPerFrame; b++) {
      if (pcmBuffer[offset + b]! !== 0) {
        isNull = false;
        break;
      }
    }
    if (!isNull) {
      break;
    }
    firstFrame++;
  }

  if (firstFrame >= totalFrames) {
    return new Uint8Array(0);
  }

  let lastFrame = totalFrames - 1;
  while (lastFrame >= firstFrame) {
    const offset = lastFrame * bytesPerFrame;
    let isNull = true;
    for (let b = 0; b < bytesPerFrame; b++) {
      if (pcmBuffer[offset + b]! !== 0) {
        isNull = false;
        break;
      }
    }
    if (!isNull) {
      break;
    }
    lastFrame--;
  }

  const startByte = firstFrame * bytesPerFrame;
  const endByte = (lastFrame + 1) * bytesPerFrame;
  return pcmBuffer.slice(startByte, endByte);
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${pad(minutes)}:${pad(secs)}`;
}

function normalizeAndCapitalize(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return "";
  }
  let result = trimmed.replace(/^([a-z])/, (m) => m.toUpperCase());
  result = result.replace(/([.?!]\s+)([a-z])/g, (_, p1: string, p2: string) => `${p1}${p2.toUpperCase()}`);
  return result;
}

function parseTimestampToSeconds(timestamp?: string): number {
  if (!timestamp) {
    return 0;
  }
  const normalized = timestamp.replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length === 3) {
    const h = parseFloat(parts[0]!);
    const m = parseFloat(parts[1]!);
    const s = parseFloat(parts[2]!);
    return (isNaN(h) ? 0 : h * 3600) + (isNaN(m) ? 0 : m * 60) + (isNaN(s) ? 0 : s);
  }
  if (parts.length === 2) {
    const m = parseFloat(parts[0]!);
    const s = parseFloat(parts[1]!);
    return (isNaN(m) ? 0 : m * 60) + (isNaN(s) ? 0 : s);
  }
  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val;
}

/**
 * Produces structured Markdown briefs formatted for workstation intake prompts.
 */
export function formatTranscriptAsBrief(
  result: TranscriptionResult,
  options?: { readonly title?: string; readonly category?: string }
): string {
  const title = options?.title ?? "Voice Dictation Brief";
  const normalizedText = normalizeAndCapitalize(result.text);
  const formattedDuration = formatTimestamp(result.durationSeconds);

  const lines: string[] = [`# ${title}`, ""];

  if (result.success) {
    lines.push(`- **Duration**: ${formattedDuration}`);
    if (options?.category) {
      lines.push(`- **Category**: ${options.category}`);
    }
    if (result.language) {
      lines.push(`- **Language**: ${result.language}`);
    }
    lines.push("");
    lines.push("## Overview");
    lines.push("");
    lines.push(normalizedText.length > 0 ? normalizedText : "No speech content recorded.");

    if (result.segments.length > 0) {
      lines.push("");
      lines.push("## Transcript");
      lines.push("");
      for (const segment of result.segments) {
        const segStart = formatTimestamp(segment.startSeconds);
        const segEnd = formatTimestamp(segment.endSeconds);
        const segText = normalizeAndCapitalize(segment.text);
        lines.push(`- [${segStart} - ${segEnd}] ${segText}`);
      }
    }
  } else {
    lines.push("- **Status**: Transcription unsuccessful");
    lines.push(`- **Duration**: ${formattedDuration}`);
    if (options?.category) {
      lines.push(`- **Category**: ${options.category}`);
    }
    if (result.errorDetail) {
      lines.push(`- **Detail**: ${result.errorDetail}`);
    }
    lines.push("");
    lines.push("## Overview");
    lines.push("");
    lines.push(
      result.errorDetail
        ? `Transcription could not be completed. ${result.errorDetail}`
        : "Transcription could not be completed."
    );
  }

  return lines.join("\n");
}

/**
 * Executes Whisper CLI transcription against supplied WAV audio, with structured failure handling.
 */
export async function transcribeAudio(
  audioBuffer: Uint8Array,
  options?: {
    readonly whisperExecutable?: string;
    readonly modelPath?: string;
    readonly language?: string;
    readonly timeoutMs?: number;
  }
): Promise<TranscriptionResult> {
  const header = parseWavHeader(audioBuffer);
  if (!header) {
    return {
      success: false,
      text: "",
      durationSeconds: 0,
      segments: [],
      errorDetail: "Audio buffer does not contain a valid 16-bit PCM WAV header at 16kHz or 44.1kHz.",
    };
  }

  if (header.dataBytes === 0) {
    return {
      success: false,
      text: "",
      durationSeconds: 0,
      segments: [],
      errorDetail: "Audio buffer contains no audio data.",
    };
  }

  const executable = options?.whisperExecutable ?? "whisper-cli";
  const timeoutMs = options?.timeoutMs ?? 30000;

  let tmpDir: string | null = null;

  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-whisper-"));
    const wavPath = path.join(tmpDir, "audio.wav");
    const outPrefix = path.join(tmpDir, "output");

    await fs.writeFile(wavPath, audioBuffer);

    const args: string[] = ["-f", wavPath, "-oj", "-of", outPrefix];
    if (options?.modelPath) {
      args.push("-m", options.modelPath);
    }
    if (options?.language) {
      args.push("-l", options.language);
    }

    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(executable, args, { timeout: timeoutMs }, (error, stdoutText, stderrText) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: stdoutText ?? "", stderr: stderrText ?? "" });
        }
      });
    });

    let segments: TranscriptSegment[] = [];
    let detectedLanguage: string | undefined = options?.language;
    let fullText = "";

    const jsonPath = `${outPrefix}.json`;
    try {
      const jsonRaw = await fs.readFile(jsonPath, "utf-8");
      const parsed = JSON.parse(jsonRaw) as WhisperJsonOutput;
      if (parsed.result?.language) {
        detectedLanguage = parsed.result.language;
      }
      if (Array.isArray(parsed.transcription)) {
        segments = parsed.transcription.map((seg, index) => {
          const startSeconds =
            typeof seg.offsets?.from === "number"
              ? seg.offsets.from / 1000
              : parseTimestampToSeconds(seg.timestamps?.from);
          const endSeconds =
            typeof seg.offsets?.to === "number"
              ? seg.offsets.to / 1000
              : parseTimestampToSeconds(seg.timestamps?.to);
          const text = typeof seg.text === "string" ? seg.text.trim() : "";
          return {
            id: index + 1,
            startSeconds,
            endSeconds,
            text,
          };
        });
        fullText = segments.map((s) => s.text).join(" ").trim();
      }
    } catch {
      // Fall back to line-by-line standard output parsing when JSON output is absent
    }

    if (segments.length === 0) {
      const timestampLineRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)]\s*(.*)/;
      const lines = stdout.split("\n");
      let segId = 1;
      for (const line of lines) {
        const match = line.match(timestampLineRegex);
        if (match) {
          const startSec = parseTimestampToSeconds(match[1]);
          const endSec = parseTimestampToSeconds(match[2]);
          const txt = (match[3] ?? "").trim();
          if (txt.length > 0) {
            segments.push({
              id: segId++,
              startSeconds: startSec,
              endSeconds: endSec,
              text: txt,
            });
          }
        }
      }

      if (segments.length > 0) {
        fullText = segments.map((s) => s.text).join(" ").trim();
      } else {
        const cleanLines = lines
          .map((l) => l.trim())
          .filter(
            (l) =>
              l.length > 0 &&
              !l.startsWith("whisper_") &&
              !l.startsWith("system_info:") &&
              !l.startsWith("main:")
          );
        fullText = cleanLines.join(" ");
        if (fullText.length > 0) {
          segments = [
            {
              id: 1,
              startSeconds: 0,
              endSeconds: header.durationSeconds,
              text: fullText,
            },
          ];
        }
      }
    }

    return {
      success: true,
      text: fullText,
      durationSeconds: header.durationSeconds,
      segments,
      ...(detectedLanguage !== undefined ? { language: detectedLanguage } : {}),
    };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      text: "",
      durationSeconds: header.durationSeconds,
      segments: [],
      errorDetail: `Whisper execution failed: ${detail}`,
    };
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Assembles a valid RIFF WAV byte array from 16-bit PCM samples.
 */
export function createWavBuffer(
  pcmSamples: Int16Array,
  sampleRate = 16000,
  channels = 1
): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = pcmSamples.length * bytesPerSample;
  const buffer = new Uint8Array(44 + dataBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // 'RIFF'
  buffer[0] = 0x52;
  buffer[1] = 0x49;
  buffer[2] = 0x46;
  buffer[3] = 0x46;
  view.setUint32(4, 36 + dataBytes, true);

  // 'WAVE'
  buffer[8] = 0x57;
  buffer[9] = 0x41;
  buffer[10] = 0x56;
  buffer[11] = 0x45;

  // 'fmt '
  buffer[12] = 0x66;
  buffer[13] = 0x6d;
  buffer[14] = 0x74;
  buffer[15] = 0x20;
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // 16-bit

  // 'data'
  buffer[36] = 0x64;
  buffer[37] = 0x61;
  buffer[38] = 0x74;
  buffer[39] = 0x61;
  view.setUint32(40, dataBytes, true);

  const sampleBytes = new Uint8Array(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);
  buffer.set(sampleBytes, 44);

  return buffer;
}
