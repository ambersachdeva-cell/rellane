import type {
  LicenseAcknowledgement,
  PinnedModelArtifact
} from "@cadrane/contracts";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acknowledgementMatchesArtifact,
  assertModelInstallTransition
} from "./install-lifecycle.js";

const licenseNoticeText = "Apache License 2.0\nInstall lifecycle fixture notice.\n";

const artifact: PinnedModelArtifact = {
  artifactVersion: 1,
  modelId: "test-model",
  displayName: "Test model",
  repository: "publisher/test-model",
  repositoryRevision: "b".repeat(40),
  filename: "test-model-Q4_K_M.gguf",
  downloadUrl: `https://huggingface.co/publisher/test-model/resolve/${"b".repeat(40)}/test-model-Q4_K_M.gguf`,
  downloadBytes: 1_000,
  sha256: "a".repeat(64),
  eligibleTargets: ["darwin-arm64"],
  license: {
    id: "Apache-2.0",
    name: "Apache License 2.0",
    officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    noticeText: licenseNoticeText,
    noticeVersion: "Apache-2.0-2004",
    noticeSha256: createHash("sha256")
      .update(licenseNoticeText, "utf8")
      .digest("hex")
  }
};

const acknowledgement: LicenseAcknowledgement = {
  acknowledgementVersion: 1,
  modelId: artifact.modelId,
  artifactSha256: artifact.sha256,
  licenseNoticeVersion: artifact.license.noticeVersion,
  licenseNoticeSha256: artifact.license.noticeSha256,
  catalogGeneration: 4,
  acceptedAt: "2026-07-30T00:00:00.000Z"
};

describe("model install lifecycle", () => {
  it("accepts the expected install path", () => {
    expect(() => assertModelInstallTransition("not-installed", "license-required")).not.toThrow();
    expect(() => assertModelInstallTransition("license-required", "queued")).not.toThrow();
    expect(() => assertModelInstallTransition("queued", "downloading")).not.toThrow();
    expect(() => assertModelInstallTransition("downloading", "verifying")).not.toThrow();
    expect(() => assertModelInstallTransition("verifying", "installed")).not.toThrow();
  });

  it("rejects illegal optimistic transitions", () => {
    expect(() => assertModelInstallTransition("not-installed", "installed")).toThrow(
      /cannot move/i
    );
    expect(() => assertModelInstallTransition("quarantined", "installed")).toThrow(
      /cannot move/i
    );
  });

  it("binds acknowledgement to artifact, notice, and catalog generation", () => {
    expect(acknowledgementMatchesArtifact(acknowledgement, artifact, 4)).toBe(true);
    expect(acknowledgementMatchesArtifact({
      ...acknowledgement,
      artifactSha256: "d".repeat(64)
    }, artifact, 4)).toBe(false);
    expect(acknowledgementMatchesArtifact(acknowledgement, artifact, 5)).toBe(false);
  });
});
