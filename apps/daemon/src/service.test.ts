import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  DaemonRequestSchema,
  type DaemonRequest,
  type HardwareProfile,
  type LicenseAcceptanceIntent,
  type ModelInstallStatus
} from "@cadrane/contracts";
import {
  LlamaServerSupervisor,
  loadStaticBetaModelCatalog,
  LocalRuntimeManager,
  ManagedLlamaAdapter,
  RuntimeBoundaryError,
  SingleLaneScheduler,
  type LlamaServerLaunchInput,
  type ModelDownloadTransport,
  type OwnedRuntimeProcess,
  type RuntimeProcessExit,
  type RuntimeProcessHost,
  type RuntimeProcessSpec
} from "@cadrane/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  promoteVerifiedManagedRuntimeAuthority
} from "../../../packages/runtime/dist/managed-runtime/activation-provenance.js";
import {
  promoteVerifiedManagedModel
} from "../../../packages/runtime/dist/managed-runtime/promoted-model-provenance.js";
import {
  createDaemonDispatcher,
  createDispatcherFromDependencies,
  MANAGED_MODEL_DOWNLOAD_REDIRECT_POLICY,
  resolveTrustedDataDirectory,
  toRendererSafeDaemonError,
  type DaemonModelInstallBoundary,
  type DaemonWorkRequest
} from "./service.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const modelId = "qwen3-4b-q4-k-m";
const artifactSha256 =
  "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5";
const noticeSha256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const now = new Date("2026-08-01T00:00:00.000Z");
const temporaryDirectories: string[] = [];

const profile: HardwareProfile = {
  platform: "darwin",
  operatingSystem: "macOS test",
  architecture: "arm64",
  chip: "Apple test",
  gpuName: "Apple test",
  dedicatedGpuMemoryBytes: null,
  logicalCores: 8,
  memoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 100 * 1024 ** 3,
  acceleration: "metal",
  recommendation: "balanced",
  recommendationReason: "Fixture recommendation.",
  measuredAt: now.toISOString()
};

const status: ModelInstallStatus = {
  modelId,
  state: "installed",
  operationId,
  catalogGeneration: 1,
  artifactSha256,
  bytesReceived: 2_497_280_256,
  totalBytes: 2_497_280_256,
  resumeAvailable: false,
  detail: "Installed after exact verification.",
  error: null,
  updatedAt: now.toISOString()
};

