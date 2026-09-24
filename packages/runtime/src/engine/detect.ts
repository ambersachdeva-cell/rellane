/**
 * Finding out what this machine can actually run.
 *
 * Everything here reports what was observed. A backend is available only after
 * it has been executed and answered — never because a file exists, and never
 * because the platform suggests it should.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mlxIsPossible, type BackendCapability, type MachineFacts } from "./backend.js";

const run = promisify(execFile);
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Python interpreters worth asking, in order.
 *
 * A packaged app launched from Finder has almost none of the user's PATH, so
 * the well-known locations matter more than `python3` does.
 */
const PYTHONS: readonly string[] = Object.freeze([
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
  "python3"
]);

/**
 * Detects MLX by importing it and asking its version.
 *
 * Checking for the package directory would be cheaper and would lie: a broken
 * install, an incompatible NumPy, or a Python that cannot load the Metal
 * extension all leave the files exactly where a file check would find them.
 */
export async function detectMlx(machine: MachineFacts): Promise<BackendCapability> {
  if (!mlxIsPossible(machine)) {
    return {
      id: "mlx",
      available: false,
      detail: "MLX runs only on Apple Silicon."
    };
  }

  for (const python of PYTHONS) {
    try {
      const { stdout } = await run(
        python,
        ["-c", "import mlx_lm, mlx.core as mx; print(mlx_lm.__version__)"],
        { timeout: PROBE_TIMEOUT_MS }
      );
      const version = stdout.trim();
      if (version.length > 0) {
        return { id: "mlx", available: true, detail: `mlx-lm ${version} via ${python}` };
      }
    } catch {
      // Next interpreter. A failure here is the ordinary case, not an error.
      continue;
    }
  }

  return {
    id: "mlx",
    available: false,
    detail: "mlx-lm is not installed. `pip install mlx-lm` enables a faster engine on this Mac."
  };
}

/**
 * The bundled llama.cpp, confirmed by running it.
 *
 * This one is expected to work — its bytes are pinned and hash-verified at
 * build time — so a failure here means something is wrong with the install
 * itself and is worth reporting rather than shrugging at.
 */
export async function detectBundled(serverPath: string): Promise<BackendCapability> {
  try {
    const { stdout, stderr } = await run(serverPath, ["--version"], {
      timeout: PROBE_TIMEOUT_MS
    });
    const line = `${stdout}${stderr}`.split("\n").find((l) => l.trim().length > 0) ?? "";
    return { id: "llama-cpp", available: true, detail: line.trim() || "bundled" };
  } catch (error) {
    return {
      id: "llama-cpp",
      available: false,
      detail: `The bundled engine did not start: ${
        error instanceof Error ? error.message.slice(0, 160) : "unknown error"
      }`
    };
  }
}

export async function detectBackends(input: {
  readonly machine: MachineFacts;
  readonly bundledServerPath: string;
}): Promise<readonly BackendCapability[]> {
  return await Promise.all([detectMlx(input.machine), detectBundled(input.bundledServerPath)]);
}
