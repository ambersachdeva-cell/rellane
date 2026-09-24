import { createHash, randomUUID } from "node:crypto";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import {
  DurableEffectSchema,
  DurableJournalEventSchema,
  DurableJournalRecordSchema,
  canTransitionDurableEffect,
  effectBindsDurableRun,
  eventBindsDurableRun,
  type DurableEffect,
  type DurableEffectState,
  type DurableJournalEvent,
  type DurableJournalRecord
} from "@cadrane/contracts/durable-journal";

const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_ITEMS = 4_096;
const MAX_ISSUED_CLAIMS = 4_096;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const SHARED_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

export type InMemoryWorkStoreErrorCode = "INVALID" | "CONFLICT" | "NOT_FOUND" | "CANCELLED";
/** Deliberately generic: no caller input, path, ciphertext, or state detail is exposed. */
export class InMemoryWorkStoreError extends Error {
  readonly code: InMemoryWorkStoreErrorCode;
  constructor(code: InMemoryWorkStoreErrorCode) { super("Durable work store operation failed."); this.name = "InMemoryWorkStoreError"; this.code = code; }
}

export interface StoredOpaqueRecord { readonly record: DurableJournalRecord; readonly ciphertext: Uint8Array; }
/** Runtime-private test image metadata; it deliberately has no public contracts export. */
export interface InMemoryJournalImage { readonly schemaVersion: 1; readonly records: readonly DurableJournalRecord[]; readonly events: readonly DurableJournalEvent[]; readonly effects: readonly DurableEffect[]; }
export interface IssuedClaimImage { readonly effectId: string; readonly claimIds: readonly string[]; }
export interface InMemoryWorkStoreImage {
  readonly metadata: InMemoryJournalImage;
  readonly envelopes: readonly StoredOpaqueRecord[];
  readonly issuedClaims: readonly IssuedClaimImage[];
}

interface StoredRecord { record: DurableJournalRecord; ciphertext: Uint8Array; }
interface EventCommitPlan {
  readonly stored: DurableJournalEvent;
  readonly result: DurableJournalEvent;
  readonly runId: string;
  readonly nextStream: DurableJournalEvent[];
  readonly alreadyStored: boolean;
}

/**
 * Private, Map-only work-store seam. It is keyless and never decrypts or executes effects.
 * `exportImageForTestOnly` / `fromImageForTestOnly` model an in-memory interruption only;
 * they neither persist bytes nor claim restart survival. Clock-based lease expiry is explicitly deferred.
 */
