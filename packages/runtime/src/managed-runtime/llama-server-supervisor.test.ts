import type { LocalChatRequest } from "@cadrane/contracts";
import { describe, expect, it, vi } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import {
  promoteVerifiedManagedRuntimeAuthority
} from "./activation-provenance.js";
import { BoundedRedactedLog } from "./bounded-log.js";
import {
  LLAMA_SERVER_READINESS_TIMEOUT_MS,
  LlamaServerSupervisor
} from "./llama-server-supervisor.js";
import {
  isExactOwnedLoopbackListenerOutput,
  NodeManagedRuntimeHttpClient,
  NodeManagedRuntimeSecretSource
} from "./node-dependencies.js";
import { SingleLaneScheduler } from "../single-lane.js";
import {
  MANAGED_LLAMA_RUNTIME_ID,
  type HealthObservation,
  type LlamaServerLaunchInput,
  type LoopbackListenerOwnershipVerifier,
  type LoopbackPortAllocator,
  type ManagedRuntimeClock,
  type ManagedRuntimeHttpClient,
  type ManagedRuntimeOperationLane,
  type ManagedRuntimeSecretSource,
  type OwnedRuntimeProcess,
  type RuntimeProcessExit,
  type RuntimeProcessHost,
  type RuntimeProcessSpec
} from "./types.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const WARMUP_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const PORT = 43_123;
const API_KEY = "k".repeat(43);

const launchIntegrityVerifier = {
  inputs: [] as LlamaServerLaunchInput[],
  failure: null as Error | null,
  async verify(
    input: LlamaServerLaunchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    this.inputs.push(input);
    if (this.failure !== null) {
      throw this.failure;
    }
  }
};
const launchAuthority = promoteVerifiedManagedRuntimeAuthority({
  runtimeRoot: "/Applications/Switchboard.app/Contents/Resources/llama",
  payloadDirectory:
    "/Applications/Switchboard.app/Contents/Resources/llama/llama-b10182",
  serverPath:
    "/Applications/Switchboard.app/Contents/Resources/llama/llama-b10182/llama-server",
  sourceManifest: {
    schemaVersion: 1,
    archiveSha256: "a".repeat(64),
    payloadRoot: "llama-b10182",
    members: []
  },
  manifest: {
    schemaVersion: 1,
    archiveSha256: "a".repeat(64),
    payloadRoot: "llama-b10182",
    members: []
  },
  receipt: {
    receiptVersion: 1,
    status: "signed-active",
    runtimeId: "llama.cpp",
    tag: "b10182",
    sourceCommit: "afeebe103bd99cda8f5dfaefcabadf890db7fda7",
    target: "darwin-arm64",
    sourceMemberManifestCanonicalSha256: "a".repeat(64),
    memberManifestCanonicalSha256: "b".repeat(64),
    serverSha256: "d".repeat(64)
  }
}, launchIntegrityVerifier);
const launchInput: LlamaServerLaunchInput = {
  authority: launchAuthority,
  runtime: launchAuthority.activation,
  model: {
    rootDirectory: "/Users/person/Library/Application Support/Switchboard/models",
    modelId: "qwen3-4b-q4-k-m",
    displayName: "Qwen3 4B",
    modelPath:
      "/Users/person/Library/Application Support/Switchboard/models/qwen3/model.gguf",
    artifactSha256: "c".repeat(64),
    downloadBytes: 2_497_280_256,
    catalogGeneration: 1,
    target: "darwin-arm64"
  }
};

const chatRequest: LocalChatRequest = {
  operationId: OPERATION_ID,
  runtimeId: MANAGED_LLAMA_RUNTIME_ID,
  modelId: launchInput.model.modelId,
  messages: [{ role: "user", content: "Reply briefly." }],
  temperature: 0.2,
  maxTokens: 128
};

