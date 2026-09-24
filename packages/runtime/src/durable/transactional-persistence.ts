import { createHash } from "node:crypto";
import { types } from "node:util";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { DurableJournalRecordSchema, type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import {
  InMemoryWorkStore,
  type InMemoryJournalImage,
  type InMemoryWorkStoreImage,
  type IssuedClaimImage
} from "./in-memory-work-store.js";

const MAX_ITEMS = 4_096;
const MAX_RECEIPTS = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_CLAIMS = 4_096;
const HASH = /^[a-f0-9]{64}$/;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const SHARED_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

export type TransactionalPersistenceErrorCode = "INVALID" | "CONFLICT" | "NOT_FOUND" | "INTERRUPTED";
/** Fixed, detail-free failure for this private test simulator boundary. */
export class TransactionalPersistenceError extends Error {
  readonly code: TransactionalPersistenceErrorCode;
  constructor(code: TransactionalPersistenceErrorCode) { super("Transactional persistence operation failed."); this.name = "TransactionalPersistenceError"; this.code = code; }
}

/** Ciphertext is separately addressed by immutable opaque metadata ref, never by a path. */
export interface OpaqueCiphertextBlob {
  readonly ciphertextRef: string;
  readonly ciphertextSha256: string;
  readonly bytes: Uint8Array;
}
export interface OpaqueCiphertextRefIndex {
  readonly ciphertextRef: string;
  readonly id: string;
  readonly recordRevision: number;
  readonly ciphertextSha256: string;
}
/**
 * Full private state needed to reconstruct the T2.2A journal. It deliberately
 * separates opaque ciphertext bytes from journal metadata. No plaintext/key/path
 * field exists here. Arrays are canonical, dense, bounded, and owned.
 */
export interface OpaqueJournalSnapshot {
  readonly schemaVersion: 1;
  readonly journal: InMemoryJournalImage;
  readonly ciphertextBlobs: readonly OpaqueCiphertextBlob[];
  readonly refIndex: readonly OpaqueCiphertextRefIndex[];
  readonly issuedClaims: readonly IssuedClaimImage[];
}
export interface TransactionCommitInput {
  readonly commitId: string;
  readonly expectedGeneration: number;
  readonly expectedSnapshotSha256: string;
  readonly operationBindingSha256: string;
  readonly snapshot: OpaqueJournalSnapshot;
}
export interface RecoveredOperationBinding { readonly commitId: string; readonly operationBindingSha256: string; }
export interface TransactionReceipt {
  readonly commitId: string;
  readonly generation: number;
  readonly snapshotSha256: string;
}
export interface RecoveredTransactionalState {
  readonly generation: number;
  readonly snapshotSha256: string;
  readonly snapshot: OpaqueJournalSnapshot;
}
export interface TransactionalPersistencePort {
  readonly concurrencyIdentity: object;
  commit(input: TransactionCommitInput): TransactionReceipt;
  recover(): RecoveredTransactionalState;
  recoverOperationBinding(commitId: string): RecoveredOperationBinding | undefined;
}
export type TransactionalFaultPoint = "before-publish" | "after-staging-bytes" | "after-staging-metadata" | "after-publish-before-ack";

export interface StoredReceipt extends TransactionReceipt {
  readonly expectedGeneration: number;
  readonly expectedSnapshotSha256: string;
  readonly requestedSnapshotSha256: string;
  readonly requestSha256: string;
  readonly operationBindingSha256: string;
}
interface MediumState { readonly generation: number; readonly snapshotSha256: string; readonly snapshot: OpaqueJournalSnapshot; readonly receipts: readonly StoredReceipt[]; }
export interface TransactionalPersistenceMediumImage { readonly schemaVersion: 1; readonly state: RecoveredTransactionalState; readonly receipts: readonly StoredReceipt[]; }

/**
 * Deterministic test medium. The sole publication assignment is the simulator's
 * atomicity model; it is neither a disk adapter nor evidence of crash durability.
 * Its unkeyed receipt chain rejects internally inconsistent images but cannot
 * authenticate a whole older image across restarts. Recovered effects stay inert;
 * this port never retries, executes, completes, or reclaims one.
 */
export class InMemoryTransactionalPersistenceMedium {
  private state: MediumState;
  private readonly portConcurrencyIdentity = Object.freeze({});
  private fault: TransactionalFaultPoint | undefined;
  private busy = false;
  private disposed = false;

  constructor(image?: TransactionalPersistenceMediumImage) {
    try { this.state = image === undefined ? initialState() : parseMediumImage(image); }
    catch (error) { throw fixedFailure(error); }
  }

  setFaultForTestOnly(point: TransactionalFaultPoint | undefined): void {
    this.assertLive();
    if (point !== undefined && point !== "before-publish" && point !== "after-staging-bytes" && point !== "after-staging-metadata" && point !== "after-publish-before-ack") throw fail("INVALID");
    this.fault = point;
  }

  exportImageForTestOnly(): TransactionalPersistenceMediumImage {
    this.assertLive();
    return { schemaVersion: 1, state: cloneRecovered(this.state), receipts: this.state.receipts.map(cloneStoredReceipt) };
  }

  static fromImageForTestOnly(image: TransactionalPersistenceMediumImage): InMemoryTransactionalPersistenceMedium { return new InMemoryTransactionalPersistenceMedium(image); }

  openPortForTestOnly(): TransactionalPersistencePort { this.assertLive(); return new InMemoryTransactionalPersistencePort(this, this.portConcurrencyIdentity); }

  /** Releases this medium's owned ciphertext clones; it cannot be reused. */
  disposeForTestOnly(): void { if (!this.disposed) { this.disposed = true; clearSnapshot(this.state.snapshot); } }

  transact(input: TransactionCommitInput): TransactionReceipt {
    this.assertLive();
    if (this.busy) throw fail("CONFLICT");
    this.busy = true;
    let request: TransactionCommitInput | undefined;
    let stagedSnapshot: OpaqueJournalSnapshot | undefined;
    let published = false;
    try {
      const parsed = parseCommitInput(input); request = parsed;
      const requestSha256 = hashRequest(parsed);
      const prior = this.state.receipts.find((receipt) => receipt.commitId === parsed.commitId);
      if (prior !== undefined) {
        if (prior.requestSha256 !== requestSha256) throw fail("CONFLICT");
        return receiptForReturn(prior);
      }
      if (parsed.expectedGeneration !== this.state.generation || parsed.expectedSnapshotSha256 !== this.state.snapshotSha256) throw fail("CONFLICT");
      if (this.state.receipts.length >= MAX_RECEIPTS) throw fail("CONFLICT");
      this.interrupt("before-publish");
      // Staging is deep-cloned and validated before it can become observable.
      stagedSnapshot = cloneSnapshot(parsed.snapshot);
      this.interrupt("after-staging-bytes");
      assertMonotonicExtension(this.state.snapshot, stagedSnapshot);
      const stagedDigest = snapshotSha256(stagedSnapshot);
      if (stagedDigest === this.state.snapshotSha256) throw fail("CONFLICT");
      this.interrupt("after-staging-metadata");
      const receipt: StoredReceipt = Object.freeze({ commitId: parsed.commitId, generation: this.state.generation + 1, snapshotSha256: stagedDigest, operationBindingSha256: parsed.operationBindingSha256,
        expectedGeneration: parsed.expectedGeneration, expectedSnapshotSha256: parsed.expectedSnapshotSha256, requestedSnapshotSha256: stagedDigest, requestSha256 });
      const next: MediumState = Object.freeze({ generation: receipt.generation, snapshotSha256: stagedDigest, snapshot: stagedSnapshot, receipts: Object.freeze([...this.state.receipts.map(cloneStoredReceipt), receipt]) });
      // The only visibility point. Pre-publication failures leave exact pre-state.
      const priorSnapshot = this.state.snapshot; this.state = next; clearSnapshot(priorSnapshot);
      published = true;
      this.interrupt("after-publish-before-ack");
      return receiptForReturn(receipt);
    } catch (error) { throw fixedFailure(error); }
    finally { if (!published) { clearSnapshot(request?.snapshot); clearSnapshot(stagedSnapshot); } else clearSnapshot(request?.snapshot); this.busy = false; }
  }

  recover(): RecoveredTransactionalState { this.assertLive(); return cloneRecovered(this.state); }
  recoverOperationBinding(commitId: string): RecoveredOperationBinding | undefined {
    try { this.assertLive(); if (!isId(commitId)) throw fail("INVALID"); const receipt = this.state.receipts.find((item) => item.commitId === commitId); return receipt === undefined ? undefined : Object.freeze({ commitId: receipt.commitId, operationBindingSha256: receipt.operationBindingSha256 }); }
    catch (error) { throw fixedFailure(error); }
  }
  private interrupt(point: TransactionalFaultPoint): void { if (this.fault === point) { this.fault = undefined; throw fail("INTERRUPTED"); } }
  private assertLive(): void { if (this.disposed) throw fail("INVALID"); }
}

class InMemoryTransactionalPersistencePort implements TransactionalPersistencePort {
  constructor(private readonly medium: InMemoryTransactionalPersistenceMedium, readonly concurrencyIdentity: object) {}
  commit(input: TransactionCommitInput): TransactionReceipt { return this.medium.transact(input); }
  recover(): RecoveredTransactionalState { return this.medium.recover(); }
  recoverOperationBinding(commitId: string): RecoveredOperationBinding | undefined { return this.medium.recoverOperationBinding(commitId); }
}

/** Converts the accepted T2.2A test image to separately-addressed opaque bytes. */
export function snapshotFromInMemoryWorkStoreForTestOnly(store: InMemoryWorkStore): OpaqueJournalSnapshot {
  try { return snapshotFromImage(store.exportImageForTestOnly()); } catch (error) { throw fixedFailure(error); }
}

/** Reconstructs the existing keyless journal only after full snapshot validation. */
export function restoreInMemoryWorkStoreFromSnapshotForTestOnly(snapshot: OpaqueJournalSnapshot): InMemoryWorkStore {
  let parsed: OpaqueJournalSnapshot | undefined; let image: InMemoryWorkStoreImage | undefined;
  try {
    parsed = parseSnapshot(snapshot);
    image = imageFromSnapshot(parsed);
    return InMemoryWorkStore.fromImageForTestOnly(image);
  } catch (error) { throw fixedFailure(error); }
  finally { clearSnapshot(parsed); clearEnvelopeCopies(image?.envelopes); }
}

/** Best-effort cleanup for owned snapshots returned by this private test port. */
export function disposeOpaqueJournalSnapshotForTestOnly(value: unknown): void {
  try {
    const blobs = decodeDataArray(ownDataField(value, "ciphertextBlobs"), MAX_ITEMS);
    for (const blob of blobs) {
      const bytes = ownDataField(blob, "bytes");
      if (!(bytes instanceof Uint8Array) || BYTE_LENGTH_GETTER === undefined || BUFFER_GETTER === undefined) continue;
      const length = BYTE_LENGTH_GETTER.call(bytes); const buffer = BUFFER_GETTER.call(bytes);
      if (Number.isSafeInteger(length) && length >= 0 && length <= MAX_BYTES && !isShared(buffer)) Uint8Array.prototype.fill.call(bytes, 0);
    }
  } catch (_error) { /* cleanup is deliberately best effort */ }
}

export function validateRecoveredTransactionalStateForTestOnly(value: unknown): RecoveredTransactionalState {
  let snapshot: OpaqueJournalSnapshot | undefined; let returned = false;
  try {
    if (!hasExactFields(value, ["generation", "snapshotSha256", "snapshot"])) throw fail("INVALID");
    const raw = value as Record<string, unknown>; if (!isGeneration(raw.generation) || !isHash(raw.snapshotSha256)) throw fail("INVALID");
    snapshot = parseSnapshot(raw.snapshot); if (snapshotSha256(snapshot) !== raw.snapshotSha256) throw fail("INVALID");
    const result = Object.freeze({ generation: raw.generation, snapshotSha256: raw.snapshotSha256, snapshot }); returned = true; return result;
  } catch (error) { throw fixedFailure(error); }
  finally { if (!returned) clearSnapshot(snapshot); }
}

/**
 * Validates a complete private medium image through the same strict recovery
 * parser used by the deterministic test medium, then returns a fresh owned
 * image. This is intentionally test-only until a real persistence adapter
 * exists; it neither opens a file nor publishes recovered work.
 */
export function validateTransactionalPersistenceMediumImageForTestOnly(value: unknown): TransactionalPersistenceMediumImage {
  let state: MediumState | undefined;
  try {
    state = parseMediumImage(value);
    const result = Object.freeze({ schemaVersion: 1 as const, state: cloneRecovered(state), receipts: Object.freeze(state.receipts.map(cloneStoredReceipt)) });
    return result;
  } catch (error) { throw fixedFailure(error); }
  finally { if (state !== undefined) clearSnapshot(state.snapshot); }
}

/** Validates the exact next immutable medium image without publishing work. */
export function validateTransactionalPersistenceSuccessorForTestOnly(previousValue: unknown, nextValue: unknown): void {
  let previous: MediumState | undefined; let next: MediumState | undefined;
  try {
    previous = parseMediumImage(previousValue); next = parseMediumImage(nextValue);
    if (next.generation !== previous.generation + 1 || next.receipts.length !== previous.receipts.length + 1) throw fail("INVALID");
    for (let index = 0; index < previous.receipts.length; index += 1) if (JSON.stringify(previous.receipts[index]) !== JSON.stringify(next.receipts[index])) throw fail("INVALID");
    const receipt = next.receipts.at(-1);
    if (receipt === undefined || receipt.expectedGeneration !== previous.generation || receipt.expectedSnapshotSha256 !== previous.snapshotSha256) throw fail("INVALID");
    assertMonotonicExtension(previous.snapshot, next.snapshot);
  } catch (error) { throw fixedFailure(error); }
  finally { clearSnapshot(previous?.snapshot); clearSnapshot(next?.snapshot); }
}

/** Captures a complete commit request before an async persistence boundary. */
export function ownTransactionCommitInputForTestOnly(value: unknown): TransactionCommitInput {
  try { return parseCommitInput(value); } catch (error) { throw fixedFailure(error); }
}

/**
 * Async-boundary capture: snapshots every untrusted descriptor exactly once,
 * rejects proxies/accessors/views/cycles, and never reads hostile properties.
 */
export function captureTransactionCommitInputForAsyncFilesystemPortForTestOnly(value: unknown): TransactionCommitInput {
  const context = newCaptureContext();
  try { return parseCommitInput(captureUntrustedValue(value, context, 0)); }
  catch (error) { throw fixedFailure(error); }
  finally { wipeCaptureContext(context); }
}
/** Non-exfiltrating test seam for the private capture cleanup invariant. */
export function inspectAsyncFilesystemCaptureCleanupForTestOnly(value: unknown): Readonly<{ accepted: boolean; capturedCopies: number; allCapturedCopiesZeroed: boolean; descriptorReads: number }> {
  const context = newCaptureContext(); let accepted = false;
  try { const input = parseCommitInput(captureUntrustedValue(value, context, 0)); accepted = true; clearSnapshot(input.snapshot); }
  catch { /* inspection deliberately reports only cleanup facts */ }
  finally { wipeCaptureContext(context); }
  return Object.freeze({ accepted, capturedCopies: context.copies.length, allCapturedCopiesZeroed: context.copies.every((bytes) => bytes.every((byte) => byte === 0)), descriptorReads: context.descriptorReads });
}

/** Computes the immutable request identity from an already-owned commit input. */
export function transactionCommitRequestSha256ForTestOnly(value: unknown): string {
  let input: TransactionCommitInput | undefined;
  try { input = parseCommitInput(value); return hashRequest(input); }
  catch (error) { throw fixedFailure(error); }
  finally { clearSnapshot(input?.snapshot); }
}

export function operationBindingSha256ForDurableRecordForTestOnly(value: unknown): string {
  try {
    if (!hasExactFields(value, ["schemaVersion", "id", "spaceId", "recordRevision", "idempotency", "envelope"])) throw fail("INVALID");
    const raw = value as Record<string, unknown>; const idempotency = raw.idempotency as Record<string, unknown>;
    if (!hasExactFields(raw.envelope, ["envelopeVersion", "spaceId", "keyId", "entityId", "entityKind", "schemaVersion", "contentRevision", "kind", "contentSha256", "nonce", "ciphertextRef", "ciphertextSha256", "tag"])) throw fail("INVALID");
    const fields = idempotency?.kind === "task" ? ["kind", "idempotencyKeySha256"] : idempotency?.kind === "run" ? ["kind", "taskId", "attempt"] : idempotency?.kind === "revision" ? ["kind", "reviewId", "requestSha256"] : idempotency?.kind === "receipt" ? ["kind", "runId"] : idempotency?.kind === "entity" ? ["kind"] : undefined;
    if (fields === undefined || !hasExactFields(idempotency, fields)) throw fail("INVALID");
    return sha256Text(JSON.stringify(DurableJournalRecordSchema.parse(value)));
  } catch (error) { throw fixedFailure(error); }
}
export function operationBindingSha256ForDurableRecordSetForTestOnly(value: unknown): string {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw fail("INVALID"); const length = Object.getOwnPropertyDescriptor(value, "length")?.value; const keys = Reflect.ownKeys(value);
    if (!Number.isSafeInteger(length) || length < 1 || length > 16 || keys.length !== length + 1) throw fail("INVALID");
    const records: DurableJournalRecord[] = [];
    for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw fail("INVALID"); operationBindingSha256ForDurableRecordForTestOnly(descriptor.value); records.push(DurableJournalRecordSchema.parse(descriptor.value)); }
    return sha256Text("transactional-encrypted-work-set:v1:" + JSON.stringify(records));
  } catch (error) { throw fixedFailure(error); }
}

