import {
  ModelInstallCancelRequestSchema,
  ModelInstallRequestSchema,
  ModelTargetSchema,
  type DesktopError,
  type ModelInstallRequest,
  type ModelInstallStatus,
  type ModelTarget,
  type PinnedModelArtifact,
  type SignedModelCatalog
} from "@cadrane/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { RuntimeBoundaryError, toDesktopError } from "../errors.js";
import { promoteVerifiedManagedModel } from "../managed-runtime/promoted-model-provenance.js";
import type { PromotedManagedModel } from "../managed-runtime/types.js";
import { SingleLaneScheduler } from "../single-lane.js";
import {
  catalogSigningBytes,
  resolveVerifiedCatalogArtifact
} from "./catalog-verifier.js";
import {
  type ManagedFileIdentity,
  NodeManagedModelFileSystem,
  type ManagedModelFileSystem,
  type ManagedModelReadHandle,
  type ManagedModelWritableFile,
  UnsafeManagedModelHardlinkError
} from "./model-download-files.js";
import {
  disposeModelDownloadResponse,
  NodeModelDownloadTransport,
  requestModelArtifact,
  type ModelDownloadHttpResponse,
  type ModelDownloadRedirectPolicy,
  type ModelDownloadTransport
} from "./model-download-network.js";
import {
  GGUF_HEADER_BYTES,
  parseBoundedGgufV3Header
} from "./inspect-gguf.js";
import { acknowledgementMatchesArtifact } from "./install-lifecycle.js";

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const DURABILITY_CHECKPOINT_BYTES = 8 * 1024 * 1024;

interface PartialDownloadMetadata {
  readonly schemaVersion: 2;
  readonly catalogId: "switchboard-model-catalog";
  readonly catalogGeneration: number;
  readonly catalogDigest: string;
  readonly modelId: string;
  readonly artifactSha256: string;
  readonly repositoryRevision: string;
  readonly filename: string;
  readonly downloadUrl: string;
  readonly downloadBytes: number;
  readonly completedBytes: number;
}

export interface ManagedModelPaths {
  readonly rootDirectory: string;
  readonly modelDirectory: string;
  readonly modelPath: string;
  readonly stagingDirectory: string;
  readonly partialPath: string;
  readonly metadataPath: string;
  readonly quarantineDirectory: string;
}

export interface ManagedModelInstallInput {
  readonly operationId: string;
  readonly catalog: SignedModelCatalog;
  readonly request: ModelInstallRequest;
  readonly target: ModelTarget;
  readonly onStatus?: (status: ModelInstallStatus) => void;
}

export interface ManagedModelProbeInput {
  readonly catalog: SignedModelCatalog;
  readonly modelId: string;
  readonly target: ModelTarget;
  readonly onStatus?: (status: ModelInstallStatus) => void;
}

export interface ManagedModelResolveInput {
  readonly catalog: SignedModelCatalog;
  readonly modelId: string;
  readonly target: ModelTarget;
}

export interface ManagedModelInstallResult {
  readonly modelId: string;
  readonly modelPath: string;
  readonly artifactSha256: string;
  readonly downloadBytes: number;
  readonly catalogGeneration: number;
  readonly installedAt: string;
}

export interface ManagedModelInstallerSnapshot {
  readonly downloadLane: {
    readonly activeOperationId: string | null;
    readonly queuedOperationIds: readonly string[];
  };
  readonly statuses: readonly ModelInstallStatus[];
}

export interface ManagedModelCommitContext {
  readonly operationId: string;
  readonly modelId: string;
  readonly stagingPath: string;
  readonly destinationPath: string;
}

export interface ManagedModelInstallerOptions {
  readonly rootDirectory: string;
  readonly transport?: ModelDownloadTransport;
  readonly fileSystem?: ManagedModelFileSystem;
  readonly redirectPolicy?: ModelDownloadRedirectPolicy;
  readonly maximumQueuedDownloads?: number;
  readonly now?: () => Date;
  readonly uniqueId?: () => string;
  /** Privileged deterministic lifecycle seam used by integration tests. */
  readonly onCommitStarted?: (
    context: ManagedModelCommitContext
  ) => void | Promise<void>;
}

interface PreparedInstall {
  readonly operationId: string;
  readonly catalog: SignedModelCatalog;
  readonly artifact: PinnedModelArtifact;
  readonly request: ModelInstallRequest | null;
  readonly target: ModelTarget;
  readonly onStatus: ((status: ModelInstallStatus) => void) | undefined;
  readonly catalogDigest: string;
  readonly statusKey: string;
  readonly paths: ManagedModelPaths;
}

interface PartialState {
  readonly bytes: number;
  readonly valid: boolean;
}

interface StableVerification {
  readonly identity: ManagedFileIdentity;
  readonly bytes: number;
  readonly digest: string;
}

interface StreamObservation {
  readonly observedStreamStartOffset: number;
  readonly observedStreamBytesAtLeast: number;
  readonly observedStreamPrefixSha256: string;
  readonly streamObservationComplete: false;
}

interface PendingQuarantineEvidence {
  readonly schemaVersion: 2;
  readonly state: "pending-quarantine-evidence";
  readonly modelId: string;
  readonly expectedSha256: string;
  readonly expectedBytes: number;
  readonly sourceKind: "managed" | "staging";
  readonly reason: string;
  readonly quarantinedAt: string;
  readonly observedStreamStartOffset: number | null;
  readonly observedStreamBytesAtLeast: number | null;
  readonly observedStreamPrefixSha256: string | null;
  readonly streamObservationComplete: boolean | null;
}

interface PendingQuarantineReservation {
  readonly quarantinePath: string;
  readonly receiptPath: string;
  readonly evidence: PendingQuarantineEvidence;
}

type OperationPhase = "precommit" | "committing";

class ResumeResponseMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeResponseMismatch";
  }
}

export class ManagedModelInstaller {
  private readonly rootDirectory: string;
  private readonly transport: ModelDownloadTransport;
  private readonly fileSystem: ManagedModelFileSystem;
  private readonly redirectPolicy: ModelDownloadRedirectPolicy;
  private readonly now: () => Date;
  private readonly uniqueId: () => string;
  private readonly onCommitStarted:
    ((context: ManagedModelCommitContext) => void | Promise<void>) | undefined;
  private readonly downloadLane: SingleLaneScheduler;
  private readonly pendingModelIds = new Set<string>();
  private readonly pendingOperationIds = new Set<string>();
  private readonly operationPhases = new Map<string, OperationPhase>();
  private readonly statuses = new Map<string, ModelInstallStatus>();
  private readonly latestStatusKeys = new Map<string, string>();
  private uniqueCounter = 0;

  constructor(options: ManagedModelInstallerOptions) {
    if (options.rootDirectory.trim() === "") {
      throw badRequest("The managed model store directory is required.");
    }
    this.rootDirectory = resolve(options.rootDirectory);
    if (dirname(this.rootDirectory) === this.rootDirectory) {
      throw badRequest("The managed model store cannot use a filesystem root.");
    }
    this.transport = options.transport ?? new NodeModelDownloadTransport();
    this.fileSystem = options.fileSystem ?? new NodeManagedModelFileSystem();
    this.redirectPolicy = options.redirectPolicy ?? {};
    this.now = options.now ?? (() => new Date());
    this.uniqueId = options.uniqueId ?? randomUUID;
    this.onCommitStarted = options.onCommitStarted;
    this.downloadLane = new SingleLaneScheduler(options.maximumQueuedDownloads ?? 4);
  }

