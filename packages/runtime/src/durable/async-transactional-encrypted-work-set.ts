import { types } from "node:util";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { DurableJournalIdempotencySchema, type DurableJournalIdempotency, type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import { EncryptedWorkStore, type EncryptedWorkStorePutInput, type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryWorkStore } from "./in-memory-work-store.js";
import { enqueueTransactionalPortOperation } from "./transactional-port-queue.js";
import { TransactionalPersistenceError, disposeOpaqueJournalSnapshotForTestOnly, operationBindingSha256ForDurableRecordSetForTestOnly, restoreInMemoryWorkStoreFromSnapshotForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, validateRecoveredTransactionalStateForTestOnly, type OpaqueJournalSnapshot, type RecoveredTransactionalState, type TransactionReceipt } from "./transactional-persistence.js";
import { type AsyncTransactionalPersistencePortForTestOnly } from "./async-transactional-persistence-filesystem-port.js";

const MAX = 8 * 1024 * 1024;
const KINDS = new Set<EncryptedWorkStorePutInput["entityKind"]>(["space", "source", "source-snapshot", "source-span", "agent", "agent-version", "task", "run", "run-step", "artifact", "review", "revision-request", "permission-request", "permission-decision", "citation", "receipt", "capability-grant", "capability-grant-receipt", "capability-grant-index"]);
const TYPED = Object.getPrototypeOf(Uint8Array.prototype);
const LENGTH = Object.getOwnPropertyDescriptor(TYPED, "byteLength")?.get;
const BUFFER = Object.getOwnPropertyDescriptor(TYPED, "buffer")?.get;
const OFFSET = Object.getOwnPropertyDescriptor(TYPED, "byteOffset")?.get;
const ARRAY_BUFFER_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const SHARED = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

export interface AsyncTransactionalEncryptedWorkSetInput {
  readonly operationId: string;
  readonly spaceId: string;
  readonly keyId: string;
  readonly writes: readonly { readonly id: string; readonly entityKind: EncryptedWorkStorePutInput["entityKind"]; readonly recordRevision: number; readonly idempotency: DurableJournalIdempotency; readonly kind: "payload" | "blob"; readonly plaintext: Uint8Array; }[];
}
export interface AsyncTransactionalEncryptedWorkSetAfterPrerequisiteInput extends AsyncTransactionalEncryptedWorkSetInput {
  readonly prerequisiteOperationId: string;
  readonly prerequisites: readonly { readonly id: string; readonly entityKind: EncryptedWorkStorePutInput["entityKind"]; readonly recordRevision: number; readonly idempotency: DurableJournalIdempotency; readonly kind: "payload" | "blob"; readonly plaintext: Uint8Array; }[];
}
export class AsyncTransactionalEncryptedWorkSetError extends Error {
  readonly code = "ASYNC_TRANSACTIONAL_ENCRYPTED_WORK_SET_FAILED" as const;
  constructor() { super("Async transactional encrypted work set operation failed."); this.name = "AsyncTransactionalEncryptedWorkSetError"; }
}

/** Private awaited coordinator: it borrows and never closes its A3 port. */
export class AsyncTransactionalEncryptedWorkSet {
  private readonly identity: object;
  constructor(private readonly port: AsyncTransactionalPersistencePortForTestOnly, private readonly provider: WorkspaceKeyProvider, private readonly refs?: () => string) {
    try { const identity = port.concurrencyIdentity; if (identity === null || typeof identity !== "object" || types.isProxy(identity)) throw fail(); this.identity = identity; }
    catch (_error) { throw fail(); }
  }

  async putAtomic(input: AsyncTransactionalEncryptedWorkSetInput): Promise<readonly DurableJournalRecord[]> {
    let owned: Owned | undefined;
    try { owned = parse(input); }
    catch (_error) { throw fail(); }
    try { return await enqueueTransactionalPortOperation(this.identity, () => this.run(owned!)); }
    catch (_error) { throw fail(); }
    finally { wipe(owned?.writes); }
  }

  async putAtomicAfterExactPrerequisite(input: AsyncTransactionalEncryptedWorkSetAfterPrerequisiteInput): Promise<readonly DurableJournalRecord[]> {
    let owned: OwnedAfter | undefined;
    try { owned = parseAfter(input); }
    catch (_error) { throw fail(); }
    try { return await enqueueTransactionalPortOperation(this.identity, () => this.runAfter(owned!)); }
    catch (_error) { throw fail(); }
    finally { wipe(owned?.writes); wipe(owned?.prerequisites); }
  }

  private async run(owned: Owned): Promise<readonly DurableJournalRecord[]> {
    let recovered: RecoveredTransactionalState | undefined; let candidate: InMemoryWorkStore | undefined; let staged: OpaqueJournalSnapshot | undefined; let verified: RecoveredTransactionalState | undefined; let verifier: InMemoryWorkStore | undefined;
    try {
      recovered = await recover(this.port); candidate = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered.snapshot);
      const present = owned.writes.map((item) => recovered!.snapshot.journal.records.some((record) => record.id === item.id && record.recordRevision === item.recordRevision));
      if (present.some(Boolean) && !present.every(Boolean)) throw fail();
      if (present.every((value) => !value) && await this.port.recoverOperationBinding(owned.operationId) !== undefined) throw fail();
      if (present.every(Boolean)) await requireBinding(this.port, owned.operationId, operationBindingSha256ForDurableRecordSetForTestOnly(exactPresent(recovered, owned.writes)));
      const facade = new EncryptedWorkStore(candidate, this.provider, this.refs); const records: DurableJournalRecord[] = [];
      for (const item of owned.writes) records.push(await facade.put(toPut(owned, item)));
      const binding = operationBindingSha256ForDurableRecordSetForTestOnly(records);
      if (present.every(Boolean)) { await requireBinding(this.port, owned.operationId, binding); return freezeRecords(records); }
      staged = snapshotFromInMemoryWorkStoreForTestOnly(candidate);
      const request = Object.freeze({ commitId: owned.operationId, expectedGeneration: recovered.generation, expectedSnapshotSha256: recovered.snapshotSha256, operationBindingSha256: binding, snapshot: staged });
      const receipt = await commitOnceWithInterruptedRetry(this.port, request, owned.operationId, recovered.generation + 1);
      verified = await recover(this.port); if (verified.generation !== receipt.generation || verified.snapshotSha256 !== receipt.snapshotSha256) throw fail();
      await requireBinding(this.port, owned.operationId, binding);
      verifier = restoreInMemoryWorkStoreFromSnapshotForTestOnly(verified.snapshot); const adopted: DurableJournalRecord[] = []; const adoptedStore = new EncryptedWorkStore(verifier, this.provider, this.refs);
      for (const item of owned.writes) adopted.push(await adoptedStore.put(toPut(owned, item)));
      if (operationBindingSha256ForDurableRecordSetForTestOnly(adopted) !== binding) throw fail();
      return freezeRecords(adopted);
    } catch (_error) { throw fail(); }
    finally { candidate?.disposeForTestOnly(); verifier?.disposeForTestOnly(); disposeOpaqueJournalSnapshotForTestOnly(recovered?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(staged); disposeOpaqueJournalSnapshotForTestOnly(verified?.snapshot); }
  }

  private async runAfter(owned: OwnedAfter): Promise<readonly DurableJournalRecord[]> {
    let recovered: RecoveredTransactionalState | undefined; let candidate: InMemoryWorkStore | undefined; let staged: OpaqueJournalSnapshot | undefined; let verified: RecoveredTransactionalState | undefined; let verifier: InMemoryWorkStore | undefined;
    try {
      recovered = await recover(this.port); candidate = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered.snapshot);
      const existingPrerequisites = exactPresent(recovered, owned.prerequisites); await requireBinding(this.port, owned.prerequisiteOperationId, operationBindingSha256ForDurableRecordSetForTestOnly(existingPrerequisites));
      const present = owned.writes.map((item) => recovered!.snapshot.journal.records.some((record) => record.id === item.id && record.recordRevision === item.recordRevision));
      if (present.some(Boolean) && !present.every(Boolean)) throw fail();
      if (present.every((value) => !value) && await this.port.recoverOperationBinding(owned.operationId) !== undefined) throw fail();
      if (present.every(Boolean)) await requireBinding(this.port, owned.operationId, operationBindingSha256ForDurableRecordSetForTestOnly(exactPresent(recovered, owned.writes)));
      const facade = new EncryptedWorkStore(candidate, this.provider, this.refs);
      for (const item of owned.prerequisites) await facade.put(toPut(owned, item));
      const records: DurableJournalRecord[] = []; for (const item of owned.writes) records.push(await facade.put(toPut(owned, item)));
      const binding = operationBindingSha256ForDurableRecordSetForTestOnly(records);
      if (present.every(Boolean)) { await requireBinding(this.port, owned.operationId, binding); return freezeRecords(records); }
      staged = snapshotFromInMemoryWorkStoreForTestOnly(candidate);
      const request = Object.freeze({ commitId: owned.operationId, expectedGeneration: recovered.generation, expectedSnapshotSha256: recovered.snapshotSha256, operationBindingSha256: binding, snapshot: staged });
      const receipt = await commitOnceWithInterruptedRetry(this.port, request, owned.operationId, recovered.generation + 1);
      verified = await recover(this.port); if (verified.generation !== receipt.generation || verified.snapshotSha256 !== receipt.snapshotSha256) throw fail();
      await requireBinding(this.port, owned.operationId, binding);
      const verifiedPrerequisites = exactPresent(verified, owned.prerequisites); await requireBinding(this.port, owned.prerequisiteOperationId, operationBindingSha256ForDurableRecordSetForTestOnly(verifiedPrerequisites));
      verifier = restoreInMemoryWorkStoreFromSnapshotForTestOnly(verified.snapshot); const adopted: DurableJournalRecord[] = []; const adoptedStore = new EncryptedWorkStore(verifier, this.provider, this.refs);
      for (const item of owned.prerequisites) await adoptedStore.put(toPut(owned, item));
      for (const item of owned.writes) adopted.push(await adoptedStore.put(toPut(owned, item)));
      if (operationBindingSha256ForDurableRecordSetForTestOnly(adopted) !== binding) throw fail();
      return freezeRecords(adopted);
    } catch (_error) { throw fail(); }
    finally { candidate?.disposeForTestOnly(); verifier?.disposeForTestOnly(); disposeOpaqueJournalSnapshotForTestOnly(recovered?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(staged); disposeOpaqueJournalSnapshotForTestOnly(verified?.snapshot); }
  }
}

interface Owned { readonly operationId: string; readonly spaceId: string; readonly keyId: string; readonly writes: readonly OwnedWrite[]; }
interface OwnedAfter extends Owned { readonly prerequisiteOperationId: string; readonly prerequisites: readonly OwnedWrite[]; }
interface OwnedWrite { readonly id: string; readonly entityKind: EncryptedWorkStorePutInput["entityKind"]; readonly recordRevision: number; readonly idempotency: DurableJournalIdempotency; readonly kind: "payload" | "blob"; readonly plaintext: Uint8Array; }

function parse(value: unknown): Owned {
  const raw = ownValues(value, ["operationId", "spaceId", "keyId", "writes"]); if (raw === undefined) throw fail(); const source = raw.writes;
  if (!id(raw.operationId) || !id(raw.spaceId) || !id(raw.keyId) || types.isProxy(source) || !Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype) throw fail();
  const length = Object.getOwnPropertyDescriptor(source, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 16 || !exactArrayIndexes(source, length)) throw fail();
  const decoded: { readonly item: Record<string, unknown>; readonly idempotency: DurableJournalIdempotency; readonly length: number }[] = []; const pairs = new Set<string>(); const revisions = new Map<string, number>(); let total = 0; const writes: OwnedWrite[] = []; let current: Uint8Array | undefined;
  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index)); const item = descriptor === undefined || !("value" in descriptor) ? undefined : ownValues(descriptor.value, ["id", "entityKind", "recordRevision", "idempotency", "kind", "plaintext"]);
      if (item === undefined) throw fail(); const parsedIdempotency = DurableJournalIdempotencySchema.safeParse(copyOwnDataObject(item.idempotency)); const byteLength = byteLengthOf(item.plaintext);
      if (!id(item.id) || !KINDS.has(item.entityKind as EncryptedWorkStorePutInput["entityKind"]) || !Number.isSafeInteger(item.recordRevision) || (item.recordRevision as number) < 1 || !parsedIdempotency.success || (item.kind !== "payload" && item.kind !== "blob")) throw fail();
      const pair = `${item.id}:${item.recordRevision}`; if (pairs.has(pair) || (revisions.get(item.id as string) ?? 0) >= (item.recordRevision as number)) throw fail(); pairs.add(pair); revisions.set(item.id as string, item.recordRevision as number); total += byteLength; if (total > MAX) throw fail();
      decoded.push({ item, idempotency: parsedIdempotency.data, length: byteLength });
    }
    for (const entry of decoded) { current = copyBytes(entry.item.plaintext, entry.length); writes.push(Object.freeze({ id: entry.item.id as string, entityKind: entry.item.entityKind as EncryptedWorkStorePutInput["entityKind"], recordRevision: entry.item.recordRevision as number, idempotency: entry.idempotency, kind: entry.item.kind as "payload" | "blob", plaintext: current })); current = undefined; }
    return Object.freeze({ operationId: raw.operationId as string, spaceId: raw.spaceId as string, keyId: raw.keyId as string, writes: Object.freeze(writes) });
  } catch (_error) { current?.fill(0); wipe(writes); throw fail(); }
}