function initialState(): MediumState {
  const snapshot = snapshotFromImage({ metadata: { schemaVersion: 1, records: [], events: [], effects: [] }, envelopes: [], issuedClaims: [] });
  return Object.freeze({ generation: 0, snapshotSha256: snapshotSha256(snapshot), snapshot, receipts: Object.freeze([]) });
}

function parseCommitInput(value: unknown): TransactionCommitInput {
  if (!hasExactFields(value, ["commitId", "expectedGeneration", "expectedSnapshotSha256", "operationBindingSha256", "snapshot"])) throw fail("INVALID");
  const input = value as Record<string, unknown>;
  if (!isId(input.commitId) || !isGeneration(input.expectedGeneration) || !isHash(input.expectedSnapshotSha256) || !isHash(input.operationBindingSha256)) throw fail("INVALID");
  return Object.freeze({ commitId: input.commitId, expectedGeneration: input.expectedGeneration, expectedSnapshotSha256: input.expectedSnapshotSha256, operationBindingSha256: input.operationBindingSha256, snapshot: parseSnapshot(input.snapshot) });
}

function parseSnapshot(value: unknown): OpaqueJournalSnapshot {
  if (!hasExactFields(value, ["schemaVersion", "journal", "ciphertextBlobs", "refIndex", "issuedClaims"])) throw fail("INVALID");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !hasExactFields(raw.journal, ["schemaVersion", "records", "events", "effects"])) throw fail("INVALID");
  const rawBlobs = decodeDataArray(raw.ciphertextBlobs, MAX_ITEMS); const rawIndex = decodeDataArray(raw.refIndex, MAX_ITEMS); const rawClaims = decodeDataArray(raw.issuedClaims, MAX_ITEMS);
  const rawJournal = raw.journal as Record<string, unknown>; const rawRecords = decodeDataArray(rawJournal.records, MAX_ITEMS);
  const blobs: OpaqueCiphertextBlob[] = []; const envelopes: { record: unknown; ciphertext: Uint8Array }[] = [];
  let validationStore: InMemoryWorkStore | undefined; let validated: InMemoryWorkStoreImage | undefined; let orderedBlobs: OpaqueCiphertextBlob[] = []; let returned = false;
  try {
    let totalBytes = 0;
    for (const rawBlob of rawBlobs) {
      const blob = parseBlob(rawBlob); totalBytes += blob.bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) { blob.bytes.fill(0); throw fail("INVALID"); }
      blobs.push(blob);
    }
    const blobByRef = new Map<string, OpaqueCiphertextBlob>();
    for (const blob of blobs) { if (blobByRef.has(blob.ciphertextRef)) throw fail("INVALID"); blobByRef.set(blob.ciphertextRef, blob); }
    preflightClaims(rawClaims);
    for (const record of rawRecords) {
      const envelope = ownDataField(record, "envelope"); const ref = ownDataField(envelope, "ciphertextRef"); const blob = typeof ref === "string" ? blobByRef.get(ref) : undefined;
      if (blob === undefined) throw fail("INVALID"); envelopes.push({ record, ciphertext: new Uint8Array(blob.bytes) });
    }
    validationStore = InMemoryWorkStore.fromImageForTestOnly({ metadata: rawJournal as unknown as InMemoryJournalImage, envelopes: envelopes as InMemoryWorkStoreImage["envelopes"], issuedClaims: rawClaims as IssuedClaimImage[] });
    validated = validationStore.exportImageForTestOnly(); const records = validated.metadata.records;
    if (blobs.length !== records.length) throw fail("INVALID");
    const expectedIndex = records.map((record) => ({ ciphertextRef: record.envelope.ciphertextRef, id: record.id, recordRevision: record.recordRevision, ciphertextSha256: record.envelope.ciphertextSha256 }));
    const providedIndex = rawIndex.map(parseRefIndex);
    if (!sameIndex(canonicalIndex(providedIndex), canonicalIndex(expectedIndex))) throw fail("INVALID");
    for (const record of records) { const blob = blobByRef.get(record.envelope.ciphertextRef); if (blob === undefined || blob.ciphertextSha256 !== record.envelope.ciphertextSha256) throw fail("INVALID"); }
    const canonical = canonicalImage(validated);
    orderedBlobs = canonical.journal.records.map((record) => { const blob = blobByRef.get(record.envelope.ciphertextRef); if (blob === undefined) throw fail("INVALID"); return cloneBlob(blob); });
    const result = Object.freeze({ schemaVersion: 1 as const, journal: canonical.journal, ciphertextBlobs: Object.freeze(orderedBlobs), refIndex: Object.freeze(canonicalIndex(expectedIndex).map(cloneRefIndex)), issuedClaims: canonical.issuedClaims });
    returned = true; return result;
  } catch (error) { throw fixedFailure(error); }
  finally {
    clearBlobs(blobs); clearEnvelopeCopies(envelopes); clearEnvelopeCopies(validated?.envelopes); validationStore?.disposeForTestOnly();
    if (!returned) clearBlobs(orderedBlobs);
  }
}
function snapshotFromImage(image: InMemoryWorkStoreImage): OpaqueJournalSnapshot {
  let validationStore: InMemoryWorkStore | undefined; let validated: InMemoryWorkStoreImage | undefined; let blobs: OpaqueCiphertextBlob[] = []; let returned = false;
  try {
    validationStore = InMemoryWorkStore.fromImageForTestOnly(image); validated = validationStore.exportImageForTestOnly();
    const canonical = canonicalImage(validated); const byRef = new Map(validated.envelopes.map((entry) => [entry.record.envelope.ciphertextRef, entry.ciphertext] as const));
    blobs = canonical.journal.records.map((record) => { const bytes = byRef.get(record.envelope.ciphertextRef); if (bytes === undefined) throw fail("INVALID"); return Object.freeze({ ciphertextRef: record.envelope.ciphertextRef, ciphertextSha256: record.envelope.ciphertextSha256, bytes: ownedBytes(bytes) }); });
    const refs = canonical.journal.records.map((record) => Object.freeze({ ciphertextRef: record.envelope.ciphertextRef, id: record.id, recordRevision: record.recordRevision, ciphertextSha256: record.envelope.ciphertextSha256 }));
    const result = Object.freeze({ schemaVersion: 1 as const, journal: canonical.journal, ciphertextBlobs: Object.freeze(blobs), refIndex: Object.freeze(canonicalIndex(refs).map(cloneRefIndex)), issuedClaims: canonical.issuedClaims }); returned = true; return result;
  } catch (error) { throw fixedFailure(error); }
  finally { clearEnvelopeCopies(validated?.envelopes); validationStore?.disposeForTestOnly(); if (!returned) clearBlobs(blobs); }
}

