import type {
  LicenseAcknowledgement,
  ModelCatalogBody,
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
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import { assertProcessVerifiedManagedModel } from "../managed-runtime/promoted-model-provenance.js";
import {
  catalogSigningBytes,
  verifySignedModelCatalog
} from "./catalog-verifier.js";
import {
  deriveManagedModelPaths,
  ManagedModelInstaller,
  managedCatalogDigest
} from "./managed-model-store.js";
import {
  NodeManagedModelFileSystem,
  type ManagedModelReadHandle,
  type ManagedModelWritableFile,
  UnsafeManagedModelHardlinkError
} from "./model-download-files.js";
import type {
  ModelDownloadHttpRequest,
  ModelDownloadHttpResponse,
  ModelDownloadTransport
} from "./model-download-network.js";

const keyPair = generateKeyPairSync("ed25519");
const publicKeyPem = keyPair.publicKey.export({
  type: "spki",
  format: "pem"
}).toString();
const fixedNow = new Date("2026-08-01T00:00:00.000Z");
const sourceUrl = "https://huggingface.co/Qwen/Test-GGUF/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/test.gguf";
const licenseNoticeText = "Apache License 2.0\nManaged model fixture notice.\n";
const operationIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003"
] as const;

let rootDirectory: string;

beforeEach(async () => {
  rootDirectory = await mkdtemp(join(tmpdir(), "switchboard-model-store-"));
});

afterEach(async () => {
  await rm(rootDirectory, { recursive: true, force: true });
});