describe("LlamaServerSupervisor", () => {
  it("launches only the fixed b10182 argument surface and proves listener ownership", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push(
      { state: "loading" },
      { state: "ready" }
    );

    const snapshot = await warmup(harness);

    expect(snapshot).toMatchObject({
      state: "ready",
      runtimeId: MANAGED_LLAMA_RUNTIME_ID,
      modelId: launchInput.model.modelId
    });
    expect(harness.integrity.inputs).toEqual([launchInput]);
    expect(harness.portAllocator.releaseCount).toBe(1);
    expect(harness.processHost.specs).toEqual([
      {
        executable: launchInput.runtime.serverPath,
        args: [
          "--model",
          launchInput.model.modelPath,
          "--host",
          "127.0.0.1",
          "--port",
          String(PORT),
          "--ctx-size",
          "4096",
          "--parallel",
          "1",
          "--gpu-layers",
          "auto",
          "--api-key",
          API_KEY,
          "--no-ui",
          "--no-slots",
          "--log-disable"
        ],
        cwd: launchInput.runtime.payloadDirectory,
        env: {
          LANG: "en_US.UTF-8",
          LC_ALL: "C"
        }
      }
    ]);
    expect(harness.ownership.checks).toEqual([
      [7_321, PORT],
      [7_321, PORT]
    ]);

    await harness.supervisor.shutdown();
    expect(harness.processHost.terminateCount).toBe(1);
    expect(harness.supervisor.snapshot().state).toBe("stopped");
  });

  it("fails before process creation when pinned integrity verification rejects", async () => {
    const harness = createHarness();
    harness.integrity.failure = new RuntimeBoundaryError({
      code: "INTEGRITY_FAILED",
      message: "Fixture integrity failure.",
      retryable: false
    });

    await expect(warmup(harness)).rejects.toMatchObject({
      detail: { code: "INTEGRITY_FAILED" }
    });
    expect(harness.portAllocator.reserveCount).toBe(0);
    expect(harness.processHost.specs).toEqual([]);
    expect(harness.supervisor.snapshot().state).toBe("failed");
  });

  it("fails before process creation when the ephemeral API key is malformed", async () => {
    const harness = createHarness();
    harness.secretSource.apiKey = "too-short";

    await expect(warmup(harness)).rejects.toMatchObject({
      detail: { code: "SECURITY_BOUNDARY" }
    });
    expect(harness.processHost.specs).toEqual([]);
    expect(harness.supervisor.snapshot().state).toBe("failed");
  });

  it("tears down when a ready response is not owned by the child", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    harness.ownership.owned = false;

    await expect(warmup(harness)).rejects.toMatchObject({
      detail: { code: "SECURITY_BOUNDARY" }
    });
    expect(harness.processHost.terminateCount).toBe(1);
    expect(harness.supervisor.snapshot().state).toBe("failed");
  });

  it("retains authority when a failed startup process cannot be confirmed stopped", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    harness.ownership.owned = false;
    harness.processHost.failTermination = true;

    await expect(warmup(harness)).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE" }
    });
    expect(harness.processHost.child.alive).toBe(true);
    expect(harness.supervisor.snapshot().state).toBe("failed");
    await expect(warmup(harness)).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });

    harness.processHost.failTermination = false;
    await harness.supervisor.stop();
    expect(harness.processHost.child.alive).toBe(false);
    await expect(harness.supervisor.shutdown()).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });
  });

  it("enforces the fixed 60-second readiness deadline and tears down", async () => {
    const harness = createHarness();
    harness.http.defaultHealth = { state: "unavailable" };
    harness.clock.delayAdvanceOverride = 10_000;

    await expect(warmup(harness)).rejects.toMatchObject({
      detail: {
        code: "TIMEOUT",
        message: expect.stringContaining("60 seconds")
      }
    });
    expect(harness.clock.monotonic).toBeGreaterThanOrEqual(
      LLAMA_SERVER_READINESS_TIMEOUT_MS
    );
    expect(harness.processHost.terminateCount).toBe(1);
  });

  it("runs bounded chat through the injected one-GPU lane", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    harness.http.chatContent = "A short local answer.";
    await warmup(harness);

    const result = await harness.supervisor.chat(
      chatRequest,
      new AbortController().signal
    );

    expect(result).toMatchObject({
      operationId: OPERATION_ID,
      runtimeId: MANAGED_LLAMA_RUNTIME_ID,
      modelId: launchInput.model.modelId,
      content: "A short local answer.",
      localOnly: true
    });
    expect(harness.lane.enqueuedIds).toEqual([
      WARMUP_OPERATION_ID,
      OPERATION_ID
    ]);
    expect(harness.http.chatRequests).toEqual([
      [PORT, chatRequest, API_KEY]
    ]);
    await harness.supervisor.shutdown();
  });

  it("keeps resolve, launch, and chat inside one managed lane operation", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    let resolverCalls = 0;

    const result = await harness.supervisor.runLazy(
      chatRequest,
      async (signal) => {
        signal.throwIfAborted();
        resolverCalls += 1;
        return launchInput;
      },
      new AbortController().signal
    );

    expect(result.content).toBe("Local answer.");
    expect(resolverCalls).toBe(1);
    expect(harness.lane.enqueuedIds).toEqual([OPERATION_ID]);
    expect(harness.processHost.specs).toHaveLength(1);
    expect(harness.http.chatRequests).toHaveLength(1);
    await harness.supervisor.shutdown();
  });

  it("cancels queued managed work before model resolution or process spawn", async () => {
    const harness = createHarness();
    harness.lane.deferTasks = true;
    let resolverCalls = 0;
    const answer = harness.supervisor.runLazy(
      chatRequest,
      async () => {
        resolverCalls += 1;
        return launchInput;
      },
      new AbortController().signal
    );

    await expect(harness.supervisor.cancel(OPERATION_ID)).resolves.toBe(true);
    await harness.lane.runNext();

    await expect(answer).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(resolverCalls).toBe(0);
    expect(harness.processHost.specs).toEqual([]);
  });

  it("rejects a cloned runtime activation before process creation", async () => {
    const harness = createHarness();
    const forged: LlamaServerLaunchInput = {
      ...launchInput,
      runtime: structuredClone(launchInput.runtime)
    };

    await expect(harness.supervisor.runLazy(
      chatRequest,
      async () => forged,
      new AbortController().signal
    )).rejects.toMatchObject({
      detail: { code: "SECURITY_BOUNDARY", retryable: false }
    });
    expect(harness.processHost.specs).toEqual([]);
  });

  it("cancels during lazy resolution without launching a process", async () => {
    const harness = createHarness();
    let resolverStarted = false;
    const answer = harness.supervisor.runLazy(
      chatRequest,
      (signal) => new Promise<LlamaServerLaunchInput>((_resolve, reject) => {
        resolverStarted = true;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      }),
      new AbortController().signal
    );
    await vi.waitFor(() => {
      expect(resolverStarted).toBe(true);
    });

    await expect(harness.supervisor.cancel(OPERATION_ID)).resolves.toBe(true);
    await expect(answer).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(harness.processHost.specs).toEqual([]);
  });

  it("cancels startup, confirms teardown, then permits one clean retry", async () => {
    const harness = createHarness();
    harness.http.waitForHealthAbort = true;
    const controller = new AbortController();
    const starting = harness.supervisor.warmup(
      WARMUP_OPERATION_ID,
      launchInput,
      controller.signal
    );
    await vi.waitFor(() => {
      expect(harness.processHost.specs).toHaveLength(1);
    });

    controller.abort(new DOMException("User cancelled.", "AbortError"));

    await expect(starting).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(harness.processHost.child.alive).toBe(false);
    expect(harness.processHost.terminateCount).toBe(1);

    harness.http.waitForHealthAbort = false;
    harness.http.healthQueue.push({ state: "ready" });
    await expect(warmup(harness)).resolves.toMatchObject({ state: "ready" });
    expect(harness.processHost.specs).toHaveLength(2);
    await harness.supervisor.shutdown();
  });

  it("reuses the exact ready process without spawning a second process", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);

    await expect(warmup(harness)).resolves.toMatchObject({
      state: "ready"
    });
    expect(harness.processHost.specs).toHaveLength(1);
    await harness.supervisor.shutdown();
  });

  it("aborts a cancelled answer and kills the owned process tree", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    harness.http.waitForChatAbort = true;
    await warmup(harness);
    const controller = new AbortController();

    const answer = harness.supervisor.chat(chatRequest, controller.signal);
    await Promise.resolve();
    controller.abort(new DOMException("User cancelled.", "AbortError"));

    await expect(answer).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(harness.processHost.terminateCount).toBe(1);
    expect(harness.supervisor.snapshot().state).toBe("stopped");
  });

  it("routes explicit operation cancellation through the lane and kills the tree", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    harness.http.waitForChatAbort = true;
    await warmup(harness);

    const answer = harness.supervisor.chat(
      chatRequest,
      new AbortController().signal
    );
    await Promise.resolve();

    await expect(
      harness.supervisor.cancel(OPERATION_ID)
    ).resolves.toBe(true);
    await expect(answer).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(harness.processHost.terminateCount).toBe(1);
    expect(harness.supervisor.snapshot().state).toBe("stopped");
  });

  it("fails closed on unexpected child exit and keeps diagnostics redacted", async () => {
    const harness = createHarness([
      `model=${launchInput.model.modelPath} token=super-secret api-key=${API_KEY}\n`
    ]);
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);
    await Promise.resolve();

    harness.processHost.child.finish({ code: 9, signal: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.supervisor.snapshot()).toMatchObject({
      state: "failed",
      modelId: null
    });
    const diagnostics = harness.supervisor.diagnosticSnapshot();
    expect(diagnostics).toContain("[redacted-sensitive]");
    expect(diagnostics).toContain("[redacted-secret]");
    expect(diagnostics).not.toContain(launchInput.model.modelPath);
    expect(diagnostics).not.toContain("super-secret");
    expect(diagnostics).not.toContain(API_KEY);
    expect(harness.processHost.terminateCount).toBe(1);
  });

  it("runs unexpected-exit descendant cleanup before ordinary shared-lane work", async () => {
    const lane = new SingleLaneScheduler();
    const harness = createHarnessWithLane(lane);
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);

    const gate = deferred<void>();
    const activeExternal = lane.enqueue("external-active", async () => {
      await gate.promise;
    });
    let terminationCountSeenByQueuedWork = -1;
    const queuedExternal = lane.enqueue("external-queued", async () => {
      terminationCountSeenByQueuedWork =
        harness.processHost.terminateCount;
    });

    harness.processHost.child.finish({ code: 9, signal: null });
    await vi.waitFor(() => {
      expect(lane.snapshot().queuedIds[0]).toMatch(
        /^managed-native-teardown:/u
      );
    });

    gate.resolve(undefined);
    await Promise.all([activeExternal, queuedExternal]);

    expect(terminationCountSeenByQueuedWork).toBe(1);
    expect(harness.processHost.terminateCount).toBe(1);
    expect(lane.snapshot()).toEqual({
      activeId: null,
      queuedIds: []
    });
    expect(harness.supervisor.snapshot()).toMatchObject({
      state: "failed",
      modelId: null
    });
    await harness.supervisor.shutdown();
  });

  it("retains group authority when descendants survive the leader exit", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);
    harness.processHost.failTermination = true;

    harness.processHost.child.finish({ code: 9, signal: null });
    await vi.waitFor(() => {
      expect(harness.processHost.terminateCount).toBe(1);
    });

    expect(harness.supervisor.snapshot()).toMatchObject({
      state: "failed",
      modelId: null
    });
    await expect(warmup(harness)).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });

    harness.processHost.failTermination = false;
    await harness.supervisor.stop();
    expect(harness.processHost.terminateCount).toBe(2);
    expect(harness.supervisor.snapshot().state).toBe("stopped");
  });

  it("rejects queued work captured from an earlier process generation", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);
    harness.lane.deferTasks = true;
    const staleAnswer = harness.supervisor.chat(
      chatRequest,
      new AbortController().signal
    );

    await harness.supervisor.stop();
    harness.lane.deferTasks = false;
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);
    await expect(
      harness.supervisor.cancel(OPERATION_ID)
    ).resolves.toBe(true);
    expect(harness.supervisor.snapshot().state).toBe("ready");
    await harness.lane.runNext();

    await expect(staleAnswer).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE" }
    });
    expect(harness.http.chatRequests).toEqual([]);
    expect(harness.supervisor.snapshot().state).toBe("ready");
    expect(harness.processHost.terminateCount).toBe(1);
    await harness.supervisor.shutdown();
  });

  it("makes shutdown idempotent", async () => {
    const harness = createHarness();
    harness.http.healthQueue.push({ state: "ready" });
    await warmup(harness);

    await Promise.all([
      harness.supervisor.shutdown(),
      harness.supervisor.shutdown()
    ]);
    await harness.supervisor.shutdown();

    expect(harness.processHost.terminateCount).toBe(1);
    expect(harness.supervisor.snapshot().state).toBe("stopped");
  });
});