function canonicalImage(image: InMemoryWorkStoreImage): { readonly journal: InMemoryJournalImage; readonly issuedClaims: readonly IssuedClaimImage[] } {
  const records = [...image.metadata.records].sort(compareRecords).map(cloneRecord);
  const events = [...image.metadata.events].sort((a, b) => a.runId.localeCompare(b.runId) || a.sequence - b.sequence || a.id.localeCompare(b.id)).map(cloneJson);
  const effects = [...image.metadata.effects].sort((a, b) => a.id.localeCompare(b.id)).map(cloneJson);
  const claimsByEffect = new Map(image.issuedClaims.map((entry) => [entry.effectId, entry.claimIds] as const));
  const issuedClaims = effects.map((effect) => Object.freeze({ effectId: effect.id, claimIds: Object.freeze([...(claimsByEffect.get(effect.id) ?? [])]) }));
  return Object.freeze({ journal: Object.freeze({ schemaVersion: 1, records: Object.freeze(records), events: Object.freeze(events), effects: Object.freeze(effects) }), issuedClaims: Object.freeze(issuedClaims) });
}

function imageFromSnapshot(snapshot: OpaqueJournalSnapshot): InMemoryWorkStoreImage {
  const byRef = new Map(snapshot.ciphertextBlobs.map((blob) => [blob.ciphertextRef, blob.bytes] as const));
  return { metadata: snapshot.journal, envelopes: snapshot.journal.records.map((record) => {
    const bytes = byRef.get(record.envelope.ciphertextRef); if (bytes === undefined) throw fail("INVALID"); return { record, ciphertext: new Uint8Array(bytes) };
  }), issuedClaims: snapshot.issuedClaims };
}

