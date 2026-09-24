import { randomUUID } from "node:crypto";
import {
  LocalChatRequestSchema,
  LocalChatResultSchema,
  type LocalChatRequest,
  type LocalChatResult
} from "@cadrane/contracts";
import { RuntimeBoundaryError } from "../errors.js";
import {
  assertProcessVerifiedManagedRuntimeAuthority
} from "./activation-provenance.js";
import { BoundedRedactedLog } from "./bounded-log.js";
import {
  MacOsLoopbackListenerOwnershipVerifier,
  NodeLoopbackPortAllocator,
  NodeManagedRuntimeClock,
  NodeManagedRuntimeHttpClient,
  NodeManagedRuntimeSecretSource,
  NodeRuntimeProcessHost
} from "./node-dependencies.js";
import {
  MANAGED_LLAMA_RUNTIME_ID,
  type LlamaServerLaunchInput,
  type LlamaServerSupervisorDependencies,
  type ManagedRuntimeReadyIdentity,
  type ManagedRuntimeSnapshot,
  type OwnedRuntimeProcess,
  type ResolveLlamaServerLaunchInput,
  type RuntimeProcessExit,
  type RuntimeProcessSpec
} from "./types.js";

export const LLAMA_SERVER_READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_INTERVAL_MS = 100;
const READY_OWNERSHIP_SETTLE_MS = 25;
const PROCESS_GRACEFUL_STOP_MS = 2_000;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FIXED_ENVIRONMENT = Object.freeze({
  LANG: "en_US.UTF-8",
  LC_ALL: "C"
});

export class LlamaServerSupervisor {
  private readonly operationLane;
  private readonly portAllocator;
  private readonly processHost;
  private readonly listenerOwnership;
  private readonly httpClient;
  private readonly secretSource;
  private readonly clock;
  private readonly diagnosticLog = new BoundedRedactedLog();
  private readonly internalLaneNamespace = randomUUID();
  private internalBarrierSequence = 0;

  private state: ManagedRuntimeSnapshot["state"] = "stopped";
  private detail = "The managed local runtime is stopped.";
  private activeInput: LlamaServerLaunchInput | null = null;
  private child: OwnedRuntimeProcess | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private startedAt: string | null = null;
  private lifecycleController: AbortController | null = null;
  private stopPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private poisonedError: RuntimeBoundaryError | null = null;
  private generation: symbol | null = null;
  private readonly operationGenerations = new Map<string, symbol>();
  private readonly ownedOperations = new Map<string, {
    readonly token: symbol;
    readonly settled: Promise<unknown>;
  }>();
  private readonly teardownBarriers = new Set<Promise<unknown>>();

  constructor(dependencies: LlamaServerSupervisorDependencies) {
    this.operationLane = dependencies.operationLane;
    this.portAllocator =
      dependencies.portAllocator ?? new NodeLoopbackPortAllocator();
    this.processHost =
      dependencies.processHost ?? new NodeRuntimeProcessHost();
    this.listenerOwnership =
      dependencies.listenerOwnership ??
      new MacOsLoopbackListenerOwnershipVerifier();
    this.httpClient =
      dependencies.httpClient ?? new NodeManagedRuntimeHttpClient();
    this.secretSource =
      dependencies.secretSource ?? new NodeManagedRuntimeSecretSource();
    this.clock =
      dependencies.clock ?? new NodeManagedRuntimeClock();
  }

