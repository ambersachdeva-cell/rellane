import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryWorkStore, type StoredOpaqueRecord } from "./in-memory-work-store.js";
import {
  InMemoryTransactionalPersistenceMedium,
  snapshotFromInMemoryWorkStoreForTestOnly,
  type TransactionalPersistenceMediumImage,
} from "./transactional-persistence.js";
import {
  TransactionalPersistenceImageCodecError,
  decodeOwnedTransactionalPersistenceMediumImage,
  disposeOwnedTransactionalPersistenceImageCodecBytesForTestOnly,
  disposeTransactionalPersistenceMediumImageForTestOnly,
  encodeTransactionalPersistenceMediumImage,
} from "./transactional-persistence-image-codec.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const SPACE = id(1); const TASK = id(2); const RUN = id(3);
const encoder = new TextEncoder(); const decoder = new TextDecoder();

function record(kind: "task" | "run", entityId: string, ref: string, ciphertext: Uint8Array): StoredOpaqueRecord {
  return { ciphertext, record: { schemaVersion: 1, id: entityId, spaceId: SPACE, recordRevision: 1,
    idempotency: kind === "task" ? { kind, idempotencyKeySha256: hash("task") } : { kind, taskId: TASK, attempt: 1 },
    envelope: { envelopeVersion: 1, spaceId: SPACE, keyId: id(90), entityId, entityKind: kind, schemaVersion: 1, contentRevision: 1,
      kind: "payload", contentSha256: hash(`plain-${kind}`), nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: ref, ciphertextSha256: hash(ciphertext), tag: "AAAAAAAAAAAAAAAAAAAAAA" },
  } } as StoredOpaqueRecord;
}

function nonemptyImage(): TransactionalPersistenceMediumImage {
  const claimIds = [id(60)]; const eventIds = [id(21), id(22)];
  const store = new InMemoryWorkStore(() => claimIds.shift() ?? id(61), () => eventIds.shift() ?? id(29));
  store.putRecord(record("task", TASK, id(100), new Uint8Array(Buffer.from("task"))));
  const run = record("run", RUN, id(101), new Uint8Array(Buffer.from("run"))); store.putRecord(run);
  store.appendEvent({ schemaVersion: 1, id: id(20), spaceId: SPACE, runId: RUN, runRevision: 1, sequence: 1, kind: "run-recorded", runCiphertextSha256: run.record.envelope.ciphertextSha256, effectId: null, effectRevision: null, effectState: null, claimSha256: null });
  const effect = store.putEffect({ schemaVersion: 1, id: id(30), spaceId: SPACE, runId: RUN, runRevision: 1, stepKey: id(31), requestSha256: hash("effect"), state: "pending", effectRevision: 1, claimId: null });
  store.claimEffect(SPACE, effect.id, 1);
  const medium = new InMemoryTransactionalPersistenceMedium(); const port = medium.openPortForTestOnly(); const before = port.recover();
  port.commit({ commitId: id(200), expectedGeneration: before.generation, expectedSnapshotSha256: before.snapshotSha256, operationBindingSha256: hash("binding"), snapshot: snapshotFromInMemoryWorkStoreForTestOnly(store) });
  return medium.exportImageForTestOnly();
}

function expectFailure(action: () => unknown): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(TransactionalPersistenceImageCodecError);
  expect(error).toMatchObject({ code: "TRANSACTIONAL_PERSISTENCE_IMAGE_CODEC_FAILED", message: "Transactional persistence image codec operation failed." });
}

