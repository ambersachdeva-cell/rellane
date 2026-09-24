import {
  LicenseAcceptanceIntentSchema,
  LicenseAcknowledgementSchema,
  MODEL_INSTALL_SNAPSHOT_MAX_ITEMS,
  ModelInstallCancelRequestSchema,
  ModelInstallCancelResultSchema,
  ModelInstallSnapshotSchema,
  ModelInstallStartIntentSchema,
  ModelInstallStatusSchema,
  ModelLicenseReviewSchema,
  ModelTargetSchema,
  type LicenseAcknowledgement,
  type ModelInstallCancelResult,
  type ModelInstallSnapshot,
  type ModelInstallStatus,
  type ModelLicenseReview,
  type ModelTarget,
  type SignedModelCatalog
} from "@cadrane/contracts";
import { randomUUID } from "node:crypto";
import { RuntimeBoundaryError } from "../errors.js";
import {
  resolveVerifiedCatalogArtifact
} from "./catalog-verifier.js";
import {
  acknowledgementMatchesArtifact
} from "./install-lifecycle.js";
import type {
  ManagedModelInstallInput,
  ManagedModelInstallResult,
  ManagedModelInstallerSnapshot,
  ManagedModelProbeInput
} from "./managed-model-store.js";
import type {
  ModelLicenseService,
  VerifiedModelCatalogSource
} from "./model-license-service.js";

const ACTIVE_INSTALL_STATES = new Set<ModelInstallStatus["state"]>([
  "queued",
  "downloading",
  "verifying"
]);

export interface ModelInstallControllerInstaller {
  install(input: ManagedModelInstallInput): Promise<ManagedModelInstallResult>;
  cancel(operationId: string): boolean;
  getStatus(
    modelId: string,
    catalogGeneration?: number,
    artifactSha256?: string
  ): ModelInstallStatus | null;
  snapshot(): ManagedModelInstallerSnapshot;
  probe(input: ManagedModelProbeInput): Promise<ModelInstallStatus>;
}

export interface ModelInstallControllerLicenseService {
  review(modelId: string): ReturnType<ModelLicenseService["review"]>;
  acknowledge(input: unknown): ReturnType<ModelLicenseService["acknowledge"]>;
  currentAcknowledgement(
    modelId: string
  ): ReturnType<ModelLicenseService["currentAcknowledgement"]>;
}

export interface ModelInstallControllerOptions {
  readonly catalogSource: VerifiedModelCatalogSource;
  readonly licenseService: ModelInstallControllerLicenseService;
  readonly installer: ModelInstallControllerInstaller;
  readonly target: ModelTarget;
  readonly uniqueId?: () => string;
}

interface ResolvedModel {
  readonly catalog: SignedModelCatalog;
  readonly artifact: SignedModelCatalog["body"]["artifacts"][number];
}

interface ActiveInstall {
  readonly modelId: string;
  readonly operationId: string;
  catalogGeneration: number | null;
  artifactSha256: string | null;
}

/**
 * Privileged daemon-side boundary for the renderer-safe model install flow.
 *
 * The controller owns operation IDs and resolves all privileged catalog,
 * target, licence, URL, and filesystem inputs inside the daemon process.
 */
export class ModelInstallController {
  private readonly catalogSource: VerifiedModelCatalogSource;
  private readonly licenseService: ModelInstallControllerLicenseService;
  private readonly installer: ModelInstallControllerInstaller;
  private readonly target: ModelTarget;
  private readonly uniqueId: () => string;
  private readonly activeByModel = new Map<string, ActiveInstall>();
  private readonly activeByOperation = new Map<string, ActiveInstall>();
  private readonly recoveryByModel = new Map<string, Promise<void>>();
  private readonly recoveredPins = new Set<string>();
  private readonly usedOperationIds = new Set<string>();

  constructor(options: ModelInstallControllerOptions) {
    const target = ModelTargetSchema.safeParse(options.target);
    if (!target.success) {
      throw badRequest("The managed model target is invalid.");
    }
    this.catalogSource = options.catalogSource;
    this.licenseService = options.licenseService;
    this.installer = options.installer;
    this.target = target.data;
    this.uniqueId = options.uniqueId ?? randomUUID;
  }

