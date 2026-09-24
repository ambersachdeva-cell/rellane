import type {
  LicenseAcknowledgement,
  ModelCatalogBody,
  ModelInstallState,
  ModelInstallStatus,
  PinnedModelArtifact,
  SignedModelCatalog
} from "@cadrane/contracts";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  catalogSigningBytes,
  verifySignedModelCatalog
} from "./catalog-verifier.js";
import type {
  LicenseAcknowledgementStore
} from "./license-acknowledgement-store.js";
import type {
  ManagedModelInstallInput,
  ManagedModelInstallResult,
  ManagedModelInstallerSnapshot,
  ManagedModelProbeInput
} from "./managed-model-store.js";
import {
  ModelInstallController,
  type ModelInstallControllerInstaller
} from "./model-install-controller.js";
import {
  ModelLicenseService,
  type VerifiedModelCatalogSource
} from "./model-license-service.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({
  type: "spki",
  format: "pem"
}).toString();
const fixedNow = new Date("2026-08-01T12:34:56.000Z");
const firstOperationId = "11111111-1111-4111-8111-111111111111";
const secondOperationId = "22222222-2222-4222-8222-222222222222";

let currentCatalog: SignedModelCatalog;
let catalogSource: VerifiedModelCatalogSource;
let store: MemoryAcknowledgementStore;
let licenseService: ModelLicenseService;
let installer: FakeInstaller;
let operationIds: string[];

beforeEach(() => {
  currentCatalog = makeVerifiedCatalog();
  catalogSource = { currentCatalog: () => currentCatalog };
  store = new MemoryAcknowledgementStore();
  licenseService = new ModelLicenseService({
    catalogSource,
    store,
    now: () => fixedNow
  });
  installer = new FakeInstaller();
  operationIds = [firstOperationId, secondOperationId];
});