function bytesFor(value: unknown): Uint8Array { return encoder.encode(JSON.stringify(value)); }
function canonicalBytes(value: unknown): Uint8Array { return encoder.encode(canonicalText(value)); }
function mutableWire(bytes: Uint8Array): Record<string, unknown> { return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>; }
function canonicalText(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (value === null || typeof value !== "object") throw new Error("fixture");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalText((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function imageWith(image: TransactionalPersistenceMediumImage, snapshot: unknown): unknown {
  return { schemaVersion: 1, state: { generation: image.state.generation, snapshotSha256: image.state.snapshotSha256, snapshot }, receipts: image.receipts };
}
function expectEncodeFailurePreserves(value: unknown, bytes: Uint8Array): void {
  const before = hash(bytes);
  expectFailure(() => encodeTransactionalPersistenceMediumImage(value));
  expect(hash(bytes)).toBe(before);
}

describe("private transactional persistence image codec", () => {
  it("deterministically round trips empty and transcript-backed encrypted images without aliases", () => {
    const empty = new InMemoryTransactionalPersistenceMedium().exportImageForTestOnly();
    const emptyOne = encodeTransactionalPersistenceMediumImage(empty); const emptyTwo = encodeTransactionalPersistenceMediumImage(empty);
    expect([...emptyOne]).toEqual([...emptyTwo]);
    const decodedEmpty = decodeOwnedTransactionalPersistenceMediumImage(new Uint8Array(emptyOne));
    expect(decodedEmpty).toEqual(empty);

    const image = nonemptyImage(); const first = encodeTransactionalPersistenceMediumImage(image); const second = encodeTransactionalPersistenceMediumImage(image);
    expect([...first]).toEqual([...second]);
    expect(decoder.decode(first)).toContain('"bytes":"dGFzaw"');
    const supplied = new Uint8Array(first); const decoded = decodeOwnedTransactionalPersistenceMediumImage(supplied);
    expect(supplied.every((byte) => byte === 0)).toBe(true);
    expect(decoded).toEqual(image);
    expect(decoded.state.snapshot.ciphertextBlobs[0]!.bytes.buffer).not.toBe(supplied.buffer);
    expect(decoded.state.snapshot.journal.events).toHaveLength(3);
    expect(decoded.state.snapshot.journal.effects).toMatchObject([{ state: "claimed", claimId: id(60) }]);
    expect(decoded.state.snapshot.issuedClaims).toEqual([{ effectId: id(30), claimIds: [id(60)] }]);
    const original = image.state.snapshot.ciphertextBlobs[0]!.bytes;
    decoded.state.snapshot.ciphertextBlobs[0]!.bytes.fill(0);
    expect(original.some((byte) => byte !== 0)).toBe(true);
    disposeTransactionalPersistenceMediumImageForTestOnly(decoded);
    expect(decoded.state.snapshot.ciphertextBlobs.every((blob) => blob.bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("rejects noncanonical JSON and strict unpadded Base64URL spellings while consuming valid-sized input", () => {
    const encoded = encodeTransactionalPersistenceMediumImage(nonemptyImage());
    const cases: Uint8Array[] = [
      new Uint8Array([0xef, 0xbb, 0xbf, ...encoded]),
      encoder.encode(` ${decoder.decode(encoded)}`),
      encoder.encode(`${decoder.decode(encoded)}\n`),
      encoder.encode(decoder.decode(encoded).replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,')),
      encoder.encode(decoder.decode(encoded).replace('"bytes":"dGFzaw"', '"bytes":"dGFzaw=="')),
      bytesFor({ state: mutableWire(encoded).state, schemaVersion: 1, receipts: mutableWire(encoded).receipts }),
    ];
    for (const supplied of cases) {
      expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(supplied));
      expect(supplied.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("rejects fatal UTF-8 and every noncanonical unpadded Base64URL spelling while consuming valid-sized input", () => {
    const encoded = encodeTransactionalPersistenceMediumImage(nonemptyImage());
    const text = decoder.decode(encoded);
    const spellings = [
      new Uint8Array([0xff]),
      encoder.encode(text.replace('"bytes":"dGFzaw"', '"bytes":"dGFzaw=="')),
      encoder.encode(text.replace('"bytes":"dGFzaw"', '"bytes":"dGFzaw++"')),
      encoder.encode(text.replace('"bytes":"dGFzaw"', '"bytes":"dGFz aw"')),
      encoder.encode(text.replace('"bytes":"dGFzaw"', '"bytes":"dGFza"')),
      // The low discarded bits differ, but canonical Base64URL encoding is aw.
      encoder.encode(text.replace('"bytes":"dGFzaw"', '"bytes":"dGFzax"')),
    ];
    for (const supplied of spellings) {
      expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(supplied));
      expect(supplied.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("rejects modified generation, state hash, receipt, ref, and ciphertext through the existing full-image validator", () => {
    const encoded = encodeTransactionalPersistenceMediumImage(nonemptyImage());
    const variants: Array<(wire: Record<string, unknown>) => void> = [
      (wire) => { (wire.state as Record<string, unknown>).generation = 2; },
      (wire) => { (wire.state as Record<string, unknown>).snapshotSha256 = "b".repeat(64); },
      (wire) => { ((wire.receipts as Array<Record<string, unknown>>)[0]!).operationBindingSha256 = "b".repeat(64); },
      (wire) => { ((((wire.state as Record<string, unknown>).snapshot as Record<string, unknown>).refIndex as Array<Record<string, unknown>>)[0]!).ciphertextRef = id(999); },
      (wire) => { ((((wire.state as Record<string, unknown>).snapshot as Record<string, unknown>).ciphertextBlobs as Array<Record<string, unknown>>)[0]!).bytes = "ZXZpbA"; },
    ];
    for (const mutate of variants) {
      const wire = mutableWire(encoded); mutate(wire); const supplied = canonicalBytes(wire);
      expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(supplied));
      expect(supplied.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("rejects hostile native views and does not promise consumption for an oversize wire", () => {
    const encoded = encodeTransactionalPersistenceMediumImage(nonemptyImage());
    const subclass = new (class extends Uint8Array {})(encoded);
    const buffer = Buffer.from(encoded);
    const accessor = new Uint8Array(encoded); Object.defineProperty(accessor, "length", { enumerable: true, get: () => 1 });
    for (const hostile of [buffer, subclass, new Proxy(new Uint8Array(encoded), {}), accessor]) expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(hostile));
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(encoded.byteLength)); shared.set(encoded);
      expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(shared));
    }
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1).fill(7);
    expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(oversized));
    expect(oversized[0]).toBe(7);
    // A sizeable valid view reaches decoding and is consumed without an
    // own-key enumeration proportional to its byte length.
    const sizeable = new Uint8Array(1_048_576).fill(0x20);
    expectFailure(() => decodeOwnedTransactionalPersistenceMediumImage(sizeable));
    expect(sizeable.every((byte) => byte === 0)).toBe(true);
  });

  it("wipes a codec-owned allocation even when it is larger than the caller wire cap", () => {
    const owned = new Uint8Array(32 * 1024 * 1024 + 1).fill(9);
    disposeOwnedTransactionalPersistenceImageCodecBytesForTestOnly(owned);
    expect(owned.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects hostile or corrupt encoder images with one fixed error and preserves caller ciphertext", () => {
    const image = nonemptyImage(); const sourceBytes = image.state.snapshot.ciphertextBlobs[0]!.bytes;
    const extra = { ...image, extra: true };
    const accessor = { ...image }; Object.defineProperty(accessor, "state", { enumerable: true, get: () => image.state });
    const proxy = new Proxy(image, { getPrototypeOf() { throw new Error("hostile"); } });
    const corrupt = imageWith(image, { ...image.state.snapshot, schemaVersion: 2 });
    for (const candidate of [extra, accessor, proxy, corrupt]) expectEncodeFailurePreserves(candidate, sourceBytes);
  });

  it("enforces existing full-image blob, item-count, and aggregate bounds without mutating encoder input", () => {
    const image = nonemptyImage(); const snapshot = image.state.snapshot; const sourceBytes = snapshot.ciphertextBlobs[0]!.bytes;
    const tooMany = { ...snapshot, ciphertextBlobs: Array.from({ length: 4_097 }, () => snapshot.ciphertextBlobs[0]!) };
    expectEncodeFailurePreserves(imageWith(image, tooMany), sourceBytes);
    const oversizedBytes = new Uint8Array(8 * 1024 * 1024 + 1).fill(7);
    const oversizedBlob = { ...snapshot.ciphertextBlobs[0]!, bytes: oversizedBytes, ciphertextSha256: hash(oversizedBytes) };
    expectEncodeFailurePreserves(imageWith(image, { ...snapshot, ciphertextBlobs: [oversizedBlob] }), oversizedBytes);
    const aggregateBytes = [0, 1, 2].map((index) => new Uint8Array(6 * 1024 * 1024).fill(index + 1));
    const aggregateBlobs = aggregateBytes.map((bytes, index) => ({ ciphertextRef: id(700 + index), ciphertextSha256: hash(bytes), bytes }));
    try { expectEncodeFailurePreserves(imageWith(image, { ...snapshot, ciphertextBlobs: aggregateBlobs }), aggregateBytes[0]!); }
    finally { aggregateBytes.forEach((bytes) => bytes.fill(0)); oversizedBytes.fill(0); }
  });

  it("stays private and inert: absent from the runtime barrel and both durable gates remain literal false", () => {
    const source = readFileSync(new URL("./transactional-persistence-image-codec.ts", import.meta.url), "utf8");
    const helper = readFileSync(new URL("./transactional-persistence.ts", import.meta.url), "utf8");
    const barrel = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const desktopGate = readFileSync(new URL("../../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8");
    const packageGate = readFileSync(new URL("../../../../apps/desktop/scripts/inspect-storage-capability-package.mjs", import.meta.url), "utf8");
    for (const forbidden of ["node:fs", "node:path", "ipc", "keychain", "sidecar", "activate", "execute", "register", "electron"]) expect(source.toLowerCase()).not.toContain(forbidden);
    expect(barrel).not.toMatch(/transactional-persistence-image-codec|validateTransactionalPersistenceMediumImageForTestOnly|disposeOwnedTransactionalPersistenceImageCodecBytesForTestOnly/);
    expect(`${source}\n${helper}`).not.toMatch(/node:(?:fs|path|http|https|child_process)|electron|\bipc\b|process\.env|\bfetch\b/i);
    expect(desktopGate).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
    expect(packageGate).toMatch(/durableSpacesEnabled:\s*false/);
  });
});
