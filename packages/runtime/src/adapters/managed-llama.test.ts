import type {
  LocalChatRequest,
  ModelInstallSnapshot,
  ModelInstallStatus
} from "@cadrane/contracts";
import { describe, expect, it, vi } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import type { LlamaServerSupervisor } from "../managed-runtime/llama-server-supervisor.js";
import {
  MANAGED_LLAMA_RUNTIME_ID,
  type ActivatedLlamaRuntime,
  type ManagedRuntimeAuthority
} from "../managed-runtime/types.js";
import { loadStaticBetaModelCatalog } from "../model/static-beta-catalog.js";
import { SingleLaneScheduler } from "../single-lane.js";
import {
  ManagedLlamaAdapter,
  UnavailableManagedRuntimeActivationSource,
  type ManagedRuntimeActivationSource
} from "./managed-llama.js";

const checkedAt = new Date("2026-08-01T00:00:00.000Z");
const catalog = loadStaticBetaModelCatalog({
  target: "darwin-arm64",
  now: checkedAt
});
const artifact = catalog.body.artifacts[0]!;
const operationId = "11111111-1111-4111-8111-111111111111";
const request: LocalChatRequest = {
  operationId,
  runtimeId: MANAGED_LLAMA_RUNTIME_ID,
  modelId: artifact.modelId,
  messages: [{ role: "user", content: "Test locally." }],
  temperature: 0.2,
  maxTokens: 64
};

describe("ManagedLlamaAdapter", () => {
  it("lists only exact installed current-pin models", async () => {
    const installed = status({
      state: "installed",
      catalogGeneration: catalog.body.generation
    });
    const { adapter } = fixture([installed]);

    await expect(adapter.probe()).resolves.toMatchObject({
      id: MANAGED_LLAMA_RUNTIME_ID,
      kind: "managed-llama",
      state: "attention",
      baseUrl: null,
      version: null,
      models: [{
        id: artifact.modelId,
        loaded: false
      }]
    });
  });

  it("does not misreport catalog suggestions or stale pins as installed", async () => {
    const stale = status({
      state: "installed",
      catalogGeneration: catalog.body.generation - 1
    });
    const { adapter } = fixture([stale]);

    const descriptor = await adapter.probe();

    expect(descriptor.state).toBe("unavailable");
    expect(descriptor.models).toEqual([]);
    expect(descriptor.detail).toContain("Install the recommended model");
  });

  it("fails before model resolution when signed activation is unavailable", async () => {
    const { adapter, supervisor, modelResolver } = fixture([
      status({
        state: "installed",
        catalogGeneration: catalog.body.generation
      })
    ]);

    await expect(adapter.chat(
      request,
      new AbortController().signal
    )).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE" }
    });
    expect(supervisor.runLazy).toHaveBeenCalledTimes(1);
    expect(modelResolver.resolveInstalledModel).not.toHaveBeenCalled();
  });

  it("does not activate from an unsigned structural fixture", async () => {
    const unsignedActivation = structuralActivation();
    const { adapter, modelResolver } = fixture([
      status({
        state: "installed",
        catalogGeneration: catalog.body.generation
      })
    ], {
      currentAuthority: () => ({
        activation: unsignedActivation,
        integrityVerifier: { verify: async () => {} }
      } as ManagedRuntimeAuthority)
    });

    await expect(adapter.probe()).resolves.toMatchObject({
      state: "attention",
      version: null,
      models: [{ loaded: false }]
    });
    await expect(adapter.chat(
      request,
      new AbortController().signal
    )).rejects.toMatchObject({
      detail: { code: "RUNTIME_UNAVAILABLE" }
    });
    expect(modelResolver.resolveInstalledModel).not.toHaveBeenCalled();
    expect(new UnavailableManagedRuntimeActivationSource().currentAuthority())
      .toBeNull();
  });
});

function fixture(
  snapshot: ModelInstallSnapshot,
  activationSource: ManagedRuntimeActivationSource =
    new UnavailableManagedRuntimeActivationSource()
) {
  const lane = new SingleLaneScheduler();
  const supervisor = {
    isReadyFor: vi.fn(() => false),
    runLazy: vi.fn(async (
      _request: LocalChatRequest,
      resolve: (signal: AbortSignal) => Promise<unknown>,
      signal: AbortSignal
    ) => {
      await resolve(signal);
      throw new RuntimeBoundaryError({
        code: "UNKNOWN",
        message: "The fixture unexpectedly resolved launch input.",
        retryable: false
      });
    }),
    shutdown: vi.fn(async () => {})
  };
  const modelResolver = {
    resolveInstalledModel: vi.fn(async () => {
      throw new Error("The resolver must not run without signed activation.");
    })
  };
  const adapter = new ManagedLlamaAdapter({
    lane,
    supervisor: supervisor as unknown as LlamaServerSupervisor,
    catalogSource: { currentCatalog: () => catalog },
    installController: { snapshot: async () => snapshot },
    modelResolver,
    activationSource,
    target: "darwin-arm64",
    now: () => checkedAt
  });
  return { adapter, supervisor, modelResolver };
}

function structuralActivation(): ActivatedLlamaRuntime {
  return {
    runtimeRoot: "/untrusted/runtime",
    payloadDirectory: "/untrusted/runtime/payload",
    serverPath: "/untrusted/runtime/payload/llama-server",
    sourceManifest: {
      schemaVersion: 1,
      archiveSha256: "a".repeat(64),
      payloadRoot: "payload",
      members: []
    },
    manifest: {
      schemaVersion: 1,
      archiveSha256: "a".repeat(64),
      payloadRoot: "payload",
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
  };
}

function status(
  overrides: Pick<ModelInstallStatus, "state" | "catalogGeneration">
): ModelInstallStatus {
  return {
    modelId: artifact.modelId,
    state: overrides.state,
    operationId: null,
    catalogGeneration: overrides.catalogGeneration,
    artifactSha256: artifact.sha256,
    bytesReceived: overrides.state === "installed"
      ? artifact.downloadBytes
      : 0,
    totalBytes: artifact.downloadBytes,
    resumeAvailable: false,
    detail: "Fixture status.",
    error: null,
    updatedAt: checkedAt.toISOString()
  };
}
