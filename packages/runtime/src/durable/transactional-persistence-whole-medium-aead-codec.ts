import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import {
  decodeOwnedTransactionalPersistenceMediumImage,
  disposeTransactionalPersistenceMediumImageForTestOnly,
  encodeTransactionalPersistenceMediumImage,
} from "./transactional-persistence-image-codec.js";
import { type WorkspaceKeyProvider, type WorkspaceKeyReference } from "./encrypted-work-store.js";
import { type TransactionalPersistenceMediumImage } from "./transactional-persistence.js";

/**
 * This is a private filesystem wire seam. It intentionally has no runtime-barrel
 * export: callers must inject both a trusted root capability and an out-of-band
 * workspace-key reference. Nothing on disk chooses a key.
 */
export class TransactionalPersistenceWholeMediumAeadCodecError extends Error {
  readonly code = "TRANSACTIONAL_PERSISTENCE_WHOLE_MEDIUM_AEAD_CODEC_FAILED" as const;
  constructor() { super("Transactional persistence whole-medium AEAD codec operation failed."); this.name = "TransactionalPersistenceWholeMediumAeadCodecError"; }
}

const VERSION = 1;
const ALGORITHM = "aes-256-gcm" as const;
const PROTECTION_KIND = "whole-medium-aead-v1" as const;
const DOMAIN = "switchboard/private/transactional-medium/v1";
const GENESIS_PREDECESSOR = sha256Text(`${DOMAIN}/genesis`);
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
// JSON plus unpadded base64url expansion for a max-size inner image. The small
// constant leaves room for the fixed metadata but never admits an unbounded wire.
const MAX_WIRE_BYTES = Math.ceil(MAX_PLAINTEXT_BYTES / 3) * 4 + 4 * 1024;
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, "byteLength")?.get;
const BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, "buffer")?.get;
const FILL = Object.getOwnPropertyDescriptor(TYPED_ARRAY, "fill")?.value as ((this: Uint8Array, value: number) => Uint8Array) | undefined;
const SHARED_LENGTH = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const CANONICAL_DURABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface WholeMediumAeadProtectionMarkerForTestOnly {
  readonly kind: typeof PROTECTION_KIND;
  readonly version: typeof VERSION;
  readonly algorithm: typeof ALGORITHM;
  readonly keyReferenceSha256: string;
  readonly rootBindingSha256: string;
}

export interface WholeMediumAeadSealedMediumForTestOnly {
  readonly bytes: Uint8Array;
  readonly envelopeWireSha256: string;
}

export interface WholeMediumAeadOpenedMediumForTestOnly {
  readonly image: TransactionalPersistenceMediumImage;
  readonly innerBytes: Uint8Array;
  readonly envelopeWireSha256: string;
}

/** A root is supplied only by the filesystem after it has pinned and checked it. */
export interface WholeMediumAeadFilesystemWireCodecForTestOnly {
  readonly maximumWireBytes: number;
  markerForRoot(rootBindingSha256: string): WholeMediumAeadProtectionMarkerForTestOnly;
  seal(rootBindingSha256: string, generation: number, predecessorEnvelopeSha256: string | undefined, innerBytes: Uint8Array): Promise<WholeMediumAeadSealedMediumForTestOnly>;
  open(rootBindingSha256: string, filenameGeneration: number, predecessorEnvelopeSha256: string | undefined, wire: Uint8Array): Promise<WholeMediumAeadOpenedMediumForTestOnly>;
  inspectGeneration(rootBindingSha256: string, wire: Uint8Array): number;
}

/**
 * Construct an inactive test-only codec with the exact injected key reference.
 * The returned codec cannot choose a reference from wire metadata.
 */
