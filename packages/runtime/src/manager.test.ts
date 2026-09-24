import type {
  LocalChatRequest,
  LocalChatResult,
  RuntimeDescriptor,
  RuntimeKind
} from "@cadrane/contracts";
import { describe, expect, it } from "vitest";
import type {
  LocalRuntimeAdapter,
  RuntimeAdapterScheduling
} from "./adapters/types.js";
import { RuntimeBoundaryError } from "./errors.js";
import { LocalRuntimeManager } from "./manager.js";
import { SingleLaneScheduler } from "./single-lane.js";

const firstOperationId = "00000000-0000-4000-8000-000000000001";
const secondOperationId = "00000000-0000-4000-8000-000000000002";

describe("LocalRuntimeManager scheduling", () => {
  it("uses one shared lane for manager- and adapter-owned work without double-enqueue", async () => {
    const lane = new SingleLaneScheduler();
    const events: string[] = [];
    const firstGate = deferred<void>();
    const external = new FakeAdapter({
      id: "ollama-loopback",
      kind: "ollama",
      chat: async (request) => {
        events.push(`${request.runtimeId}:start`);
        await firstGate.promise;
        events.push(`${request.runtimeId}:end`);
        return resultFor(request);
      }
    });
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: (request) => lane.enqueue(request.operationId, async () => {
        events.push(`${request.runtimeId}:start`);
        events.push(`${request.runtimeId}:end`);
        return resultFor(request);
      })
    });
    const manager = new LocalRuntimeManager([external, managed], lane);

    const first = manager.chat(requestFor(external.id, firstOperationId));
    const second = manager.chat(requestFor(managed.id, secondOperationId));

    expect(lane.snapshot()).toEqual({
      activeId: firstOperationId,
      queuedIds: [secondOperationId]
    });
    expect(events).toEqual(["ollama-loopback:start"]);

    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(events).toEqual([
      "ollama-loopback:start",
      "ollama-loopback:end",
      "managed-llama-b10182:start",
      "managed-llama-b10182:end"
    ]);
  });

  it("serializes manager-owned work behind active adapter-owned work", async () => {
    const lane = new SingleLaneScheduler();
    const events: string[] = [];
    const managedGate = deferred<void>();
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: (request) => lane.enqueue(request.operationId, async () => {
        events.push("managed:start");
        await managedGate.promise;
        events.push("managed:end");
        return resultFor(request);
      })
    });
    const external = new FakeAdapter({
      id: "lm-studio-loopback",
      kind: "lm-studio",
      chat: async (request) => {
        events.push("external:start");
        events.push("external:end");
        return resultFor(request);
      }
    });
    const manager = new LocalRuntimeManager([managed, external], lane);

    const first = manager.chat(requestFor(managed.id, firstOperationId));
    const second = manager.chat(requestFor(external.id, secondOperationId));

    expect(lane.snapshot()).toEqual({
      activeId: firstOperationId,
      queuedIds: [secondOperationId]
    });
    expect(events).toEqual(["managed:start"]);

    managedGate.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(events).toEqual([
      "managed:start",
      "managed:end",
      "external:start",
      "external:end"
    ]);
  });

  it("rejects duplicate adapter and operation IDs across scheduling owners", async () => {
    const lane = new SingleLaneScheduler();
    const duplicateA = new FakeAdapter({
      id: "duplicate",
      kind: "ollama",
      chat: async (request) => resultFor(request)
    });
    const duplicateB = new FakeAdapter({
      id: "duplicate",
      kind: "lm-studio",
      chat: async (request) => resultFor(request)
    });
    expect(() => new LocalRuntimeManager([duplicateA, duplicateB], lane))
      .toThrow(/registered more than once/i);

    const gate = deferred<void>();
    const external = new FakeAdapter({
      id: "ollama-loopback",
      kind: "ollama",
      chat: async (request) => {
        await gate.promise;
        return resultFor(request);
      }
    });
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: (request) => lane.enqueue(
        request.operationId,
        async () => resultFor(request)
      )
    });
    const manager = new LocalRuntimeManager([external, managed], lane);
    const active = manager.chat(requestFor(external.id, firstOperationId));
    await expect(
      manager.chat(requestFor(managed.id, firstOperationId))
    ).rejects.toMatchObject({ detail: { code: "BAD_REQUEST" } });
    gate.resolve();
    await expect(active).resolves.toMatchObject({
      operationId: firstOperationId
    });
  });

  it("rejects adapter-owned work that does not use the injected shared lane", () => {
    const managerLane = new SingleLaneScheduler();
    const hiddenLane = new SingleLaneScheduler();
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane: hiddenLane },
      chat: (request) => hiddenLane.enqueue(
        request.operationId,
        async () => resultFor(request)
      )
    });
    expect(() => new LocalRuntimeManager([managed], managerLane))
      .toThrow(/shared operation lane/i);

    const unscheduledManaged = new FakeAdapter({
      id: "managed-without-owner",
      kind: "managed-llama",
      chat: async (request) => resultFor(request)
    });
    expect(() => new LocalRuntimeManager([unscheduledManaged], managerLane))
      .toThrow(/must own scheduling/i);
  });

  it("cancels adapter-owned work in the same tick before its delayed enqueue", async () => {
    const lane = new SingleLaneScheduler();
    let enqueued = false;
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: async (request, signal) => {
        await Promise.resolve();
        throwIfTestCancelled(signal);
        enqueued = true;
        return lane.enqueue(
          request.operationId,
          async () => resultFor(request)
        );
      }
    });
    const manager = new LocalRuntimeManager([managed], lane);

    const pending = manager.chat(
      requestFor(managed.id, firstOperationId)
    );
    expect(manager.cancel(firstOperationId)).toBe(true);

    await expect(pending).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(enqueued).toBe(false);
    expect(lane.snapshot()).toEqual({
      activeId: null,
      queuedIds: []
    });
  });

  it("rejects duplicate managed and cross-adapter IDs before adapter side effects while preserving cancellation", async () => {
    const lane = new SingleLaneScheduler();
    const gate = deferred<void>();
    let managedEnqueues = 0;
    let externalCalls = 0;
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: async (request, signal) => {
        await gate.promise;
        throwIfTestCancelled(signal);
        managedEnqueues += 1;
        return lane.enqueue(
          request.operationId,
          async () => resultFor(request)
        );
      }
    });
    const external = new FakeAdapter({
      id: "ollama-loopback",
      kind: "ollama",
      chat: async (request) => {
        externalCalls += 1;
        return resultFor(request);
      }
    });
    const manager = new LocalRuntimeManager([managed, external], lane);
    const first = manager.chat(requestFor(managed.id, firstOperationId));

    await expect(
      manager.chat(requestFor(managed.id, firstOperationId))
    ).rejects.toMatchObject({ detail: { code: "BAD_REQUEST" } });
    await expect(
      manager.chat(requestFor(external.id, firstOperationId))
    ).rejects.toMatchObject({ detail: { code: "BAD_REQUEST" } });
    expect(managedEnqueues).toBe(0);
    expect(externalCalls).toBe(0);

    expect(manager.cancel(firstOperationId)).toBe(true);
    gate.resolve();
    await expect(first).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });

    await expect(
      manager.chat(requestFor(external.id, firstOperationId))
    ).resolves.toMatchObject({ operationId: firstOperationId });
    expect(externalCalls).toBe(1);
  });

  it("cancels queued adapter-owned and active manager-owned work through the shared lane", async () => {
    const lane = new SingleLaneScheduler();
    let managedRan = false;
    const external = new FakeAdapter({
      id: "ollama-loopback",
      kind: "ollama",
      chat: (request, signal) => abortableResult(request, signal)
    });
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: (request) => lane.enqueue(request.operationId, async () => {
        managedRan = true;
        return resultFor(request);
      })
    });
    const manager = new LocalRuntimeManager([external, managed], lane);
    const active = manager.chat(requestFor(external.id, firstOperationId));
    const queued = manager.chat(requestFor(managed.id, secondOperationId));

    expect(manager.cancel(secondOperationId)).toBe(true);
    await expect(queued).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(managedRan).toBe(false);

    expect(manager.cancel(firstOperationId)).toBe(true);
    await expect(active).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
  });

  it("cancels active adapter-owned work through the manager's shared lane", async () => {
    const lane = new SingleLaneScheduler();
    const managed = new FakeAdapter({
      id: "managed-llama-b10182",
      kind: "managed-llama",
      scheduling: { owner: "adapter", lane },
      chat: (request) => lane.enqueue(
        request.operationId,
        (signal) => abortableResult(request, signal)
      )
    });
    const manager = new LocalRuntimeManager([managed], lane);
    const active = manager.chat(requestFor(managed.id, firstOperationId));

    expect(manager.cancel(firstOperationId)).toBe(true);
    await expect(active).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
  });

  it("closes admission, settles active work, then shuts adapters down once", async () => {
    const lane = new SingleLaneScheduler();
    const events: string[] = [];
    let shutdownCalls = 0;
    const external = new FakeAdapter({
      id: "ollama-loopback",
      kind: "ollama",
      chat: (request, signal) =>
        new Promise<LocalChatResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            events.push("operation:settled");
            reject(new RuntimeBoundaryError({
              code: "CANCELLED",
              message: "Shutting down.",
              retryable: true
            }));
          }, { once: true });
        }),
      shutdown: async () => {
        shutdownCalls += 1;
        events.push("adapter:shutdown");
      }
    });
    const manager = new LocalRuntimeManager([external], lane);
    const active = manager.chat(requestFor(external.id, firstOperationId));

    const firstShutdown = manager.shutdown();
    const secondShutdown = manager.shutdown();

    await expect(active).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    await expect(Promise.all([firstShutdown, secondShutdown]))
      .resolves.toEqual([undefined, undefined]);
    expect(events).toEqual(["operation:settled", "adapter:shutdown"]);
    expect(shutdownCalls).toBe(1);
    await expect(manager.discover()).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });
    await expect(
      manager.chat(requestFor(external.id, secondOperationId))
    ).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });
  });
});

