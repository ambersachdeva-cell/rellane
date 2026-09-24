import { describe, expect, it } from "vitest";
import {
  LicenseAcceptanceIntentSchema,
  MODEL_INSTALL_SNAPSHOT_MAX_ITEMS,
  MODEL_LICENSE_NOTICE_MAX_CHARACTERS,
  ModelInstallCancelResultSchema,
  ModelInstallSnapshotSchema,
  ModelInstallStartIntentSchema,
  ModelInstallStatusSchema,
  ModelLicenseReviewSchema
} from "./model-install.js";

const digest = "a".repeat(64);
const operationId = "11111111-1111-4111-8111-111111111111";

const acceptanceIntent = {
  modelId: "test-model",
  artifactSha256: digest,
  catalogGeneration: 7,
  licenseNoticeVersion: "Apache-2.0-2004",
  licenseNoticeSha256: "b".repeat(64),
  accepted: true
} as const;

const status = {
  modelId: "test-model",
  state: "downloading",
  operationId,
  catalogGeneration: 7,
  artifactSha256: digest,
  bytesReceived: 512,
  totalBytes: 1_024,
  resumeAvailable: false,
  detail: "Downloading the reviewed model.",
  error: null,
  updatedAt: "2026-07-30T00:00:00.000Z"
} as const;

describe("renderer-safe model installation contracts", () => {
  it("accepts only an explicit literal licence agreement", () => {
    expect(LicenseAcceptanceIntentSchema.parse(acceptanceIntent)).toEqual(
      acceptanceIntent
    );
    expect(LicenseAcceptanceIntentSchema.safeParse({
      ...acceptanceIntent,
      accepted: false
    }).success).toBe(false);
    const { accepted: _accepted, ...missingAcceptance } = acceptanceIntent;
    expect(LicenseAcceptanceIntentSchema.safeParse(missingAcceptance).success)
      .toBe(false);
  });

  it("rejects renderer attempts to add privileged install fields", () => {
    for (const extra of [
      { downloadUrl: "https://example.invalid/model.gguf" },
      { destinationPath: "/tmp/model.gguf" },
      { operationId },
      { acceptedAt: "2026-07-30T00:00:00.000Z" },
      { headers: { authorization: "secret" } },
      { target: "darwin-arm64" },
      { catalog: { generation: 7 } },
      { acknowledgement: acceptanceIntent }
    ]) {
      expect(ModelInstallStartIntentSchema.safeParse({
        modelId: "test-model",
        ...extra
      }).success).toBe(false);
    }
    expect(LicenseAcceptanceIntentSchema.safeParse({
      ...acceptanceIntent,
      officialUrl: "https://www.apache.org/licenses/LICENSE-2.0"
    }).success).toBe(false);
    expect(LicenseAcceptanceIntentSchema.safeParse({
      ...acceptanceIntent,
      acknowledgementCurrent: true
    }).success).toBe(false);
  });

  it("rejects malformed IDs, digests, and operation identifiers", () => {
    expect(ModelInstallStartIntentSchema.safeParse({
      modelId: "../../escape"
    }).success).toBe(false);
    expect(LicenseAcceptanceIntentSchema.safeParse({
      ...acceptanceIntent,
      artifactSha256: "not-a-digest"
    }).success).toBe(false);
    expect(ModelInstallStatusSchema.safeParse({
      ...status,
      operationId: "not-a-uuid"
    }).success).toBe(false);
  });

  it("bounds exact plain licence review text and excludes URLs and paths", () => {
    const review = {
      modelId: "test-model",
      displayName: "Test model",
      artifactSha256: digest,
      downloadBytes: 1_024,
      catalogGeneration: 7,
      licenseId: "Apache-2.0",
      licenseName: "Apache License 2.0",
      licenseNoticeVersion: "Apache-2.0-2004",
      licenseNoticeSha256: "b".repeat(64),
      noticeText: "Fixture licence notice.",
      sourceHost: "huggingface.co", repository: "Qwen/Test-GGUF",
      acknowledgementCurrent: false
    };
    expect(ModelLicenseReviewSchema.parse(review)).toEqual(review);
    expect(ModelLicenseReviewSchema.safeParse({
      ...review,
      noticeText: "x".repeat(MODEL_LICENSE_NOTICE_MAX_CHARACTERS + 1)
    }).success).toBe(false);
    expect(ModelLicenseReviewSchema.safeParse({
      ...review,
      noticeText: "é".repeat(
        Math.floor(MODEL_LICENSE_NOTICE_MAX_CHARACTERS / 2) + 1
      )
    }).success).toBe(false);
    expect(ModelLicenseReviewSchema.safeParse({
      ...review,
      officialUrl: "https://www.apache.org/licenses/LICENSE-2.0"
    }).success).toBe(false);
    expect(ModelLicenseReviewSchema.safeParse({
      ...review,
      modelPath: "/tmp/model.gguf"
    }).success).toBe(false);
  });

  it("bounds snapshots and rejects privileged or malformed status fields", () => {
    expect(ModelInstallSnapshotSchema.parse([status])).toEqual([status]);
    expect(ModelInstallSnapshotSchema.safeParse(
      Array.from(
        { length: MODEL_INSTALL_SNAPSHOT_MAX_ITEMS + 1 },
        () => status
      )
    ).success).toBe(false);
    expect(ModelInstallSnapshotSchema.safeParse([{
      ...status,
      destinationPath: "/tmp/model.gguf"
    }]).success).toBe(false);
    expect(ModelInstallStatusSchema.safeParse({
      ...status,
      error: {
        code: "DOWNLOAD_FAILED",
        message: "The download ended.",
        retryable: true,
        path: "/tmp/model.gguf"
      }
    }).success).toBe(false);
    expect(ModelInstallStatusSchema.safeParse({
      ...status,
      error: {
        code: "DOWNLOAD_FAILED",
        message: "The download ended."
      }
    }).success).toBe(false);
  });

  it("keeps cancellation acknowledgement distinct from terminal lifecycle state", () => {
    expect(ModelInstallCancelResultSchema.parse({
      cancelRequested: true,
      status
    })).toEqual({
      cancelRequested: true,
      status
    });
    expect(ModelInstallCancelResultSchema.safeParse({
      cancelRequested: true,
      status,
      paused: true
    }).success).toBe(false);
  });
});