const acceptance: LicenseAcceptanceIntent = {
  modelId,
  artifactSha256,
  catalogGeneration: 1,
  licenseNoticeVersion: "Apache-2.0-2004-static-beta-1",
  licenseNoticeSha256: noticeSha256,
  accepted: true
};

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("daemon model install composition", () => {
  it("accepts only an absolute non-root trusted data directory", () => {
    expect(resolveTrustedDataDirectory("/tmp/switchboard-data/../switchboard-data"))
      .toBe("/tmp/switchboard-data");
    for (const invalid of ["", ".", "relative/path", "/", "\0bad"]) {
      expect(() => resolveTrustedDataDirectory(invalid)).toThrow(
        "trusted Rellane data directory is invalid"
      );
    }
  });

  it("loads the static catalog once and derives the private model root itself", async () => {
    let catalogLoads = 0;
    let factoryRoot = "";
    let factoryCatalogModelId = "";
    const installBoundary = new FakeInstallBoundary();
    const dispatcher = createDaemonDispatcher({
      dataDirectory: "/tmp/switchboard-owner-data",
      platform: "darwin",
      architecture: "arm64",
      now,
      runtimeManager: fakeRuntimeManager(),
      profile: async () => profile,
      catalogLoader: (target, at) => {
        catalogLoads += 1;
        return loadStaticBetaModelCatalog({
          target,
          ...(at === undefined ? {} : { now: at })
        });
      },
      installBoundaryFactory: (options) => {
        factoryRoot = options.rootDirectory;
        factoryCatalogModelId = options.catalog.body.artifacts[0]?.modelId ?? "";
        return installBoundary;
      }
    });

    await dispatcher.dispatch(request("model.install.snapshot", {}), signal());
    await dispatcher.dispatch(
      request("model.license.review", { modelId }),
      signal()
    );

    expect(catalogLoads).toBe(1);
    expect(factoryRoot).toBe(path.join(
      "/tmp/switchboard-owner-data",
      "local-intelligence",
      "managed-models"
    ));
    expect(factoryCatalogModelId).toBe(modelId);
  });

  it("does not touch the artifact network during startup or snapshot recovery", async () => {
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "switchboard-daemon-network-test-")
    );
    temporaryDirectories.push(dataDirectory);
    const requestTransport = vi.fn<ModelDownloadTransport["request"]>(
      async () => {
        throw new Error("Network must not be reached.");
      }
    );
    let currentTime = now;
    const dispatcher = createDaemonDispatcher({
      dataDirectory,
      platform: "darwin",
      architecture: "arm64",
      clock: () => currentTime,
      runtimeManager: fakeRuntimeManager(),
      profile: async () => profile,
      downloadTransport: { request: requestTransport }
    });

    expect(requestTransport).not.toHaveBeenCalled();
    const snapshot = await dispatcher.dispatch(
      request("model.install.snapshot", {}),
      signal()
    );
    expect(snapshot).toMatchObject([{ modelId, state: "not-installed" }]);
    expect(requestTransport).not.toHaveBeenCalled();

    currentTime = new Date("2027-07-30T00:00:00.000Z");
    await expect(dispatcher.dispatch(
      request("model.license.review", { modelId }),
      signal()
    )).rejects.toMatchObject({
      detail: { code: "CATALOG_INVALID" }
    });
    await expect(dispatcher.dispatch(
      request("runtime.discover", {}),
      signal()
    )).resolves.toEqual([]);
    expect(requestTransport).not.toHaveBeenCalled();
  });

  it("composes a truthful managed runtime with the shared install stack by default", async () => {
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "switchboard-daemon-managed-stack-")
    );
    temporaryDirectories.push(dataDirectory);
    const requestTransport = vi.fn<ModelDownloadTransport["request"]>(
      async () => {
        throw new Error("Discovery must not download an artifact.");
      }
    );
    const dispatcher = createDaemonDispatcher({
      dataDirectory,
      platform: "darwin",
      architecture: "arm64",
      now,
      profile: async () => profile,
      downloadTransport: { request: requestTransport }
    });

    const [runtimes, snapshot] = await Promise.all([
      dispatcher.dispatch(request("runtime.discover", {}), signal()),
      dispatcher.dispatch(request("model.install.snapshot", {}), signal())
    ]);
    const managed = (runtimes as Array<{ id: string }>).find(
      (runtime) => runtime.id === "managed-llama-b10182"
    );

    expect(managed).toMatchObject({
      kind: "managed-llama",
      state: "unavailable",
      baseUrl: null,
      version: null,
      models: []
    });
    expect(snapshot).toMatchObject([{ modelId, state: "not-installed" }]);
    expect(JSON.stringify(managed)).not.toMatch(
      /modelPath|runtimeRoot|serverPath|downloadUrl|payloadDirectory/u
    );
    expect(requestTransport).not.toHaveBeenCalled();
    await expect(dispatcher.shutdown()).resolves.toBeUndefined();
    await expect(
      dispatcher.dispatch(request("runtime.discover", {}), signal())
    ).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE", retryable: false }
    });
  });

  it("routes a promoted authority through the service, manager, adapter, and supervisor", async () => {
    const catalog = loadStaticBetaModelCatalog({
      target: "darwin-arm64",
      now
    });
    const artifact = catalog.body.artifacts.find(
      (candidate) => candidate.modelId === modelId
    );
    if (artifact === undefined) {
      throw new Error("The managed service fixture model is missing.");
    }

    const verifier = {
      verify: vi.fn(async (
        input: LlamaServerLaunchInput,
        requestSignal: AbortSignal
      ) => {
        requestSignal.throwIfAborted();
        expect(input.authority).toBe(authority);
      })
    };
    const authority = promoteVerifiedManagedRuntimeAuthority({
      runtimeRoot: "/fixture/signed-runtime",
      payloadDirectory: "/fixture/signed-runtime/llama-b10182",
      serverPath: "/fixture/signed-runtime/llama-b10182/llama-server",
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
        serverSha256: "c".repeat(64)
      }
    }, verifier);
    const promotedModel = promoteVerifiedManagedModel({
      rootDirectory: "/fixture/models",
      modelId,
      displayName: artifact.displayName,
      modelPath: "/fixture/models/qwen3/model.gguf",
      artifactSha256: artifact.sha256,
      downloadBytes: artifact.downloadBytes,
      catalogGeneration: catalog.body.generation,
      target: "darwin-arm64"
    });
    const lane = new SingleLaneScheduler();
    const processHost = new ServiceFixtureProcessHost();
    let monotonic = 0;
    const supervisor = new LlamaServerSupervisor({
      operationLane: lane,
      portAllocator: {
        reserve: async (requestSignal) => {
          requestSignal.throwIfAborted();
          return {
            port: 43_121,
            release: async () => {}
          };
        }
      },
      processHost,
      listenerOwnership: {
        isOwnedBy: async (_pid, _port, requestSignal) => {
          requestSignal.throwIfAborted();
          return true;
        }
      },
      httpClient: {
        health: async (_port, requestSignal) => {
          requestSignal.throwIfAborted();
          return { state: "ready" as const };
        },
        chat: async (_port, _request, _apiKey, requestSignal) => {
          requestSignal.throwIfAborted();
          return "Service-routed local answer.";
        }
      },
      secretSource: {
        createApiKey: () => "s".repeat(43)
      },
      clock: {
        now: () => new Date(now.getTime() + monotonic++),
        monotonicMs: () => monotonic,
        delay: async (milliseconds, requestSignal) => {
          requestSignal.throwIfAborted();
          monotonic += milliseconds;
        }
      }
    });
    const managedAdapter = new ManagedLlamaAdapter({
      lane,
      supervisor,
      catalogSource: {
        currentCatalog: () => catalog
      },
      installController: {
        snapshot: async () => [status]
      },
      modelResolver: {
        resolveInstalledModel: async (_input, requestSignal) => {
          requestSignal.throwIfAborted();
          return promotedModel;
        }
      },
      activationSource: {
        currentAuthority: () => authority
      },
      target: "darwin-arm64",
      now: () => now
    });
    const runtimeManager = new LocalRuntimeManager(
      [managedAdapter],
      lane
    );
    const dispatcher = createDispatcherFromDependencies({
      dataDirectory: "/tmp/switchboard-trusted",
      runtimeManager,
      installBoundary: new FakeInstallBoundary(),
      installUnavailableError: null,
      profile: async () => profile,
      inspect: async () => ({ inspection: null })
    });

    await expect(
      dispatcher.dispatch(request("runtime.discover", {}), signal())
    ).resolves.toMatchObject([{
      id: "managed-llama-b10182",
      kind: "managed-llama",
      state: "available",
      models: [{ id: modelId }]
    }]);
    await expect(dispatcher.dispatch(
      request("runtime.chat", {
        operationId,
        runtimeId: "managed-llama-b10182",
        modelId,
        messages: [{ role: "user", content: "Reply from the local worker." }],
        temperature: 0.2,
        maxTokens: 128
      }),
      signal()
    )).resolves.toMatchObject({
      operationId,
      runtimeId: "managed-llama-b10182",
      modelId,
      content: "Service-routed local answer.",
      localOnly: true
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(processHost.specs).toHaveLength(1);

    await expect(dispatcher.shutdown()).resolves.toBeUndefined();
    expect(processHost.terminateCount).toBe(1);
  });

  it("keeps non-install routes working when target or catalog activation fails", async () => {
    const profilePaths: string[] = [];
    const unsupported = createDaemonDispatcher({
      dataDirectory: "/tmp/switchboard-trusted",
      platform: "linux",
      architecture: "x64",
      runtimeManager: fakeRuntimeManager(),
      profile: async (dataDirectory) => {
        profilePaths.push(dataDirectory);
        return profile;
      },
      catalogLoader: () => {
        throw new Error("Unsupported targets must not load a catalog.");
      }
    });

    await expect(unsupported.dispatch(
      request("runtime.discover", {}),
      signal()
    )).resolves.toEqual([]);
    await expect(unsupported.dispatch(
      request("system.profile", { dataDir: "/renderer-controlled" }),
      signal()
    )).resolves.toEqual(profile);
    expect(profilePaths).toEqual(["/tmp/switchboard-trusted"]);
    await expect(unsupported.dispatch(
      request("model.install.snapshot", {}),
      signal()
    )).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE" }
    });

    const invalidCatalog = createDaemonDispatcher({
      dataDirectory: "/tmp/switchboard-trusted",
      platform: "darwin",
      architecture: "arm64",
      runtimeManager: fakeRuntimeManager(),
      profile: async () => profile,
      catalogLoader: () => {
        throw new RuntimeBoundaryError({
          code: "CATALOG_INVALID",
          message: "Expired fixture with private details.",
          retryable: false
        });
      }
    });
    await expect(invalidCatalog.dispatch(
      request("runtime.discover", {}),
      signal()
    )).resolves.toEqual([]);
    await expect(invalidCatalog.dispatch(
      request("model.license.review", { modelId }),
      signal()
    )).rejects.toMatchObject({
      detail: {
        code: "CATALOG_INVALID",
        message: "The signed model catalog is not currently valid."
      }
    });
  });

  it("passes only strict intents and the matching request signal to install services", async () => {
    const boundary = new FakeInstallBoundary();
    const dispatcher = dispatcherWith(boundary);
    const controller = new AbortController();

    const acknowledgement = await dispatcher.dispatch(
      request("model.license.acknowledge", acceptance),
      signal()
    );
    const installed = await dispatcher.dispatch(
      request("model.install.start", { modelId }),
      controller.signal
    );
    const staleCancel = await dispatcher.dispatch(
      request("model.install.cancel", { operationId }),
      signal()
    );

    expect(boundary.acknowledgeCalls).toEqual([acceptance]);
    expect(boundary.startCalls).toEqual([
      { modelId, signal: controller.signal }
    ]);
    expect(staleCancel).toEqual({
      cancelRequested: false,
      status: null
    });
    const serialized = JSON.stringify([
      acknowledgement,
      installed,
      staleCancel
    ]);
    for (const privilegedValue of [
      "https://",
      "/tmp/",
      "modelPath",
      "downloadUrl",
      "\"target\"",
      "\"catalog\""
    ]) {
      expect(serialized).not.toContain(privilegedValue);
    }
  });

  it("forwards abort to only the in-flight start signal", async () => {
    let receivedSignal: AbortSignal | null = null;
    const boundary = new FakeInstallBoundary();
    boundary.start = async (_modelId, requestSignal) => {
      receivedSignal = requestSignal ?? null;
      await new Promise<void>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      });
      return status;
    };
    const dispatcher = dispatcherWith(boundary);
    const controller = new AbortController();
    const pending = dispatcher.dispatch(
      request("model.install.start", { modelId }),
      controller.signal
    );
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal).toBe(controller.signal);
  });

  it("rejects privileged fields returned by an install dependency", async () => {
    const boundary = new FakeInstallBoundary();
    boundary.snapshot = async () => [{
      ...status,
      modelPath: "/tmp/private/model.gguf",
      downloadUrl: "https://private.invalid/signed-url"
    }];
    await expect(dispatcherWith(boundary).dispatch(
      request("model.install.snapshot", {}),
      signal()
    )).rejects.toMatchObject({ name: "ZodError" });
  });

  it("redacts unknown install failures before they cross the daemon boundary", () => {
    const error = toRendererSafeDaemonError(
      new Error(
        "fetch https://private.invalid/signed failed for /tmp/private.gguf"
      ),
      "model.install.start"
    );
    expect(error).toEqual({
      code: "UNKNOWN",
      message: "The managed model operation failed inside the isolated service.",
      retryable: false
    });
    expect(JSON.stringify(error)).not.toContain("https://");
    expect(JSON.stringify(error)).not.toContain("/tmp/");
  });

  it("pins the only configured extra redirect origin and a bounded limit", () => {
    expect(MANAGED_MODEL_DOWNLOAD_REDIRECT_POLICY).toEqual({
      allowedRedirectOrigins: ["https://us.aws.cdn.hf.co"],
      maximumRedirects: 3
    });
    expect(Object.isFrozen(MANAGED_MODEL_DOWNLOAD_REDIRECT_POLICY)).toBe(true);
    expect(Object.isFrozen(
      MANAGED_MODEL_DOWNLOAD_REDIRECT_POLICY.allowedRedirectOrigins
    )).toBe(true);
  });
});

