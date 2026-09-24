import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  EnvelopeCryptoError,
  type EncryptedEnvelope,
  type EnvelopeContext
} from "./envelope-crypto.js";

const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const KEY = Buffer.alloc(32, 0x31);
const OTHER_KEY = Buffer.alloc(32, 0x32);
const MESSAGE = Buffer.from("private durable content");

describe("private durable envelope crypto", () => {
  it("round trips contract-canonical payloads, blobs, and intentional empty content without mutating caller bytes", () => {
    const key = Buffer.from(KEY);
    const plaintext = Buffer.from(MESSAGE);
    const payloadContext = context({ kind: "payload", contentSha256: sha256(plaintext) });
    const blobContext = context({ kind: "blob", contentSha256: sha256(plaintext) });
    const empty = Buffer.alloc(0);
    const emptyContext = context({ entityId: IDS.otherEntity, contentSha256: sha256(empty) });

    const payload = encryptEnvelope(key, plaintext, payloadContext);
    const blob = encryptEnvelope(key, plaintext, blobContext);
    const emptyEnvelope = encryptEnvelope(key, empty, emptyContext);

    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(blob)).toBe(true);
    expect(Object.isFrozen(payload.ciphertext)).toBe(false);
    expect(payload.ciphertext).not.toEqual(plaintext);
    expect(payload.ciphertext.byteLength).toBe(plaintext.byteLength);
    expect(Buffer.from(decryptEnvelope(key, payload, payloadContext))).toEqual(plaintext);
    expect(Buffer.from(decryptEnvelope(key, blob, blobContext))).toEqual(plaintext);
    expect(Buffer.from(decryptEnvelope(key, emptyEnvelope, emptyContext))).toEqual(empty);
    expect(key).toEqual(KEY);
    expect(plaintext).toEqual(MESSAGE);
  });

  it("uses a fresh 96-bit nonce and keeps payload/blob cryptographic domains separate", () => {
    const payloadContext = context({ contentSha256: sha256(MESSAGE) });
    const blobContext = context({ kind: "blob", contentSha256: sha256(MESSAGE) });
    const first = encryptEnvelope(KEY, MESSAGE, payloadContext);
    const second = encryptEnvelope(KEY, MESSAGE, payloadContext);
    const blob = encryptEnvelope(KEY, MESSAGE, blobContext);

    expect(first.nonce).toHaveLength(16);
    expect(second.nonce).toHaveLength(16);
    expect(first.nonce).not.toBe(second.nonce);
    expectAuth(() => decryptEnvelope(KEY, first, blobContext));
    expectAuth(() => decryptEnvelope(KEY, blob, payloadContext));
  });

  it("round trips each private capability journal entity kind", () => {
    for (const entityKind of ["capability-grant", "capability-grant-receipt", "capability-grant-index"] as const) {
      const item = context({ entityKind, contentSha256: sha256(MESSAGE) });
      expect(Buffer.from(decryptEnvelope(KEY, encryptEnvelope(KEY, MESSAGE, item), item))).toEqual(MESSAGE);
    }
  });

  it("gives every wrong key or changed AAD dimension the same generic authentication error", () => {
    const original = context({ contentSha256: sha256(MESSAGE) });
    const envelope = encryptEnvelope(KEY, MESSAGE, original);
    const alteredContexts: readonly EnvelopeContext[] = [
      context({ envelopeVersion: 2 as never, contentSha256: original.contentSha256 }),
      context({ spaceId: IDS.otherSpace, contentSha256: original.contentSha256 }),
      context({ keyId: IDS.otherKey, contentSha256: original.contentSha256 }),
      context({ entityId: IDS.otherEntity, contentSha256: original.contentSha256 }),
      context({ entityKind: "artifact", contentSha256: original.contentSha256 }),
      context({ schemaVersion: 2 as never, contentSha256: original.contentSha256 }),
      context({ contentRevision: 2, contentSha256: original.contentSha256 }),
      context({ kind: "blob", contentSha256: original.contentSha256 }),
      context({ contentSha256: "f".repeat(64) })
    ];

    expectAuth(() => decryptEnvelope(OTHER_KEY, envelope, original));
    for (const altered of alteredContexts) expectAuth(() => decryptEnvelope(KEY, envelope, altered));
  });

  it("rejects envelope tampering, malformed encodings, unexpected fields, and replay substitutions generically", () => {
    const firstContext = context({ contentSha256: sha256(MESSAGE) });
    const secondContext = context({ entityId: IDS.otherEntity, contentSha256: sha256(MESSAGE) });
    const otherSpaceContext = context({ spaceId: IDS.otherSpace, contentSha256: sha256(MESSAGE) });
    const envelope = encryptEnvelope(KEY, MESSAGE, firstContext);
    const cipherTamper = cloneEnvelope(envelope);
    cipherTamper.ciphertext[0]! ^= 0x01;
    const tagTamper = { ...envelope, tag: mutateBase64Url(envelope.tag) };
    const nonceTamper = { ...envelope, nonce: mutateBase64Url(envelope.nonce) };
    const tamperedDigest = differentDigest(envelope.ciphertextSha256);
    const digestTamper = { ...envelope, ciphertextSha256: tamperedDigest };
    const malformed = { ...envelope, nonce: "AA==" };
    const noncanonical = { ...envelope, tag: `${envelope.tag.slice(0, -1)}B` };
    const unexpected = { ...envelope, ignored: true };
    const missingEnvelope = { ...envelope } as Record<string, unknown>;
    delete missingEnvelope.tag;
    const accessorEnvelope = { ...envelope };
    Object.defineProperty(accessorEnvelope, "nonce", { enumerable: true, get: () => envelope.nonce });
    const prototypedEnvelope = Object.assign(Object.create({ inherited: true }) as object, envelope) as EncryptedEnvelope;
    const missingContext = { ...firstContext } as Record<string, unknown>;
    delete missingContext.keyId;
    const accessorContext = { ...firstContext };
    Object.defineProperty(accessorContext, "entityId", { enumerable: true, get: () => firstContext.entityId });
    const prototypedContext = Object.assign(Object.create({ inherited: true }) as object, firstContext) as EnvelopeContext;

    expect(tamperedDigest).not.toBe(envelope.ciphertextSha256);

    expectAuth(() => decryptEnvelope(KEY, cipherTamper, firstContext));
    expectAuth(() => decryptEnvelope(KEY, tagTamper, firstContext));
    expectAuth(() => decryptEnvelope(KEY, nonceTamper, firstContext));
    expectAuth(() => decryptEnvelope(KEY, digestTamper, firstContext));
    expectAuth(() => decryptEnvelope(KEY, malformed, firstContext));
    expectAuth(() => decryptEnvelope(KEY, noncanonical, firstContext));
    expectAuth(() => decryptEnvelope(KEY, unexpected, firstContext));
    expectAuth(() => decryptEnvelope(KEY, missingEnvelope as unknown as EncryptedEnvelope, firstContext));
    expectAuth(() => decryptEnvelope(KEY, accessorEnvelope, firstContext));
    expectAuth(() => decryptEnvelope(KEY, prototypedEnvelope, firstContext));
    expectAuth(() => decryptEnvelope(KEY, envelope, missingContext as unknown as EnvelopeContext));
    expectAuth(() => decryptEnvelope(KEY, envelope, accessorContext));
    expectAuth(() => decryptEnvelope(KEY, envelope, prototypedContext));
    expectAuth(() => decryptEnvelope(KEY, envelope, secondContext));
    expectAuth(() => decryptEnvelope(KEY, envelope, otherSpaceContext));
  });

  it("rejects bad encryption inputs and bounded decrypt inputs without exposing details", () => {
    const validContext = context({ contentSha256: sha256(MESSAGE) });
    const envelope = encryptEnvelope(KEY, MESSAGE, validContext);
    const tooLarge = Buffer.alloc(MAX_CONTENT_BYTES + 1);
    const maximum = Buffer.alloc(MAX_CONTENT_BYTES, 0x5a);
    const maximumContext = context({ entityId: IDS.otherEntity, contentSha256: sha256(maximum) });
    const maximumEnvelope = encryptEnvelope(KEY, maximum, maximumContext);
    const oversizedEnvelope = {
      ...envelope,
      ciphertext: tooLarge,
      ciphertextSha256: sha256(tooLarge)
    };

    expectInput(() => encryptEnvelope(Buffer.alloc(31), MESSAGE, validContext));
    expectInput(() => encryptEnvelope(Buffer.alloc(33), MESSAGE, validContext));
    expectInput(() => encryptEnvelope(KEY, MESSAGE, context({ contentSha256: "0".repeat(64) })));
    expectInput(() => encryptEnvelope(KEY, tooLarge, context({ contentSha256: sha256(tooLarge) })));
    expectInput(() => encryptEnvelope(KEY, MESSAGE, context({ contentRevision: Number.MAX_SAFE_INTEGER + 1, contentSha256: sha256(MESSAGE) })));
    const maximumRoundTrip = decryptEnvelope(KEY, maximumEnvelope, maximumContext);
    expect(maximumRoundTrip.byteLength).toBe(maximum.byteLength);
    expect(sha256(maximumRoundTrip)).toBe(maximumContext.contentSha256);
    expectAuth(() => decryptEnvelope(Buffer.alloc(31), envelope, validContext));
    expectAuth(() => decryptEnvelope(KEY, envelope, context({ contentRevision: Number.MAX_SAFE_INTEGER + 1, contentSha256: sha256(MESSAGE) })));
    expectAuth(() => decryptEnvelope(KEY, oversizedEnvelope, validContext));
  });

  it("rejects SharedArrayBuffer-backed key, plaintext, and ciphertext inputs", () => {
    const validContext = context({ contentSha256: sha256(MESSAGE) });
    const envelope = encryptEnvelope(KEY, MESSAGE, validContext);
    const sharedKey = sharedBytes(KEY);
    const sharedPlaintext = sharedBytes(MESSAGE);
    const sharedCiphertext = sharedBytes(envelope.ciphertext);
    const sharedEnvelope = { ...envelope, ciphertext: sharedCiphertext };

    expectInput(() => encryptEnvelope(sharedKey, MESSAGE, validContext));
    expectInput(() => encryptEnvelope(KEY, sharedPlaintext, validContext));
    expectAuth(() => decryptEnvelope(sharedKey, envelope, validContext));
    expectAuth(() => decryptEnvelope(KEY, sharedEnvelope, validContext));
  });

  it("rejects shadowed typed-array metadata while accepting ordinary Buffer and Uint8Array inputs", () => {
    const validContext = context({ contentSha256: sha256(MESSAGE) });
    const ordinaryKey = new Uint8Array(KEY);
    const ordinaryPlaintext = new Uint8Array(MESSAGE);
    const ordinaryEnvelope = encryptEnvelope(ordinaryKey, ordinaryPlaintext, validContext);
    const sharedSpoof = sharedBytes(KEY);
    const prototypeAlteredSharedSpoof = prototypeAlteredSharedBytes(KEY);
    const oversizedSpoof = new Uint8Array(MAX_CONTENT_BYTES + 1);
    spoofTypedArrayMetadata(sharedSpoof, new ArrayBuffer(KEY.byteLength), KEY.byteLength);
    spoofTypedArrayMetadata(prototypeAlteredSharedSpoof, new ArrayBuffer(KEY.byteLength), KEY.byteLength);
    spoofTypedArrayMetadata(oversizedSpoof, new ArrayBuffer(1), 1);

    expect(Buffer.from(decryptEnvelope(ordinaryKey, ordinaryEnvelope, validContext))).toEqual(MESSAGE);
    expectInput(() => encryptEnvelope(sharedSpoof, MESSAGE, validContext));
    expectInput(() => encryptEnvelope(prototypeAlteredSharedSpoof, MESSAGE, validContext));
    expectInput(() => encryptEnvelope(KEY, oversizedSpoof, context({ contentSha256: sha256(oversizedSpoof) })));
  });

  it.each([0, 4_096])("snapshots key, plaintext, and ciphertext despite own length %i", (spoofedLength) => {
    const key = new Uint8Array(KEY);
    const plaintext = new Uint8Array(MESSAGE);
    const validContext = context({ contentSha256: sha256(plaintext) });
    spoofTypedArrayLength(key, spoofedLength);
    spoofTypedArrayLength(plaintext, spoofedLength);
    const envelope = encryptEnvelope(key, plaintext, validContext);
    const ciphertext = new Uint8Array(envelope.ciphertext);
    spoofTypedArrayLength(ciphertext, spoofedLength);

    expect(Buffer.from(decryptEnvelope(key, { ...envelope, ciphertext }, validContext))).toEqual(MESSAGE);
  });
});