  install(input: ManagedModelInstallInput): Promise<ManagedModelInstallResult> {
    let prepared: PreparedInstall;
    try {
      prepared = this.prepare(input);
    } catch (error) {
      return Promise.reject(normalizeDownloadError(error));
    }

    if (
      prepared.request === null ||
      !acknowledgementMatchesArtifact(
      prepared.request.acknowledgement,
      prepared.artifact,
      prepared.catalog.body.generation
      )
    ) {
      const error = licenseRequired();
      this.emit(prepared, {
        state: "license-required",
        operationId: null,
        bytesReceived: 0,
        resumeAvailable: false,
        detail: "Review and accept this exact model license before installing.",
        error: error.detail
      });
      return Promise.reject(error);
    }
    if (this.pendingOperationIds.has(prepared.operationId)) {
      return Promise.reject(
        badRequest("This model-download operation ID is already in use.")
      );
    }
    if (!this.reserveModelId(prepared.artifact.modelId)) {
      return Promise.reject(
        badRequest("A local model operation for this model ID is already running.")
      );
    }

    this.pendingOperationIds.add(prepared.operationId);
    this.operationPhases.set(prepared.operationId, "precommit");
    this.emit(prepared, {
      state: "queued",
      operationId: prepared.operationId,
      bytesReceived: 0,
      resumeAvailable: false,
      detail: "Waiting for the private model download lane.",
      error: null
    });

    return this.downloadLane.enqueue(
      prepared.operationId,
      async (signal) => this.execute(prepared, signal)
    ).catch(async (error: unknown) => {
      const normalized = normalizeDownloadError(error);
      const latestBeforeRecovery = this.statuses.get(prepared.statusKey);
      if (
        latestBeforeRecovery?.state !== "quarantined" &&
        latestBeforeRecovery?.state !== "installed"
      ) {
        const resumableBytes = await this.resumableBytes(prepared).catch(() => 0);
        const latestAfterRecovery = this.statuses.get(prepared.statusKey);
        if (
          latestAfterRecovery?.state !== "quarantined" &&
          latestAfterRecovery?.state !== "installed"
        ) {
          const canResume = resumableBytes > 0;
          this.emit(prepared, {
            state: canResume ? "paused" : "failed",
            operationId: null,
            bytesReceived: resumableBytes,
            resumeAvailable: canResume,
            detail: canResume
              ? "The download paused safely and can resume automatically."
              : "The model download did not create a resumable partial file.",
            error: normalized.detail
          });
        }
      }
      throw normalized;
    }).finally(() => {
      this.releaseModelId(prepared.artifact.modelId);
      this.pendingOperationIds.delete(prepared.operationId);
      this.operationPhases.delete(prepared.operationId);
    });
  }

  cancel(operationId: string): boolean {
    const parsed = ModelInstallCancelRequestSchema.safeParse({ operationId });
    if (
      !parsed.success ||
      this.operationPhases.get(parsed.data.operationId) !== "precommit"
    ) {
      return false;
    }
    return this.downloadLane.cancel(parsed.data.operationId);
  }

  getStatus(
    modelId: string,
    catalogGeneration?: number,
    artifactSha256?: string
  ): ModelInstallStatus | null {
    if (catalogGeneration !== undefined && artifactSha256 !== undefined) {
      return this.statuses.get(statusKey(
        modelId,
        catalogGeneration,
        artifactSha256
      )) ?? null;
    }
    const latestKey = this.latestStatusKeys.get(modelId);
    return latestKey === undefined
      ? null
      : this.statuses.get(latestKey) ?? null;
  }

  snapshot(): ManagedModelInstallerSnapshot {
    const lane = this.downloadLane.snapshot();
    return {
      downloadLane: {
        activeOperationId: lane.activeId,
        queuedOperationIds: [...lane.queuedIds]
      },
      statuses: [...this.statuses.values()]
    };
  }

  private reserveModelId(modelId: string): boolean {
    if (this.pendingModelIds.has(modelId)) {
      return false;
    }
    this.pendingModelIds.add(modelId);
    return true;
  }

  private releaseModelId(modelId: string): void {
    this.pendingModelIds.delete(modelId);
  }

  async probe(input: ManagedModelProbeInput): Promise<ModelInstallStatus> {
    const prepared = this.prepareProbe(input);
    if (!this.reserveModelId(prepared.artifact.modelId)) {
      throw badRequest("A local model operation for this model ID is already running.");
    }
    try {
      await this.prepareStore(prepared.paths);
      await this.assertStoreAncestors(prepared.paths);
      await this.reconcileQuarantine(prepared);

      const existingSize = await this.inspectStoreEntrySize(
        prepared,
        prepared.paths.modelPath,
        "The recovered managed model has an unsafe hardlink identity."
      );
      if (existingSize !== null) {
        try {
          await this.verifyManagedPath(prepared);
          this.emit(prepared, {
            state: "installed",
            operationId: null,
            bytesReceived: prepared.artifact.downloadBytes,
            resumeAvailable: false,
            detail: "Recovered a stably verified managed model from local storage.",
            error: null
          });
        } catch {
          await this.quarantine(
            prepared,
            prepared.paths.modelPath,
            "The recovered managed model failed stable GGUF verification."
          );
        }
        return this.requireStatus(prepared);
      }

      const partial = await this.inspectPartial(prepared, true);
      this.emit(prepared, {
        state: partial.valid && partial.bytes > 0 ? "paused" : "not-installed",
        operationId: null,
        bytesReceived: partial.bytes,
        resumeAvailable: partial.valid && partial.bytes > 0,
        detail: partial.valid && partial.bytes > 0
          ? "Recovered a durable partial download that can resume."
          : "No durable managed model or resumable partial was found.",
        error: null
      });
      return this.requireStatus(prepared);
    } catch (error) {
      const status = this.statuses.get(prepared.statusKey);
      if (status?.state === "quarantined") {
        return status;
      }
      throw error;
    } finally {
      this.releaseModelId(prepared.artifact.modelId);
    }
  }

  /**
   * Privileged daemon-only resolution boundary. This method never downloads,
   * accepts a licence, or trusts a renderer-supplied path. It derives the exact
   * store location from an in-process verified catalog and returns an opaque
   * process-promoted model only after the existing stable verification path
   * succeeds.
   */
  async resolveInstalledModel(
    input: ManagedModelResolveInput,
    signal: AbortSignal
  ): Promise<PromotedManagedModel> {
    const prepared = this.prepareProbe(input);
    if (!this.reserveModelId(prepared.artifact.modelId)) {
      throw busy("The selected managed model is already being checked or changed.");
    }
    try {
      throwIfCancelled(signal);
      await this.prepareStore(prepared.paths);
      await this.assertStoreAncestors(prepared.paths);
      await this.reconcileQuarantine(prepared);
      throwIfCancelled(signal);

      const existingSize = await this.inspectStoreEntrySize(
        prepared,
        prepared.paths.modelPath,
        "The managed model selected for runtime use has an unsafe hardlink identity."
      );
      if (existingSize === null) {
        throw runtimeUnavailable(
          "The selected managed model is not installed and verified."
        );
      }

      try {
        await this.verifyManagedPath(prepared, signal);
      } catch (error) {
        if (isCancellation(error)) {
          throw normalizeCancellation(error);
        }
        if (!isModelIdentityFailure(error)) {
          throw error;
        }
        if (await this.quarantineFailedPath(
          prepared,
          prepared.paths.modelPath,
          "The managed model selected for runtime use failed stable GGUF verification."
        )) {
          throw integrityFailure(
            "The managed model selected for runtime use failed integrity verification."
          );
        }
        throw error;
      }
      throwIfCancelled(signal);

      return promoteVerifiedManagedModel({
        rootDirectory: prepared.paths.rootDirectory,
        modelId: prepared.artifact.modelId,
        displayName: prepared.artifact.displayName,
        modelPath: prepared.paths.modelPath,
        artifactSha256: prepared.artifact.sha256,
        downloadBytes: prepared.artifact.downloadBytes,
        catalogGeneration: prepared.catalog.body.generation,
        target: prepared.target
      });
    } finally {
      this.releaseModelId(prepared.artifact.modelId);
    }
  }

