import {
  execFile,
  spawn,
  type ChildProcess
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RuntimeBoundaryError } from "../errors.js";
import type {
  HealthObservation,
  LoopbackListenerOwnershipVerifier,
  LoopbackPortAllocator,
  LoopbackPortReservation,
  ManagedRuntimeClock,
  ManagedRuntimeHttpClient,
  ManagedRuntimeSecretSource,
  OwnedRuntimeProcess,
  RuntimeProcessExit,
  RuntimeProcessHost,
  RuntimeProcessSpec
} from "./types.js";
import type { LocalChatRequest } from "@cadrane/contracts";

const LOOPBACK_HOST = "127.0.0.1";
const HEALTH_RESPONSE_LIMIT = 64 * 1024;
const CHAT_RESPONSE_LIMIT = 4_000_000;
const HEALTH_ATTEMPT_TIMEOUT_MS = 2_000;
const CHAT_TIMEOUT_MS = 120_000;
const LISTENER_OWNERSHIP_TIMEOUT_MS = 2_000;
const PROCESS_KILL_TIMEOUT_MS = 3_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 25;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const ChatResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().max(2_000_000)
    })
  })).min(1).max(100)
});

export class NodeLoopbackPortAllocator implements LoopbackPortAllocator {
  async reserve(signal: AbortSignal): Promise<LoopbackPortReservation> {
    throwIfAborted(signal);
    const server = createServer({ pauseOnConnect: true });
    server.on("connection", (socket) => {
      socket.destroy();
    });

    const port = await listenOnEphemeralLoopback(server, signal);
    if (signal.aborted) {
      await closeServer(server);
      throw cancelled(signal.reason);
    }
    let released = false;
    return {
      port,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await closeServer(server);
      }
    };
  }
}

export class NodeRuntimeProcessHost implements RuntimeProcessHost {
  spawn(spec: RuntimeProcessSpec): OwnedRuntimeProcess {
    if (
      !isAbsolute(spec.executable) ||
      !isAbsolute(spec.cwd) ||
      spec.args.some((argument) => argument.includes("\0")) ||
      Object.keys(spec.env).some((key) => key.includes("\0")) ||
      Object.values(spec.env).some((value) => value.includes("\0"))
    ) {
      throw securityBoundary("The managed runtime process specification is unsafe.");
    }

    const child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    if (child.stderr === null) {
      child.kill("SIGKILL");
      throw runtimeUnavailable("The managed runtime diagnostic pipe was unavailable.");
    }

    const exit = processExitPromise(child);
    return {
      pid: child.pid ?? 0,
      stderr: child.stderr,
      exit,
      get alive() {
        return (
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        );
      }
    };
  }

  async terminateTree(
    child: OwnedRuntimeProcess,
    gracefulTimeoutMs: number
  ): Promise<void> {
    if (
      !Number.isInteger(child.pid) ||
      child.pid <= 1 ||
      !Number.isInteger(gracefulTimeoutMs) ||
      gracefulTimeoutMs < 0 ||
      gracefulTimeoutMs > 10_000
    ) {
      throw securityBoundary("The managed runtime process identity is unsafe.");
    }
    signalProcessGroup(child.pid, "SIGTERM");
    if (await processTreeSettlesWithin(child, gracefulTimeoutMs)) {
      return;
    }
    signalProcessGroup(child.pid, "SIGKILL");
    if (!await processTreeSettlesWithin(child, PROCESS_KILL_TIMEOUT_MS)) {
      throw runtimeUnavailable(
        "The managed runtime process tree did not exit after forced termination."
      );
    }
  }
}

export class MacOsLoopbackListenerOwnershipVerifier
implements LoopbackListenerOwnershipVerifier {
  async isOwnedBy(
    pid: number,
    port: number,
    signal: AbortSignal
  ): Promise<boolean> {
    if (
      process.platform !== "darwin" ||
      !Number.isInteger(pid) ||
      pid <= 1 ||
      !isValidPort(port)
    ) {
      return false;
    }
    throwIfAborted(signal);
    let output: string | null;
    try {
      output = await runLsof(pid, port, signal);
    } catch (error) {
      if (signal.aborted) {
        throw cancelled(error);
      }
      output = null;
    }
    return output !== null &&
      isExactOwnedLoopbackListenerOutput(output, pid, port);
  }
}