  warmup(
    operationId: string,
    input: LlamaServerLaunchInput,
    signal: AbortSignal
  ): Promise<ManagedRuntimeSnapshot> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(operationId)
    ) {
      return Promise.reject(
        badRequest("The managed runtime warmup operation ID is invalid.")
      );
    }
    if (this.shuttingDown) {
      return Promise.reject(
        runtimeUnavailable("The managed local runtime is shutting down.")
      );
    }
    return this.enqueueOwned(operationId, async (laneSignal) => {
      const combinedSignal = AbortSignal.any([signal, laneSignal]);
      try {
        if (
          this.state === "ready" &&
          this.activeInput !== null &&
          sameLaunchIdentity(this.activeInput, input)
        ) {
          return this.snapshot();
        }
        if (this.state === "ready" || this.child !== null) {
          await this.stopWithinBoundary();
        }
        return await this.startWithinLane(input, combinedSignal);
      } catch (error) {
        try {
          await this.teardownWithinLane();
        } catch (teardownError) {
          throw normalizeRuntimeError(
            teardownError,
            new AbortController().signal
          );
        }
        throw normalizeRuntimeError(error, combinedSignal);
      }
    });
  }

  private async startWithinLane(
    input: LlamaServerLaunchInput,
    signal?: AbortSignal
  ): Promise<ManagedRuntimeSnapshot> {
    assertProcessVerifiedManagedRuntimeAuthority(input.authority);
    if (input.authority.activation !== input.runtime) {
      throw securityBoundary(
        "The managed runtime activation did not match its verifier authority."
      );
    }
    if (
      this.state === "starting" ||
      this.state === "ready" ||
      this.state === "stopping" ||
      this.child !== null
    ) {
      throw busy(
        "A managed local runtime is already starting, ready, or stopping."
      );
    }

    const generation = Symbol("managed-runtime-generation");
    const lifecycleController = new AbortController();
    const combinedSignal = signal === undefined
      ? lifecycleController.signal
      : AbortSignal.any([signal, lifecycleController.signal]);
    this.generation = generation;
    this.lifecycleController = lifecycleController;
    this.state = "starting";
    this.detail = "Verifying the managed runtime and model before launch.";
    this.startedAt = null;
    this.activeInput = null;
    this.port = null;
    this.apiKey = null;
    this.diagnosticLog.clear();
    addSensitiveLaunchValues(this.diagnosticLog, input);

    let reservation: Awaited<ReturnType<typeof this.portAllocator.reserve>> | null =
      null;
    let spawnedChild: OwnedRuntimeProcess | null = null;
    try {
      throwIfAborted(combinedSignal);
      await input.authority.integrityVerifier.verify(input, combinedSignal);
      throwIfAborted(combinedSignal);

      reservation = await this.portAllocator.reserve(combinedSignal);
      const port = reservation.port;
      assertValidEphemeralPort(port);
      await reservation.release();
      reservation = null;
      throwIfAborted(combinedSignal);

      const apiKey = this.secretSource.createApiKey();
      assertValidApiKey(apiKey);
      this.apiKey = apiKey;
      this.diagnosticLog.addSensitiveValue(apiKey);
      const spec = buildPinnedLlamaServerProcessSpec(input, port, apiKey);
      spawnedChild = this.processHost.spawn(spec);
      this.child = spawnedChild;
      this.port = port;
      this.activeInput = input;
      if (!Number.isInteger(spawnedChild.pid) || spawnedChild.pid <= 1) {
        throw securityBoundary(
          "The managed runtime process did not receive a safe process identity."
        );
      }
      this.captureDiagnostics(spawnedChild, generation);
      this.watchUnexpectedExit(spawnedChild, generation);

      await this.waitUntilReady(
        spawnedChild,
        port,
        combinedSignal
      );
      throwIfAborted(combinedSignal);
      if (
        this.generation !== generation ||
        this.child !== spawnedChild ||
        !spawnedChild.alive
      ) {
        throw runtimeUnavailable(
          "The managed runtime exited before readiness could be committed."
        );
      }

      this.state = "ready";
      this.startedAt = safeIsoDate(this.clock.now());
      this.detail = "The pinned managed local runtime is ready.";
      return this.snapshot();
    } catch (error) {
      await reservation?.release().catch(() => undefined);
      if (this.generation !== generation) {
        throw normalizeRuntimeError(error, combinedSignal);
      }
      let teardownError: unknown = null;
      if (this.stopPromise !== null) {
        await this.stopPromise.catch((stopError: unknown) => {
          teardownError = stopError;
        });
      } else if (spawnedChild !== null) {
        try {
          await this.processHost.terminateTree(
            spawnedChild,
            PROCESS_GRACEFUL_STOP_MS
          );
          await spawnedChild.exit;
        } catch (terminationError) {
          teardownError = terminationError;
          this.diagnosticLog.append(
            `Managed runtime teardown failed: ${safeErrorName(terminationError)}\n`
          );
        }
      }
      if (this.generation === generation) {
        if (
          spawnedChild?.alive === true ||
          this.child?.alive === true ||
          (
            teardownError !== null &&
            (spawnedChild !== null || this.child !== null)
          )
        ) {
          this.state = "failed";
          this.detail =
            "The failed managed runtime process tree could not be confirmed stopped.";
          const poisoned = lanePoisoned();
          this.poisonLane(poisoned);
          throw normalizeRuntimeError(
            teardownError ?? error,
            new AbortController().signal
          );
        }
        this.child = null;
        this.port = null;
        this.apiKey = null;
        this.activeInput = null;
        this.startedAt = null;
        this.lifecycleController = null;
        this.generation = null;
        const normalized = normalizeRuntimeError(error, combinedSignal);
        if (normalized.detail.code === "CANCELLED") {
          this.state = "stopped";
          this.detail = "The managed local runtime start was cancelled.";
        } else {
          this.state = "failed";
          this.detail = "The managed local runtime failed closed during startup.";
        }
        throw normalized;
      }
      throw normalizeRuntimeError(error, combinedSignal);
    }
  }

  runLazy(
    request: LocalChatRequest,
    resolveLaunchInput: ResolveLlamaServerLaunchInput,
    callerSignal: AbortSignal
  ): Promise<LocalChatResult> {
    const parsed = LocalChatRequestSchema.safeParse(request);
    if (
      !parsed.success ||
      parsed.data.runtimeId !== MANAGED_LLAMA_RUNTIME_ID
    ) {
      return Promise.reject(
        badRequest("The managed runtime chat request is invalid.")
      );
    }
    if (this.shuttingDown) {
      return Promise.reject(
        runtimeUnavailable("The managed local runtime is shutting down.")
      );
    }

    return this.enqueueOwned(
      parsed.data.operationId,
      async (laneSignal) => {
        const combinedSignal = AbortSignal.any([
          callerSignal,
          laneSignal
        ]);
        try {
          throwIfAborted(combinedSignal);
          const input = await resolveLaunchInput(combinedSignal);
          throwIfAborted(combinedSignal);
          assertProcessVerifiedManagedRuntimeAuthority(input.authority);
          if (input.authority.activation !== input.runtime) {
            throw securityBoundary(
              "The managed runtime activation did not match its verifier authority."
            );
          }
          if (
            this.state === "ready" &&
            this.activeInput !== null &&
            !sameLaunchIdentity(this.activeInput, input)
          ) {
            await this.stopWithinBoundary();
          }
          if (
            this.state !== "ready" ||
            this.activeInput === null ||
            !sameLaunchIdentity(this.activeInput, input)
          ) {
            await this.startWithinLane(input, combinedSignal);
          }
          const generation = this.generation;
          if (generation === null) {
            throw runtimeUnavailable(
              "The managed runtime did not establish a process generation."
            );
          }
          this.operationGenerations.set(
            parsed.data.operationId,
            generation
          );
          return await this.chatReadyWithinLane(
            parsed.data,
            combinedSignal
          );
        } catch (error) {
          try {
            await this.teardownWithinLane();
          } catch (teardownError) {
            throw normalizeRuntimeError(
              teardownError,
              new AbortController().signal
            );
          }
          throw normalizeRuntimeError(error, combinedSignal);
        } finally {
          this.operationGenerations.delete(parsed.data.operationId);
        }
      }
    );
  }

  async chat(
    request: LocalChatRequest,
    signal: AbortSignal
  ): Promise<LocalChatResult> {
    const parsed = LocalChatRequestSchema.safeParse(request);
    if (
      !parsed.success ||
      parsed.data.runtimeId !== MANAGED_LLAMA_RUNTIME_ID
    ) {
      throw badRequest("The managed runtime chat request is invalid.");
    }
    if (this.shuttingDown) {
      throw runtimeUnavailable("The managed local runtime is shutting down.");
    }

    const capturedGeneration = this.generation;
    if (capturedGeneration !== null) {
      this.operationGenerations.set(
        parsed.data.operationId,
        capturedGeneration
      );
    }
    return this.enqueueOwned(parsed.data.operationId, async (laneSignal) => {
      const combinedSignal = AbortSignal.any([signal, laneSignal]);
      try {
        if (
          capturedGeneration === null ||
          this.generation !== capturedGeneration
        ) {
          throw runtimeUnavailable(
            "The queued managed operation belongs to an earlier process generation."
          );
        }
        return await this.chatReadyWithinLane(
          parsed.data,
          combinedSignal
        );
      } catch (error) {
        if (this.generation === capturedGeneration) {
          try {
            await this.teardownWithinLane();
          } catch (teardownError) {
            throw normalizeRuntimeError(
              teardownError,
              new AbortController().signal
            );
          }
        }
        throw normalizeRuntimeError(error, combinedSignal);
      }
    }).finally(() => {
      this.operationGenerations.delete(parsed.data.operationId);
    });
  }

  async cancel(operationId: string): Promise<boolean> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(operationId)
    ) {
      throw badRequest("The managed runtime operation ID is invalid.");
    }
    return this.operationLane.cancel(operationId);
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    if (
      this.state === "stopped" &&
      this.child === null &&
      this.lifecycleController === null
    ) {
      return;
    }

    this.stopPromise = this.stopWithinBoundary();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const operations = [...this.ownedOperations.entries()];
      for (const [operationId] of operations) {
        this.operationLane.cancel(operationId);
      }
      await Promise.allSettled(
        operations.map(([, operation]) => operation.settled)
      );
      while (this.teardownBarriers.size > 0) {
        await Promise.allSettled([...this.teardownBarriers]);
      }
      let stopError: unknown = null;
      try {
        await this.stop();
      } catch (error) {
        stopError = error;
      }
      if (this.poisonedError !== null) {
        throw this.poisonedError;
      }
      if (stopError !== null) {
        throw stopError;
      }
    })();
    return this.shutdownPromise;
  }

  snapshot(): ManagedRuntimeSnapshot {
    return {
      state: this.state,
      runtimeId: MANAGED_LLAMA_RUNTIME_ID,
      modelId: this.activeInput?.model.modelId ?? null,
      modelDisplayName: this.activeInput?.model.displayName ?? null,
      startedAt: this.startedAt,
      detail: this.detail
    };
  }

  isReadyFor(identity: ManagedRuntimeReadyIdentity): boolean {
    const model = this.activeInput?.model;
    return (
      this.state === "ready" &&
      this.child?.alive === true &&
      this.activeInput?.authority === identity.authority &&
      model?.modelId === identity.modelId &&
      model.artifactSha256 === identity.artifactSha256 &&
      model.catalogGeneration === identity.catalogGeneration &&
      model.target === identity.target
    );
  }

  /**
   * Privileged daemon diagnostics only. The string is bounded and redacted;
   * it must not be exposed through renderer IPC.
   */
  diagnosticSnapshot(): string {
    return this.diagnosticLog.snapshot();
  }

  private enqueueOwned<T>(
    operationId: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.ownedOperations.has(operationId)) {
      return Promise.reject(
        badRequest("A managed runtime operation with this ID already exists.")
      );
    }
    const token = Symbol(operationId);
    const execution = this.operationLane.enqueue(operationId, task);
    const settled = execution.finally(() => {
      if (this.ownedOperations.get(operationId)?.token === token) {
        this.ownedOperations.delete(operationId);
      }
    });
    this.ownedOperations.set(operationId, { token, settled });
    return settled;
  }

  private async chatReadyWithinLane(
    request: LocalChatRequest,
    signal: AbortSignal
  ): Promise<LocalChatResult> {
    const generation = this.generation;
    const activeInput = this.activeInput;
    const port = this.port;
    const apiKey = this.apiKey;
    const child = this.child;
    const lifecycleController = this.lifecycleController;
    if (
      this.state !== "ready" ||
      generation === null ||
      activeInput === null ||
      port === null ||
      apiKey === null ||
      child === null ||
      lifecycleController === null ||
      !child.alive ||
      request.runtimeId !== MANAGED_LLAMA_RUNTIME_ID ||
      request.modelId !== activeInput.model.modelId
    ) {
      throw runtimeUnavailable(
        "The selected managed local model is not ready."
      );
    }

    const combinedSignal = AbortSignal.any([
      signal,
      lifecycleController.signal
    ]);
    throwIfAborted(combinedSignal);
    const startedAt = safeIsoDate(this.clock.now());
    const content = await this.httpClient.chat(
      port,
      request,
      apiKey,
      combinedSignal
    );
    throwIfAborted(combinedSignal);
    if (
      this.state !== "ready" ||
      this.generation !== generation ||
      this.activeInput !== activeInput ||
      this.child !== child ||
      !child.alive
    ) {
      throw runtimeUnavailable(
        "The captured managed local runtime changed before the answer completed."
      );
    }
    return LocalChatResultSchema.parse({
      operationId: request.operationId,
      runtimeId: MANAGED_LLAMA_RUNTIME_ID,
      modelId: request.modelId,
      content,
      startedAt,
      finishedAt: safeIsoDate(this.clock.now()),
      localOnly: true
    });
  }

  private async teardownWithinLane(): Promise<void> {
    if (this.stopPromise !== null) {
      await this.stopPromise;
      return;
    }
    if (this.child === null && this.lifecycleController === null) {
      return;
    }
    await this.stopWithinBoundary();
  }

  private async stopWithinBoundary(): Promise<void> {
    this.state = "stopping";
    this.detail = "Stopping the managed local runtime.";
    const stoppingGeneration = this.generation;
    if (stoppingGeneration !== null) {
      for (const [operationId, generation] of this.operationGenerations) {
        if (generation === stoppingGeneration) {
          this.operationLane.cancel(operationId);
        }
      }
    }
    this.lifecycleController?.abort(
      new DOMException("Managed runtime stopped.", "AbortError")
    );
    const child = this.child;
    try {
      if (child !== null) {
        await this.processHost.terminateTree(
          child,
          PROCESS_GRACEFUL_STOP_MS
        );
        await child.exit;
      }
    } catch (error) {
      this.state = "failed";
      this.detail =
        "The managed runtime process tree could not be confirmed stopped.";
      const poisoned = lanePoisoned(error);
      this.poisonLane(poisoned);
      throw poisoned;
    }

    this.child = null;
    this.port = null;
    this.apiKey = null;
    this.activeInput = null;
    this.startedAt = null;
    this.lifecycleController = null;
    this.generation = null;
    this.state = "stopped";
    this.detail = "The managed local runtime is stopped.";
  }

  private async waitUntilReady(
    child: OwnedRuntimeProcess,
    port: number,
    signal: AbortSignal
  ): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(
      LLAMA_SERVER_READINESS_TIMEOUT_MS
    );
    const readinessSignal = AbortSignal.any([signal, timeoutSignal]);
    const deadline = this.clock.monotonicMs() +
      LLAMA_SERVER_READINESS_TIMEOUT_MS;
    const exitFailure = child.exit.then((exit) => {
      throw runtimeUnavailable(exitMessage(exit));
    });

    try {
      while (this.clock.monotonicMs() < deadline) {
        throwIfAborted(readinessSignal);
        const observation = await Promise.race([
          this.httpClient.health(port, readinessSignal),
          exitFailure
        ]);
        if (observation.state === "ready") {
          if (
            !child.alive ||
            !await this.listenerOwnership.isOwnedBy(
              child.pid,
              port,
              readinessSignal
            )
          ) {
            throw securityBoundary(
              "The ready loopback listener was not owned by the managed child."
            );
          }
          await this.clock.delay(
            READY_OWNERSHIP_SETTLE_MS,
            readinessSignal
          );
          if (
            !child.alive ||
            !await this.listenerOwnership.isOwnedBy(
              child.pid,
              port,
              readinessSignal
            )
          ) {
            throw securityBoundary(
              "The managed child did not retain ownership of its loopback listener."
            );
          }
          return;
        }
        await this.clock.delay(
          READINESS_POLL_INTERVAL_MS,
          readinessSignal
        );
      }
    } catch (error) {
      if (timeoutSignal.aborted && !signal.aborted) {
        throw readinessTimeout();
      }
      throw error;
    }
    throw readinessTimeout();
  }

  private captureDiagnostics(
    child: OwnedRuntimeProcess,
    generation: symbol
  ): void {
    void (async () => {
      try {
        for await (const chunk of child.stderr) {
          if (this.generation !== generation) {
            break;
          }
          this.diagnosticLog.append(chunk);
        }
      } catch (error) {
        if (this.generation === generation) {
          this.diagnosticLog.append(
            `Managed diagnostic stream failed: ${safeErrorName(error)}\n`
          );
        }
      }
    })();
  }

  private watchUnexpectedExit(
    child: OwnedRuntimeProcess,
    generation: symbol
  ): void {
    void child.exit.then(async (exit) => {
      if (
        this.generation !== generation ||
        this.child !== child ||
        this.state !== "ready"
      ) {
        return;
      }
      this.diagnosticLog.append(`${exitMessage(exit)}\n`);
      this.lifecycleController?.abort(
        new DOMException("Managed runtime exited.", "AbortError")
      );
      this.state = "failed";
      this.detail = "The managed local runtime exited unexpectedly.";
      this.activeInput = null;
      this.startedAt = null;
      const barrierId = [
        "managed-native-teardown",
        this.internalLaneNamespace,
        String(++this.internalBarrierSequence)
      ].join(":");
      const barrier = this.operationLane.enqueuePriorityBarrier(
        barrierId,
        async () => {
          if (this.generation !== generation || this.child !== child) {
            return;
          }
          await this.processHost.terminateTree(
            child,
            PROCESS_GRACEFUL_STOP_MS
          );
          if (this.generation !== generation || this.child !== child) {
            return;
          }
          this.child = null;
          this.port = null;
          this.apiKey = null;
          this.activeInput = null;
          this.startedAt = null;
          this.lifecycleController = null;
          this.generation = null;
        }
      );
      this.teardownBarriers.add(barrier);
      void barrier.catch((error: unknown) => {
        if (this.generation === generation && this.child === child) {
          this.diagnosticLog.append(
            `Managed descendant cleanup failed: ${safeErrorName(error)}\n`
          );
          this.detail =
            "The exited managed runtime left a process tree that could not be confirmed stopped.";
          this.poisonLane(lanePoisoned(error));
        }
      }).finally(() => {
        this.teardownBarriers.delete(barrier);
      });
    }).catch((error: unknown) => {
      if (this.generation === generation && this.child === child) {
        this.diagnosticLog.append(
          `Managed exit watcher failed: ${safeErrorName(error)}\n`
        );
        this.state = "failed";
        this.detail =
          "The managed runtime exit boundary failed closed.";
        this.poisonLane(lanePoisoned(error));
      }
    });
  }

  private poisonLane(error: RuntimeBoundaryError): void {
    this.poisonedError ??= error;
    this.operationLane.poison(this.poisonedError);
  }
}