class FakeInstallBoundary implements DaemonModelInstallBoundary {
  readonly acknowledgeCalls: unknown[] = [];
  readonly startCalls: Array<{
    modelId: string;
    signal: AbortSignal | undefined;
  }> = [];

  async snapshot(): Promise<unknown> {
    return [status];
  }

  async review(): Promise<unknown> {
    return {
      modelId,
      displayName: "Qwen3 4B (Q4_K_M)",
      artifactSha256,
      downloadBytes: 2_497_280_256,
      catalogGeneration: 1,
      licenseId: "Apache-2.0",
      licenseName: "Apache License 2.0",
      licenseNoticeVersion: "Apache-2.0-2004-static-beta-1",
      licenseNoticeSha256: noticeSha256,
      noticeText: "Apache fixture notice.",
      sourceHost: "huggingface.co", repository: "Qwen/Test-GGUF",
      acknowledgementCurrent: false
    };
  }

  async acknowledge(intent: unknown): Promise<unknown> {
    this.acknowledgeCalls.push(intent);
    return {
      acknowledgementVersion: 1,
      modelId,
      artifactSha256,
      licenseNoticeVersion: "Apache-2.0-2004-static-beta-1",
      licenseNoticeSha256: noticeSha256,
      catalogGeneration: 1,
      acceptedAt: now.toISOString()
    };
  }