describe("daemon model install controller", () => {
  it.each([{ sourceHost: "different.example" }, { repository: "Different/Model" }])("rejects changed source metadata in a review", async change => {
    const controller = makeController();
    const review = await controller.review("model-one");
    licenseService.review = async () => ({ ...review, ...change });
    await expect(controller.review("model-one")).rejects.toThrow("catalog changed");
  });

  it("returns only strict renderer-safe review and daemon-created acknowledgement shapes", async () => {
    const controller = makeController();
    const review = await controller.review("model-one");
    const acknowledgement = await controller.acknowledge({
      modelId: review.modelId,
      artifactSha256: review.artifactSha256,
      catalogGeneration: review.catalogGeneration,
      licenseNoticeVersion: review.licenseNoticeVersion,
      licenseNoticeSha256: review.licenseNoticeSha256,
      accepted: true
    });

    expect(acknowledgement.acceptedAt).toBe(fixedNow.toISOString());
    expect(review.acknowledgementCurrent).toBe(false);
    expect(privilegedKeys([review, acknowledgement])).toEqual([]);
    await expect(controller.acknowledge({
      modelId: review.modelId,
      artifactSha256: review.artifactSha256,
      catalogGeneration: review.catalogGeneration,
      licenseNoticeVersion: review.licenseNoticeVersion,
      licenseNoticeSha256: review.licenseNoticeSha256,
      accepted: true,
      acceptedAt: fixedNow.toISOString(),
      downloadUrl: "https://example.invalid/model.gguf",
      modelPath: "/tmp/model.gguf"
    })).rejects.toMatchObject({
      detail: { code: "BAD_REQUEST" }
    });
  });

  it.each([
    ["installed", 4_096, false],
    ["paused", 1_024, true],
    ["quarantined", 0, false]
  ] as const)(
    "probes an exact current pin on initial and restarted %s snapshots",
    async (state, bytesReceived, resumeAvailable) => {
      installer.probeStatusFactory = (input) => statusFor(input.catalog, {
        state,
        bytesReceived,
        resumeAvailable,
        error: state === "quarantined"
          ? {
              code: "INTEGRITY_FAILED",
              message: "The artifact failed exact verification.",
              retryable: false
            }
          : null
      });
      installer.putStatus({
        ...statusFor(makeVerifiedCatalog({ generation: 6 }), {
          state: "installed"
        }),
        artifactSha256: "f".repeat(64)
      });

      const firstController = makeController();
      const first = await firstController.snapshot();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        modelId: "model-one",
        catalogGeneration: 7,
        artifactSha256: "a".repeat(64),
        state,
        bytesReceived,
        resumeAvailable
      });
      expect(installer.probeCalls).toHaveLength(1);

      await firstController.snapshot();
      expect(installer.probeCalls).toHaveLength(1);

      const restartedController = makeController();
      const restarted = await restartedController.snapshot();
      expect(restarted[0]?.state).toBe(state);
      expect(installer.probeCalls).toHaveLength(2);
      expect(JSON.stringify(restarted)).not.toContain("https://");
      expect(JSON.stringify(restarted)).not.toContain("/tmp/");
    }
  );

  it("serializes recovery before start and never probes over an active same-model operation", async () => {
    const controller = makeController();
    await acceptCurrentLicense(controller);
    const probeGate = deferred<void>();
    installer.probeGate = probeGate;
    const snapshotPromise = controller.snapshot();
    await waitUntil(() => installer.probeCalls.length === 1);

    const startPromise = controller.start("model-one");
    await tick();
    expect(installer.installCalls).toHaveLength(0);

    probeGate.resolve();
    await snapshotPromise;
    await startPromise;
    expect(installer.events).toEqual([
      "probe:start:model-one",
      "probe:end:model-one",
      "install:model-one"
    ]);

    const activeGate = deferred<void>();
    installer.installGate = activeGate;
    const secondStart = controller.start("model-one");
    await installer.installStarted.promise;
    const probesBeforeActiveSnapshot = installer.probeCalls.length;
    const activeSnapshot = await controller.snapshot();
    expect(activeSnapshot[0]?.state).toBe("downloading");
    expect(installer.probeCalls).toHaveLength(probesBeforeActiveSnapshot);
    activeGate.resolve();
    await secondStart;
  });

  it("requires a current acknowledgement and passes only daemon-resolved privileged inputs", async () => {
    const controller = makeController();
    await expect(controller.start("model-one")).rejects.toMatchObject({
      detail: { code: "LICENSE_REQUIRED" }
    });
    expect(installer.installCalls).toHaveLength(0);

    await acceptCurrentLicense(controller);
    const terminal = await controller.start("model-one");
    const call = installer.installCalls[0]!;
    expect(call.operationId).toBe(secondOperationId);
    expect(call.catalog).toBe(currentCatalog);
    expect(call.target).toBe("darwin-arm64");
    expect(call.request).toEqual({
      modelId: "model-one",
      acknowledgement: await store.load("model-one")
    });
    expect(terminal).toMatchObject({
      modelId: "model-one",
      state: "installed",
      operationId: secondOperationId
    });
    expect(privilegedKeys(terminal)).toEqual([]);
    expect(JSON.stringify(terminal)).not.toContain(installer.internalModelPath);
    expect(JSON.stringify(terminal)).not.toContain("runtimeReady");
    expect(JSON.stringify(terminal)).not.toContain("readyToUse");
  });

  it("returns BUSY for duplicate starts of one model", async () => {
    const controller = makeController();
    await acceptCurrentLicense(controller);
    const installGate = deferred<void>();
    installer.installGate = installGate;

    const first = controller.start("model-one");
    await installer.installStarted.promise;
    await expect(controller.start("model-one")).rejects.toMatchObject({
      detail: { code: "BUSY", retryable: true }
    });
    const recreatedController = makeController();
    await expect(recreatedController.start("model-one")).rejects.toMatchObject({
      detail: { code: "BUSY", retryable: true }
    });
    expect(installer.installCalls).toHaveLength(1);

    installGate.resolve();
    await first;
  });

  it("routes request abort only to its matching daemon-created operation", async () => {
    const controller = makeController();
    await acceptCurrentLicense(controller);
    const abortController = new AbortController();
    const installGate = deferred<void>();
    installer.installGate = installGate;
    installer.rejectGateOnCancel = true;

    const first = controller.start("model-one", abortController.signal);
    await installer.installStarted.promise;
    abortController.abort();
    await expect(first).rejects.toMatchObject({
      detail: { code: "CANCELLED" }
    });
    expect(installer.cancelCalls).toEqual([firstOperationId]);
    await expect(controller.snapshot()).resolves.toMatchObject([{
      state: "paused",
      operationId: null,
      resumeAvailable: true
    }]);
    expect(installer.probeCalls).toHaveLength(0);

    installer.installGate = null;
    installer.rejectGateOnCancel = false;
    await controller.start("model-one");
    expect(installer.cancelCalls).toEqual([firstOperationId]);
    expect(installer.installCalls[1]?.operationId).toBe(secondOperationId);
  });

  it("does not let a stale operation cancel a newer run or fabricate paused state", async () => {
    const controller = makeController();
    await acceptCurrentLicense(controller);
    await controller.start("model-one");

    const installGate = deferred<void>();
    installer.installGate = installGate;
    const current = controller.start("model-one");
    await installer.installStarted.promise;

    await expect(controller.cancel(firstOperationId)).resolves.toEqual({
      cancelRequested: false,
      status: null
    });
    expect(installer.cancelCalls).toEqual([]);

    const result = await controller.cancel(secondOperationId);
    expect(result).toMatchObject({
      cancelRequested: true,
      status: {
        state: "downloading",
        operationId: secondOperationId
      }
    });
    expect(result.status?.state).not.toBe("paused");
    expect(installer.cancelCalls).toEqual([secondOperationId]);

    installGate.resolve();
    await current;
  });

  it("accepts a separately verified but byte-identical current catalog object", async () => {
    const firstCatalog = makeVerifiedCatalog();
    const equivalentCatalog = makeVerifiedCatalog();
    let callCount = 0;
    catalogSource = {
      currentCatalog: () => {
        callCount += 1;
        return callCount % 2 === 1 ? firstCatalog : equivalentCatalog;
      }
    };
    licenseService = new ModelLicenseService({
      catalogSource,
      store,
      now: () => fixedNow
    });
    const controller = makeController();

    await expect(controller.snapshot()).resolves.toHaveLength(1);
    expect(installer.probeCalls).toHaveLength(1);
  });

  it("filters stale catalog pins and rejects privileged installer status fields", async () => {
    const controller = makeController();
    installer.probeStatusFactory = (input) => statusFor(input.catalog, {
      state: "paused",
      bytesReceived: 128,
      resumeAvailable: true
    });
    installer.putStatus(statusFor(makeVerifiedCatalog({ generation: 6 }), {
      state: "installed"
    }));
    const snapshot = await controller.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.catalogGeneration).toBe(7);

    installer.putStatus({
      ...snapshot[0]!,
      modelPath: "/tmp/private-model.gguf"
    } as ModelInstallStatus);
    await expect(controller.snapshot()).rejects.toMatchObject({
      detail: { code: "RUNTIME_RESPONSE_INVALID" }
    });
  });
});