/** This slice is append/advance-only: an accepted ref, byte, record, event, or claim never disappears. */
function assertMonotonicExtension(previous: OpaqueJournalSnapshot, next: OpaqueJournalSnapshot): void {
  const records = new Map(next.journal.records.map((record) => [`${record.id}:${record.recordRevision}`, record] as const));
  const blobs = new Map(next.ciphertextBlobs.map((blob) => [blob.ciphertextRef, blob] as const));
  for (const oldRecord of previous.journal.records) {
    const current = records.get(`${oldRecord.id}:${oldRecord.recordRevision}`);
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(oldRecord)) throw fail("CONFLICT");
    const oldBlob = previous.ciphertextBlobs.find((blob) => blob.ciphertextRef === oldRecord.envelope.ciphertextRef);
    const currentBlob = blobs.get(oldRecord.envelope.ciphertextRef);
    if (oldBlob === undefined || currentBlob === undefined || oldBlob.ciphertextSha256 !== currentBlob.ciphertextSha256 || !sameBytes(oldBlob.bytes, currentBlob.bytes)) throw fail("CONFLICT");
  }
  const nextEvents = groupEvents(next.journal.events);
  for (const [runId, oldEvents] of groupEvents(previous.journal.events)) {
    const current = nextEvents.get(runId);
    if (current === undefined || current.length < oldEvents.length || oldEvents.some((event, index) => JSON.stringify(event) !== JSON.stringify(current[index]))) throw fail("CONFLICT");
  }
  const claims = new Map(next.issuedClaims.map((claim) => [claim.effectId, claim.claimIds] as const));
  for (const oldClaim of previous.issuedClaims) {
    const current = claims.get(oldClaim.effectId);
    if (current === undefined || current.length < oldClaim.claimIds.length || oldClaim.claimIds.some((claim, index) => current[index] !== claim)) throw fail("CONFLICT");
  }
  const effects = new Map(next.journal.effects.map((effect) => [effect.id, effect] as const));
  for (const oldEffect of previous.journal.effects) {
    const current = effects.get(oldEffect.id);
    if (current === undefined || current.effectRevision < oldEffect.effectRevision || current.spaceId !== oldEffect.spaceId || current.runId !== oldEffect.runId || current.runRevision !== oldEffect.runRevision || current.stepKey !== oldEffect.stepKey || current.requestSha256 !== oldEffect.requestSha256 || (current.effectRevision === oldEffect.effectRevision && JSON.stringify(current) !== JSON.stringify(oldEffect))) throw fail("CONFLICT");
  }
}
function groupEvents(events: readonly InMemoryJournalImage["events"][number][]): Map<string, InMemoryJournalImage["events"][number][]> {
  const grouped = new Map<string, InMemoryJournalImage["events"][number][]>();
  for (const event of events) { const current = grouped.get(event.runId) ?? []; current.push(event); grouped.set(event.runId, current); }
  return grouped;
}

