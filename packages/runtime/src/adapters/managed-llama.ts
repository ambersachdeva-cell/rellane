import {
  LocalChatRequestSchema,
  RuntimeDescriptorSchema,
  type LocalChatRequest,
  type LocalChatResult,
  type ModelInstallSnapshot,
  type ModelTarget,
  type RuntimeDescriptor,
  type SignedModelCatalog
} from "@cadrane/contracts";
import { RuntimeBoundaryError } from "../errors.js";
import {
  isProcessVerifiedManagedRuntimeAuthority
} from "../managed-runtime/activation-provenance.js";
import { LlamaServerSupervisor } from "../managed-runtime/llama-server-supervisor.js";
import {
  MANAGED_LLAMA_RUNTIME_ID,
  type ManagedRuntimeAuthority,
  type PromotedManagedModel
} from "../managed-runtime/types.js";
import {
  resolveVerifiedCatalogArtifact
} from "../model/catalog-verifier.js";
import type {
  ManagedModelResolveInput
} from "../model/managed-model-store.js";
import type {
  VerifiedModelCatalogSource
} from "../model/model-license-service.js";
import { SingleLaneScheduler } from "../single-lane.js";
import type {
  LocalRuntimeAdapter,
  RuntimeAdapterScheduling
} from "./types.js";

export interface ManagedRuntimeActivationSource {
  currentAuthority(): ManagedRuntimeAuthority | null;
}

export class UnavailableManagedRuntimeActivationSource
implements ManagedRuntimeActivationSource {
  currentAuthority(): null {
    return null;
  }
}

export interface ManagedInstallSnapshotSource {
  snapshot(): Promise<ModelInstallSnapshot>;
}

export interface ManagedInstalledModelResolver {
  resolveInstalledModel(
    input: ManagedModelResolveInput,
    signal: AbortSignal
  ): Promise<PromotedManagedModel>;
}

export interface ManagedLlamaAdapterOptions {
  readonly lane: SingleLaneScheduler;
  readonly supervisor: LlamaServerSupervisor;
  readonly catalogSource: VerifiedModelCatalogSource;
  readonly installController: ManagedInstallSnapshotSource;
  readonly modelResolver: ManagedInstalledModelResolver;
  readonly activationSource: ManagedRuntimeActivationSource;
  readonly target: ModelTarget;
  readonly now?: () => Date;
}

export class ManagedLlamaAdapter implements LocalRuntimeAdapter {
  readonly id = MANAGED_LLAMA_RUNTIME_ID;
  readonly kind = "managed-llama" as const;
  readonly identity = { name: "Switchboard Managed", baseUrl: null };
  readonly scheduling: RuntimeAdapterScheduling;

  private readonly supervisor: LlamaServerSupervisor;
  private readonly catalogSource: VerifiedModelCatalogSource;
  private readonly installController: ManagedInstallSnapshotSource;
  private readonly modelResolver: ManagedInstalledModelResolver;
  private readonly activationSource: ManagedRuntimeActivationSource;
  private readonly target: ModelTarget;
  private readonly now: () => Date;

  constructor(options: ManagedLlamaAdapterOptions) {
    this.scheduling = Object.freeze({
      owner: "adapter",
      lane: options.lane
    });
    this.supervisor = options.supervisor;
    this.catalogSource = options.catalogSource;
    this.installController = options.installController;
    this.modelResolver = options.modelResolver;
    this.activationSource = options.activationSource;
    this.target = options.target;
    this.now = options.now ?? (() => new Date());
  }