  private prepare(input: ManagedModelInstallInput): PreparedInstall {
    const operation = ModelInstallCancelRequestSchema.safeParse({
      operationId: input.operationId
    });
    const request = ModelInstallRequestSchema.safeParse(input.request);
    const target = ModelTargetSchema.safeParse(input.target);
    if (!operation.success || !request.success || !target.success) {
      throw badRequest("The managed model install request is malformed.");
    }
    const artifact = resolveVerifiedCatalogArtifact(input.catalog, request.data.modelId);
    if (!artifact.eligibleTargets.includes(target.data)) {
      throw badRequest("This model artifact is not approved for the current computer target.");
    }
    const catalogDigest = managedCatalogDigest(input.catalog);
    return {
      operationId: operation.data.operationId,
      catalog: input.catalog,
      artifact,
      request: request.data,
      target: target.data,
      onStatus: input.onStatus,
      catalogDigest,
      statusKey: statusKey(
        artifact.modelId,
        input.catalog.body.generation,
        artifact.sha256
      ),
      paths: deriveManagedModelPaths(
        this.rootDirectory,
        artifact.modelId,
        catalogDigest,
        artifact.sha256
      )
    };
  }

  private prepareProbe(input: ManagedModelProbeInput): PreparedInstall {
    const target = ModelTargetSchema.safeParse(input.target);
    if (!target.success || !MODEL_ID_PATTERN.test(input.modelId)) {
      throw badRequest("The managed model probe request is malformed.");
    }
    const artifact = resolveVerifiedCatalogArtifact(input.catalog, input.modelId);
    if (!artifact.eligibleTargets.includes(target.data)) {
      throw badRequest("This model artifact is not approved for the current computer target.");
    }
    const catalogDigest = managedCatalogDigest(input.catalog);
    return {
      operationId: randomUUID(),
      catalog: input.catalog,
      artifact,
      request: null,
      target: target.data,
      onStatus: input.onStatus,
      catalogDigest,
      statusKey: statusKey(
        artifact.modelId,
        input.catalog.body.generation,
        artifact.sha256
      ),
      paths: deriveManagedModelPaths(
        this.rootDirectory,
        artifact.modelId,
        catalogDigest,
        artifact.sha256
      )
    };
  }

  private async execute(
    prepared: PreparedInstall,
    signal: AbortSignal
  ): Promise<ManagedModelInstallResult> {
    await this.prepareStore(prepared.paths);
    await this.assertStoreAncestors(prepared.paths);
    await this.reconcileQuarantine(prepared);
    throwIfCancelled(signal);

    const existingSize = await this.inspectStoreEntrySize(
      prepared,
      prepared.paths.modelPath,
      "The managed model entry has an unsafe hardlink identity."
    );
    if (existingSize !== null) {
      return this.verifyExisting(prepared, signal, existingSize);
    }

    let partial = await this.inspectPartial(prepared, true);
    if (partial.valid && partial.bytes === prepared.artifact.downloadBytes) {
      return this.verifyAndPromote(prepared, signal, partial.bytes);
    }
    if (!partial.valid) {
      await this.writePartialMetadata(prepared, 0);
      partial = { bytes: 0, valid: true };
    }

    const responsePlan = await this.obtainDownloadResponse(
      prepared,
      partial.bytes,
      signal
    );
    const streamedBytes = await this.streamResponse(
      prepared,
      responsePlan.response,
      responsePlan.startingBytes,
      responsePlan.append,
      signal
    );
    if (streamedBytes < prepared.artifact.downloadBytes) {
      throw downloadFailure(
        "The model download ended before the signed artifact size was reached."
      );
    }
    return this.verifyAndPromote(prepared, signal, streamedBytes);
  }

  private async prepareStore(paths: ManagedModelPaths): Promise<void> {
    for (const path of directoryChain(paths)) {
      await this.fileSystem.ensurePrivateDirectory(path);
    }
  }

  private async assertStoreAncestors(paths: ManagedModelPaths): Promise<void> {
    for (const path of directoryChain(paths)) {
      await this.fileSystem.assertRealDirectory(path);
    }
  }

  private async inspectPartial(
    prepared: PreparedInstall,
    cleanMismatch: boolean
  ): Promise<PartialState> {
    const metadataText = await this.fileSystem.readUtf8(prepared.paths.metadataPath);
    const metadata = metadataText === null
      ? null
      : parsePartialMetadata(metadataText);
    let partialSize = await this.inspectStoreEntrySize(
      prepared,
      prepared.paths.partialPath,
      "The staged model entry has an unsafe hardlink identity."
    );
    const valid = (
      metadata !== null &&
      partialSize !== null &&
      partialMetadataMatches(metadata, prepared) &&
      partialSize >= metadata.completedBytes
    );
    if (
      valid &&
      metadata !== null &&
      partialSize !== null &&
      partialSize > metadata.completedBytes
    ) {
      await this.fileSystem.truncateRegularFile(
        prepared.paths.partialPath,
        metadata.completedBytes
      );
      await this.fileSystem.syncDirectory(prepared.paths.stagingDirectory);
      partialSize = metadata.completedBytes;
    }
    if (!valid && cleanMismatch) {
      await this.discardPartial(prepared);
    }
    return {
      bytes: valid && partialSize !== null ? partialSize : 0,
      valid
    };
  }

  private async writePartialMetadata(
    prepared: PreparedInstall,
    completedBytes: number
  ): Promise<void> {
    const temporaryPath = `${prepared.paths.metadataPath}.${this.nextToken()}.tmp`;
    assertWithinRoot(prepared.paths.rootDirectory, temporaryPath);
    await this.fileSystem.replacePrivateFile(
      prepared.paths.metadataPath,
      temporaryPath,
      JSON.stringify(partialMetadata(prepared, completedBytes))
    );
  }

  private async discardPartial(prepared: PreparedInstall): Promise<void> {
    await Promise.all([
      this.fileSystem.removeFile(prepared.paths.metadataPath),
      this.fileSystem.removeFile(prepared.paths.partialPath)
    ]);
    await this.fileSystem.syncDirectory(prepared.paths.stagingDirectory);
  }

  private async obtainDownloadResponse(
    prepared: PreparedInstall,
    requestedOffset: number,
    signal: AbortSignal
  ): Promise<{
    response: ModelDownloadHttpResponse;
    startingBytes: number;
    append: boolean;
  }> {
    const first = await this.requestDownload(prepared, requestedOffset, signal);
    try {
      const plan = validateResponse(
        first,
        requestedOffset,
        prepared.artifact.downloadBytes
      );
      if (requestedOffset > 0 && !plan.append) {
        await this.discardPartial(prepared);
        await this.writePartialMetadata(prepared, 0);
      }
      return {
        response: first,
        startingBytes: plan.append ? requestedOffset : 0,
        append: plan.append
      };
    } catch (error) {
      if (!(error instanceof ResumeResponseMismatch) || requestedOffset === 0) {
        await disposeModelDownloadResponse(first);
        throw error;
      }
      await disposeModelDownloadResponse(first);
      await this.discardPartial(prepared);
      await this.writePartialMetadata(prepared, 0);
      const fresh = await this.requestDownload(prepared, 0, signal);
      try {
        const freshPlan = validateResponse(
          fresh,
          0,
          prepared.artifact.downloadBytes
        );
        return {
          response: fresh,
          startingBytes: 0,
          append: freshPlan.append
        };
      } catch (freshError) {
        await disposeModelDownloadResponse(fresh);
        throw freshError;
      }
    }
  }