function parseBlob(value: unknown): OpaqueCiphertextBlob {
  if (!hasExactFields(value, ["ciphertextRef", "ciphertextSha256", "bytes"])) throw fail("INVALID");
  const blob = value as Record<string, unknown>; const bytes = ownedBytes(blob.bytes);
  try {
    if (!isId(blob.ciphertextRef) || !isHash(blob.ciphertextSha256) || sha256(bytes) !== blob.ciphertextSha256) throw fail("INVALID");
    return Object.freeze({ ciphertextRef: blob.ciphertextRef, ciphertextSha256: blob.ciphertextSha256, bytes });
  } catch (error) { bytes.fill(0); throw fixedFailure(error); }
}
function parseRefIndex(value: unknown): OpaqueCiphertextRefIndex {
  if (!hasExactFields(value, ["ciphertextRef", "id", "recordRevision", "ciphertextSha256"])) throw fail("INVALID");
  const index = value as Record<string, unknown>;
  if (!isId(index.ciphertextRef) || !isId(index.id) || !isGeneration(index.recordRevision) || index.recordRevision === 0 || !isHash(index.ciphertextSha256)) throw fail("INVALID");
  return Object.freeze({ ciphertextRef: index.ciphertextRef, id: index.id, recordRevision: index.recordRevision, ciphertextSha256: index.ciphertextSha256 });
}
function preflightClaims(value: unknown[]): void {
  let count = 0;
  for (const entry of value) {
    if (!hasExactFields(entry, ["effectId", "claimIds"])) throw fail("INVALID");
    const claim = entry as Record<string, unknown>;
    if (!isId(claim.effectId)) throw fail("INVALID");
    const claimIds = decodeDataArray(claim.claimIds, MAX_ITEMS);
    for (const id of claimIds) { if (!isId(id) || ++count > MAX_TOTAL_CLAIMS) throw fail("INVALID"); }
  }
}