export class InMemoryWorkStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly recordRevisions = new Map<string, Map<number, StoredRecord>>();
  private readonly recordKeys = new Map<string, string>();
  private readonly ciphertextRefs = new Map<string, string>();
  private readonly events = new Map<string, DurableJournalEvent>();
  private readonly eventsByRun = new Map<string, DurableJournalEvent[]>();
  private readonly effects = new Map<string, DurableEffect>();
  private readonly effectKeys = new Map<string, string>();
  private readonly issuedClaims = new Map<string, Set<string>>();
  private readonly claimIdGenerator: () => string;
  private readonly eventIdGenerator: () => string;

  constructor(claimIdGenerator: () => string = randomUUID, eventIdGenerator: () => string = randomUUID) { this.claimIdGenerator = claimIdGenerator; this.eventIdGenerator = eventIdGenerator; }

  putRecord(input: StoredOpaqueRecord): StoredOpaqueRecord {
    try { return this.putRecordUnchecked(input); } catch (error) { throw fixedBoundaryFailure(error); }
  }
  private putRecordUnchecked(input: StoredOpaqueRecord): StoredOpaqueRecord {
    if (!hasExactStoredRecordFields(input)) throw failure("INVALID");
    const record = parseRecord(input.record);
    const ciphertext = ownedBytes(input.ciphertext);
    try {
      if (sha256(ciphertext) !== record.envelope.ciphertextSha256) throw failure("INVALID");
      const historical = this.recordRevisions.get(record.id)?.get(record.recordRevision);
      if (historical !== undefined) {
        if (sameRecord(historical, record, ciphertext)) return cloneStoredRecord(historical);
        throw failure("CONFLICT");
      }
      const sameId = this.records.get(record.id);
      if (sameId !== undefined) {
        if (sameRecord(sameId, record, ciphertext)) return cloneStoredRecord(sameId);
        if (record.recordRevision !== sameId.record.recordRevision + 1 || !sameIdempotency(sameId.record, record) || !sameEnvelopeShape(sameId.record, record)) throw failure("CONFLICT");
        if (this.ciphertextRefs.has(record.envelope.ciphertextRef)) throw failure("CONFLICT");
        if (sameId.record.idempotency.kind === "run" && this.hasNonterminalEffects(record.id, sameId.record.recordRevision)) throw failure("CONFLICT");
        this.assertRecordRelations(record);
        const stored = { record: cloneRecord(record), ciphertext: new Uint8Array(ciphertext) };
        this.records.set(record.id, stored); this.ciphertextRefs.set(record.envelope.ciphertextRef, record.id);
        const revisions = this.recordRevisions.get(record.id); if (revisions === undefined) throw failure("INVALID"); revisions.set(record.recordRevision, stored);
        return cloneStoredRecord(stored);
      }
      if (record.recordRevision !== 1) throw failure("INVALID");
      const key = recordKey(record);
      const existingKeyId = this.recordKeys.get(key);
      if (existingKeyId !== undefined) throw failure("CONFLICT");
      const existingCiphertextRef = this.ciphertextRefs.get(record.envelope.ciphertextRef);
      if (existingCiphertextRef !== undefined) throw failure("CONFLICT");
      this.assertRecordRelations(record);
      const stored = { record: cloneRecord(record), ciphertext: new Uint8Array(ciphertext) };
      this.records.set(record.id, stored); this.recordRevisions.set(record.id, new Map([[record.recordRevision, stored]])); this.recordKeys.set(key, record.id); this.ciphertextRefs.set(record.envelope.ciphertextRef, record.id);
      return cloneStoredRecord(stored);
    } finally { ciphertext.fill(0); }
  }

  readRecord(spaceId: string, id: string): StoredOpaqueRecord {
    return this.atPublicBoundary(() => {
      validId(spaceId); validId(id);
      const record = this.records.get(id);
      if (record === undefined || record.record.spaceId !== spaceId) throw failure("NOT_FOUND");
      return cloneStoredRecord(record);
    });
  }

  /** Private revision lookup for an encrypting facade's exact retry check. */
  readRecordRevision(spaceId: string, id: string, recordRevision: number): StoredOpaqueRecord {
    return this.atPublicBoundary(() => {
      validId(spaceId); validId(id); validRevision(recordRevision);
      const record = this.recordRevisions.get(id)?.get(recordRevision);
      if (record === undefined || record.record.spaceId !== spaceId) throw failure("NOT_FOUND");
      return cloneStoredRecord(record);
    });
  }

  appendEvent(input: DurableJournalEvent): DurableJournalEvent {
    try { if (input === null || typeof input !== "object" || (input as { kind?: unknown }).kind !== "run-recorded") throw failure("INVALID"); return this.appendEventInternal(input, true); } catch (error) { throw fixedBoundaryFailure(error); }
  }

  private appendEventInternal(input: DurableJournalEvent, enforceEffectState: boolean): DurableJournalEvent {
    const plan = this.preflightEvent(input, enforceEffectState);
    if (!plan.alreadyStored) this.commitEvent(plan);
    return plan.result;
  }

  private preflightEvent(input: DurableJournalEvent, enforceEffectState: boolean, effectOverride?: DurableEffect): EventCommitPlan {
    const event = parseEvent(input);
    const byId = this.events.get(event.id);
    if (byId !== undefined) {
      if (!sameJson(byId, event)) throw failure("CONFLICT");
      const stored = cloneEvent(byId);
      return { stored, result: cloneEvent(stored), runId: stored.runId, nextStream: [...(this.eventsByRun.get(stored.runId) ?? [])], alreadyStored: true };
    }
    const run = enforceEffectState ? this.requireRun(event.spaceId, event.runId) : this.requireRunRevision(event.spaceId, event.runId, event.runRevision);
    if (!eventBindsDurableRun(event, run.record)) throw failure("INVALID");
    const stream = this.eventsByRun.get(event.runId) ?? [];
    if (event.sequence !== stream.length + 1) throw failure("CONFLICT");
    if (event.effectId !== null) {
      const effect = effectOverride?.id === event.effectId ? effectOverride : this.effects.get(event.effectId);
      if (effect === undefined || !effectBindsDurableRun(effect, run.record)) throw failure("NOT_FOUND");
      const stateForEvent: Partial<Record<DurableJournalEvent["kind"], DurableEffectState>> = {
        "effect-created": "pending", "effect-claimed": "claimed", "effect-completed": "completed", "effect-failed": "failed", "effect-cancelled": "cancelled"
      };
      if (enforceEffectState && stateForEvent[event.kind] !== effect.state) throw failure("CONFLICT");
    }
    const stored = cloneEvent(event);
    const result = cloneEvent(stored);
    return { stored, result, runId: event.runId, nextStream: [...stream, stored], alreadyStored: false };
  }

  private commitEvent(plan: EventCommitPlan): void {
    this.events.set(plan.stored.id, plan.stored);
    this.eventsByRun.set(plan.runId, plan.nextStream);
  }

  putEffect(input: DurableEffect): DurableEffect {
    return this.atPublicBoundary(() => this.putEffectUnchecked(input));
  }

  private putEffectUnchecked(input: DurableEffect): DurableEffect {
    const effect = parseEffect(input);
    if (effect.state !== "pending" || effect.effectRevision !== 1 || effect.claimId !== null) throw failure("INVALID");
    const key = effectKey(effect);
    const keyedId = this.effectKeys.get(key);
    if (keyedId !== undefined) {
      const existing = this.effects.get(keyedId); if (existing !== undefined && existing.runRevision === effect.runRevision) return cloneEffect(existing);
      throw failure("CONFLICT");
    }
    const byId = this.effects.get(effect.id);
    if (byId !== undefined) { if (sameJson(byId, effect)) return cloneEffect(byId); throw failure("CONFLICT"); }
    const run = this.requireRun(effect.spaceId, effect.runId);
    if (!effectBindsDurableRun(effect, run.record)) throw failure("INVALID");
    const stored = cloneEffect(effect);
    const result = cloneEffect(stored);
    const event = this.effectEvent(stored, "effect-created", null);
    const eventPlan = this.preflightEvent(event, false, stored);
    this.effects.set(effect.id, stored);
    this.effectKeys.set(key, effect.id);
    this.commitEvent(eventPlan);
    return result;
  }

  claimEffect(spaceId: string, effectId: string, expectedRevision: number): DurableEffect {
    return this.atPublicBoundary(() => {
      validId(spaceId); validId(effectId); validRevision(expectedRevision);
      const effect = this.requireEffect(spaceId, effectId);
      this.requireCurrentEffectRun(effect);
      if ((effect.state !== "pending" && effect.state !== "failed") || effect.effectRevision !== expectedRevision) throw failure("CONFLICT");
      const issued = this.issuedClaims.get(effect.id) ?? new Set<string>();
      const freshClaimId = this.nextClaimId(issued);
      const nextIssued = new Set(issued); nextIssued.add(freshClaimId);
      return this.replaceEffectWithEvent({ ...effect, state: "claimed", effectRevision: effect.effectRevision + 1, claimId: freshClaimId }, "effect-claimed", freshClaimId, nextIssued);
    });
  }

  completeEffect(spaceId: string, effectId: string, expectedRevision: number, claimId: string): DurableEffect { return this.atPublicBoundary(() => this.settleEffect(spaceId, effectId, expectedRevision, claimId, "completed")); }
  failEffect(spaceId: string, effectId: string, expectedRevision: number, claimId: string): DurableEffect { return this.atPublicBoundary(() => this.settleEffect(spaceId, effectId, expectedRevision, claimId, "failed")); }

  cancelEffect(spaceId: string, effectId: string, expectedRevision: number, claimId: string | null): DurableEffect {
    return this.atPublicBoundary(() => {
      validId(spaceId); validId(effectId); validRevision(expectedRevision); if (claimId !== null) validId(claimId);
      const effect = this.requireEffect(spaceId, effectId);
      this.requireCurrentEffectRun(effect);
      if (effect.effectRevision !== expectedRevision || !canTransitionDurableEffect(effect.state, "cancelled") || effect.claimId !== claimId) throw failure(effect.state === "cancelled" ? "CANCELLED" : "CONFLICT");
      return this.replaceEffectWithEvent({ ...effect, state: "cancelled", effectRevision: effect.effectRevision + 1, claimId: null }, "effect-cancelled", claimId);
    });
  }

  exportImageForTestOnly(): InMemoryWorkStoreImage {
    const revisions = [...this.recordRevisions.values()].flatMap((records) => [...records.values()]);
    const metadata: InMemoryJournalImage = parseImageMetadata({ schemaVersion: 1, records: revisions.map(({ record }) => cloneRecord(record)), events: [...this.eventsByRun.values()].flat().map(cloneEvent), effects: [...this.effects.values()].map(cloneEffect) });
    return { metadata: cloneImage(metadata), envelopes: revisions.map(cloneStoredRecord), issuedClaims: metadata.effects.map((effect) => ({ effectId: effect.id, claimIds: [...(this.issuedClaims.get(effect.id) ?? new Set<string>())] })) };
  }

  static fromImageForTestOnly(image: InMemoryWorkStoreImage, claimIdGenerator: () => string = randomUUID): InMemoryWorkStore {
    const store = new InMemoryWorkStore(claimIdGenerator);
    try { store.restoreImageForTestOnly(image); return store; }
    catch (error) { store.disposeForTestOnly(); throw fixedBoundaryFailure(error); }
  }

  restoreImageForTestOnly(image: InMemoryWorkStoreImage): void {
    const candidate = new InMemoryWorkStore(this.claimIdGenerator, this.eventIdGenerator); let transferred = false;
    try {
      candidate.restoreUnchecked(this.exportImageForTestOnly());
      candidate.restoreUnchecked(image);
      this.copyStateFrom(candidate); transferred = true;
    } catch (error) { throw fixedBoundaryFailure(error); }
    finally { if (!transferred) candidate.disposeForTestOnly(); }
  }

  /** Test-only ownership cleanup for a rejected temporary image import. */
  disposeForTestOnly(): void {
    this.clearOwnedCiphertext();
    this.records.clear(); this.recordRevisions.clear(); this.recordKeys.clear(); this.ciphertextRefs.clear();
    this.events.clear(); this.eventsByRun.clear(); this.effects.clear(); this.effectKeys.clear(); this.issuedClaims.clear();
  }

  private assertRecordRelations(record: DurableJournalRecord): void {
    if (record.idempotency.kind === "run") this.requireTask(record.spaceId, record.idempotency.taskId);
    if (record.idempotency.kind === "receipt") this.requireRun(record.spaceId, record.idempotency.runId);
    if (record.idempotency.kind === "revision") this.requireGenericReview(record.spaceId, record.idempotency.reviewId);
  }
  private requireTask(spaceId: string, id: string): StoredRecord { const item = this.records.get(id); if (item === undefined || item.record.spaceId !== spaceId || item.record.idempotency.kind !== "task") throw failure("NOT_FOUND"); return item; }
  private requireRun(spaceId: string, id: string): StoredRecord { const item = this.records.get(id); if (item === undefined || item.record.spaceId !== spaceId || item.record.idempotency.kind !== "run") throw failure("NOT_FOUND"); return item; }
  private requireGenericReview(spaceId: string, id: string): StoredRecord { const item = this.records.get(id); if (item === undefined || item.record.spaceId !== spaceId || item.record.idempotency.kind !== "entity" || item.record.envelope.entityKind !== "review") throw failure("NOT_FOUND"); return item; }
  private requireRunRevision(spaceId: string, id: string, revision: number): StoredRecord { const item = this.recordRevisions.get(id)?.get(revision); if (item === undefined || item.record.spaceId !== spaceId || item.record.idempotency.kind !== "run") throw failure("NOT_FOUND"); return item; }
  private requireEffect(spaceId: string, id: string): DurableEffect { const effect = this.effects.get(id); if (effect === undefined || effect.spaceId !== spaceId) throw failure("NOT_FOUND"); return effect; }
  private requireCurrentEffectRun(effect: DurableEffect): StoredRecord {
    const run = this.requireRun(effect.spaceId, effect.runId);
    if (!effectBindsDurableRun(effect, run.record)) throw failure("CONFLICT");
    return run;
  }
  private settleEffect(spaceId: string, effectId: string, expectedRevision: number, claimId: string, state: "completed" | "failed"): DurableEffect {
    validId(spaceId); validId(effectId); validId(claimId); validRevision(expectedRevision);
    const effect = this.requireEffect(spaceId, effectId);
    this.requireCurrentEffectRun(effect);
    if (effect.state !== "claimed" || effect.effectRevision !== expectedRevision || effect.claimId !== claimId || !canTransitionDurableEffect(effect.state, state)) throw failure("CONFLICT");
    return this.replaceEffectWithEvent({ ...effect, state, effectRevision: effect.effectRevision + 1 }, state === "completed" ? "effect-completed" : "effect-failed", claimId);
  }
  private replaceEffectWithEvent(next: DurableEffect, kind: "effect-claimed" | "effect-completed" | "effect-failed" | "effect-cancelled", claimId: string | null, nextIssuedClaims?: ReadonlySet<string>): DurableEffect {
    const parsed = parseEffect(next);
    const stored = cloneEffect(parsed);
    const result = cloneEffect(stored);
    const event = this.effectEvent(stored, kind, claimId);
    const eventPlan = this.preflightEvent(event, false, stored);
    const issuedCommit = nextIssuedClaims === undefined ? undefined : new Set(nextIssuedClaims);
    this.effects.set(stored.id, stored);
    if (issuedCommit !== undefined) this.issuedClaims.set(stored.id, issuedCommit);
    this.commitEvent(eventPlan);
    return result;
  }
  private effectEvent(effect: DurableEffect, kind: "effect-created" | "effect-claimed" | "effect-completed" | "effect-failed" | "effect-cancelled", claimId: string | null): DurableJournalEvent {
    const run = this.requireRunRevision(effect.spaceId, effect.runId, effect.runRevision); const stream = this.eventsByRun.get(effect.runId) ?? [];
    return parseEvent({ schemaVersion: 1, id: this.nextEventId(), spaceId: effect.spaceId, runId: effect.runId, runRevision: effect.runRevision, sequence: stream.length + 1, kind, runCiphertextSha256: run.record.envelope.ciphertextSha256, effectId: effect.id, effectRevision: effect.effectRevision, effectState: effect.state, claimSha256: claimId === null ? null : sha256(Buffer.from(claimId, "ascii")) });
  }
  private nextEventId(): string { for (let attempt = 0; attempt < 32; attempt += 1) { let candidate: string; try { candidate = this.eventIdGenerator(); } catch (_error) { throw failure("INVALID"); } if (CanonicalDurableIdSchema.safeParse(candidate).success && !this.events.has(candidate)) return candidate; } throw failure("CONFLICT"); }
  private hasNonterminalEffects(runId: string, runRevision: number): boolean { return [...this.effects.values()].some((effect) => effect.runId === runId && effect.runRevision === runRevision && effect.state !== "completed" && effect.state !== "cancelled"); }
  private atPublicBoundary<T>(operation: () => T): T { try { return operation(); } catch (error) { throw fixedBoundaryFailure(error); } }
  private nextClaimId(issued: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      let candidate: string;
      try { candidate = this.claimIdGenerator(); } catch (_error) { throw failure("INVALID"); }
      if (CanonicalDurableIdSchema.safeParse(candidate).success && !issued.has(candidate)) return candidate;
    }
    throw failure("CONFLICT");
  }
  private restoreUnchecked(image: InMemoryWorkStoreImage): void {
    if (!hasExactImageFields(image)) throw failure("INVALID");
    const metadata = parseImageMetadata(image.metadata);
    const envelopes = decodeDataArray(image.envelopes, MAX_IMAGE_ITEMS);
    if (envelopes.length !== metadata.records.length) throw failure("INVALID");
    for (const envelope of envelopes) this.putRecord(envelope as StoredOpaqueRecord);
    if (metadata.records.some((record) => !sameJson(this.recordRevisions.get(record.id)?.get(record.recordRevision)?.record, record))) throw failure("INVALID");
    for (const effect of metadata.effects) this.restoreEffect(effect);
    const claims = parseIssuedClaims(image.issuedClaims, metadata.effects);
    for (const [effectId, claimIds] of claims) {
      const existing = this.issuedClaims.get(effectId) ?? new Set<string>();
      for (const claimId of claimIds) existing.add(claimId);
      this.issuedClaims.set(effectId, existing);
    }
    for (const effect of metadata.effects) if (effect.claimId !== null && !this.issuedClaims.get(effect.id)?.has(effect.claimId)) throw failure("INVALID");
    for (const event of metadata.events) this.appendEventInternal(event, false);
    this.verifyEffectTranscripts();
  }
  private copyStateFrom(source: InMemoryWorkStore): void {
    this.clearOwnedCiphertext();
    copyMap(this.records, source.records); copyMap(this.recordRevisions, source.recordRevisions); copyMap(this.recordKeys, source.recordKeys); copyMap(this.ciphertextRefs, source.ciphertextRefs); copyMap(this.events, source.events); copyMap(this.eventsByRun, source.eventsByRun); copyMap(this.effects, source.effects); copyMap(this.effectKeys, source.effectKeys); copyMap(this.issuedClaims, source.issuedClaims);
  }
  private clearOwnedCiphertext(): void { const bytes = new Set<Uint8Array>(); for (const revisions of this.recordRevisions.values()) for (const record of revisions.values()) bytes.add(record.ciphertext); for (const value of bytes) value.fill(0); }
  private verifyEffectTranscripts(): void {
    for (const effect of this.effects.values()) {
      const transcript = [...this.eventsByRun.get(effect.runId) ?? []].filter((event) => event.effectId === effect.id);
      if (transcript.length === 0) throw failure("INVALID");
      let revision = 0; let state: DurableEffectState | undefined; let activeClaimHash: string | null = null; const claimedHashes: string[] = [];
      for (const event of transcript) {
        if (event.effectRevision === null || event.effectState === null || !effectBindsDurableRun(effect, this.requireRunRevision(event.spaceId, event.runId, event.runRevision).record)) throw failure("INVALID");
        if (event.kind === "effect-created") {
          if (revision !== 0 || event.effectRevision !== 1 || event.effectState !== "pending" || event.claimSha256 !== null) throw failure("INVALID");
          revision = 1; state = "pending"; continue;
        }
        if (revision === 0 || event.effectRevision !== revision + 1 || state === undefined || event.effectState === null || !canTransitionDurableEffect(state, event.effectState)) throw failure("INVALID");
        if (event.kind === "effect-claimed") {
          if ((state !== "pending" && state !== "failed") || event.effectState !== "claimed" || event.claimSha256 === null || !hasClaimHash(this.issuedClaims.get(effect.id), event.claimSha256)) throw failure("INVALID");
          activeClaimHash = event.claimSha256; claimedHashes.push(event.claimSha256);
        } else if (event.kind === "effect-completed" || event.kind === "effect-failed") {
          if (state !== "claimed" || event.claimSha256 === null || event.claimSha256 !== activeClaimHash) throw failure("INVALID");
        } else if (event.kind === "effect-cancelled") {
          if ((state === "claimed" || state === "failed") && event.claimSha256 !== activeClaimHash) throw failure("INVALID");
          if (state === "pending" && event.claimSha256 !== null) throw failure("INVALID");
          activeClaimHash = null;
        } else throw failure("INVALID");
        revision = event.effectRevision; state = event.effectState;
      }
      if (revision !== effect.effectRevision || state !== effect.state) throw failure("INVALID");
      const currentHash = effect.claimId === null ? null : sha256(Buffer.from(effect.claimId, "ascii"));
      if (currentHash !== activeClaimHash || (effect.claimId !== null && !this.issuedClaims.get(effect.id)?.has(effect.claimId))) throw failure("INVALID");
      const issuedHashes = [...(this.issuedClaims.get(effect.id) ?? new Set<string>())].map((claim) => sha256(Buffer.from(claim, "ascii")));
      if (claimedHashes.length !== issuedHashes.length || claimedHashes.some((hash, index) => hash !== issuedHashes[index])) throw failure("INVALID");
    }
  }
  private restoreEffect(input: DurableEffect): void {
    const effect = parseEffect(input); const run = this.requireRunRevision(effect.spaceId, effect.runId, effect.runRevision);
    const keyed = this.effectKeys.get(effectKey(effect));
    if (!effectBindsDurableRun(effect, run.record)) throw failure("INVALID");
    if (effect.state !== "completed" && effect.state !== "cancelled" && !effectBindsDurableRun(effect, this.requireRun(effect.spaceId, effect.runId).record)) throw failure("INVALID");
    if (keyed !== undefined) { const existing = this.effects.get(keyed); if (existing !== undefined && sameJson(existing, effect)) return; throw failure("INVALID"); }
    if (this.effects.has(effect.id)) throw failure("INVALID");
    this.effects.set(effect.id, cloneEffect(effect)); this.effectKeys.set(effectKey(effect), effect.id);
  }
}