describe("NodeManagedRuntimeHttpClient", () => {
  it("accepts only the exact loopback health shape", async () => {
    let observedHealthInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      observedHealthInit = init;
      return responseFor(url, JSON.stringify({ status: "ok" }), 200);
    });
    const client = new NodeManagedRuntimeHttpClient(fetchImpl);

    await expect(
      client.health(PORT, new AbortController().signal)
    ).resolves.toEqual({ state: "ready" });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:${PORT}/health`,
      expect.objectContaining({
        method: "GET",
        redirect: "error"
      })
    );
    const healthHeaders = observedHealthInit?.headers as
      | Record<string, string>
      | undefined;
    expect(healthHeaders?.authorization).toBeUndefined();

    const invalidClient = new NodeManagedRuntimeHttpClient(async (url) =>
      responseFor(url, JSON.stringify({ status: "ok", extra: true }), 200)
    );
    await expect(
      invalidClient.health(PORT, new AbortController().signal)
    ).rejects.toMatchObject({
      detail: { code: "RUNTIME_RESPONSE_INVALID" }
    });
  });

  it("creates distinct fixed-shape per-process API keys", () => {
    const secretSource = new NodeManagedRuntimeSecretSource();
    const first = secretSource.createApiKey();
    const second = secretSource.createApiKey();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
  });

  it("uses only the fixed OpenAI-compatible chat endpoint and bounded body", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const client = new NodeManagedRuntimeHttpClient(async (url, init) => {
      observedUrl = url;
      observedInit = init;
      return responseFor(
        url,
        JSON.stringify({
          choices: [{ message: { content: "Local result" } }]
        }),
        200
      );
    });

    await expect(
      client.chat(
        PORT,
        chatRequest,
        API_KEY,
        new AbortController().signal
      )
    ).resolves.toBe("Local result");
    expect(observedUrl).toBe(
      `http://127.0.0.1:${PORT}/v1/chat/completions`
    );
    expect(observedInit).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({
        authorization: `Bearer ${API_KEY}`
      })
    });
    expect(JSON.parse(String(observedInit?.body))).toEqual({
      model: chatRequest.modelId,
      messages: chatRequest.messages,
      temperature: chatRequest.temperature,
      max_tokens: chatRequest.maxTokens,
      stream: false
    });
  });
});

