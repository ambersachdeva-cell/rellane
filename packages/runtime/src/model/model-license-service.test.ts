import type {
  LicenseAcceptanceIntent,
  ModelCatalogBody,
  ModelLicenseReview,
  PinnedModelArtifact,
  SignedModelCatalog
} from "@cadrane/contracts";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import {
  catalogSigningBytes,
  verifySignedModelCatalog
} from "./catalog-verifier.js";
import {
  FileLicenseAcknowledgementStore
} from "./license-acknowledgement-store.js";
import { NodeManagedModelFileSystem } from "./model-download-files.js";
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
const baseNotice = "Apache License 2.0\nModel licence fixture notice.\n";
const modelId = "test-model";

let rootDirectory: string;
let currentCatalog: SignedModelCatalog;
let catalogSource: VerifiedModelCatalogSource;

beforeEach(async () => {
  rootDirectory = await mkdtemp(join(tmpdir(), "switchboard-license-store-"));
  currentCatalog = makeVerifiedCatalog();
  catalogSource = {
    currentCatalog: () => currentCatalog
  };
});

afterEach(async () => {
  await rm(rootDirectory, { recursive: true, force: true });
});

describe("model licence service and acknowledgement store", () => {
  it("derives a URL-free review and persists a daemon-timestamped private receipt", async () => {
    const service = makeService();
    const review = await service.review(modelId);

    expect(review).toEqual({
      modelId,
      displayName: "Test model",
      artifactSha256: "a".repeat(64),
      downloadBytes: 1_024,
      sourceHost: "huggingface.co", repository: "Qwen/Test-GGUF",
      catalogGeneration: 7,
      licenseId: "Apache-2.0",
      licenseName: "Apache License 2.0",
      licenseNoticeVersion: "Apache-2.0-2004",
      licenseNoticeSha256: sha256Utf8(baseNotice),
      noticeText: baseNotice,
      acknowledgementCurrent: false
    });

    const acknowledgement = await service.acknowledge(intentFromReview(review));
    expect(acknowledgement.acceptedAt).toBe(fixedNow.toISOString());
    expect(JSON.stringify({ review, acknowledgement })).not.toContain("https://");
    expect(JSON.stringify({ review, acknowledgement })).not.toContain(
      rootDirectory
    );

    const path = acknowledgementPath();
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      acknowledgement: { acceptedAt: string };
    };
    expect(saved.acknowledgement.acceptedAt).toBe(fixedNow.toISOString());
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(rootDirectory, "license-acknowledgements"))).mode & 0o777)
        .toBe(0o700);
    }
  });

  it("reloads only the exact current acknowledgement after restart", async () => {
    const service = makeService();
    const acknowledgement = await service.acknowledge(
      intentFromReview(await service.review(modelId))
    );

    const restarted = makeService();
    await expect(restarted.currentAcknowledgement(modelId))
      .resolves.toEqual(acknowledgement);
    await expect(restarted.review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: true
    });

    currentCatalog = makeVerifiedCatalog({
      artifactSha256: "d".repeat(64)
    });
    await expect(restarted.currentAcknowledgement(modelId)).resolves.toBeNull();
    await expect(restarted.review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: false
    });

    currentCatalog = makeVerifiedCatalog({
      noticeText: `${baseNotice}Updated.\n`
    });
    await expect(restarted.currentAcknowledgement(modelId)).resolves.toBeNull();
    await expect(restarted.review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: false
    });

    currentCatalog = makeVerifiedCatalog({ generation: 8 });
    await expect(restarted.currentAcknowledgement(modelId)).resolves.toBeNull();
    await expect(restarted.review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: false
    });

    currentCatalog = makeVerifiedCatalog();
    await expect(restarted.currentAcknowledgement(modelId))
      .resolves.toEqual(acknowledgement);
    await expect(restarted.review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: true
    });
  });

  it("rejects stale renderer acceptance fields without storing a receipt", async () => {
    const service = makeService();
    const review = await service.review(modelId);
    await expectRuntimeCode(service.acknowledge({
      ...intentFromReview(review),
      artifactSha256: "f".repeat(64)
    }), "LICENSE_REQUIRED");
    await expect(service.currentAcknowledgement(modelId)).resolves.toBeNull();
  });

  it("resolves reviews only from a catalog verified in this process", async () => {
    currentCatalog = structuredClone(currentCatalog);
    await expectRuntimeCode(
      makeService().review(modelId),
      "CATALOG_INVALID"
    );
  });

  it("fails closed on corrupted acknowledgement JSON", async () => {
    const store = makeStore();
    await expect(store.load(modelId)).resolves.toBeNull();
    await writeFile(acknowledgementPath(), "{broken", { mode: 0o600 });
    await expect(store.load(modelId)).resolves.toBeNull();
    await expect(makeService().review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: false
    });

    await writeFile(acknowledgementPath(), JSON.stringify({
      schemaVersion: 1,
      acknowledgement: {
        acknowledgementVersion: 1,
        modelId,
        artifactSha256: "a".repeat(64),
        licenseNoticeVersion: "Apache-2.0-2004",
        licenseNoticeSha256: sha256Utf8(baseNotice),
        catalogGeneration: 7,
        acceptedAt: fixedNow.toISOString(),
        modelPath: "/tmp/model.gguf"
      }
    }), { mode: 0o600 });
    await expect(store.load(modelId)).resolves.toBeNull();
    await expect(makeService().review(modelId)).resolves.toMatchObject({
      acknowledgementCurrent: false
    });
  });

  it("rejects symlink and hardlink acknowledgement aliases", async () => {
    const store = makeStore();
    await expect(store.load(modelId)).resolves.toBeNull();
    const outside = join(rootDirectory, "outside.json");
    await writeFile(outside, "{}", { mode: 0o600 });

    await symlink(outside, acknowledgementPath());
    await expectRuntimeCode(store.load(modelId), "SECURITY_BOUNDARY");
    await expectRuntimeCode(makeService().review(modelId), "SECURITY_BOUNDARY");
    await unlink(acknowledgementPath());

    await link(outside, acknowledgementPath());
    await expectRuntimeCode(store.load(modelId), "SECURITY_BOUNDARY");
    await expectRuntimeCode(makeService().review(modelId), "SECURITY_BOUNDARY");
  });

  it("preserves the last durable receipt when an injected atomic replace fails", async () => {
    const service = makeService();
    const first = await service.acknowledge(
      intentFromReview(await service.review(modelId))
    );

    const failingService = new ModelLicenseService({
      catalogSource,
      store: new FileLicenseAcknowledgementStore({
        rootDirectory,
        fileSystem: new FailingReplaceFileSystem()
      }),
      now: () => new Date("2026-08-02T00:00:00.000Z")
    });
    await expectRuntimeCode(failingService.acknowledge(
      intentFromReview(await failingService.review(modelId))
    ), "STORAGE_UNAVAILABLE");

    await expect(makeService().currentAcknowledgement(modelId))
      .resolves.toEqual(first);
  });

  it("does not persist a receipt when the injected clock is invalid", async () => {
    const service = new ModelLicenseService({
      catalogSource,
      store: makeStore(),
      now: () => new Date(Number.NaN)
    });
    await expectRuntimeCode(service.acknowledge(
      intentFromReview(await service.review(modelId))
    ), "STORAGE_UNAVAILABLE");
    await expect(service.currentAcknowledgement(modelId)).resolves.toBeNull();
  });

  it("rejects a relative persistence root", () => {
    expect(() => new FileLicenseAcknowledgementStore({
      rootDirectory: "relative/model-store"
    })).toThrowError(expect.objectContaining({
      detail: expect.objectContaining({ code: "SECURITY_BOUNDARY" })
    }));
  });
});