export function createWholeMediumAeadFilesystemWireCodecForTestOnly(provider: WorkspaceKeyProvider, reference: WorkspaceKeyReference): WholeMediumAeadFilesystemWireCodecForTestOnly {
  const safeProvider = captureProvider(provider);
  const safeReference = captureReference(reference);
  const referenceSha256 = sha256Text(canonicalJson({ keyId: safeReference.keyId, spaceId: safeReference.spaceId }));
  const reentry = new AsyncLocalStorage<{ reentered: boolean }>();
  return Object.freeze({
    maximumWireBytes: MAX_WIRE_BYTES,
    markerForRoot(rootBindingSha256: string): WholeMediumAeadProtectionMarkerForTestOnly {
      assertSha256(rootBindingSha256);
      return Object.freeze({ kind: PROTECTION_KIND, version: VERSION, algorithm: ALGORITHM, keyReferenceSha256: referenceSha256, rootBindingSha256 });
    },
    async seal(rootBindingSha256: string, generation: number, predecessorEnvelopeSha256: string | undefined, innerBytes: Uint8Array): Promise<WholeMediumAeadSealedMediumForTestOnly> {
      let plain: Uint8Array | undefined; let nonce: Uint8Array | undefined; let tag: Uint8Array | undefined; let ciphertext: Uint8Array | undefined; let output: Uint8Array | undefined; let aad: Buffer | undefined;
      try {
        assertBinding(rootBindingSha256, generation, predecessorEnvelopeSha256);
        plain = copyOwnedBytes(innerBytes, MAX_PLAINTEXT_BYTES);
        // The image codec is the canonical inner authority. Validate it before
        // entering the provider, so malformed input has no key-provider effect.
        const inner = decodeOwnedTransactionalPersistenceMediumImage(new Uint8Array(plain));
        try {
          const canonical = encodeTransactionalPersistenceMediumImage(inner);
          try { if (!sameBytes(canonical, plain) || inner.state.generation !== generation || !sameSpace(inner, safeReference.spaceId)) throw failed(); }
          finally { wipe(canonical); }
        } finally { disposeTransactionalPersistenceMediumImageForTestOnly(inner); }
        nonce = new Uint8Array(randomBytes(12));
        aad = aadFor(rootBindingSha256, generation, predecessorEnvelopeSha256, plain.byteLength, referenceSha256);
        const encrypted = await withDerivedKey(safeProvider, safeReference, reentry, (key) => {
          let cipher: ReturnType<typeof createCipheriv> | undefined; let first: Buffer | undefined; let last: Buffer | undefined; let joined: Buffer | undefined;
          try {
            cipher = createCipheriv(ALGORITHM, key, nonce!, { authTagLength: 16 });
            const aead = cipher as unknown as { setAAD(value: Uint8Array, options: { plaintextLength: number }): void; getAuthTag(): Uint8Array };
            aead.setAAD(aad!, { plaintextLength: plain!.byteLength });
            first = cipher.update(plain!); last = cipher.final(); tag = new Uint8Array(aead.getAuthTag()); joined = Buffer.concat([first, last]);
            return new Uint8Array(joined);
          } finally { first?.fill(0); last?.fill(0); joined?.fill(0); cipher?.destroy(); }
        });
        ciphertext = encrypted;
        const outer: OuterWire = {
          schemaVersion: VERSION,
          protection: { kind: PROTECTION_KIND, version: VERSION },
          algorithm: ALGORITHM,
          keyReferenceSha256: referenceSha256,
          rootBindingSha256,
          generation,
          predecessorEnvelopeSha256: predecessorOrGenesis(predecessorEnvelopeSha256),
          plaintextByteLength: plain.byteLength,
          nonce: base64Url(nonce),
          tag: base64Url(tag!),
          ciphertext: base64Url(ciphertext),
        };
        output = encoder.encode(canonicalJson(outer));
        if (output.byteLength < 1 || output.byteLength > MAX_WIRE_BYTES) throw failed();
        const result = Object.freeze({ bytes: output, envelopeWireSha256: sha256(output) }); output = undefined; return result;
      } catch { throw failed(); }
      finally { aad?.fill(0); wipe(plain); wipe(nonce); wipe(tag); wipe(ciphertext); wipe(output); }
    },
    async open(rootBindingSha256: string, filenameGeneration: number, predecessorEnvelopeSha256: string | undefined, wire: Uint8Array): Promise<WholeMediumAeadOpenedMediumForTestOnly> {
      let parsed: ParsedOuter | undefined; let plain: Uint8Array | undefined; let innerBytes: Uint8Array | undefined; let image: TransactionalPersistenceMediumImage | undefined; let aad: Buffer | undefined;
      try {
        assertBinding(rootBindingSha256, filenameGeneration, predecessorEnvelopeSha256);
        parsed = parseOuter(wire, rootBindingSha256, referenceSha256);
        if (parsed.generation !== filenameGeneration || parsed.predecessorEnvelopeSha256 !== predecessorOrGenesis(predecessorEnvelopeSha256)) throw failed();
        aad = aadFor(rootBindingSha256, filenameGeneration, predecessorEnvelopeSha256, parsed.plaintextByteLength, referenceSha256);
        plain = await withDerivedKey(safeProvider, safeReference, reentry, (key) => {
          let decipher: ReturnType<typeof createDecipheriv> | undefined; let first: Buffer | undefined; let last: Buffer | undefined; let joined: Buffer | undefined;
          try {
            decipher = createDecipheriv(ALGORITHM, key, parsed!.nonce, { authTagLength: 16 });
            const aead = decipher as unknown as { setAAD(value: Uint8Array, options: { plaintextLength: number }): void; setAuthTag(value: Uint8Array): void };
            aead.setAAD(aad!, { plaintextLength: parsed!.plaintextByteLength }); aead.setAuthTag(parsed!.tag);
            first = decipher.update(parsed!.ciphertext); last = decipher.final(); joined = Buffer.concat([first, last]); return new Uint8Array(joined);
          } finally { first?.fill(0); last?.fill(0); joined?.fill(0); decipher?.destroy(); }
        });
        if (plain.byteLength !== parsed.plaintextByteLength || plain.byteLength > MAX_PLAINTEXT_BYTES) throw failed();
        image = decodeOwnedTransactionalPersistenceMediumImage(new Uint8Array(plain));
        innerBytes = encodeTransactionalPersistenceMediumImage(image);
        if (!sameBytes(innerBytes, plain) || image.state.generation !== filenameGeneration || !sameSpace(image, safeReference.spaceId)) throw failed();
        const result = Object.freeze({ image, innerBytes, envelopeWireSha256: parsed.envelopeWireSha256 }); image = undefined; innerBytes = undefined; return result;
      } catch { throw failed(); }
      finally { aad?.fill(0); disposeParsed(parsed); wipe(plain); wipe(innerBytes); disposeTransactionalPersistenceMediumImageForTestOnly(image); }
    },
    inspectGeneration(rootBindingSha256: string, wire: Uint8Array): number {
      let parsed: ParsedOuter | undefined;
      try { parsed = parseOuter(wire, rootBindingSha256, referenceSha256); return parsed.generation; } catch { throw failed(); }
      finally { disposeParsed(parsed); }
    },
  });
}

