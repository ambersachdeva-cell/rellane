import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import {
  DurableJournalIdempotencySchema,
  DurableJournalRecordSchema,
  type DurableJournalIdempotency,
  type DurableJournalRecord
} from "@cadrane/contracts/durable-journal";
import {
  decryptEnvelope,
  encryptEnvelope,
  type DurableEntityKind,
  type EncryptedEnvelope,
  type EnvelopeContext
} from "./envelope-crypto.js";
import { InMemoryWorkStore, InMemoryWorkStoreError, type StoredOpaqueRecord } from "./in-memory-work-store.js";

const KEY_BYTES = 32;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const SHARED_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const ENTITY_KINDS = new Set<DurableEntityKind>([
  "space", "source", "source-snapshot", "source-span", "agent", "agent-version", "task", "run", "run-step", "artifact", "review", "revision-request", "permission-request", "permission-decision", "citation", "receipt", "capability-grant", "capability-grant-receipt", "capability-grant-index"
]);
/** Shared only by object identity, so facades over one injected journal serialize exact entity writes. */
const JOURNAL_PUT_QUEUES = new WeakMap<InMemoryWorkStore, Map<string, Promise<void>>>();

export interface WorkspaceKeyReference { readonly spaceId: string; readonly keyId: string; }
/**
 * Compatible with WorkspaceKeyBroker.withUnlockedKey: the authority only exposes
 * an ephemeral key to the awaited callback and resolves to no key/result.
 * The binding is trusted injection; this facade authenticates its declared IDs in
 * AAD but cannot certify the provider's key provenance.
 */
export interface WorkspaceKeyProvider {
  withUnlockedKey(reference: WorkspaceKeyReference, callback: (keyMaterial: Uint8Array) => void | Promise<void>): Promise<void>;
}

export interface EncryptedWorkStorePutInput {
  readonly spaceId: string;
  readonly keyId: string;
  readonly id: string;
  readonly entityKind: DurableEntityKind;
  readonly recordRevision: number;
  readonly idempotency: DurableJournalIdempotency;
  readonly kind: "payload" | "blob";
  readonly plaintext: Uint8Array;
}

export interface EncryptedWorkStoreReadInput {
  readonly spaceId: string;
  readonly keyId: string;
  readonly id: string;
  readonly recordRevision: number;
}

export class EncryptedWorkStoreError extends Error {
  readonly code = "ENCRYPTED_WORK_STORE_FAILED" as const;
  constructor() { super("Encrypted work store operation failed."); this.name = "EncryptedWorkStoreError"; }
}

/**
 * Private process-local facade over the keyless journal. It stores only opaque
 * ciphertext and metadata. It has no persistence/restart/SQLCipher claim and is
 * intentionally not exported from the runtime barrel or wired to any feature.
 * `ciphertextRef` is an opaque globally unique metadata token only: this inline
 * Map seam retains bytes by record revision and never dereferences that token.
 * Future persistence needs a separately accepted transactional ref-to-bytes authority.
 */
export class EncryptedWorkStore {
  constructor(
    private readonly journal: InMemoryWorkStore,
    private readonly keyProvider: WorkspaceKeyProvider,
    private readonly ciphertextRefGenerator: () => string = randomUUID
  ) {}

  async put(input: EncryptedWorkStorePutInput): Promise<DurableJournalRecord> {
    let prepared: PreparedPut | undefined;
    try { prepared = parsePutInput(input); }
    catch (_error) { throw facadeFailure(); }
    try {
      return await this.enqueuePut(prepared.spaceId, prepared.id, () => this.putPrepared(prepared!));
    } catch (_error) { throw facadeFailure(); }
    finally { prepared.plaintext.fill(0); }
  }

  private async putPrepared(prepared: PreparedPut): Promise<DurableJournalRecord> {
    let existing: StoredOpaqueRecord | undefined;
    let stagedRecord: DurableJournalRecord | undefined;
    let stagedCiphertext: Uint8Array | undefined;
    let result: DurableJournalRecord | undefined;
    try {
      existing = this.readExisting(prepared);
      if (existing !== undefined && !sameMetadata(existing.record, prepared)) throw facadeFailure();
      // Generator failures never enter the key boundary. The ref remains merely staged
      // until the provider has closed, so a collision cannot mutate journal state.
      const ciphertextRef = existing === undefined ? nextCiphertextRef(this.ciphertextRefGenerator) : undefined;
      await this.withSpaceKey(prepared.spaceId, prepared.keyId, (key) => {
        if (existing !== undefined) {
          let prior: Uint8Array | undefined;
          try {
            prior = decryptStored(key, existing!);
            if (!sameBytes(prior, prepared!.plaintext)) throw facadeFailure();
            stagedRecord = cloneRecord(existing!.record);
          } finally { prior?.fill(0); }
          return;
        }
        let encrypted: EncryptedEnvelope | undefined;
        try {
          if (ciphertextRef === undefined) throw facadeFailure();
          const context = contextFor(prepared!);
          encrypted = encryptEnvelope(key, prepared!.plaintext, context);
          const record = DurableJournalRecordSchema.parse({
            schemaVersion: 1,
            id: prepared!.id,
            spaceId: prepared!.spaceId,
            recordRevision: prepared!.recordRevision,
            idempotency: prepared!.idempotency,
            envelope: {
              envelopeVersion: 1, spaceId: prepared!.spaceId, keyId: prepared!.keyId,
              entityId: prepared!.id, entityKind: prepared!.entityKind, schemaVersion: 1,
              contentRevision: prepared!.recordRevision, kind: prepared!.kind,
              contentSha256: prepared!.contentSha256, nonce: encrypted.nonce,
              ciphertextRef, ciphertextSha256: encrypted.ciphertextSha256, tag: encrypted.tag
            }
          });
          stagedRecord = record;
          stagedCiphertext = new Uint8Array(encrypted.ciphertext);
        } finally { encrypted?.ciphertext.fill(0); }
      });
      if (stagedRecord === undefined) throw facadeFailure();
      result = existing === undefined
        ? this.journal.putRecord({ record: stagedRecord, ciphertext: stagedCiphertext ?? (() => { throw facadeFailure(); })() }).record
        : stagedRecord;
      return cloneRecord(result);
    } catch (_error) {
      throw facadeFailure();
    } finally {
      stagedCiphertext?.fill(0);
      existing?.ciphertext.fill(0);
    }
  }