  async review(modelId: string): Promise<ModelLicenseReview> {
    try {
      this.resolveCurrentModel(modelId);
      const review = parseReview(await this.licenseService.review(modelId));
      const current = this.resolveCurrentModel(modelId);
      if (
        review.modelId !== current.artifact.modelId ||
        review.artifactSha256 !== current.artifact.sha256 ||
        review.displayName !== current.artifact.displayName ||
        review.downloadBytes !== current.artifact.downloadBytes ||
        review.sourceHost !== new URL(current.artifact.downloadUrl).hostname ||
        review.repository !== current.artifact.repository ||
        review.catalogGeneration !== current.catalog.body.generation ||
        review.licenseId !== current.artifact.license.id ||
        review.licenseName !== current.artifact.license.name ||
        review.licenseNoticeVersion !==
          current.artifact.license.noticeVersion ||
        review.licenseNoticeSha256 !== current.artifact.license.noticeSha256 ||
        review.noticeText !== current.artifact.license.noticeText
      ) {
        throw busy(
          "The signed model catalog changed while its license was being reviewed."
        );
      }
      return review;
    } catch (error) {
      throw normalizeControllerError(
        error,
        "The current model license could not be reviewed."
      );
    }
  }

  async acknowledge(input: unknown): Promise<LicenseAcknowledgement> {
    try {
      const intent = LicenseAcceptanceIntentSchema.safeParse(input);
      if (!intent.success) {
        throw badRequest("The license acceptance intent is malformed.");
      }
      this.resolveCurrentModel(intent.data.modelId);
      const acknowledgement = parseAcknowledgement(
        await this.licenseService.acknowledge(intent.data)
      );
      const current = this.resolveCurrentModel(intent.data.modelId);
      if (
        !acknowledgementMatchesArtifact(
          acknowledgement,
          current.artifact,
          current.catalog.body.generation
        )
      ) {
        throw licenseRequired(
          "Review and accept the current signed model license before installing."
        );
      }
      return acknowledgement;
    } catch (error) {
      throw normalizeControllerError(
        error,
        "The model license acknowledgement could not be saved."
      );
    }
  }

