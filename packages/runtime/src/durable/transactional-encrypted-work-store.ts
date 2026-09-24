import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { DurableJournalIdempotencySchema, type DurableJournalIdempotency, type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import { EncryptedWorkStore, type EncryptedWorkStorePutInput, type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryWorkStore } from "./in-memory-work-store.js";
import { enqueueTransactionalPortOperation } from "./transactional-port-queue.js";
import { TransactionalPersistenceError, disposeOpaqueJournalSnapshotForTestOnly, operationBindingSha256ForDurableRecordForTestOnly, restoreInMemoryWorkStoreFromSnapshotForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, validateRecoveredTransactionalStateForTestOnly, type OpaqueJournalSnapshot, type RecoveredTransactionalState, type TransactionReceipt, type TransactionalPersistencePort } from "./transactional-persistence.js";

/** One queue per transactional medium, including independent record IDs. */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const SHARED_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const ENTITY_KINDS = new Set<EncryptedWorkStorePutInput["entityKind"]>(["space", "source", "source-snapshot", "source-span", "agent", "agent-version", "task", "run", "run-step", "artifact", "review", "revision-request", "permission-request", "permission-decision", "citation", "receipt", "capability-grant", "capability-grant-receipt", "capability-grant-index"]);

export interface TransactionalEncryptedWorkStorePutInput extends EncryptedWorkStorePutInput { readonly operationId: string; }

export class TransactionalEncryptedWorkStoreError extends Error {
  readonly code = "TRANSACTIONAL_ENCRYPTED_WORK_STORE_FAILED" as const;
  constructor() { super("Transactional encrypted work store operation failed."); this.name = "TransactionalEncryptedWorkStoreError"; }
}

/** Private coordinator: it stages an off-side keyless journal and publishes it exactly once. */
export class TransactionalEncryptedWorkStore {
  private readonly concurrencyIdentity: object;
  constructor(private readonly port: TransactionalPersistencePort, private readonly keyProvider: WorkspaceKeyProvider, private readonly ciphertextRefGenerator?: () => string) {
    try { const identity = port.concurrencyIdentity; if (identity === null || typeof identity !== "object") throw failure(); this.concurrencyIdentity = identity; }
    catch (_error) { throw failure(); }
  }

  async put(input: TransactionalEncryptedWorkStorePutInput): Promise<DurableJournalRecord> {
    let prepared: OwnedPut | undefined;
    try { prepared = ownPut(input); } catch (_error) { throw failure(); }
    try { return await enqueueTransactionalPortOperation(this.concurrencyIdentity, () => this.putOwned(prepared!)); }
    catch (_error) { throw failure(); }
    finally { prepared?.plaintext.fill(0); }
  }

  async read(input: { readonly spaceId: string; readonly keyId: string; readonly id: string; readonly recordRevision: number }): Promise<Uint8Array> {
    let recovered: RecoveredTransactionalState | undefined; let candidate: InMemoryWorkStore | undefined; let output: Uint8Array | undefined;
    try {
      recovered = recoverValidated(this.port); candidate = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered.snapshot);
      output = await new EncryptedWorkStore(candidate, this.keyProvider, this.ciphertextRefGenerator).read(input);
      return output;
    } catch (_error) { output?.fill(0); throw failure(); }
    finally { candidate?.disposeForTestOnly(); disposeOpaqueJournalSnapshotForTestOnly(recovered?.snapshot); }
  }

  private async putOwned(prepared: OwnedPut): Promise<DurableJournalRecord> {
    let recovered: RecoveredTransactionalState | undefined; let candidate: InMemoryWorkStore | undefined; let staged: OpaqueJournalSnapshot | undefined; let verification: RecoveredTransactionalState | undefined; let verifier: InMemoryWorkStore | undefined;
    try {
      recovered = recoverValidated(this.port); candidate = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered.snapshot);
      const hadRecord = recovered.snapshot.journal.records.some((record) => record.id === prepared.id && record.recordRevision === prepared.recordRevision);
      const facade = new EncryptedWorkStore(candidate, this.keyProvider, this.ciphertextRefGenerator);
      const record = await facade.put(workInput(prepared));
      const operationBindingSha256 = operationBindingSha256ForDurableRecordForTestOnly(record);
      if (hadRecord) { requireBinding(this.port, prepared.operationId, operationBindingSha256); return record; }
      staged = snapshotFromInMemoryWorkStoreForTestOnly(candidate);
      const request = Object.freeze({ commitId: prepared.operationId, expectedGeneration: recovered.generation, expectedSnapshotSha256: recovered.snapshotSha256, operationBindingSha256, snapshot: staged });
      let receipt: TransactionReceipt;
      try { receipt = this.port.commit(request); }
      catch (error) {
        if (!(error instanceof TransactionalPersistenceError) || error.code !== "INTERRUPTED") throw error;
        receipt = this.port.commit(request);
      }
      if (!isReceipt(receipt, recovered.generation + 1) || receipt.commitId !== prepared.operationId) throw failure();
      verification = recoverValidated(this.port);
      if (verification.generation !== receipt.generation || verification.snapshotSha256 !== receipt.snapshotSha256) throw failure();
      requireBinding(this.port, prepared.operationId, operationBindingSha256);
      const persisted = verification.snapshot.journal.records.find((item) => item.id === record.id && item.recordRevision === record.recordRevision);
      if (persisted === undefined || JSON.stringify(persisted) !== JSON.stringify(record)) throw failure();
      verifier = restoreInMemoryWorkStoreFromSnapshotForTestOnly(verification.snapshot);
      const adopted = await new EncryptedWorkStore(verifier, this.keyProvider, this.ciphertextRefGenerator).put(workInput(prepared));
      if (JSON.stringify(adopted) !== JSON.stringify(record)) throw failure();
      return record;
    } catch (_error) { throw failure(); }
    finally {
      candidate?.disposeForTestOnly(); verifier?.disposeForTestOnly(); disposeOpaqueJournalSnapshotForTestOnly(recovered?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(staged); disposeOpaqueJournalSnapshotForTestOnly(verification?.snapshot);
    }
  }

}