interface OuterWire {
  readonly schemaVersion: number;
  readonly protection: { readonly kind: string; readonly version: number };
  readonly algorithm: string;
  readonly keyReferenceSha256: string;
  readonly rootBindingSha256: string;
  readonly generation: number;
  readonly predecessorEnvelopeSha256: string;
  readonly plaintextByteLength: number;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}
interface ParsedOuter {
  readonly generation: number;
  readonly predecessorEnvelopeSha256: string;
  readonly plaintextByteLength: number;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly envelopeWireSha256: string;
}

async function withDerivedKey(provider: CapturedProvider, reference: WorkspaceKeyReference, reentry: AsyncLocalStorage<{ reentered: boolean }>, operation: (derived: Uint8Array) => Uint8Array): Promise<Uint8Array> {
  const parent = reentry.getStore();
  if (parent !== undefined) { parent.reentered = true; throw failed(); }
  const audit = { reentered: false };
  return await reentry.run(audit, async () => withDerivedKeyInContext(provider, reference, audit, operation));
}

async function withDerivedKeyInContext(provider: CapturedProvider, reference: WorkspaceKeyReference, audit: { reentered: boolean }, operation: (derived: Uint8Array) => Uint8Array): Promise<Uint8Array> {
  let callbackCalls = 0; let callbackCompleted = false; let providerReturned = false; let result: Uint8Array | undefined;
  const callback = async (provided: Uint8Array): Promise<void> => {
    let root: Uint8Array | undefined; let derived: Uint8Array | undefined;
    try {
      callbackCalls += 1; if (providerReturned || callbackCalls !== 1) throw failed();
      root = copyKey(provided);
      derived = derive(root, reference);
      result = operation(derived);
      callbackCompleted = true;
    } finally { wipe(root); wipe(derived); }
  };
  try {
    const boundary = provider.method.call(provider.host, reference, callback);
    if (!isNativePromise(boundary)) throw failed();
    const resolved = await boundary;
    providerReturned = true;
    if (resolved !== undefined || callbackCalls !== 1 || !callbackCompleted || result === undefined || audit.reentered) throw failed();
    const output = result; result = undefined; return output;
  } catch { wipe(result); throw failed(); }
}

