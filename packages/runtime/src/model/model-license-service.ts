import {
  LicenseAcceptanceIntentSchema,
  LicenseAcknowledgementSchema,
  ModelInstallStartIntentSchema,
  ModelLicenseReviewSchema,
  type LicenseAcknowledgement,
  type ModelLicenseReview,
  type SignedModelCatalog
} from "@cadrane/contracts";
import { RuntimeBoundaryError } from "../errors.js";
import {
  resolveVerifiedCatalogArtifact
} from "./catalog-verifier.js";
import {
  acknowledgementMatchesArtifact
} from "./install-lifecycle.js";
import type {
  LicenseAcknowledgementStore
} from "./license-acknowledgement-store.js";

export interface VerifiedModelCatalogSource {
  currentCatalog(): SignedModelCatalog;
}

export interface ModelLicenseServiceOptions {
  readonly catalogSource: VerifiedModelCatalogSource;
  readonly store: LicenseAcknowledgementStore;
  readonly now?: () => Date;
}

export class ModelLicenseService {
  private readonly catalogSource: VerifiedModelCatalogSource;
  private readonly store: LicenseAcknowledgementStore;
  private readonly now: () => Date;

  constructor(options: ModelLicenseServiceOptions) {
    this.catalogSource = options.catalogSource;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  async review(modelId: string): Promise<ModelLicenseReview> {
    const initial = this.resolveCurrentArtifact(modelId);
    const acknowledgement = await this.store.load(initial.artifact.modelId);
    const { catalog, artifact } = this.resolveCurrentArtifact(modelId);
    return ModelLicenseReviewSchema.parse({
      modelId: artifact.modelId,
      displayName: artifact.displayName,
      artifactSha256: artifact.sha256,
      downloadBytes: artifact.downloadBytes,
      sourceHost: new URL(artifact.downloadUrl).hostname,
      repository: artifact.repository,
      catalogGeneration: catalog.body.generation,
      licenseId: artifact.license.id,
      licenseName: artifact.license.name,
      licenseNoticeVersion: artifact.license.noticeVersion,
      licenseNoticeSha256: artifact.license.noticeSha256,
      noticeText: artifact.license.noticeText,
      acknowledgementCurrent: (
        acknowledgement !== null &&
        acknowledgementMatchesArtifact(
          acknowledgement,
          artifact,
          catalog.body.generation
        )
      )
    });
  }

  async acknowledge(
    input: unknown
  ): Promise<LicenseAcknowledgement> {
    const intent = LicenseAcceptanceIntentSchema.safeParse(input);
    if (!intent.success) {
      throw badRequest("The license acceptance intent is malformed.");
    }
    const { catalog, artifact } = this.resolveCurrentArtifact(intent.data.modelId);
    if (
      intent.data.artifactSha256 !== artifact.sha256 ||
      intent.data.catalogGeneration !== catalog.body.generation ||
      intent.data.licenseNoticeVersion !== artifact.license.noticeVersion ||
      intent.data.licenseNoticeSha256 !== artifact.license.noticeSha256
    ) {
      throw licenseRequired(
        "Review and accept the current signed model license before installing."
      );
    }

    let acceptedAt: string;
    try {
      acceptedAt = this.now().toISOString();
    } catch {
      throw storageUnavailable(
        "The license acknowledgement clock is unavailable."
      );
    }
    const acknowledgement = LicenseAcknowledgementSchema.safeParse({
      acknowledgementVersion: 1,
      modelId: artifact.modelId,
      artifactSha256: artifact.sha256,
      licenseNoticeVersion: artifact.license.noticeVersion,
      licenseNoticeSha256: artifact.license.noticeSha256,
      catalogGeneration: catalog.body.generation,
      acceptedAt
    });
    if (!acknowledgement.success) {
      throw storageUnavailable(
        "The license acknowledgement clock returned an invalid time."
      );
    }
    await this.store.save(acknowledgement.data);
    return acknowledgement.data;
  }

  async currentAcknowledgement(
    modelId: string
  ): Promise<LicenseAcknowledgement | null> {
    const { catalog, artifact } = this.resolveCurrentArtifact(modelId);
    const acknowledgement = await this.store.load(artifact.modelId);
    return (
      acknowledgement !== null &&
      acknowledgementMatchesArtifact(
        acknowledgement,
        artifact,
        catalog.body.generation
      )
    )
      ? acknowledgement
      : null;
  }

  private resolveCurrentArtifact(modelId: string): {
    catalog: SignedModelCatalog;
    artifact: SignedModelCatalog["body"]["artifacts"][number];
  } {
    const intent = ModelInstallStartIntentSchema.safeParse({ modelId });
    if (!intent.success) {
      throw badRequest("The model license request is malformed.");
    }
    const catalog = this.catalogSource.currentCatalog();
    const artifact = resolveVerifiedCatalogArtifact(
      catalog,
      intent.data.modelId
    );
    return { catalog, artifact };
  }
}

function badRequest(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BAD_REQUEST",
    message,
    retryable: false
  });
}

function licenseRequired(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "LICENSE_REQUIRED",
    message,
    retryable: false
  });
}

function storageUnavailable(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "STORAGE_UNAVAILABLE",
    message,
    retryable: true
  });
}
