import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";

const ENVELOPE_VERSION = 1 as const;
const SCHEMA_VERSION = 1 as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const AAD_MAGIC = Buffer.from([0x53, 0x42, 0x45, 0x41, 0x00, 0x01]); // SBEA v1
const PAYLOAD_DOMAIN = Buffer.from("switchboard/durable/record-payload/v1", "ascii");
const BLOB_DOMAIN = Buffer.from("switchboard/durable/blob/v1", "ascii");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const ENVELOPE_FIELDS = ["envelopeVersion", "nonce", "tag", "ciphertext", "ciphertextSha256"] as const;
const CONTEXT_FIELDS = ["envelopeVersion", "spaceId", "keyId", "entityId", "entityKind", "schemaVersion", "contentRevision", "kind", "contentSha256"] as const;
const ENTITY_KINDS = new Set([
  "space", "source", "source-snapshot", "source-span", "agent", "agent-version",
  "task", "run", "run-step", "artifact", "review", "revision-request",
  "permission-request", "permission-decision", "citation", "receipt",
  "capability-grant", "capability-grant-receipt", "capability-grant-index"
]);

export type DurableEntityKind =
  | "space" | "source" | "source-snapshot" | "source-span" | "agent"
  | "agent-version" | "task" | "run" | "run-step" | "artifact" | "review"
  | "revision-request" | "permission-request" | "permission-decision"
  | "citation" | "receipt" | "capability-grant" | "capability-grant-receipt"
  | "capability-grant-index";

export interface EnvelopeContext {
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  readonly spaceId: string;
  readonly keyId: string;
  readonly entityId: string;
  readonly entityKind: DurableEntityKind;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly contentRevision: number;
  readonly kind: "payload" | "blob";
  readonly contentSha256: string;
}

export interface EncryptedEnvelope {
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: Uint8Array;
  readonly ciphertextSha256: string;
}

export type EnvelopeCryptoErrorCode = "ENVELOPE_INPUT_INVALID" | "ENVELOPE_AUTH_FAILED";

/** Private durable-boundary error; its messages deliberately contain no inputs. */
export class EnvelopeCryptoError extends Error {
  readonly code: EnvelopeCryptoErrorCode;

  constructor(code: EnvelopeCryptoErrorCode) {
    super(code === "ENVELOPE_AUTH_FAILED"
      ? "Envelope authentication failed."
      : "Envelope input is invalid.");
    this.name = "EnvelopeCryptoError";
    this.code = code;
  }
}

/**
 * Encrypts bytes for one immutable durable record/blob context. This module is
 * intentionally not re-exported by the runtime package barrel. Its envelope is
 * shallow-frozen: ciphertext is an owned mutable copy guarded by its digest and GCM.
 */
export function encryptEnvelope(
  dataEncryptionKey: Uint8Array,
  plaintext: Uint8Array,
  context: EnvelopeContext
): EncryptedEnvelope {
  let masterKey: Buffer | undefined;
  let subkey: Buffer | undefined;
  let nonce: Buffer | undefined;
  let tag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let plaintextCopy: Buffer | undefined;

  try {
    if (!isNonSharedBoundedBytes(dataEncryptionKey, KEY_BYTES) || !hasNativeByteLength(dataEncryptionKey, KEY_BYTES) ||
      !isNonSharedBoundedBytes(plaintext, MAX_CONTENT_BYTES)) {
      throw inputError();
    }

    // Snapshot accepted caller bytes before reading their content or invoking crypto.
    masterKey = snapshotTypedArray(dataEncryptionKey);
    plaintextCopy = snapshotTypedArray(plaintext);
    if (!isValidContext(context)) throw inputError();

    const plaintextSha256 = sha256(plaintextCopy);
    if (!timingSafeEqual(Buffer.from(plaintextSha256, "ascii"), Buffer.from(context.contentSha256, "ascii"))) {
      throw inputError();
    }

    const aad = encodeAad(context);
    subkey = deriveSubkey(masterKey, aad, context.kind);
    nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", subkey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: plaintextCopy.byteLength });
    ciphertext = Buffer.concat([cipher.update(plaintextCopy), cipher.final()]);
    tag = cipher.getAuthTag();

    const result: EncryptedEnvelope = {
      envelopeVersion: ENVELOPE_VERSION,
      nonce: nonce.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: new Uint8Array(ciphertext),
      ciphertextSha256: sha256(ciphertext)
    };
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof EnvelopeCryptoError) throw error;
    throw inputError();
  } finally {
    plaintextCopy?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
    nonce?.fill(0);
    subkey?.fill(0);
    masterKey?.fill(0);
  }
}