function parseOuter(input: Uint8Array, rootBindingSha256: string, referenceSha256: string): ParsedOuter {
  let copy: Uint8Array | undefined; let nonce: Uint8Array | undefined; let tag: Uint8Array | undefined; let ciphertext: Uint8Array | undefined;
  try {
    copy = copyOwnedBytes(input, MAX_WIRE_BYTES);
    const value: unknown = JSON.parse(decoder.decode(copy));
    const outer = own(value, ["schemaVersion", "protection", "algorithm", "keyReferenceSha256", "rootBindingSha256", "generation", "predecessorEnvelopeSha256", "plaintextByteLength", "nonce", "tag", "ciphertext"] as const);
    const protection = own(outer.protection, ["kind", "version"] as const);
    if (outer.schemaVersion !== VERSION || protection.kind !== PROTECTION_KIND || protection.version !== VERSION || outer.algorithm !== ALGORITHM || outer.keyReferenceSha256 !== referenceSha256 || outer.rootBindingSha256 !== rootBindingSha256) throw failed();
    if (!validGeneration(outer.generation) || !isSha256(outer.predecessorEnvelopeSha256) || !validPlaintextLength(outer.plaintextByteLength) || typeof outer.nonce !== "string" || typeof outer.tag !== "string" || typeof outer.ciphertext !== "string") throw failed();
    nonce = decodeBase64Url(outer.nonce, 12); tag = decodeBase64Url(outer.tag, 16); ciphertext = decodeBase64Url(outer.ciphertext, outer.plaintextByteLength);
    const canonical = encoder.encode(canonicalJson({ schemaVersion: outer.schemaVersion, protection: { kind: protection.kind, version: protection.version }, algorithm: outer.algorithm, keyReferenceSha256: outer.keyReferenceSha256, rootBindingSha256: outer.rootBindingSha256, generation: outer.generation, predecessorEnvelopeSha256: outer.predecessorEnvelopeSha256, plaintextByteLength: outer.plaintextByteLength, nonce: outer.nonce, tag: outer.tag, ciphertext: outer.ciphertext }));
    try { if (!sameBytes(copy, canonical)) throw failed(); } finally { wipe(canonical); }
    const result = Object.freeze({ generation: outer.generation, predecessorEnvelopeSha256: outer.predecessorEnvelopeSha256, plaintextByteLength: outer.plaintextByteLength, nonce, tag, ciphertext, envelopeWireSha256: sha256(copy) }); nonce = undefined; tag = undefined; ciphertext = undefined; return result;
  } catch { throw failed(); }
  finally { wipe(copy); wipe(nonce); wipe(tag); wipe(ciphertext); }
}

function aadFor(rootBindingSha256: string, generation: number, predecessorEnvelopeSha256: string | undefined, plaintextByteLength: number, referenceSha256: string): Buffer {
  return Buffer.from(canonicalJson({ domain: DOMAIN, version: VERSION, algorithm: ALGORITHM, keyReferenceSha256: referenceSha256, rootBindingSha256, generation, predecessorEnvelopeSha256: predecessorOrGenesis(predecessorEnvelopeSha256), plaintextByteLength }), "utf8");
}

function derive(root: Uint8Array, reference: WorkspaceKeyReference): Uint8Array {
  let salt: Buffer | undefined; let info: Buffer | undefined;
  try {
    salt = Buffer.from(sha256Text(canonicalJson({ domain: DOMAIN, keyId: reference.keyId, spaceId: reference.spaceId })), "hex"); info = Buffer.from(DOMAIN, "utf8");
    return new Uint8Array(hkdfSync("sha256", root, salt, info, 32));
  } finally { salt?.fill(0); info?.fill(0); }
}

interface CapturedProvider { readonly host: WorkspaceKeyProvider; readonly method: WorkspaceKeyProvider["withUnlockedKey"]; }
function captureProvider(value: unknown): CapturedProvider {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value)) throw failed();
    const descriptor = Object.getOwnPropertyDescriptor(value, "withUnlockedKey");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") throw failed();
    const method = descriptor.value as WorkspaceKeyProvider["withUnlockedKey"];
    return Object.freeze({ host: value as WorkspaceKeyProvider, method });
  } catch { throw failed(); }
}

