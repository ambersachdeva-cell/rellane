/**
 * The workstation document importer.
 *
 * One bounded Python child converts documents (PDF, Word, Excel, slides, etc.)
 * to Markdown via markitdown. Refuses invalid, symlinked, oversize or unsupported
 * files before spawning. The child is sandboxed with `-I -S -B -X utf8`, no shell,
 * a fresh temporary directory, a strict lifetime timeout, and an output byte cap.
 * Output is parsed as structured data rather than assumed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DocumentImportRuntimeOptions {
  readonly pythonPath?: string;
  readonly scriptPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface DocumentImportInput {
  /** Absolute path to the file the owner picked. */
  readonly filePath: string;
  readonly runtimeOptions?: DocumentImportRuntimeOptions;
}

export type DocumentImportResult =
  | {
      readonly status: "converted";
      readonly markdown: string;
      readonly bytes: number;
      readonly truncated: boolean;
      /** What actually ran, reported rather than assumed. */
      readonly runtime: string;
    }
  | {
      readonly status: "unavailable";
      /** One plain sentence the owner can act on. Never a stack trace, never a path. */
      readonly reason: string;
    };

export const MAX_DOCUMENT_BYTES = 33_554_432;
export const MAX_MARKDOWN_BYTES = 1_048_576;
export const DOCUMENT_TIMEOUT_MS = 30_000;
export const TEMP_DIR_PREFIX = "rellane-doc-import-";

export const SUPPORTED_EXTENSIONS: readonly string[] = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "html",
  "htm",
  "csv",
  "txt",
  "md",
  "rtf",
  "epub"
] as const;

/** Isolated, no site packages, no bytecode, UTF-8 regardless of the locale. */
export const PYTHON_ARGS = ["-I", "-S", "-B", "-X", "utf8"] as const;

export const PYTHON_CANDIDATES = [
  "/Library/Developer/CommandLineTools/usr/bin/python3",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3"
] as const;

export const DEFAULT_PYTHON_PATH: string =
  PYTHON_CANDIDATES[0] ?? "/Library/Developer/CommandLineTools/usr/bin/python3";