/** Decrypts only when the caller supplies the exact original authenticated context. */
export function decryptEnvelope(
  dataEncryptionKey: Uint8Array,
  envelope: EncryptedEnvelope,
  expectedContext: EnvelopeContext
): Uint8Array {
  let masterKey: Buffer | undefined;
  let subkey: Buffer | undefined;
  let nonce: Buffer | undefined;
  let tag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let plaintext: Buffer | undefined;

  try {
    if (!isNonSharedBoundedBytes(dataEncryptionKey, KEY_BYTES) || !hasNativeByteLength(dataEncryptionKey, KEY_BYTES) ||
      !isValidContext(expectedContext)) {
      throw authError();
    }

    ({ nonce, tag, ciphertext } = parseEnvelope(envelope));
    const expectedContentSha256 = expectedContext.contentSha256;
    const actualDigest = sha256(ciphertext);
    if (!timingSafeEqual(Buffer.from(actualDigest, "ascii"), Buffer.from(envelope.ciphertextSha256, "ascii"))) {
      throw authError();
    }

    const aad = encodeAad(expectedContext);
    masterKey = snapshotTypedArray(dataEncryptionKey);
    subkey = deriveSubkey(masterKey, aad, expectedContext.kind);
    const decipher = createDecipheriv("aes-256-gcm", subkey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (!timingSafeEqual(Buffer.from(sha256(plaintext), "ascii"), Buffer.from(expectedContentSha256, "ascii"))) {
      throw authError();
    }
    return new Uint8Array(plaintext);
  } catch (_error) {
    throw authError();
  } finally {
    plaintext?.fill(0);
    ciphertext?.fill(0);
    tag?.fill(0);
    nonce?.fill(0);
    subkey?.fill(0);
    masterKey?.fill(0);
  }
}

function parseEnvelope(value: unknown): { nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!isStrictEnvelope(value)) throw authError();
  const nonce = decodeCanonicalBase64Url(value.nonce, NONCE_BYTES, /^[A-Za-z0-9_-]{16}$/);
  const tag = decodeCanonicalBase64Url(value.tag, TAG_BYTES, /^[A-Za-z0-9_-]{21}[AQgw]$/);
  if (!isNonSharedBoundedBytes(value.ciphertext, MAX_CONTENT_BYTES) || !SHA256_PATTERN.test(value.ciphertextSha256)) {
    nonce.fill(0);
    tag.fill(0);
    throw authError();
  }
  try {
    return { nonce, tag, ciphertext: snapshotTypedArray(value.ciphertext) };
  } catch (_error) {
    nonce.fill(0);
    tag.fill(0);
    throw authError();
  }
}

function isStrictEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!hasExactDataFields(value, ENVELOPE_FIELDS)) return false;
  const record = value;
  return record.envelopeVersion === ENVELOPE_VERSION && typeof record.nonce === "string" &&
    typeof record.tag === "string" && typeof record.ciphertextSha256 === "string" &&
    isBytes(record.ciphertext);
}

function isValidContext(value: unknown): value is EnvelopeContext {
  if (!hasExactDataFields(value, CONTEXT_FIELDS)) return false;
  const record = value;
  return record.envelopeVersion === ENVELOPE_VERSION && isCanonicalUuid(record.spaceId) &&
    isCanonicalUuid(record.keyId) && isCanonicalUuid(record.entityId) &&
    typeof record.entityKind === "string" && ENTITY_KINDS.has(record.entityKind) &&
    record.schemaVersion === SCHEMA_VERSION && typeof record.contentRevision === "number" &&
    Number.isSafeInteger(record.contentRevision) && record.contentRevision > 0 &&
    (record.kind === "payload" || record.kind === "blob") &&
    typeof record.contentSha256 === "string" && SHA256_PATTERN.test(record.contentSha256);
}

