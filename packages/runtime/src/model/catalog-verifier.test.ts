import {
  MODEL_LICENSE_NOTICE_MAX_UTF8_BYTES,
  type ModelCatalogBody,
  type PinnedModelArtifact,
  type SignedModelCatalog
} from "@cadrane/contracts";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  catalogSigningBytes,
  resolveVerifiedCatalogArtifact,
  verifySignedModelCatalog
} from "./catalog-verifier.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const allowedTargets = new Set(["darwin-arm64"] as const);
const licenseNoticeText = "Apache License 2.0\nTest fixture notice.\n";

const artifact: PinnedModelArtifact = {
  artifactVersion: 1,
  modelId: "qwen3-4b-q4-k-m",
  displayName: "Qwen3 4B",
  repository: "Qwen/Qwen3-4B-GGUF",
  repositoryRevision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
  filename: "Qwen3-4B-Q4_K_M.gguf",
  downloadUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
  downloadBytes: 2_497_280_256,
  sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
  eligibleTargets: ["darwin-arm64"],
  license: {
    id: "Apache-2.0",
    name: "Apache License 2.0",
    officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    noticeText: licenseNoticeText,
    noticeVersion: "Apache-2.0-2004",
    noticeSha256: sha256Utf8(licenseNoticeText)
  }
};

const body: ModelCatalogBody = {
  schemaVersion: 2,
  catalogId: "switchboard-model-catalog",
  generation: 7,
  issuedAt: "2026-07-30T00:00:00.000Z",
  expiresAt: "2026-08-30T00:00:00.000Z",
  artifacts: [artifact]
};

describe("signed model catalog verifier", () => {
  it("accepts a valid envelope from a trusted key", () => {
    const catalog = signCatalog(body, "release-2026", keys.privateKey);
    const verified = verify(catalog);
    expect(verified.body.artifacts[0]?.sha256).toBe(artifact.sha256);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.body.artifacts[0])).toBe(true);
  });

  it("only resolves artifacts from the exact catalog object verified in this process", () => {
    const catalog = verify(signCatalog(body, "release-2026", keys.privateKey));
    expect(resolveVerifiedCatalogArtifact(catalog, artifact.modelId)).toBe(
      catalog.body.artifacts[0]
    );
    const clonedCatalog = structuredClone(catalog);
    expect(() => resolveVerifiedCatalogArtifact(
      clonedCatalog,
      artifact.modelId
    )).toThrow(/has not passed signature verification/i);
  });

  it("rejects altered signed bytes", () => {
    const catalog = signCatalog(body, "release-2026", keys.privateKey);
    const tampered = {
      ...catalog,
      body: {
        ...catalog.body,
        artifacts: [{
          ...catalog.body.artifacts[0]!,
          downloadBytes: catalog.body.artifacts[0]!.downloadBytes + 1
        }]
      }
    };
    expect(() => verify(tampered)).toThrow(/signature is invalid/i);
  });

  it("rejects a signed notice whose exact UTF-8 bytes do not match its digest", () => {
    const catalog = signCatalog({
      ...body,
      artifacts: [{
        ...artifact,
        license: {
          ...artifact.license,
          noticeText: `${artifact.license.noticeText}!`
        }
      }]
    }, "release-2026", keys.privateKey);
    expect(() => verify(catalog)).toThrow(/license notice.*SHA-256 digest/i);
  });

  it("rejects a signed notice larger than the UTF-8 byte boundary", () => {
    const oversizedNotice = "é".repeat(
      Math.floor(MODEL_LICENSE_NOTICE_MAX_UTF8_BYTES / 2) + 1
    );
    const catalog = signCatalog({
      ...body,
      artifacts: [{
        ...artifact,
        license: {
          ...artifact.license,
          noticeText: oversizedNotice,
          noticeSha256: sha256Utf8(oversizedNotice)
        }
      }]
    }, "release-2026", keys.privateKey);
    expect(() => verify(catalog)).toThrow(/malformed|incomplete|bounded UTF-8/i);
  });

  it("rejects an unknown signing key", () => {
    const catalog = signCatalog(body, "unknown-key", keys.privateKey);
    expect(() => verify(catalog)).toThrow(/unknown key/i);
  });

  it("rejects an expired envelope", () => {
    const expired = signCatalog({
      ...body,
      expiresAt: "2026-07-31T00:00:00.000Z"
    }, "release-2026", keys.privateKey);
    expect(() => verify(expired)).toThrow(/expired|validity window/i);
  });

  it("rejects an invalid injected clock", () => {
    const catalog = signCatalog(body, "release-2026", keys.privateKey);
    expect(() => verifySignedModelCatalog(catalog, {
      trustRoots: [{ keyId: "release-2026", publicKeyPem }],
      minimumGeneration: 7,
      allowedTargets,
      now: new Date("not a date")
    })).toThrow(/expired|validity window/i);
  });

  it.each([
    { notBefore: "not a date" },
    { notAfter: "not a date" },
    {
      notBefore: "2026-08-02T00:00:00.000Z",
      notAfter: "2026-08-01T00:00:00.000Z"
    }
  ])("rejects an invalid trust-root validity window", (validityWindow) => {
    const catalog = signCatalog(body, "release-2026", keys.privateKey);
    expect(() => verifySignedModelCatalog(catalog, {
      trustRoots: [{ keyId: "release-2026", publicKeyPem, ...validityWindow }],
      minimumGeneration: 7,
      allowedTargets,
      now: new Date("2026-08-01T00:00:00.000Z")
    })).toThrow(/trusted validity window/i);
  });

  it("rejects a rollback generation", () => {
    const catalog = signCatalog(body, "release-2026", keys.privateKey);
    expect(() => verifySignedModelCatalog(catalog, {
      trustRoots: [{ keyId: "release-2026", publicKeyPem }],
      minimumGeneration: 8,
      allowedTargets,
      now: new Date("2026-08-01T00:00:00.000Z")
    })).toThrow(/roll back/i);
  });

  it("rejects malformed or null artifact digests", () => {
    const malformed = {
      ...signCatalog(body, "release-2026", keys.privateKey),
      body: {
        ...body,
        artifacts: [{ ...artifact, sha256: null }]
      }
    };
    expect(() => verify(malformed)).toThrow(/malformed|incomplete/i);
  });

  it("rejects an artifact outside the approved native target", () => {
    const catalog = signCatalog({
      ...body,
      artifacts: [{ ...artifact, eligibleTargets: ["win32-x64"] }]
    }, "release-2026", keys.privateKey);
    expect(() => verify(catalog)).toThrow(/unapproved target/i);
  });

  it("rejects a mutable or mismatched download path", () => {
    const catalog = signCatalog({
      ...body,
      artifacts: [{
        ...artifact,
        downloadUrl: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf"
      }]
    }, "release-2026", keys.privateKey);
    expect(() => verify(catalog)).toThrow(/immutable approved/i);
  });
});

function verify(catalog: unknown): SignedModelCatalog {
  return verifySignedModelCatalog(catalog, {
    trustRoots: [{ keyId: "release-2026", publicKeyPem }],
    minimumGeneration: 7,
    allowedTargets,
    now: new Date("2026-08-01T00:00:00.000Z")
  });
}

function signCatalog(
  catalogBody: ModelCatalogBody,
  keyId: string,
  privateKey: KeyObject
): SignedModelCatalog {
  const envelope: SignedModelCatalog = {
    keyId,
    algorithm: "Ed25519",
    body: catalogBody,
    signature: `${"A".repeat(86)}==`
  };
  return {
    ...envelope,
    signature: sign(null, catalogSigningBytes(envelope), privateKey).toString("base64")
  };
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