export type ManagedRuntimeFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export class NodeManagedRuntimeHttpClient implements ManagedRuntimeHttpClient {
  constructor(
    private readonly fetchImpl: ManagedRuntimeFetch = fetch
  ) {}

  async health(
    port: number,
    signal: AbortSignal
  ): Promise<HealthObservation> {
    const url = loopbackUrl(port, "/health");
    const attemptTimeout = AbortSignal.timeout(HEALTH_ATTEMPT_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, attemptTimeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: combinedSignal,
        headers: { accept: "application/json" }
      });
    } catch (error) {
      if (signal.aborted) {
        throw cancelled(error);
      }
      return { state: "unavailable" };
    }
    assertExactResponseUrl(response, url);
    let bytes: Uint8Array;
    try {
      bytes = await readBodyWithinLimit(
        response,
        HEALTH_RESPONSE_LIMIT,
        combinedSignal
      );
    } catch (error) {
      if (signal.aborted) {
        throw cancelled(error);
      }
      if (attemptTimeout.aborted) {
        return { state: "unavailable" };
      }
      throw error;
    }
    if (response.status === 503) {
      return { state: "loading" };
    }
    if (response.status !== 200) {
      throw invalidResponse(
        "The managed runtime returned an unexpected health status."
      );
    }
    const value = parseJson(bytes, "The managed runtime health response was invalid.");
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("status" in value) ||
      value.status !== "ok"
    ) {
      throw invalidResponse(
        "The managed runtime did not return the exact ready health response."
      );
    }
    return { state: "ready" };
  }

  async chat(
    port: number,
    request: LocalChatRequest,
    apiKey: string,
    signal: AbortSignal
  ): Promise<string> {
    assertValidApiKey(apiKey);
    const url = loopbackUrl(port, "/v1/chat/completions");
    const timeoutSignal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal: combinedSignal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: false
        })
      });
    } catch (error) {
      if (signal.aborted) {
        throw cancelled(error);
      }
      if (timeoutSignal.aborted) {
        throw new RuntimeBoundaryError({
          code: "TIMEOUT",
          message: "The managed runtime answer exceeded its local deadline.",
          retryable: true
        }, error instanceof Error ? { cause: error } : undefined);
      }
      throw runtimeUnavailable(
        "The managed runtime stopped responding on loopback.",
        error
      );
    }
    assertExactResponseUrl(response, url);
    let bytes: Uint8Array;
    try {
      bytes = await readBodyWithinLimit(
        response,
        CHAT_RESPONSE_LIMIT,
        combinedSignal
      );
    } catch (error) {
      if (signal.aborted) {
        throw cancelled(error);
      }
      if (timeoutSignal.aborted) {
        throw new RuntimeBoundaryError({
          code: "TIMEOUT",
          message: "The managed runtime answer exceeded its local deadline.",
          retryable: true
        }, error instanceof Error ? { cause: error } : undefined);
      }
      throw error;
    }
    if (!response.ok) {
      throw invalidResponse(
        "The managed runtime returned an unsuccessful chat response.",
        response.status >= 500
      );
    }
    const parsed = ChatResponseSchema.safeParse(
      parseJson(bytes, "The managed runtime chat response was invalid.")
    );
    const content = parsed.success
      ? parsed.data.choices[0]?.message.content
      : undefined;
    if (content === undefined) {
      throw invalidResponse(
        "The managed runtime chat response did not match its bounded contract."
      );
    }
    return content;
  }
}

export class NodeManagedRuntimeSecretSource
implements ManagedRuntimeSecretSource {
  createApiKey(): string {
    return randomBytes(32).toString("base64url");
  }
}

export class NodeManagedRuntimeClock implements ManagedRuntimeClock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    return performance.now();
  }

  delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 60_000
    ) {
      return Promise.reject(new Error("The managed runtime delay is invalid."));
    }
    if (signal.aborted) {
      return Promise.reject(cancelled(signal.reason));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      timer.unref();
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(cancelled(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }
}

async function listenOnEphemeralLoopback(
  server: Server,
  signal: AbortSignal
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let aborted = signal.aborted;
    let closing = false;
    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const closeAfterAbort = () => {
      if (closing || settled) {
        return;
      }
      closing = true;
      void closeServer(server).then(
        () => finishReject(cancelled(signal.reason)),
        (error) => finishReject(runtimeUnavailable(
          "The cancelled private port reservation could not be closed.",
          error
        ))
      );
    };
    const onAbort = () => {
      aborted = true;
      if (server.listening) {
        closeAfterAbort();
      }
    };
    const onError = (error: Error) => {
      finishReject(aborted
        ? cancelled(signal.reason)
        : runtimeUnavailable(
          "A private loopback port could not be reserved.",
          error
        ));
    };
    const onListening = () => {
      if (aborted) {
        closeAfterAbort();
        return;
      }
      const address = server.address();
      if (
        address === null ||
        typeof address === "string" ||
        address.address !== LOOPBACK_HOST ||
        !isValidPort(address.port)
      ) {
        void closeServer(server).then(
          () => finishReject(securityBoundary(
            "The private runtime port was not reserved on IPv4 loopback."
          )),
          (error) => finishReject(runtimeUnavailable(
            "The invalid private port reservation could not be closed.",
            error
          ))
        );
        return;
      }
      settled = true;
      cleanup();
      server.unref();
      resolve(address.port);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({
        host: LOOPBACK_HOST,
        port: 0,
        exclusive: true
      });
    } catch (error) {
      finishReject(runtimeUnavailable(
        "A private loopback port could not be reserved.",
        error
      ));
    }
  });
}

