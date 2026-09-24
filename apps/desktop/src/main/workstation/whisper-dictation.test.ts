import { describe, expect, it } from "vitest";
import {
  createWavBuffer,
  detectVoiceActivity,
  formatTranscriptAsBrief,
  parseWavHeader,
  transcribeAudio,
  trimSilence,
} from "./whisper-dictation.js";
import type { AudioWavHeader, TranscriptionResult } from "./whisper-dictation.js";

describe("parseWavHeader", () => {
  it("parses valid 16kHz mono WAV header and computes accurate duration", () => {
    const samples = new Int16Array(16000);
    const wav = createWavBuffer(samples, 16000, 1);
    const header = parseWavHeader(wav);

    expect(header).not.toBeNull();
    expect(header?.sampleRate).toBe(16000);
    expect(header?.channels).toBe(1);
    expect(header?.bitsPerSample).toBe(16);
    expect(header?.dataBytes).toBe(32000);
    expect(header?.durationSeconds).toBe(1.0);
  });

  it("parses valid 44.1kHz stereo WAV header and computes fractional duration", () => {
    const samples = new Int16Array(44100 * 2);
    const wav = createWavBuffer(samples, 44100, 2);
    const header = parseWavHeader(wav);

    expect(header).not.toBeNull();
    expect(header?.sampleRate).toBe(44100);
    expect(header?.channels).toBe(2);
    expect(header?.bitsPerSample).toBe(16);
    expect(header?.dataBytes).toBe(44100 * 2 * 2);
    expect(header?.durationSeconds).toBe(1.0);
  });

  it("rejects corrupted buffers and non-PCM formats", () => {
    expect(parseWavHeader(new Uint8Array(10))).toBeNull();

    const invalidMagic = createWavBuffer(new Int16Array(100), 16000, 1);
    invalidMagic[0] = 0x00;
    expect(parseWavHeader(invalidMagic)).toBeNull();

    const invalidRate = createWavBuffer(new Int16Array(100), 8000, 1);
    expect(parseWavHeader(invalidRate)).toBeNull();

    const truncated = invalidMagic.slice(0, 30);
    expect(parseWavHeader(truncated)).toBeNull();
  });
});

describe("detectVoiceActivity", () => {
  it("identifies silence in null audio", () => {
    const silence = new Int16Array(16000);
    const vad = detectVoiceActivity(silence, 16000);

    expect(vad.hasSpeech).toBe(false);
    expect(vad.voiceFramesCount).toBe(0);
    expect(vad.speechDurationSeconds).toBe(0);
  });

  it("detects voice activity across simulated speech sine wave audio", () => {
    const speech = new Int16Array(16000);
    for (let i = 0; i < speech.length; i++) {
      speech[i] = Math.floor(Math.sin(i / 10) * 8000);
    }
    const vad = detectVoiceActivity(speech, 16000);

    expect(vad.hasSpeech).toBe(true);
    expect(vad.voiceFramesCount).toBeGreaterThan(45);
    expect(vad.speechDurationSeconds).toBeCloseTo(1.0, 1);
  });
});

describe("trimSilence", () => {
  it("removes leading and trailing null frames", () => {
    const header: AudioWavHeader = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 2000,
      durationSeconds: 2000 / 32000,
    };

    const leadingNullBytes = 400;
    const activeAudioBytes = 600;
    const trailingNullBytes = 400;
    const totalBytes = leadingNullBytes + activeAudioBytes + trailingNullBytes;

    const pcm = new Uint8Array(totalBytes);
    for (let i = 0; i < activeAudioBytes; i++) {
      pcm[leadingNullBytes + i] = 120;
    }

    const trimmed = trimSilence(pcm, header);
    expect(trimmed.byteLength).toBe(activeAudioBytes);
    expect(trimmed[0]).toBe(120);
    expect(trimmed[trimmed.byteLength - 1]).toBe(120);
  });

  it("returns empty buffer when audio consists entirely of silence frames", () => {
    const header: AudioWavHeader = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 640,
      durationSeconds: 0.02,
    };
    const silentPcm = new Uint8Array(640);
    const trimmed = trimSilence(silentPcm, header);
    expect(trimmed.byteLength).toBe(0);
  });
});

describe("formatTranscriptAsBrief", () => {
  it("formats speech into a structured Markdown brief with normalised sentences and timestamps", () => {
    const result: TranscriptionResult = {
      success: true,
      text: "we need to deploy the migration today. check all database replica statuses.",
      durationSeconds: 12.5,
      language: "en",
      segments: [
        {
          id: 1,
          startSeconds: 0,
          endSeconds: 5.2,
          text: "we need to deploy the migration today.",
        },
        {
          id: 2,
          startSeconds: 5.5,
          endSeconds: 12.5,
          text: "check all database replica statuses.",
        },
      ],
    };

    const brief = formatTranscriptAsBrief(result, {
      title: "Database Maintenance Intake",
      category: "Operations",
    });

    expect(brief).toContain("# Database Maintenance Intake");
    expect(brief).toContain("- **Category**: Operations");
    expect(brief).toContain("- **Duration**: 00:12");
    expect(brief).toContain("- **Language**: en");
    expect(brief).toContain("We need to deploy the migration today. Check all database replica statuses.");
    expect(brief).toContain("- [00:00 - 00:05] We need to deploy the migration today.");
    expect(brief).toContain("- [00:05 - 00:12] Check all database replica statuses.");
  });

  it("formats unsuccessful transcriptions with calm error context", () => {
    const result: TranscriptionResult = {
      success: false,
      text: "",
      durationSeconds: 0,
      segments: [],
      errorDetail: "Microphone intake connection was interrupted.",
    };

    const brief = formatTranscriptAsBrief(result, {
      title: "Standup Recording",
    });

    expect(brief).toContain("# Standup Recording");
    expect(brief).toContain("- **Status**: Transcription unsuccessful");
    expect(brief).toContain("Microphone intake connection was interrupted.");
  });
});

describe("transcribeAudio", () => {
  it("falls back cleanly with structured error details when whisper binary does not exist", async () => {
    const wav = createWavBuffer(new Int16Array(16000), 16000, 1);
    const result = await transcribeAudio(wav, {
      whisperExecutable: "/opt/nonexistent/whisper-cli-bin",
    });

    expect(result.success).toBe(false);
    expect(result.text).toBe("");
    expect(result.segments).toHaveLength(0);
    expect(result.durationSeconds).toBe(1.0);
    expect(result.errorDetail).toContain("Whisper execution failed");
  });
});
