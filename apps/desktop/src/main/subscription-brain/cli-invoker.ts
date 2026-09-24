/**
 * Runs a child process safely.
 *
 * `shell` is never enabled. Arguments are passed as an argv array so a prompt
 * containing backticks, semicolons, or quotes is data rather than shell syntax.
 * Prompts are written to stdin where the provider supports it, which also keeps
 * them out of the process table where any other user could read them.
 */

import { spawn } from "node:child_process";
import { RuntimeBoundaryError } from "./errors.js";

/** Hard ceiling on captured output, so a runaway process cannot exhaust memory. */
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

export interface RunProcessInput {
  readonly executablePath: string;
  readonly args: readonly string[];
  /** Written to the child's stdin, then stdin is closed. */
  readonly stdin?: string | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * Which account this runs as.
   *
   * A vendor CLI reads its credentials out of `$HOME`, so the home directory
   * *is* the account. Handing a different one starts the same binary signed in
   * as somebody else — which is how one person's several subscriptions become
   * several seats (D-091).
   *
   * **Rellane still never touches a credential.** It sets a path and starts the
   * vendor's own program; the token stays in that directory, unread. That is
   * D-022 and D-038 unchanged.
   *
   * Absent means the ambient environment, which is the single-account case and
   * still the default.
   */
  readonly home?: string | undefined;
}

export interface RunProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export async function runProcess(input: RunProcessInput): Promise<RunProcessResult> {
  const { executablePath, args, stdin, timeoutMs, signal, home } = input;

  if (signal?.aborted === true) {
    throw new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The request was cancelled before it started.",
      retryable: true
    });
  }

  return await new Promise<RunProcessResult>((resolve, reject) => {
    const child = spawn(executablePath, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // `HOME` is overridden and nothing else, so a seat cannot be used to
      // rewrite the environment a CLI runs in — only to say whose it is.
      env: home === undefined ? process.env : { ...process.env, HOME: home }
    });

    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = () => {
      if (!child.killed) {
        child.kill("SIGTERM");
        // If it ignores SIGTERM, insist shortly after.
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 2_000).unref?.();
      }
    };

    const timer = setTimeout(() => {
      kill();
      finish(() =>
        reject(
          new RuntimeBoundaryError({
            code: "TIMEOUT",
            message: `The request took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`,
            retryable: true
          })
        )
      );
    }, timeoutMs);

    const onAbort = () => {
      kill();
      finish(() =>
        reject(
          new RuntimeBoundaryError({
            code: "CANCELLED",
            message: "The request was cancelled.",
            retryable: true
          })
        )
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const capture = (chunk: Buffer, sink: "out" | "err") => {
      if (capturedBytes >= MAX_CAPTURED_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_CAPTURED_BYTES - capturedBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      capturedBytes += slice.length;
      if (slice.length < chunk.length) {
        truncated = true;
      }
      if (sink === "out") {
        stdout += slice.toString("utf8");
      } else {
        stderr += slice.toString("utf8");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(chunk, "out"));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, "err"));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new RuntimeBoundaryError({
            code: error.code === "ENOENT" ? "RUNTIME_UNAVAILABLE" : "UNKNOWN",
            message:
              error.code === "ENOENT"
                ? `${executablePath} is no longer installed.`
                : `Could not start ${executablePath}: ${error.message}`,
            retryable: false
          })
        )
      );
    });

    child.on("close", (code) => {
      finish(() => resolve({ code, stdout, stderr, truncated }));
    });

    if (stdin !== undefined) {
      child.stdin.on("error", () => {
        // The child may exit before reading stdin; the close handler reports it.
      });
      child.stdin.end(stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}
