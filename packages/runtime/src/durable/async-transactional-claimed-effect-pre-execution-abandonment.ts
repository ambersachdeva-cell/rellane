import { createHash } from "node:crypto";
import { types } from "node:util";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { type CapabilityJournalState } from "@cadrane/contracts/capability-journal";
import { DurableEffectSchema, DurableJournalEventSchema, type DurableEffect, type DurableJournalEvent, type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import { canonicalCapabilityIntentSha256 } from "../capability-intent-binding.js";
import { validateCapabilityJournalBundle } from "../capability-journal-codec.js";
import { decodeOwnedCapabilityJournalStorageBundle } from "../capability-journal-storage-codec.js";
import { prepareCapabilityGrantIndexes } from "../capability-grant-index.js";
import { authorizedEffectClaimTargetBindingSha256ForTestOnly } from "./async-transactional-authorized-effect-claim.js";
import { inertEventEffectOperationBindingSha256ForTestOnly } from "./async-transactional-event-effect-journal.js";
import { type AsyncTransactionalPersistencePortForTestOnly } from "./async-transactional-persistence-filesystem-port.js";
import { EncryptedWorkStore, type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryWorkStore, type InMemoryWorkStoreImage } from "./in-memory-work-store.js";
import { enqueueTransactionalPortOperation } from "./transactional-port-queue.js";
import { TransactionalPersistenceError, disposeOpaqueJournalSnapshotForTestOnly, operationBindingSha256ForDurableRecordSetForTestOnly, restoreInMemoryWorkStoreFromSnapshotForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, validateRecoveredTransactionalStateForTestOnly, type OpaqueJournalSnapshot, type RecoveredTransactionalState, type TransactionReceipt } from "./transactional-persistence.js";

const HASH = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PROBE_CLAIM_ID = "00000000-0000-4000-8000-000000000001";

export interface ClaimedEffectPreExecutionAbandonmentResultForTestOnly {
  readonly event: DurableJournalEvent;
  readonly effect: Omit<DurableEffect, "claimId">;
  readonly authorization: Readonly<{ grantId: string; intentSha256: string; effectKind: "export-artifact" | "delete-record"; terminalOperationId: string; lifecycle: "consumed" }>;
  readonly abandonment: "before-execution";
  readonly effectExecution: "not-performed";
}

export class AsyncTransactionalClaimedEffectPreExecutionAbandonmentError extends Error {
  readonly code = "ASYNC_TRANSACTIONAL_CLAIMED_EFFECT_PRE_EXECUTION_ABANDONMENT_FAILED" as const;
  constructor() { super("Async transactional claimed effect pre-execution abandonment failed."); this.name = "AsyncTransactionalClaimedEffectPreExecutionAbandonmentError"; }
}

interface ConsumedAuthorizationLocator { readonly grantRecordId: string; readonly issueOperationId: string; readonly issueReceiptRecordId: string; readonly requestIndexRecordId: string; readonly decisionIndexRecordId: string; readonly consumedOperationId: string; readonly consumedReceiptRecordId: string; }
interface Owned { readonly operationId: string; readonly claimOperationId: string; readonly runOperationId: string; readonly runRecordedOperationId: string; readonly createOperationId: string; readonly pendingEffect: DurableEffect; readonly consumedAuthorization: ConsumedAuthorizationLocator; }
interface Prerequisites { readonly runOperationId: string; readonly runOperationBindingSha256: string; readonly runRecordedOperationId: string; readonly runRecordedOperationBindingSha256: string; readonly createOperationId: string; readonly createOperationBindingSha256: string; readonly issueOperationId: string; readonly issueOperationBindingSha256: string; readonly terminalOperationId: string; readonly terminalOperationBindingSha256: string; readonly authorizationUseAt: string; }
interface B1Prerequisites { readonly runOperationId: string; readonly runOperationBindingSha256: string; readonly runRecordedOperationId: string; readonly runRecordedOperationBindingSha256: string; readonly createOperationId: string; readonly createOperationBindingSha256: string; }
interface Capability { readonly state: CapabilityJournalState; readonly digest: string; readonly issueBinding: string; readonly terminalBinding: string; }
interface B3Chain { readonly claimed: DurableEffect; readonly event: DurableJournalEvent; readonly prerequisites: Prerequisites; readonly binding: string; }
interface B4Chain { readonly claimed: DurableEffect; readonly failed: DurableEffect; readonly claimEvent: DurableJournalEvent; readonly event: DurableJournalEvent; readonly b3: B3Chain; readonly binding: string; }

/**
 * Private/test-only local lease abandonment. `effect-failed` records only that
 * no execution occurred before the lease was abandoned; it is not external
 * failure evidence and cannot authorize a future retry.
 */
export class AsyncTransactionalClaimedEffectPreExecutionAbandonmentForTestOnly {
  private readonly identity: object;

  constructor(private readonly port: AsyncTransactionalPersistencePortForTestOnly, private readonly keys: WorkspaceKeyProvider) {
    try { const identity = port.concurrencyIdentity; if (identity === null || typeof identity !== "object" || types.isProxy(identity)) throw failed(); this.identity = identity; }
    catch { throw failed(); }
  }

  async abandonClaimBeforeExecution(input: unknown): Promise<ClaimedEffectPreExecutionAbandonmentResultForTestOnly> {
    let owned: Owned | undefined;
    try { owned = parse(input); return await enqueueTransactionalPortOperation(this.identity, () => this.abandonOwned(owned!)); }
    catch { throw failed(); }
  }

  private async abandonOwned(input: Owned): Promise<ClaimedEffectPreExecutionAbandonmentResultForTestOnly> {
    let raw: RecoveredTransactionalState | undefined; let recovered: RecoveredTransactionalState | undefined;
    let store: InMemoryWorkStore | undefined; let bridge: InMemoryWorkStoreImage | undefined; let deterministic: InMemoryWorkStore | undefined;
    let staged: OpaqueJournalSnapshot | undefined; let verifiedRaw: RecoveredTransactionalState | undefined; let verified: RecoveredTransactionalState | undefined; let verifier: InMemoryWorkStore | undefined;
    try {
      ({ raw, validated: recovered } = await recover(this.port));
      const b1 = await deriveB1Preconditions(this.port, recovered!, input);
      const preflight = await preflightClaimedState(this.port, recovered!, input);
      const capability = await authenticateCapability(this.port, this.keys, recovered!, input);
      const chain = deriveB4(recovered!, input, capability, b1);
      await requireBinding(this.port, input.claimOperationId, chain.b3.binding);
      if (preflight === "replay") {
        await requireBinding(this.port, input.operationId, chain.binding);
        return result(chain.event, chain.failed, capability.state);
      }
      if (await this.port.recoverOperationBinding(input.operationId) !== undefined) throw failed();

      store = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered!.snapshot); bridge = store.exportImageForTestOnly();
      let claimGeneratorCalls = 0; let eventCalls = 0;
      deterministic = new InMemoryWorkStore(() => { claimGeneratorCalls += 1; throw failed(); }, () => { if (++eventCalls !== 1) throw failed(); return input.operationId; });
      deterministic.restoreImageForTestOnly(bridge); wipeImage(bridge); bridge = undefined; store.disposeForTestOnly(); store = undefined;
      const abandoned = deterministic.failEffect(input.pendingEffect.spaceId, input.pendingEffect.id, 2, chain.claimed.claimId!);
      if (claimGeneratorCalls !== 0 || eventCalls !== 1 || !same(abandoned, chain.failed)) throw failed();
      const successor = deterministic.exportImageForTestOnly();
      try { assertSuccessor(successor, recovered!, input, chain); } finally { wipeImage(successor); }
      staged = snapshotFromInMemoryWorkStoreForTestOnly(deterministic);
      const receipt = await commitOnce(this.port, Object.freeze({ commitId: input.operationId, expectedGeneration: recovered!.generation, expectedSnapshotSha256: recovered!.snapshotSha256, operationBindingSha256: chain.binding, snapshot: staged }), input.operationId, recovered!.generation + 1);
      ({ raw: verifiedRaw, validated: verified } = await recover(this.port));
      if (verified!.generation !== receipt.generation || verified!.snapshotSha256 !== receipt.snapshotSha256) throw failed();
      const verifiedB1 = await deriveB1Preconditions(this.port, verified!, input);
      await preflightClaimedState(this.port, verified!, input);
      const verifiedCapability = await authenticateCapability(this.port, this.keys, verified!, input);
      const adopted = deriveB4(verified!, input, verifiedCapability, verifiedB1);
      if (adopted.binding !== chain.binding) throw failed(); await requireBinding(this.port, input.claimOperationId, adopted.b3.binding); await requireBinding(this.port, input.operationId, adopted.binding);
      verifier = restoreInMemoryWorkStoreFromSnapshotForTestOnly(verified!.snapshot);
      return result(adopted.event, adopted.failed, verifiedCapability.state);
    } catch { throw failed(); }
    finally {
      store?.disposeForTestOnly(); deterministic?.disposeForTestOnly(); verifier?.disposeForTestOnly(); wipeImage(bridge);
      disposeOpaqueJournalSnapshotForTestOnly(raw?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(recovered?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(staged);
      disposeOpaqueJournalSnapshotForTestOnly(verifiedRaw?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(verified?.snapshot);
    }
  }
}

/** Stable private binding for a B3-authenticated abandonment before execution. */
export function claimedEffectPreExecutionAbandonmentTargetBindingSha256ForTestOnly(value: unknown): string {
  try {
    const raw = exact(value, ["operationId", "claimOperationId", "claimOperationBindingSha256", "prerequisites", "consumedCapabilityBundleSha256", "pendingEffect", "claimedEffect", "failedEffect", "issuedClaimDelta", "claimEvent", "event", "abandonment", "effectExecution"]);
    if (raw === undefined || !id(raw.operationId) || !id(raw.claimOperationId) || raw.operationId === raw.claimOperationId || !hash(raw.claimOperationBindingSha256) || !hash(raw.consumedCapabilityBundleSha256) || raw.abandonment !== "before-execution" || raw.effectExecution !== "not-performed") throw failed();
    const prerequisites = copyPrerequisites(capture(raw.prerequisites)); const pending = copyEffect(capture(raw.pendingEffect)); const claimed = copyRedactedEffect(capture(raw.claimedEffect), "claimed", 2); const failedEffect = copyRedactedEffect(capture(raw.failedEffect), "failed", 3); const claimEvent = copyEvent(capture(raw.claimEvent)); const event = copyEvent(capture(raw.event));
    const delta = exact(capture(raw.issuedClaimDelta), ["effectId", "claimSha256"]);
    if (delta === undefined || delta.effectId !== claimed.id || delta.claimSha256 !== claimed.claimSha256 || !hash(delta.claimSha256) || pending.state !== "pending" || pending.effectRevision !== 1 || pending.claimId !== null || !sameRedactedTuple(pending, claimed) || !sameRedactedTuple(pending, failedEffect) || claimed.claimSha256 !== failedEffect.claimSha256) throw failed();
    const b3Binding = authorizedEffectClaimTargetBindingSha256ForTestOnly({ operationId: raw.claimOperationId, prerequisites, consumedCapabilityBundleSha256: raw.consumedCapabilityBundleSha256, pendingEffect: pending, claimedEffect: claimed, issuedClaimDelta: { effectId: claimed.id, claimSha256: claimed.claimSha256 }, event: claimEvent, effectExecution: "not-performed" });
    if (b3Binding !== raw.claimOperationBindingSha256 || claimEvent.id !== raw.claimOperationId || event.id !== raw.operationId || event.kind !== "effect-failed" || event.sequence !== 4 || event.spaceId !== failedEffect.spaceId || event.runId !== failedEffect.runId || event.runRevision !== failedEffect.runRevision || event.effectId !== failedEffect.id || event.effectRevision !== 3 || event.effectState !== "failed" || event.claimSha256 !== failedEffect.claimSha256) throw failed();
    return createHash("sha256").update(`async-transactional-claimed-effect-pre-execution-abandonment:v1:${JSON.stringify({ operationId: raw.operationId, claimOperationId: raw.claimOperationId, claimOperationBindingSha256: b3Binding, prerequisites, consumedCapabilityBundleSha256: raw.consumedCapabilityBundleSha256, pendingEffect: canonicalEffect(pending), claimedEffect: claimed, failedEffect, issuedClaimDelta: { effectId: claimed.id, claimSha256: claimed.claimSha256 }, claimEvent: canonicalEvent(claimEvent), event: canonicalEvent(event), abandonment: "before-execution", effectExecution: "not-performed" })}`).digest("hex");
  } catch { throw failed(); }
}

async function preflightClaimedState(port: AsyncTransactionalPersistencePortForTestOnly, state: RecoveredTransactionalState, input: Owned): Promise<"fresh" | "replay"> {
  const effect = effectById(state, input.pendingEffect.id); const claimEvent = eventById(state, input.claimOperationId); const event = eventById(state, input.operationId); const claims = claimDelta(state, input.pendingEffect.id);
  const run = record(state, input.pendingEffect.runId, input.pendingEffect.runRevision, "run"); const allClaims = state.snapshot.issuedClaims.flatMap((entry) => entry.claimIds);
  if (effect === undefined || claimEvent === undefined || claims.length !== 1 || allClaims.length !== 1 || effect.claimId === null || claims[0] !== effect.claimId || allClaims[0] !== effect.claimId || !sameTuple(input.pendingEffect, effect) || claimEvent.id !== input.claimOperationId || claimEvent.kind !== "effect-claimed" || claimEvent.sequence !== 3 || claimEvent.spaceId !== effect.spaceId || claimEvent.runId !== effect.runId || claimEvent.runRevision !== effect.runRevision || claimEvent.runCiphertextSha256 !== run.envelope.ciphertextSha256 || claimEvent.effectId !== effect.id || claimEvent.effectRevision !== 2 || claimEvent.effectState !== "claimed" || claimEvent.claimSha256 !== claimHash(effect.claimId)) throw failed();
  if (await port.recoverOperationBinding(input.claimOperationId) === undefined) throw failed();
  const runEvents = state.snapshot.journal.events.filter((item) => item.runId === input.pendingEffect.runId); const effectEvents = state.snapshot.journal.events.filter((item) => item.effectId === input.pendingEffect.id);
  if (effect.state === "claimed" && effect.effectRevision === 2) {
    if (event !== undefined || await port.recoverOperationBinding(input.operationId) !== undefined || runEvents.length !== 3 || effectEvents.length !== 2 || runEvents[0]?.id !== input.runRecordedOperationId || runEvents[1]?.id !== input.createOperationId || runEvents[2]?.id !== input.claimOperationId || effectEvents[0]?.id !== input.createOperationId || effectEvents[1]?.id !== input.claimOperationId) throw failed();
    return "fresh";
  }
  if (effect.state === "failed" && effect.effectRevision === 3) {
    if (event === undefined || event.kind !== "effect-failed" || event.id !== input.operationId || event.sequence !== 4 || event.spaceId !== effect.spaceId || event.runId !== effect.runId || event.runRevision !== effect.runRevision || event.runCiphertextSha256 !== run.envelope.ciphertextSha256 || event.effectId !== effect.id || event.effectRevision !== 3 || event.effectState !== "failed" || event.claimSha256 !== claimHash(effect.claimId) || await port.recoverOperationBinding(input.operationId) === undefined || runEvents.length !== 4 || effectEvents.length !== 3 || runEvents[0]?.id !== input.runRecordedOperationId || runEvents[1]?.id !== input.createOperationId || runEvents[2]?.id !== input.claimOperationId || runEvents[3]?.id !== input.operationId || effectEvents[0]?.id !== input.createOperationId || effectEvents[1]?.id !== input.claimOperationId || effectEvents[2]?.id !== input.operationId) throw failed();
    return "replay";
  }
  throw failed();
}

function deriveB4(state: RecoveredTransactionalState, input: Owned, capability: Capability, b1: B1Prerequisites): B4Chain {
  const current = effectById(state, input.pendingEffect.id); const claimEvent = eventById(state, input.claimOperationId);
  if (current === undefined || claimEvent === undefined) throw failed();
  const claimed = current.state === "claimed" && current.effectRevision === 2 ? current : current.state === "failed" && current.effectRevision === 3 ? DurableEffectSchema.parse({ ...current, state: "claimed", effectRevision: 2 }) : (() => { throw failed(); })();
  if (claimed.claimId === null || !sameTuple(input.pendingEffect, claimed)) throw failed();
  const b3 = deriveB3(state, input, capability, completePrerequisites(b1, capability), claimed, claimEvent);
  const failedEffect = DurableEffectSchema.parse({ ...claimed, state: "failed", effectRevision: 3 }); const claimSha256 = claimHash(claimed.claimId);
  const expectedEvent = DurableJournalEventSchema.parse({ schemaVersion: 1, id: input.operationId, spaceId: failedEffect.spaceId, runId: failedEffect.runId, runRevision: failedEffect.runRevision, sequence: 4, kind: "effect-failed", runCiphertextSha256: record(state, failedEffect.runId, failedEffect.runRevision, "run").envelope.ciphertextSha256, effectId: failedEffect.id, effectRevision: 3, effectState: "failed", claimSha256 });
  const event = eventById(state, input.operationId); if (current.state === "failed" && !same(event, expectedEvent)) throw failed(); if (current.state === "claimed" && event !== undefined) throw failed();
  const binding = claimedEffectPreExecutionAbandonmentTargetBindingSha256ForTestOnly({ operationId: input.operationId, claimOperationId: input.claimOperationId, claimOperationBindingSha256: b3.binding, prerequisites: b3.prerequisites, consumedCapabilityBundleSha256: capability.digest, pendingEffect: input.pendingEffect, claimedEffect: redactedEffect(claimed, claimSha256), failedEffect: redactedEffect(failedEffect, claimSha256), issuedClaimDelta: { effectId: claimed.id, claimSha256 }, claimEvent: b3.event, event: expectedEvent, abandonment: "before-execution", effectExecution: "not-performed" });
  return Object.freeze({ claimed, failed: failedEffect, claimEvent: b3.event, event: expectedEvent, b3, binding });
}

function deriveB3(state: RecoveredTransactionalState, input: Owned, capability: Capability, prerequisites: Prerequisites, claimed: DurableEffect, event: DurableJournalEvent): B3Chain {
  if (claimed.state !== "claimed" || claimed.effectRevision !== 2 || claimed.claimId === null || !sameTuple(input.pendingEffect, claimed)) throw failed();
  const expectedEvent = DurableJournalEventSchema.parse({ schemaVersion: 1, id: input.claimOperationId, spaceId: claimed.spaceId, runId: claimed.runId, runRevision: claimed.runRevision, sequence: 3, kind: "effect-claimed", runCiphertextSha256: record(state, claimed.runId, claimed.runRevision, "run").envelope.ciphertextSha256, effectId: claimed.id, effectRevision: 2, effectState: "claimed", claimSha256: claimHash(claimed.claimId) });
  const delta = claimDelta(state, claimed.id); if (!same(event, expectedEvent) || delta.length !== 1 || delta[0] !== claimed.claimId) throw failed();
  const claimSha256 = claimHash(claimed.claimId); const binding = authorizedEffectClaimTargetBindingSha256ForTestOnly({ operationId: input.claimOperationId, prerequisites, consumedCapabilityBundleSha256: capability.digest, pendingEffect: input.pendingEffect, claimedEffect: redactedEffect(claimed, claimSha256), issuedClaimDelta: { effectId: claimed.id, claimSha256 }, event: expectedEvent, effectExecution: "not-performed" });
  return Object.freeze({ claimed, event: expectedEvent, prerequisites, binding });
}

function assertSuccessor(image: InMemoryWorkStoreImage, prior: RecoveredTransactionalState, input: Owned, chain: B4Chain): void {
  const events = image.metadata.events.filter((item) => item.runId === input.pendingEffect.runId); const effects = image.metadata.effects.filter((item) => item.id === input.pendingEffect.id); const issued = image.issuedClaims.filter((item) => item.effectId === input.pendingEffect.id);
  const previousCiphertext = new Map(prior.snapshot.ciphertextBlobs.map((blob) => [blob.ciphertextRef, blob] as const));
  const ciphertextUnchanged = image.envelopes.length === previousCiphertext.size && image.envelopes.every((entry) => { const previous = previousCiphertext.get(entry.record.envelope.ciphertextRef); return previous !== undefined && previous.ciphertextSha256 === entry.record.envelope.ciphertextSha256 && sameBytes(previous.bytes, entry.ciphertext); });
  if (!same(image.metadata.records, prior.snapshot.journal.records) || !same(image.issuedClaims, prior.snapshot.issuedClaims) || !ciphertextUnchanged || events.length !== 4 || events[0]?.id !== input.runRecordedOperationId || events[1]?.id !== input.createOperationId || !same(events[2], chain.claimEvent) || !same(events[3], chain.event) || effects.length !== 1 || !same(effects[0], chain.failed) || issued.length !== 1 || issued[0]?.claimIds.length !== 1 || issued[0]?.claimIds[0] !== chain.claimed.claimId) throw failed();
}

async function authenticateCapability(port: AsyncTransactionalPersistencePortForTestOnly, keys: WorkspaceKeyProvider, state: RecoveredTransactionalState, input: Owned): Promise<Capability> {
  const locator = input.consumedAuthorization;
  const issued = [capabilityRecord(state, locator.grantRecordId, 1, "capability-grant"), capabilityRecord(state, locator.issueReceiptRecordId, 1, "capability-grant-receipt"), capabilityRecord(state, locator.requestIndexRecordId, 1, "capability-grant-index"), capabilityRecord(state, locator.decisionIndexRecordId, 1, "capability-grant-index")];
  const terminalRecords = [capabilityRecord(state, locator.grantRecordId, 2, "capability-grant"), capabilityRecord(state, locator.consumedReceiptRecordId, 1, "capability-grant-receipt")];
  if (new Set([...issued, ...terminalRecords].map((item) => `${item.id}:${item.recordRevision}`)).size !== 6) throw failed();
  const spaceId = issued[0]!.spaceId; const keyId = issued[0]!.envelope.keyId;
  if (input.pendingEffect.spaceId !== spaceId || [...issued, ...terminalRecords].some((item) => item.spaceId !== spaceId || item.envelope.spaceId !== spaceId || item.envelope.keyId !== keyId)) throw failed();
  const issueBinding = operationBindingSha256ForDurableRecordSetForTestOnly(issued); const terminalBinding = operationBindingSha256ForDurableRecordSetForTestOnly(terminalRecords);
  await requireBinding(port, locator.issueOperationId, issueBinding); await requireBinding(port, locator.consumedOperationId, terminalBinding);
  let store: InMemoryWorkStore | undefined; let bundle: ReturnType<typeof validateCapabilityJournalBundle> | undefined;
  try { store = restoreInMemoryWorkStoreFromSnapshotForTestOnly(state.snapshot); bundle = await decryptBundle(store, keys, spaceId, keyId, issued, terminalRecords); }
  finally { store?.disposeForTestOnly(); }
  const terminal = bundle!.state.terminal;
  if (bundle.state.lifecycle !== "consumed" || bundle.state.stateRevision !== 2 || bundle.state.intent.maxUses !== 1 || bundle.receipt.effectExecution !== "not-performed" || bundle.receipt.recordedAt !== bundle.state.lastTransitionAt || bundle.state.lastTransitionAt >= bundle.state.intent.expiresAt || terminal === null || terminal.lifecycle !== "consumed" || bundle.predecessor === null || bundle.predecessor.state.lifecycle !== "issued" || bundle.predecessor.state.stateRevision !== 1 || bundle.predecessor.receipt.lifecycle !== "issued") throw failed();
  const intent = bundle.state.intent;
  if (intent.spaceId !== spaceId || intent.runId !== input.pendingEffect.runId || intent.effectId !== input.pendingEffect.id || intent.effectRevision !== 1 || intent.requestSha256 !== input.pendingEffect.requestSha256 || bundle.state.intentSha256 !== canonicalCapabilityIntentSha256(intent)) throw failed();
  const indexes = prepareCapabilityGrantIndexes({ state: bundle.predecessor.state, receipt: bundle.predecessor.receipt, predecessor: null });
  if (bundle.state.grantRecordId !== locator.grantRecordId || bundle.predecessor.state.grantRecordId !== locator.grantRecordId || bundle.predecessor.state.issueOperationId !== locator.issueOperationId || bundle.predecessor.state.issueReceiptId !== locator.issueReceiptRecordId || indexes[0].indexRole !== "request" || indexes[0].indexRecordId !== locator.requestIndexRecordId || indexes[1].indexRole !== "decision" || indexes[1].indexRecordId !== locator.decisionIndexRecordId || terminal.operationId !== locator.consumedOperationId || terminal.receiptId !== locator.consumedReceiptRecordId) throw failed();
  assertHiddenIdentities(input, bundle, indexes);
  return Object.freeze({ state: bundle.state, digest: capabilityDigest(bundle), issueBinding, terminalBinding });
}

async function decryptBundle(store: InMemoryWorkStore, keys: WorkspaceKeyProvider, spaceId: string, keyId: string, issued: readonly DurableJournalRecord[], terminal: readonly DurableJournalRecord[]): Promise<ReturnType<typeof validateCapabilityJournalBundle>> {
  const plaintext: Uint8Array[] = [];
  try {
    const facade = new EncryptedWorkStore(store, keys); const read = async (value: DurableJournalRecord) => { if (value.spaceId !== spaceId || value.envelope.keyId !== keyId || value.idempotency.kind !== "entity") throw failed(); const bytes = await facade.read({ spaceId, keyId, id: value.id, recordRevision: value.recordRevision }); plaintext.push(bytes); return bytes; };
    return decodeOwnedCapabilityJournalStorageBundle({ current: { state: { entityKind: "capability-grant", id: terminal[0]!.id, recordRevision: 2, plaintext: await read(terminal[0]!) }, receipt: { entityKind: "capability-grant-receipt", id: terminal[1]!.id, recordRevision: 1, plaintext: await read(terminal[1]!) }, indexes: [] }, predecessor: { state: { entityKind: "capability-grant", id: issued[0]!.id, recordRevision: 1, plaintext: await read(issued[0]!) }, receipt: { entityKind: "capability-grant-receipt", id: issued[1]!.id, recordRevision: 1, plaintext: await read(issued[1]!) }, indexes: [{ entityKind: "capability-grant-index", id: issued[2]!.id, recordRevision: 1, plaintext: await read(issued[2]!) }, { entityKind: "capability-grant-index", id: issued[3]!.id, recordRevision: 1, plaintext: await read(issued[3]!) }] } }).bundle;
  } finally { plaintext.forEach((bytes) => bytes.fill(0)); }
}

async function deriveB1Preconditions(port: AsyncTransactionalPersistencePortForTestOnly, state: RecoveredTransactionalState, input: Owned): Promise<B1Prerequisites> {
  const run = record(state, input.pendingEffect.runId, input.pendingEffect.runRevision, "run"); if (run.spaceId !== input.pendingEffect.spaceId || run.idempotency.kind !== "run") throw failed();
  const runBinding = operationBindingSha256ForDurableRecordSetForTestOnly([run]); await requireBinding(port, input.runOperationId, runBinding);
  const anchor = eventById(state, input.runRecordedOperationId); const created = eventById(state, input.createOperationId);
  if (anchor === undefined || anchor.kind !== "run-recorded" || anchor.sequence !== 1 || anchor.spaceId !== input.pendingEffect.spaceId || anchor.runId !== input.pendingEffect.runId || anchor.runRevision !== input.pendingEffect.runRevision || anchor.runCiphertextSha256 !== run.envelope.ciphertextSha256 || anchor.effectId !== null || anchor.effectRevision !== null || anchor.effectState !== null || anchor.claimSha256 !== null) throw failed();
  const anchorBinding = inertEventEffectOperationBindingSha256ForTestOnly("record-run", input.runRecordedOperationId, anchor, null, { runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, anchorOperationId: null, anchorOperationBindingSha256: null }); await requireBinding(port, input.runRecordedOperationId, anchorBinding);
  if (created === undefined || created.kind !== "effect-created" || created.sequence !== 2 || created.spaceId !== input.pendingEffect.spaceId || created.runId !== input.pendingEffect.runId || created.runRevision !== input.pendingEffect.runRevision || created.runCiphertextSha256 !== run.envelope.ciphertextSha256 || created.effectId !== input.pendingEffect.id || created.effectRevision !== 1 || created.effectState !== "pending" || created.claimSha256 !== null) throw failed();
  const createBinding = inertEventEffectOperationBindingSha256ForTestOnly("create-pending-effect", input.createOperationId, created, input.pendingEffect, { runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, anchorOperationId: input.runRecordedOperationId, anchorOperationBindingSha256: anchorBinding }); await requireBinding(port, input.createOperationId, createBinding);
  return Object.freeze({ runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, runRecordedOperationId: input.runRecordedOperationId, runRecordedOperationBindingSha256: anchorBinding, createOperationId: input.createOperationId, createOperationBindingSha256: createBinding });
}

function completePrerequisites(b1: B1Prerequisites, capability: Capability): Prerequisites { return Object.freeze({ ...b1, issueOperationId: capability.state.issueOperationId, issueOperationBindingSha256: capability.issueBinding, terminalOperationId: capability.state.terminal!.operationId, terminalOperationBindingSha256: capability.terminalBinding, authorizationUseAt: capability.state.lastTransitionAt }); }

function parse(value: unknown): Owned {
  const raw = exact(value, ["operationId", "claimOperationId", "runOperationId", "runRecordedOperationId", "createOperationId", "pendingEffect", "consumedAuthorization"]);
  if (raw === undefined || !id(raw.operationId) || !id(raw.claimOperationId) || !id(raw.runOperationId) || !id(raw.runRecordedOperationId) || !id(raw.createOperationId)) throw failed();
  const pendingEffect = copyEffect(capture(raw.pendingEffect)); const consumedAuthorization = parseConsumedAuthorization(capture(raw.consumedAuthorization));
  if (pendingEffect.state !== "pending" || pendingEffect.effectRevision !== 1 || pendingEffect.claimId !== null) throw failed();
  const operations = [raw.operationId as string, raw.claimOperationId as string, raw.runOperationId as string, raw.runRecordedOperationId as string, raw.createOperationId as string]; const visible = [...collectIds(pendingEffect), ...collectIds(consumedAuthorization)];
  if (new Set(operations).size !== operations.length || operations.some((item) => visible.includes(item))) throw failed();
  return Object.freeze({ operationId: raw.operationId as string, claimOperationId: raw.claimOperationId as string, runOperationId: raw.runOperationId as string, runRecordedOperationId: raw.runRecordedOperationId as string, createOperationId: raw.createOperationId as string, pendingEffect, consumedAuthorization });
}

async function recover(port: AsyncTransactionalPersistencePortForTestOnly): Promise<{ raw: RecoveredTransactionalState; validated: RecoveredTransactionalState }> { let raw: RecoveredTransactionalState | undefined; let validated: RecoveredTransactionalState | undefined; try { raw = await port.recover(); validated = validateRecoveredTransactionalStateForTestOnly(raw); return { raw, validated }; } catch { disposeOpaqueJournalSnapshotForTestOnly(raw?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(validated?.snapshot); throw failed(); } }
async function requireBinding(port: AsyncTransactionalPersistencePortForTestOnly, operationId: string, expected: string): Promise<void> { try { const raw = exact(await port.recoverOperationBinding(operationId), ["commitId", "operationBindingSha256"]); if (raw === undefined || raw.commitId !== operationId || raw.operationBindingSha256 !== expected || !hash(raw.operationBindingSha256)) throw failed(); } catch { throw failed(); } }
async function commitOnce(port: AsyncTransactionalPersistencePortForTestOnly, request: unknown, operationId: string, generation: number): Promise<TransactionReceipt> { try { return receipt(await port.commit(request), operationId, generation); } catch (error) { if (!(error instanceof TransactionalPersistenceError) || error.code !== "INTERRUPTED") throw error; return receipt(await port.commit(request), operationId, generation); } }
function receipt(value: unknown, operationId: string, generation: number): TransactionReceipt { const raw = exact(value, ["commitId", "generation", "snapshotSha256"]); if (raw === undefined || raw.commitId !== operationId || raw.generation !== generation || !hash(raw.snapshotSha256)) throw failed(); return Object.freeze({ commitId: operationId, generation, snapshotSha256: raw.snapshotSha256 as string }); }
function record(state: RecoveredTransactionalState, value: string, revision: number, kind: string): DurableJournalRecord { const matches = state.snapshot.journal.records.filter((item) => item.id === value && item.recordRevision === revision); if (matches.length !== 1 || matches[0]!.envelope.entityKind !== kind) throw failed(); return matches[0]!; }
function capabilityRecord(state: RecoveredTransactionalState, value: string, revision: number, kind: "capability-grant" | "capability-grant-receipt" | "capability-grant-index"): DurableJournalRecord { const found = record(state, value, revision, kind); if (found.idempotency.kind !== "entity" || found.envelope.entityId !== value || found.envelope.spaceId !== found.spaceId || found.envelope.contentRevision !== revision || found.envelope.kind !== "payload") throw failed(); return found; }
function eventById(state: RecoveredTransactionalState, value: string): DurableJournalEvent | undefined { const matches = state.snapshot.journal.events.filter((item) => item.id === value); if (matches.length > 1) throw failed(); return matches[0]; }
function effectById(state: RecoveredTransactionalState, value: string): DurableEffect | undefined { const matches = state.snapshot.journal.effects.filter((item) => item.id === value); if (matches.length > 1) throw failed(); return matches[0]; }
function claimDelta(state: RecoveredTransactionalState, effectId: string): readonly string[] { const entries = state.snapshot.issuedClaims.filter((entry) => entry.effectId === effectId); if (entries.length > 1) throw failed(); return entries[0]?.claimIds ?? []; }
function capabilityDigest(value: ReturnType<typeof validateCapabilityJournalBundle>): string { return createHash("sha256").update("authorized-effect-claim-consumed-capability:v1:" + JSON.stringify(value)).digest("hex"); }
function claimHash(value: string): string { return createHash("sha256").update(value, "ascii").digest("hex"); }
function sameTuple(left: DurableEffect, right: DurableEffect): boolean { return left.id === right.id && left.spaceId === right.spaceId && left.runId === right.runId && left.runRevision === right.runRevision && left.stepKey === right.stepKey && left.requestSha256 === right.requestSha256; }
function sameRedactedTuple(left: DurableEffect, right: Omit<DurableEffect, "claimId"> & { readonly claimSha256: string }): boolean { return left.id === right.id && left.spaceId === right.spaceId && left.runId === right.runId && left.runRevision === right.runRevision && left.stepKey === right.stepKey && left.requestSha256 === right.requestSha256; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
function id(value: unknown): value is string { return CanonicalDurableIdSchema.safeParse(value).success; }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined { try { if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined; const keys = Reflect.ownKeys(value); if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) return undefined; const output: Record<string, unknown> = {}; for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined; output[field] = descriptor.value; } return output; } catch { return undefined; } }
function copyEffect(value: unknown): DurableEffect { const parsed = DurableEffectSchema.safeParse(value); if (!parsed.success) throw failed(); return parsed.data; }
function copyEvent(value: unknown): DurableJournalEvent { const parsed = DurableJournalEventSchema.safeParse(value); if (!parsed.success) throw failed(); return parsed.data; }
function copyRedactedEffect(value: unknown, state: "claimed" | "failed", revision: 2 | 3): Omit<DurableEffect, "claimId"> & { readonly claimSha256: string } { const raw = exact(value, ["schemaVersion", "id", "spaceId", "runId", "runRevision", "stepKey", "requestSha256", "state", "effectRevision", "claimSha256"]); if (raw === undefined || raw.state !== state || raw.effectRevision !== revision || !hash(raw.claimSha256)) throw failed(); const { claimSha256, ...effect } = raw; const parsed = DurableEffectSchema.safeParse({ ...effect, claimId: PROBE_CLAIM_ID }); if (!parsed.success) throw failed(); const { claimId: _claimId, ...redacted } = parsed.data; return Object.freeze({ ...redacted, claimSha256: claimSha256 as string }); }
function redactedEffect(effect: DurableEffect, claimSha256: string): Omit<DurableEffect, "claimId"> & { readonly claimSha256: string } { const { claimId: _claimId, ...redacted } = effect; return Object.freeze({ ...redacted, claimSha256 }); }
function copyPrerequisites(value: unknown): Prerequisites { const raw = exact(value, ["runOperationId", "runOperationBindingSha256", "runRecordedOperationId", "runRecordedOperationBindingSha256", "createOperationId", "createOperationBindingSha256", "issueOperationId", "issueOperationBindingSha256", "terminalOperationId", "terminalOperationBindingSha256", "authorizationUseAt"]); if (raw === undefined || !id(raw.runOperationId) || !hash(raw.runOperationBindingSha256) || !id(raw.runRecordedOperationId) || !hash(raw.runRecordedOperationBindingSha256) || !id(raw.createOperationId) || !hash(raw.createOperationBindingSha256) || !id(raw.issueOperationId) || !hash(raw.issueOperationBindingSha256) || !id(raw.terminalOperationId) || !hash(raw.terminalOperationBindingSha256) || typeof raw.authorizationUseAt !== "string" || !ISO.test(raw.authorizationUseAt)) throw failed(); return Object.freeze(raw as unknown as Prerequisites); }
function parseConsumedAuthorization(value: unknown): ConsumedAuthorizationLocator { const raw = exact(value, ["grantRecordId", "issueOperationId", "issueReceiptRecordId", "requestIndexRecordId", "decisionIndexRecordId", "consumedOperationId", "consumedReceiptRecordId"]); if (raw === undefined || !id(raw.grantRecordId) || !id(raw.issueOperationId) || !id(raw.issueReceiptRecordId) || !id(raw.requestIndexRecordId) || !id(raw.decisionIndexRecordId) || !id(raw.consumedOperationId) || !id(raw.consumedReceiptRecordId) || new Set(Object.values(raw)).size !== 7) throw failed(); return Object.freeze(raw as unknown as ConsumedAuthorizationLocator); }
function assertHiddenIdentities(input: Owned, bundle: ReturnType<typeof validateCapabilityJournalBundle>, indexes: readonly [{ readonly indexRecordId: string }, { readonly indexRecordId: string }]): void { const state = bundle.state; const terminal = state.terminal; const previous = bundle.predecessor?.state; if (terminal === null || previous === undefined) throw failed(); const hidden = new Set([state.grantRecordId, state.grantId, state.intent.permissionRequestId, state.intent.permissionDecisionId, state.intent.authoritySessionId, state.approvalVerifierId, state.issueLifecycleId, state.issueOperationId, state.issueReceiptId, terminal.lifecycleId, terminal.operationId, terminal.receiptId, indexes[0].indexRecordId, indexes[1].indexRecordId]); const operations = [input.operationId, input.claimOperationId, input.runOperationId, input.runRecordedOperationId, input.createOperationId]; if (operations.some((value) => hidden.has(value))) throw failed(); }
function canonicalEvent(value: DurableJournalEvent): object { return { schemaVersion: value.schemaVersion, id: value.id, spaceId: value.spaceId, runId: value.runId, runRevision: value.runRevision, sequence: value.sequence, kind: value.kind, runCiphertextSha256: value.runCiphertextSha256, effectId: value.effectId, effectRevision: value.effectRevision, effectState: value.effectState, claimSha256: value.claimSha256 }; }
function canonicalEffect(value: DurableEffect): object { return { schemaVersion: value.schemaVersion, id: value.id, spaceId: value.spaceId, runId: value.runId, runRevision: value.runRevision, stepKey: value.stepKey, requestSha256: value.requestSha256, state: value.state, effectRevision: value.effectRevision, claimId: value.claimId }; }
function result(event: DurableJournalEvent, effect: DurableEffect, capability: CapabilityJournalState): ClaimedEffectPreExecutionAbandonmentResultForTestOnly { const { claimId: _claimId, ...redacted } = effect; return deepFreeze({ event: JSON.parse(JSON.stringify(event)) as DurableJournalEvent, effect: redacted, authorization: { grantId: capability.grantId, intentSha256: capability.intentSha256, effectKind: capability.intent.effectKind, terminalOperationId: capability.terminal!.operationId, lifecycle: "consumed" as const }, abandonment: "before-execution" as const, effectExecution: "not-performed" as const }); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function wipeImage(image: InMemoryWorkStoreImage | undefined): void { image?.envelopes.forEach((entry) => entry.ciphertext.fill(0)); }
function collectIds(value: unknown): string[] { const output: string[] = []; const visit = (item: unknown, depth: number): void => { if (depth > 32) throw failed(); if (typeof item === "string") { if (id(item)) output.push(item); return; } if (item !== null && typeof item === "object") for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1); }; visit(value, 0); return output; }
function capture(value: unknown): unknown { const budget = { nodes: 0, strings: 0 }; const seen = new Set<object>(); const visit = (item: unknown, depth: number): unknown => { if (item === null || typeof item === "boolean" || typeof item === "number") return item; if (typeof item === "string") { if ((budget.strings += item.length) > 1_048_576) throw failed(); return item; } if (typeof item !== "object" || types.isProxy(item) || Object.getPrototypeOf(item) !== Object.prototype || seen.has(item) || depth >= 32 || ++budget.nodes > 2_048) throw failed(); seen.add(item); try { const keys = Reflect.ownKeys(item); if (keys.length > 64 || keys.some((key) => typeof key !== "string")) throw failed(); const output: Record<string, unknown> = {}; for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(item, key); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw failed(); output[key as string] = visit(descriptor.value, depth + 1); } return output; } finally { seen.delete(item); } }; return visit(value, 0); }
function failed(): AsyncTransactionalClaimedEffectPreExecutionAbandonmentError { return new AsyncTransactionalClaimedEffectPreExecutionAbandonmentError(); }
