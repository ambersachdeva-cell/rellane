import {
  disposeOpaqueJournalSnapshotForTestOnly,
  validateTransactionalPersistenceMediumImageForTestOnly,
  type TransactionalPersistenceMediumImage,
} from "./transactional-persistence.js";

/**
 * Private, in-memory transport codec for deterministic simulator images. It is
 * deliberately not a filesystem format or evidence of restart persistence.
 */
export class TransactionalPersistenceImageCodecError extends Error {
  readonly code = "TRANSACTIONAL_PERSISTENCE_IMAGE_CODEC_FAILED" as const;
  constructor() { super("Transactional persistence image codec operation failed."); this.name = "TransactionalPersistenceImageCodecError"; }
}

const MAX_WIRE_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 4_096;
const MAX_RECEIPTS = 256;
const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, "byteLength")?.get;
const BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, "buffer")?.get;
const FILL = Object.getOwnPropertyDescriptor(TYPED_ARRAY, "fill")?.value as ((this: Uint8Array, value: number) => Uint8Array) | undefined;
const SHARED_LENGTH = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

type JsonObject = Record<string, unknown>;

/** Encodes a validated full simulator image as canonical UTF-8 JSON. */
export function encodeTransactionalPersistenceMediumImage(input: unknown): Uint8Array {
  let image: TransactionalPersistenceMediumImage | undefined;
  let output: Uint8Array | undefined;
  try {
    image = validateTransactionalPersistenceMediumImageForTestOnly(input);
    output = textEncoder.encode(canonicalJson(wireImage(image)));
    if (output.byteLength > MAX_WIRE_BYTES) throw failed();
    return output;
  } catch {
    wipeOwned(output);
    throw failed();
  } finally {
    disposeTransactionalPersistenceMediumImageForTestOnly(image);
  }
}

/**
 * Decodes only an exact, owned native Uint8Array. A valid-sized caller buffer
 * is consumed on either path; callers receive a fresh independently-owned image.
 */
export function decodeOwnedTransactionalPersistenceMediumImage(input: unknown): TransactionalPersistenceMediumImage {
  let wire: Uint8Array | undefined;
  let canonical: Uint8Array | undefined;
  let image: TransactionalPersistenceMediumImage | undefined;
  const temporaryCiphertexts: Uint8Array[] = [];
  let returned = false;
  try {
    wire = copyAndConsumeWire(input);
    const parsed: unknown = JSON.parse(textDecoder.decode(wire));
    image = validateTransactionalPersistenceMediumImageForTestOnly(materializeWireImage(parsed, temporaryCiphertexts));
    canonical = textEncoder.encode(canonicalJson(wireImage(image)));
    if (!sameBytes(wire, canonical)) throw failed();
    returned = true;
    return image;
  } catch {
    throw failed();
  } finally {
    wipeOwned(wire);
    wipeOwned(canonical);
    temporaryCiphertexts.forEach(wipeOwned);
    if (!returned) disposeTransactionalPersistenceMediumImageForTestOnly(image);
  }
}

/** Best-effort cleanup for a returned image from this private codec. */
export function disposeTransactionalPersistenceMediumImageForTestOnly(value: unknown): void {
  try {
    const image = own(value, ["schemaVersion", "state", "receipts"] as const);
    const state = own(image.state, ["generation", "snapshotSha256", "snapshot"] as const);
    disposeOpaqueJournalSnapshotForTestOnly(state.snapshot);
  } catch { /* cleanup never changes a failure boundary */ }
}

/** Narrow test seam for codec-owned allocations; never use this for caller input. */
export function disposeOwnedTransactionalPersistenceImageCodecBytesForTestOnly(value: Uint8Array): void { wipeOwned(value); }

function wireImage(image: TransactionalPersistenceMediumImage): JsonObject {
  const state = image.state;
  const snapshot = state.snapshot;
  return {
    schemaVersion: image.schemaVersion,
    state: {
      generation: state.generation,
      snapshotSha256: state.snapshotSha256,
      snapshot: {
        schemaVersion: snapshot.schemaVersion,
        journal: snapshot.journal,
        ciphertextBlobs: snapshot.ciphertextBlobs.map((blob) => ({
          ciphertextRef: blob.ciphertextRef,
          ciphertextSha256: blob.ciphertextSha256,
          bytes: base64Url(blob.bytes),
        })),
        refIndex: snapshot.refIndex,
        issuedClaims: snapshot.issuedClaims,
      },
    },
    receipts: image.receipts,
  };
}