  async start(
    selectedModelId: string,
    requestSignal?: AbortSignal
  ): Promise<unknown> {
    this.startCalls.push({
      modelId: selectedModelId,
      signal: requestSignal
    });
    return status;
  }

  async cancel(): Promise<unknown> {
    return {
      cancelRequested: false,
      status: null
    };
  }
}

function dispatcherWith(
  installBoundary: DaemonModelInstallBoundary
) {
  return createDispatcherFromDependencies({
    dataDirectory: "/tmp/switchboard-trusted",
    runtimeManager: fakeRuntimeManager(),
    installBoundary,
    installUnavailableError: null,
    profile: async () => profile,
    inspect: async () => ({ inspection: null })
  });
}

function fakeRuntimeManager() {
  return {
    discover: async () => [],
    chat: async () => {
      throw new Error("Chat is not used in this fixture.");
    },
    cancel: () => false,
    shutdown: async () => {}
  };
}

class ServiceFixtureChild implements OwnedRuntimeProcess {
  readonly pid = 7_654;
  readonly stderr: AsyncIterable<Uint8Array | string> =
    (async function* () {})();
  readonly exit: Promise<RuntimeProcessExit>;
  private resolveExit!: (exit: RuntimeProcessExit) => void;
  private running = true;

  constructor() {
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
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

class ServiceFixtureProcessHost implements RuntimeProcessHost {
  readonly specs: RuntimeProcessSpec[] = [];
  readonly children: ServiceFixtureChild[] = [];
  terminateCount = 0;

  spawn(spec: RuntimeProcessSpec): OwnedRuntimeProcess {
    this.specs.push(spec);
    const child = new ServiceFixtureChild();
    this.children.push(child);
    return child;
  }

  async terminateTree(child: OwnedRuntimeProcess): Promise<void> {
    this.terminateCount += 1;
    if (child instanceof ServiceFixtureChild) {
      child.finish({ code: null, signal: "SIGTERM" });
    }
    await child.exit;
  }
}

function request(
  type: DaemonWorkRequest["type"],
  payload: unknown
): DaemonWorkRequest {
  return DaemonRequestSchema.parse({
    protocolVersion: 5,
    requestId,
    type,
    payload
  }) as Exclude<DaemonRequest, { type: "request.cancel" }>;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