export function buildPinnedLlamaServerProcessSpec(
  input: LlamaServerLaunchInput,
  port: number,
  apiKey: string
): RuntimeProcessSpec {
  assertValidEphemeralPort(port);
  assertValidApiKey(apiKey);
  return {
    executable: input.runtime.serverPath,
    args: [
      "--model",
      input.model.modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ctx-size",
      "4096",
      "--parallel",
      "1",
      "--gpu-layers",
      "auto",
      "--api-key",
      apiKey,
      "--no-ui",
      "--no-slots",
      "--log-disable"
    ],
    cwd: input.runtime.payloadDirectory,
    env: FIXED_ENVIRONMENT
  };
}

function addSensitiveLaunchValues(
  log: BoundedRedactedLog,
  input: LlamaServerLaunchInput
): void {
  log.addSensitiveValue(input.runtime.runtimeRoot);
  log.addSensitiveValue(input.runtime.payloadDirectory);
  log.addSensitiveValue(input.runtime.serverPath);
  log.addSensitiveValue(input.model.rootDirectory);
  log.addSensitiveValue(input.model.modelPath);
}

function sameLaunchIdentity(
  left: LlamaServerLaunchInput,
  right: LlamaServerLaunchInput
): boolean {
  return (
    left.authority === right.authority &&
    left.runtime === right.runtime &&
    left.model.modelId === right.model.modelId &&
    left.model.artifactSha256 === right.model.artifactSha256 &&
    left.model.downloadBytes === right.model.downloadBytes &&
    left.model.catalogGeneration === right.model.catalogGeneration &&
    left.model.target === right.model.target &&
    left.model.rootDirectory === right.model.rootDirectory &&
    left.model.modelPath === right.model.modelPath
  );
}