describe("macOS listener ownership parsing", () => {
  it("accepts only the child PID bound to exact IPv4 loopback", () => {
    expect(
      isExactOwnedLoopbackListenerOutput(
        `p7321\nn127.0.0.1:${PORT}\n`,
        7_321,
        PORT
      )
    ).toBe(true);
    expect(
      isExactOwnedLoopbackListenerOutput(
        `p7321\nn*:${PORT}\n`,
        7_321,
        PORT
      )
    ).toBe(false);
    expect(
      isExactOwnedLoopbackListenerOutput(
        `p9999\nn127.0.0.1:${PORT}\n`,
        7_321,
        PORT
      )
    ).toBe(false);
  });
});

describe("BoundedRedactedLog", () => {
  it("bounds and redacts sensitive diagnostics", () => {
    const log = new BoundedRedactedLog(1_024);
    log.addSensitiveValue("/Users/person/private/model.gguf");
    log.append(
      "/Users/person/private/model.gguf " +
      "Authorization: Bearer abc.def.ghi " +
      "https://example.invalid/private " +
      "x".repeat(4_096)
    );

    const value = log.snapshot();
    expect(value.length).toBeLessThanOrEqual(1_024);
    expect(value).not.toContain("/Users/person");
    expect(value).not.toContain("abc.def.ghi");
    expect(value).not.toContain("example.invalid");
  });

  it("redacts an API key split across diagnostic chunks", () => {
    const log = new BoundedRedactedLog(1_024);
    log.addSensitiveValue(API_KEY);
    log.append(`credential=${API_KEY.slice(0, 19)}`);
    log.append(`${API_KEY.slice(19)}\n`);

    const value = log.snapshot();
    expect(value).not.toContain(API_KEY);
    expect(value).toContain("[redacted-sensitive]");
  });
});

