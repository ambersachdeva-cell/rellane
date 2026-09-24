import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOCUMENT_TIMEOUT_MS,
  MAX_DOCUMENT_BYTES,
  MAX_MARKDOWN_BYTES,
  SUPPORTED_EXTENSIONS,
  TEMP_DIR_PREFIX,
  importDocument,
  isSupportedDocument,
  type DocumentImportResult
} from "./document-import.js";

let testDir: string;
let mockPythonPath: string;
let validDocPath: string;

function assertUnavailableWithoutPath(result: DocumentImportResult): void {
  expect(result.status).toBe("unavailable");
  if (result.status === "unavailable") {
    expect(result.reason).not.toContain("/");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason.endsWith(".")).toBe(true);
  }
}

beforeAll(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-doc-import-test-"));
  mockPythonPath = path.join(testDir, "mock-python.sh");
  // The mock python script shifts Python isolated arguments (-I -S -B -X utf8)
  // and executes the target test script using /bin/sh.
  await fs.writeFile(
    mockPythonPath,
    [
      "#!/bin/sh",
      "shift 5",
      'SCRIPT="$1"',
      "shift",
      'exec /bin/sh "$SCRIPT" "$@"'
    ].join("\n")
  );
  await fs.chmod(mockPythonPath, 0o755);

  validDocPath = path.join(testDir, "valid-sample.pdf");
  await fs.writeFile(validDocPath, "%PDF-1.4 test document content");
});

afterAll(async () => {
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

describe("document import: extension support", () => {
  it("recognises all supported document extensions case-insensitively", () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(isSupportedDocument(`brief.${ext}`)).toBe(true);
      expect(isSupportedDocument(`brief.${ext.toUpperCase()}`)).toBe(true);
      expect(isSupportedDocument(`/Users/owner/Documents/brief.${ext}`)).toBe(true);
    }
  });

  it("refuses unsupported extensions, dotfiles, and files with no extension", () => {
    expect(isSupportedDocument("executable.exe")).toBe(false);
    expect(isSupportedDocument("archive.zip")).toBe(false);
    expect(isSupportedDocument("plain-file")).toBe(false);
    expect(isSupportedDocument(".pdf")).toBe(false);
    expect(isSupportedDocument("")).toBe(false);
  });
});

describe("document import: pre-flight checks before child spawn", () => {
  it("refuses unsupported extensions with an actionable sentence", async () => {
    const result = await importDocument({
      filePath: path.join(testDir, "notes.bin")
    });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("This document format is not supported.");
    }
  });

  it("refuses missing files before spawning any process", async () => {
    const result = await importDocument({
      filePath: path.join(testDir, "nonexistent-doc.pdf")
    });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The selected file could not be found.");
    }
  });

  it("refuses symlinks so the exact approved path is what is read", async () => {
    const targetFile = path.join(testDir, "symlink-target.docx");
    const linkFile = path.join(testDir, "symlink-alias.docx");
    await fs.writeFile(targetFile, "Sample docx payload");
    await fs.symlink(targetFile, linkFile);

    const result = await importDocument({ filePath: linkFile });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The selected file is a symbolic link and cannot be imported.");
    }
  });

  it("refuses non-regular files such as directories", async () => {
    const folderPath = path.join(testDir, "fake-folder.pdf");
    await fs.mkdir(folderPath);

    const result = await importDocument({ filePath: folderPath });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The selected item is not a regular file.");
    }
  });

  it("refuses files that exceed the 32 MB limit", async () => {
    const oversizePath = path.join(testDir, "oversize-sample.pdf");
    await fs.writeFile(oversizePath, "");
    await fs.truncate(oversizePath, MAX_DOCUMENT_BYTES + 1);

    const result = await importDocument({ filePath: oversizePath });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The selected document exceeds the 32 MB size limit.");
    }
  });
});

describe("document import: interpreter and script path verification", () => {
  it("reports unavailable when the interpreter does not exist on this Mac", async () => {
    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: { pythonPath: path.join(testDir, "missing-python") }
    });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toContain("Python 3.9");
    }
  });

  it("reports unavailable when the conversion script is missing from the install", async () => {
    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: {
        pythonPath: mockPythonPath,
        scriptPath: path.join(testDir, "missing-script.py")
      }
    });
    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The document import script is missing from this install.");
    }
  });
});

