import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { disposeTransactionalPersistenceMediumImageForTestOnly, encodeTransactionalPersistenceMediumImage } from "./transactional-persistence-image-codec.js";
import { InMemoryWorkStore } from "./in-memory-work-store.js";
import { InMemoryTransactionalPersistenceMedium, disposeOpaqueJournalSnapshotForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, type TransactionalPersistenceMediumImage } from "./transactional-persistence.js";
import { createWholeMediumAeadFilesystemWireCodecForTestOnly, TransactionalPersistenceWholeMediumAeadCodecError } from "./transactional-persistence-whole-medium-aead-codec.js";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const rootBinding = "a".repeat(64);
const reference = Object.freeze({ spaceId: id(1), keyId: id(2) });
const provider: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { const key = new Uint8Array(32).fill(7); try { await callback(key); } finally { key.fill(0); } } };

function genesisBytes(): Uint8Array { const medium = new InMemoryTransactionalPersistenceMedium(); try { return encodeTransactionalPersistenceMediumImage(medium.exportImageForTestOnly()); } finally { medium.disposeForTestOnly(); } }
function imagePair(): readonly [TransactionalPersistenceMediumImage, TransactionalPersistenceMediumImage] { const medium = new InMemoryTransactionalPersistenceMedium(); const zero = medium.exportImageForTestOnly(); const state = medium.openPortForTestOnly().recover(); const store = new InMemoryWorkStore(); let snapshot: ReturnType<typeof snapshotFromInMemoryWorkStoreForTestOnly> | undefined; try { const ciphertext = new Uint8Array([7]); const digest = createHash("sha256").update(ciphertext).digest("hex"); store.putRecord({ ciphertext, record: { schemaVersion: 1, id: id(4), spaceId: reference.spaceId, recordRevision: 1, idempotency: { kind: "task", idempotencyKeySha256: digest }, envelope: { envelopeVersion: 1, spaceId: reference.spaceId, keyId: reference.keyId, entityId: id(4), entityKind: "task", schemaVersion: 1, contentRevision: 1, kind: "payload", contentSha256: digest, nonce: "AAAAAAAAAAAAAAAA", ciphertextRef: id(5), ciphertextSha256: digest, tag: "AAAAAAAAAAAAAAAAAAAAAA" } } } as never); ciphertext.fill(0); snapshot = snapshotFromInMemoryWorkStoreForTestOnly(store); medium.openPortForTestOnly().commit({ commitId: id(99), expectedGeneration: state.generation, expectedSnapshotSha256: state.snapshotSha256, operationBindingSha256: "a".repeat(64), snapshot }); snapshot = undefined; return [zero, medium.exportImageForTestOnly()]; } finally { disposeOpaqueJournalSnapshotForTestOnly(state.snapshot); if (snapshot !== undefined) disposeOpaqueJournalSnapshotForTestOnly(snapshot); store.disposeForTestOnly(); medium.disposeForTestOnly(); } }
function expectFailure(action: () => Promise<unknown>): Promise<void> { return expect(action()).rejects.toBeInstanceOf(TransactionalPersistenceWholeMediumAeadCodecError); }

