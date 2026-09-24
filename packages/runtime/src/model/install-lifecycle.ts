import type {
  LicenseAcknowledgement,
  ModelInstallState,
  PinnedModelArtifact
} from "@cadrane/contracts";
import { RuntimeBoundaryError } from "../errors.js";

const LEGAL_TRANSITIONS: Readonly<Record<ModelInstallState, readonly ModelInstallState[]>> = {
  "not-installed": ["license-required", "removed"],
  "license-required": ["queued", "removed"],
  queued: ["downloading", "failed", "removed"],
  downloading: ["paused", "verifying", "failed", "removed"],
  paused: ["queued", "failed", "removed"],
  verifying: ["paused", "installed", "failed", "quarantined"],
  installed: ["failed", "quarantined", "removed"],
  failed: ["license-required", "queued", "removed"],
  quarantined: ["removed"],
  removed: ["not-installed", "license-required"]
};

export function assertModelInstallTransition(
  from: ModelInstallState,
  to: ModelInstallState
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new RuntimeBoundaryError({
      code: "BAD_REQUEST",
      message: `The model install state cannot move from ${from} to ${to}.`,
      retryable: false
    });
  }
}

export function acknowledgementMatchesArtifact(
  acknowledgement: LicenseAcknowledgement,
  artifact: PinnedModelArtifact,
  catalogGeneration: number
): boolean {
  return (
    acknowledgement.modelId === artifact.modelId &&
    acknowledgement.artifactSha256 === artifact.sha256 &&
    acknowledgement.licenseNoticeVersion === artifact.license.noticeVersion &&
    acknowledgement.licenseNoticeSha256 === artifact.license.noticeSha256 &&
    acknowledgement.catalogGeneration === catalogGeneration
  );
}