function makeController(): ModelInstallController {
  return new ModelInstallController({
    catalogSource,
    licenseService,
    installer,
    target: "darwin-arm64",
    uniqueId: () => operationIds.shift() ?? firstOperationId
  });
}

async function acceptCurrentLicense(
  controller: ModelInstallController
): Promise<LicenseAcknowledgement> {
  const review = await controller.review("model-one");
  return controller.acknowledge({
    modelId: review.modelId,
    artifactSha256: review.artifactSha256,
    catalogGeneration: review.catalogGeneration,
    licenseNoticeVersion: review.licenseNoticeVersion,
    licenseNoticeSha256: review.licenseNoticeSha256,
    accepted: true
  });
}

class MemoryAcknowledgementStore implements LicenseAcknowledgementStore {
  private readonly values = new Map<string, LicenseAcknowledgement>();

  async load(modelId: string): Promise<LicenseAcknowledgement | null> {
    return this.values.get(modelId) ?? null;
  }

  async save(acknowledgement: LicenseAcknowledgement): Promise<void> {
    this.values.set(acknowledgement.modelId, structuredClone(acknowledgement));
  }
}

class FakeInstaller implements ModelInstallControllerInstaller {
  readonly internalModelPath = "/private/internal/models/model-one.gguf";
  readonly installCalls: ManagedModelInstallInput[] = [];
  readonly probeCalls: ManagedModelProbeInput[] = [];
  readonly cancelCalls: string[] = [];
  readonly events: string[] = [];
  installGate: Deferred<void> | null = null;
  probeGate: Deferred<void> | null = null;
  rejectGateOnCancel = false;
  probeStatusFactory:
    ((input: ManagedModelProbeInput) => ModelInstallStatus) | null = null;
  probeStarted = deferred<void>();
  installStarted = deferred<void>();
  private readonly statuses = new Map<string, ModelInstallStatus>();
  private activeOperationId: string | null = null;