export function resolvePythonPath(custom?: string): string | null {
  if (custom !== undefined) {
    return existsSync(custom) ? custom : null;
  }
  for (const candidate of PYTHON_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveDocumentImportScriptPath(customPath?: string): string {
  return (
    customPath ??
    (typeof __dirname !== "undefined"
      ? path.resolve(__dirname, "../../../scripts/document-import-bridge.py")
      : path.resolve(process.cwd(), "apps/desktop/scripts/document-import-bridge.py"))
  );
}

export function isSupportedDocument(filePath: string): boolean {
  const base = path.basename(filePath);
  const dotIndex = base.lastIndexOf(".");
  // Files with no extension or hidden dotfiles without extension are rejected.
  if (dotIndex <= 0) {
    return false;
  }
  const ext = base.slice(dotIndex + 1).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function parseConvertedResult(stdout: string, truncated: boolean): DocumentImportResult {
  if (truncated) {
    let markdown = stdout;
    let runtime = "unknown";
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.markdown === "string") {
          markdown = record.markdown;
        }
        if (typeof record.runtime === "string") {
          runtime = record.runtime;
        }
      }
    } catch {
      // If stdout was truncated mid-JSON stream, recover metadata from available chunks.
      const runtimeMatch = stdout.match(/"runtime"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (runtimeMatch && runtimeMatch[1] !== undefined) {
        try {
          runtime = JSON.parse(`"${runtimeMatch[1]}"`) as string;
        } catch {
          runtime = runtimeMatch[1];
        }
      }
      const markdownMatch = stdout.match(/"markdown"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (markdownMatch && markdownMatch[1] !== undefined) {
        try {
          markdown = JSON.parse(`"${markdownMatch[1]}"`) as string;
        } catch {
          markdown = markdownMatch[1];
        }
      }
    }
    return {
      status: "converted",
      markdown,
      bytes: Buffer.byteLength(markdown, "utf8"),
      truncated: true,
      runtime
    };
  }

  if (!stdout.trim()) {
    return {
      status: "unavailable",
      reason: "The document converter produced no output."
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return {
      status: "unavailable",
      reason: "The document converter returned output this app could not read."
    };
  }

  if (typeof raw !== "object" || raw === null) {
    return {
      status: "unavailable",
      reason: "The document converter returned output this app could not read."
    };
  }

  const record = raw as Record<string, unknown>;
  if (record.status === "unavailable" && typeof record.reason === "string") {
    return {
      status: "unavailable",
      reason: record.reason
    };
  }

  if (typeof record.markdown !== "string" || typeof record.runtime !== "string") {
    return {
      status: "unavailable",
      reason: "The document converter returned output this app could not read."
    };
  }

  return {
    status: "converted",
    markdown: record.markdown,
    bytes: Buffer.byteLength(record.markdown, "utf8"),
    truncated: false,
    runtime: record.runtime
  };
}

export async function importDocument(input: DocumentImportInput): Promise<DocumentImportResult> {
  if (!isSupportedDocument(input.filePath)) {
    return {
      status: "unavailable",
      reason: "This document format is not supported."
    };
  }

  let stats: import("node:fs").Stats;
  try {
    stats = await fs.lstat(input.filePath);
  } catch {
    return {
      status: "unavailable",
      reason: "The selected file could not be found."
    };
  }

  // Refuse symlinks so the exact path the owner approved is what gets converted.
  if (stats.isSymbolicLink()) {
    return {
      status: "unavailable",
      reason: "The selected file is a symbolic link and cannot be imported."
    };
  }

  if (!stats.isFile()) {
    return {
      status: "unavailable",
      reason: "The selected item is not a regular file."
    };
  }

  if (stats.size > MAX_DOCUMENT_BYTES) {
    return {
      status: "unavailable",
      reason: "The selected document exceeds the 32 MB size limit."
    };
  }

  const pythonPath = resolvePythonPath(input.runtimeOptions?.pythonPath);
  if (!pythonPath) {
    return {
      status: "unavailable",
      reason: "Document conversion needs Python 3.9 or newer on this Mac."
    };
  }

  const scriptPath = resolveDocumentImportScriptPath(input.runtimeOptions?.scriptPath);
  if (!existsSync(scriptPath)) {
    return {
      status: "unavailable",
      reason: "The document import script is missing from this install."
    };
  }

  const timeoutMs = input.runtimeOptions?.timeoutMs ?? DOCUMENT_TIMEOUT_MS;
  const maxOutputBytes = input.runtimeOptions?.maxOutputBytes ?? MAX_MARKDOWN_BYTES;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));

  try {
    return await new Promise<DocumentImportResult>((resolve) => {
      // The child runs isolated without site-packages or bytecode caching,
      // in an empty temporary directory with a minimal PATH to prevent
      // external script execution or ambient state contamination.
      const child = spawn(pythonPath, [...PYTHON_ARGS, scriptPath, input.filePath], {
        cwd: tempDir,
        env: { PATH: "/usr/bin:/bin" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      let stdout = "";
      let stdoutBytes = 0;
      let timedOut = false;
      let truncated = false;
      let settled = false;
      let startError: string | null = null;
      let killTimer: NodeJS.Timeout | null = null;

      const finish = (result: DocumentImportResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer !== null) {
          clearTimeout(killTimer);
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 1_000);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const remaining = maxOutputBytes - stdoutBytes;
        if (chunk.length >= remaining) {
          stdout += chunk.subarray(0, remaining).toString("utf8");
          stdoutBytes += remaining;
          truncated = true;
          child.stdout.destroy();
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, 1_000);
          return;
        }
        stdoutBytes += chunk.length;
        stdout += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        startError = error.message;
      });

      child.on("close", (code, signal) => {
        if (startError) {
          finish({
            status: "unavailable",
            reason: "The document converter could not be started."
          });
          return;
        }
        if (timedOut) {
          finish({
            status: "unavailable",
            reason: "The document converter ran out of time and was stopped."
          });
          return;
        }
        if (truncated) {
          finish(parseConvertedResult(stdout, true));
          return;
        }
        if (code !== 0 || signal !== null) {
          finish({
            status: "unavailable",
            reason: "The document converter did not finish cleanly."
          });
          return;
        }
        finish(parseConvertedResult(stdout, false));
      });
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