  private async enqueuePut(spaceId: string, id: string, operation: () => Promise<DurableJournalRecord>): Promise<DurableJournalRecord> {
    const key = `${spaceId}:${id}`;
    let queues = JOURNAL_PUT_QUEUES.get(this.journal);
    if (queues === undefined) { queues = new Map<string, Promise<void>>(); JOURNAL_PUT_QUEUES.set(this.journal, queues); }
    const prior = queues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    const entry = prior.then(() => completion);
    queues.set(key, entry);
    try {
      await prior;
      return await operation();
    } finally {
      release?.();
      if (queues.get(key) === entry) queues.delete(key);
    }
  }

  async read(input: EncryptedWorkStoreReadInput): Promise<Uint8Array> {
    let request: ReadRequest | undefined;
    let stored: StoredOpaqueRecord | undefined;
    let output: Uint8Array | undefined;
    try {
      request = parseReadInput(input);
      stored = this.journal.readRecordRevision(request.spaceId, request.id, request.recordRevision);
      const record = DurableJournalRecordSchema.parse(stored.record);
      if (record.envelope.keyId !== request.keyId) throw facadeFailure();
      await this.withSpaceKey(request.spaceId, request.keyId, (key) => {
        let plaintext: Uint8Array | undefined;
        try {
          plaintext = decryptStored(key, stored!);
          output = new Uint8Array(plaintext);
        } finally { plaintext?.fill(0); }
      });
      if (output === undefined) throw facadeFailure();
      return output;
    } catch (_error) {
      output?.fill(0);
      throw facadeFailure();
    } finally { stored?.ciphertext.fill(0); }
  }

