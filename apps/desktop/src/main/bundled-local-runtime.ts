import { markLocalRuntimeFailed } from "./runtime-status.js";
import { assertRuntimeIntegrity } from "./runtime-integrity.js";
import { createHash, randomBytes } from "node:crypto";
import type { QualityMode } from "@cadrane/contracts";
import { planLoad } from "./local/plan.js";
import { readHardwareProfile } from "./local/profile.js";
import { diagnostics } from "./foundations/diagnostics.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const EXTERNAL_RUNTIME_BASE_URL = "http://127.0.0.1:1234";
const CADRANE_LOCAL_BASE_URLS = [
  "http://127.0.0.1:12340", "http://127.0.0.1:12341",
  "http://127.0.0.1:12342", "http://127.0.0.1:12343",
  "http://127.0.0.1:12344", "http://127.0.0.1:12345",
  "http://127.0.0.1:12346", "http://127.0.0.1:12347",
  "http://127.0.0.1:12348", "http://127.0.0.1:12349"
] as const;
type CadraneLocalBaseUrl = typeof CADRANE_LOCAL_BASE_URLS[number];
const LOCAL_RUNTIME_MODEL_ID = "qwen3-4b-q4-k-m";
const LOCAL_RUNTIME_SERVER_SHA256 =
  "a4998768a70ba2be02617ec9d8773accc2952516f4f5a8f38f621ece54cbf04b";
const LOCAL_RUNTIME_MODEL_SHA256 =
  "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5";
const LOCAL_RUNTIME_MODEL_BYTES = 2_497_280_256;
const STARTUP_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 3_000;

export interface BundledLocalRuntimePaths {
  readonly applicationPath: string;
  readonly resourcesPath: string;
  readonly userDataPath: string;
  readonly packaged: boolean;
}

/**
 * Owns the local-beta llama.cpp process. The renderer never receives its API key,
 * process identity, or filesystem paths. A separately installed LM Studio server
 * already listening on the supported loopback port wins and is left untouched.
 */
export class BundledLocalRuntime {
  readonly apiKey = randomBytes(32).toString("base64url");

  private child: ChildProcess | null = null;
  private childExit: Promise<void> | null = null;
  private readyPromise: Promise<boolean> | null = null;
  private startedByRellane = false;
  private stopping = false;
  private diagnostics = "";
  private baseUrl: CadraneLocalBaseUrl | null = null;
  /**
   * What the owner asked for, not what they get.
   *
   * "fast" keeps the model on the graphics card or refuses; "quality" accepts a
   * split across the processor. Defaults to balanced because a first run should
   * work rather than refuse.
   */
  private mode: QualityMode = "balanced";
  /** Why the last start refused, for the screen. Null when it did not. */
  private refusal: string | null = null;

  setMode(mode: QualityMode): void {
    this.mode = mode;
  }

  /** Set when this machine cannot load the model in the mode requested. */
  whyRefused(): string | null {
    return this.refusal;
  }

  /**
   * Whether the model actually answered a health probe.
   *
   * `start()` returns once the process is spawned, which is not the same thing —
   * loading a 2.5 GB model takes up to ninety seconds. This is the only honest
   * source of "ready", and its result was previously computed and thrown away
   * (`void this.readyPromise.catch(...)`), which is why the Engine Room reported
   * a green light for a model that had never answered anything.
   *
   * Returns false when nothing was started, so a caller cannot mistake "we never
   * tried" for "it is loading".
   */
  async whenReady(): Promise<boolean> {
    if (this.readyPromise === null) {
      return false;
    }
    return this.readyPromise.catch(() => false).then(ready => ready && this.child !== null);
  }

  get authorizationBearer(): string | null {
    return this.startedByRellane && this.child !== null ? this.apiKey : null;
  }

  get runtimeBaseUrl(): CadraneLocalBaseUrl | null {
    return this.startedByRellane && this.child !== null ? this.baseUrl : null;
  }