  async probe(): Promise<RuntimeDescriptor> {
    const checkedAt = safeIso(this.now());
    try {
      const catalog = this.catalogSource.currentCatalog();
      const artifacts = eligibleArtifacts(catalog, this.target);
      const snapshot = await this.installController.snapshot();
      const authority = this.activationSource.currentAuthority();
      const activationReady = (
        authority !== null &&
        isProcessVerifiedManagedRuntimeAuthority(authority)
      );
      const installed = artifacts.filter((artifact) =>
        snapshot.some((status) =>
          status.modelId === artifact.modelId &&
          status.state === "installed" &&
          status.catalogGeneration === catalog.body.generation &&
          status.artifactSha256 === artifact.sha256
        )
      );
      const currentStatuses = snapshot.filter((status) =>
        status.catalogGeneration === catalog.body.generation &&
        artifacts.some((artifact) =>
          artifact.modelId === status.modelId &&
          artifact.sha256 === status.artifactSha256
        )
      );
      const hasPaused = currentStatuses.some((status) =>
        status.state === "paused" && status.resumeAvailable
      );
      const hasAttention = currentStatuses.some((status) =>
        status.state === "failed" || status.state === "quarantined"
      );
      const state = installed.length > 0 && activationReady
        ? "available"
        : installed.length > 0 || hasAttention
          ? "attention"
          : "unavailable";
      const detail = installed.length > 0 && !activationReady
        ? "A verified model is installed. A signed Switchboard runtime package is still required."
        : installed.length > 0
          ? "The signed managed runtime can start this verified model on demand."
          : hasPaused
            ? "The managed model download is paused. Finish installation before local work can start."
            : hasAttention
              ? "The managed model needs attention before local work can start."
              : "Install the recommended model to prepare Switchboard managed local AI.";

      return RuntimeDescriptorSchema.parse({
        id: this.id,
        kind: this.kind,
        name: "Switchboard Managed",
        state,
        baseUrl: null,
        version: activationReady ? authority.activation.receipt.tag : null,
        models: installed.map((artifact) => ({
          id: artifact.modelId,
          displayName: artifact.displayName,
          sizeBytes: artifact.downloadBytes,
          loaded: activationReady && this.supervisor.isReadyFor({
            authority,
            modelId: artifact.modelId,
            artifactSha256: artifact.sha256,
            catalogGeneration: catalog.body.generation,
            target: this.target
          })
        })),
        detail,
        checkedAt
      });
    } catch {
      return RuntimeDescriptorSchema.parse({
        id: this.id,
        kind: this.kind,
        name: "Switchboard Managed",
        state: "attention",
        baseUrl: null,
        version: null,
        models: [],
        detail:
          "The managed runtime could not verify its current model and signed activation state.",
        checkedAt
      });
    }
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

    return this.supervisor.runLazy(
      parsed.data,
      async (operationSignal) => {
        operationSignal.throwIfAborted();
        const catalog = this.catalogSource.currentCatalog();
        const artifact = resolveVerifiedCatalogArtifact(
          catalog,
          parsed.data.modelId
        );
        if (!artifact.eligibleTargets.includes(this.target)) {
          throw runtimeUnavailable(
            "The selected model is not approved for this computer target."
          );
        }
        const authority = this.activationSource.currentAuthority();
        if (
          authority === null ||
          !isProcessVerifiedManagedRuntimeAuthority(authority)
        ) {
          throw runtimeUnavailable(
            "A build-anchored signed runtime package is required before managed inference can start."
          );
        }
        const model = await this.modelResolver.resolveInstalledModel({
          catalog,
          modelId: artifact.modelId,
          target: this.target
        }, operationSignal);
        if (
          model.modelId !== artifact.modelId ||
          model.artifactSha256 !== artifact.sha256 ||
          model.downloadBytes !== artifact.downloadBytes ||
          model.catalogGeneration !== catalog.body.generation ||
          model.target !== this.target
        ) {
          throw new RuntimeBoundaryError({
            code: "INTEGRITY_FAILED",
            message:
              "The promoted managed model did not match the current signed catalog pin.",
            retryable: false
          });
        }
        return {
          authority,
          runtime: authority.activation,
          model
        };
      },
      signal
    );
  }

  shutdown(): Promise<void> {
    return this.supervisor.shutdown();
  }
}

function eligibleArtifacts(
  catalog: SignedModelCatalog,
  target: ModelTarget
): readonly SignedModelCatalog["body"]["artifacts"][number][] {
  return catalog.body.artifacts
    .map((candidate) =>
      resolveVerifiedCatalogArtifact(catalog, candidate.modelId)
    )
    .filter((artifact) => artifact.eligibleTargets.includes(target));
}

function safeIso(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new RuntimeBoundaryError({
      code: "UNKNOWN",
      message: "The managed runtime clock is invalid.",
      retryable: false
    });
  }
  return now.toISOString();
}

function badRequest(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BAD_REQUEST",
    message,
    retryable: false
  });
}

function runtimeUnavailable(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message,
    retryable: false
  });
}