function processExitPromise(child: ChildProcess): Promise<RuntimeProcessExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exit: RuntimeProcessExit) => {
      if (!settled) {
        settled = true;
        resolve(exit);
      }
    };
    child.once("error", (error) => {
      finish({
        code: null,
        signal: null,
        error
      });
    });
    child.once("exit", (code, signal) => {
      finish({ code, signal });
    });
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw runtimeUnavailable(
        "The managed runtime process tree could not be stopped.",
        error
      );
    }
  }
}

async function processTreeSettlesWithin(
  child: OwnedRuntimeProcess,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (!child.alive && !isProcessGroupAlive(child.pid)) {
      await child.exit.catch(() => undefined);
      return true;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      break;
    }
    await unrefDelay(Math.min(PROCESS_GROUP_POLL_INTERVAL_MS, remaining));
  }
  return !child.alive && !isProcessGroupAlive(child.pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return true;
    }
    throw runtimeUnavailable(
      "The managed runtime process group could not be inspected.",
      error
    );
  }
}

function unrefDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function runLsof(
  pid: number,
  port: number,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/lsof",
      [
        "-n",
        "-P",
        "-a",
        "-p",
        String(pid),
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-Fpn"
      ],
      {
        encoding: "utf8",
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
        },
        timeout: LISTENER_OWNERSHIP_TIMEOUT_MS,
        maxBuffer: 32 * 1024,
        signal
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function readBodyWithinLimit(
  response: Response,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(announced) && announced > limit) {
    throw invalidResponse("The managed runtime response exceeded its safety limit.");
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const item = await reader.read();
      if (item.done) {
        break;
      }
      total += item.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw invalidResponse(
          "The managed runtime response exceeded its safety limit."
        );
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (signal.aborted) {
      throw cancelled(error);
    }
    throw error;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array, message: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw invalidResponse(message, false, error);
  }
}

function assertExactResponseUrl(response: Response, expectedUrl: string): void {
  if (response.redirected || response.url !== expectedUrl) {
    throw securityBoundary(
      "The managed runtime loopback response changed origin or endpoint."
    );
  }
}

function loopbackUrl(port: number, path: string): string {
  if (!isValidPort(port) || !path.startsWith("/") || path.includes("://")) {
    throw securityBoundary("The managed runtime loopback endpoint is invalid.");
  }
  return `http://${LOOPBACK_HOST}:${port}${path}`;
}

export function isExactOwnedLoopbackListenerOutput(
  output: string,
  pid: number,
  port: number
): boolean {
  if (
    output.length === 0 ||
    output.length > 32 * 1024 ||
    !Number.isInteger(pid) ||
    pid <= 1 ||
    !isValidPort(port)
  ) {
    return false;
  }
  const lines = output.split(/\r?\n/gu);
  return (
    lines.some((line) => line === `p${pid}`) &&
    lines.some((line) => line === `n${LOOPBACK_HOST}:${port}`)
  );
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535;
}

function assertValidApiKey(apiKey: string): void {
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw securityBoundary(
      "The managed runtime API credential did not match its fixed contract."
    );
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ESRCH";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelled(signal.reason);
  }
}

function cancelled(cause?: unknown): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "CANCELLED",
    message: "The managed runtime operation was cancelled.",
    retryable: true
  }, cause instanceof Error ? { cause } : undefined);
}

function invalidResponse(
  message: string,
  retryable = false,
  cause?: unknown
): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_RESPONSE_INVALID",
    message,
    retryable
  }, cause instanceof Error ? { cause } : undefined);
}

function runtimeUnavailable(
  message: string,
  cause?: unknown
): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message,
    retryable: true
  }, cause instanceof Error ? { cause } : undefined);
}

function securityBoundary(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message,
    retryable: false
  });
}
