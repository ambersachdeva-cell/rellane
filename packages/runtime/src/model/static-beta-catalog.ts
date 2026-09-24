import {
  type ModelTarget,
  type SignedModelCatalog
} from "@cadrane/contracts";
import { gunzipSync } from "node:zlib";
import {
  verifySignedModelCatalog,
  type CatalogTrustRoot
} from "./catalog-verifier.js";

export const STATIC_BETA_CATALOG_GENERATION = 1;
export const STATIC_BETA_CATALOG_TARGET = "darwin-arm64" as const;
export const STATIC_BETA_CATALOG_ISSUED_AT = "2026-07-30T00:00:00.000Z";
export const STATIC_BETA_CATALOG_EXPIRES_AT = "2027-07-30T00:00:00.000Z";
export const STATIC_BETA_CATALOG_KEY_ID = "switchboard-static-beta-2026-07-30";
export const STATIC_BETA_CATALOG_PUBLIC_KEY_SHA256 =
  "fd4d4ce55ece7e857a07b6b0c38221fe7e48e5d62747fd8b8b93a6d5bf31f76d";

export const STATIC_BETA_CATALOG_TRUST_ROOT: Readonly<CatalogTrustRoot> =
  Object.freeze({
    keyId: STATIC_BETA_CATALOG_KEY_ID,
    publicKeyPem: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEANTydGdLfvUfu52VPTMS9348Xml1hKaB90ZFP4SFBohg=",
      "-----END PUBLIC KEY-----",
      ""
    ].join("\n"),
    notBefore: STATIC_BETA_CATALOG_ISSUED_AT,
    notAfter: STATIC_BETA_CATALOG_EXPIRES_AT
  });

export interface LoadStaticBetaModelCatalogOptions {
  target: ModelTarget;
  now?: Date;
}

/**
 * Returns the only generation-1 static beta catalog after verifying it in this
 * process. Target, validity, signature, pins, and exact notice bytes all fail
 * closed through the normal catalog verifier.
 *
 * This catalog is a download allowlist only. It does not assert native
 * conformance, runtime readiness, or release signing.
 */
export function loadStaticBetaModelCatalog(
  options: LoadStaticBetaModelCatalogOptions
): SignedModelCatalog {
  return verifySignedModelCatalog(STATIC_BETA_SIGNED_CATALOG, {
    trustRoots: [STATIC_BETA_CATALOG_TRUST_ROOT],
    minimumGeneration: STATIC_BETA_CATALOG_GENERATION,
    allowedTargets: new Set([options.target]),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

const APACHE_2_LICENSE_GZIP_BASE64 = [
  "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",
  "I+zNI1p9/GVfnJbMfN2d3mv94j+0tOKGXiwAAA=="
].join("");

const APACHE_2_LICENSE_NOTICE = gunzipSync(
  Buffer.from(APACHE_2_LICENSE_GZIP_BASE64, "base64")
).toString("utf8");

const STATIC_BETA_SIGNED_CATALOG: SignedModelCatalog = deepFreeze({
  keyId: STATIC_BETA_CATALOG_KEY_ID,
  algorithm: "Ed25519",
  body: {
    schemaVersion: 2,
    catalogId: "switchboard-model-catalog",
    generation: STATIC_BETA_CATALOG_GENERATION,
    issuedAt: STATIC_BETA_CATALOG_ISSUED_AT,
    expiresAt: STATIC_BETA_CATALOG_EXPIRES_AT,
    artifacts: [{
      artifactVersion: 1,
      modelId: "qwen3-4b-q4-k-m",
      displayName: "Qwen3 4B (Q4_K_M)",
      repository: "Qwen/Qwen3-4B-GGUF",
      repositoryRevision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
      filename: "Qwen3-4B-Q4_K_M.gguf",
      downloadUrl:
        "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf",
      downloadBytes: 2_497_280_256,
      sha256:
        "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
      eligibleTargets: [STATIC_BETA_CATALOG_TARGET],
      license: {
        id: "Apache-2.0",
        name: "Apache License 2.0",
        officialUrl: "https://www.apache.org/licenses/LICENSE-2.0",
        noticeText: APACHE_2_LICENSE_NOTICE,
        noticeVersion: "Apache-2.0-2004-static-beta-1",
        noticeSha256:
          "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
      }
    }]
  },
  signature:
    "yGDV7Frl91VcVFIE/hU/2hZgREfVUsdK1E7kJLAqW+onZ9RMk1SNuHJfJjHchM/e1yzNpns6jQZczuQYjl3QAw=="
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
