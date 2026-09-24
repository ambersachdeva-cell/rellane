import {
  MODEL_LICENSE_NOTICE_MAX_UTF8_BYTES,
  SignedModelCatalogSchema,
  isImmutableHuggingFaceResolverUrl,
  type ModelTarget,
  type SignedModelCatalog
} from "@cadrane/contracts";
import { createHash, createPublicKey, verify } from "node:crypto";
import { RuntimeBoundaryError } from "../errors.js";

const verifiedCatalogs = new WeakSet<object>();

export interface CatalogTrustRoot {
  keyId: string;
  publicKeyPem: string;
  notBefore?: string;
  notAfter?: string;
}

export interface VerifyCatalogOptions {
  trustRoots: readonly CatalogTrustRoot[];
  minimumGeneration: number;
  allowedTargets: ReadonlySet<ModelTarget>;
  now?: Date;
}

export function verifySignedModelCatalog(
  input: unknown,
  options: VerifyCatalogOptions
): SignedModelCatalog {
  const parsed = SignedModelCatalogSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidCatalog("The model catalog is malformed or contains an incomplete artifact pin.");
  }
  const catalog = parsed.data;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const issuedAtMs = Date.parse(catalog.body.issuedAt);
  const expiresAtMs = Date.parse(catalog.body.expiresAt);
  const trustRoot = options.trustRoots.find((root) => root.keyId === catalog.keyId);

  if (trustRoot === undefined) {
    throw invalidCatalog("The model catalog was signed by an unknown key.");
  }
  const trustRootNotBeforeMs = trustRoot.notBefore === undefined
    ? undefined
    : Date.parse(trustRoot.notBefore);
  const trustRootNotAfterMs = trustRoot.notAfter === undefined
    ? undefined
    : Date.parse(trustRoot.notAfter);
  if (
    !Number.isSafeInteger(options.minimumGeneration) ||
    options.minimumGeneration < 0 ||
    catalog.body.generation < options.minimumGeneration
  ) {
    throw invalidCatalog("The model catalog would roll back the trusted generation.");
  }
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    issuedAtMs >= expiresAtMs ||
    issuedAtMs > nowMs + 5 * 60_000 ||
    expiresAtMs <= nowMs
  ) {
    throw invalidCatalog("The model catalog is expired or has an invalid validity window.");
  }
  if (
    (trustRootNotBeforeMs !== undefined && !Number.isFinite(trustRootNotBeforeMs)) ||
    (trustRootNotAfterMs !== undefined && !Number.isFinite(trustRootNotAfterMs)) ||
    (trustRootNotBeforeMs !== undefined &&
      trustRootNotAfterMs !== undefined &&
      trustRootNotBeforeMs >= trustRootNotAfterMs) ||
    (trustRootNotBeforeMs !== undefined && nowMs < trustRootNotBeforeMs) ||
    (trustRootNotAfterMs !== undefined && nowMs >= trustRootNotAfterMs)
  ) {
    throw invalidCatalog("The model catalog signing key is outside its trusted validity window.");
  }

  let verified = false;
  try {
    verified = verify(
      null,
      catalogSigningBytes(catalog),
      createPublicKey(trustRoot.publicKeyPem),
      Buffer.from(catalog.signature, "base64")
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw invalidCatalog("The model catalog signature is invalid.");
  }

  const modelIds = new Set<string>();
  for (const artifact of catalog.body.artifacts) {
    if (modelIds.has(artifact.modelId)) {
      throw invalidCatalog("The model catalog contains a duplicate model artifact.");
    }
    modelIds.add(artifact.modelId);
    assertPinnedHuggingFaceUrl(artifact);
    assertExactLicenseNotice(artifact);
    if (
      artifact.eligibleTargets.some((target) => !options.allowedTargets.has(target))
    ) {
      throw invalidCatalog("The model catalog contains an artifact for an unapproved target.");
    }
  }

  const frozenCatalog = deepFreeze(catalog);
  verifiedCatalogs.add(frozenCatalog);
  return frozenCatalog;
}

export function resolveVerifiedCatalogArtifact(
  catalog: SignedModelCatalog,
  modelId: string
): SignedModelCatalog["body"]["artifacts"][number] {
  if (!verifiedCatalogs.has(catalog)) {
    throw invalidCatalog("The model catalog has not passed signature verification in this process.");
  }
  const artifact = catalog.body.artifacts.find((candidate) => candidate.modelId === modelId);
  if (artifact === undefined) {
    throw invalidCatalog("The requested model is not present in the verified catalog.");
  }
  return artifact;
}

export function catalogSigningBytes(catalog: SignedModelCatalog): Buffer {
  return Buffer.from(canonicalJson({
    algorithm: catalog.algorithm,
    body: catalog.body,
    keyId: catalog.keyId
  }), "utf8");
}

function assertPinnedHuggingFaceUrl(
  artifact: SignedModelCatalog["body"]["artifacts"][number]
): void {
  let url: URL;
  try {
    url = new URL(artifact.downloadUrl);
  } catch {
    throw invalidCatalog("A model artifact URL is invalid.");
  }
  const expectedPath = `/${artifact.repository}/resolve/${artifact.repositoryRevision}/${artifact.filename}`;
  if (
    !isImmutableHuggingFaceResolverUrl(
      artifact.downloadUrl,
      artifact.repositoryRevision,
      artifact.filename
    ) ||
    url.pathname !== expectedPath
  ) {
    throw invalidCatalog("A model artifact URL is not an immutable approved Hugging Face path.");
  }
}

function assertExactLicenseNotice(
  artifact: SignedModelCatalog["body"]["artifacts"][number]
): void {
  const noticeBytes = Buffer.from(artifact.license.noticeText, "utf8");
  if (
    noticeBytes.byteLength > MODEL_LICENSE_NOTICE_MAX_UTF8_BYTES ||
    noticeBytes.toString("utf8") !== artifact.license.noticeText
  ) {
    throw invalidCatalog("A model license notice is not valid bounded UTF-8 text.");
  }
  const digest = createHash("sha256").update(noticeBytes).digest("hex");
  if (digest !== artifact.license.noticeSha256) {
    throw invalidCatalog("A model license notice does not match its signed SHA-256 digest.");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidCatalog("The model catalog contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw invalidCatalog("The model catalog contains an unsupported canonical value.");
}

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

function invalidCatalog(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "CATALOG_INVALID",
    message,
    retryable: false
  });
}