  /**
   * Recovers each current target pin once per daemon/controller lifetime.
   * A new controller (including a daemon restart) therefore re-probes disk,
   * while ordinary 500 ms UI polling reads the installer's in-process truth.
   */
  async snapshot(): Promise<ModelInstallSnapshot> {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const catalog = this.catalogSource.currentCatalog();
        const models = this.currentTargetModels(catalog);
        for (const model of models) {
          await this.recoverCurrentPin(model);
        }

        const latestCatalog = this.catalogSource.currentCatalog();
        this.currentTargetModels(latestCatalog);
        if (!sameSignedCatalog(latestCatalog, catalog)) {
          continue;
        }
        const statuses: ModelInstallStatus[] = [];
        for (const { artifact } of models) {
          const status = this.installer.getStatus(
            artifact.modelId,
            catalog.body.generation,
            artifact.sha256
          );
          if (status !== null) {
            statuses.push(parsePinnedStatus(status, {
              catalog,
              artifact
            }));
          }
        }
        return parseSnapshot(statuses);
      }
      throw busy(
        "The signed model catalog changed while install state was recovering."
      );
    } catch (error) {
      throw normalizeControllerError(
        error,
        "The managed model install state could not be recovered."
      );
    }
  }

  async start(
    modelId: string,
    signal?: AbortSignal
  ): Promise<ModelInstallStatus> {
    const intent = ModelInstallStartIntentSchema.safeParse({ modelId });
    if (!intent.success) {
      throw badRequest("The model install intent is malformed.");
    }

    try {
      const initial = this.resolveCurrentModel(intent.data.modelId);
      if (
        this.activeByModel.has(intent.data.modelId) ||
        this.installerHasActiveModel(initial)
      ) {
        throw duplicateStart();
      }
      const recovery = this.recoveryByModel.get(intent.data.modelId);
      if (recovery !== undefined) {
        await recovery;
      }
      const recoveredCurrent = this.resolveCurrentModel(intent.data.modelId);
      if (
        this.activeByModel.has(intent.data.modelId) ||
        this.installerHasActiveModel(recoveredCurrent)
      ) {
        throw duplicateStart();
      }

      const operationId = this.nextOperationId();
      const active: ActiveInstall = {
        modelId: intent.data.modelId,
        operationId,
        catalogGeneration: null,
        artifactSha256: null
      };
      this.activeByModel.set(active.modelId, active);
      this.activeByOperation.set(active.operationId, active);

      let abortListener: (() => void) | undefined;
      let installModel: ResolvedModel | null = null;
      try {
        const acknowledgement = await this.licenseService
          .currentAcknowledgement(active.modelId);
        const current = this.resolveCurrentModel(active.modelId);
        installModel = current;
        active.catalogGeneration = current.catalog.body.generation;
        active.artifactSha256 = current.artifact.sha256;
        if (
          acknowledgement === null ||
          !acknowledgementMatchesArtifact(
            acknowledgement,
            current.artifact,
            current.catalog.body.generation
          )
        ) {
          throw licenseRequired(
            "Review and accept the current signed model license before installing."
          );
        }
        if (signal?.aborted === true) {
          throw cancelled();
        }

        if (signal !== undefined) {
          abortListener = () => {
            this.cancelMatchingOperation(active.operationId);
          };
          signal.addEventListener("abort", abortListener, { once: true });
        }

        await this.installer.install({
          operationId: active.operationId,
          catalog: current.catalog,
          request: {
            modelId: current.artifact.modelId,
            acknowledgement
          },
          target: this.target
        });

        const status = this.installer.getStatus(
          current.artifact.modelId,
          current.catalog.body.generation,
          current.artifact.sha256
        );
        const terminal = parsePinnedStatus(status, current);
        if (terminal.state !== "installed") {
          throw invalidInstallerResponse(
            "The managed model installer returned without an installed terminal state."
          );
        }
        return terminal;
      } finally {
        if (installModel !== null) {
          try {
            const latest = this.installer.getStatus(
              installModel.artifact.modelId,
              installModel.catalog.body.generation,
              installModel.artifact.sha256
            );
            if (latest !== null && statusMatchesPin(latest, installModel)) {
              this.recoveredPins.add(pinKey(installModel));
            }
          } catch {
            // Status recovery remains available after releasing the operation.
          }
        }
        if (signal !== undefined && abortListener !== undefined) {
          signal.removeEventListener("abort", abortListener);
        }
        this.releaseOperation(active);
      }
    } catch (error) {
      throw normalizeControllerError(
        error,
        "The managed model installation failed."
      );
    }
  }

  async cancel(operationId: string): Promise<ModelInstallCancelResult> {
    try {
      const request = ModelInstallCancelRequestSchema.safeParse({ operationId });
      if (!request.success) {
        throw badRequest("The model install cancellation request is malformed.");
      }
      const active = this.activeByOperation.get(request.data.operationId);
      if (
        active === undefined ||
        this.activeByModel.get(active.modelId) !== active
      ) {
        return parseCancelResult({
          cancelRequested: false,
          status: null
        });
      }

      const cancelRequested = this.installer.cancel(active.operationId);
      const status = this.currentStatusForActive(active);
      return parseCancelResult({ cancelRequested, status });
    } catch (error) {
      throw normalizeControllerError(
        error,
        "The model install cancellation could not be requested."
      );
    }
  }

  private async recoverCurrentPin(model: ResolvedModel): Promise<void> {
    const key = pinKey(model);
    if (
      this.recoveredPins.has(key) ||
      this.activeByModel.has(model.artifact.modelId) ||
      this.installerHasActiveModel(model)
    ) {
      return;
    }
    const existing = this.recoveryByModel.get(model.artifact.modelId);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const recovery = (async () => {
      if (
        this.activeByModel.has(model.artifact.modelId) ||
        this.installerHasActiveModel(model)
      ) {
        return;
      }
      parsePinnedStatus(await this.installer.probe({
        catalog: model.catalog,
        modelId: model.artifact.modelId,
        target: this.target
      }), model);
      this.recoveredPins.add(key);
    })();
    this.recoveryByModel.set(model.artifact.modelId, recovery);
    try {
      await recovery;
    } finally {
      if (this.recoveryByModel.get(model.artifact.modelId) === recovery) {
        this.recoveryByModel.delete(model.artifact.modelId);
      }
    }
  }

  private installerHasActiveModel(model: ResolvedModel): boolean {
    const status = this.installer.getStatus(
      model.artifact.modelId,
      model.catalog.body.generation,
      model.artifact.sha256
    );
    if (status === null) {
      return false;
    }
    const currentStatus = parsePinnedStatus(status, model);
    if (!ACTIVE_INSTALL_STATES.has(currentStatus.state)) {
      return false;
    }
    const snapshot = this.installer.snapshot();
    const lane = snapshot.downloadLane;
    if (currentStatus.operationId !== null) {
      return (
        lane.activeOperationId === currentStatus.operationId ||
        lane.queuedOperationIds.includes(currentStatus.operationId)
      );
    }
    if (
      currentStatus.state !== "verifying" ||
      lane.activeOperationId === null
    ) {
      return false;
    }
    return !snapshot.statuses.some(
      (candidate) => candidate.operationId === lane.activeOperationId
    );
  }

  private resolveCurrentModel(modelId: string): ResolvedModel {
    const intent = ModelInstallStartIntentSchema.safeParse({ modelId });
    if (!intent.success) {
      throw badRequest("The model install intent is malformed.");
    }
    const catalog = this.catalogSource.currentCatalog();
    const artifact = resolveVerifiedCatalogArtifact(
      catalog,
      intent.data.modelId
    );
    if (!artifact.eligibleTargets.includes(this.target)) {
      throw new RuntimeBoundaryError({
        code: "RUNTIME_UNAVAILABLE",
        message: "This model is not approved for the current computer target.",
        retryable: false
      });
    }
    return { catalog, artifact };
  }

  private currentTargetModels(
    catalog: SignedModelCatalog
  ): readonly ResolvedModel[] {
    if (
      catalog.body.artifacts.length === 0 ||
      catalog.body.artifacts.length > MODEL_INSTALL_SNAPSHOT_MAX_ITEMS
    ) {
      throw new RuntimeBoundaryError({
        code: "CATALOG_INVALID",
        message: "The verified model catalog violates the install snapshot boundary.",
        retryable: false
      });
    }
    const models: ResolvedModel[] = [];
    for (const candidate of catalog.body.artifacts) {
      const artifact = resolveVerifiedCatalogArtifact(
        catalog,
        candidate.modelId
      );
      if (artifact.eligibleTargets.includes(this.target)) {
        models.push({ catalog, artifact });
      }
    }
    return models;
  }

  private currentStatusForActive(
    active: ActiveInstall
  ): ModelInstallStatus | null {
    if (
      active.catalogGeneration === null ||
      active.artifactSha256 === null
    ) {
      return null;
    }
    let current: ResolvedModel;
    try {
      current = this.resolveCurrentModel(active.modelId);
    } catch {
      return null;
    }
    if (
      current.catalog.body.generation !== active.catalogGeneration ||
      current.artifact.sha256 !== active.artifactSha256
    ) {
      return null;
    }
    const status = this.installer.getStatus(
      active.modelId,
      active.catalogGeneration,
      active.artifactSha256
    );
    return status === null ? null : parsePinnedStatus(status, current);
  }

  private cancelMatchingOperation(operationId: string): void {
    const active = this.activeByOperation.get(operationId);
    if (
      active !== undefined &&
      this.activeByModel.get(active.modelId) === active
    ) {
      try {
        this.installer.cancel(operationId);
      } catch {
        // An abort listener must never throw into AbortController.abort().
      }
    }
  }

  private releaseOperation(active: ActiveInstall): void {
    if (this.activeByModel.get(active.modelId) === active) {
      this.activeByModel.delete(active.modelId);
    }
    if (this.activeByOperation.get(active.operationId) === active) {
      this.activeByOperation.delete(active.operationId);
    }
  }

  private nextOperationId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.uniqueId();
      const parsed = ModelInstallCancelRequestSchema.safeParse({
        operationId: candidate
      });
      if (
        parsed.success &&
        !this.usedOperationIds.has(parsed.data.operationId)
      ) {
        this.usedOperationIds.add(parsed.data.operationId);
        return parsed.data.operationId;
      }
    }
    throw invalidInstallerResponse(
      "The daemon could not create a unique model install operation ID."
    );
  }
}