  private requestDownload(
    prepared: PreparedInstall,
    offset: number,
    signal: AbortSignal
  ): Promise<ModelDownloadHttpResponse> {
    const headers: Record<string, string> = {
      "accept": "application/octet-stream",
      "accept-encoding": "identity"
    };
    if (offset > 0) {
      headers["range"] = `bytes=${offset}-`;
    }
    return requestModelArtifact(
      this.transport,
      prepared.artifact.downloadUrl,
      headers,
      signal,
      this.redirectPolicy
    );
  }

  private async streamResponse(
    prepared: PreparedInstall,
    response: ModelDownloadHttpResponse,
    startingBytes: number,
    append: boolean,
    signal: AbortSignal
  ): Promise<number> {
    let bytesReceived = startingBytes;
    let durableBytes = startingBytes;
    let writer: ManagedModelWritableFile | null = null;
    let streamCompleted = false;
    let writerSyncFailed = false;
    const observationHash = createHash("sha256");
    let observedResponseBytes = 0;
    let overflowObservation: StreamObservation | null = null;
    try {
      if (!append) {
        await this.fileSystem.removeFile(prepared.paths.partialPath);
        await this.writePartialMetadata(prepared, 0);
      }
      this.emit(prepared, {
        state: "downloading",
        operationId: prepared.operationId,
        bytesReceived,
        resumeAvailable: bytesReceived > 0,
        detail: append
          ? "Resuming the verified model download."
          : "Downloading the model into private local staging.",
        error: null
      });

      writer = await this.fileSystem.openWritable(
        prepared.paths.partialPath,
        append,
        startingBytes
      );
      for await (const chunk of response.body!) {
        throwIfCancelled(signal);
        if (!(chunk instanceof Uint8Array)) {
          throw downloadFailure("The model-download server returned an invalid data chunk.");
        }
        if (chunk.byteLength === 0) {
          continue;
        }
        observationHash.update(chunk);
        observedResponseBytes += chunk.byteLength;
        const remaining = prepared.artifact.downloadBytes - bytesReceived;
        const accepted = chunk.byteLength > remaining
          ? chunk.subarray(0, Math.max(0, remaining))
          : chunk;
        let acceptedOffset = 0;
        while (acceptedOffset < accepted.byteLength) {
          const bytesUntilCheckpoint =
            DURABILITY_CHECKPOINT_BYTES - (bytesReceived - durableBytes);
          const sliceLength = Math.min(
            accepted.byteLength - acceptedOffset,
            bytesUntilCheckpoint
          );
          await writer.write(
            accepted.subarray(acceptedOffset, acceptedOffset + sliceLength)
          );
          acceptedOffset += sliceLength;
          bytesReceived += sliceLength;
          if (bytesReceived - durableBytes === DURABILITY_CHECKPOINT_BYTES) {
            try {
              await writer.sync();
            } catch (error) {
              writerSyncFailed = true;
              throw error;
            }
            await this.writePartialMetadata(prepared, bytesReceived);
            durableBytes = bytesReceived;
          }
        }
        this.emit(prepared, {
          state: "downloading",
          operationId: prepared.operationId,
          bytesReceived,
          resumeAvailable: durableBytes > 0,
          detail: "Downloading the model into private local staging.",
          error: null
        });
        if (chunk.byteLength > remaining) {
          overflowObservation = {
            observedStreamStartOffset: startingBytes,
            observedStreamBytesAtLeast: observedResponseBytes,
            observedStreamPrefixSha256: observationHash.copy().digest("hex"),
            streamObservationComplete: false
          };
          break;
        }
      }
      throwIfCancelled(signal);
      try {
        await writer.sync();
      } catch (error) {
        writerSyncFailed = true;
        throw error;
      }
      await this.writePartialMetadata(prepared, bytesReceived);
      durableBytes = bytesReceived;
      streamCompleted = true;
    } finally {
      try {
        if (!streamCompleted && writer !== null && !writerSyncFailed) {
          try {
            await writer.sync();
            if (bytesReceived <= prepared.artifact.downloadBytes) {
              await this.writePartialMetadata(prepared, bytesReceived);
            }
          } catch {
            // Preserve the previous durable checkpoint when sync or metadata fails.
          }
        }
        if (streamCompleted) {
          await writer?.close();
        } else {
          await writer?.close().catch(() => undefined);
        }
      } finally {
        await disposeModelDownloadResponse(response);
      }
    }

    if (overflowObservation !== null) {
      await this.quarantine(
        prepared,
        prepared.paths.partialPath,
        "The download exceeded the signed artifact size.",
        overflowObservation
      );
      throw integrityFailure("The model download exceeded the signed artifact size.");
    }
    return bytesReceived;
  }

  private async verifyExisting(
    prepared: PreparedInstall,
    signal: AbortSignal,
    bytes: number
  ): Promise<ManagedModelInstallResult> {
    this.emit(prepared, {
      state: "verifying",
      operationId: prepared.operationId,
      bytesReceived: bytes,
      resumeAvailable: false,
      detail: "Verifying the existing managed model through a stable local handle.",
      error: null
    });
    let handle: ManagedModelReadHandle | null = null;
    let pathHandle: ManagedModelReadHandle | null = null;
    try {
      await this.assertStoreAncestors(prepared.paths);
      handle = await this.fileSystem.openStableRead(prepared.paths.modelPath);
      const verified = await verifyStableGguf(
        handle,
        prepared.artifact,
        signal
      );
      await handle.sync();
      throwIfCancelled(signal);
      this.operationPhases.set(prepared.operationId, "committing");
      this.emitCommitBoundary(prepared, bytes);
      await this.onCommitStarted?.({
        operationId: prepared.operationId,
        modelId: prepared.artifact.modelId,
        stagingPath: prepared.paths.modelPath,
        destinationPath: prepared.paths.modelPath
      });
      await this.assertStoreAncestors(prepared.paths);
      pathHandle = await this.fileSystem.openStableRead(prepared.paths.modelPath);
      const pathIdentity = await pathHandle.identity();
      if (!sameFileObject(verified.identity, pathIdentity)) {
        throw integrityFailure("The managed model path no longer names the verified file.");
      }
      const pathVerification = await verifyStableGguf(
        pathHandle,
        prepared.artifact
      );
      const after = await handle.identity();
      if (
        !sameStableIdentity(verified.identity, after) ||
        !sameContentIdentity(verified.identity, pathVerification.identity)
      ) {
        throw integrityFailure("The installed model changed after verification.");
      }
      await pathHandle.close();
      pathHandle = null;
      await handle.close();
      handle = null;
      return this.complete(prepared);
    } catch (error) {
      await pathHandle?.close().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      if (isCancellation(error)) {
        throw error;
      }
      if (await this.quarantineFailedPath(
        prepared,
        prepared.paths.modelPath,
        "The existing managed model failed stable GGUF verification."
      )) {
        throw integrityFailure("The existing managed model failed integrity verification.");
      }
      throw error;
    }
  }