function parseAfter(value: unknown): OwnedAfter {
  const raw = ownValues(value, ["operationId", "spaceId", "keyId", "prerequisiteOperationId", "prerequisites", "writes"]);
  if (raw === undefined || !id(raw.prerequisiteOperationId) || raw.prerequisiteOperationId === raw.operationId) throw fail();
  let prerequisites: readonly OwnedWrite[] = []; let target: Owned | undefined;
  try {
    prerequisites = parse({ operationId: raw.prerequisiteOperationId, spaceId: raw.spaceId, keyId: raw.keyId, writes: raw.prerequisites }).writes;
    target = parse({ operationId: raw.operationId, spaceId: raw.spaceId, keyId: raw.keyId, writes: raw.writes });
    const total = prerequisites.reduce((sum, item) => sum + item.plaintext.byteLength, 0) + target.writes.reduce((sum, item) => sum + item.plaintext.byteLength, 0); if (total > MAX) throw fail();
    for (const prior of prerequisites) for (const write of target.writes) if (prior.id === write.id && prior.recordRevision >= write.recordRevision) throw fail();
    return Object.freeze({ ...target, prerequisiteOperationId: raw.prerequisiteOperationId as string, prerequisites: Object.freeze(prerequisites) });
  } catch (_error) { wipe(prerequisites); wipe(target?.writes); throw fail(); }
}

