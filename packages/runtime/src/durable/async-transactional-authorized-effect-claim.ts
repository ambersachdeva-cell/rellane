import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { type CapabilityJournalState } from "@cadrane/contracts/capability-journal";
import { DurableEffectSchema, DurableJournalEventSchema, type DurableEffect, type DurableJournalEvent, type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import { canonicalCapabilityIntentSha256 } from "../capability-intent-binding.js";
import { validateCapabilityJournalBundle } from "../capability-journal-codec.js";
import { decodeOwnedCapabilityJournalStorageBundle } from "../capability-journal-storage-codec.js";
import { prepareCapabilityGrantIndexes } from "../capability-grant-index.js";
import { inertEventEffectOperationBindingSha256ForTestOnly } from "./async-transactional-event-effect-journal.js";
import { type AsyncTransactionalPersistencePortForTestOnly } from "./async-transactional-persistence-filesystem-port.js";
import { EncryptedWorkStore, type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { InMemoryWorkStore, type InMemoryWorkStoreImage } from "./in-memory-work-store.js";
import { enqueueTransactionalPortOperation } from "./transactional-port-queue.js";
import { TransactionalPersistenceError, disposeOpaqueJournalSnapshotForTestOnly, operationBindingSha256ForDurableRecordSetForTestOnly, restoreInMemoryWorkStoreFromSnapshotForTestOnly, snapshotFromInMemoryWorkStoreForTestOnly, validateRecoveredTransactionalStateForTestOnly, type OpaqueJournalSnapshot, type RecoveredTransactionalState, type TransactionReceipt } from "./transactional-persistence.js";

const HASH = /^[a-f0-9]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PROBE_CLAIM_ID = "00000000-0000-4000-8000-000000000001";

export interface AuthorizedEffectClaimResultForTestOnly {
  readonly event: DurableJournalEvent;
  readonly effect: Omit<DurableEffect, "claimId">;
  readonly authorization: Readonly<{ grantId: string; intentSha256: string; effectKind: "export-artifact" | "delete-record"; terminalOperationId: string; lifecycle: "consumed" }>;
  readonly effectExecution: "not-performed";
}

export class AsyncTransactionalAuthorizedEffectClaimError extends Error {
  readonly code = "ASYNC_TRANSACTIONAL_AUTHORIZED_EFFECT_CLAIM_FAILED" as const;
  constructor() { super("Async transactional authorized effect claim failed."); this.name = "AsyncTransactionalAuthorizedEffectClaimError"; }
}

interface Owned {
  readonly operationId: string; readonly runOperationId: string; readonly runRecordedOperationId: string; readonly createOperationId: string;
  readonly pendingEffect: DurableEffect; readonly consumedAuthorization: ConsumedAuthorizationLocator;
}
interface ConsumedAuthorizationLocator { readonly grantRecordId: string; readonly issueOperationId: string; readonly issueReceiptRecordId: string; readonly requestIndexRecordId: string; readonly decisionIndexRecordId: string; readonly consumedOperationId: string; readonly consumedReceiptRecordId: string; }
interface Prerequisites {
  readonly runOperationId: string; readonly runOperationBindingSha256: string; readonly runRecordedOperationId: string;
  readonly runRecordedOperationBindingSha256: string; readonly createOperationId: string; readonly createOperationBindingSha256: string;
  readonly issueOperationId: string; readonly issueOperationBindingSha256: string; readonly terminalOperationId: string; readonly terminalOperationBindingSha256: string;
  readonly authorizationUseAt: string;
}
interface B1Prerequisites { readonly runOperationId: string; readonly runOperationBindingSha256: string; readonly runRecordedOperationId: string; readonly runRecordedOperationBindingSha256: string; readonly createOperationId: string; readonly createOperationBindingSha256: string; }
interface Chain { readonly pending: DurableEffect; readonly claimed: DurableEffect; readonly event: DurableJournalEvent; readonly prerequisites: Prerequisites; readonly binding: string; }

/**
 * Private/test-only reservation seam. It writes an inert durable claim only
 * and never exposes the internal claim token.
 */
export class AsyncTransactionalAuthorizedEffectClaimForTestOnly {
  private readonly identity: object;

  constructor(
    private readonly port: AsyncTransactionalPersistencePortForTestOnly,
    private readonly keys: WorkspaceKeyProvider,
  ) {
    try {
      const identity = port.concurrencyIdentity;
      if (identity === null || typeof identity !== "object" || types.isProxy(identity)) throw failed();
      this.identity = identity;
    } catch { throw failed(); }
  }

  async claim(input: unknown): Promise<AuthorizedEffectClaimResultForTestOnly> {
    let owned: Owned | undefined;
    try { owned = parse(input); return await enqueueTransactionalPortOperation(this.identity, () => this.claimOwned(owned!)); }
    catch { throw failed(); }
  }

  /** Alias retained for an adjacent focused test; it grants no additional authority. */
  async claimAuthorizedEffect(input: unknown): Promise<AuthorizedEffectClaimResultForTestOnly> { return this.claim(input); }

  private async claimOwned(input: Owned): Promise<AuthorizedEffectClaimResultForTestOnly> {
    let raw: RecoveredTransactionalState | undefined; let recovered: RecoveredTransactionalState | undefined;
    let store: InMemoryWorkStore | undefined; let bridge: InMemoryWorkStoreImage | undefined; let deterministic: InMemoryWorkStore | undefined;
    let staged: OpaqueJournalSnapshot | undefined; let verifiedRaw: RecoveredTransactionalState | undefined; let verified: RecoveredTransactionalState | undefined; let verifier: InMemoryWorkStore | undefined;
    try {
      ({ raw, validated: recovered } = await recover(this.port));
      const b1 = await deriveB1Preconditions(this.port, recovered!, input);
      const current = effectById(recovered!, input.pendingEffect.id); const existingEvent = eventById(recovered!, input.operationId);
      if (current?.state === "claimed" || existingEvent !== undefined) {
        if (current === undefined || existingEvent === undefined) throw failed();
        assertReplayShape(recovered!, input, current, existingEvent);
        if (await this.port.recoverOperationBinding(input.operationId) === undefined) throw failed();
        const capability = await authenticateCapability(this.port, this.keys, recovered!, input); const pre = completePrerequisites(b1, capability);
        const adopted = deriveClaimed(recovered!, input, capability, pre, current, existingEvent);
        assertExactClaimedState(recovered!, input, pre, adopted);
        await requireBinding(this.port, input.operationId, adopted.binding);
        return result(adopted.event, adopted.claimed, capability.state);
      }
      if (current === undefined || !same(current, input.pendingEffect) || await this.port.recoverOperationBinding(input.operationId) !== undefined) throw failed();
      assertExactPendingPrestate(recovered!, input, b1);
      const capability = await authenticateCapability(this.port, this.keys, recovered!, input); const pre = completePrerequisites(b1, capability);

      store = restoreInMemoryWorkStoreFromSnapshotForTestOnly(recovered!.snapshot); bridge = store.exportImageForTestOnly();
      let claimCalls = 0; let eventCalls = 0; const identities = identitySet(recovered!, input, capability.state);
      deterministic = new InMemoryWorkStore(() => {
        if (++claimCalls !== 1) throw failed(); const token = randomUUID();
        if (typeof token !== "string" || !UUID_V4.test(token) || identities.has(token)) throw failed(); return token;
      }, () => { if (++eventCalls !== 1) throw failed(); return input.operationId; });
      deterministic.restoreImageForTestOnly(bridge); wipeImage(bridge); bridge = undefined; store.disposeForTestOnly(); store = undefined;
      const claimed = deterministic.claimEffect(input.pendingEffect.spaceId, input.pendingEffect.id, 1);
      if (claimCalls !== 1 || eventCalls !== 1 || claimed.state !== "claimed" || claimed.effectRevision !== 2 || claimed.claimId === null) throw failed();
      const next = deterministic.exportImageForTestOnly();
      let chain: Chain;
      try {
        const event = next.metadata.events.find((item) => item.id === input.operationId);
        if (event === undefined) throw failed(); chain = deriveClaimed(recovered!, input, capability, pre, claimed, event, [claimed.claimId]);
        assertClaimedSuccessor(next, input, pre, chain);
      } finally { wipeImage(next); }
      staged = snapshotFromInMemoryWorkStoreForTestOnly(deterministic);
      const receipt = await commitOnce(this.port, Object.freeze({ commitId: input.operationId, expectedGeneration: recovered!.generation, expectedSnapshotSha256: recovered!.snapshotSha256, operationBindingSha256: chain!.binding, snapshot: staged }), input.operationId, recovered!.generation + 1);
      ({ raw: verifiedRaw, validated: verified } = await recover(this.port));
      if (verified!.generation !== receipt.generation || verified!.snapshotSha256 !== receipt.snapshotSha256) throw failed();
      const verifiedB1 = await deriveB1Preconditions(this.port, verified!, input);
      if (await this.port.recoverOperationBinding(input.operationId) === undefined) throw failed();
      const verifiedCapability = await authenticateCapability(this.port, this.keys, verified!, input); const verifiedPre = completePrerequisites(verifiedB1, verifiedCapability);
      const verifiedEffect = effectById(verified!, input.pendingEffect.id); const verifiedEvent = eventById(verified!, input.operationId);
      if (verifiedEffect === undefined || verifiedEvent === undefined) throw failed();
      const adopted = deriveClaimed(verified!, input, verifiedCapability, verifiedPre, verifiedEffect, verifiedEvent);
      assertExactClaimedState(verified!, input, verifiedPre, adopted);
      if (adopted.binding !== chain!.binding) throw failed(); await requireBinding(this.port, input.operationId, adopted.binding);
      verifier = restoreInMemoryWorkStoreFromSnapshotForTestOnly(verified!.snapshot);
      return result(adopted.event, adopted.claimed, verifiedCapability.state);
    } catch { throw failed(); }
    finally {
      store?.disposeForTestOnly(); deterministic?.disposeForTestOnly(); verifier?.disposeForTestOnly(); wipeImage(bridge);
      disposeOpaqueJournalSnapshotForTestOnly(raw?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(recovered?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(staged);
      disposeOpaqueJournalSnapshotForTestOnly(verifiedRaw?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(verified?.snapshot);
    }
  }
}

/** Stable private receipt binding for the one inert reservation transition. */
export function authorizedEffectClaimTargetBindingSha256ForTestOnly(value: unknown): string {
  try {
    const raw = exact(value, ["operationId", "prerequisites", "consumedCapabilityBundleSha256", "pendingEffect", "claimedEffect", "issuedClaimDelta", "event", "effectExecution"]);
    if (raw === undefined || !id(raw.operationId) || !hash(raw.consumedCapabilityBundleSha256)) throw failed();
    const prerequisites = parsePrerequisites(capture(raw.prerequisites)); const pending = copyEffect(capture(raw.pendingEffect)); const claimed = copyRedactedClaimedEffect(capture(raw.claimedEffect)); const event = copyEvent(capture(raw.event));
    if (pending.state !== "pending" || pending.effectRevision !== 1 || pending.claimId !== null || claimed.state !== "claimed" || claimed.effectRevision !== 2 || !sameRedactedTuple(pending, claimed) || event.id !== raw.operationId || event.kind !== "effect-claimed" || event.spaceId !== claimed.spaceId || event.runId !== claimed.runId || event.runRevision !== claimed.runRevision || event.sequence !== 3 || event.effectId !== claimed.id || event.effectRevision !== 2 || event.effectState !== "claimed" || event.claimSha256 !== claimed.claimSha256) throw failed();
    const delta = exact(capture(raw.issuedClaimDelta), ["effectId", "claimSha256"]); if (delta === undefined || delta.effectId !== claimed.id || delta.claimSha256 !== claimed.claimSha256 || !hash(delta.claimSha256)) throw failed();
    if (raw.effectExecution !== "not-performed") throw failed();
    return createHash("sha256").update(`async-transactional-authorized-effect-claim:v1:${JSON.stringify({ operationId: raw.operationId, prerequisites, consumedCapabilityBundleSha256: raw.consumedCapabilityBundleSha256, pendingEffect: canonicalEffect(pending), claimedEffect: claimed, issuedClaimDelta: { effectId: claimed.id, claimSha256: claimed.claimSha256 }, event: canonicalEvent(event), effectExecution: "not-performed" })}`).digest("hex");
  } catch { throw failed(); }
}

async function authenticateCapability(port: AsyncTransactionalPersistencePortForTestOnly, keys: WorkspaceKeyProvider, state: RecoveredTransactionalState, input: Owned): Promise<{ readonly state: CapabilityJournalState; readonly digest: string; readonly issueBinding: string; readonly terminalBinding: string }> {
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
  const expectedIndexes = prepareCapabilityGrantIndexes({ state: bundle.predecessor.state, receipt: bundle.predecessor.receipt, predecessor: null });
  if (bundle.state.grantRecordId !== locator.grantRecordId || bundle.predecessor.state.grantRecordId !== locator.grantRecordId || bundle.predecessor.state.issueOperationId !== locator.issueOperationId || bundle.predecessor.state.issueReceiptId !== locator.issueReceiptRecordId || expectedIndexes[0].indexRole !== "request" || expectedIndexes[0].indexRecordId !== locator.requestIndexRecordId || expectedIndexes[1].indexRole !== "decision" || expectedIndexes[1].indexRecordId !== locator.decisionIndexRecordId || terminal.operationId !== locator.consumedOperationId || terminal.receiptId !== locator.consumedReceiptRecordId) throw failed();
  assertCrossChainIdentityRoles(input, bundle, expectedIndexes);
  return Object.freeze({ state: bundle.state, digest: capabilityDigest(bundle), issueBinding, terminalBinding });
}

async function decryptBundle(store: InMemoryWorkStore, keys: WorkspaceKeyProvider, spaceId: string, keyId: string, issued: readonly DurableJournalRecord[], terminal: readonly DurableJournalRecord[]): Promise<ReturnType<typeof validateCapabilityJournalBundle>> {
  const plaintext: Uint8Array[] = []; let decoded: ReturnType<typeof decodeOwnedCapabilityJournalStorageBundle> | undefined;
  try {
    const facade = new EncryptedWorkStore(store, keys);
    const read = async (recordValue: DurableJournalRecord) => {
      if (recordValue.spaceId !== spaceId || recordValue.envelope.keyId !== keyId || recordValue.idempotency.kind !== "entity") throw failed();
      const bytes = await facade.read({ spaceId, keyId, id: recordValue.id, recordRevision: recordValue.recordRevision }); plaintext.push(bytes); return bytes;
    };
    const current = { state: { entityKind: "capability-grant" as const, id: terminal[0]!.id, recordRevision: 2 as const, plaintext: await read(terminal[0]!) }, receipt: { entityKind: "capability-grant-receipt" as const, id: terminal[1]!.id, recordRevision: 1 as const, plaintext: await read(terminal[1]!) }, indexes: [] as const };
    const predecessor = { state: { entityKind: "capability-grant" as const, id: issued[0]!.id, recordRevision: 1 as const, plaintext: await read(issued[0]!) }, receipt: { entityKind: "capability-grant-receipt" as const, id: issued[1]!.id, recordRevision: 1 as const, plaintext: await read(issued[1]!) }, indexes: [{ entityKind: "capability-grant-index" as const, id: issued[2]!.id, recordRevision: 1 as const, plaintext: await read(issued[2]!) }, { entityKind: "capability-grant-index" as const, id: issued[3]!.id, recordRevision: 1 as const, plaintext: await read(issued[3]!) }] as const };
    decoded = decodeOwnedCapabilityJournalStorageBundle({ current, predecessor }); return decoded.bundle;
  } finally { plaintext.forEach((bytes) => bytes.fill(0)); }
}

async function deriveB1Preconditions(port: AsyncTransactionalPersistencePortForTestOnly, state: RecoveredTransactionalState, input: Owned): Promise<B1Prerequisites> {
  const run = record(state, input.pendingEffect.runId, input.pendingEffect.runRevision, "run");
  if (run.spaceId !== input.pendingEffect.spaceId || run.idempotency.kind !== "run") throw failed();
  const runBinding = operationBindingSha256ForDurableRecordSetForTestOnly([run]); await requireBinding(port, input.runOperationId, runBinding);
  const anchor = eventById(state, input.runRecordedOperationId); const created = eventById(state, input.createOperationId);
  if (anchor === undefined || anchor.kind !== "run-recorded" || anchor.sequence !== 1 || anchor.spaceId !== input.pendingEffect.spaceId || anchor.runId !== input.pendingEffect.runId || anchor.runRevision !== input.pendingEffect.runRevision || anchor.runCiphertextSha256 !== run.envelope.ciphertextSha256 || anchor.effectId !== null || anchor.effectRevision !== null || anchor.effectState !== null || anchor.claimSha256 !== null) throw failed();
  const anchorBinding = inertEventEffectOperationBindingSha256ForTestOnly("record-run", input.runRecordedOperationId, anchor, null, { runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, anchorOperationId: null, anchorOperationBindingSha256: null }); await requireBinding(port, input.runRecordedOperationId, anchorBinding);
  if (created === undefined || created.kind !== "effect-created" || created.sequence !== 2 || created.spaceId !== input.pendingEffect.spaceId || created.runId !== input.pendingEffect.runId || created.runRevision !== input.pendingEffect.runRevision || created.runCiphertextSha256 !== run.envelope.ciphertextSha256 || created.effectId !== input.pendingEffect.id || created.effectRevision !== 1 || created.effectState !== "pending" || created.claimSha256 !== null) throw failed();
  const createBinding = inertEventEffectOperationBindingSha256ForTestOnly("create-pending-effect", input.createOperationId, created, input.pendingEffect, { runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, anchorOperationId: input.runRecordedOperationId, anchorOperationBindingSha256: anchorBinding }); await requireBinding(port, input.createOperationId, createBinding);
  return Object.freeze({ runOperationId: input.runOperationId, runOperationBindingSha256: runBinding, runRecordedOperationId: input.runRecordedOperationId, runRecordedOperationBindingSha256: anchorBinding, createOperationId: input.createOperationId, createOperationBindingSha256: createBinding });
}
function completePrerequisites(b1: B1Prerequisites, capability: { state: CapabilityJournalState; issueBinding: string; terminalBinding: string }): Prerequisites { return Object.freeze({ ...b1, issueOperationId: capability.state.issueOperationId, issueOperationBindingSha256: capability.issueBinding, terminalOperationId: capability.state.terminal!.operationId, terminalOperationBindingSha256: capability.terminalBinding, authorizationUseAt: capability.state.lastTransitionAt }); }

function deriveClaimed(state: RecoveredTransactionalState, input: Owned, capability: { state: CapabilityJournalState; digest: string }, pre: Prerequisites, claimed: DurableEffect, event: DurableJournalEvent, issuedDelta: readonly string[] = claimDelta(state, claimed.id)): Chain {
  if (claimed.state !== "claimed" || claimed.effectRevision !== 2 || claimed.claimId === null || !sameTuple(input.pendingEffect, claimed)) throw failed();
  const expectedEvent = DurableJournalEventSchema.parse({ schemaVersion: 1, id: input.operationId, spaceId: claimed.spaceId, runId: claimed.runId, runRevision: claimed.runRevision, sequence: 3, kind: "effect-claimed", runCiphertextSha256: record(state, claimed.runId, claimed.runRevision, "run").envelope.ciphertextSha256, effectId: claimed.id, effectRevision: 2, effectState: "claimed", claimSha256: claimHash(claimed.claimId) });
  if (!same(event, expectedEvent)) throw failed();
  const delta = issuedDelta; if (delta.length !== 1 || delta[0] !== claimed.claimId) throw failed();
  const claimSha256 = claimHash(claimed.claimId); const binding = authorizedEffectClaimTargetBindingSha256ForTestOnly({ operationId: input.operationId, prerequisites: pre, consumedCapabilityBundleSha256: capability.digest, pendingEffect: input.pendingEffect, claimedEffect: redactedClaimedEffect(claimed, claimSha256), issuedClaimDelta: { effectId: claimed.id, claimSha256 }, event, effectExecution: "not-performed" });
  return Object.freeze({ pending: input.pendingEffect, claimed, event: expectedEvent, prerequisites: pre, binding });
}

function assertExactPendingPrestate(state: RecoveredTransactionalState, input: Owned, _pre: B1Prerequisites): void {
  const current = effectById(state, input.pendingEffect.id); const runEvents = state.snapshot.journal.events.filter((item) => item.runId === input.pendingEffect.runId); const effectEvents = state.snapshot.journal.events.filter((item) => item.effectId === input.pendingEffect.id);
  if (current === undefined || !same(current, input.pendingEffect) || state.snapshot.issuedClaims.some((item) => item.claimIds.length !== 0) || runEvents.length !== 2 || runEvents[0]?.id !== input.runRecordedOperationId || runEvents[1]?.id !== input.createOperationId || effectEvents.length !== 1 || effectEvents[0]?.id !== input.createOperationId) throw failed();
}

function assertClaimedSuccessor(image: InMemoryWorkStoreImage, input: Owned, pre: Prerequisites, chain: Chain): void {
  const events = image.metadata.events.filter((item) => item.runId === input.pendingEffect.runId); const effect = image.metadata.effects.find((item) => item.id === input.pendingEffect.id); const issued = image.issuedClaims.find((item) => item.effectId === input.pendingEffect.id);
  if (effect === undefined || !same(effect, chain.claimed) || events.length !== 3 || events[0]?.id !== input.runRecordedOperationId || events[1]?.id !== input.createOperationId || !same(events[2], chain.event) || issued === undefined || issued.claimIds.length !== 1 || issued.claimIds[0] !== chain.claimed.claimId || pre.runOperationId === input.operationId) throw failed();
}

function assertExactClaimedState(state: RecoveredTransactionalState, input: Owned, pre: Prerequisites, chain: Chain): void { const runEvents = state.snapshot.journal.events.filter((item) => item.runId === input.pendingEffect.runId); const effectEvents = state.snapshot.journal.events.filter((item) => item.effectId === input.pendingEffect.id); const allClaims = state.snapshot.issuedClaims.flatMap((item) => item.claimIds); if (runEvents.length !== 3 || runEvents[0]?.id !== input.runRecordedOperationId || runEvents[1]?.id !== input.createOperationId || !same(runEvents[2], chain.event) || effectEvents.length !== 2 || effectEvents[0]?.id !== input.createOperationId || !same(effectEvents[1], chain.event) || allClaims.length !== 1 || allClaims[0] !== chain.claimed.claimId || pre.terminalOperationId === input.operationId) throw failed(); }
function assertReplayShape(state: RecoveredTransactionalState, input: Owned, effect: DurableEffect, event: DurableJournalEvent): void { const runEvents = state.snapshot.journal.events.filter((item) => item.runId === input.pendingEffect.runId); const effectEvents = state.snapshot.journal.events.filter((item) => item.effectId === input.pendingEffect.id); const claims = state.snapshot.issuedClaims.flatMap((item) => item.claimIds); if (effect.state !== "claimed" || effect.effectRevision !== 2 || effect.claimId === null || !sameTuple(input.pendingEffect, effect) || event.id !== input.operationId || event.kind !== "effect-claimed" || event.spaceId !== input.pendingEffect.spaceId || event.runId !== input.pendingEffect.runId || event.runRevision !== input.pendingEffect.runRevision || event.sequence !== 3 || event.effectId !== input.pendingEffect.id || event.effectRevision !== 2 || event.effectState !== "claimed" || event.claimSha256 !== claimHash(effect.claimId) || runEvents.length !== 3 || effectEvents.length !== 2 || claims.length !== 1 || claims[0] !== effect.claimId) throw failed(); }


function parse(value: unknown): Owned {
  const raw = exact(value, ["operationId", "runOperationId", "runRecordedOperationId", "createOperationId", "pendingEffect", "consumedAuthorization"]);
  if (raw === undefined || !id(raw.operationId) || !id(raw.runOperationId) || !id(raw.runRecordedOperationId) || !id(raw.createOperationId)) throw failed();
  const pendingEffect = copyEffect(capture(raw.pendingEffect)); const consumedAuthorization = parseConsumedAuthorization(raw.consumedAuthorization);
  if (pendingEffect.state !== "pending" || pendingEffect.effectRevision !== 1 || pendingEffect.claimId !== null) throw failed();
  const operations = [raw.operationId as string, raw.runOperationId as string, raw.runRecordedOperationId as string, raw.createOperationId as string]; const identities = [...collectIds(pendingEffect), ...collectIds(consumedAuthorization)];
  if (new Set(operations).size !== operations.length || operations.some((operation) => identities.includes(operation))) throw failed();
  return Object.freeze({ operationId: raw.operationId as string, runOperationId: raw.runOperationId as string, runRecordedOperationId: raw.runRecordedOperationId as string, createOperationId: raw.createOperationId as string, pendingEffect, consumedAuthorization });
}

async function recover(port: AsyncTransactionalPersistencePortForTestOnly): Promise<{ raw: RecoveredTransactionalState; validated: RecoveredTransactionalState }> { let raw: RecoveredTransactionalState | undefined; let validated: RecoveredTransactionalState | undefined; try { raw = await port.recover(); validated = validateRecoveredTransactionalStateForTestOnly(raw); return { raw, validated }; } catch { disposeOpaqueJournalSnapshotForTestOnly(raw?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(validated?.snapshot); throw failed(); } }
async function requireBinding(port: AsyncTransactionalPersistencePortForTestOnly, operationId: string, expected: string): Promise<void> { try { const raw = exact(await port.recoverOperationBinding(operationId), ["commitId", "operationBindingSha256"]); if (raw === undefined || raw.commitId !== operationId || raw.operationBindingSha256 !== expected || !hash(raw.operationBindingSha256)) throw failed(); } catch { throw failed(); } }
async function commitOnce(port: AsyncTransactionalPersistencePortForTestOnly, request: unknown, operationId: string, generation: number): Promise<TransactionReceipt> { try { return receipt(await port.commit(request), operationId, generation); } catch (error) { if (!(error instanceof TransactionalPersistenceError) || error.code !== "INTERRUPTED") throw error; return receipt(await port.commit(request), operationId, generation); } }
function receipt(value: unknown, operationId: string, generation: number): TransactionReceipt { const raw = exact(value, ["commitId", "generation", "snapshotSha256"]); if (raw === undefined || raw.commitId !== operationId || raw.generation !== generation || !hash(raw.snapshotSha256)) throw failed(); return Object.freeze({ commitId: operationId, generation, snapshotSha256: raw.snapshotSha256 as string }); }
function record(state: RecoveredTransactionalState, idValue: string, revision: number, kind: string): DurableJournalRecord { const found = state.snapshot.journal.records.find((item) => item.id === idValue && item.recordRevision === revision); if (found === undefined || found.envelope.entityKind !== kind) throw failed(); return found; }
function capabilityRecord(state: RecoveredTransactionalState, idValue: string, revision: number, kind: "capability-grant" | "capability-grant-receipt" | "capability-grant-index"): DurableJournalRecord { const matches = state.snapshot.journal.records.filter((item) => item.id === idValue && item.recordRevision === revision); if (matches.length !== 1) throw failed(); const found = matches[0]!; if (found.idempotency.kind !== "entity" || found.envelope.entityKind !== kind || found.envelope.entityId !== idValue || found.envelope.spaceId !== found.spaceId || found.envelope.contentRevision !== revision || found.envelope.kind !== "payload") throw failed(); return found; }
function eventById(state: RecoveredTransactionalState, value: string): DurableJournalEvent | undefined { return state.snapshot.journal.events.find((item) => item.id === value); }
function effectById(state: RecoveredTransactionalState, value: string): DurableEffect | undefined { return state.snapshot.journal.effects.find((item) => item.id === value); }
function claimDelta(state: RecoveredTransactionalState, effectId: string): readonly string[] { const item = state.snapshot.issuedClaims.find((entry) => entry.effectId === effectId); return item === undefined ? [] : item.claimIds; }
function capabilityDigest(value: ReturnType<typeof validateCapabilityJournalBundle>): string { return createHash("sha256").update("authorized-effect-claim-consumed-capability:v1:" + JSON.stringify(value)).digest("hex"); }
function claimHash(value: string): string { return createHash("sha256").update(value, "ascii").digest("hex"); }
function sameTuple(left: DurableEffect, right: DurableEffect): boolean { return left.id === right.id && left.spaceId === right.spaceId && left.runId === right.runId && left.runRevision === right.runRevision && left.stepKey === right.stepKey && left.requestSha256 === right.requestSha256; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function id(value: unknown): value is string { return CanonicalDurableIdSchema.safeParse(value).success; }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined { try { if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined; const keys = Reflect.ownKeys(value); if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) return undefined; const out: Record<string, unknown> = {}; for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined; out[field] = descriptor.value; } return out; } catch { return undefined; } }
function copyEffect(value: unknown): DurableEffect { const parsed = DurableEffectSchema.safeParse(value); if (!parsed.success) throw failed(); return parsed.data; }
function copyEvent(value: unknown): DurableJournalEvent { const parsed = DurableJournalEventSchema.safeParse(value); if (!parsed.success) throw failed(); return parsed.data; }
function copyRedactedClaimedEffect(value: unknown): Omit<DurableEffect, "claimId"> & { readonly claimSha256: string } { const raw = exact(value, ["schemaVersion", "id", "spaceId", "runId", "runRevision", "stepKey", "requestSha256", "state", "effectRevision", "claimSha256"]); if (raw === undefined || !hash(raw.claimSha256)) throw failed(); const { claimSha256, ...effect } = raw; const parsed = DurableEffectSchema.safeParse({ ...effect, claimId: PROBE_CLAIM_ID }); if (!parsed.success || parsed.data.state !== "claimed" || parsed.data.effectRevision !== 2) throw failed(); const { claimId: _claimId, ...redacted } = parsed.data; return Object.freeze({ ...redacted, claimSha256: claimSha256 as string }); }
function redactedClaimedEffect(value: DurableEffect, claimSha256: string): Omit<DurableEffect, "claimId"> & { readonly claimSha256: string } { const { claimId: _claimId, ...redacted } = value; return Object.freeze({ ...redacted, claimSha256 }); }
function parseConsumedAuthorization(value: unknown): ConsumedAuthorizationLocator { const raw = exact(value, ["grantRecordId", "issueOperationId", "issueReceiptRecordId", "requestIndexRecordId", "decisionIndexRecordId", "consumedOperationId", "consumedReceiptRecordId"]); if (raw === undefined || !id(raw.grantRecordId) || !id(raw.issueOperationId) || !id(raw.issueReceiptRecordId) || !id(raw.requestIndexRecordId) || !id(raw.decisionIndexRecordId) || !id(raw.consumedOperationId) || !id(raw.consumedReceiptRecordId) || new Set(Object.values(raw)).size !== 7) throw failed(); return Object.freeze(raw as unknown as ConsumedAuthorizationLocator); }
function assertCrossChainIdentityRoles(input: Owned, bundle: ReturnType<typeof validateCapabilityJournalBundle>, indexes: readonly [{ readonly indexRecordId: string }, { readonly indexRecordId: string }]): void { const state = bundle.state; const prior = bundle.predecessor?.state; const terminal = state.terminal; if (prior === undefined || terminal === null) throw failed(); const protectedIds = new Set([state.grantRecordId, state.grantId, state.intent.permissionRequestId, state.intent.permissionDecisionId, state.intent.authoritySessionId, state.approvalVerifierId, state.issueLifecycleId, state.issueOperationId, state.issueReceiptId, terminal.lifecycleId, terminal.operationId, terminal.receiptId, indexes[0].indexRecordId, indexes[1].indexRecordId]); const operations = [input.operationId, input.runOperationId, input.runRecordedOperationId, input.createOperationId]; if (operations.some((value) => protectedIds.has(value))) throw failed(); }
function parsePrerequisites(value: unknown): Prerequisites { const raw = exact(value, ["runOperationId", "runOperationBindingSha256", "runRecordedOperationId", "runRecordedOperationBindingSha256", "createOperationId", "createOperationBindingSha256", "issueOperationId", "issueOperationBindingSha256", "terminalOperationId", "terminalOperationBindingSha256", "authorizationUseAt"]); if (raw === undefined || !id(raw.runOperationId) || !hash(raw.runOperationBindingSha256) || !id(raw.runRecordedOperationId) || !hash(raw.runRecordedOperationBindingSha256) || !id(raw.createOperationId) || !hash(raw.createOperationBindingSha256) || !id(raw.issueOperationId) || !hash(raw.issueOperationBindingSha256) || !id(raw.terminalOperationId) || !hash(raw.terminalOperationBindingSha256) || typeof raw.authorizationUseAt !== "string" || !ISO.test(raw.authorizationUseAt) || !Number.isFinite(Date.parse(raw.authorizationUseAt)) || new Date(raw.authorizationUseAt).toISOString() !== raw.authorizationUseAt) throw failed(); return Object.freeze(raw as unknown as Prerequisites); }
function canonicalEvent(value: DurableJournalEvent): object { return { schemaVersion: value.schemaVersion, id: value.id, spaceId: value.spaceId, runId: value.runId, runRevision: value.runRevision, sequence: value.sequence, kind: value.kind, runCiphertextSha256: value.runCiphertextSha256, effectId: value.effectId, effectRevision: value.effectRevision, effectState: value.effectState, claimSha256: value.claimSha256 }; }
function canonicalEffect(value: DurableEffect): object { return { schemaVersion: value.schemaVersion, id: value.id, spaceId: value.spaceId, runId: value.runId, runRevision: value.runRevision, stepKey: value.stepKey, requestSha256: value.requestSha256, state: value.state, effectRevision: value.effectRevision, claimId: value.claimId }; }
function sameRedactedTuple(left: DurableEffect, right: Omit<DurableEffect, "claimId"> & { readonly claimSha256: string }): boolean { return left.id === right.id && left.spaceId === right.spaceId && left.runId === right.runId && left.runRevision === right.runRevision && left.stepKey === right.stepKey && left.requestSha256 === right.requestSha256; }
function result(event: DurableJournalEvent, effect: DurableEffect, capability: CapabilityJournalState): AuthorizedEffectClaimResultForTestOnly { const { claimId: _claimId, ...redacted } = effect; return deepFreeze({ event: JSON.parse(JSON.stringify(event)) as DurableJournalEvent, effect: redacted, authorization: { grantId: capability.grantId, intentSha256: capability.intentSha256, effectKind: capability.intent.effectKind, terminalOperationId: capability.terminal!.operationId, lifecycle: "consumed" as const }, effectExecution: "not-performed" as const }); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function wipeImage(image: InMemoryWorkStoreImage | undefined): void { image?.envelopes.forEach((entry) => entry.ciphertext.fill(0)); }
function collectIds(value: unknown): string[] { const output: string[] = []; const visit = (item: unknown, depth: number): void => { if (depth > 32) throw failed(); if (typeof item === "string") { if (id(item)) output.push(item); return; } if (item !== null && typeof item === "object") for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1); }; visit(value, 0); return output; }
function identitySet(state: RecoveredTransactionalState, input: Owned, capability: CapabilityJournalState): Set<string> { return new Set([...collectIds(state.snapshot.journal), ...state.snapshot.issuedClaims.flatMap((item) => [item.effectId, ...item.claimIds]), ...collectIds(input), ...collectIds(capability)]); }
function capture(value: unknown): unknown { const budget = { nodes: 0, strings: 0 }; const seen = new Set<object>(); const visit = (item: unknown, depth: number): unknown => { if (item === null || typeof item === "boolean" || typeof item === "number") return item; if (typeof item === "string") { if ((budget.strings += item.length) > 1_048_576) throw failed(); return item; } if (typeof item !== "object" || types.isProxy(item) || Object.getPrototypeOf(item) !== Object.prototype || seen.has(item) || depth >= 32 || ++budget.nodes > 2_048) throw failed(); seen.add(item); try { const keys = Reflect.ownKeys(item); if (keys.length > 64 || keys.some((key) => typeof key !== "string")) throw failed(); const output: Record<string, unknown> = {}; for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(item, key); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw failed(); output[key as string] = visit(descriptor.value, depth + 1); } return output; } finally { seen.delete(item); } }; return visit(value, 0); }
function failed(): AsyncTransactionalAuthorizedEffectClaimError { return new AsyncTransactionalAuthorizedEffectClaimError(); }