function parseMediumImage(value: unknown): MediumState {
  let snapshot: OpaqueJournalSnapshot | undefined; let returned = false;
  try {
    if (!hasExactFields(value, ["schemaVersion", "state", "receipts"])) throw fail("INVALID");
    const raw = value as Record<string, unknown>; if (raw.schemaVersion !== 1 || !hasExactFields(raw.state, ["generation", "snapshotSha256", "snapshot"])) throw fail("INVALID");
    const state = raw.state as Record<string, unknown>; const rawReceipts = decodeDataArray(raw.receipts, MAX_RECEIPTS); snapshot = parseSnapshot(state.snapshot);
    const generation = state.generation; const snapshotSha = state.snapshotSha256;
    if (!isGeneration(generation) || !isHash(snapshotSha) || snapshotSha !== snapshotSha256(snapshot) || generation !== rawReceipts.length) throw fail("INVALID");
    const receipts = rawReceipts.map(parseStoredReceipt); const unique = new Set<string>(); let predecessorSha = emptySnapshotSha256();
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index]; if (receipt === undefined || unique.has(receipt.commitId)) throw fail("INVALID"); unique.add(receipt.commitId);
      if (receipt.generation !== index + 1 || receipt.expectedGeneration !== index || receipt.expectedSnapshotSha256 !== predecessorSha || receipt.snapshotSha256 !== receipt.requestedSnapshotSha256 || receipt.requestSha256 !== hashStoredRequest(receipt)) throw fail("INVALID");
      predecessorSha = receipt.snapshotSha256;
    }
    if (receipts.length === 0 ? snapshotSha !== predecessorSha : predecessorSha !== snapshotSha) throw fail("INVALID");
    const result = Object.freeze({ generation, snapshotSha256: snapshotSha, snapshot, receipts: Object.freeze(receipts.map(cloneStoredReceipt)) }); returned = true; return result;
  } catch (error) { throw fixedFailure(error); }
  finally { if (!returned) clearSnapshot(snapshot); }
}
function parseStoredReceipt(value: unknown): StoredReceipt {
  if (!hasExactFields(value, ["commitId", "generation", "snapshotSha256", "expectedGeneration", "expectedSnapshotSha256", "requestedSnapshotSha256", "requestSha256", "operationBindingSha256"])) throw fail("INVALID");
  const receipt = value as Record<string, unknown>;
  if (!isId(receipt.commitId) || !isGeneration(receipt.generation) || receipt.generation === 0 || !isHash(receipt.snapshotSha256) || !isGeneration(receipt.expectedGeneration) || !isHash(receipt.expectedSnapshotSha256) || !isHash(receipt.requestedSnapshotSha256) || !isHash(receipt.requestSha256) || !isHash(receipt.operationBindingSha256)) throw fail("INVALID");
  return Object.freeze({ commitId: receipt.commitId, generation: receipt.generation, snapshotSha256: receipt.snapshotSha256, expectedGeneration: receipt.expectedGeneration,
    expectedSnapshotSha256: receipt.expectedSnapshotSha256, requestedSnapshotSha256: receipt.requestedSnapshotSha256, requestSha256: receipt.requestSha256, operationBindingSha256: receipt.operationBindingSha256 });
}