function exactPresent(recovered: RecoveredTransactionalState, writes: readonly OwnedWrite[]): DurableJournalRecord[] { const records = writes.map((item) => recovered.snapshot.journal.records.find((record) => record.id === item.id && record.recordRevision === item.recordRevision)); if (records.some((record) => record === undefined)) throw fail(); return records as DurableJournalRecord[]; }
function toPut(owned: Owned, item: OwnedWrite): EncryptedWorkStorePutInput { return { spaceId: owned.spaceId, keyId: owned.keyId, id: item.id, entityKind: item.entityKind, recordRevision: item.recordRevision, idempotency: item.idempotency, kind: item.kind, plaintext: item.plaintext }; }
function byteLengthOf(value: unknown): number {
  if (types.isProxy(value) || !(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype || LENGTH === undefined || BUFFER === undefined || OFFSET === undefined || ARRAY_BUFFER_LENGTH === undefined || Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "byteOffset") || Object.hasOwn(value, "length")) throw fail();
  const length = LENGTH.call(value); const buffer = BUFFER.call(value); const offset = OFFSET.call(value);
  if (types.isProxy(buffer)) throw fail();
  const shared = SHARED !== undefined && (() => { try { return typeof SHARED.call(buffer) === "number"; } catch (_error) { return false; } })();
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX || !Number.isSafeInteger(offset) || offset !== 0 || shared || ARRAY_BUFFER_LENGTH.call(buffer) !== length) throw fail(); return length;
}
function copyBytes(value: unknown, length: number): Uint8Array { const copy = new Uint8Array(value as Uint8Array); if (LENGTH?.call(copy) !== length) { copy.fill(0); throw fail(); } return copy; }
async function recover(port: AsyncTransactionalPersistencePortForTestOnly): Promise<RecoveredTransactionalState> { let raw: RecoveredTransactionalState | undefined; try { raw = await port.recover(); return validateRecoveredTransactionalStateForTestOnly(raw); } catch (_error) { throw fail(); } finally { disposeOpaqueJournalSnapshotForTestOnly(raw?.snapshot); } }
async function requireBinding(port: AsyncTransactionalPersistencePortForTestOnly, commitId: string, binding: string): Promise<void> { try { const raw = ownValues(await port.recoverOperationBinding(commitId), ["commitId", "operationBindingSha256"]); if (raw === undefined || raw.commitId !== commitId || typeof raw.operationBindingSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.operationBindingSha256) || raw.operationBindingSha256 !== binding) throw fail(); } catch (_error) { throw fail(); } }
async function commitOnceWithInterruptedRetry(port: AsyncTransactionalPersistencePortForTestOnly, request: unknown, commitId: string, generation: number): Promise<TransactionReceipt> { try { return parseReceipt(await port.commit(request), commitId, generation); } catch (error) { if (!(error instanceof TransactionalPersistenceError) || error.code !== "INTERRUPTED") throw error; return parseReceipt(await port.commit(request), commitId, generation); } }
function parseReceipt(value: unknown, commitId: string, generation: number): TransactionReceipt { const raw = ownValues(value, ["commitId", "generation", "snapshotSha256"]); if (raw === undefined || raw.commitId !== commitId || raw.generation !== generation || typeof raw.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.snapshotSha256)) throw fail(); return Object.freeze({ commitId, generation, snapshotSha256: raw.snapshotSha256 }); }
function exactArrayIndexes(value: unknown[], length: number): boolean { try { let seen = 0; for (const key in value) { if (!Object.hasOwn(value, key) || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length || ++seen > length) return false; } return seen === length; } catch (_error) { return false; } }
function ownValues(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined { try { if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined; let count = 0; for (const key in value) { if (!Object.hasOwn(value, key) || !fields.includes(key) || ++count > fields.length) return undefined; } if (count !== fields.length) return undefined; const output: Record<string, unknown> = {}; for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined; output[field] = descriptor.value; } return output; } catch (_error) { return undefined; } }
function copyOwnDataObject(value: unknown): Record<string, unknown> | undefined { try { if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined; const output: Record<string, unknown> = {}; let count = 0; for (const key in value) { if (!Object.hasOwn(value, key) || ++count > 3) return undefined; const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined; Object.defineProperty(output, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true }); } const kind = Object.getOwnPropertyDescriptor(output, "kind")?.value; const expected = kind === "entity" ? ["kind"] : kind === "task" ? ["kind", "idempotencyKeySha256"] : kind === "run" ? ["kind", "taskId", "attempt"] : kind === "revision" ? ["kind", "reviewId", "requestSha256"] : kind === "receipt" ? ["kind", "runId"] : undefined; if (expected === undefined || count !== expected.length) return undefined; for (const key of expected) if (!Object.hasOwn(output, key)) return undefined; return output; } catch (_error) { return undefined; } }
function id(value: unknown): value is string { return CanonicalDurableIdSchema.safeParse(value).success; }
function wipe(writes: readonly OwnedWrite[] | undefined): void { writes?.forEach((item) => item.plaintext.fill(0)); }
function freezeRecords(records: readonly DurableJournalRecord[]): readonly DurableJournalRecord[] { return Object.freeze(records.map((record) => deepFreeze(JSON.parse(JSON.stringify(record)) as DurableJournalRecord))); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(): AsyncTransactionalEncryptedWorkSetError { return new AsyncTransactionalEncryptedWorkSetError(); }
