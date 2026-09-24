import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface EmbeddingRuntimeOptions {
  readonly executablePath?: string;
  readonly modelPath?: string;
  /** Loopback port. Never a remote host. */
  readonly port?: number;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export type EmbeddingResult =
  | {
      readonly status: "embedded";
      readonly vectors: readonly (readonly number[])[];
      readonly dimensions: number;
      readonly model: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export const MAX_BATCH = 32;
export const MAX_INPUT_CHARS = 8_000;

export const DEFAULT_LOOPBACK_PORT = 18412;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// Loopback host for all child process bindings and HTTP requests.
// There is no code path in this module that can reach a non-loopback host —
// no configurable base URL, no proxy, and no fallback endpoint.
// Requests go to http://127.0.0.1:<port> and nowhere else.
const LOOPBACK_HOST = "127.0.0.1";

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(forceKillTimer);
        resolve();
      }
    };

    child.once("exit", finish);
    child.once("close", finish);

    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }

    const forceKillTimer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // Child may have already exited.
      }
      finish();
    }, 250);

    if (typeof forceKillTimer.unref === "function") {
      forceKillTimer.unref();
    }
  });
}

async function waitForReadiness(
  port: number,
  timeoutMs: number,
  child: ChildProcess
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://${LOOPBACK_HOST}:${port}/health`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }

    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(500, remainingMs))
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Server is starting up and not yet accepting HTTP connections.
    }

    if (Date.now() + 50 >= deadline) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  return false;
}

export async function embedTexts(
  texts: readonly string[],
  options?: EmbeddingRuntimeOptions
): Promise<EmbeddingResult> {
  if (texts.length === 0) {
    return {
      status: "unavailable",
      reason: "No texts were provided to embed."
    };
  }

  if (texts.length > MAX_BATCH) {
    return {
      status: "unavailable",
      reason: `Batch size of ${texts.length} exceeds the limit of ${MAX_BATCH}.`
    };
  }

  for (const text of texts) {
    if (text.length > MAX_INPUT_CHARS) {
      return {
        status: "unavailable",
        reason: `Text length of ${text.length} characters exceeds the limit of ${MAX_INPUT_CHARS}.`
      };
    }
  }

  if (!options?.executablePath || options.executablePath.trim().length === 0) {
    return {
      status: "unavailable",
      reason: "An embedding runtime executable is not configured on this Mac."
    };
  }

  if (!options?.modelPath || options.modelPath.trim().length === 0) {
    return {
      status: "unavailable",
      reason: "An embedding model is not installed on this Mac."
    };
  }

  // Generative models (such as qwen3-4b) lack metric embeddings; refuse early.
  if (options.modelPath.toLowerCase().includes("qwen")) {
    return {
      status: "unavailable",
      reason: "The installed model is not an embedding model."
    };
  }

  const port = options.port ?? DEFAULT_LOOPBACK_PORT;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Resolve executable path to guarantee spawn targets the exact binary or script.
  const executablePath = path.resolve(options.executablePath);
  const modelPath = path.resolve(options.modelPath);

  const argv: readonly string[] = [
    "--model",
    modelPath,
    "--host",
    LOOPBACK_HOST,
    "--port",
    String(port),
    "--embedding"
  ];

  let child: ChildProcess | null = null;
  try {
    let spawnError: Error | null = null;

    child = spawn(executablePath, [...argv], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    child.on("error", (err) => {
      spawnError = err;
    });

    // Drain pipes to prevent buffer saturation from blocking child execution.
    if (child.stdout) {
      child.stdout.on("data", () => {});
    }
    if (child.stderr) {
      child.stderr.on("data", () => {});
    }

    const isReady = await waitForReadiness(port, startupTimeoutMs, child);
    if (!isReady || spawnError !== null) {
      return {
        status: "unavailable",
        reason:
          spawnError !== null
            ? "The embedding server could not be started."
            : "The embedding server did not become ready in time."
      };
    }

    const requestUrl = `http://${LOOPBACK_HOST}:${port}/v1/embeddings`;
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ input: texts }),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
    } catch {
      return {
        status: "unavailable",
        reason: "The embedding request timed out or could not be completed."
      };
    }

    if (!response.ok) {
      return {
        status: "unavailable",
        reason: "The embedding server returned an error."
      };
    }

    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch {
      return {
        status: "unavailable",
        reason: "The embedding server returned an unreadable response."
      };
    }

    if (typeof responseJson !== "object" || responseJson === null) {
      return {
        status: "unavailable",
        reason: "The embedding response format was not recognised."
      };
    }

    const record = responseJson as Record<string, unknown>;
    const modelVal = record["model"];
    if (typeof modelVal !== "string" || modelVal.trim().length === 0) {
      return {
        status: "unavailable",
        reason: "The embedding response did not identify the loaded model."
      };
    }
    const model = modelVal.trim();

    if (model.toLowerCase().includes("qwen")) {
      return {
        status: "unavailable",
        reason: "The installed model is not an embedding model."
      };
    }

    const dataItems = record["data"];
    if (!Array.isArray(dataItems) || dataItems.length !== texts.length) {
      return {
        status: "unavailable",
        reason: "The embedding response did not contain the expected number of vectors."
      };
    }

    // When indices are provided, sort items by index to preserve input batch alignment.
    const hasIndices = dataItems.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>)["index"] === "number"
    );

    const sortedItems = hasIndices
      ? [...dataItems].sort(
          (a, b) =>
            ((a as Record<string, unknown>)["index"] as number) -
            ((b as Record<string, unknown>)["index"] as number)
        )
      : dataItems;

    const vectors: (readonly number[])[] = [];

    for (const item of sortedItems) {
      if (typeof item !== "object" || item === null) {
        return {
          status: "unavailable",
          reason: "The embedding response contained an invalid vector entry."
        };
      }

      const itemRecord = item as Record<string, unknown>;
      const embeddingVal = itemRecord["embedding"];
      if (!Array.isArray(embeddingVal) || embeddingVal.length === 0) {
        return {
          status: "unavailable",
          reason: "An embedding vector was missing or empty."
        };
      }

      const vector: number[] = [];
      for (const num of embeddingVal) {
        if (typeof num !== "number" || !Number.isFinite(num)) {
          return {
            status: "unavailable",
            reason: "An embedding vector contained non-numeric values."
          };
        }
        vector.push(num);
      }

      vectors.push(vector);
    }

    const firstVector = vectors[0];
    if (!firstVector || firstVector.length === 0) {
      return {
        status: "unavailable",
        reason: "An embedding vector was empty."
      };
    }

    const dimensions = firstVector.length;
    for (let i = 1; i < vectors.length; i++) {
      const currentVector = vectors[i];
      if (!currentVector || currentVector.length !== dimensions) {
        return {
          status: "unavailable",
          reason: "Embedding vectors in the batch have mismatched dimensions."
        };
      }
    }

    return {
      status: "embedded",
      vectors,
      dimensions,
      model
    };
  } finally {
    if (child !== null) {
      await stopChildProcess(child);
    }
  }
}
