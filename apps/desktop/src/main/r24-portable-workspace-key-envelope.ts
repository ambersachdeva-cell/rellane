/**
 * An unregistered R24 primitive for carrying one synthetic workspace key under
 * an explicitly supplied, randomly generated Book-style recovery phrase.
 * It does not read the broker, Keychain, Book, or an owner data root.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { fromPhrase } from "./book/recovery.js";

const VERSION = 1 as const;
const DOMAIN = "cadrane/portable-workspace-key-envelope/v1" as const;
const KDF = "hkdf-sha256-book-phrase/v1" as const;
const CIPHER = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TEXT_CHARS = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const FIELDS = ["schemaVersion", "domain", "kdf", "cipher", "spaceId", "keyId", "salt", "nonce", "ciphertext", "tag"] as const;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NATIVE_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const NATIVE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const NATIVE_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const NATIVE_SHARED_LENGTH = typeof SharedArrayBuffer === "undefined" ? undefined :
  Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

export interface PortableWorkspaceKeyReference {
  readonly spaceId: string;
  readonly keyId: string;
}

export interface PortableWorkspaceKeyEnvelope extends PortableWorkspaceKeyReference {
  readonly schemaVersion: typeof VERSION;
  readonly domain: typeof DOMAIN;
  readonly kdf: typeof KDF;
  readonly cipher: typeof CIPHER;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export class PortableWorkspaceKeyEnvelopeError extends Error {
  constructor() {
    super("The portable workspace-key envelope could not be opened or published.");
    this.name = "PortableWorkspaceKeyEnvelopeError";
  }
}

/**
 * Only 32-byte caller-owned keys are accepted. No phrase or plaintext key is
 * returned or written; mutable copies made here are erased in `finally`.
 */
export function wrapPortableWorkspaceKey(
  reference: PortableWorkspaceKeyReference,
  phrase: string,
  keyMaterial: Uint8Array
): PortableWorkspaceKeyEnvelope {
  let secret: Buffer | undefined;
  let input: Buffer | undefined;
  let derived: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let finalBytes: Buffer | undefined;
  let tag: Buffer | undefined;
  let salt: Buffer | undefined;
  let nonce: Buffer | undefined;
  try {
    const pinnedReference = readReference(reference);
    if (typeof phrase !== "string")
      throw new PortableWorkspaceKeyEnvelopeError();
    secret = fromPhrase(phrase);
    input = snapshotKey(keyMaterial);
    salt = randomBytes(SALT_BYTES);
    nonce = randomBytes(NONCE_BYTES);
    derived = derive(secret, salt, pinnedReference);
    const header = headerFor(pinnedReference, salt.toString("base64url"), nonce.toString("base64url"));
    const cipher = createCipheriv(CIPHER, derived, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(JSON.stringify(header), "utf8"));
    ciphertext = cipher.update(input);
    finalBytes = cipher.final();
    tag = cipher.getAuthTag();
    if (finalBytes.byteLength !== 0 || ciphertext.byteLength !== KEY_BYTES)
      throw new PortableWorkspaceKeyEnvelopeError();
    return Object.freeze({
      ...header,
      ciphertext: ciphertext.toString("base64url"),
      tag: tag.toString("base64url")
    });
  } catch {
    throw new PortableWorkspaceKeyEnvelopeError();
  } finally {
    wipe(secret, input, derived, ciphertext, finalBytes, tag, salt, nonce);
  }
}