interface FakeAdapterOptions {
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly scheduling?: RuntimeAdapterScheduling;
  readonly chat: (
    request: LocalChatRequest,
    signal: AbortSignal
  ) => Promise<LocalChatResult>;
  readonly shutdown?: () => Promise<void>;
}

class FakeAdapter implements LocalRuntimeAdapter {
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly scheduling?: RuntimeAdapterScheduling;
  private readonly runChat: FakeAdapterOptions["chat"];
  private readonly runShutdown: FakeAdapterOptions["shutdown"];

  get identity() {
    return {
      name: this.id,
      baseUrl: this.kind === "managed-llama" ? null : this.kind === "ollama"
        ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234"
    };
  }

  constructor(options: FakeAdapterOptions) {
    this.id = options.id;
    this.kind = options.kind;
    if (options.scheduling !== undefined) {
      this.scheduling = options.scheduling;
    }
    this.runChat = options.chat;
    this.runShutdown = options.shutdown;
  }

  async probe(): Promise<RuntimeDescriptor> {
    return {
      id: this.id,
      kind: this.kind,
      name: this.id,
      state: "available",
      baseUrl: this.kind === "managed-llama"
        ? null
        : this.kind === "ollama"
          ? "http://127.0.0.1:11434"
          : "http://127.0.0.1:1234",
      version: null,
      models: [],
      detail: "Available for the scheduling test.",
      checkedAt: "2026-07-31T00:00:00.000Z"
    } as RuntimeDescriptor;
  }

  chat(
    request: LocalChatRequest,
    signal: AbortSignal
  ): Promise<LocalChatResult> {
    return this.runChat(request, signal);
  }

  shutdown(): Promise<void> {
    return this.runShutdown?.() ?? Promise.resolve();
  }
}

function requestFor(runtimeId: string, operationId: string): LocalChatRequest {
  return {
    operationId,
    runtimeId,
    modelId: "test-model",
    messages: [{ role: "user", content: "Test" }],
    temperature: 0.2,
    maxTokens: 32
  };
}

function resultFor(request: LocalChatRequest): LocalChatResult {
  return {
    operationId: request.operationId,
    runtimeId: request.runtimeId,
    modelId: request.modelId,
    content: "Done",
    startedAt: "2026-07-31T00:00:00.000Z",
    finishedAt: "2026-07-31T00:00:01.000Z",
    localOnly: true
  };
}

function abortableResult(
  request: LocalChatRequest,
  signal: AbortSignal
): Promise<LocalChatResult> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The test operation was cancelled.",
      retryable: true
    }));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void resolve;
  });
}

function throwIfTestCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The test operation was cancelled.",
      retryable: true
    });
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
