import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  app,
  utilityProcess,
  type UtilityProcess
} from "electron";
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonRequestSchema,
  DaemonResponseSchema,
  type DaemonRequest
} from "@cadrane/contracts";
import {
  DaemonDurableSpaceLockAcknowledgementSchema,
  DaemonDurableSpaceLockRequestSchema,
  DaemonDurableSpaceUnlockAcknowledgementSchema,
  DaemonDurableSpaceUnlockRequestSchema,
  DaemonPrivateReadyEventSchema,
  DaemonShutdownAcknowledgementSchema,
  DaemonShutdownRequestSchema,
  isPrivateControlKeyMaterial
} from "@cadrane/contracts/daemon-control";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface DaemonStopResult {
  readonly clean: boolean;
  readonly forced: boolean;
  readonly hardKilled: boolean;
  readonly exited: boolean;
}

export interface DaemonProcessTerminationBoundary {
  requestGracefulTermination(child: UtilityProcess): void;
  forceKill(child: UtilityProcess): void;
}

class NodeDaemonProcessTerminationBoundary
implements DaemonProcessTerminationBoundary {
  requestGracefulTermination(child: UtilityProcess): void {
    child.kill();
  }

  forceKill(child: UtilityProcess): void {
    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
      throw new Error("The isolated local service has no safe process ID.");
    }
    process.kill(pid, "SIGKILL");
  }
}

type DaemonClientState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "disabled";

const MAX_PENDING_REQUESTS = 8;
const DAEMON_START_TIMEOUT_MS = 8_000;
const DAEMON_SHUTDOWN_ACK_TIMEOUT_MS = 3_000;
const DAEMON_EXIT_TIMEOUT_MS = 2_000;
const DURABLE_CONTROL_TIMEOUT_MS = 3_000;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

export interface DurableSpaceUnlockInput {
  readonly spaceId: string;
  readonly keyId: string;
  /** Ownership transfers to this method: it is zeroed before return or throw. */
  readonly keyMaterial: Uint8Array;
}

export interface DurableSpaceLockInput {
  readonly spaceId: string;
  readonly keyId: string;
}

