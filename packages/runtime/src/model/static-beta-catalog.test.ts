import type {
  ModelTarget,
  SignedModelCatalog
} from "@cadrane/contracts";
import {
  createHash,
  createPublicKey
} from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  catalogSigningBytes,
  resolveVerifiedCatalogArtifact,
  verifySignedModelCatalog
} from "./catalog-verifier.js";
import {
  loadStaticBetaModelCatalog,
  STATIC_BETA_CATALOG_EXPIRES_AT,
  STATIC_BETA_CATALOG_GENERATION,
  STATIC_BETA_CATALOG_PUBLIC_KEY_SHA256,
  STATIC_BETA_CATALOG_TARGET,
  STATIC_BETA_CATALOG_TRUST_ROOT
} from "./static-beta-catalog.js";

const VALID_NOW = new Date("2026-08-01T00:00:00.000Z");
const MODEL_ID = "qwen3-4b-q4-k-m";
const NOTICE_PATH = fileURLToPath(new URL(
  "../../../../third_party/model-licenses/apache-2.0/LICENSE.txt",
  import.meta.url
));
const MODULE_PATH = fileURLToPath(new URL("./static-beta-catalog.ts", import.meta.url));
const RECEIPT_PATH = fileURLToPath(new URL(
  "../../../../docs/research/STATIC-BETA-MODEL-CATALOG-RECEIPT-2026-07-30.md",
  import.meta.url
));

describe("static beta model catalog", () => {
  it("reconstructs the canonical notice byte-for-byte with its exact digest", () => {
    const catalog = loadCatalog();
    const canonicalNotice = readFileSync(NOTICE_PATH);
    const embeddedNotice = Buffer.from(
      catalog.body.artifacts[0]!.license.noticeText,
      "utf8"
    );

    expect(canonicalNotice.byteLength).toBe(11_358);
    expect(embeddedNotice.equals(canonicalNotice)).toBe(true);
    expect(sha256(canonicalNotice)).toBe(
      "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
    );
    expect(catalog.body.artifacts[0]!.license.noticeSha256).toBe(
      sha256(embeddedNotice)
    );
  });

  it("verifies the embedded signature and exact generation-1 artifact pin", () => {
    const catalog = loadCatalog();
    const artifact = resolveVerifiedCatalogArtifact(catalog, MODEL_ID);
    const publicDer = createPublicKey(
      STATIC_BETA_CATALOG_TRUST_ROOT.publicKeyPem
    ).export({ type: "spki", format: "der" });

    expect(catalog.body.generation).toBe(STATIC_BETA_CATALOG_GENERATION);
    expect(artifact.repositoryRevision).toBe(
      "bc640142c66e1fdd12af0bd68f40445458f3869b"
    );
    expect(artifact.filename).toBe("Qwen3-4B-Q4_K_M.gguf");
    expect(artifact.downloadBytes).toBe(2_497_280_256);
    expect(artifact.sha256).toBe(
      "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"
    );
    expect(artifact.eligibleTargets).toEqual([STATIC_BETA_CATALOG_TARGET]);
    expect(sha256(publicDer)).toBe(STATIC_BETA_CATALOG_PUBLIC_KEY_SHA256);
    expect(sha256(catalogSigningBytes(catalog))).toBe(
      "62968c09dd64ce502d56396391295ece4ec2b15ba362abc524cd081016997b01"
    );
  });

  it.each([
    ["notice text", (catalog: SignedModelCatalog) => {
      catalog.body.artifacts[0]!.license.noticeText += " ";
    }],
    ["artifact pin", (catalog: SignedModelCatalog) => {
      catalog.body.artifacts[0]!.sha256 =
        `0${catalog.body.artifacts[0]!.sha256.slice(1)}`;
    }],
    ["signature", (catalog: SignedModelCatalog) => {
      catalog.signature = `A${catalog.signature.slice(1)}`;
    }]
  ])("rejects %s tampering", (_label, tamper) => {
    const tampered = structuredClone(loadCatalog());
    tamper(tampered);
    expect(() => verifyForDarwin(tampered)).toThrow(/signature is invalid/i);
  });

  it("fails closed at expiry", () => {
    expect(() => loadStaticBetaModelCatalog({
      target: STATIC_BETA_CATALOG_TARGET,
      now: new Date(STATIC_BETA_CATALOG_EXPIRES_AT)
    })).toThrow(/expired|validity window/i);
  });

  it.each<ModelTarget>([
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64"
  ])("fails closed when used for other target %s", (target) => {
    expect(() => loadStaticBetaModelCatalog({
      target,
      now: VALID_NOW
    })).toThrow(/unapproved target/i);
  });

  it("returns only a process-verified, recursively frozen catalog", () => {
    const catalog = loadCatalog();
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.body)).toBe(true);
    expect(Object.isFrozen(catalog.body.artifacts)).toBe(true);
    expect(Object.isFrozen(catalog.body.artifacts[0])).toBe(true);
    expect(Object.isFrozen(catalog.body.artifacts[0]!.license)).toBe(true);

    const unverifiedClone = structuredClone(catalog);
    expect(() => resolveVerifiedCatalogArtifact(unverifiedClone, MODEL_ID))
      .toThrow(/has not passed signature verification/i);
  });

  it("contains no secret-key PEM block or secret-key source identifier", () => {
    const reviewedSources = [
      readFileSync(MODULE_PATH, "utf8"),
      readFileSync(RECEIPT_PATH, "utf8")
    ].join("\n");

    expect(reviewedSources).not.toMatch(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----END [A-Z0-9 ]*PRIVATE KEY-----/
    );
    expect(reviewedSources).not.toMatch(/\bprivateKey\b|\bsecretKey\b/);
  });
});

function loadCatalog(): SignedModelCatalog {
  return loadStaticBetaModelCatalog({
    target: STATIC_BETA_CATALOG_TARGET,
    now: VALID_NOW
  });
}

function verifyForDarwin(input: unknown): SignedModelCatalog {
  return verifySignedModelCatalog(input, {
    trustRoots: [STATIC_BETA_CATALOG_TRUST_ROOT],
    minimumGeneration: STATIC_BETA_CATALOG_GENERATION,
    allowedTargets: new Set([STATIC_BETA_CATALOG_TARGET]),
    now: VALID_NOW
  });
}

function sha256(value: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}
