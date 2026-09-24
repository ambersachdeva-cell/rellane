/**
 * macOS action runner and safety gatekeeper.
 *
 * Rellane requires explicit approval from you before executing any action on this Mac.
 * Every approved action is strictly bounded: spawned directly with an argument array
 * without shell interpretation, subject to output caps and forced termination on timeout.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

export type MacAction =
  | { readonly kind: "reveal"; readonly path: string }
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "shortcut"; readonly name: string; readonly input?: string };

export interface ActionDescription {
  readonly title: string;
  readonly detail: string;
  readonly reversible: boolean;
}

export type ActionOutcome =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "refused"; readonly reason: string };

export const MAX_SHORTCUT_INPUT = 4_000;

export const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const MAX_STDERR_CAPTURE_BYTES = 8_192;
export const SIGKILL_GRACE_MS = 500;

export interface MacActionRuntimeOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly openBinary?: string;
  readonly shortcutsBinary?: string;
  readonly spawnFn?: typeof spawn;
}

/**
 * Verifies whether a canonical target path is located within or equals the canonical root.
 * Pre-resolving both paths ensures dot segments or symlinks cannot escape the allowed boundary.
 */
function isWithinRoot(resolvedPath: string, resolvedRoot: string): boolean {
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Formulates the human-readable summary shown for approval.
 * Identifies the exact target file and folder or Shortcut name rather than generic placeholders.
 */
export function describeAction(action: MacAction): ActionDescription {
  switch (action.kind) {
    case "reveal": {
      const fileName = path.basename(action.path) || action.path;
      const folderPath = path.dirname(action.path);
      return {
        title: `Reveal "${fileName}" in Finder`,
        detail: `Shows "${fileName}" in folder "${folderPath}".`,
        // Highlighting an item in Finder alters transient selection state and causes no data mutation.
        reversible: true
      };
    }
    case "open": {
      const fileName = path.basename(action.path) || action.path;
      const folderPath = path.dirname(action.path);
      return {
        title: `Open "${fileName}"`,
        detail: `Opens "${fileName}" from folder "${folderPath}" with the default application.`,
        // Launching an application initiates external state changes that cannot be automatically undone.
        reversible: false
      };
    }
    case "shortcut": {
      const detail =
        action.input !== undefined && action.input.length > 0
          ? `Runs the macOS Shortcut "${action.name}" with your input.`
          : `Runs the macOS Shortcut "${action.name}".`;
      return {
        title: `Run shortcut "${action.name}"`,
        detail,
        // Shortcuts execute arbitrary user automation flows with unknown side effects.
        reversible: false
      };
    }
  }
}

/**
 * Evaluates safety constraints prior to starting any action.
 * Rejects non-absolute paths, traversal or symlink escapes outside the boundary,
 * missing files, malformed shortcut identifiers, and oversize payloads.
 */
export function whyRefused(action: MacAction, allowedRoot: string): string | null {
  switch (action.kind) {
    case "reveal":
    case "open": {
      if (action.path.includes("\0")) {
        return "The path contains an invalid null character.";
      }
      if (!path.isAbsolute(action.path)) {
        return "The path must be an absolute path.";
      }
      if (allowedRoot.includes("\0")) {
        return "The permitted boundary contains an invalid null character.";
      }
      if (!path.isAbsolute(allowedRoot)) {
        return "The permitted boundary must be an absolute path.";
      }

      // Resolving realpath for both paths canonicalises symlinks and relative tokens before boundary checks.
      let resolvedRoot: string;
      try {
        resolvedRoot = realpathSync(allowedRoot);
      } catch {
        return `The permitted folder does not exist: "${allowedRoot}".`;
      }

      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(action.path);
      } catch {
        return `The file does not exist: "${action.path}".`;
      }

      if (!isWithinRoot(resolvedPath, resolvedRoot)) {
        return `The path is outside the permitted folder "${allowedRoot}".`;
      }

      return null;
    }

    case "shortcut": {
      if (action.name.trim().length === 0) {
        return "The Shortcut name cannot be empty.";
      }
      if (action.name.includes("\0")) {
        return "The Shortcut name contains an invalid null character.";
      }
      if (action.name.includes("/") || action.name.includes("\\")) {
        return "The Shortcut name must not contain slashes.";
      }
      if (/['"`]/.test(action.name)) {
        return "The Shortcut name must not contain quotes.";
      }
      if (/[\r\n]/.test(action.name)) {
        return "The Shortcut name must not contain newlines.";
      }
      if (/[;&|$()<>{}[\]*?~!#^=\t]/.test(action.name)) {
        return "The Shortcut name must not contain shell metacharacters.";
      }
      if (!/^[\p{L}\p{N} _.-]+$/u.test(action.name)) {
        return "The Shortcut name must be a plain name.";
      }

      if (action.input !== undefined) {
        if (action.input.includes("\0")) {
          return "The Shortcut input contains an invalid null character.";
        }
        if (action.input.length > MAX_SHORTCUT_INPUT) {
          return `The Shortcut input exceeds the limit of ${MAX_SHORTCUT_INPUT.toLocaleString()} characters.`;
        }
      }

      return null;
    }
  }
}

/**
 * Executes an approved action within strict process and resource limits.
 * Spawns child processes using argv arrays exclusively to avoid shell vulnerabilities.
 */
export async function runAction(
  action: MacAction,
  allowedRoot: string,
  runtimeOptions?: MacActionRuntimeOptions
): Promise<ActionOutcome> {
  const refusal = whyRefused(action, allowedRoot);
  if (refusal !== null) {
    return { status: "refused", reason: refusal };
  }

  // Every command is spawned with an argv array, never a shell string, and never exec.
  // There is no code path in this module that builds a command from a string.
  let binary: string;
  let args: readonly string[];

  switch (action.kind) {
    case "reveal":
      binary = runtimeOptions?.openBinary ?? "open";
      args = ["-R", action.path];
      break;
    case "open":
      binary = runtimeOptions?.openBinary ?? "open";
      args = [action.path];
      break;
    case "shortcut":
      binary = runtimeOptions?.shortcutsBinary ?? "shortcuts";
      args = ["run", action.name];
      break;
  }

  const timeoutMs = runtimeOptions?.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const maxOutputBytes = runtimeOptions?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const spawnChild = runtimeOptions?.spawnFn ?? spawn;

  return new Promise<ActionOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnChild(binary, args, {
        // Shell invocation is disabled to eliminate shell injection attack surfaces.
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ status: "refused", reason: `The action could not be started: ${message}.` });
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let timedOut = false;
    let oversized = false;
    let settled = false;
    let startError: string | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    // Bound child lifetime to prevent hung shortcuts from stalling the workstation.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have exited right before the timer triggered.
      }
      // Force termination if the process does not shut down cleanly following SIGTERM.
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have exited during the grace interval.
        }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    const finish = (outcome: ActionOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      resolve(outcome);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        oversized = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore if child process has already terminated.
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        oversized = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore if child process has already terminated.
        }
        return;
      }
      if (stderr.length < MAX_STDERR_CAPTURE_BYTES) {
        stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CAPTURE_BYTES - stderr.length);
      }
    });

    child.on("error", (error: Error) => {
      startError = error.message;
    });

    // Prevent unhandled EPIPE if the child process closes standard input early.
    child.stdin?.on("error", () => {});

    if (action.kind === "shortcut" && action.input !== undefined) {
      child.stdin?.end(action.input, "utf8");
    } else {
      child.stdin?.end();
    }

    child.on("close", (code, signal) => {
      if (startError !== null) {
        finish({
          status: "refused",
          reason: `The action could not be started: ${startError}.`
        });
        return;
      }
      if (timedOut) {
        finish({
          status: "refused",
          reason: "The action ran out of time and was stopped."
        });
        return;
      }
      if (oversized) {
        finish({
          status: "refused",
          reason: "The action produced too much output and was stopped."
        });
        return;
      }
      if (code !== 0 || signal !== null) {
        const detail =
          stderr.trim().slice(0, 1_000) ||
          (signal !== null
            ? `The action was stopped by signal ${signal}.`
            : `The action failed with exit code ${code}.`);
        finish({ status: "refused", reason: detail });
        return;
      }

      switch (action.kind) {
        case "reveal": {
          const fileName = path.basename(action.path) || action.path;
          finish({
            status: "done",
            detail: `Revealed "${fileName}" in Finder.`
          });
          break;
        }
        case "open": {
          const fileName = path.basename(action.path) || action.path;
          finish({
            status: "done",
            detail: `Opened "${fileName}".`
          });
          break;
        }
        case "shortcut": {
          const trimmed = stdout.trim();
          const detail =
            trimmed.length > 0 ? trimmed : `Ran shortcut "${action.name}".`;
          finish({
            status: "done",
            detail
          });
          break;
        }
      }
    });
  });
}