  private async verifyManagedPath(
    prepared: PreparedInstall,
    signal?: AbortSignal
  ): Promise<void> {
    let first: ManagedModelReadHandle | null = null;
    let second: ManagedModelReadHandle | null = null;
    try {
      await this.assertStoreAncestors(prepared.paths);
      first = await this.fileSystem.openStableRead(prepared.paths.modelPath);
      const firstVerification = await verifyStableGguf(
        first,
        prepared.artifact,
        signal
      );
      signal?.throwIfAborted();
      second = await this.fileSystem.openStableRead(prepared.paths.modelPath);
      const secondIdentity = await second.identity();
      if (!sameFileObject(firstVerification.identity, secondIdentity)) {
        throw integrityFailure("The recovered managed model path changed during verification.");
      }
      const secondVerification = await verifyStableGguf(
        second,
        prepared.artifact,
        signal
      );
      const firstAfter = await first.identity();
      if (
        !sameStableIdentity(firstVerification.identity, firstAfter) ||
        !sameContentIdentity(
          firstVerification.identity,
          secondVerification.identity
        )
      ) {
        throw integrityFailure("The recovered managed model changed during verification.");
      }
    } finally {
      await second?.close().catch(() => undefined);
      await first?.close().catch(() => undefined);
    }
  }

  private async verifyAndPromote(
    prepared: PreparedInstall,
    signal: AbortSignal,
    bytesReceived: number
  ): Promise<ManagedModelInstallResult> {
    this.emit(prepared, {
      state: "verifying",
      operationId: prepared.operationId,
      bytesReceived,
      resumeAvailable: true,
      detail: "Verifying GGUF v3, exact size, and SHA-256 from one stable file handle.",
      error: null
    });

    let sourceHandle: ManagedModelReadHandle | null = null;
    let destinationHandle: ManagedModelReadHandle | null = null;
    let committed = false;
    try {
      await this.assertStoreAncestors(prepared.paths);
      sourceHandle = await this.fileSystem.openStableRead(prepared.paths.partialPath);
      const sourceVerification = await verifyStableGguf(
        sourceHandle,
        prepared.artifact,
        signal
      );
      await sourceHandle.sync();
      throwIfCancelled(signal);

      this.operationPhases.set(prepared.operationId, "committing");
      this.emitCommitBoundary(prepared, bytesReceived);
      await this.onCommitStarted?.({
        operationId: prepared.operationId,
        modelId: prepared.artifact.modelId,
        stagingPath: prepared.paths.partialPath,
        destinationPath: prepared.paths.modelPath
      });
      await this.assertStoreAncestors(prepared.paths);
      const promotion = await this.fileSystem.moveNoReplace(
        prepared.paths.partialPath,
        prepared.paths.modelPath
      );
      if (!promotion.moved) {
        throw integrityFailure("The managed model destination already exists.");
      }
      committed = true;

      destinationHandle = await this.fileSystem.openStableRead(prepared.paths.modelPath);
      const destinationIdentity = await destinationHandle.identity();
      if (!sameFileObject(sourceVerification.identity, destinationIdentity)) {
        throw integrityFailure("The promoted model is not the file that was verified.");
      }
      const destinationVerification = await verifyStableGguf(
        destinationHandle,
        prepared.artifact
      );
      const sourceAfterPromotion = await sourceHandle.identity();
      if (
        !sameContentIdentity(sourceVerification.identity, sourceAfterPromotion) ||
        !sameContentIdentity(
          sourceVerification.identity,
          destinationVerification.identity
        )
      ) {
        throw integrityFailure("The model changed across its promotion boundary.");
      }

      await destinationHandle.close();
      destinationHandle = null;
      await sourceHandle.close();
      sourceHandle = null;
      await this.assertStoreAncestors(prepared.paths);
      await this.fileSystem.syncDirectory(prepared.paths.modelDirectory);
      await this.fileSystem.removeFile(prepared.paths.metadataPath);
      await this.fileSystem.syncDirectory(prepared.paths.stagingDirectory);
      return this.complete(prepared);
    } catch (error) {
      await destinationHandle?.close().catch(() => undefined);
      await sourceHandle?.close().catch(() => undefined);
      if (isCancellation(error) && !committed) {
        throw error;
      }
      const quarantineSource = committed
        ? prepared.paths.modelPath
        : prepared.paths.partialPath;
      if (await this.quarantineFailedPath(
        prepared,
        quarantineSource,
        "The staged model failed stable verification or promotion identity checks."
      )) {
        throw integrityFailure(
          "The staged model failed stable verification or promotion identity checks."
        );
      }
      throw error;
    }
  }

  private complete(prepared: PreparedInstall): ManagedModelInstallResult {
    const installedAt = this.safeNow().toISOString();
    this.emit(prepared, {
      state: "installed",
      operationId: prepared.operationId,
      bytesReceived: prepared.artifact.downloadBytes,
      resumeAvailable: false,
      detail: "The model is verified and installed; runtime readiness is checked separately.",
      error: null
    }, installedAt);
    return {
      modelId: prepared.artifact.modelId,
      modelPath: prepared.paths.modelPath,
      artifactSha256: prepared.artifact.sha256,
      downloadBytes: prepared.artifact.downloadBytes,
      catalogGeneration: prepared.catalog.body.generation,
      installedAt
    };
  }

  private async inspectStoreEntrySize(
    prepared: PreparedInstall,
    sourcePath: string,
    reason: string
  ): Promise<number | null> {
    try {
      return await this.fileSystem.regularFileSize(sourcePath);
    } catch (error) {
      if (!(error instanceof UnsafeManagedModelHardlinkError)) {
        throw error;
      }
      await this.revokeUnsafeHardlink(prepared, sourcePath, reason);
      throw integrityFailure(reason);
    }
  }

  private async quarantineFailedPath(
    prepared: PreparedInstall,
    sourcePath: string,
    reason: string
  ): Promise<boolean> {
    let sourceSize: number | null;
    try {
      sourceSize = await this.fileSystem.regularFileSize(sourcePath);
    } catch (error) {
      if (!(error instanceof UnsafeManagedModelHardlinkError)) {
        throw error;
      }
      await this.revokeUnsafeHardlink(prepared, sourcePath, reason);
      return true;
    }
    if (sourceSize === null) {
      return false;
    }
    await this.quarantine(prepared, sourcePath, reason);
    return true;
  }

  private async revokeUnsafeHardlink(
    prepared: PreparedInstall,
    sourcePath: string,
    reason: string
  ): Promise<void> {
    const reservation = await this.reservePendingQuarantine(
      prepared,
      sourcePath,
      `${reason} An unsafe hardlink identity was revoked.`
    );
    await this.fileSystem.removeFile(sourcePath);
    await this.fileSystem.syncDirectory(dirname(sourcePath));
    await this.fileSystem.removeFile(prepared.paths.metadataPath);
    await this.fileSystem.syncDirectory(prepared.paths.stagingDirectory);
    await this.finalizeQuarantineReceipt(
      prepared,
      reservation.receiptPath,
      reservation.evidence,
      null
    );
    await this.fileSystem.syncDirectory(prepared.paths.quarantineDirectory);

    const error = integrityFailure(reason);
    this.emit(prepared, {
      state: "quarantined",
      operationId: null,
      bytesReceived: 0,
      resumeAvailable: false,
      detail: "The unsafe managed-store entry was revoked without modifying its outside alias.",
      error: error.detail
    });
  }