describe("private whole-medium filesystem AEAD codec", () => {
  it("uses random authenticated envelopes while preserving one canonical logical image", async () => {
    let providerCalls = 0; const countingProvider: WorkspaceKeyProvider = { async withUnlockedKey(keyReference, callback) { providerCalls += 1; await provider.withUnlockedKey(keyReference, callback); } };
    const codec = createWholeMediumAeadFilesystemWireCodecForTestOnly(countingProvider, reference); const inner = genesisBytes();
    try {
      const [first, second] = await Promise.all([codec.seal(rootBinding, 0, undefined, inner), codec.seal(rootBinding, 0, undefined, inner)]);
      try {
        expect(first.bytes).not.toEqual(second.bytes); expect(Buffer.from(first.bytes).toString("utf8")).not.toContain("snapshotSha256");
        const outer = JSON.parse(Buffer.from(first.bytes).toString("utf8")) as Record<string, unknown>;
        expect(Object.keys(outer)).toEqual([...Object.keys(outer)].sort()); expect(outer).toMatchObject({ schemaVersion: 1, algorithm: "aes-256-gcm", plaintextByteLength: inner.byteLength, rootBindingSha256: rootBinding });
        const opened = await codec.open(rootBinding, 0, undefined, first.bytes);
        try { expect(opened.image.state.generation).toBe(0); expect(opened.innerBytes).toEqual(inner); expect(opened.envelopeWireSha256).toBe(first.envelopeWireSha256); }
        finally { opened.innerBytes.fill(0); disposeTransactionalPersistenceMediumImageForTestOnly(opened.image); }
        const wrongKey: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(32).fill(8)); } };
        await expectFailure(() => createWholeMediumAeadFilesystemWireCodecForTestOnly(wrongKey, reference).open(rootBinding, 0, undefined, first.bytes));
        const tamperedOuter = JSON.parse(Buffer.from(first.bytes).toString("utf8")) as { ciphertext: string };
        tamperedOuter.ciphertext = `${tamperedOuter.ciphertext[0] === "A" ? "B" : "A"}${tamperedOuter.ciphertext.slice(1)}`;
        const tampered = new TextEncoder().encode(JSON.stringify(tamperedOuter)); providerCalls = 0; await expectFailure(() => codec.open(rootBinding, 0, undefined, tampered)); expect(providerCalls).toBe(1); tampered.fill(0);
        const truncated = new Uint8Array(first.bytes.subarray(0, first.bytes.byteLength - 1)); await expectFailure(() => codec.open(rootBinding, 0, undefined, truncated)); truncated.fill(0);
        await expectFailure(() => codec.open("b".repeat(64), 0, undefined, first.bytes));
      } finally { first.bytes.fill(0); second.bytes.fill(0); }
    } finally { inner.fill(0); }
  });

  it("rejects malformed wire before provider use and contains invalid provider behaviour", async () => {
    let calls = 0; const counting: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { calls += 1; await callback(new Uint8Array(32).fill(4)); } };
    const codec = createWholeMediumAeadFilesystemWireCodecForTestOnly(counting, reference); const plain = genesisBytes();
    try {
      await expectFailure(() => codec.open(rootBinding, 0, undefined, plain)); expect(calls).toBe(0);
      const providers: WorkspaceKeyProvider[] = [
        { async withUnlockedKey() { return undefined; } },
        { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(31)); } },
        { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(new SharedArrayBuffer(32))); } },
        { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(32)); await callback(new Uint8Array(32)); } },
        { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(32)); try { await callback(new Uint8Array(32)); } catch { /* hostile swallow */ } } },
        { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(32)); return "not-void" as never; } },
        { withUnlockedKey() { return undefined as never; } },
        { async withUnlockedKey() { throw new Error("provider rejection"); } },
      ];
      for (const hostile of providers) await expectFailure(() => createWholeMediumAeadFilesystemWireCodecForTestOnly(hostile, reference).seal(rootBinding, 0, undefined, plain));
      let late: ((key: Uint8Array) => void | Promise<void>) | undefined;
      const lateProvider: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { late = callback; } };
      await expectFailure(() => createWholeMediumAeadFilesystemWireCodecForTestOnly(lateProvider, reference).seal(rootBinding, 0, undefined, plain));
      await expect(Promise.resolve().then(() => late!(new Uint8Array(32)))).rejects.toBeInstanceOf(TransactionalPersistenceWholeMediumAeadCodecError);
    } finally { plain.fill(0); }
  });

  it("rejects every changed outer binding and noncanonical outer shape", async () => {
    const codec = createWholeMediumAeadFilesystemWireCodecForTestOnly(provider, reference); const inner = genesisBytes(); const sealed = await codec.seal(rootBinding, 0, undefined, inner);
    try {
      const source = JSON.parse(Buffer.from(sealed.bytes).toString("utf8")) as Record<string, unknown>;
      const replacements: Array<(wire: Record<string, unknown>) => void> = [
        (wire) => { wire.schemaVersion = 2; },
        (wire) => { wire.protection = { kind: "plaintext-test-only" }; },
        (wire) => { wire.algorithm = "aes-128-gcm"; },
        (wire) => { wire.keyReferenceSha256 = "b".repeat(64); },
        (wire) => { wire.rootBindingSha256 = "b".repeat(64); },
        (wire) => { wire.generation = 1; },
        (wire) => { wire.predecessorEnvelopeSha256 = "b".repeat(64); },
        (wire) => { wire.plaintextByteLength = (wire.plaintextByteLength as number) + 1; },
        (wire) => { const value = wire.nonce as string; wire.nonce = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`; },
        (wire) => { const value = wire.tag as string; wire.tag = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`; },
        (wire) => { const value = wire.ciphertext as string; wire.ciphertext = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`; },
        (wire) => { wire.unexpected = true; },
      ];
      for (const replace of replacements) {
        const candidate = JSON.parse(JSON.stringify(source)) as Record<string, unknown>; replace(candidate);
        const wire = new TextEncoder().encode(JSON.stringify(candidate)); await expectFailure(() => codec.open(rootBinding, 0, undefined, wire)); wire.fill(0);
      }
      const reordered = new TextEncoder().encode(JSON.stringify({ ciphertext: source.ciphertext, tag: source.tag, nonce: source.nonce, plaintextByteLength: source.plaintextByteLength, predecessorEnvelopeSha256: source.predecessorEnvelopeSha256, generation: source.generation, rootBindingSha256: source.rootBindingSha256, keyReferenceSha256: source.keyReferenceSha256, algorithm: source.algorithm, protection: source.protection, schemaVersion: source.schemaVersion }));
      await expectFailure(() => codec.open(rootBinding, 0, undefined, reordered)); reordered.fill(0);
    } finally { sealed.bytes.fill(0); inner.fill(0); }
  });

  it("uses the pre-await owned wire snapshot and rejects swallowed same-codec reentry", async () => {
    let release: (() => void) | undefined; let entered: (() => void) | undefined; let calls = 0; const gate = new Promise<void>((resolve) => { release = resolve; }); const began = new Promise<void>((resolve) => { entered = resolve; });
    const gated: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { calls += 1; if (calls === 2) { entered?.(); await gate; } await callback(new Uint8Array(32).fill(7)); } };
    const codec = createWholeMediumAeadFilesystemWireCodecForTestOnly(gated, reference); const [zero, one] = imagePair(); const zeroInner = encodeTransactionalPersistenceMediumImage(zero); const oneInner = encodeTransactionalPersistenceMediumImage(one);
    try {
      const sealed = await codec.seal(rootBinding, 0, undefined, zeroInner); const originalDigest = createHash("sha256").update(sealed.bytes).digest("hex"); const opening = codec.open(rootBinding, 0, undefined, sealed.bytes); await began; sealed.bytes.fill(0); release?.();
      const opened = await opening;
      try {
        expect([opened.image.state.generation, opened.envelopeWireSha256]).toEqual([0, originalDigest]); const successor = await codec.seal(rootBinding, 1, opened.envelopeWireSha256, oneInner); try { const reopened = await codec.open(rootBinding, 1, opened.envelopeWireSha256, successor.bytes); try { expect(reopened.image.state.generation).toBe(1); } finally { reopened.innerBytes.fill(0); disposeTransactionalPersistenceMediumImageForTestOnly(reopened.image); } } finally { successor.bytes.fill(0); }
      } finally { opened.innerBytes.fill(0); disposeTransactionalPersistenceMediumImageForTestOnly(opened.image); }
    } finally { zeroInner.fill(0); oneInner.fill(0); }
    let reentrant: ReturnType<typeof createWholeMediumAeadFilesystemWireCodecForTestOnly> | undefined;
    const recursiveProvider: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { await callback(new Uint8Array(32).fill(8)); const nested = genesisBytes(); try { await reentrant!.seal(rootBinding, 0, undefined, nested); } catch { /* hostile swallow */ } finally { nested.fill(0); } } };
    reentrant = createWholeMediumAeadFilesystemWireCodecForTestOnly(recursiveProvider, reference); const inner = genesisBytes(); try { await expectFailure(() => reentrant!.seal(rootBinding, 0, undefined, inner)); } finally { inner.fill(0); }
  });

  it("rejects a cross-space inner image before it asks a provider for a key", async () => {
    let calls = 0; const counting: WorkspaceKeyProvider = { async withUnlockedKey(_reference, callback) { calls += 1; await callback(new Uint8Array(32).fill(1)); } }; const wrongReference = Object.freeze({ spaceId: id(800), keyId: reference.keyId }); const codec = createWholeMediumAeadFilesystemWireCodecForTestOnly(counting, wrongReference); const [, image] = imagePair(); const inner = encodeTransactionalPersistenceMediumImage(image);
    try { await expectFailure(() => codec.seal(rootBinding, 1, "a".repeat(64), inner)); expect(calls).toBe(0); }
    finally { inner.fill(0); }
  });
});