describe("document import: bounded child execution", () => {
  it("converts a valid document and extracts markdown and actual runtime", async () => {
    const validScript = path.join(testDir, "valid-script.sh");
    await fs.writeFile(
      validScript,
      [
        "#!/bin/sh",
        "cat << 'EOF'",
        '{"status":"converted","markdown":"# Converted Document\\n\\nPlain text from PDF.","runtime":"MockPython 3.11.2"}',
        "EOF"
      ].join("\n")
    );
    await fs.chmod(validScript, 0o755);

    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: {
        pythonPath: mockPythonPath,
        scriptPath: validScript
      }
    });

    expect(result.status).toBe("converted");
    if (result.status === "converted") {
      expect(result.markdown).toBe("# Converted Document\n\nPlain text from PDF.");
      expect(result.bytes).toBe(Buffer.byteLength(result.markdown, "utf8"));
      expect(result.truncated).toBe(false);
      expect(result.runtime).toBe("MockPython 3.11.2");
    }
  });

  it("reports unavailable when the script exits with a non-zero code", async () => {
    const failScript = path.join(testDir, "fail-script.sh");
    await fs.writeFile(failScript, "#!/bin/sh\nexit 1\n");
    await fs.chmod(failScript, 0o755);

    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: {
        pythonPath: mockPythonPath,
        scriptPath: failScript
      }
    });

    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The document converter did not finish cleanly.");
    }
  });

  it("caps stdout at maxOutputBytes and reports truncated: true", async () => {
    const oversizeScript = path.join(testDir, "oversize-script.sh");
    await fs.writeFile(
      oversizeScript,
      [
        "#!/bin/sh",
        'printf \'{"runtime":"MockPython 3.11.2","markdown":"\'',
        "i=0",
        "while [ $i -lt 200 ]; do",
        "  printf 'Detailed paragraph %d containing words for output capping. ' \"$i\"",
        "  i=$((i + 1))",
        "done",
        'printf \'"}\' '
      ].join("\n")
    );
    await fs.chmod(oversizeScript, 0o755);

    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: {
        pythonPath: mockPythonPath,
        scriptPath: oversizeScript,
        maxOutputBytes: 180
      }
    });

    expect(result.status).toBe("converted");
    if (result.status === "converted") {
      expect(result.truncated).toBe(true);
      expect(result.runtime).toBe("MockPython 3.11.2");
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.bytes).toBeLessThanOrEqual(180);
      expect(result.markdown).toContain("Detailed paragraph");
    }
  });

  it("terminates a timed-out child and ensures the temp directory is removed", async () => {
    const sleepScript = path.join(testDir, "sleep-script.sh");
    await fs.writeFile(sleepScript, "#!/bin/sh\nsleep 5\n");
    await fs.chmod(sleepScript, 0o755);

    const countDocTempDirs = async () =>
      (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith(TEMP_DIR_PREFIX)).length;

    const beforeTempCount = await countDocTempDirs();

    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: {
        pythonPath: mockPythonPath,
        scriptPath: sleepScript,
        timeoutMs: 100
      }
    });

    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The document converter ran out of time and was stopped.");
    }

    const afterTempCount = await countDocTempDirs();
    expect(afterTempCount).toBe(beforeTempCount);
  });

  it("reports unavailable when script output cannot be parsed", async () => {
    const badOutputScript = path.join(testDir, "bad-output-script.sh");
    await fs.writeFile(badOutputScript, "#!/bin/sh\necho 'corrupt non-json content'\n");
    await fs.chmod(badOutputScript, 0o755);

    const result = await importDocument({
      filePath: validDocPath,
      runtimeOptions: {
        pythonPath: mockPythonPath,
        scriptPath: badOutputScript
      }
    });

    assertUnavailableWithoutPath(result);
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The document converter returned output this app could not read.");
    }
  });
});