  private async quarantine(
    prepared: PreparedInstall,
    sourcePath: string,
    reason: string,
    streamObservation?: StreamObservation
  ): Promise<void> {
    const reservation = await this.reservePendingQuarantine(
      prepared,
      sourcePath,
      reason,
      streamObservation
    );
    const {
      quarantinePath,
      receiptPath,
      evidence: pendingEvidence
    } = reservation;

    const movement = await this.fileSystem.moveNoReplace(
      sourcePath,
      quarantinePath
    );
    if (!movement.moved) {
      throw storageFailure(
        "Could not reserve a unique quarantine artifact path; pending evidence was preserved."
      );
    }
    const observed = await hashStableFile(
      this.fileSystem,
      quarantinePath
    );
    await this.finalizeQuarantineReceipt(
      prepared,
      receiptPath,
      pendingEvidence,
      observed
    );
    await this.fileSystem.removeFile(prepared.paths.metadataPath);
    await this.fileSystem.syncDirectory(dirname(sourcePath));
    await this.fileSystem.syncDirectory(prepared.paths.stagingDirectory);
    await this.fileSystem.syncDirectory(prepared.paths.quarantineDirectory);

    const error = integrityFailure(reason);
    this.emit(prepared, {
      state: "quarantined",
      operationId: null,
      bytesReceived: observed.bytes,
      resumeAvailable: false,
      detail: "The untrusted file and its verified evidence were isolated.",
      error: error.detail
    });
  }

  private async reservePendingQuarantine(
    prepared: PreparedInstall,
    sourcePath: string,
    reason: string,
    streamObservation?: StreamObservation
  ): Promise<PendingQuarantineReservation> {
    await this.assertStoreAncestors(prepared.paths);
    const token = this.nextToken();
    const quarantinePath = join(
      prepared.paths.quarantineDirectory,
      `${prepared.artifact.sha256}.${prepared.operationId}.${token}.gguf`
    );
    const receiptPath = `${quarantinePath}.json`;
    assertWithinRoot(prepared.paths.rootDirectory, quarantinePath);
    assertWithinRoot(prepared.paths.rootDirectory, receiptPath);

    const pendingEvidence: PendingQuarantineEvidence = {
      schemaVersion: 2,
      state: "pending-quarantine-evidence",
      modelId: prepared.artifact.modelId,
      expectedSha256: prepared.artifact.sha256,
      expectedBytes: prepared.artifact.downloadBytes,
      sourceKind: sourcePath === prepared.paths.modelPath ? "managed" : "staging",
      reason,
      quarantinedAt: this.safeNow().toISOString(),
      observedStreamStartOffset:
        streamObservation?.observedStreamStartOffset ?? null,
      observedStreamBytesAtLeast:
        streamObservation?.observedStreamBytesAtLeast ?? null,
      observedStreamPrefixSha256:
        streamObservation?.observedStreamPrefixSha256 ?? null,
      streamObservationComplete:
        streamObservation?.streamObservationComplete ?? null
    };
    const reserved = await this.fileSystem.writeExclusivePrivateFile(
      receiptPath,
      JSON.stringify(pendingEvidence)
    );
    if (!reserved) {
      throw storageFailure("Could not reserve a unique quarantine evidence path.");
    }
    await this.fileSystem.syncDirectory(prepared.paths.quarantineDirectory);

    const error = integrityFailure(reason);
    this.emit(prepared, {
      state: "quarantined",
      operationId: null,
      bytesReceived: 0,
      resumeAvailable: false,
      detail: "Durable quarantine evidence was recorded; artifact isolation is being finalized.",
      error: error.detail
    });
    return {
      quarantinePath,
      receiptPath,
      evidence: pendingEvidence
    };
  }

  private async reconcileQuarantine(prepared: PreparedInstall): Promise<void> {
    const prefix = `${prepared.artifact.sha256}.`;
    const receiptNames = (await this.fileSystem.listDirectory(
      prepared.paths.quarantineDirectory
    )).filter((name) => (
      name.length <= 512 &&
      name.startsWith(prefix) &&
      name.endsWith(".gguf.json") &&
      !name.includes("/") &&
      !name.includes("\\")
    ));
    if (receiptNames.length === 0) {
      return;
    }

    let quarantinedBytes = 0;
    for (const receiptName of receiptNames) {
      const receiptPath = join(
        prepared.paths.quarantineDirectory,
        receiptName
      );
      assertWithinRoot(prepared.paths.rootDirectory, receiptPath);
      const text = await this.fileSystem.readUtf8(receiptPath);
      const record = text === null ? null : parseJsonRecord(text);
      if (record?.state === "pending-quarantine-evidence") {
        quarantinedBytes = Math.max(
          quarantinedBytes,
          await this.recoverPendingQuarantine(
            prepared,
            receiptPath,
            coercePendingEvidence(record, prepared)
          )
        );
      } else {
        const receiptBytes = record?.quarantinedBytes;
        if (
          typeof receiptBytes === "number" &&
          Number.isSafeInteger(receiptBytes) &&
          receiptBytes >= 0
        ) {
          quarantinedBytes = Math.max(quarantinedBytes, receiptBytes);
        }
      }
    }

    const error = integrityFailure(
      "This exact artifact pin has durable quarantine evidence and is revoked."
    );
    this.emit(prepared, {
      state: "quarantined",
      operationId: null,
      bytesReceived: quarantinedBytes,
      resumeAvailable: false,
      detail: "This artifact pin remains quarantined and cannot be installed again.",
      error: error.detail
    });
    throw error;
  }

  private async recoverPendingQuarantine(
    prepared: PreparedInstall,
    receiptPath: string,
    pending: PendingQuarantineEvidence
  ): Promise<number> {
    const quarantinePath = receiptPath.slice(0, -".json".length);
    assertWithinRoot(prepared.paths.rootDirectory, quarantinePath);
    let quarantineSize: number | null;
    let recoveredSourceDirectory: string | null = null;
    try {
      quarantineSize = await this.fileSystem.regularFileSize(quarantinePath);
    } catch (error) {
      if (!isSecurityBoundaryError(error)) {
        throw error;
      }
      await this.fileSystem.removeFile(quarantinePath);
      quarantineSize = null;
    }
    if (quarantineSize === null) {
      const preferredSource = pending.sourceKind === "managed"
        ? prepared.paths.modelPath
        : prepared.paths.partialPath;
      const alternateSource = pending.sourceKind === "managed"
        ? prepared.paths.partialPath
        : prepared.paths.modelPath;
      for (const sourcePath of [preferredSource, alternateSource]) {
        let sourceSize: number | null;
        try {
          sourceSize = await this.fileSystem.regularFileSize(sourcePath);
        } catch (error) {
          if (!isSecurityBoundaryError(error)) {
            throw error;
          }
          await this.fileSystem.removeFile(sourcePath);
          continue;
        }
        if (sourceSize === null) {
          continue;
        }
        const movement = await this.fileSystem.moveNoReplace(
          sourcePath,
          quarantinePath
        );
        if (!movement.moved) {
          throw storageFailure(
            "Could not recover a pending quarantine artifact without replacing evidence."
          );
        }
        quarantineSize = sourceSize;
        recoveredSourceDirectory = dirname(sourcePath);
        break;
      }
    }

    const observed = quarantineSize === null
      ? null
      : await hashStableFile(this.fileSystem, quarantinePath);
    await this.finalizeQuarantineReceipt(
      prepared,
      receiptPath,
      pending,
      observed
    );
    await this.fileSystem.removeFile(prepared.paths.metadataPath);
    if (recoveredSourceDirectory !== null) {
      await this.fileSystem.syncDirectory(recoveredSourceDirectory);
    }
    await this.fileSystem.syncDirectory(prepared.paths.stagingDirectory);
    await this.fileSystem.syncDirectory(prepared.paths.quarantineDirectory);
    return observed?.bytes ?? 0;
  }