function pinKey(model: ResolvedModel): string {
  return [
    model.artifact.modelId,
    model.catalog.body.generation,
    model.artifact.sha256,
    model.catalog.keyId,
    model.catalog.signature
  ].join("\u0000");
}

function sameSignedCatalog(
  left: SignedModelCatalog,
  right: SignedModelCatalog
): boolean {
  return (
    left.keyId === right.keyId &&
    left.algorithm === right.algorithm &&
    left.signature === right.signature
  );
}

function parseReview(input: unknown): ModelLicenseReview {
  const parsed = ModelLicenseReviewSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInstallerResponse(
      "The model license service returned an invalid renderer-safe review."
    );
  }
  return parsed.data;
}

function parseAcknowledgement(input: unknown): LicenseAcknowledgement {
  const parsed = LicenseAcknowledgementSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInstallerResponse(
      "The model license service returned an invalid acknowledgement."
    );
  }
  return parsed.data;
}

function parseStatus(input: unknown): ModelInstallStatus {
  const parsed = ModelInstallStatusSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInstallerResponse(
      "The managed model installer returned an invalid renderer-safe status."
    );
  }
  return parsed.data;
}

function parsePinnedStatus(
  input: unknown,
  model: ResolvedModel
): ModelInstallStatus {
  const status = parseStatus(input);
  if (!statusMatchesPin(status, model)) {
    throw invalidInstallerResponse(
      "The managed model installer returned status for a different catalog pin."
    );
  }
  return status;
}