/** Authentication completes before any plaintext byte reaches the callback. */
export async function withPortableWorkspaceKey(
  envelope: unknown,
  expected: PortableWorkspaceKeyReference,
  phrase: string,
  callback: (keyMaterial: Uint8Array) => void | Promise<void>
): Promise<void> {
  let secret: Buffer | undefined;
  let salt: Buffer | undefined;
  let nonce: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let tag: Buffer | undefined;
  let derived: Buffer | undefined;
  let plaintext: Buffer | undefined;
  let finalBytes: Buffer | undefined;
  let callbackKey: Uint8Array | undefined;
  let enteredCallback = false;
  try {
    const pinnedReference = readReference(expected);
    const record = validateEnvelope(envelope);
    if (record.spaceId !== pinnedReference.spaceId || record.keyId !== pinnedReference.keyId ||
        typeof phrase !== "string" || typeof callback !== "function")
      throw new PortableWorkspaceKeyEnvelopeError();
    secret = fromPhrase(phrase);
    salt = decode(record.salt, SALT_BYTES);
    nonce = decode(record.nonce, NONCE_BYTES);
    ciphertext = decode(record.ciphertext, KEY_BYTES);
    tag = decode(record.tag, TAG_BYTES);
    derived = derive(secret, salt, pinnedReference);
    const decipher = createDecipheriv(CIPHER, derived, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(JSON.stringify(headerFor(pinnedReference, record.salt, record.nonce)), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = decipher.update(ciphertext);
    finalBytes = decipher.final();
    if (plaintext.byteLength !== KEY_BYTES || finalBytes.byteLength !== 0)
      throw new PortableWorkspaceKeyEnvelopeError();
    callbackKey = Uint8Array.from(plaintext);
    enteredCallback = true;
    await callback(callbackKey);
  } catch (error) {
    if (enteredCallback) throw error;
    throw new PortableWorkspaceKeyEnvelopeError();
  } finally {
    wipe(secret, salt, nonce, ciphertext, tag, derived, plaintext, finalBytes, callbackKey);
  }
}

/**
 * Parses only the canonical, bounded one-line format. An export importer must
 * still verify its independently attested manifest and source identity.
 */
export function parsePortableWorkspaceKeyEnvelope(text: string): PortableWorkspaceKeyEnvelope {
  try {
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_CHARS)
      throw new PortableWorkspaceKeyEnvelopeError();
    const canonical = text.endsWith("\n") ? text.slice(0, -1) : text;
    const parsed: unknown = JSON.parse(canonical);
    const record = validateEnvelope(parsed);
    if (JSON.stringify(record) !== canonical) throw new PortableWorkspaceKeyEnvelopeError();
    return record;
  } catch {
    throw new PortableWorkspaceKeyEnvelopeError();
  }
}

/**
 * Publishes encrypted bytes in one trusted, caller-attested directory. A hard
 * link creates the final name only if absent; this does not attest directory
 * ancestry, snapshot consistency, or crash durability of the directory entry.
 */
export async function createPortableWorkspaceKeyEnvelopeFile(
  destination: string,
  reference: PortableWorkspaceKeyReference,
  phrase: string,
  keyMaterial: Uint8Array
): Promise<PortableWorkspaceKeyEnvelope> {
  const envelope = wrapPortableWorkspaceKey(reference, phrase, keyMaterial);
  if (typeof destination !== "string" || destination.length === 0)
    throw new PortableWorkspaceKeyEnvelopeError();
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, destination);
    return envelope;
  } catch {
    throw new PortableWorkspaceKeyEnvelopeError();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function headerFor(reference: PortableWorkspaceKeyReference, salt: string, nonce: string) {
  return { schemaVersion: VERSION, domain: DOMAIN, kdf: KDF, cipher: CIPHER,
    spaceId: reference.spaceId, keyId: reference.keyId, salt, nonce } as const;
}

function derive(secret: Buffer, salt: Buffer, reference: PortableWorkspaceKeyReference): Buffer {
  const info = Buffer.from(`${DOMAIN}\0${reference.spaceId}\0${reference.keyId}`, "utf8");
  let material: Uint8Array | undefined;
  try {
    material = new Uint8Array(hkdfSync("sha256", secret, salt, info, KEY_BYTES));
    return Buffer.from(material);
  } finally {
    material?.fill(0);
    info.fill(0);
  }
}

function snapshotKey(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || NATIVE_BUFFER === undefined ||
      NATIVE_LENGTH === undefined || NATIVE_OFFSET === undefined)
    throw new PortableWorkspaceKeyEnvelopeError();
  const buffer: unknown = NATIVE_BUFFER.call(value);
  const length: unknown = NATIVE_LENGTH.call(value);
  const offset: unknown = NATIVE_OFFSET.call(value);
  if (!(buffer instanceof ArrayBuffer) || isShared(buffer) ||
      length !== KEY_BYTES || typeof offset !== "number")
    throw new PortableWorkspaceKeyEnvelopeError();
  return Buffer.from(new Uint8Array(buffer, offset, KEY_BYTES));
}

function isShared(value: unknown): boolean {
  if (NATIVE_SHARED_LENGTH === undefined) return false;
  try {
    return typeof NATIVE_SHARED_LENGTH.call(value) === "number";
  } catch {
    return false;
  }
}

function readReference(value: PortableWorkspaceKeyReference): PortableWorkspaceKeyReference {
  if (value === null || typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype)
    throw new PortableWorkspaceKeyEnvelopeError();
  const spaceId = Object.getOwnPropertyDescriptor(value, "spaceId");
  const keyId = Object.getOwnPropertyDescriptor(value, "keyId");
  if (spaceId === undefined || keyId === undefined ||
      !Object.hasOwn(spaceId, "value") || !Object.hasOwn(keyId, "value") ||
      !CanonicalDurableIdSchema.safeParse(spaceId.value).success ||
      !CanonicalDurableIdSchema.safeParse(keyId.value).success)
    throw new PortableWorkspaceKeyEnvelopeError();
  return Object.freeze({ spaceId: spaceId.value as string, keyId: keyId.value as string });
}

function validateEnvelope(value: unknown): PortableWorkspaceKeyEnvelope {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== FIELDS.length ||
      !FIELDS.every(field => Object.hasOwn(value, field) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, "value")))
    throw new PortableWorkspaceKeyEnvelopeError();
  const record = value as PortableWorkspaceKeyEnvelope;
  if (record.schemaVersion !== VERSION || record.domain !== DOMAIN || record.kdf !== KDF ||
      record.cipher !== CIPHER) throw new PortableWorkspaceKeyEnvelopeError();
  readReference(record);
  for (const [encoded, length] of [
    [record.salt, SALT_BYTES], [record.nonce, NONCE_BYTES],
    [record.ciphertext, KEY_BYTES], [record.tag, TAG_BYTES]
  ] as const) {
    const decoded = decode(encoded, length);
    decoded.fill(0);
  }
  return record;
}

function decode(value: string, length: number): Buffer {
  if (typeof value !== "string" || value.length > 64 || !BASE64URL.test(value))
    throw new PortableWorkspaceKeyEnvelopeError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new PortableWorkspaceKeyEnvelopeError();
  }
  return decoded;
}

function wipe(...values: Array<Uint8Array | undefined>): void {
  for (const value of values) value?.fill(0);
}