  async start(paths: BundledLocalRuntimePaths): Promise<boolean> {
    if (await hasCompatibleLoopbackRuntime()) {
      return true;
    }
    if (this.child !== null) {
      return true;
    }

    try {
      const serverPath = paths.packaged
        ? path.join(paths.resourcesPath, "llama-b10182", "llama-server")
        : path.join(paths.applicationPath, "vendor", "llama-b10182", "llama-server");
      const modelPath = path.join(
        paths.userDataPath,
        "local-intelligence",
        "managed-models",
        "models",
        LOCAL_RUNTIME_MODEL_ID,
        `${LOCAL_RUNTIME_MODEL_SHA256}.gguf`
      );

      await assertPinnedServer(serverPath, paths.packaged ? path.resolve(paths.resourcesPath, "..", "..") : null);
      const modelBytes = await assertInstalledModel(modelPath);

      /**
       * How to load it, decided from this machine rather than assumed.
       *
       * These were four hardcoded constants: every layer on the GPU, eight
       * threads, a 4k context. All four are right on an Apple Silicon Mac and
       * at least one is wrong everywhere else — `--n-gpu-layers 99` on a machine
       * with an 8 GB card and a 14B model is an allocation failure that reads to
       * the owner as "the app is broken".
       */
      const plan = planLoad(await readHardwareProfile(), modelBytes, this.mode);
      if (!plan.ok) {
        diagnostics.warn("local", "will not load this model on this machine", {
          why: plan.why
        });
        this.refusal = plan.why;
        return false;
      }
      this.refusal = null;
      this.diagnostics = "";
      const baseUrl = await firstVacantBundledBaseUrl();
      if (baseUrl === null) { this.refusal = "All private local-model ports are in use. Close another local runtime and try again."; return false; }
      this.baseUrl = baseUrl;
      const port = new URL(baseUrl).port;

      const child = spawn(serverPath, [
        "--model", modelPath,
        "--host", "127.0.0.1",
        "--port", port,
        "--alias", LOCAL_RUNTIME_MODEL_ID,
        "--n-gpu-layers", String(plan.plan.gpuLayers),
        "--flash-attn", "on",
        "-t", String(plan.plan.threads),
        "--threads-batch", String(plan.plan.threads),
        "--ctx-size", String(plan.plan.ctxSize),
        "--cache-type-k", "q8_0",
        "--cache-type-v", "q8_0",
        "--parallel", "1",
        "--api-key", this.apiKey,
        "--no-webui",
        "--offline"
      ], {
        cwd: path.dirname(serverPath),
        env: {
          LANG: "en_US.UTF-8",
          LC_ALL: "C"
        },
        stdio: ["ignore", "ignore", "pipe"]
      });
      this.child = child;
      this.startedByRellane = true;
      this.childExit = new Promise((resolve) => {
        child.once("close", (code, signal) => {
          if (!this.stopping && this.child === child) {
            this.refusal = runtimeExitProblem(this.diagnostics, code, signal);
            markLocalRuntimeFailed(this.refusal);
          }
          if (this.child === child) {
            this.child = null;
          }
          resolve();
        });
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.diagnostics = `${this.diagnostics}${String(chunk)}`.slice(-16_000);
      });
      child.once("error", () => {
        this.diagnostics = "The bundled local runtime process could not start.";
      });

      this.readyPromise = this.waitUntilReady(child);
      void this.readyPromise.catch(() => false);
      return true;
    } catch (error) {
      this.refusal = error instanceof Error ? error.message : "The local runtime could not start.";
      await this.stop().catch(() => undefined);
      return false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    const exit = this.childExit;
    if (child === null || !this.startedByRellane || this.stopping) {
      return;
    }
    this.stopping = true;
    try {
      child.kill("SIGTERM");
      if (exit !== null) {
        const clean = await settlesWithin(exit, STOP_TIMEOUT_MS);
        if (!clean && this.child === child) {
          child.kill("SIGKILL");
          await settlesWithin(exit, STOP_TIMEOUT_MS);
        }
      }
    } finally {
      this.stopping = false;
      this.startedByRellane = false;
      this.child = null;
      this.childExit = null;
      this.readyPromise = null;
      this.diagnostics = "";
      this.baseUrl = null;
    }
  }

  private async waitUntilReady(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child !== child) {
        return false;
      }
      try {
        if (this.baseUrl === null) return false;
        const response = await fetch(`${this.baseUrl}/health`, {
          headers: { authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(1_500)
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Loading and the first loopback connect race are expected here.
      }
      await delay(200);
    }
    this.refusal = "The local model did not become ready within 90 seconds. It was stopped; no work was sent to it.";
    await this.stop().catch(() => undefined);
    return false;
  }
}

async function hasCompatibleLoopbackRuntime(): Promise<boolean> {
  try {
    const response = await fetch(`${EXTERNAL_RUNTIME_BASE_URL}/v1/models`, {
      signal: AbortSignal.timeout(700)
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json() as { readonly data?: unknown };
    return Array.isArray(body.data);
  } catch {
    return false;
  }
}

async function firstVacantBundledBaseUrl(): Promise<CadraneLocalBaseUrl | null> {
  for (const baseUrl of CADRANE_LOCAL_BASE_URLS) {
    if (await canBindLoopbackPort(Number(new URL(baseUrl).port))) return baseUrl;
  }
  return null;
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolve(error === undefined));
    });
  });
}