function createHarness(stderrChunks: readonly string[] = []) {
  return createHarnessWithLane(
    new FakeOperationLane(),
    stderrChunks
  );
}

function createHarnessWithLane<
  TLane extends ManagedRuntimeOperationLane
>(
  lane: TLane,
  stderrChunks: readonly string[] = []
) {
  launchIntegrityVerifier.inputs.splice(0);
  launchIntegrityVerifier.failure = null;
  const integrity = launchIntegrityVerifier;
  const portAllocator = new FakePortAllocator();
  const processHost = new FakeProcessHost(stderrChunks);
  const ownership = new FakeOwnershipVerifier();
  const http = new FakeHttpClient();
  const secretSource = new FakeSecretSource();
  const clock = new FakeClock();
  const supervisor = new LlamaServerSupervisor({
    operationLane: lane,
    portAllocator,
    processHost,
    listenerOwnership: ownership,
    httpClient: http,
    secretSource,
    clock
  });
  return {
    supervisor,
    integrity,
    portAllocator,
    processHost,
    ownership,
    http,
    secretSource,
    clock,
    lane
  };
}

function warmup(
  harness: { readonly supervisor: LlamaServerSupervisor }
): Promise<import("./types.js").ManagedRuntimeSnapshot> {
  return harness.supervisor.warmup(
    WARMUP_OPERATION_ID,
    launchInput,
    new AbortController().signal
  );
}