  async install(
    input: ManagedModelInstallInput
  ): Promise<ManagedModelInstallResult> {
    this.installCalls.push(input);
    this.events.push(`install:${input.request.modelId}`);
    this.activeOperationId = input.operationId;
    this.putStatus(statusFor(input.catalog, {
      state: "downloading",
      operationId: input.operationId,
      bytesReceived: 256
    }));
    this.installStarted.resolve();
    this.installStarted = deferred<void>();

    const gate = this.installGate;
    if (gate !== null) {
      await gate.promise;
    }
    this.putStatus(statusFor(input.catalog, {
      state: "installed",
      operationId: input.operationId,
      bytesReceived: artifactFor(input.catalog).downloadBytes
    }));
    this.activeOperationId = null;
    return {
      modelId: input.request.modelId,
      modelPath: this.internalModelPath,
      artifactSha256: artifactFor(input.catalog).sha256,
      downloadBytes: artifactFor(input.catalog).downloadBytes,
      catalogGeneration: input.catalog.body.generation,
      installedAt: fixedNow.toISOString()
    };
  }

  cancel(operationId: string): boolean {
    if (this.activeOperationId !== operationId) {
      return false;
    }
    this.cancelCalls.push(operationId);
    if (this.rejectGateOnCancel && this.installGate !== null) {
      const active = [...this.statuses.values()].find(
        (status) => status.operationId === operationId
      );
      if (active !== undefined) {
        this.putStatus({
          ...active,
          state: "paused",
          operationId: null,
          resumeAvailable: true,
          detail: "Fixture paused status.",
          error: {
            code: "CANCELLED",
            message: "The fixture install was cancelled.",
            retryable: true
          }
        });
      }
      const error = new Error("cancelled");
      error.name = "AbortError";
      this.installGate.reject(error);
      this.installGate = null;
      this.activeOperationId = null;
    }
    return true;
  }

  getStatus(
    modelId: string,
    catalogGeneration?: number,
    artifactSha256?: string
  ): ModelInstallStatus | null {
    if (catalogGeneration === undefined || artifactSha256 === undefined) {
      return [...this.statuses.values()]
        .reverse()
        .find((status) => status.modelId === modelId) ?? null;
    }
    return this.statuses.get(statusKey(
      modelId,
      catalogGeneration,
      artifactSha256
    )) ?? null;
  }

  snapshot(): ManagedModelInstallerSnapshot {
    return {
      downloadLane: {
        activeOperationId: this.activeOperationId,
        queuedOperationIds: []
      },
      statuses: [...this.statuses.values()]
    };
  }

  async probe(input: ManagedModelProbeInput): Promise<ModelInstallStatus> {
    this.probeCalls.push(input);
    this.events.push(`probe:start:${input.modelId}`);
    this.probeStarted.resolve();
    this.probeStarted = deferred<void>();
    const gate = this.probeGate;
    if (gate !== null) {
      await gate.promise;
      this.probeGate = null;
    }
    const status = this.probeStatusFactory?.(input) ?? statusFor(input.catalog, {
      state: "not-installed"
    });
    this.putStatus(status);
    this.events.push(`probe:end:${input.modelId}`);
    return status;
  }