/** Materializes only the byte-bearing leaves; full semantic validation follows. */
function materializeWireImage(value: unknown, temporaryCiphertexts: Uint8Array[]): JsonObject {
  const root = own(value, ["schemaVersion", "state", "receipts"] as const);
  const state = own(root.state, ["generation", "snapshotSha256", "snapshot"] as const);
  const snapshot = own(state.snapshot, ["schemaVersion", "journal", "ciphertextBlobs", "refIndex", "issuedClaims"] as const);
  const journal = own(snapshot.journal, ["schemaVersion", "records", "events", "effects"] as const);
  const blobs = decodeArray(snapshot.ciphertextBlobs, MAX_ITEMS).map((candidate) => {
    const blob = own(candidate, ["ciphertextRef", "ciphertextSha256", "bytes"] as const);
    if (typeof blob.bytes !== "string") throw failed();
    const bytes = decodeBase64Url(blob.bytes);
    temporaryCiphertexts.push(bytes);
    return { ciphertextRef: blob.ciphertextRef, ciphertextSha256: blob.ciphertextSha256, bytes };
  });
  const records = decodeArray(journal.records, MAX_ITEMS);
  const events = decodeArray(journal.events, MAX_ITEMS);
  const effects = decodeArray(journal.effects, MAX_ITEMS);
  const refs = decodeArray(snapshot.refIndex, MAX_ITEMS);
  const claims = decodeArray(snapshot.issuedClaims, MAX_ITEMS);
  const receipts = decodeArray(root.receipts, MAX_RECEIPTS);
  // Each property originates from an exact own data descriptor. No untrusted
  // object is spread or assigned into an authority-bearing object.
  return {
    schemaVersion: root.schemaVersion,
    state: {
      generation: state.generation,
      snapshotSha256: state.snapshotSha256,
      snapshot: {
        schemaVersion: snapshot.schemaVersion,
        journal: { schemaVersion: journal.schemaVersion, records, events, effects },
        ciphertextBlobs: blobs,
        refIndex: refs,
        issuedClaims: claims,
      },
    },
    receipts,
  };
}

function decodeArray(value: unknown, maximum: number): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failed();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(value).length !== length + 1) throw failed();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw failed();
      result.push(descriptor.value);
    }
    return result;
  } catch { throw failed(); }
}

/** Strict RFC 4648 unpadded Base64URL: alphabet, length, and exact spelling. */
function decodeBase64Url(value: string): Uint8Array {
  let buffer: Buffer | undefined;
  let output: Uint8Array | undefined;
  try {
    if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) throw failed();
    const remainder = value.length % 4;
    const decodedLength = Math.floor(value.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1);
    if (!Number.isSafeInteger(decodedLength) || decodedLength < 0 || decodedLength > MAX_CIPHERTEXT_BYTES) throw failed();
    buffer = Buffer.from(value, "base64url");
    if (buffer.byteLength !== decodedLength || buffer.toString("base64url") !== value) throw failed();
    output = new Uint8Array(buffer);
    return output;
  } catch {
    wipeOwned(output);
    throw failed();
  } finally {
    buffer?.fill(0);
  }
}

function base64Url(value: Uint8Array): string {
  let copy: Buffer | undefined;
  try { copy = Buffer.from(value); return copy.toString("base64url"); }
  finally { copy?.fill(0); }
}

function copyAndConsumeWire(value: unknown): Uint8Array {
  const length = inspectNativeBytes(value);
  if (length === undefined || length > MAX_WIRE_BYTES) throw failed();
  try {
    if (!isExactNativeBytes(value)) throw failed();
    return new Uint8Array(value);
  } catch { throw failed(); }
  finally { wipeCallerInput(value); }
}

function inspectNativeBytes(value: unknown): number | undefined {
  try {
    if (!(value instanceof Uint8Array) || Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype || BYTE_LENGTH === undefined || BUFFER === undefined || FILL === undefined) return undefined;
    const length = BYTE_LENGTH.call(value);
    const buffer = BUFFER.call(value);
    if (!Number.isSafeInteger(length) || length < 0 || isShared(buffer)) return undefined;
    return length;
  } catch { return undefined; }
}

function isExactNativeBytes(value: unknown): value is Uint8Array {
  try {
    // Do not enumerate typed-array indexes: at the 32 MiB cap that would turn
    // a bounded input check into a multi-million-property allocation. The
    // inherited intrinsic getters are the only byte metadata we accept.
    return !Object.hasOwn(value as object, "byteLength") && !Object.hasOwn(value as object, "buffer") && !Object.hasOwn(value as object, "length");
  } catch { return false; }
}

function own<const Fields extends readonly string[]>(value: unknown, fields: Fields): Record<Fields[number], unknown> {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw failed();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) throw failed();
    const result = Object.create(null) as Record<Fields[number], unknown>;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined || !("value" in descriptor)) throw failed();
      result[field as Fields[number]] = descriptor.value;
    }
    return result;
  } catch { throw failed(); }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw failed(); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw failed();
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(Object.getOwnPropertyDescriptor(value, key)?.value)}`).join(",")}}`;
}

function isShared(value: unknown): boolean {
  if (SHARED_LENGTH === undefined) return false;
  try { return typeof SHARED_LENGTH.call(value) === "number"; } catch { return false; }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** Wipes a codec allocation with the intrinsic method; no caller-size policy applies. */
function wipeOwned(value: Uint8Array | undefined): void {
  try { if (value !== undefined) FILL?.call(value, 0); } catch { /* best effort */ }
}

/** Caller data is only claimed/consumed after native validation and the wire cap. */
function wipeCallerInput(value: unknown): void {
  try {
    const length = inspectNativeBytes(value);
    if (length !== undefined && length <= MAX_WIRE_BYTES) FILL?.call(value as Uint8Array, 0);
  } catch { /* best effort */ }
}

function failed(): TransactionalPersistenceImageCodecError { return new TransactionalPersistenceImageCodecError(); }