function captureReference(value: unknown): WorkspaceKeyReference {
  try {
    const fields = own(value, ["spaceId", "keyId"] as const);
    if (!validReferencePart(fields.spaceId) || !validReferencePart(fields.keyId)) throw failed();
    return Object.freeze({ spaceId: fields.spaceId, keyId: fields.keyId });
  } catch { throw failed(); }
}

function copyKey(value: unknown): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype || types.isProxy(value) || BYTE_LENGTH === undefined || BUFFER === undefined || FILL === undefined || Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "length")) throw failed();
    const length = BYTE_LENGTH.call(value); const buffer = BUFFER.call(value);
    if (length !== 32 || isShared(buffer)) throw failed(); return new Uint8Array(value);
  } catch { throw failed(); }
}

function copyOwnedBytes(value: unknown, maximum: number): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype || types.isProxy(value) || BYTE_LENGTH === undefined || BUFFER === undefined || Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "length")) throw failed();
    const length = BYTE_LENGTH.call(value); const buffer = BUFFER.call(value);
    if (!Number.isSafeInteger(length) || length < 1 || length > maximum || isShared(buffer)) throw failed(); return new Uint8Array(value);
  } catch { throw failed(); }
}

function decodeBase64Url(value: string, exactLength: number): Uint8Array {
  let buffer: Buffer | undefined; let result: Uint8Array | undefined;
  try {
    if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) throw failed();
    buffer = Buffer.from(value, "base64url"); if (buffer.byteLength !== exactLength || buffer.toString("base64url") !== value) throw failed(); result = new Uint8Array(buffer); return result;
  } catch { wipe(result); throw failed(); }
  finally { buffer?.fill(0); }
}
function base64Url(value: Uint8Array): string { let copy: Buffer | undefined; try { copy = Buffer.from(value); return copy.toString("base64url"); } finally { copy?.fill(0); } }
function own<const Fields extends readonly string[]>(value: unknown, fields: Fields): Record<Fields[number], unknown> {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || types.isProxy(value)) throw failed();
    const keys = Reflect.ownKeys(value); if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) throw failed();
    const result = Object.create(null) as Record<Fields[number], unknown>;
    for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor === undefined || !("value" in descriptor)) throw failed(); result[field as Fields[number]] = descriptor.value; }
    return result;
  } catch { throw failed(); }
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw failed(); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw failed();
  const object = value as Record<string, unknown>; const keys = Object.keys(object).sort(); return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(Object.getOwnPropertyDescriptor(object, key)?.value)}`).join(",")}}`;
}
function assertBinding(rootBindingSha256: string, generation: number, predecessor: string | undefined): void { assertSha256(rootBindingSha256); if (!validGeneration(generation) || (predecessor !== undefined && !isSha256(predecessor))) throw failed(); if (generation === 0 ? predecessor !== undefined : predecessor === undefined) throw failed(); }
function predecessorOrGenesis(value: string | undefined): string { return value ?? GENESIS_PREDECESSOR; }
function validGeneration(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 256; }
function validPlaintextLength(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PLAINTEXT_BYTES; }
function validReferencePart(value: unknown): value is string { return typeof value === "string" && CANONICAL_DURABLE_ID.test(value); }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function assertSha256(value: unknown): asserts value is string { if (!isSha256(value)) throw failed(); }
function isNativePromise(value: unknown): value is Promise<unknown> { try { return value instanceof Promise && Object.getPrototypeOf(value) === Promise.prototype && !types.isProxy(value); } catch { return false; } }
function isShared(value: unknown): boolean { if (SHARED_LENGTH === undefined) return false; try { return typeof SHARED_LENGTH.call(value) === "number"; } catch { return false; } }
function disposeParsed(value: ParsedOuter | undefined): void { if (value === undefined) return; wipe(value.nonce); wipe(value.tag); wipe(value.ciphertext); }
function sameSpace(image: TransactionalPersistenceMediumImage, expectedSpaceId: string): boolean {
  try {
    const journal = image.state.snapshot.journal;
    return [...journal.records, ...journal.events, ...journal.effects].every((entry) => (entry as { readonly spaceId?: unknown }).spaceId === expectedSpaceId);
  } catch { return false; }
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; let difference = 0; for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!; return difference === 0; }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function wipe(value: Uint8Array | undefined): void { try { if (value !== undefined) FILL?.call(value, 0); } catch { /* best effort for owned temporary memory */ } }
function failed(): TransactionalPersistenceWholeMediumAeadCodecError { return new TransactionalPersistenceWholeMediumAeadCodecError(); }
