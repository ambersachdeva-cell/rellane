/** A slow readiness check must not hide another working local engine. */
import {
  RuntimeDescriptorSchema,
  type LocalChatRequest,
  type LocalChatResult,
  type RuntimeDescriptor
} from "@cadrane/contracts";
import { RuntimeBoundaryError } from "./errors.js";
import { LmStudioAdapter } from "./adapters/lm-studio.js";
import { OllamaAdapter } from "./adapters/ollama.js";
import type { LocalRuntimeAdapter } from "./adapters/types.js";
import { SingleLaneScheduler } from "./single-lane.js";

interface InFlightOperation {
  readonly token: symbol;
  readonly controller: AbortController;
  settled: Promise<unknown> | null;
}

export class LocalRuntimeManager {
  private readonly adapters: Map<string, LocalRuntimeAdapter>;
  private readonly scheduler: SingleLaneScheduler;
  private readonly inFlight = new Map<string, InFlightOperation>();
  private readonly identities = new Map<string, RuntimeDescriptor>();
  private readonly probes = new Map<string, Promise<RuntimeDescriptor>>();
  private closing = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    adapters: readonly LocalRuntimeAdapter[] = [
      new OllamaAdapter(),
      new LmStudioAdapter()
    ],
    scheduler = new SingleLaneScheduler()
  ) {
    this.scheduler = scheduler;
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw badRequest("A local runtime adapter ID is registered more than once.");
      }
      if (
        adapter.kind === "managed-llama" &&
        adapter.scheduling?.owner !== "adapter"
      ) {
        throw badRequest(
          "The managed local runtime must own scheduling on the shared operation lane."
        );
      }
      if (adapter.scheduling?.owner === "adapter") {
        if (adapter.kind !== "managed-llama") {
          throw badRequest(
            "Only the managed local runtime may own operation scheduling."
          );
        }
        if (adapter.scheduling.lane !== scheduler) {
          throw badRequest(
            "The managed local runtime must use the manager's shared operation lane."
          );
        }
      }
      const identity = RuntimeDescriptorSchema.safeParse({
        ...adapter.identity,
        id: adapter.id,
        kind: adapter.kind,
        state: "attention",
        version: null,
        models: [],
        detail: "This local engine has not been checked.",
        checkedAt: new Date().toISOString()
      });
      if (!identity.success) {
        throw badRequest("The local runtime adapter has an invalid public identity.");
      }
      this.identities.set(adapter.id, identity.data);
      this.adapters.set(adapter.id, adapter);
    }
  }

  async discover(): Promise<RuntimeDescriptor[]> {
    this.assertOpen();
    const descriptors = await Promise.all(
      [...this.adapters.values()].map((adapter) =>
        probeRuntime(adapter, this.identities.get(adapter.id)!, this.probes)
      )
    );
    this.assertOpen();
    return descriptors;
  }


  async chat(request: LocalChatRequest): Promise<LocalChatResult> {
    this.assertOpen();
    const adapter = this.adapters.get(request.runtimeId);
    if (adapter === undefined) {
      throw new RuntimeBoundaryError({
        code: "BAD_REQUEST",
        message: "The selected local runtime is not registered.",
        retryable: false
      });
    }
    if (this.inFlight.has(request.operationId)) {
      throw badRequest("An operation with this ID already exists.");
    }

    const token = Symbol(request.operationId);
    const controller = new AbortController();
    const operation: InFlightOperation = {
      token,
      controller,
      settled: null
    };
    this.inFlight.set(request.operationId, operation);
    let execution: Promise<LocalChatResult>;
    try {
      execution = adapter.scheduling?.owner === "adapter"
        ? adapter.chat(request, controller.signal)
        : this.scheduler.enqueue(
            request.operationId,
            (laneSignal) => {
              const signal = AbortSignal.any([
                controller.signal,
                laneSignal
              ]);
              throwIfCancelled(signal);
              return adapter.chat(request, signal);
            }
          );
    } catch (error) {
      this.deleteMatchingOperation(request.operationId, token);
      throw error;
    }

    const settled = execution.finally(() => {
      this.deleteMatchingOperation(request.operationId, token);
    });
    operation.settled = settled;
    return settled;
  }

  cancel(operationId: string): boolean {
    const operation = this.inFlight.get(operationId);
    operation?.controller.abort(
      new DOMException("Local runtime operation cancelled.", "AbortError")
    );
    const laneCancelled = this.scheduler.cancel(operationId);
    return operation !== undefined || laneCancelled;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.closing = true;
    this.shutdownPromise = (async () => {
      const operations = [...this.inFlight.entries()];
      for (const [operationId, operation] of operations) {
        operation.controller.abort(
          new DOMException("Local runtime manager is shutting down.", "AbortError")
        );
        this.scheduler.cancel(operationId);
      }
      await Promise.allSettled(
        operations.flatMap(([, operation]) =>
          operation.settled === null ? [] : [operation.settled]
        )
      );

      const shutdowns = [...this.adapters.values()].flatMap((adapter) =>
        adapter.shutdown === undefined
          ? []
          : [Promise.resolve().then(() => adapter.shutdown!())]
      );
      const results = await Promise.allSettled(shutdowns);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (failure !== undefined) {
        throw failure.reason;
      }
    })();
    return this.shutdownPromise;
  }

  private deleteMatchingOperation(operationId: string, token: symbol): void {
    if (this.inFlight.get(operationId)?.token === token) {
      this.inFlight.delete(operationId);
    }
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_UNAVAILABLE",
        message: "The local runtime manager is shutting down.",
        retryable: false
      });
    }
  }
}

// Keep discovery independent of operation admission and the shared inference lane.
function probeRuntime(
  adapter: LocalRuntimeAdapter,
  identity: RuntimeDescriptor,
  probes: Map<string, Promise<RuntimeDescriptor>>
): Promise<RuntimeDescriptor> {
  const pending = probes.get(adapter.id);
  if (pending) return pending;

  const unchecked = (detail: string): RuntimeDescriptor => ({
    ...identity,
    detail,
    checkedAt: new Date().toISOString()
  });
  // Verification can keep running after this deadline. Share the same probe
  // until it settles, so refresh never starts duplicate GGUF verification.
  const raw = Promise.resolve().then(() => adapter.probe()).then((value) => {
    const descriptor = RuntimeDescriptorSchema.parse(value);
    if (
      descriptor.id !== identity.id || descriptor.kind !== identity.kind ||
      descriptor.baseUrl !== identity.baseUrl
    ) throw badRequest("A runtime probe returned a different engine identity.");
    return descriptor;
  }).catch(() => unchecked(
    "This engine could not be checked. Check again before using it."
  ));
  const bounded = new Promise<RuntimeDescriptor>((resolve) => {
    const timer = setTimeout(() => resolve(unchecked(
      "This engine is still being checked. Other ready engines can be used. Check again shortly."
    )), 4_000);
    void raw.then((descriptor) => {
      clearTimeout(timer);
      resolve(descriptor);
    });
  });
  probes.set(adapter.id, bounded);
  void raw.then(() => {
    if (probes.get(adapter.id) === bounded) probes.delete(adapter.id);
  });
  return bounded;
}

function badRequest(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BAD_REQUEST",
    message,
    retryable: false
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The local runtime operation was cancelled.",
      retryable: true
    });
  }
}