function hashRequest(input: TransactionCommitInput): string { return hashRequestFields(input.commitId, input.expectedGeneration, input.expectedSnapshotSha256, input.operationBindingSha256, snapshotSha256(input.snapshot)); }
function hashStoredRequest(receipt: StoredReceipt): string { return hashRequestFields(receipt.commitId, receipt.expectedGeneration, receipt.expectedSnapshotSha256, receipt.operationBindingSha256, receipt.requestedSnapshotSha256); }
function hashRequestFields(commitId: string, expectedGeneration: number, expectedSnapshotSha256: string, operationBindingSha256: string, requestedSnapshotSha256: string): string { return sha256Text(JSON.stringify({ commitId, expectedGeneration, expectedSnapshotSha256, operationBindingSha256, requestedSnapshotSha256 })); }
function emptySnapshotSha256(): string { const snapshot = snapshotFromImage({ metadata: { schemaVersion: 1, records: [], events: [], effects: [] }, envelopes: [], issuedClaims: [] }); try { return snapshotSha256(snapshot); } finally { clearSnapshot(snapshot); } }
function snapshotSha256(snapshot: OpaqueJournalSnapshot): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ schemaVersion: snapshot.schemaVersion, journal: snapshot.journal, refIndex: snapshot.refIndex, issuedClaims: snapshot.issuedClaims }), "utf8");
  for (const blob of snapshot.ciphertextBlobs) { hash.update(blob.ciphertextRef, "utf8"); hash.update(blob.ciphertextSha256, "ascii"); hash.update(String(blob.bytes.byteLength), "ascii"); hash.update(blob.bytes); }
  return hash.digest("hex");
}
function cloneSnapshot(value: OpaqueJournalSnapshot): OpaqueJournalSnapshot { return parseSnapshot(value); }
function cloneRecovered(value: MediumState): RecoveredTransactionalState { return Object.freeze({ generation: value.generation, snapshotSha256: value.snapshotSha256, snapshot: cloneSnapshot(value.snapshot) }); }
function cloneStoredReceipt(value: StoredReceipt): StoredReceipt { return Object.freeze({ commitId: value.commitId, generation: value.generation, snapshotSha256: value.snapshotSha256,
  expectedGeneration: value.expectedGeneration, expectedSnapshotSha256: value.expectedSnapshotSha256, requestedSnapshotSha256: value.requestedSnapshotSha256, requestSha256: value.requestSha256, operationBindingSha256: value.operationBindingSha256 }); }
function receiptForReturn(value: StoredReceipt): TransactionReceipt { return Object.freeze({ commitId: value.commitId, generation: value.generation, snapshotSha256: value.snapshotSha256 }); }
function cloneBlob(value: OpaqueCiphertextBlob): OpaqueCiphertextBlob { return Object.freeze({ ciphertextRef: value.ciphertextRef, ciphertextSha256: value.ciphertextSha256, bytes: ownedBytes(value.bytes) }); }
function cloneRefIndex(value: OpaqueCiphertextRefIndex): OpaqueCiphertextRefIndex { return Object.freeze({ ...value }); }
function cloneRecord(value: DurableJournalRecord): DurableJournalRecord { return JSON.parse(JSON.stringify(value)) as DurableJournalRecord; }
function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonicalIndex(value: readonly OpaqueCiphertextRefIndex[]): OpaqueCiphertextRefIndex[] { return [...value].sort((a, b) => a.ciphertextRef.localeCompare(b.ciphertextRef)); }
function sameIndex(left: readonly OpaqueCiphertextRefIndex[], right: readonly OpaqueCiphertextRefIndex[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function compareRecords(left: DurableJournalRecord, right: DurableJournalRecord): number { return recordPriority(left) - recordPriority(right) || left.id.localeCompare(right.id) || left.recordRevision - right.recordRevision; }
function recordPriority(record: DurableJournalRecord): number { return record.idempotency.kind === "task" ? 0 : record.idempotency.kind === "entity" ? 1 : record.idempotency.kind === "run" ? 2 : 3; }
function ownedBytes(value: unknown): Uint8Array {
  let copy: Uint8Array | undefined;
  try {
    if (!(value instanceof Uint8Array) || BYTE_LENGTH_GETTER === undefined || BUFFER_GETTER === undefined || Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "length")) throw fail("INVALID");
    const length = BYTE_LENGTH_GETTER.call(value); const buffer = BUFFER_GETTER.call(value);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES || isShared(buffer)) throw fail("INVALID");
    copy = new Uint8Array(value); if (copy.byteLength !== length) throw fail("INVALID"); return copy;
  } catch (error) { copy?.fill(0); throw fixedFailure(error); }
}
interface CaptureBudget { nodes: number; bytes: number; stringChars: number; }
interface CaptureContext { readonly seen: Set<object>; readonly budget: CaptureBudget; readonly copies: Uint8Array[]; descriptorReads: number; }
const MAX_CAPTURE_NODES = 65_536;
const MAX_CAPTURE_OBJECT_FIELDS = 64;
const MAX_CAPTURE_DEPTH = 64;
const MAX_CAPTURE_STRING_CHARS = 16 * 1024 * 1024;
function newCaptureContext(): CaptureContext { return { seen: new Set<object>(), budget: { nodes: 0, bytes: 0, stringChars: 0 }, copies: [], descriptorReads: 0 }; }
function captureDescriptor(value: object, key: PropertyKey, context: CaptureContext): PropertyDescriptor | undefined { context.descriptorReads += 1; return Object.getOwnPropertyDescriptor(value, key); }
/**
 * This private boundary captures only enumerable own string data fields. Hidden
 * and symbol fields are inert; required hidden fields become absent and fail
 * canonical parsing. Same-isolate inspection cannot preempt hostile CPU work.
 */