  private readExisting(input: PreparedPut): StoredOpaqueRecord | undefined {
    try { return this.journal.readRecordRevision(input.spaceId, input.id, input.recordRevision); }
    catch (error) {
      if (error instanceof InMemoryWorkStoreError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }

  private async withSpaceKey(spaceId: string, keyId: string, use: (key: Uint8Array) => void): Promise<void> {
    let calls = 0;
    let closed = false;
    let invalidAttempt = false;
    try {
      const reference = Object.freeze({ spaceId, keyId });
      let completion: Promise<void> | undefined;
      try {
        completion = this.keyProvider.withUnlockedKey(reference, (provided) => {
          calls += 1;
          if (closed || calls !== 1) { invalidAttempt = true; throw facadeFailure(); }
          let key: Uint8Array | undefined;
          try {
            key = ownedBytes(provided, KEY_BYTES);
            use(key);
          } catch (error) { invalidAttempt = true; throw error; }
          finally { key?.fill(0); }
        });
      } catch (_error) { throw facadeFailure(); }
      // The provider contract is asynchronous; a non-promise result is invalid.
      if (completion === undefined || typeof (completion as { then?: unknown }).then !== "function") throw facadeFailure();
      const providerResult = await completion;
      if (providerResult !== undefined || calls !== 1 || invalidAttempt) throw facadeFailure();
      closed = true;
    } finally { closed = true; }
  }
}

interface PreparedPut {
  readonly spaceId: string; readonly keyId: string; readonly id: string; readonly entityKind: DurableEntityKind;
  readonly recordRevision: number; readonly idempotency: DurableJournalIdempotency; readonly kind: "payload" | "blob";
  readonly plaintext: Uint8Array; readonly contentSha256: string;
}
interface ReadRequest { readonly spaceId: string; readonly keyId: string; readonly id: string; readonly recordRevision: number; }

function parsePutInput(value: unknown): PreparedPut {
  if (!hasExactDataFields(value, ["spaceId", "keyId", "id", "entityKind", "recordRevision", "idempotency", "kind", "plaintext"])) throw facadeFailure();
  const input = value as Record<string, unknown>;
  let plaintext: Uint8Array | undefined;
  try {
    if (!isId(input.spaceId) || !isId(input.keyId) || !isId(input.id) || !ENTITY_KINDS.has(input.entityKind as DurableEntityKind) ||
      !isRevision(input.recordRevision) || (input.kind !== "payload" && input.kind !== "blob")) throw facadeFailure();
    const idempotency = DurableJournalIdempotencySchema.safeParse(input.idempotency);
    if (!idempotency.success) throw facadeFailure();
    plaintext = ownedBytes(input.plaintext, MAX_CONTENT_BYTES);
    return { spaceId: input.spaceId, keyId: input.keyId, id: input.id, entityKind: input.entityKind as DurableEntityKind,
      recordRevision: input.recordRevision, idempotency: idempotency.data, kind: input.kind, plaintext,
      contentSha256: sha256(plaintext) };
  } catch (_error) { plaintext?.fill(0); throw facadeFailure(); }
}

function parseReadInput(value: unknown): ReadRequest {
  if (!hasExactDataFields(value, ["spaceId", "keyId", "id", "recordRevision"])) throw facadeFailure();
  const input = value as Record<string, unknown>;
  if (!isId(input.spaceId) || !isId(input.keyId) || !isId(input.id) || !isRevision(input.recordRevision)) throw facadeFailure();
  return { spaceId: input.spaceId, keyId: input.keyId, id: input.id, recordRevision: input.recordRevision };
}

function contextFor(input: PreparedPut): EnvelopeContext {
  return Object.freeze({ envelopeVersion: 1, spaceId: input.spaceId, keyId: input.keyId, entityId: input.id,
    entityKind: input.entityKind, schemaVersion: 1, contentRevision: input.recordRevision, kind: input.kind, contentSha256: input.contentSha256 });
}

function decryptStored(key: Uint8Array, stored: StoredOpaqueRecord): Uint8Array {
  const record = DurableJournalRecordSchema.parse(stored.record);
  const envelope = record.envelope;
  const context: EnvelopeContext = Object.freeze({ envelopeVersion: envelope.envelopeVersion, spaceId: envelope.spaceId, keyId: envelope.keyId,
    entityId: envelope.entityId, entityKind: envelope.entityKind, schemaVersion: envelope.schemaVersion,
    contentRevision: envelope.contentRevision, kind: envelope.kind, contentSha256: envelope.contentSha256 });
  const cryptoEnvelope: EncryptedEnvelope = Object.freeze({ envelopeVersion: envelope.envelopeVersion, nonce: envelope.nonce, tag: envelope.tag,
    ciphertext: stored.ciphertext, ciphertextSha256: envelope.ciphertextSha256 });
  return decryptEnvelope(key, cryptoEnvelope, context);
}

function sameMetadata(record: DurableJournalRecord, input: PreparedPut): boolean {
  const envelope = record.envelope;
  return record.schemaVersion === 1 && record.spaceId === input.spaceId && record.id === input.id && record.recordRevision === input.recordRevision &&
    JSON.stringify(record.idempotency) === JSON.stringify(input.idempotency) && envelope.keyId === input.keyId && envelope.entityKind === input.entityKind &&
    envelope.kind === input.kind && envelope.contentSha256 === input.contentSha256 && envelope.entityId === input.id && envelope.contentRevision === input.recordRevision;
}

function nextCiphertextRef(generator: () => string): string {
  let candidate: unknown;
  try { candidate = generator(); } catch (_error) { throw facadeFailure(); }
  if (!isId(candidate)) throw facadeFailure();
  return candidate;
}
function cloneRecord(record: DurableJournalRecord): DurableJournalRecord { return DurableJournalRecordSchema.parse(record); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && timingSafeEqual(left, right); }
function isId(value: unknown): value is string { return CanonicalDurableIdSchema.safeParse(value).success; }
function isRevision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function facadeFailure(): EncryptedWorkStoreError { return new EncryptedWorkStoreError(); }

function ownedBytes(value: unknown, maxBytes: number): Uint8Array {
  let copy: Uint8Array | undefined;
  try {
    if (!(value instanceof Uint8Array) || BYTE_LENGTH_GETTER === undefined || BUFFER_GETTER === undefined ||
      Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer") || Object.hasOwn(value, "length")) throw facadeFailure();
    const byteLength = BYTE_LENGTH_GETTER.call(value); const buffer = BUFFER_GETTER.call(value);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes || isShared(buffer)) throw facadeFailure();
    copy = new Uint8Array(value);
    const copiedLength = BYTE_LENGTH_GETTER.call(copy);
    if (copiedLength !== byteLength) throw facadeFailure();
    return copy;
  } catch (_error) { copy?.fill(0); throw facadeFailure(); }
}
function isShared(value: unknown): boolean {
  if (SHARED_LENGTH_GETTER === undefined) return false;
  try { return typeof SHARED_LENGTH_GETTER.call(value) === "number"; } catch (_error) { return false; }
}
function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length && fields.every((field) => keys.includes(field) && (() => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })());
  } catch (_error) { return false; }
}