export class DaemonClient {
  private readonly terminationBoundary: DaemonProcessTerminationBoundary;
  private child: UtilityProcess | null = null;
  private state: DaemonClientState = "stopped";
  private permanentlyDisabled = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason: unknown) => void) | null = null;
  private childExitPromise: Promise<void> | null = null;
  private childExitResolve: (() => void) | null = null;
  private stopPromise: Promise<DaemonStopResult> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private daemonSessionId: string | null = null;
  private localRuntimeApiKey: string | null = null;
  private localRuntimeBaseUrl: string | null = null;

  constructor(
    terminationBoundary: DaemonProcessTerminationBoundary =
      new NodeDaemonProcessTerminationBoundary()
  ) {
    this.terminationBoundary = terminationBoundary;
  }

  configureBundledLocalRuntime(apiKey: string | null, baseUrl: string | null): void {
    if (this.child !== null || this.state !== "stopped") {
      throw new Error("The local runtime must be configured before the daemon starts.");
    }
    if (apiKey !== null && !/^[A-Za-z0-9_-]{43}$/u.test(apiKey)) {
      throw new Error("The bundled local runtime credential is invalid.");
    }
    if ((apiKey === null) !== (baseUrl === null)) {
      throw new Error("The bundled local runtime endpoint is incomplete.");
    }
    if (baseUrl !== null && !/^http:\/\/127\.0\.0\.1:1234[0-9]$/u.test(baseUrl)) {
      throw new Error("The bundled local runtime endpoint is invalid.");
    }
    this.localRuntimeApiKey = apiKey;
    this.localRuntimeBaseUrl = baseUrl;
  }

  async request<T>(
    request: Omit<DaemonRequest, "protocolVersion" | "requestId">,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    await this.ensureStarted();
    signal?.throwIfAborted();
    if (this.state !== "running") {
      throw new Error("The isolated local service is not accepting work.");
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error("The isolated local service is busy. Wait for current work to finish.");
    }
    const requestId = randomUUID();
    const envelope = DaemonRequestSchema.parse({
      ...request,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId
    });

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectPending = (error: Error, cancelDaemonRequest: boolean) => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) {
          return;
        }
        clearTimeout(pending.timer);
        pending.cleanup();
        this.pending.delete(requestId);
        if (cancelDaemonRequest) {
          this.cancelRequest(requestId);
        }
        reject(error);
      };
      const onAbort = () => {
        rejectPending(
          new DOMException("The local request was cancelled.", "AbortError"),
          true
        );
      };
      const timer = setTimeout(() => {
        rejectPending(
          new Error("The isolated local service did not respond in time."),
          true
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        cleanup
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const child = this.child;
      if (child === null || this.state !== "running") {
        rejectPending(new Error("The isolated local service is unavailable."), false);
        return;
      }
      try {
        child.postMessage(envelope);
      } catch (caught) {
        rejectPending(
          caught instanceof Error
            ? caught
            : new Error("The isolated local service could not receive the request."),
          false
        );
      }
    });
  }

  /**
   * Private main-to-daemon key transfer. It is deliberately not part of IPC,
   * preload, the renderer bridge, or the generic daemon work dispatcher.
   */
  async unlockDurableSpace(input: DurableSpaceUnlockInput): Promise<void> {
    const callerKey = input.keyMaterial;
    let outbound: Uint8Array | null = null;
    let childForFailure: UtilityProcess | null = null;
    try {
      CanonicalDurableIdSchema.parse(input.spaceId);
      CanonicalDurableIdSchema.parse(input.keyId);
      if (!isPrivateControlKeyMaterial(callerKey)) {
        throw new Error("Durable-space key material is invalid.");
      }
      outbound = copyPrivateControlKey(callerKey);
      await this.ensureStarted();
      const child = this.child;
      const daemonSessionId = this.daemonSessionId;
      if (child === null || daemonSessionId === null || this.state !== "running") {
        throw new Error("The isolated local service has no durable-space session.");
      }
      childForFailure = child;
      const requestId = randomUUID();
      const envelope = DaemonDurableSpaceUnlockRequestSchema.parse({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        requestId,
        type: "durable-space.unlock",
        payload: { daemonSessionId, spaceId: input.spaceId, keyId: input.keyId, keyMaterial: outbound }
      });
      const acknowledgement = await this.postPrivateControl(
        child,
        envelope,
        DURABLE_CONTROL_TIMEOUT_MS
      );
      const parsed = DaemonDurableSpaceUnlockAcknowledgementSchema.parse(acknowledgement);
      if (
        parsed.daemonSessionId !== daemonSessionId ||
        parsed.spaceId !== input.spaceId ||
        parsed.keyId !== input.keyId
      ) {
        throw new Error("The isolated local service returned a mismatched durable-space acknowledgement.");
      }
    } catch (error) {
      if (childForFailure !== null) {
        await this.destroyAfterAmbiguousControl(childForFailure);
      }
      throw error;
    } finally {
      wipePrivateControlKey(callerKey);
      if (outbound !== null) wipePrivateControlKey(outbound);
    }
  }

  async lockDurableSpace(input: DurableSpaceLockInput): Promise<void> {
    let childForFailure: UtilityProcess | null = null;
    try {
      CanonicalDurableIdSchema.parse(input.spaceId);
      CanonicalDurableIdSchema.parse(input.keyId);
      await this.ensureStarted();
      const child = this.child;
      const daemonSessionId = this.daemonSessionId;
      if (child === null || daemonSessionId === null || this.state !== "running") {
        throw new Error("The isolated local service has no durable-space session.");
      }
      childForFailure = child;
      const requestId = randomUUID();
      const envelope = DaemonDurableSpaceLockRequestSchema.parse({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        requestId,
        type: "durable-space.lock",
        payload: { daemonSessionId, spaceId: input.spaceId, keyId: input.keyId }
      });
      const acknowledgement = await this.postPrivateControl(
        child,
        envelope,
        DURABLE_CONTROL_TIMEOUT_MS
      );
      const parsed = DaemonDurableSpaceLockAcknowledgementSchema.parse(acknowledgement);
      if (
        parsed.daemonSessionId !== daemonSessionId ||
        parsed.spaceId !== input.spaceId ||
        parsed.keyId !== input.keyId
      ) {
        throw new Error("The isolated local service returned a mismatched durable-space acknowledgement.");
      }
    } catch (error) {
      if (childForFailure !== null) {
        await this.destroyAfterAmbiguousControl(childForFailure);
      }
      throw error;
    }
  }

  stop(): Promise<DaemonStopResult> {
    return this.stopWithMode(false);
  }

  disable(): Promise<DaemonStopResult> {
    return this.stopWithMode(true);
  }

  private stopWithMode(permanent: boolean): Promise<DaemonStopResult> {
    this.daemonSessionId = null;
    if (permanent) {
      this.permanentlyDisabled = true;
    }
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }

    const child = this.child;
    if (child === null) {
      this.state = this.permanentlyDisabled ? "disabled" : "stopped";
      this.failPending(new Error("The isolated local service stopped."));
      return Promise.resolve({
        clean: true,
        forced: false,
        hardKilled: false,
        exited: true
      });
    }

    this.state = "stopping";
    const stopping = this.stopChild(child);
    this.stopPromise = stopping.finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopChild(child: UtilityProcess): Promise<DaemonStopResult> {
    this.failPending(new Error("The isolated local service is stopping."));
    let acknowledged = false;
    let forced = false;
    let hardKilled = false;
    try {
      const acknowledgement = await this.postShutdownControl(child);
      DaemonShutdownAcknowledgementSchema.parse(acknowledgement);
      acknowledged = true;
    } catch {
      forced = true;
      this.requestGracefulTermination(child);
    }

    let exited = await this.waitForChildExit(child, DAEMON_EXIT_TIMEOUT_MS);
    if (!exited && !forced) {
      forced = true;
      this.requestGracefulTermination(child);
      exited = await this.waitForChildExit(child, DAEMON_EXIT_TIMEOUT_MS);
    }
    if (!exited) {
      forced = true;
      hardKilled = true;
      try {
        this.terminationBoundary.forceKill(child);
      } catch {
        // The unclean result and retained child authority fail closed below.
      }
      exited = await this.waitForChildExit(child, DAEMON_EXIT_TIMEOUT_MS);
    }
    if (!exited) {
      this.state = this.permanentlyDisabled ? "disabled" : "stopping";
    }
    return {
      clean: acknowledged && !forced && exited,
      forced,
      hardKilled,
      exited
    };
  }

  private requestGracefulTermination(child: UtilityProcess): void {
    try {
      this.terminationBoundary.requestGracefulTermination(child);
    } catch {
      // The bounded exit wait and explicit hard-kill boundary remain in force.
    }
  }

  private postShutdownControl(child: UtilityProcess): Promise<unknown> {
    const requestId = randomUUID();
    const envelope = DaemonShutdownRequestSchema.parse({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      type: "daemon.shutdown",
      payload: {}
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(requestId);
        reject(new Error(
          "The isolated local service did not confirm clean shutdown."
        ));
      }, DAEMON_SHUTDOWN_ACK_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        cleanup: () => {}
      });
      try {
        child.postMessage(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private postPrivateControl(
    child: UtilityProcess,
    envelope: { readonly requestId: string },
    timeoutMs: number
  ): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("The isolated local service is busy. Wait for current work to finish."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(envelope.requestId);
        if (pending === undefined) return;
        this.pending.delete(envelope.requestId);
        reject(new Error("The isolated local service did not confirm durable-space control."));
      }, timeoutMs);
      this.pending.set(envelope.requestId, { resolve, reject, timer, cleanup: () => {} });
      try {
        child.postMessage(envelope);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(envelope.requestId);
        reject(error);
      }
    });
  }

  private async destroyAfterAmbiguousControl(child: UtilityProcess): Promise<void> {
    if (this.child !== child) return;
    this.daemonSessionId = null;
    try {
      await this.stop();
    } catch {
      // stop() is deliberately best-effort; retained authority remains stopped/fail-closed.
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.permanentlyDisabled || this.state === "disabled") {
      throw new Error("The isolated local service is disabled for app shutdown.");
    }
    if (this.state === "stopping") {
      if (this.stopPromise !== null) {
        await this.stopPromise;
      }
      if (this.state === "stopping") {
        throw new Error(
          "The previous isolated local service has not exited yet."
        );
      }
    }
    if (this.child !== null && this.readyPromise !== null) {
      return this.readyPromise;
    }

    const daemonPath = app.isPackaged
      ? path.join(app.getAppPath(), "dist", "daemon", "index.cjs")
      : path.resolve(__dirname, "../../../daemon/dist/index.cjs");

    this.state = "starting";
    this.daemonSessionId = null;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const child = utilityProcess.fork(daemonPath, [], {
      serviceName: "Rellane",
      stdio: "pipe",
      env: {
        LANG: process.env.LANG ?? "en_US.UTF-8",
        SWITCHBOARD_DATA_DIR: app.getPath("userData"),
        ...(this.localRuntimeApiKey === null
          ? {}
          : {
              CADRANE_LOCAL_API_KEY: this.localRuntimeApiKey,
              CADRANE_LOCAL_BASE_URL: this.localRuntimeBaseUrl!
            })
      }
    });
    this.child = child;
    this.childExitPromise = new Promise<void>((resolve) => {
      this.childExitResolve = resolve;
    });

    const startupTimer = setTimeout(() => {
      this.daemonSessionId = null;
      this.readyReject?.(new Error("The isolated local service failed to start."));
      this.terminationBoundary.requestGracefulTermination(child);
    }, DAEMON_START_TIMEOUT_MS);

    child.on("message", (message) => {
      // Exit listeners deliberately remain attached for testability and late IPC
      // can arrive after restart; an old child has no authority over this session.
      if (this.child !== child) {
        return;
      }
      try {
        assertCompatibleDaemonProtocol(message);
      } catch (error) {
        clearTimeout(startupTimer);
        this.daemonSessionId = null;
        const mismatch = error instanceof Error
          ? error
          : new Error("The isolated local service protocol is incompatible.");
        this.readyReject?.(mismatch);
        this.failPending(mismatch);
        this.terminationBoundary.requestGracefulTermination(child);
        return;
      }

      const ready = DaemonPrivateReadyEventSchema.safeParse(message);
      if (ready.success) {
        clearTimeout(startupTimer);
        if (this.child === child && this.state === "starting") {
          this.daemonSessionId = ready.data.daemonSessionId;
          this.state = "running";
          this.readyResolve?.();
          this.readyResolve = null;
          this.readyReject = null;
          return;
        }
        const error = new Error("The isolated local service sent readiness outside its startup boundary.");
        this.daemonSessionId = null;
        this.readyReject?.(error);
        this.failPending(error);
        this.terminationBoundary.requestGracefulTermination(child);
        return;
      }

      if (isReadyShapedMessage(message)) {
        clearTimeout(startupTimer);
        const error = new Error("The isolated local service sent invalid private readiness.");
        this.daemonSessionId = null;
        this.readyReject?.(error);
        this.failPending(error);
        this.terminationBoundary.requestGracefulTermination(child);
        return;
      }

      const response = DaemonResponseSchema.safeParse(message);
      if (!response.success) {
        return;
      }
      const pending = this.pending.get(response.data.requestId);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      pending.cleanup();
      this.pending.delete(response.data.requestId);
      if (response.data.ok) {
        pending.resolve(response.data.data);
      } else {
        pending.reject(new Error(response.data.error?.message ?? "The local service failed."));
      }
    });

    child.on("exit", () => {
      if (this.child !== child) {
        return;
      }
      clearTimeout(startupTimer);
      const expected = this.state === "stopping" || this.permanentlyDisabled;
      const error = new Error(expected
        ? "The isolated local service stopped."
        : "The isolated local service exited unexpectedly.");
      this.readyReject?.(error);
      this.childExitResolve?.();
      this.daemonSessionId = null;
      this.child = null;
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this.childExitPromise = null;
      this.childExitResolve = null;
      this.state = this.permanentlyDisabled ? "disabled" : "stopped";
      this.failPending(error);
    });

    return this.readyPromise;
  }

  private async waitForChildExit(
    child: UtilityProcess,
    timeoutMs: number
  ): Promise<boolean> {
    if (this.child !== child) {
      return true;
    }
    const exitPromise = this.childExitPromise;
    if (exitPromise === null) {
      return this.child !== child;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cancelRequest(targetRequestId: string): void {
    try {
      this.child?.postMessage(DaemonRequestSchema.parse({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        requestId: randomUUID(),
        type: "request.cancel",
        payload: { targetRequestId }
      }));
    } catch {
      // The original request has already been rejected and cleaned up.
    }
  }
}

function copyPrivateControlKey(value: Uint8Array): Uint8Array {
  const source = nativeTypedArrayDetails(value);
  if (source === undefined) throw new Error("Durable-space key material is invalid.");
  let copied: Uint8Array | undefined;
  try {
    copied = new Uint8Array(value);
    const copiedDetails = nativeTypedArrayDetails(copied);
    if (copiedDetails === undefined || copiedDetails.byteLength !== source.byteLength) {
      throw new Error("Durable-space key material is invalid.");
    }
    return copied;
  } catch {
    if (copied !== undefined) wipePrivateControlKey(copied);
    throw new Error("Durable-space key material is invalid.");
  }
}

function wipePrivateControlKey(value: unknown): void {
  const details = nativeTypedArrayDetails(value);
  if (details === undefined || isSharedBuffer(details.buffer)) return;
  try {
    Uint8Array.prototype.fill.call(value as Uint8Array, 0);
  } catch {
    // Do not mask the operation result while clearing caller-owned transfer material.
  }
}

function nativeTypedArrayDetails(value: unknown): { buffer: unknown; byteLength: number } | undefined {
  if (NATIVE_TYPED_ARRAY_BUFFER_GETTER === undefined || NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) return undefined;
  try {
    const buffer = NATIVE_TYPED_ARRAY_BUFFER_GETTER.call(value);
    const byteLength = NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
      ? { buffer, byteLength }
      : undefined;
  } catch {
    return undefined;
  }
}

function isSharedBuffer(value: unknown): boolean {
  if (NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) return false;
  try {
    const byteLength = NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0;
  } catch {
    return false;
  }
}

function isReadyShapedMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return Reflect.get(value, "type") === "daemon.ready";
  } catch {
    return false;
  }
}

export function readProtocolVersion(value: unknown): number | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocolVersion" in value)
  ) {
    return null;
  }
  const protocolVersion = value.protocolVersion;
  return typeof protocolVersion === "number" &&
    Number.isSafeInteger(protocolVersion)
    ? protocolVersion
    : null;
}

export function assertCompatibleDaemonProtocol(value: unknown): void {
  const protocolVersion = readProtocolVersion(value);
  if (
    protocolVersion !== null &&
    protocolVersion !== DAEMON_PROTOCOL_VERSION
  ) {
    throw new Error(
      "The isolated local service protocol version does not match this desktop build."
    );
  }
}