  private async finalizeQuarantineReceipt(
    prepared: PreparedInstall,
    receiptPath: string,
    pending: PendingQuarantineEvidence,
    observed: { bytes: number; digest: string } | null
  ): Promise<void> {
    const temporaryReceiptPath = `${receiptPath}.${this.nextToken()}.tmp`;
    assertWithinRoot(prepared.paths.rootDirectory, temporaryReceiptPath);
    await this.fileSystem.replacePrivateFile(
      receiptPath,
      temporaryReceiptPath,
      JSON.stringify({
        schemaVersion: 2,
        state: "quarantined",
        modelId: pending.modelId,
        expectedSha256: pending.expectedSha256,
        expectedBytes: pending.expectedBytes,
        quarantinedSha256: observed?.digest ?? null,
        quarantinedBytes: observed?.bytes ?? 0,
        quarantineArtifactMissing: observed === null,
        reason: pending.reason,
        quarantinedAt: pending.quarantinedAt,
        observedStreamStartOffset: pending.observedStreamStartOffset,
        observedStreamBytesAtLeast: pending.observedStreamBytesAtLeast,
        observedStreamPrefixSha256: pending.observedStreamPrefixSha256,
        streamObservationComplete: pending.streamObservationComplete
      })
    );
  }

  private async resumableBytes(prepared: PreparedInstall): Promise<number> {
    const state = await this.inspectPartial(prepared, false);
    return state.valid ? state.bytes : 0;
  }

  private emit(
    prepared: PreparedInstall,
    change: Pick<
      ModelInstallStatus,
      "state" |
      "operationId" |
      "bytesReceived" |
      "resumeAvailable" |
      "detail" |
      "error"
    >,
    updatedAt = this.safeNow().toISOString()
  ): void {
    const status: ModelInstallStatus = {
      modelId: prepared.artifact.modelId,
      state: change.state,
      operationId: change.operationId,
      catalogGeneration: prepared.catalog.body.generation,
      artifactSha256: prepared.artifact.sha256,
      bytesReceived: change.bytesReceived,
      totalBytes: prepared.artifact.downloadBytes,
      resumeAvailable: change.resumeAvailable,
      detail: change.detail,
      error: change.error,
      updatedAt
    };
    this.statuses.set(prepared.statusKey, status);
    this.latestStatusKeys.set(status.modelId, prepared.statusKey);
    try {
      prepared.onStatus?.(status);
    } catch {
      // Status observers cannot affect the privileged download state machine.
    }
  }

  private emitCommitBoundary(
    prepared: PreparedInstall,
    bytesReceived: number
  ): void {
    this.emit(prepared, {
      state: "verifying",
      operationId: null,
      bytesReceived,
      resumeAvailable: false,
      detail: "Verification passed; atomic managed-store commit is in progress.",
      error: null
    });
  }

  private requireStatus(prepared: PreparedInstall): ModelInstallStatus {
    const status = this.statuses.get(prepared.statusKey);
    if (status === undefined) {
      throw new RuntimeBoundaryError({
        code: "UNKNOWN",
        message: "The managed model status was not recorded.",
        retryable: false
      });
    }
    return status;
  }

  private nextToken(): string {
    const raw = this.uniqueId();
    if (!SAFE_TOKEN_PATTERN.test(raw)) {
      throw storageFailure("The managed model unique ID source returned an unsafe value.");
    }
    this.uniqueCounter += 1;
    return `${raw}-${this.uniqueCounter}`;
  }

  private safeNow(): Date {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new RuntimeBoundaryError({
        code: "UNKNOWN",
        message: "The managed model installer clock is invalid.",
        retryable: false
      });
    }
    return value;
  }
}

export function managedCatalogDigest(catalog: SignedModelCatalog): string {
  return createHash("sha256").update(catalogSigningBytes(catalog)).digest("hex");
}

export function deriveManagedModelPaths(
  rootDirectory: string,
  modelId: string,
  catalogDigest: string,
  artifactSha256: string
): ManagedModelPaths {
  if (rootDirectory.trim() === "") {
    throw badRequest("The managed model store directory is required.");
  }
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw badRequest("The managed model ID is unsafe.");
  }
  if (!SHA256_PATTERN.test(catalogDigest) || !SHA256_PATTERN.test(artifactSha256)) {
    throw badRequest("The managed model artifact identity is invalid.");
  }

  const root = resolve(rootDirectory);
  if (dirname(root) === root) {
    throw badRequest("The managed model store cannot use a filesystem root.");
  }
  const stagingKey = createHash("sha256")
    .update(`${modelId}\0${catalogDigest}\0${artifactSha256}`, "utf8")
    .digest("hex");
  const modelDirectory = join(root, "models", modelId);
  const modelPath = join(modelDirectory, `${artifactSha256}.gguf`);
  const stagingDirectory = join(root, ".staging", stagingKey);
  const partialPath = join(stagingDirectory, `${artifactSha256}.partial`);
  const metadataPath = join(stagingDirectory, `${artifactSha256}.json`);
  const quarantineDirectory = join(root, "quarantine", modelId);

  for (const path of [
    modelDirectory,
    modelPath,
    stagingDirectory,
    partialPath,
    metadataPath,
    quarantineDirectory
  ]) {
    assertWithinRoot(root, path);
  }
  return {
    rootDirectory: root,
    modelDirectory,
    modelPath,
    stagingDirectory,
    partialPath,
    metadataPath,
    quarantineDirectory
  };
}

function partialMetadata(
  prepared: PreparedInstall,
  completedBytes: number
): PartialDownloadMetadata {
  return {
    schemaVersion: 2,
    catalogId: prepared.catalog.body.catalogId,
    catalogGeneration: prepared.catalog.body.generation,
    catalogDigest: prepared.catalogDigest,
    modelId: prepared.artifact.modelId,
    artifactSha256: prepared.artifact.sha256,
    repositoryRevision: prepared.artifact.repositoryRevision,
    filename: prepared.artifact.filename,
    downloadUrl: prepared.artifact.downloadUrl,
    downloadBytes: prepared.artifact.downloadBytes,
    completedBytes
  };
}

function parsePartialMetadata(text: string): PartialDownloadMetadata | null {
  return parseJsonRecord(text) as PartialDownloadMetadata | null;
}

function partialMetadataMatches(
  candidate: PartialDownloadMetadata,
  prepared: PreparedInstall
): boolean {
  const expected = partialMetadata(prepared, candidate.completedBytes);
  const record = candidate as unknown as Record<string, unknown>;
  const expectedRecord = expected as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  return (
    Number.isSafeInteger(candidate.completedBytes) &&
    candidate.completedBytes >= 0 &&
    candidate.completedBytes <= prepared.artifact.downloadBytes &&
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => record[key] === expectedRecord[key])
  );
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function coercePendingEvidence(
  record: Record<string, unknown>,
  prepared: PreparedInstall
): PendingQuarantineEvidence {
  const sourceKind = record.sourceKind === "managed" ? "managed" : "staging";
  const reason = typeof record.reason === "string" && record.reason.trim() !== ""
    ? record.reason
    : "A previous install was interrupted while quarantining this artifact pin.";
  const quarantinedAt = typeof record.quarantinedAt === "string"
    ? record.quarantinedAt
    : new Date(0).toISOString();
  return {
    schemaVersion: 2,
    state: "pending-quarantine-evidence",
    modelId: prepared.artifact.modelId,
    expectedSha256: prepared.artifact.sha256,
    expectedBytes: prepared.artifact.downloadBytes,
    sourceKind,
    reason,
    quarantinedAt,
    observedStreamStartOffset: safeNullableInteger(
      record.observedStreamStartOffset
    ),
    observedStreamBytesAtLeast: safeNullableInteger(
      record.observedStreamBytesAtLeast
    ),
    observedStreamPrefixSha256:
      typeof record.observedStreamPrefixSha256 === "string" &&
        SHA256_PATTERN.test(record.observedStreamPrefixSha256)
        ? record.observedStreamPrefixSha256
        : null,
    streamObservationComplete:
      typeof record.streamObservationComplete === "boolean"
        ? record.streamObservationComplete
        : null
  };
}