  putStatus(status: ModelInstallStatus): void {
    this.statuses.set(statusKey(
      status.modelId,
      status.catalogGeneration,
      status.artifactSha256
    ), status);
  }
}

function statusFor(
  catalog: SignedModelCatalog,
  overrides: {
    state: ModelInstallState;
    operationId?: string | null;
    bytesReceived?: number;
    resumeAvailable?: boolean;
    error?: ModelInstallStatus["error"];
  }
): ModelInstallStatus {
  const artifact = artifactFor(catalog);
  return {
    modelId: artifact.modelId,
    state: overrides.state,
    operationId: overrides.operationId ?? null,
    catalogGeneration: catalog.body.generation,
    artifactSha256: artifact.sha256,
    bytesReceived: overrides.bytesReceived ?? 0,
    totalBytes: artifact.downloadBytes,
    resumeAvailable: overrides.resumeAvailable ?? false,
    detail: `Fixture ${overrides.state} status.`,
    error: overrides.error ?? null,
    updatedAt: fixedNow.toISOString()
  };
}

function artifactFor(
  catalog: SignedModelCatalog
): SignedModelCatalog["body"]["artifacts"][number] {
  return catalog.body.artifacts[0]!;
}

function statusKey(
  modelId: string,
  generation: number,
  artifactSha256: string
): string {
  return `${modelId}\u0000${generation}\u0000${artifactSha256}`;
}

function makeVerifiedCatalog(
  options: {
    generation?: number;
    artifactSha256?: string;
  } = {}
): SignedModelCatalog {
  const noticeText = "Apache License 2.0\nController fixture notice.\n";
  const artifact: PinnedModelArtifact = {
    artifactVersion: 1,
    modelId: "model-one",
    displayName: "Model One",
    repository: "Qwen/Model-One-GGUF",
    repositoryRevision: "b".repeat(40),
    filename: "model-one-Q4_K_M.gguf",
    downloadUrl: `https://huggingface.co/Qwen/Model-One-GGUF/resolve/${"b".repeat(40)}/model-one-Q4_K_M.gguf`,
    downloadBytes: 4_096,
    sha256: options.artifactSha256 ?? "a".repeat(64),
    eligibleTargets: ["darwin-arm64"],
    license: {
      id: "Apache-2.0",
      name: "Apache License 2.0",
      officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      noticeText,
      noticeVersion: "Apache-2.0-2004",
      noticeSha256: sha256Utf8(noticeText)
    }
  };
  const body: ModelCatalogBody = {
    schemaVersion: 2,
    catalogId: "switchboard-model-catalog",
    generation: options.generation ?? 7,
    issuedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    artifacts: [artifact]
  };
  return verifySignedModelCatalog(signCatalog(body, keys.privateKey), {
    trustRoots: [{ keyId: "controller-test-key", publicKeyPem }],
    minimumGeneration: options.generation ?? 7,
    allowedTargets: new Set(["darwin-arm64"]),
    now: fixedNow
  });
}

function signCatalog(
  body: ModelCatalogBody,
  privateKey: KeyObject
): SignedModelCatalog {
  const unsigned: SignedModelCatalog = {
    keyId: "controller-test-key",
    algorithm: "Ed25519",
    body,
    signature: `${"A".repeat(86)}==`
  };
  return {
    ...unsigned,
    signature: sign(null, catalogSigningBytes(unsigned), privateKey)
      .toString("base64")
  };
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function privilegedKeys(value: unknown): string[] {
  const forbidden = new Set([
    "acknowledgement",
    "catalog",
    "destinationPath",
    "downloadUrl",
    "headers",
    "installedAt",
    "modelPath",
    "officialUrl",
    "runtimeArgs",
    "target"
  ]);
  const found = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.has(key)) {
        found.add(key);
      }
      visit(child);
    }
  };
  visit(value);
  return [...found].sort();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
  throw new Error("Timed out waiting for the deterministic test condition.");
}