class FakePortAllocator implements LoopbackPortAllocator {
  reserveCount = 0;
  releaseCount = 0;

  async reserve(signal: AbortSignal) {
    signal.throwIfAborted();
    this.reserveCount += 1;
    let released = false;
    return {
      port: PORT,
      release: async () => {
        if (!released) {
          released = true;
          this.releaseCount += 1;
        }
      }
    };
  }
}

class FakeChild implements OwnedRuntimeProcess {
  readonly pid = 7_321;
  readonly exit: Promise<RuntimeProcessExit>;
  private resolveExit!: (exit: RuntimeProcessExit) => void;
  private running = true;
  readonly stderr: AsyncIterable<Uint8Array | string>;

  constructor(stderrChunks: readonly string[]) {
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.stderr = (async function* () {
      for (const chunk of stderrChunks) {
        yield chunk;
      }
    })();
  }

  get alive(): boolean {
    return this.running;
  }

  finish(exit: RuntimeProcessExit): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.resolveExit(exit);
  }
}

class FakeProcessHost implements RuntimeProcessHost {
  readonly specs: RuntimeProcessSpec[] = [];
  readonly children: FakeChild[] = [];
  terminateCount = 0;
  failTermination = false;

  constructor(private readonly stderrChunks: readonly string[]) {}

  get child(): FakeChild {
    const child = this.children.at(-1);
    if (child === undefined) {
      throw new Error("The fixture process has not been spawned.");
    }
    return child;
  }

  spawn(spec: RuntimeProcessSpec): OwnedRuntimeProcess {
    this.specs.push(spec);
    const child = new FakeChild(this.stderrChunks);
    this.children.push(child);
    return child;
  }

  async terminateTree(child: OwnedRuntimeProcess): Promise<void> {
    this.terminateCount += 1;
    if (this.failTermination) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_UNAVAILABLE",
        message: "Fixture could not terminate the tree.",
        retryable: true
      });
    }
    if (child instanceof FakeChild) {
      child.finish({ code: null, signal: "SIGTERM" });
    }
    await child.exit;
  }
}

