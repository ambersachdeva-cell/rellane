import {
  DAEMON_PROTOCOL_VERSION,
  DaemonRequestSchema,
  type DaemonResponse
} from "@cadrane/contracts";
import {
  DaemonDurableSpaceLockRequestSchema,
  DaemonDurableSpaceUnlockRequestSchema,
  DaemonPrivateReadyEventSchema,
  DaemonShutdownRequestSchema
} from "@cadrane/contracts/daemon-control";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  createDaemonDispatcher,
  toRendererSafeDaemonError,
  type DaemonWorkRequest
} from "./service.js";
import {
  DurableUnlockSessionController,
  wipeRecognizableKeyMaterial
} from "./durable-unlock-session.js";

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

type UtilityProcess = NodeJS.Process & { parentPort?: ParentPort };

const processParentPort = (process as UtilityProcess).parentPort;
if (processParentPort === undefined) {
  throw new Error("Rellane daemon requires an Electron utility-process parent.");
}
const parentPort: ParentPort = processParentPort;

const daemonSessionId = randomUUID();
const durableUnlockSession = new DurableUnlockSessionController(daemonSessionId);
const dispatcher = createDaemonDispatcher({
  dataDirectory: process.env.SWITCHBOARD_DATA_DIR ?? "",
  automationKeySource: durableUnlockSession
});
const activeRequests = new Map<string, ActiveRequest>();
let accepting = true;
let shutdownPromise: Promise<void> | null = null;

parentPort.on("message", (event) => {
  const shutdown = DaemonShutdownRequestSchema.safeParse(event.data);
  if (shutdown.success) {
    void handleShutdownRequest(shutdown.data.requestId);
    return;
  }
  const unlock = DaemonDurableSpaceUnlockRequestSchema.safeParse(event.data);
  if (unlock.success) {
    void handleUnlockRequest(unlock.data);
    return;
  }
  const lock = DaemonDurableSpaceLockRequestSchema.safeParse(event.data);
  if (lock.success) {
    void handleLockRequest(lock.data);
    return;
  }
  wipeRecognizableReceivedControlKey(event.data);
  acceptWorkRequest(event.data);
});

process.once("SIGTERM", () => {
  void shutdownForSignal();
});

parentPort.postMessage(DaemonPrivateReadyEventSchema.parse({
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  type: "daemon.ready",
  pid: process.pid,
  daemonSessionId
}));

async function handleUnlockRequest(
  request: import("@cadrane/contracts/daemon-control").DaemonDurableSpaceUnlockRequest
): Promise<void> {
  try {
    if (!accepting) throw new Error("unavailable");
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      data: durableUnlockSession.unlock(request)
    });
  } catch {
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "The durable-space control request was rejected.",
        retryable: false
      }
    });
  } finally {
    // Invalid/rejected requests have no other owner that can clear transferred bytes.
    wipeRecognizableKeyMaterial(request.payload.keyMaterial);
  }
}

async function handleLockRequest(
  request: import("@cadrane/contracts/daemon-control").DaemonDurableSpaceLockRequest
): Promise<void> {
  try {
    if (!accepting) throw new Error("unavailable");
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      data: durableUnlockSession.lock(request)
    });
  } catch {
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "The durable-space control request was rejected.",
        retryable: false
      }
    });
  }
}

function acceptWorkRequest(value: unknown): void {
  const parsed = DaemonRequestSchema.safeParse(value);
  if (!parsed.success) {
    const requestId = extractRequestId(value);
    if (requestId !== null) {
      respond({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: "The daemon rejected an invalid request.",
          retryable: false
        }
      });
    }
    return;
  }

  const request = parsed.data;
  if (!accepting) {
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "The isolated local service is shutting down.",
        retryable: false
      }
    });
    return;
  }

  if (request.type === "request.cancel") {
    const active = activeRequests.get(request.payload.targetRequestId);
    active?.controller.abort();
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      data: { cancelled: active !== undefined }
    });
    return;
  }

  const controller = new AbortController();
  const settled = Promise.resolve().then(() =>
    executeWorkRequest(request, controller.signal)
  );
  activeRequests.set(request.requestId, { controller, settled });
  const removeSettledRequest = () => {
    if (activeRequests.get(request.requestId)?.settled === settled) {
      activeRequests.delete(request.requestId);
    }
  };
  void settled.then(removeSettledRequest, removeSettledRequest);
}

async function executeWorkRequest(
  request: DaemonWorkRequest,
  signal: AbortSignal
): Promise<void> {
  try {
    const data = await dispatcher.dispatch(request, signal);
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      data
    });
  } catch (error) {
    const detail = error instanceof ZodError
      ? {
          code: "RUNTIME_RESPONSE_INVALID" as const,
          message: "A local component returned data outside its contract.",
          retryable: false
        }
      : toRendererSafeDaemonError(error, request.type);
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: detail
    });
  }
}

async function handleShutdownRequest(requestId: string): Promise<void> {
  try {
    await beginShutdown();
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      ok: true,
      data: { shutdown: "clean" }
    });
    setImmediate(() => process.exit(0));
  } catch {
    respond({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "The isolated local service could not confirm clean shutdown.",
        retryable: false
      }
    });
    setImmediate(() => process.exit(1));
  }
}

function beginShutdown(): Promise<void> {
  if (shutdownPromise !== null) {
    return shutdownPromise;
  }
  accepting = false;
  shutdownPromise = (async () => {
    durableUnlockSession.shutdown();
    const active = [...activeRequests.values()];
    for (const request of active) {
      request.controller.abort(
        new DOMException("The isolated local service is shutting down.", "AbortError")
      );
    }
    await Promise.allSettled(active.map((request) => request.settled));
    await dispatcher.shutdown();
  })();
  return shutdownPromise;
}

function wipeRecognizableReceivedControlKey(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  try {
    const payload = Reflect.get(value, "payload");
    if (typeof payload !== "object" || payload === null) return;
    wipeRecognizableKeyMaterial(Reflect.get(payload, "keyMaterial"));
  } catch {
    // Malformed input has no authority and must not crash the daemon listener.
  }
}

async function shutdownForSignal(): Promise<void> {
  try {
    await beginShutdown();
    setImmediate(() => process.exit(0));
  } catch {
    setImmediate(() => process.exit(1));
  }
}

function respond(response: DaemonResponse): void {
  parentPort.postMessage(response);
}

function extractRequestId(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    /^[0-9a-f-]{36}$/i.test(value.requestId)
  ) {
    return value.requestId;
  }
  return null;
}