function captureUntrustedValue(value: unknown, context: CaptureContext, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") { context.budget.stringChars += value.length; if (context.budget.stringChars > MAX_CAPTURE_STRING_CHARS) throw fail("INVALID"); return value; }
  if (typeof value !== "object" || types.isProxy(value)) throw fail("INVALID");
  if (depth >= MAX_CAPTURE_DEPTH || context.seen.has(value) || ++context.budget.nodes > MAX_CAPTURE_NODES) throw fail("INVALID"); context.seen.add(value);
  try {
    if (value instanceof Uint8Array) return captureExactBytes(value, context);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw fail("INVALID");
      const lengthDescriptor = captureDescriptor(value, "length", context);
      if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_ITEMS) throw fail("INVALID");
      const result: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) { const descriptor = captureDescriptor(value, String(index), context); if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw fail("INVALID"); result.push(captureUntrustedValue(descriptor.value, context, depth + 1)); }
      let enumerable = 0;
      for (const key in value) { if (!Object.hasOwn(value, key) || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= lengthDescriptor.value || ++enumerable > lengthDescriptor.value) throw fail("INVALID"); }
      if (enumerable !== lengthDescriptor.value) throw fail("INVALID");
      return result;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw fail("INVALID");
    const result: Record<string, unknown> = {};
    let fields = 0;
    for (const key in value) { if (!Object.hasOwn(value, key) || ++fields > MAX_CAPTURE_OBJECT_FIELDS) throw fail("INVALID"); const descriptor = captureDescriptor(value, key, context); if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw fail("INVALID"); Object.defineProperty(result, key, { value: captureUntrustedValue(descriptor.value, context, depth + 1), enumerable: true, configurable: true, writable: true }); }
    return result;
  } finally { context.seen.delete(value); }
}
function captureExactBytes(value: Uint8Array, context: CaptureContext): Uint8Array {
  let copy: Uint8Array | undefined;
  try {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype || Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "byteOffset") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "length") || BYTE_LENGTH_GETTER === undefined || BUFFER_GETTER === undefined || BYTE_OFFSET_GETTER === undefined || ARRAY_BUFFER_LENGTH_GETTER === undefined) throw fail("INVALID");
    const length = BYTE_LENGTH_GETTER.call(value); const buffer = BUFFER_GETTER.call(value);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES || (context.budget.bytes += length) > MAX_TOTAL_BYTES || isShared(buffer) || BYTE_OFFSET_GETTER.call(value) !== 0 || ARRAY_BUFFER_LENGTH_GETTER.call(buffer) !== length) throw fail("INVALID");
    copy = new Uint8Array(value); context.copies.push(copy); if (copy.byteLength !== length) throw fail("INVALID"); return copy;
  } catch (error) { throw fixedFailure(error); }
}
function wipeCaptureContext(context: CaptureContext): void { for (const bytes of context.copies) bytes.fill(0); }
function clearSnapshot(snapshot: OpaqueJournalSnapshot | undefined): void { for (const blob of snapshot?.ciphertextBlobs ?? []) blob.bytes.fill(0); }
function clearBlobs(blobs: readonly OpaqueCiphertextBlob[]): void { for (const blob of blobs) blob.bytes.fill(0); }
function clearEnvelopeCopies(envelopes: readonly { readonly ciphertext: Uint8Array }[] | undefined): void { for (const envelope of envelopes ?? []) envelope.ciphertext.fill(0); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
function hasExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> { try { if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false; const keys = Reflect.ownKeys(value); return keys.length === fields.length && fields.every((field) => keys.includes(field) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, field) ?? {}, "value")); } catch (_error) { return false; } }
function ownDataField(value: unknown, field: string): unknown { try { if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw fail("INVALID"); const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw fail("INVALID"); return descriptor.value; } catch (error) { throw fixedFailure(error); } }
/**
 * Copies only a bounded, plain, dense data array. It never invokes an attacker
 * iterator, array method, index accessor, or length getter. A same-isolate Proxy
 * handler can still spend CPU inside reflective traps; JavaScript cannot preempt it.
 */
function decodeDataArray(value: unknown, maxItems: number): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw fail("INVALID");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maxItems) throw fail("INVALID");
    const length = lengthDescriptor.value as number; const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) throw fail("INVALID");
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index); if (!keys.includes(key)) throw fail("INVALID");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw fail("INVALID"); result.push(descriptor.value);
    }
    return result;
  } catch (error) { throw fixedFailure(error); }
}
function isShared(value: unknown): boolean { if (SHARED_LENGTH_GETTER === undefined) return false; try { return typeof SHARED_LENGTH_GETTER.call(value) === "number"; } catch { return false; } }
function isId(value: unknown): value is string { return CanonicalDurableIdSchema.safeParse(value).success; }
function isGeneration(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function fail(code: TransactionalPersistenceErrorCode): TransactionalPersistenceError { return new TransactionalPersistenceError(code); }
function fixedFailure(error: unknown): TransactionalPersistenceError { return error instanceof TransactionalPersistenceError ? fail(error.code) : fail("INVALID"); }