class FakeOwnershipVerifier
implements LoopbackListenerOwnershipVerifier {
  owned = true;
  readonly checks: Array<[number, number]> = [];

  async isOwnedBy(
    pid: number,
    port: number,
    signal: AbortSignal
  ): Promise<boolean> {
    signal.throwIfAborted();
    this.checks.push([pid, port]);
    return this.owned;
  }
}

class FakeHttpClient implements ManagedRuntimeHttpClient {
  readonly healthQueue: HealthObservation[] = [];
  defaultHealth: HealthObservation = { state: "unavailable" };
  chatContent = "Local answer.";
  waitForHealthAbort = false;
  waitForChatAbort = false;
  readonly chatRequests: Array<[number, LocalChatRequest, string]> = [];

  async health(
    _port: number,
    signal: AbortSignal
  ): Promise<HealthObservation> {
    if (this.waitForHealthAbort) {
      return new Promise<HealthObservation>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      });
    }
    signal.throwIfAborted();
    return this.healthQueue.shift() ?? this.defaultHealth;
  }

  async chat(
    port: number,
    request: LocalChatRequest,
    apiKey: string,
    signal: AbortSignal
  ): Promise<string> {
    this.chatRequests.push([port, request, apiKey]);
    if (!this.waitForChatAbort) {
      signal.throwIfAborted();
      return this.chatContent;
    }
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        reject(new RuntimeBoundaryError({
          code: "CANCELLED",
          message: "Fixture cancelled.",
          retryable: true
        }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }
}

class FakeSecretSource implements ManagedRuntimeSecretSource {
  apiKey = API_KEY;

  createApiKey(): string {
    return this.apiKey;
  }
}

class FakeClock implements ManagedRuntimeClock {
  monotonic = 0;
  delayAdvanceOverride: number | null = null;
  private wallClock = Date.parse("2026-07-30T00:00:00.000Z");

  now(): Date {
    const value = new Date(this.wallClock);
    this.wallClock += 1;
    return value;
  }

  monotonicMs(): number {
    return this.monotonic;
  }

  async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.monotonic += this.delayAdvanceOverride ?? milliseconds;
  }
}

class FakeOperationLane implements ManagedRuntimeOperationLane {
  readonly enqueuedIds: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingTasks: Array<() => Promise<void>> = [];
  deferTasks = false;
  poisoned: RuntimeBoundaryError | null = null;

  async enqueue<T>(
    operationId: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.poisoned !== null) {
      throw this.poisoned;
    }
    const controller = new AbortController();
    this.enqueuedIds.push(operationId);
    this.controllers.set(operationId, controller);
    if (this.deferTasks) {
      return new Promise<T>((resolve, reject) => {
        this.pendingTasks.push(async () => {
          try {
            resolve(await task(controller.signal));
          } catch (error) {
            reject(error);
          } finally {
            this.controllers.delete(operationId);
          }
        });
      });
    }
    try {
      return await task(controller.signal);
    } finally {
      this.controllers.delete(operationId);
    }
  }

  async runNext(): Promise<void> {
    const task = this.pendingTasks.shift();
    if (task === undefined) {
      throw new Error("The fixture operation lane has no pending task.");
    }
    await task();
  }

  enqueuePriorityBarrier<T>(
    operationId: string,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    return this.enqueue(operationId, task);
  }

  cancel(operationId: string): boolean {
    const controller = this.controllers.get(operationId);
    if (controller === undefined) {
      return false;
    }
    controller.abort(new DOMException("Lane cancelled.", "AbortError"));
    return true;
  }

  poison(error: RuntimeBoundaryError): void {
    if (this.poisoned !== null) {
      return;
    }
    this.poisoned = error;
    for (const controller of this.controllers.values()) {
      controller.abort(error);
    }
  }
}

function responseFor(
  url: string,
  body: string,
  status: number
): Response {
  const response = new Response(body, {
    status,
    headers: { "content-type": "application/json" }
  });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: url
  });
  return response;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