function statusMatchesPin(
  status: ModelInstallStatus,
  model: ResolvedModel
): boolean {
  return (
    status.modelId === model.artifact.modelId &&
    status.catalogGeneration === model.catalog.body.generation &&
    status.artifactSha256 === model.artifact.sha256 &&
    status.totalBytes === model.artifact.downloadBytes
  );
}

function parseSnapshot(input: unknown): ModelInstallSnapshot {
  const parsed = ModelInstallSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInstallerResponse(
      "The managed model installer returned an invalid bounded snapshot."
    );
  }
  return parsed.data;
}

function parseCancelResult(input: unknown): ModelInstallCancelResult {
  const parsed = ModelInstallCancelResultSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidInstallerResponse(
      "The managed model installer returned an invalid cancellation result."
    );
  }
  return parsed.data;
}

function duplicateStart(): RuntimeBoundaryError {
  return busy("A model installation for this model is already running.");
}

function badRequest(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BAD_REQUEST",
    message,
    retryable: false
  });
}

function busy(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BUSY",
    message,
    retryable: true
  });
}

function cancelled(): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "CANCELLED",
    message: "The model installation request was cancelled.",
    retryable: true
  });
}

function licenseRequired(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "LICENSE_REQUIRED",
    message,
    retryable: false
  });
}

function invalidInstallerResponse(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_RESPONSE_INVALID",
    message,
    retryable: false
  });
}

function normalizeControllerError(
  error: unknown,
  fallbackMessage: string
): RuntimeBoundaryError {
  if (error instanceof RuntimeBoundaryError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return cancelled();
  }
  return new RuntimeBoundaryError({
    code: "UNKNOWN",
    message: fallbackMessage,
    retryable: false
  }, { cause: error });
}