function safeNullableInteger(value: unknown): number | null {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
    ? value
    : null;
}

function validateResponse(
  response: ModelDownloadHttpResponse,
  requestedOffset: number,
  totalBytes: number
): { append: boolean } {
  if (response.body === null) {
    throw downloadFailure("The model-download server returned no response body.");
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (
    contentEncoding !== null &&
    contentEncoding.trim().toLowerCase() !== "identity"
  ) {
    throw downloadFailure(
      "The model-download server returned encoded bytes instead of the pinned artifact."
    );
  }
  if (requestedOffset === 0) {
    if (response.status !== 200) {
      throw downloadFailure(
        `The model-download server returned HTTP ${response.status} for a fresh download.`
      );
    }
    assertContentLength(response, totalBytes, false);
    return { append: false };
  }
  if (response.status === 200) {
    assertContentLength(response, totalBytes, false);
    return { append: false };
  }
  if (response.status !== 206) {
    throw downloadFailure(
      `The model-download server returned HTTP ${response.status} for a resume request.`
    );
  }

  const contentRange = response.headers.get("content-range");
  const parsedRange = contentRange === null ? null : parseContentRange(contentRange);
  if (
    parsedRange === null ||
    parsedRange.start !== requestedOffset ||
    parsedRange.end !== totalBytes - 1 ||
    parsedRange.total !== totalBytes
  ) {
    throw new ResumeResponseMismatch(
      "The model-download server returned a mismatched resume range."
    );
  }
  assertContentLength(response, totalBytes - requestedOffset, true);
  return { append: true };
}

function parseContentRange(
  value: string
): { start: number; end: number; total: number } | null {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(value);
  if (match === null) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

function assertContentLength(
  response: ModelDownloadHttpResponse,
  expectedBytes: number,
  resume: boolean
): void {
  const value = response.headers.get("content-length");
  if (value === null) {
    return;
  }
  if (!/^[0-9]+$/.test(value) || Number(value) !== expectedBytes) {
    if (resume) {
      throw new ResumeResponseMismatch(
        "The resumed model download returned a mismatched Content-Length."
      );
    }
    throw downloadFailure(
      "The model-download Content-Length did not match the signed artifact size."
    );
  }
}

async function verifyStableGguf(
  handle: ManagedModelReadHandle,
  artifact: PinnedModelArtifact,
  signal?: AbortSignal
): Promise<StableVerification> {
  signal?.throwIfAborted();
  const before = await handle.identity();
  signal?.throwIfAborted();
  const header = await handle.read(0, GGUF_HEADER_BYTES);
  signal?.throwIfAborted();
  let formatError: unknown = null;
  try {
    parseBoundedGgufV3Header(header, BigInt(before.size));
  } catch (error) {
    formatError = error;
  }

  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of handle.chunks(signal)) {
    signal?.throwIfAborted();
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  signal?.throwIfAborted();
  const digest = hash.digest("hex");
  const after = await handle.identity();
  signal?.throwIfAborted();
  if (!sameStableIdentity(before, after) || bytes !== before.size) {
    throw integrityFailure("The model file changed while it was being verified.");
  }
  if (formatError !== null) {
    throw integrityFailure("The signed artifact is not a supported bounded GGUF v3 file.");
  }
  if (bytes !== artifact.downloadBytes || digest !== artifact.sha256) {
    throw integrityFailure("The model did not match its signed size and SHA-256 digest.");
  }
  return {
    identity: after,
    bytes,
    digest
  };
}

async function hashStableFile(
  fileSystem: ManagedModelFileSystem,
  path: string
): Promise<{ bytes: number; digest: string }> {
  const handle = await fileSystem.openStableRead(path);
  try {
    const before = await handle.identity();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.chunks()) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    const after = await handle.identity();
    if (!sameStableIdentity(before, after) || bytes !== before.size) {
      throw integrityFailure("The quarantined artifact changed during evidence capture.");
    }
    return { bytes, digest: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

function sameStableIdentity(
  left: ManagedFileIdentity,
  right: ManagedFileIdentity
): boolean {
  return (
    sameContentIdentity(left, right) &&
    left.changedNanoseconds === right.changedNanoseconds &&
    left.hardLinks === right.hardLinks
  );
}

function sameContentIdentity(
  left: ManagedFileIdentity,
  right: ManagedFileIdentity
): boolean {
  return (
    sameFileObject(left, right) &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds
  );
}

function sameFileObject(
  left: ManagedFileIdentity,
  right: ManagedFileIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function directoryChain(paths: ManagedModelPaths): readonly string[] {
  return [
    paths.rootDirectory,
    join(paths.rootDirectory, "models"),
    paths.modelDirectory,
    join(paths.rootDirectory, ".staging"),
    paths.stagingDirectory,
    join(paths.rootDirectory, "quarantine"),
    paths.quarantineDirectory
  ];
}

function statusKey(
  modelId: string,
  catalogGeneration: number,
  artifactSha256: string
): string {
  return `${modelId}\0${catalogGeneration}\0${artifactSha256}`;
}

function assertWithinRoot(rootDirectory: string, candidate: string): void {
  const pathFromRoot = relative(rootDirectory, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new RuntimeBoundaryError({
      code: "SECURITY_BOUNDARY",
      message: "A managed model path escaped its private store boundary.",
      retryable: false
    });
  }
}

function normalizeDownloadError(error: unknown): RuntimeBoundaryError {
  if (error instanceof RuntimeBoundaryError) {
    return error;
  }
  if (error instanceof ResumeResponseMismatch) {
    return downloadFailure(error.message);
  }
  const desktopError: DesktopError = toDesktopError(error);
  if (desktopError.code === "CANCELLED") {
    return new RuntimeBoundaryError(desktopError, { cause: error });
  }
  return new RuntimeBoundaryError({
    code: "DOWNLOAD_FAILED",
    message: "The model download failed before it could be verified.",
    retryable: true
  }, { cause: error });
}

function isSecurityBoundaryError(error: unknown): boolean {
  return (
    error instanceof RuntimeBoundaryError &&
    error.detail.code === "SECURITY_BOUNDARY"
  );
}

function isModelIdentityFailure(error: unknown): boolean {
  return (
    error instanceof RuntimeBoundaryError &&
    (
      error.detail.code === "INTEGRITY_FAILED" ||
      error.detail.code === "SECURITY_BOUNDARY"
    )
  );
}

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof RuntimeBoundaryError && error.detail.code === "CANCELLED") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function normalizeCancellation(error: unknown): RuntimeBoundaryError {
  if (error instanceof RuntimeBoundaryError) {
    return error;
  }
  return new RuntimeBoundaryError({
    code: "CANCELLED",
    message: "The managed model verification was cancelled.",
    retryable: true
  }, error instanceof Error ? { cause: error } : undefined);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeBoundaryError({
      code: "CANCELLED",
      message: "The model download was cancelled.",
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

function licenseRequired(): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "LICENSE_REQUIRED",
    message: "Accept the exact signed license notice before downloading this model.",
    retryable: false
  });
}

function downloadFailure(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "DOWNLOAD_FAILED",
    message,
    retryable: true
  });
}

function integrityFailure(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "INTEGRITY_FAILED",
    message,
    retryable: false
  });
}

function storageFailure(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "STORAGE_UNAVAILABLE",
    message,
    retryable: true
  });
}

function runtimeUnavailable(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message,
    retryable: true
  });
}

function busy(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BUSY",
    message,
    retryable: true
  });
}