function encodeAad(context: EnvelopeContext): Buffer {
  const revision = Buffer.alloc(8);
  revision.writeBigUInt64BE(BigInt(context.contentRevision));
  try {
    return Buffer.concat([
      AAD_MAGIC,
      encodeField("envelopeVersion", Buffer.from([context.envelopeVersion])),
      encodeField("spaceId", Buffer.from(context.spaceId, "ascii")),
      encodeField("keyId", Buffer.from(context.keyId, "ascii")),
      encodeField("entityId", Buffer.from(context.entityId, "ascii")),
      encodeField("entityKind", Buffer.from(context.entityKind, "ascii")),
      encodeField("schemaVersion", Buffer.from([context.schemaVersion])),
      encodeField("contentRevision", revision),
      encodeField("kind", Buffer.from(context.kind, "ascii")),
      encodeField("contentSha256", Buffer.from(context.contentSha256, "ascii"))
    ]);
  } finally {
    revision.fill(0);
  }
}

function encodeField(label: string, value: Buffer): Buffer {
  const labelBytes = Buffer.from(label, "ascii");
  const header = Buffer.alloc(5);
  header.writeUInt8(labelBytes.byteLength, 0);
  header.writeUInt32BE(value.byteLength, 1);
  return Buffer.concat([header, labelBytes, value]);
}

function deriveSubkey(masterKey: Buffer, aad: Buffer, kind: EnvelopeContext["kind"]): Buffer {
  const salt = createHash("sha256").update(aad).digest();
  const info = Buffer.concat([kind === "payload" ? PAYLOAD_DOMAIN : BLOB_DOMAIN, aad]);
  try {
    // hkdfSync returns an ArrayBuffer; Buffer.from keeps an owned view that this caller clears.
    return Buffer.from(hkdfSync("sha256", masterKey, salt, info, KEY_BYTES));
  } finally {
    salt.fill(0);
    info.fill(0);
  }
}

function decodeCanonicalBase64Url(input: string, expectedBytes: number, pattern: RegExp): Buffer {
  if (!pattern.test(input)) throw authError();
  const decoded = Buffer.from(input, "base64url");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64url") !== input) {
    decoded.fill(0);
    throw authError();
  }
  return decoded;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCanonicalUuid(value: unknown): value is string {
  return CanonicalDurableIdSchema.safeParse(value).success;
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isNonSharedBoundedBytes(value: unknown, maxBytes: number): value is Uint8Array {
  const details = nativeTypedArrayDetails(value);
  return details !== undefined && !isSharedArrayBuffer(details.buffer) && details.byteLength <= maxBytes;
}

function hasNativeByteLength(value: unknown, expectedBytes: number): boolean {
  return nativeTypedArrayDetails(value)?.byteLength === expectedBytes;
}

function nativeTypedArrayDetails(value: unknown): { buffer: unknown; byteLength: number } | undefined {
  if (!isBytes(value) || NATIVE_TYPED_ARRAY_BUFFER_GETTER === undefined || NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) {
    return undefined;
  }
  try {
    const buffer = NATIVE_TYPED_ARRAY_BUFFER_GETTER.call(value);
    const byteLength = NATIVE_TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
      ? { buffer, byteLength }
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function snapshotTypedArray(value: Uint8Array): Buffer {
  const source = nativeTypedArrayDetails(value);
  if (source === undefined) throw new TypeError("Invalid typed array.");
  let copied: Uint8Array | undefined;
  let snapshot: Buffer | undefined;
  try {
    // Typed-array construction and set use native slots, not user-controlled view metadata.
    copied = new Uint8Array(value);
    const copiedDetails = nativeTypedArrayDetails(copied);
    if (copiedDetails === undefined || copiedDetails.byteLength !== source.byteLength) {
      throw new TypeError("Typed-array snapshot mismatch.");
    }
    snapshot = Buffer.allocUnsafe(source.byteLength);
    snapshot.set(copied);
    return snapshot;
  } catch (error) {
    snapshot?.fill(0);
    throw error;
  } finally {
    copied?.fill(0);
  }
}

function isSharedArrayBuffer(value: unknown): boolean {
  if (NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined) return false;
  try {
    const byteLength = NATIVE_SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(value);
    return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0;
  } catch (_error) {
    return false;
  }
}

function hasExactDataFields(
  value: unknown,
  fields: readonly string[]
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  });
}

function inputError(): EnvelopeCryptoError {
  return new EnvelopeCryptoError("ENVELOPE_INPUT_INVALID");
}

function authError(): EnvelopeCryptoError {
  return new EnvelopeCryptoError("ENVELOPE_AUTH_FAILED");
}