async function assertPinnedServer(serverPath: string, appBundlePath: string | null): Promise<void> {
  const observed = await lstat(serverPath);
  if (!observed.isFile() || observed.isSymbolicLink()) {
    throw new Error("The bundled local runtime is not a regular file.");
  }
  const canonical = await realpath(serverPath);
  if (canonical !== path.resolve(serverPath)) {
    throw new Error("The bundled local runtime path changed during startup.");
  }
  await assertRuntimeIntegrity({
    serverPath, appBundlePath, expectedDigest: LOCAL_RUNTIME_SERVER_SHA256,
    digest: async () => {
      const digest = createHash("sha256");
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(serverPath);
        stream.on("data", (chunk) => digest.update(chunk));
        stream.once("error", reject);
        stream.once("end", resolve);
      });
      return digest.digest("hex");
    }
  });
}

async function assertInstalledModel(modelPath: string): Promise<number> {
  const observed = await lstat(modelPath);
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.size !== LOCAL_RUNTIME_MODEL_BYTES ||
    path.basename(modelPath) !== `${LOCAL_RUNTIME_MODEL_SHA256}.gguf`
  ) {
    throw new Error("The installed local model did not match its verified record.");
  }
  const canonical = await realpath(modelPath);
  if (canonical !== path.resolve(modelPath)) {
    throw new Error("The installed local model path changed during startup.");
  }
  // The verified size, returned rather than re-read: the planner needs it, and
  // reading it a second time would open a window where the two disagree.
  return observed.size;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    delay(milliseconds).then(() => false)
  ]);
}

/** Classify known failures without exposing native logs, prompt text or paths. */
export function runtimeExitProblem(log: string, code: number | null, signal: string | null): string {
  if (log.includes("failed to create command queue")) return "The local model could not access this Mac's graphics queue. Close other GPU-heavy work and restart the app. This request was not moved to another model.";
  if (log.includes("failed to allocate") || log.includes("out of memory")) return "The local model could not allocate enough working memory. Close other heavy applications before trying again.";
  if (log.includes("error while handling argument")) return "The bundled model runner rejected its startup options. Install a corrected build before trying again.";
  return `The local model stopped (${signal ?? `exit code ${code ?? "unknown"}`}). Restart the app before asking it for more work.`;
}
