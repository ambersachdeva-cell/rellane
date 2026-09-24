import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SPEECH_CHARS,
  speak,
  type SpeechResult
} from "./speech.js";

async function createStubScript(
  dir: string,
  fileName: string,
  scriptBody: string
): Promise<string> {
  const scriptPath = path.join(dir, fileName);
  await fs.writeFile(scriptPath, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("speech synthesis: precondition validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-speech-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns unavailable when text is empty or whitespace only", async () => {
    const emptyResult = await speak({ text: "", outputDir: tempDir });
    expect(emptyResult.status).toBe("unavailable");
    if (emptyResult.status === "unavailable") {
      expect(emptyResult.reason).toBe("No text was provided to read aloud.");
      expect(emptyResult.reason).not.toContain("/");
    }

    const whitespaceResult = await speak({ text: "   \n\t  ", outputDir: tempDir });
    expect(whitespaceResult.status).toBe("unavailable");
    if (whitespaceResult.status === "unavailable") {
      expect(whitespaceResult.reason).toBe("No text was provided to read aloud.");
      expect(whitespaceResult.reason).not.toContain("/");
    }
  });

  it("returns unavailable when text exceeds MAX_SPEECH_CHARS", async () => {
    const longText = "a".repeat(MAX_SPEECH_CHARS + 1);
    const result = await speak({ text: longText, outputDir: tempDir });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The text is too long to read aloud in one go.");
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns unavailable when executablePath is absent or does not exist", async () => {
    const dummyModel = path.join(tempDir, "voice.bin");
    await fs.writeFile(dummyModel, "dummy-voice-bytes");

    const absentResult = await speak({
      text: "Please read this back.",
      outputDir: tempDir,
      runtimeOptions: { modelPath: dummyModel }
    });
    expect(absentResult.status).toBe("unavailable");
    if (absentResult.status === "unavailable") {
      expect(absentResult.reason).toBe("The speech synthesiser is not available on this Mac.");
      expect(absentResult.reason).not.toContain("/");
    }

    const missingResult = await speak({
      text: "Please read this back.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: path.join(tempDir, "nonexistent-tts"),
        modelPath: dummyModel
      }
    });
    expect(missingResult.status).toBe("unavailable");
    if (missingResult.status === "unavailable") {
      expect(missingResult.reason).toBe("The speech synthesiser is not available on this Mac.");
      expect(missingResult.reason).not.toContain("/");
    }
  });

  it("returns unavailable when modelPath is absent or does not exist", async () => {
    const dummyExecutable = await createStubScript(tempDir, "stub.sh", "exit 0");

    const absentResult = await speak({
      text: "Please read this back.",
      outputDir: tempDir,
      runtimeOptions: { executablePath: dummyExecutable }
    });
    expect(absentResult.status).toBe("unavailable");
    if (absentResult.status === "unavailable") {
      expect(absentResult.reason).toBe("No voice is installed on this Mac yet.");
      expect(absentResult.reason).not.toContain("/");
    }

    const missingResult = await speak({
      text: "Please read this back.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: dummyExecutable,
        modelPath: path.join(tempDir, "nonexistent-model.bin")
      }
    });
    expect(missingResult.status).toBe("unavailable");
    if (missingResult.status === "unavailable") {
      expect(missingResult.reason).toBe("No voice is installed on this Mac yet.");
      expect(missingResult.reason).not.toContain("/");
    }
  });

  it("returns unavailable when outputDir does not exist or is not a directory", async () => {
    const dummyExecutable = await createStubScript(tempDir, "stub.sh", "exit 0");
    const dummyModel = path.join(tempDir, "voice.bin");
    await fs.writeFile(dummyModel, "dummy-voice-bytes");

    const nonexistentDir = path.join(tempDir, "missing-dir");
    const nonexistentResult = await speak({
      text: "Please read this back.",
      outputDir: nonexistentDir,
      runtimeOptions: { executablePath: dummyExecutable, modelPath: dummyModel }
    });
    expect(nonexistentResult.status).toBe("unavailable");
    if (nonexistentResult.status === "unavailable") {
      expect(nonexistentResult.reason).toBe("The output directory does not exist or is not a directory.");
      expect(nonexistentResult.reason).not.toContain("/");
    }

    const regularFile = path.join(tempDir, "not-a-dir.txt");
    await fs.writeFile(regularFile, "file content");
    const notDirResult = await speak({
      text: "Please read this back.",
      outputDir: regularFile,
      runtimeOptions: { executablePath: dummyExecutable, modelPath: dummyModel }
    });
    expect(notDirResult.status).toBe("unavailable");
    if (notDirResult.status === "unavailable") {
      expect(notDirResult.reason).toBe("The output directory does not exist or is not a directory.");
      expect(notDirResult.reason).not.toContain("/");
    }
  });
});