function parseRecord(value: unknown): DurableJournalRecord { const parsed = DurableJournalRecordSchema.safeParse(value); if (!parsed.success) throw failure("INVALID"); return parsed.data; }
function parseEvent(value: unknown): DurableJournalEvent { const parsed = DurableJournalEventSchema.safeParse(value); if (!parsed.success) throw failure("INVALID"); return parsed.data; }
function parseEffect(value: unknown): DurableEffect { const parsed = DurableEffectSchema.safeParse(value); if (!parsed.success) throw failure("INVALID"); return parsed.data; }
function failure(code: InMemoryWorkStoreErrorCode): InMemoryWorkStoreError { return new InMemoryWorkStoreError(code); }
function fixedBoundaryFailure(error: unknown): InMemoryWorkStoreError {
  const code = error instanceof InMemoryWorkStoreError && (error.code === "INVALID" || error.code === "CONFLICT" || error.code === "NOT_FOUND" || error.code === "CANCELLED") ? error.code : "INVALID";
  return failure(code);
}
function validId(value: string): void { if (!CanonicalDurableIdSchema.safeParse(value).success) throw failure("INVALID"); }
function validRevision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw failure("INVALID"); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function recordKey(record: DurableJournalRecord): string { const key = record.idempotency; return key.kind === "task" ? `task:${record.spaceId}:${key.idempotencyKeySha256}` : key.kind === "run" ? `run:${record.spaceId}:${key.taskId}:${key.attempt}` : key.kind === "revision" ? `revision:${record.spaceId}:${key.reviewId}:${key.requestSha256}` : key.kind === "receipt" ? `receipt:${record.spaceId}:${key.runId}` : `entity:${record.spaceId}:${record.id}`; }
function effectKey(effect: DurableEffect): string { return `${effect.spaceId}:${effect.runId}:${effect.stepKey}:${effect.requestSha256}`; }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameRecord(left: StoredRecord, record: DurableJournalRecord, ciphertext: Uint8Array): boolean { return sameJson(left.record, record) && left.ciphertext.byteLength === ciphertext.byteLength && left.ciphertext.every((value, index) => value === ciphertext[index]); }
function sameIdempotency(left: DurableJournalRecord, right: DurableJournalRecord): boolean { return left.spaceId === right.spaceId && sameJson(left.idempotency, right.idempotency); }
function cloneRecord(record: DurableJournalRecord): DurableJournalRecord { return DurableJournalRecordSchema.parse(record); }
function cloneEvent(event: DurableJournalEvent): DurableJournalEvent { return DurableJournalEventSchema.parse(event); }
function cloneEffect(effect: DurableEffect): DurableEffect { return DurableEffectSchema.parse(effect); }
function cloneImage(image: InMemoryJournalImage): InMemoryJournalImage { return parseImageMetadata(image); }
function cloneStoredRecord(value: StoredRecord): StoredOpaqueRecord { return { record: cloneRecord(value.record), ciphertext: new Uint8Array(value.ciphertext) }; }
function ownedBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || BYTE_LENGTH_GETTER === undefined || BUFFER_GETTER === undefined) throw failure("INVALID");
  try {
    if (Object.hasOwn(value, "byteLength") || Object.hasOwn(value, "buffer")) throw failure("INVALID");
    const bytes = BYTE_LENGTH_GETTER.call(value); const buffer = BUFFER_GETTER.call(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CIPHERTEXT_BYTES || isShared(buffer)) throw failure("INVALID");
    const copy = new Uint8Array(value); if (copy.byteLength !== bytes) { copy.fill(0); throw failure("INVALID"); } return copy;
  } catch (error) { if (error instanceof InMemoryWorkStoreError) throw error; throw failure("INVALID"); }
}
function isShared(value: unknown): boolean { if (SHARED_LENGTH_GETTER === undefined) return false; try { return typeof SHARED_LENGTH_GETTER.call(value) === "number"; } catch { return false; } }
function hasExactImageFields(value: unknown): value is InMemoryWorkStoreImage { return hasExactDataFields(value, ["metadata", "envelopes", "issuedClaims"]); }
function hasExactStoredRecordFields(value: unknown): value is StoredOpaqueRecord { return hasExactDataFields(value, ["record", "ciphertext"]); }
function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> { try { if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false; const keys = Reflect.ownKeys(value); return keys.length === fields.length && fields.every((field) => keys.includes(field) && (() => { const descriptor = Object.getOwnPropertyDescriptor(value, field); return descriptor !== undefined && Object.hasOwn(descriptor, "value"); })()); } catch (_error) { return false; } }
function sameEnvelopeShape(left: DurableJournalRecord, right: DurableJournalRecord): boolean { return left.envelope.entityKind === right.envelope.entityKind && left.envelope.kind === right.envelope.kind; }
function parseImageMetadata(value: unknown): InMemoryJournalImage {
  if (!hasExactDataFields(value, ["schemaVersion", "records", "events", "effects"])) throw failure("INVALID");
  if (value.schemaVersion !== 1) throw failure("INVALID");
  const rawRecords = decodeDataArray(value.records, MAX_IMAGE_ITEMS); const rawEvents = decodeDataArray(value.events, MAX_IMAGE_ITEMS); const rawEffects = decodeDataArray(value.effects, MAX_IMAGE_ITEMS);
  const records = rawRecords.map(parseRecord); const events = rawEvents.map(parseEvent); const effects = rawEffects.map(parseEffect);
  const recordVersions = new Set<string>(); const ciphertextRefs = new Set<string>(); const eventIds = new Set<string>(); const effectIds = new Set<string>(); const nextByRun = new Map<string, number>();
  records.forEach((record) => { const version = `${record.id}:${record.recordRevision}`; if (recordVersions.has(version) || ciphertextRefs.has(record.envelope.ciphertextRef)) throw failure("INVALID"); recordVersions.add(version); ciphertextRefs.add(record.envelope.ciphertextRef); });
  events.forEach((event) => { const expected = nextByRun.get(event.runId) ?? 1; if (eventIds.has(event.id) || event.sequence !== expected) throw failure("INVALID"); eventIds.add(event.id); nextByRun.set(event.runId, expected + 1); });
  effects.forEach((effect) => { if (effectIds.has(effect.id)) throw failure("INVALID"); effectIds.add(effect.id); });
  return { schemaVersion: 1, records, events, effects };
}
function parseIssuedClaims(value: unknown, effects: readonly DurableEffect[]): Map<string, Set<string>> {
  const entries = decodeDataArray(value, MAX_IMAGE_ITEMS);
  if (entries.length !== effects.length) throw failure("INVALID");
  const effectIds = new Set(effects.map((effect) => effect.id)); const result = new Map<string, Set<string>>();
  let totalClaims = 0;
  for (const rawEntry of entries) {
    if (!hasExactDataFields(rawEntry, ["effectId", "claimIds"])) throw failure("INVALID");
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.effectId !== "string" || !effectIds.has(entry.effectId) || result.has(entry.effectId)) throw failure("INVALID");
    const claimIds = decodeDataArray(entry.claimIds, MAX_ISSUED_CLAIMS);
    const claims = new Set<string>();
    for (const claimId of claimIds) { totalClaims += 1; if (totalClaims > MAX_ISSUED_CLAIMS || typeof claimId !== "string" || !CanonicalDurableIdSchema.safeParse(claimId).success || claims.has(claimId)) throw failure("INVALID"); claims.add(claimId); }
    result.set(entry.effectId, claims);
  }
  if (result.size !== effects.length) throw failure("INVALID");
  return result;
}
/**
 * Copies a plain dense data array without invoking its iterator, methods, index
 * accessors, or length getter. A hostile same-isolate Proxy trap can still spend
 * CPU while the reflective checks execute; JavaScript provides no local preemption.
 */
function decodeDataArray(value: unknown, maxItems: number): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failure("INVALID");
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maxItems) throw failure("INVALID");
    const length = lengthDescriptor.value as number; const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) throw failure("INVALID");
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index); if (!keys.includes(key)) throw failure("INVALID");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) throw failure("INVALID");
      result.push(descriptor.value);
    }
    return result;
  } catch (error) { throw fixedBoundaryFailure(error); }
}
function copyMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void { target.clear(); source.forEach((value, key) => target.set(key, value)); }
function hasClaimHash(claims: ReadonlySet<string> | undefined, expectedHash: string): boolean { return claims !== undefined && [...claims].some((claim) => sha256(Buffer.from(claim, "ascii")) === expectedHash); }