interface OwnedPut extends EncryptedWorkStorePutInput { readonly operationId: string; readonly idempotency: DurableJournalIdempotency; readonly plaintext: Uint8Array; }
function ownPut(value: unknown): OwnedPut {
  if (!hasExactDataFields(value, ["operationId", "spaceId", "keyId", "id", "entityKind", "recordRevision", "idempotency", "kind", "plaintext"])) throw failure();
  const raw = value as Record<string, unknown>;
  const fields = ["operationId", "spaceId", "keyId", "id", "entityKind", "recordRevision", "idempotency", "kind", "plaintext"];
  if (!fields.every((field) => Object.hasOwn(raw, field)) || !isId(raw.operationId) || !isId(raw.spaceId) || !isId(raw.keyId) || !isId(raw.id) || !ENTITY_KINDS.has(raw.entityKind as EncryptedWorkStorePutInput["entityKind"]) || !isRevision(raw.recordRevision) || (raw.kind !== "payload" && raw.kind !== "blob")) throw failure();
  const idem = DurableJournalIdempotencySchema.safeParse(raw.idempotency); if (!idem.success) throw failure();
  const plaintext = ownedBytes(raw.plaintext);
  return Object.freeze({ operationId: raw.operationId as string, spaceId: raw.spaceId as string, keyId: raw.keyId as string, id: raw.id as string, entityKind: raw.entityKind as EncryptedWorkStorePutInput["entityKind"], recordRevision: raw.recordRevision as number, idempotency: idem.data, kind: raw.kind as "payload" | "blob", plaintext });
}
function isReceipt(value: unknown, expectedGeneration: number): value is TransactionReceipt {
  if (!hasExactDataFields(value, ["commitId", "generation", "snapshotSha256"])) return false;
  const raw = value as Record<string, unknown>;
  return isId(raw.commitId) && raw.generation === expectedGeneration && typeof raw.snapshotSha256 === "string" && /^[a-f0-9]{64}$/.test(raw.snapshotSha256);
}
function workInput(value: OwnedPut): EncryptedWorkStorePutInput {
  return Object.freeze({ spaceId: value.spaceId, keyId: value.keyId, id: value.id, entityKind: value.entityKind, recordRevision: value.recordRevision, idempotency: value.idempotency, kind: value.kind, plaintext: value.plaintext });
}
function recoverValidated(port: TransactionalPersistencePort): RecoveredTransactionalState {
  let raw: RecoveredTransactionalState | undefined;
  try { raw = port.recover(); return validateRecoveredTransactionalStateForTestOnly(raw); }
  catch (_error) { throw failure(); }
  finally { disposeOpaqueJournalSnapshotForTestOnly(raw?.snapshot); }
}
function requireBinding(port: TransactionalPersistencePort, commitId: string, expected: string): void {
  try {
    const value = port.recoverOperationBinding(commitId);
    if (!hasExactDataFields(value, ["commitId", "operationBindingSha256"])) throw failure();
    const raw = value as Record<string, unknown>;
    if (raw.commitId !== commitId || typeof raw.operationBindingSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.operationBindingSha256) || raw.operationBindingSha256 !== expected || !/^[a-f0-9]{64}$/.test(expected)) throw failure();
  } catch (_error) { throw failure(); }
}
function failure(): TransactionalEncryptedWorkStoreError { return new TransactionalEncryptedWorkStoreError(); }
function isId(value: unknown): value is string { return CanonicalDurableIdSchema.safeParse(value).success; }
function isRevision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function ownedBytes(value: unknown): Uint8Array {
  let copy: Uint8Array | undefined;
  try {
    if (!(value instanceof Uint8Array) || BYTE_LENGTH_GETTER === undefined || BUFFER_GETTER === undefined || Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "length")) throw failure();
    const length = BYTE_LENGTH_GETTER.call(value); const buffer = BUFFER_GETTER.call(value);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CONTENT_BYTES || isShared(buffer)) throw failure();
    copy = new Uint8Array(value); if (BYTE_LENGTH_GETTER.call(copy) !== length) throw failure(); return copy;
  } catch (_error) { copy?.fill(0); throw failure(); }
}
function isShared(value: unknown): boolean { try { return SHARED_LENGTH_GETTER !== undefined && typeof SHARED_LENGTH_GETTER.call(value) === "number"; } catch (_error) { return false; } }
function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value); if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) return false;
    return fields.every((field) => { const descriptor = Object.getOwnPropertyDescriptor(value, field); return descriptor !== undefined && Object.hasOwn(descriptor, "value"); });
  } catch (_error) { return false; }
}