describe("managed model installer", () => {
  it("installs a fresh artifact after stable-handle GGUF and digest verification", async () => {
    const payload = ggufPayload("verified-model-bytes");
    const fixture = createFixture(payload);
    const statuses: ModelInstallStatus[] = [];
    let disposed = 0;
    const transport = new ScriptedTransport([
      (request) => ({
        ...response(request.url, 200, [payload.subarray(0, 8), payload.subarray(8)], {
          "content-length": String(payload.byteLength)
        }),
        dispose: async () => {
          disposed += 1;
        }
      })
    ]);
    const installer = createInstaller(transport);

    const result = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64",
      onStatus: (status) => statuses.push(status)
    });

    expect(await readFile(result.modelPath)).toEqual(payload);
    expect(result.artifactSha256).toBe(sha256(payload));
    expect(transport.requests[0]?.headers["accept-encoding"]).toBe("identity");
    expect(disposed).toBe(1);
    expect(statuses.map((status) => status.state)).toEqual([
      "queued",
      "downloading",
      "downloading",
      "downloading",
      "verifying",
      "verifying",
      "installed"
    ]);
    expect(statuses.filter((status) => status.state === "verifying").at(-1))
      .toMatchObject({ operationId: null, resumeAvailable: false });
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "installed",
      resumeAvailable: false,
      error: null
    });
  });

  it("resumes only an exact metadata-bound partial with an exact 206 range", async () => {
    const payload = ggufPayload("resume-this-model");
    const fixture = createFixture(payload);
    const splitAt = 6;
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ], { "content-length": String(payload.byteLength) })
    ]);
    const installer = createInstaller(transport);
    await createCancelledPartial(installer, fixture, splitAt);

    transport.push((request) => {
      expect(request.headers["range"]).toBe(`bytes=${splitAt}-`);
      return response(request.url, 206, [payload.subarray(splitAt)], {
        "content-range": `bytes ${splitAt}-${payload.byteLength - 1}/${payload.byteLength}`,
        "content-length": String(payload.byteLength - splitAt)
      });
    });
    const result = await installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });

    expect(await readFile(result.modelPath)).toEqual(payload);
    expect(transport.requests).toHaveLength(2);
  });

  it("discards a mismatched 206 and retries exactly once as a fresh request", async () => {
    const payload = ggufPayload("retry-invalid-content-range");
    const fixture = createFixture(payload);
    const splitAt = 8;
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ], { "content-length": String(payload.byteLength) })
    ]);
    const installer = createInstaller(transport);
    await createCancelledPartial(installer, fixture, splitAt);

    let mismatchedResponseDisposed = false;
    transport.push((request) => {
      expect(request.headers["range"]).toBe(`bytes=${splitAt}-`);
      return {
        ...response(request.url, 206, [payload.subarray(splitAt)], {
          "content-range": `bytes ${splitAt + 1}-${payload.byteLength - 1}/${payload.byteLength}`
        }),
        dispose: async () => {
          mismatchedResponseDisposed = true;
        }
      };
    });
    transport.push((request) => {
      expect(request.headers["range"]).toBeUndefined();
      return response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      });
    });

    const result = await installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    expect(await readFile(result.modelPath)).toEqual(payload);
    expect(transport.requests).toHaveLength(3);
    expect(mismatchedResponseDisposed).toBe(true);
  });

  it("disposes both responses when the one allowed fresh retry is invalid", async () => {
    const payload = ggufPayload("retry-invalid-fresh-response");
    const fixture = createFixture(payload);
    const splitAt = 8;
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ])
    ]);
    const installer = createInstaller(transport);
    await createCancelledPartial(installer, fixture, splitAt);

    let disposed = 0;
    transport.push((request) => ({
      ...response(request.url, 206, [payload.subarray(splitAt)], {
        "content-range": `bytes ${splitAt + 1}-${payload.byteLength - 1}/${payload.byteLength}`
      }),
      dispose: async () => {
        disposed += 1;
      }
    }));
    transport.push((request) => ({
      ...response(request.url, 500, []),
      dispose: async () => {
        disposed += 1;
      }
    }));

    await expectRuntimeCode(installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "DOWNLOAD_FAILED");
    expect(transport.requests).toHaveLength(3);
    expect(disposed).toBe(2);
  });

  it.each(["open", "write", "body"] as const)(
    "disposes an accepted response when stream %s fails",
    async (failureMode) => {
      const payload = ggufPayload(`dispose-${failureMode}-failure`);
      const fixture = createFixture(payload);
      let disposed = 0;
      const baseResponse = response(sourceUrl, 200, [payload]);
      const acceptedResponse: ModelDownloadHttpResponse = {
        ...baseResponse,
        ...(failureMode === "body"
          ? {
              body: (async function* () {
                throw new Error("simulated response-body failure");
              })()
            }
          : {}),
        dispose: async () => {
          disposed += 1;
        }
      };
      const installer = new ManagedModelInstaller({
        rootDirectory,
        fileSystem: new StreamFailureManagedModelFileSystem(failureMode),
        transport: new ScriptedTransport([() => acceptedResponse]),
        now: () => fixedNow
      });

      await expectRuntimeCode(installer.install({
        operationId: operationIds[0],
        catalog: fixture.catalog,
        request: fixture.request,
        target: "darwin-arm64"
      }), failureMode === "body" ? "DOWNLOAD_FAILED" : "STORAGE_UNAVAILABLE");
      expect(disposed).toBe(1);
    }
  );

  it("discards a metadata-mismatched partial and starts clean without Range", async () => {
    const payload = ggufPayload("metadata-binding");
    const fixture = createFixture(payload);
    const splitAt = 5;
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ], { "content-length": String(payload.byteLength) })
    ]);
    const installer = createInstaller(transport);
    await createCancelledPartial(installer, fixture, splitAt);

    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    await writeFile(paths.metadataPath, JSON.stringify({ schemaVersion: 1, modelId: "other" }));
    transport.push((request) => {
      expect(request.headers["range"]).toBeUndefined();
      return response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      });
    });

    const result = await installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    expect(await readFile(result.modelPath)).toEqual(payload);
  });

  it("restarts from byte zero when the server ignores a valid Range request", async () => {
    const payload = ggufPayload("range-can-restart");
    const fixture = createFixture(payload);
    const splitAt = 4;
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ], { "content-length": String(payload.byteLength) })
    ]);
    const installer = createInstaller(transport);
    await createCancelledPartial(installer, fixture, splitAt);

    transport.push((request) => {
      expect(request.headers["range"]).toBe(`bytes=${splitAt}-`);
      return response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      });
    });
    const result = await installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });

    expect(await readFile(result.modelPath)).toEqual(payload);
  });

  it("keeps a short download resumable and exposes a structured paused status", async () => {
    const payload = ggufPayload("short-response");
    const fixture = createFixture(payload);
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [payload.subarray(0, 5)])
    ]);
    const installer = createInstaller(transport);

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "DOWNLOAD_FAILED");
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "paused",
      bytesReceived: 5,
      resumeAvailable: true,
      error: {
        code: "DOWNLOAD_FAILED",
        retryable: true
      }
    });
  });

  it("quarantines an oversized response instead of making it loadable", async () => {
    const payload = ggufPayload("exact-size");
    const oversizedPayload = Buffer.concat([payload, Buffer.from("!")]);
    const fixture = createFixture(payload);
    let disposed = 0;
    const transport = new ScriptedTransport([
      (request) => ({
        ...response(request.url, 200, [oversizedPayload]),
        dispose: async () => {
          disposed += 1;
        }
      })
    ]);
    const installer = createInstaller(transport);

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");

    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const quarantined = await readdir(paths.quarantineDirectory);
    expect(quarantined.some((name) => name.endsWith(".gguf"))).toBe(true);
    expect(quarantined.some((name) => name.endsWith(".gguf.json"))).toBe(true);
    const receiptName = quarantined.find((name) => name.endsWith(".gguf.json"));
    expect(receiptName).toBeDefined();
    const receipt = JSON.parse(await readFile(
      join(paths.quarantineDirectory, receiptName!),
      "utf8"
    )) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      expectedBytes: payload.byteLength,
      expectedSha256: fixture.artifact.sha256,
      quarantinedBytes: payload.byteLength,
      quarantinedSha256: sha256(payload),
      observedStreamStartOffset: 0,
      observedStreamBytesAtLeast: oversizedPayload.byteLength,
      observedStreamPrefixSha256: sha256(oversizedPayload),
      streamObservationComplete: false
    });
    const artifactName = quarantined.find((name) => name.endsWith(".gguf"));
    expect(artifactName).toBeDefined();
    expect((await readFile(
      join(paths.quarantineDirectory, artifactName!)
    )).byteLength).toBe(payload.byteLength);
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "quarantined",
      resumeAvailable: false,
      error: { code: "INTEGRITY_FAILED" }
    });
    expect(disposed).toBe(1);
  });

  it("quarantines an exact-size SHA-256 mismatch", async () => {
    const payload = ggufPayload("expected-bytes");
    const wrongPayload = Buffer.from(payload);
    const lastIndex = wrongPayload.byteLength - 1;
    wrongPayload.writeUInt8(wrongPayload.readUInt8(lastIndex) ^ 0xff, lastIndex);
    expect(wrongPayload.byteLength).toBe(payload.byteLength);
    const fixture = createFixture(payload);
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [wrongPayload], {
        "content-length": String(wrongPayload.byteLength)
      })
    ]);
    const installer = createInstaller(transport);

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    expect(installer.getStatus(fixture.artifact.modelId)?.state).toBe("quarantined");
  });

  it("cancels safely, records resumability, and leaves the partial for a later install", async () => {
    const payload = ggufPayload("cancel-and-resume");
    const fixture = createFixture(payload);
    const splitAt = 7;
    let disposed = 0;
    const transport = new ScriptedTransport([
      (request) => ({
        ...response(request.url, 200, [
          payload.subarray(0, splitAt),
          payload.subarray(splitAt)
        ], { "content-length": String(payload.byteLength) }),
        dispose: async () => {
          disposed += 1;
        }
      })
    ]);
    const installer = createInstaller(transport);

    await createCancelledPartial(installer, fixture, splitAt);
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const metadata = JSON.parse(
      await readFile(paths.metadataPath, "utf8")
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schemaVersion: 2,
      repositoryRevision: fixture.artifact.repositoryRevision,
      filename: fixture.artifact.filename,
      completedBytes: splitAt
    });
    expect(installer.snapshot()).toMatchObject({
      downloadLane: {
        activeOperationId: null,
        queuedOperationIds: []
      },
      statuses: [{
        state: "paused",
        operationId: null,
        bytesReceived: splitAt,
        resumeAvailable: true,
        error: { code: "CANCELLED", retryable: true }
      }]
    });
    expect(disposed).toBe(1);
  });

  it("probes durable paused state across installer restart without network access", async () => {
    const payload = ggufPayload("restart-paused");
    const fixture = createFixture(payload);
    const splitAt = 9;
    const firstTransport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ])
    ]);
    await createCancelledPartial(
      createInstaller(firstTransport),
      fixture,
      splitAt
    );

    const restartedTransport = new ScriptedTransport([]);
    const status = await createInstaller(restartedTransport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "paused",
      operationId: null,
      bytesReceived: splitAt,
      resumeAvailable: true
    });
    expect(restartedTransport.requests).toHaveLength(0);
  });

  it("probes a stably verified installed model across installer restart", async () => {
    const payload = ggufPayload("restart-installed");
    const fixture = createFixture(payload);
    await createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload])
    ])).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });

    const restartedTransport = new ScriptedTransport([]);
    const status = await createInstaller(restartedTransport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "installed",
      operationId: null,
      artifactSha256: fixture.artifact.sha256,
      resumeAvailable: false
    });
    expect(restartedTransport.requests).toHaveLength(0);
  });

  it("reserves a model synchronously when probe wins the probe/install race", async () => {
    const fixture = createFixture(ggufPayload("probe-wins-reservation"));
    const fileSystem = new FirstDirectoryGateFileSystem();
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem,
      transport: new ScriptedTransport([]),
      now: () => fixedNow
    });

    const probe = installer.probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    await fileSystem.started;
    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "BAD_REQUEST");
    fileSystem.release();
    await expect(probe).resolves.toMatchObject({ state: "not-installed" });
    await expect(installer.probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    })).resolves.toMatchObject({ state: "not-installed" });
  });

  it("reserves a model synchronously when install wins the install/probe race", async () => {
    const payload = ggufPayload("install-wins-reservation");
    const fixture = createFixture(payload);
    const fileSystem = new FirstDirectoryGateFileSystem();
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem,
      transport: new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ]),
      now: () => fixedNow
    });

    const install = installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    await fileSystem.started;
    await expectRuntimeCode(installer.probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }), "BAD_REQUEST");
    fileSystem.release();
    await expect(install).resolves.toMatchObject({
      artifactSha256: fixture.artifact.sha256
    });
    await expect(installer.probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    })).resolves.toMatchObject({ state: "installed" });
  });

  it("rejects a duplicate artifact job even when it uses another operation ID", async () => {
    const payload = ggufPayload("one-download-lane");
    const fixture = createFixture(payload);
    let releaseSecondChunk!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const transport = new ScriptedTransport([
      (request) => ({
        ...response(request.url, 200, []),
        body: (async function* () {
          requestStarted();
          yield payload.subarray(0, 1);
          await waitForRelease;
          yield payload.subarray(1);
        })()
      })
    ]);
    const installer = createInstaller(transport);
    const first = installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    await started;

    const nextGeneration = createFixture(
      ggufPayload("next-generation"),
      { generation: 5 }
    );
    await expectRuntimeCode(installer.install({
      operationId: operationIds[1],
      catalog: nextGeneration.catalog,
      request: nextGeneration.request,
      target: "darwin-arm64"
    }), "BAD_REQUEST");
    const otherModel = createFixture(
      ggufPayload("other-model"),
      { modelId: "other-model" }
    );
    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: otherModel.catalog,
      request: otherModel.request,
      target: "darwin-arm64"
    }), "BAD_REQUEST");
    expect(installer.cancel(operationIds[0])).toBe(true);
    releaseSecondChunk();
    await expectRuntimeCode(first, "CANCELLED");
  });

  it("keeps status truth separate across artifact generations", async () => {
    const firstFixture = createFixture(ggufPayload("generation-four"));
    const secondFixture = createFixture(
      ggufPayload("generation-five"),
      { generation: 5 }
    );
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [firstFixture.payload]),
      (request) => response(request.url, 200, [secondFixture.payload])
    ]);
    const installer = createInstaller(transport);
    await installer.install({
      operationId: operationIds[0],
      catalog: firstFixture.catalog,
      request: firstFixture.request,
      target: "darwin-arm64"
    });
    await installer.install({
      operationId: operationIds[1],
      catalog: secondFixture.catalog,
      request: secondFixture.request,
      target: "darwin-arm64"
    });
    await installer.install({
      operationId: operationIds[2],
      catalog: firstFixture.catalog,
      request: firstFixture.request,
      target: "darwin-arm64"
    });

    expect(installer.getStatus(
      firstFixture.artifact.modelId,
      4,
      firstFixture.artifact.sha256
    )?.state).toBe("installed");
    expect(installer.getStatus(
      secondFixture.artifact.modelId,
      5,
      secondFixture.artifact.sha256
    )?.state).toBe("installed");
    expect(installer.snapshot().statuses.filter(
      (status) => status.modelId === firstFixture.artifact.modelId
    )).toHaveLength(2);
    expect(installer.getStatus(firstFixture.artifact.modelId)).toMatchObject({
      catalogGeneration: 4,
      artifactSha256: firstFixture.artifact.sha256,
      state: "installed"
    });
  });

  it("rejects a symlinked managed-store ancestor before network access", async () => {
    const fixture = createFixture(ggufPayload("never-download"));
    const outside = join(rootDirectory, "outside");
    await mkdir(outside);
    await symlink(outside, join(rootDirectory, "models"), "dir");
    const transport = new ScriptedTransport([]);

    await expectRuntimeCode(createInstaller(transport).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "SECURITY_BOUNDARY");
    expect(transport.requests).toHaveLength(0);
  });

  it("detects a same-length staging path swap across the commit boundary", async () => {
    const payload = ggufPayload("stable-original");
    const replacement = Buffer.from(payload);
    const lastIndex = replacement.byteLength - 1;
    replacement.writeUInt8(replacement.readUInt8(lastIndex) ^ 0xff, lastIndex);
    const fixture = createFixture(payload);
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [payload])
    ]);
    const installer = new ManagedModelInstaller({
      rootDirectory,
      transport,
      now: () => fixedNow,
      uniqueId: () => "stable-swap",
      onCommitStarted: async ({ stagingPath }) => {
        const replacementPath = `${stagingPath}.replacement`;
        await writeFile(replacementPath, replacement);
        await rename(replacementPath, stagingPath);
      }
    });

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    expect(installer.getStatus(fixture.artifact.modelId)?.state).toBe("quarantined");
  });

  it("reopens and fully verifies an existing managed path at commit", async () => {
    const payload = ggufPayload("stable-existing");
    const replacement = Buffer.from(payload);
    const lastIndex = replacement.byteLength - 1;
    replacement.writeUInt8(replacement.readUInt8(lastIndex) ^ 0xff, lastIndex);
    const fixture = createFixture(payload);
    await createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload])
    ])).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });

    const installer = new ManagedModelInstaller({
      rootDirectory,
      transport: new ScriptedTransport([]),
      now: () => fixedNow,
      uniqueId: () => "existing-swap",
      onCommitStarted: async ({ destinationPath }) => {
        const replacementPath = `${destinationPath}.replacement`;
        await writeFile(replacementPath, replacement);
        await rename(replacementPath, destinationPath);
      }
    });
    await expectRuntimeCode(installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    expect(installer.getStatus(fixture.artifact.modelId)?.state).toBe("quarantined");
  });

  it("durably revokes a staged commit hardlink while preserving its outside alias", async () => {
    const payload = ggufPayload("staged-hardlink-race");
    const fixture = createFixture(payload);
    const outsideAlias = join(rootDirectory, "outside-staged-alias.gguf");
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: new DeferredHardlinkUnlinkFileSystem(),
      transport: new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ]),
      now: () => fixedNow,
      uniqueId: () => "staged-hardlink",
      onCommitStarted: async ({ stagingPath }) => {
        await link(stagingPath, outsideAlias);
      }
    });

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "STORAGE_UNAVAILABLE");
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    expect(await readFile(outsideAlias)).toEqual(payload);
    expect((await stat(outsideAlias)).nlink).toBe(2);
    expect(await readFile(paths.modelPath)).toEqual(payload);
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });

    const restartedTransport = new ScriptedTransport([]);
    const status = await createInstaller(restartedTransport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
    await expect(readFile(paths.modelPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outsideAlias)).toEqual(payload);
    expect((await stat(outsideAlias)).nlink).toBe(1);
    expect(restartedTransport.requests).toHaveLength(0);
  });

  it("durably revokes an existing commit hardlink while preserving its outside alias", async () => {
    const payload = ggufPayload("existing-hardlink-race");
    const fixture = createFixture(payload);
    await createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload])
    ])).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const outsideAlias = join(rootDirectory, "outside-existing-alias.gguf");
    const installer = new ManagedModelInstaller({
      rootDirectory,
      transport: new ScriptedTransport([]),
      now: () => fixedNow,
      uniqueId: () => "existing-hardlink",
      onCommitStarted: async ({ destinationPath }) => {
        await link(destinationPath, outsideAlias);
      }
    });

    await expectRuntimeCode(installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    expect(await readFile(outsideAlias)).toEqual(payload);
    expect((await stat(outsideAlias)).nlink).toBe(1);
    await expect(readFile(paths.modelPath)).rejects.toMatchObject({ code: "ENOENT" });

    const restartedTransport = new ScriptedTransport([]);
    const status = await createInstaller(restartedTransport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
    expect(await readFile(outsideAlias)).toEqual(payload);
    expect(restartedTransport.requests).toHaveLength(0);
  });

  it("revokes a pre-existing installed hardlink on a fresh probe without network", async () => {
    const payload = ggufPayload("startup-installed-hardlink");
    const fixture = createFixture(payload);
    await createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload])
    ])).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const outsideAlias = join(rootDirectory, "startup-installed-alias.gguf");
    await link(paths.modelPath, outsideAlias);

    const transport = new ScriptedTransport([]);
    const status = await createInstaller(transport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
    expect(transport.requests).toHaveLength(0);
    await expect(readFile(paths.modelPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outsideAlias)).toEqual(payload);
    expect((await stat(outsideAlias)).nlink).toBe(1);
    await expectQuarantinedAcrossTwoRestarts(fixture);
  });

  it("revokes a pre-existing full staged hardlink on a fresh probe without network", async () => {
    const payload = ggufPayload("startup-full-staged-hardlink");
    const fixture = createFixture(payload);
    await createCancelledPartial(
      createInstaller(new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ])),
      fixture,
      payload.byteLength
    );
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const outsideAlias = join(rootDirectory, "startup-full-staged-alias.gguf");
    await link(paths.partialPath, outsideAlias);

    const transport = new ScriptedTransport([]);
    const status = await createInstaller(transport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
    expect(transport.requests).toHaveLength(0);
    await expect(readFile(paths.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outsideAlias)).toEqual(payload);
    expect((await stat(outsideAlias)).nlink).toBe(1);
    await expectQuarantinedAcrossTwoRestarts(fixture);
  });

  it("revokes a pre-existing partial hardlink on a fresh install without network", async () => {
    const payload = ggufPayload("startup-partial-staged-hardlink");
    const fixture = createFixture(payload);
    const splitAt = 9;
    await createCancelledPartial(
      createInstaller(new ScriptedTransport([
        (request) => response(request.url, 200, [
          payload.subarray(0, splitAt),
          payload.subarray(splitAt)
        ])
      ])),
      fixture,
      splitAt
    );
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const outsideAlias = join(rootDirectory, "startup-partial-staged-alias.gguf");
    await link(paths.partialPath, outsideAlias);

    const transport = new ScriptedTransport([]);
    const installer = createInstaller(transport);
    await expectRuntimeCode(installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
    expect(transport.requests).toHaveLength(0);
    await expect(readFile(paths.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(outsideAlias)).toEqual(payload.subarray(0, splitAt));
    expect((await stat(outsideAlias)).nlink).toBe(1);
    await expectQuarantinedAcrossTwoRestarts(fixture);
  });

  it("closes cancellation at the explicit commit boundary", async () => {
    const payload = ggufPayload("commit-cannot-cancel");
    const fixture = createFixture(payload);
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [payload])
    ]);
    let cancellationResult: boolean | null = null;
    let installer!: ManagedModelInstaller;
    installer = new ManagedModelInstaller({
      rootDirectory,
      transport,
      now: () => fixedNow,
      onCommitStarted: () => {
        cancellationResult = installer.cancel(operationIds[0]);
      }
    });

    const result = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    expect(cancellationResult).toBe(false);
    expect(await readFile(result.modelPath)).toEqual(payload);
    expect(installer.cancel(operationIds[0])).toBe(false);
  });

  it("quarantines a digest-correct artifact that is not bounded GGUF v3", async () => {
    const invalidPayload = Buffer.alloc(32, 0x41);
    const fixture = createFixture(invalidPayload);
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [invalidPayload])
    ]);
    const installer = createInstaller(transport);

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    expect(installer.getStatus(fixture.artifact.modelId)?.state).toBe("quarantined");
  });

  it("truncates bytes beyond the last durable checkpoint before resuming", async () => {
    const payload = ggufPayload("truncate-to-checkpoint");
    const fixture = createFixture(payload);
    const splitAt = 8;
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [
        payload.subarray(0, splitAt),
        payload.subarray(splitAt)
      ])
    ]);
    const installer = createInstaller(transport);
    await createCancelledPartial(installer, fixture, splitAt);
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    await appendFile(paths.partialPath, Buffer.from("unsynced-tail"));

    transport.push((request) => {
      expect(request.headers["range"]).toBe(`bytes=${splitAt}-`);
      return response(request.url, 206, [payload.subarray(splitAt)], {
        "content-range": `bytes ${splitAt}-${payload.byteLength - 1}/${payload.byteLength}`
      });
    });
    const result = await installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    expect(await readFile(result.modelPath)).toEqual(payload);
  });

  it("reconciles pending quarantine evidence and revokes the same pin across restart", async () => {
    const payload = ggufPayload("quarantine-recovery");
    const quarantinedPayload = Buffer.from(payload);
    quarantinedPayload.writeUInt8(
      quarantinedPayload.readUInt8(quarantinedPayload.byteLength - 1) ^ 0xff,
      quarantinedPayload.byteLength - 1
    );
    const fixture = createFixture(payload);
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    await mkdir(paths.quarantineDirectory, { recursive: true });
    await mkdir(paths.stagingDirectory, { recursive: true });
    const quarantinePath = join(
      paths.quarantineDirectory,
      `${fixture.artifact.sha256}.${operationIds[0]}.crash.gguf`
    );
    const receiptPath = `${quarantinePath}.json`;
    await writeFile(quarantinePath, quarantinedPayload);
    await writeFile(receiptPath, JSON.stringify({
      schemaVersion: 2,
      state: "pending-quarantine-evidence",
      sourceKind: "staging",
      reason: "Interrupted quarantine.",
      quarantinedAt: fixedNow.toISOString()
    }));

    const transport = new ScriptedTransport([]);
    const installer = createInstaller(transport);
    await expectRuntimeCode(installer.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "INTEGRITY_FAILED");
    expect(transport.requests).toHaveLength(0);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      state: "quarantined",
      quarantinedBytes: quarantinedPayload.byteLength,
      quarantinedSha256: sha256(quarantinedPayload)
    });

    const restartedTransport = new ScriptedTransport([]);
    const restartedStatus = await createInstaller(restartedTransport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(restartedStatus).toMatchObject({
      state: "quarantined",
      operationId: null,
      artifactSha256: fixture.artifact.sha256
    });
    expect(restartedTransport.requests).toHaveLength(0);
  });

  it("finishes a pending managed-file quarantine before probing installed state", async () => {
    const payload = ggufPayload("pending-managed-quarantine");
    const invalid = Buffer.from(payload);
    invalid.writeUInt8(
      invalid.readUInt8(invalid.byteLength - 1) ^ 0xff,
      invalid.byteLength - 1
    );
    const fixture = createFixture(payload);
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    await mkdir(paths.modelDirectory, { recursive: true });
    await mkdir(paths.quarantineDirectory, { recursive: true });
    await mkdir(paths.stagingDirectory, { recursive: true });
    await writeFile(paths.modelPath, invalid);
    const quarantinePath = join(
      paths.quarantineDirectory,
      `${fixture.artifact.sha256}.${operationIds[0]}.pending.gguf`
    );
    const receiptPath = `${quarantinePath}.json`;
    await writeFile(receiptPath, JSON.stringify({
      schemaVersion: 2,
      state: "pending-quarantine-evidence",
      sourceKind: "managed",
      reason: "Interrupted managed-file quarantine.",
      quarantinedAt: fixedNow.toISOString()
    }));

    const status = await createInstaller(new ScriptedTransport([])).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status.state).toBe("quarantined");
    await expect(readFile(paths.modelPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(quarantinePath)).toEqual(invalid);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      state: "quarantined",
      quarantinedBytes: invalid.byteLength,
      quarantinedSha256: sha256(invalid)
    });
  });

  it("preserves pending evidence when a quarantine destination cannot be reserved", async () => {
    const payload = Buffer.alloc(32, 0x41);
    const fixture = createFixture(payload);
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: new RefusedMoveManagedModelFileSystem(),
      transport: new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ]),
      now: () => fixedNow,
      uniqueId: () => "refused-move"
    });

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "STORAGE_UNAVAILABLE");
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false,
      error: { code: "INTEGRITY_FAILED" }
    });
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const receiptName = (await readdir(paths.quarantineDirectory)).find(
      (name) => name.endsWith(".gguf.json")
    );
    expect(receiptName).toBeDefined();
    expect(JSON.parse(await readFile(
      join(paths.quarantineDirectory, receiptName!),
      "utf8"
    ))).toMatchObject({ state: "pending-quarantine-evidence" });

    const status = await createInstaller(new ScriptedTransport([])).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status.state).toBe("quarantined");
  });

  it("keeps durable quarantined status when final receipt replacement fails", async () => {
    const payload = Buffer.alloc(32, 0x41);
    const fixture = createFixture(payload);
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: new FinalizeReceiptFailureFileSystem(),
      transport: new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ]),
      now: () => fixedNow,
      uniqueId: () => "finalize-failure"
    });

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "STORAGE_UNAVAILABLE");
    expect(installer.getStatus(fixture.artifact.modelId)).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false,
      error: { code: "INTEGRITY_FAILED" }
    });
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    const receiptName = (await readdir(paths.quarantineDirectory)).find(
      (name) => name.endsWith(".gguf.json")
    );
    expect(receiptName).toBeDefined();
    expect(JSON.parse(await readFile(
      join(paths.quarantineDirectory, receiptName!),
      "utf8"
    ))).toMatchObject({ state: "pending-quarantine-evidence" });

    const status = await createInstaller(new ScriptedTransport([])).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
  });

  it("does not advance resume metadata after fsync failure and truncates on restart", async () => {
    const payload = ggufPayload("x".repeat(17 * 1024 * 1024));
    const fixture = createFixture(payload);
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: new SecondCheckpointSyncFailureFileSystem(),
      transport: new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ]),
      now: () => fixedNow
    });

    await expectRuntimeCode(installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "STORAGE_UNAVAILABLE");
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    expect(JSON.parse(await readFile(paths.metadataPath, "utf8"))).toMatchObject({
      completedBytes: 8 * 1024 * 1024
    });
    expect((await stat(paths.partialPath)).size).toBe(16 * 1024 * 1024);

    const status = await createInstaller(new ScriptedTransport([])).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "paused",
      bytesReceived: 8 * 1024 * 1024,
      resumeAvailable: true
    });
    expect((await stat(paths.partialPath)).size).toBe(8 * 1024 * 1024);
  });

  it("checkpoints large downloads on an approximately eight MiB cadence", async () => {
    const payload = ggufPayload("x".repeat(17 * 1024 * 1024));
    const fixture = createFixture(payload);
    const fileSystem = new CountingManagedModelFileSystem();
    const installer = new ManagedModelInstaller({
      rootDirectory,
      fileSystem,
      transport: new ScriptedTransport([
        (request) => response(request.url, 200, [payload])
      ]),
      now: () => fixedNow
    });
    await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    expect(fileSystem.completedByteCheckpoints.filter(
      (bytes) => bytes > 0 && bytes < payload.byteLength
    )).toEqual([8 * 1024 * 1024, 16 * 1024 * 1024]);
    expect(fileSystem.metadataReplacements).toBeLessThanOrEqual(5);
  });

  it("derives traversal-resistant paths without accepting caller destinations", () => {
    const root = join(rootDirectory, "managed");
    const digest = "a".repeat(64);
    const paths = deriveManagedModelPaths(root, "safe-model", digest, "b".repeat(64));
    for (const path of [
      paths.modelPath,
      paths.partialPath,
      paths.metadataPath,
      paths.quarantineDirectory
    ]) {
      expect(relative(root, path)).not.toMatch(/^\.\.(?:\/|$)/);
    }
    expect(() => deriveManagedModelPaths(
      root,
      "../../escape",
      digest,
      "b".repeat(64)
    )).toThrow(/model ID is unsafe/i);
    expect(() => deriveManagedModelPaths(
      root,
      "safe-model",
      "../catalog",
      "b".repeat(64)
    )).toThrow(/artifact identity is invalid/i);
  });

  it("rejects off-origin redirects unless an exact HTTPS origin is injected", async () => {
    const payload = ggufPayload("redirect-bytes");
    const fixture = createFixture(payload);
    const redirectUrl = "https://us.aws.cdn.hf.co/signed-ephemeral/model.gguf?token=secret";
    const blockedTransport = new ScriptedTransport([
      (request) => response(request.url, 302, [], { location: redirectUrl })
    ]);
    await expectRuntimeCode(createInstaller(blockedTransport).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "SECURITY_BOUNDARY");

    const allowedTransport = new ScriptedTransport([
      (request) => response(request.url, 302, [], { location: redirectUrl }),
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]);
    const allowedInstaller = createInstaller(allowedTransport, {
      allowedRedirectOrigins: ["https://us.aws.cdn.hf.co"]
    });
    const result = await allowedInstaller.install({
      operationId: operationIds[1],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    expect(await readFile(result.modelPath)).toEqual(payload);
    expect(allowedTransport.requests[1]?.url).toBe(redirectUrl);
  });

  it("rejects encoded response bytes even when the declared length matches", async () => {
    const payload = ggufPayload("identity-only");
    const fixture = createFixture(payload);
    const transport = new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-encoding": "gzip",
        "content-length": String(payload.byteLength)
      })
    ]);
    await expectRuntimeCode(createInstaller(transport).install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    }), "DOWNLOAD_FAILED");
  });

  it("resolves only an exact installed artifact into frozen process-local launch authority", async () => {
    const payload = ggufPayload("promote-exact-installed-model");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    const installed = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });

    const promoted = await installer.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal);

    expect(promoted).toEqual({
      rootDirectory,
      modelId: fixture.artifact.modelId,
      displayName: fixture.artifact.displayName,
      modelPath: installed.modelPath,
      artifactSha256: fixture.artifact.sha256,
      downloadBytes: payload.byteLength,
      catalogGeneration: fixture.catalog.body.generation,
      target: "darwin-arm64"
    });
    expect(Object.isFrozen(promoted)).toBe(true);
    expect(() => assertProcessVerifiedManagedModel(promoted)).not.toThrow();
  });

  it("reports resolver contention as retryable BUSY", async () => {
    const payload = ggufPayload("resolver-contention");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const gate = new FirstDirectoryGateFileSystem();
    const resolver = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: gate,
      transport: new ScriptedTransport([]),
      now: () => fixedNow
    });
    const input = {
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    } as const;
    const first = resolver.resolveInstalledModel(
      input,
      new AbortController().signal
    );
    await gate.started;

    await expectRuntimeCode(resolver.resolveInstalledModel(
      input,
      new AbortController().signal
    ), "BUSY");
    gate.release();
    await expect(first).resolves.toMatchObject({
      modelId: fixture.artifact.modelId
    });
  });

  it("fails closed for missing, partial, and catalog-mismatched artifacts", async () => {
    const fixture = createFixture(ggufPayload("missing-model"));
    const installer = createInstaller(new ScriptedTransport([]));

    await expectRuntimeCode(installer.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "RUNTIME_UNAVAILABLE");

    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    await writeFile(paths.partialPath, fixture.payload.subarray(0, 8));
    await expectRuntimeCode(installer.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "RUNTIME_UNAVAILABLE");

    const installedFixture = createFixture(ggufPayload("installed-pin"));
    const installTransport = new ScriptedTransport([
      (request) => response(request.url, 200, [installedFixture.payload], {
        "content-length": String(installedFixture.payload.byteLength)
      })
    ]);
    const installedManager = createInstaller(installTransport);
    await installedManager.install({
      operationId: operationIds[0],
      catalog: installedFixture.catalog,
      request: installedFixture.request,
      target: "darwin-arm64"
    });
    const otherPin = createFixture(
      ggufPayload("different-catalog-pin"),
      { generation: 5 }
    );
    await expectRuntimeCode(installedManager.resolveInstalledModel({
      catalog: otherPin.catalog,
      modelId: otherPin.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "RUNTIME_UNAVAILABLE");
  });

  it("rejects unverified catalogs and ineligible targets before path promotion", async () => {
    const fixture = createFixture(ggufPayload("authority-boundary"));
    const installer = createInstaller(new ScriptedTransport([]));

    await expectRuntimeCode(installer.resolveInstalledModel({
      catalog: structuredClone(fixture.catalog),
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "CATALOG_INVALID");
    await expectRuntimeCode(installer.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "linux-x64"
    }, new AbortController().signal), "BAD_REQUEST");
  });

  it("quarantines corrupt installed material instead of promoting it", async () => {
    const payload = ggufPayload("corrupt-before-promotion");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    const installed = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    await appendFile(installed.modelPath, "corrupt");

    await expectRuntimeCode(installer.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "INTEGRITY_FAILED");
    expect((await readdir(deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    ).quarantineDirectory)).some((name) => name.endsWith(".gguf"))).toBe(true);
  });

  it("propagates transient stable-read failure without moving a valid model", async () => {
    const payload = ggufPayload("preserve-on-storage-failure");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    const installed = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const resolver = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: new StableReadFailureFileSystem(installed.modelPath),
      transport: new ScriptedTransport([]),
      now: () => fixedNow
    });

    await expectRuntimeCode(resolver.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "STORAGE_UNAVAILABLE");
    expect(await readFile(installed.modelPath)).toEqual(payload);
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    expect(await readdir(paths.quarantineDirectory)).toEqual([]);
  });

  it("rejects a pre-aborted resolution before touching the filesystem", async () => {
    const fixture = createFixture(ggufPayload("cancel-before-filesystem"));
    const fileSystem = new NoTouchManagedModelFileSystem();
    const resolver = new ManagedModelInstaller({
      rootDirectory,
      fileSystem,
      transport: new ScriptedTransport([]),
      now: () => fixedNow
    });
    const controller = new AbortController();
    controller.abort();

    await expectRuntimeCode(resolver.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, controller.signal), "CANCELLED");
    expect(fileSystem.touched).toBe(false);
  });

  it("cancels during stable hashing without quarantining or moving the model", async () => {
    const payload = ggufPayload("cancel-during-stable-hash");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    const installed = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const controller = new AbortController();
    const resolver = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: new AbortDuringStableReadFileSystem(
        installed.modelPath,
        controller
      ),
      transport: new ScriptedTransport([]),
      now: () => fixedNow
    });

    await expectRuntimeCode(resolver.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, controller.signal), "CANCELLED");
    expect(await readFile(installed.modelPath)).toEqual(payload);
    const paths = deriveManagedModelPaths(
      rootDirectory,
      fixture.artifact.modelId,
      managedCatalogDigest(fixture.catalog),
      fixture.artifact.sha256
    );
    expect(await readdir(paths.quarantineDirectory)).toEqual([]);
  });

  it("fails closed when the installed path is replaced during stable verification", async () => {
    const payload = ggufPayload("replace-during-resolve");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    const installed = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const replacingFileSystem = new ReplaceOnSecondModelReadFileSystem(
      installed.modelPath
    );
    const resolver = new ManagedModelInstaller({
      rootDirectory,
      fileSystem: replacingFileSystem,
      transport: new ScriptedTransport([]),
      now: () => fixedNow
    });

    await expectRuntimeCode(resolver.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "INTEGRITY_FAILED");
    expect(replacingFileSystem.replaced).toBe(true);
  });

  it("revokes a hardlinked managed entry without touching its outside alias", async () => {
    const payload = ggufPayload("hardlink-before-promotion");
    const fixture = createFixture(payload);
    const installer = createInstaller(new ScriptedTransport([
      (request) => response(request.url, 200, [payload], {
        "content-length": String(payload.byteLength)
      })
    ]));
    const installed = await installer.install({
      operationId: operationIds[0],
      catalog: fixture.catalog,
      request: fixture.request,
      target: "darwin-arm64"
    });
    const outsideAlias = join(rootDirectory, "outside-model-alias.gguf");
    await link(installed.modelPath, outsideAlias);

    await expectRuntimeCode(installer.resolveInstalledModel({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    }, new AbortController().signal), "INTEGRITY_FAILED");
    expect(await readFile(outsideAlias)).toEqual(payload);
    await expect(stat(installed.modelPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

interface Fixture {
  payload: Buffer;
  artifact: PinnedModelArtifact;
  catalog: SignedModelCatalog;
  request: {
    modelId: string;
    acknowledgement: LicenseAcknowledgement;
  };
}

function createFixture(
  payload: Buffer,
  options: {
    modelId?: string;
    generation?: number;
  } = {}
): Fixture {
  const modelId = options.modelId ?? "test-model";
  const generation = options.generation ?? 4;
  const artifact: PinnedModelArtifact = {
    artifactVersion: 1,
    modelId,
    displayName: "Test model",
    repository: "Qwen/Test-GGUF",
    repositoryRevision: "a".repeat(40),
    filename: "test.gguf",
    downloadUrl: sourceUrl,
    downloadBytes: payload.byteLength,
    sha256: sha256(payload),
    eligibleTargets: ["darwin-arm64"],
    license: {
      id: "Apache-2.0",
      name: "Apache License 2.0",
      officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      noticeText: licenseNoticeText,
      noticeVersion: "Apache-2.0-2004",
      noticeSha256: sha256(Buffer.from(licenseNoticeText, "utf8"))
    }
  };
  const body: ModelCatalogBody = {
    schemaVersion: 2,
    catalogId: "switchboard-model-catalog",
    generation,
    issuedAt: "2026-07-30T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
    artifacts: [artifact]
  };
  const catalog = verifySignedModelCatalog(
    signCatalog(body, keyPair.privateKey),
    {
      trustRoots: [{ keyId: "test-key", publicKeyPem }],
      minimumGeneration: 4,
      allowedTargets: new Set(["darwin-arm64"]),
      now: fixedNow
    }
  );
  return {
    payload,
    artifact,
    catalog,
    request: {
      modelId: artifact.modelId,
      acknowledgement: {
        acknowledgementVersion: 1,
        modelId: artifact.modelId,
        artifactSha256: artifact.sha256,
        licenseNoticeVersion: artifact.license.noticeVersion,
        licenseNoticeSha256: artifact.license.noticeSha256,
        catalogGeneration: generation,
        acceptedAt: fixedNow.toISOString()
      }
    }
  };
}

function createInstaller(
  transport: ModelDownloadTransport,
  redirectPolicy?: { allowedRedirectOrigins: readonly string[] }
): ManagedModelInstaller {
  return new ManagedModelInstaller({
    rootDirectory,
    transport,
    ...(redirectPolicy === undefined ? {} : { redirectPolicy }),
    now: () => fixedNow
  });
}

async function createCancelledPartial(
  installer: ManagedModelInstaller,
  fixture: Fixture,
  splitAt: number
): Promise<void> {
  let cancelled = false;
  await expectRuntimeCode(installer.install({
    operationId: operationIds[0],
    catalog: fixture.catalog,
    request: fixture.request,
    target: "darwin-arm64",
    onStatus: (status) => {
      if (
        !cancelled &&
        status.state === "downloading" &&
        status.bytesReceived === splitAt
      ) {
        cancelled = installer.cancel(operationIds[0]);
      }
    }
  }), "CANCELLED");
  expect(cancelled).toBe(true);
}

async function expectQuarantinedAcrossTwoRestarts(
  fixture: Fixture
): Promise<void> {
  for (let restart = 0; restart < 2; restart += 1) {
    const transport = new ScriptedTransport([]);
    const status = await createInstaller(transport).probe({
      catalog: fixture.catalog,
      modelId: fixture.artifact.modelId,
      target: "darwin-arm64"
    });
    expect(status).toMatchObject({
      state: "quarantined",
      operationId: null,
      resumeAvailable: false
    });
    expect(transport.requests).toHaveLength(0);
  }
}

class ScriptedTransport implements ModelDownloadTransport {
  readonly requests: ModelDownloadHttpRequest[] = [];
  private readonly handlers: Array<
    (request: ModelDownloadHttpRequest) =>
      ModelDownloadHttpResponse | Promise<ModelDownloadHttpResponse>
  >;

  constructor(
    handlers: Array<
      (request: ModelDownloadHttpRequest) =>
        ModelDownloadHttpResponse | Promise<ModelDownloadHttpResponse>
    >
  ) {
    this.handlers = [...handlers];
  }

  push(
    handler: (request: ModelDownloadHttpRequest) =>
      ModelDownloadHttpResponse | Promise<ModelDownloadHttpResponse>
  ): void {
    this.handlers.push(handler);
  }

  async request(request: ModelDownloadHttpRequest): Promise<ModelDownloadHttpResponse> {
    this.requests.push(request);
    const handler = this.handlers.shift();
    if (handler === undefined) {
      throw new Error("No scripted model-download response remains.");
    }
    return handler(request);
  }
}

class CountingManagedModelFileSystem extends NodeManagedModelFileSystem {
  metadataReplacements = 0;
  completedByteCheckpoints: number[] = [];

  override async replacePrivateFile(
    path: string,
    temporaryPath: string,
    content: string
  ): Promise<void> {
    this.metadataReplacements += 1;
    const record = JSON.parse(content) as { completedBytes?: unknown };
    if (typeof record.completedBytes === "number") {
      this.completedByteCheckpoints.push(record.completedBytes);
    }
    await super.replacePrivateFile(path, temporaryPath, content);
  }
}

class RefusedMoveManagedModelFileSystem extends NodeManagedModelFileSystem {
  override async moveNoReplace(): Promise<{
    moved: boolean;
    directoriesSynced: boolean;
  }> {
    return { moved: false, directoriesSynced: true };
  }
}

class FinalizeReceiptFailureFileSystem extends NodeManagedModelFileSystem {
  override async replacePrivateFile(
    path: string,
    temporaryPath: string,
    content: string
  ): Promise<void> {
    if (path.endsWith(".gguf.json")) {
      throw storageUnavailable("simulated quarantine receipt finalization failure");
    }
    await super.replacePrivateFile(path, temporaryPath, content);
  }
}

class FirstDirectoryGateFileSystem extends NodeManagedModelFileSystem {
  readonly started: Promise<void>;
  private readonly released: Promise<void>;
  private resolveStarted!: () => void;
  private resolveReleased!: () => void;
  private gated = false;

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.resolveReleased = resolve;
    });
  }

  release(): void {
    this.resolveReleased();
  }

  override async ensurePrivateDirectory(path: string): Promise<void> {
    await super.ensurePrivateDirectory(path);
    if (!this.gated) {
      this.gated = true;
      this.resolveStarted();
      await this.released;
    }
  }
}

class StreamFailureManagedModelFileSystem extends NodeManagedModelFileSystem {
  constructor(
    private readonly failureMode: "open" | "write" | "body"
  ) {
    super();
  }

  override async openWritable(
    path: string,
    append: boolean,
    expectedSize: number
  ): Promise<ManagedModelWritableFile> {
    if (this.failureMode === "open") {
      throw storageUnavailable("simulated writable setup failure");
    }
    const writer = await super.openWritable(path, append, expectedSize);
    return {
      write: this.failureMode === "write"
        ? async () => {
            throw storageUnavailable("simulated model write failure");
          }
        : (chunk) => writer.write(chunk),
      sync: () => writer.sync(),
      close: () => writer.close()
    };
  }
}

class SecondCheckpointSyncFailureFileSystem extends NodeManagedModelFileSystem {
  private syncCalls = 0;

  override async openWritable(
    path: string,
    append: boolean,
    expectedSize: number
  ): Promise<ManagedModelWritableFile> {
    const writer = await super.openWritable(path, append, expectedSize);
    return {
      write: (chunk) => writer.write(chunk),
      sync: async () => {
        this.syncCalls += 1;
        if (this.syncCalls === 2) {
          throw storageUnavailable("simulated second durability checkpoint failure");
        }
        await writer.sync();
      },
      close: () => writer.close()
    };
  }

  override async truncateRegularFile(): Promise<void> {
    throw storageUnavailable("defer truncation to the restarted installer");
  }
}

class DeferredHardlinkUnlinkFileSystem extends NodeManagedModelFileSystem {
  private unsafePath: string | null = null;
  private refused = false;

  override async regularFileSize(path: string): Promise<number | null> {
    try {
      return await super.regularFileSize(path);
    } catch (error) {
      if (error instanceof UnsafeManagedModelHardlinkError) {
        this.unsafePath = path;
      }
      throw error;
    }
  }

  override async removeFile(path: string): Promise<void> {
    if (!this.refused && path === this.unsafePath) {
      this.refused = true;
      throw storageUnavailable("simulated crash before hardlink entry unlink");
    }
    await super.removeFile(path);
  }
}

class ReplaceOnSecondModelReadFileSystem extends NodeManagedModelFileSystem {
  replaced = false;
  private matchingReads = 0;

  constructor(private readonly modelPath: string) {
    super();
  }

  override async openStableRead(path: string): Promise<ManagedModelReadHandle> {
    if (path === this.modelPath) {
      this.matchingReads += 1;
      if (this.matchingReads === 2) {
        const bytes = await readFile(path);
        await rename(path, `${path}.replaced`);
        await writeFile(path, bytes, { mode: 0o600 });
        this.replaced = true;
      }
    }
    return super.openStableRead(path);
  }
}

class StableReadFailureFileSystem extends NodeManagedModelFileSystem {
  constructor(private readonly modelPath: string) {
    super();
  }

  override async openStableRead(path: string): Promise<ManagedModelReadHandle> {
    if (path === this.modelPath) {
      throw storageUnavailable("simulated transient stable-read failure");
    }
    return super.openStableRead(path);
  }
}

class NoTouchManagedModelFileSystem extends NodeManagedModelFileSystem {
  touched = false;

  override async ensurePrivateDirectory(path: string): Promise<void> {
    this.touched = true;
    await super.ensurePrivateDirectory(path);
  }
}

class AbortDuringStableReadFileSystem extends NodeManagedModelFileSystem {
  private wrapped = false;

  constructor(
    private readonly modelPath: string,
    private readonly controller: AbortController
  ) {
    super();
  }

  override async openStableRead(path: string): Promise<ManagedModelReadHandle> {
    const handle = await super.openStableRead(path);
    if (path !== this.modelPath || this.wrapped) {
      return handle;
    }
    this.wrapped = true;
    const controller = this.controller;
    return {
      identity: () => handle.identity(),
      read: (position, length) => handle.read(position, length),
      chunks: async function* () {
        for await (const chunk of handle.chunks()) {
          controller.abort();
          yield chunk;
        }
      },
      sync: () => handle.sync(),
      close: () => handle.close()
    };
  }
}

function storageUnavailable(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "STORAGE_UNAVAILABLE",
    message,
    retryable: true
  });
}

function response(
  url: string,
  status: number,
  chunks: readonly Uint8Array[],
  headers: Readonly<Record<string, string>> = {}
): ModelDownloadHttpResponse {
  const lowerHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    status,
    url,
    headers: {
      get: (name) => lowerHeaders.get(name.toLowerCase()) ?? null
    },
    body: (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })()
  };
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
    signature: sign(null, catalogSigningBytes(unsigned), privateKey).toString("base64")
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ggufPayload(body: string): Buffer {
  const header = Buffer.alloc(24);
  header.write("GGUF", 0, "ascii");
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(1n, 8);
  header.writeBigUInt64LE(1n, 16);
  return Buffer.concat([header, Buffer.from(body, "utf8")]);
}

async function expectRuntimeCode(
  promise: Promise<unknown>,
  code: RuntimeBoundaryError["detail"]["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected runtime error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeBoundaryError);
    expect((error as RuntimeBoundaryError).detail.code).toBe(code);
  }
}