function makeService(): ModelLicenseService {
  return new ModelLicenseService({
    catalogSource,
    store: makeStore(),
    now: () => fixedNow
  });
}

function makeStore(): FileLicenseAcknowledgementStore {
  return new FileLicenseAcknowledgementStore({ rootDirectory });
}

function acknowledgementPath(): string {
  return join(
    rootDirectory,
    "license-acknowledgements",
    `${sha256Utf8(modelId)}.license-ack.json`
  );
}

function intentFromReview(review: ModelLicenseReview): LicenseAcceptanceIntent {
  return {
    modelId: review.modelId,
    artifactSha256: review.artifactSha256,
    catalogGeneration: review.catalogGeneration,
    licenseNoticeVersion: review.licenseNoticeVersion,
    licenseNoticeSha256: review.licenseNoticeSha256,
    accepted: true
  };
}

function makeVerifiedCatalog(
  options: {
    generation?: number;
    artifactSha256?: string;
    noticeText?: string;
  } = {}
): SignedModelCatalog {
  const noticeText = options.noticeText ?? baseNotice;
  const artifact: PinnedModelArtifact = {
    artifactVersion: 1,
    modelId,
    displayName: "Test model",
    repository: "Qwen/Test-GGUF",
    repositoryRevision: "b".repeat(40),
    filename: "test-Q4_K_M.gguf",
    downloadUrl: `https://huggingface.co/Qwen/Test-GGUF/resolve/${"b".repeat(40)}/test-Q4_K_M.gguf`,
    downloadBytes: 1_024,
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
    trustRoots: [{ keyId: "test-key", publicKeyPem }],
    minimumGeneration: 7,
    allowedTargets: new Set(["darwin-arm64"]),
    now: fixedNow
  });
}

function signCatalog(
  body: ModelCatalogBody,
  privateKey: KeyObject
): SignedModelCatalog {
  const unsigned: SignedModelCatalog = {
    keyId: "test-key",
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

async function expectRuntimeCode(
  promise: Promise<unknown>,
  code: RuntimeBoundaryError["detail"]["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeBoundaryError);
    expect((error as RuntimeBoundaryError).detail.code).toBe(code);
  }
}

class FailingReplaceFileSystem extends NodeManagedModelFileSystem {
  override async replacePrivateFile(
    _path: string,
    _temporaryPath: string,
    _content: string
  ): Promise<void> {
    throw new RuntimeBoundaryError({
      code: "STORAGE_UNAVAILABLE",
      message: "Simulated atomic replacement failure.",
      retryable: true
    });
  }
}