describe("speech synthesis: child lifecycle and validation", () => {
  let tempDir: string;
  let dummyModel: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-speech-test-"));
    dummyModel = path.join(tempDir, "voice.bin");
    await fs.writeFile(dummyModel, "dummy-voice-bytes");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns spoken when a stub writes a valid RIFF file", async () => {
    const stub = await createStubScript(
      tempDir,
      "stub-spoken.sh",
      [
        'out="output.wav"',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o|--output) out="$2"; shift 2;;',
        '    *) shift;;',
        '  esac',
        'done',
        'printf "RIFFmockaudiodata" > "$out"'
      ].join("\n")
    );

    const result = await speak({
      text: "Read this sentence aloud on this Mac.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: stub,
        modelPath: dummyModel
      }
    });

    expect(result.status).toBe("spoken");
    if (result.status === "spoken") {
      expect(result.wavPath).toBe(path.join(tempDir, "output.wav"));
      expect(existsSync(result.wavPath)).toBe(true);
      expect(result.bytes).toBe(17);
      expect(result.runtime).toBe(stub);
    }

    const entries = await fs.readdir(tempDir);
    const tempInputs = entries.filter((name) => name.startsWith("speech-input-"));
    expect(tempInputs).toHaveLength(0);
  });

  it("returns unavailable when a stub writes a non-RIFF file", async () => {
    const stub = await createStubScript(
      tempDir,
      "stub-non-riff.sh",
      [
        'out="output.wav"',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o|--output) out="$2"; shift 2;;',
        '    *) shift;;',
        '  esac',
        'done',
        'printf "NOT_RIFF_INVALID_HEADER" > "$out"'
      ].join("\n")
    );

    const result = await speak({
      text: "Read this sentence aloud on this Mac.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: stub,
        modelPath: dummyModel
      }
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The speech output was not a valid audio file.");
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns unavailable when a stub produces no file", async () => {
    const stub = await createStubScript(tempDir, "stub-empty-exit.sh", "exit 0");

    const result = await speak({
      text: "Read this sentence aloud on this Mac.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: stub,
        modelPath: dummyModel
      }
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The speech synthesiser did not produce an audio file.");
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns unavailable when a stub exits non-zero", async () => {
    const stub = await createStubScript(tempDir, "stub-fail.sh", "exit 1");

    const result = await speak({
      text: "Read this sentence aloud on this Mac.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: stub,
        modelPath: dummyModel
      }
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The speech synthesiser did not finish cleanly.");
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns unavailable and cleans temporary input file when timed out", async () => {
    const stub = await createStubScript(tempDir, "stub-sleep.sh", "sleep 5");

    const result = await speak({
      text: "Read this sentence aloud on this Mac.",
      outputDir: tempDir,
      runtimeOptions: {
        executablePath: stub,
        modelPath: dummyModel,
        timeoutMs: 50
      }
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The speech synthesiser ran out of time and was stopped.");
      expect(result.reason).not.toContain("/");
    }

    const entries = await fs.readdir(tempDir);
    const tempInputs = entries.filter((name) => name.startsWith("speech-input-"));
    expect(tempInputs).toHaveLength(0);
  });

  it("ensures no unavailable reason contains a slash path segment", async () => {
    const failureCases: readonly Promise<SpeechResult>[] = [
      speak({ text: "", outputDir: tempDir }),
      speak({ text: "a".repeat(MAX_SPEECH_CHARS + 1), outputDir: tempDir }),
      speak({ text: "Hello", outputDir: path.join(tempDir, "missing") }),
      speak({ text: "Hello", outputDir: tempDir, runtimeOptions: {} }),
      speak({
        text: "Hello",
        outputDir: tempDir,
        runtimeOptions: { executablePath: path.join(tempDir, "missing.sh"), modelPath: dummyModel }
      })
    ];

    const results = await Promise.all(failureCases);
    for (const result of results) {
      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).not.toContain("/");
      }
    }
  });
});