const IDS = {
  space: "11111111-1111-4111-8111-111111111111",
  otherSpace: "22222222-2222-4222-8222-222222222222",
  key: "33333333-3333-4333-8333-333333333333",
  otherKey: "44444444-4444-4444-8444-444444444444",
  entity: "55555555-5555-4555-8555-555555555555",
  otherEntity: "66666666-6666-4666-8666-666666666666"
} as const;

function context(overrides: Partial<EnvelopeContext> = {}): EnvelopeContext {
  return {
    envelopeVersion: 1,
    spaceId: IDS.space,
    keyId: IDS.key,
    entityId: IDS.entity,
    entityKind: "task",
    schemaVersion: 1,
    contentRevision: 1,
    kind: "payload",
    contentSha256: sha256(MESSAGE),
    ...overrides
  } as EnvelopeContext;
}

function cloneEnvelope(value: EncryptedEnvelope): EncryptedEnvelope {
  return { ...value, ciphertext: new Uint8Array(value.ciphertext) };
}

function mutateBase64Url(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0]! ^= 0x01;
  return bytes.toString("base64url");
}

function differentDigest(value: string): string {
  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
}

function sharedBytes(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(new SharedArrayBuffer(value.byteLength));
  result.set(value);
  return result;
}

function prototypeAlteredSharedBytes(value: Uint8Array): Uint8Array {
  const backing = new SharedArrayBuffer(value.byteLength);
  Object.setPrototypeOf(backing, ArrayBuffer.prototype);
  const result = new Uint8Array(backing);
  result.set(value);
  return result;
}

function spoofTypedArrayMetadata(value: Uint8Array, buffer: ArrayBuffer, byteLength: number): void {
  Object.defineProperties(value, {
    buffer: { configurable: true, value: buffer },
    byteLength: { configurable: true, value: byteLength }
  });
}

function spoofTypedArrayLength(value: Uint8Array, length: number): void {
  Object.defineProperty(value, "length", { configurable: true, value: length });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectInput(action: () => unknown): void {
  expectFailure(action, "ENVELOPE_INPUT_INVALID", "Envelope input is invalid.");
}

function expectAuth(action: () => unknown): void {
  expectFailure(action, "ENVELOPE_AUTH_FAILED", "Envelope authentication failed.");
}

function expectFailure(action: () => unknown, code: string, message: string): void {
  try {
    action();
    throw new Error("Expected envelope crypto to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(EnvelopeCryptoError);
    expect(error).toMatchObject({ code, message });
  }
}