function assertValidEphemeralPort(port: number): void {
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw securityBoundary(
      "The managed runtime did not receive a valid private port."
    );
  }
}

function assertValidApiKey(apiKey: string): void {
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw securityBoundary(
      "The managed runtime API credential did not match its fixed contract."
    );
  }
}

function safeIsoDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new RuntimeBoundaryError({
      code: "UNKNOWN",
      message: "The managed runtime clock is invalid.",
      retryable: false
    });
  }
  return value.toISOString();
}

function exitMessage(exit: RuntimeProcessExit): string {
  if (exit.error !== undefined) {
    return "The managed runtime process failed to start.";
  }
  if (exit.signal !== null) {
    return `The managed runtime process exited from signal ${exit.signal}.`;
  }
  return `The managed runtime process exited with code ${String(exit.code)}.`;
}

function safeErrorName(error: unknown): string {
  if (error instanceof RuntimeBoundaryError) {
    return error.detail.code;
  }
  return error instanceof Error ? error.name.slice(0, 80) : "UnknownError";
}

function normalizeRuntimeError(
  error: unknown,
  signal: AbortSignal
): RuntimeBoundaryError {
  if (error instanceof RuntimeBoundaryError) {
    return error;
  }
  if (
    signal.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The managed runtime operation was cancelled.",
      retryable: true
    }, error instanceof Error ? { cause: error } : undefined);
  }
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message: "The managed local runtime failed inside its process boundary.",
    retryable: true
  }, error instanceof Error ? { cause: error } : undefined);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The managed runtime operation was cancelled.",
      retryable: true
    });
  }
}

function badRequest(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BAD_REQUEST",
    message,
    retryable: false
  });
}

function busy(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BUSY",
    message,
    retryable: true
  });
}

function securityBoundary(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message,
    retryable: false
  });
}

function runtimeUnavailable(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message,
    retryable: true
  });
}

function lanePoisoned(cause?: unknown): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message:
      "The local GPU lane is blocked because native process cleanup could not be confirmed. Restart Switchboard before running another local model.",
    retryable: false
  }, cause instanceof Error ? { cause } : undefined);
}

function readinessTimeout(): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "TIMEOUT",
    message: "The managed runtime did not become ready within 60 seconds.",
    retryable: true
  });
}
