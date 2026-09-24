import {
  InMemoryTransactionalPersistenceMedium,
  TransactionalPersistenceError,
  captureTransactionCommitInputForAsyncFilesystemPortForTestOnly,
  disposeOpaqueJournalSnapshotForTestOnly,
  transactionCommitRequestSha256ForTestOnly,
  validateRecoveredTransactionalStateForTestOnly,
  type RecoveredOperationBinding,
  type RecoveredTransactionalState,
  type TransactionCommitInput,
  type TransactionReceipt,
  type TransactionalPersistenceMediumImage,
} from "./transactional-persistence.js";
import { types } from "node:util";
import { type WorkspaceKeyProvider, type WorkspaceKeyReference } from "./encrypted-work-store.js";
import { TransactionalPersistenceFilesystemForTestOnly, type PublishedTransactionalPersistenceGeneration, type TransactionalPersistenceFilesystemProtectionMarkerForTestOnly, type TrustedAppOwnedGenerationRootForTestOnly } from "./transactional-persistence-filesystem.js";
import { createWholeMediumAeadFilesystemWireCodecForTestOnly } from "./transactional-persistence-whole-medium-aead-codec.js";

export interface AsyncTransactionalPersistencePortForTestOnly {
  readonly concurrencyIdentity: object;
  readonly protectionMarker?: TransactionalPersistenceFilesystemProtectionMarkerForTestOnly;
  commit(input: unknown): Promise<TransactionReceipt>;
  recover(): Promise<RecoveredTransactionalState>;
  recoverOperationBinding(commitId: unknown): Promise<RecoveredOperationBinding | undefined>;
  close(): Promise<void>;
}
export class AsyncTransactionalPersistenceFilesystemPortError extends Error {
  readonly code = "ASYNC_TRANSACTIONAL_PERSISTENCE_FILESYSTEM_PORT_FAILED" as const;
  constructor() { super("Async transactional persistence filesystem port operation failed."); this.name = "AsyncTransactionalPersistenceFilesystemPortError"; }
}
/** Narrow injection seam for focused A3 publication/reload fault tests only. */
export interface AsyncTransactionalPersistenceFilesystemAdapterForTestOnly {
  readonly protectionMarker?: unknown;
  loadLatest(): Promise<TransactionalPersistenceMediumImage | undefined>;
  publish(image: unknown): Promise<PublishedTransactionalPersistenceGeneration>;
}
export type AsyncTransactionalPersistenceFilesystemAdapterFactoryForTestOnly = (root: TrustedAppOwnedGenerationRootForTestOnly) => AsyncTransactionalPersistenceFilesystemAdapterForTestOnly;
interface SharedLane { lane: Promise<void>; references: number; readonly identity: object; }
const LANES = new Map<string, SharedLane>();
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface WholeMediumAeadProtectedPortCapabilityForTestOnly {
  readonly concurrencyIdentity: object;
  readonly spaceId: string;
  readonly keyReferenceSha256: string;
  readonly rootBindingSha256: string;
  readonly commit: (input: unknown) => Promise<TransactionReceipt>;
  readonly recover: () => Promise<RecoveredTransactionalState>;
  readonly recoverOperationBinding: (commitId: unknown) => Promise<RecoveredOperationBinding | undefined>;
  readonly close: () => Promise<void>;
}
export interface WholeMediumAeadPublicationFaultControllerForTestOnly {
  failBeforePublishForTestOnly(count: number): void;
  failAfterRealPublishAcknowledgementForTestOnly(count: number): void;
}
const WHOLE_MEDIUM_PORT_CAPABILITIES = new WeakMap<object, WholeMediumAeadProtectedPortCapabilityForTestOnly>();
const AUTHENTIC_PROTECTED_PORTS = new WeakSet<object>();
const CANONICAL_FILESYSTEM_LOAD_LATEST = TransactionalPersistenceFilesystemForTestOnly.prototype.loadLatest;
const CANONICAL_FILESYSTEM_PUBLISH = TransactionalPersistenceFilesystemForTestOnly.prototype.publish;
interface PortState {
  readonly laneKey: string;
  readonly shared: SharedLane;
  readonly filesystem: AsyncTransactionalPersistenceFilesystemAdapterForTestOnly;
  readonly concurrencyIdentity: object;
  readonly protectionMarker: TransactionalPersistenceFilesystemProtectionMarkerForTestOnly;
  lifecycle: "opening" | "open" | "closing" | "closed";
  closePromise: Promise<void> | undefined;
}
const PORT_STATES = new WeakMap<AsyncTransactionalPersistenceFilesystemPortForTestOnly, PortState>();

/** Pure WeakMap lookup: no candidate property is read or invoked. */
export function captureWholeMediumAeadProtectedPortCapabilityForTestOnly(value: unknown): WholeMediumAeadProtectedPortCapabilityForTestOnly | undefined { return value !== null && typeof value === "object" ? WHOLE_MEDIUM_PORT_CAPABILITIES.get(value) : undefined; }

export class AsyncTransactionalPersistenceFilesystemPortForTestOnly implements AsyncTransactionalPersistencePortForTestOnly {
  readonly concurrencyIdentity: object;
  readonly protectionMarker: TransactionalPersistenceFilesystemProtectionMarkerForTestOnly;
  constructor(laneKey: string, shared: SharedLane, filesystem: AsyncTransactionalPersistenceFilesystemAdapterForTestOnly, protectedOpen: boolean, rootBindingSha256: string) {
    const protectionMarker = normalizeProtectionMarker(filesystem, protectedOpen, rootBindingSha256);
    this.concurrencyIdentity = shared.identity; this.protectionMarker = protectionMarker;
    PORT_STATES.set(this, { laneKey, shared, filesystem, concurrencyIdentity: shared.identity, protectionMarker, lifecycle: "opening", closePromise: undefined });
  }

  /** The trusted A2 root remains borrowed and is never closed by this port. */
  static async open(root: TrustedAppOwnedGenerationRootForTestOnly, factory: AsyncTransactionalPersistenceFilesystemAdapterFactoryForTestOnly = (capability) => new TransactionalPersistenceFilesystemForTestOnly(capability)): Promise<AsyncTransactionalPersistenceFilesystemPortForTestOnly> {
    return openFilesystemPort(root, factory, false);
  }

  /** The only private route which can construct an AEAD-backed filesystem port. */
  static async openWholeMediumAeadForTestOnly(root: TrustedAppOwnedGenerationRootForTestOnly, provider: WorkspaceKeyProvider, reference: WorkspaceKeyReference): Promise<AsyncTransactionalPersistenceFilesystemPortForTestOnly> {
    return openAuthenticProtectedPort(root, provider, reference);
  }

  /** Narrow private fault seam: it wraps only a real protected filesystem. */
  static async openWholeMediumAeadWithPublicationFaultsForTestOnly(root: TrustedAppOwnedGenerationRootForTestOnly, provider: WorkspaceKeyProvider, reference: WorkspaceKeyReference): Promise<Readonly<{ port: AsyncTransactionalPersistenceFilesystemPortForTestOnly; controller: WholeMediumAeadPublicationFaultControllerForTestOnly }>> {
    return openAuthenticProtectedPortWithFaults(root, provider, reference);
  }

  async recover(): Promise<RecoveredTransactionalState> {
    return enqueueOperation(this, async () => {
      let latest: TransactionalPersistenceMediumImage | undefined;
      try { latest = await portState(this).filesystem.loadLatest(); if (latest === undefined) throw failed(); return validateRecoveredTransactionalStateForTestOnly(latest.state); }
      catch (error) { if (error instanceof TransactionalPersistenceError) throw new AsyncTransactionalPersistenceFilesystemPortError(); throw failed(); }
      finally { disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); }
    });
  }

  async recoverOperationBinding(commitId: unknown): Promise<RecoveredOperationBinding | undefined> {
    if (typeof commitId !== "string" || !CANONICAL_ID.test(commitId)) throw new TransactionalPersistenceError("INVALID");
    return enqueueOperation(this, async () => {
      let latest: TransactionalPersistenceMediumImage | undefined;
      try { latest = await portState(this).filesystem.loadLatest(); if (latest === undefined) throw failed(); const receipt = latest.receipts.find((item) => item.commitId === commitId); return receipt === undefined ? undefined : Object.freeze({ commitId: receipt.commitId, operationBindingSha256: receipt.operationBindingSha256 }); }
      catch (error) { if (error instanceof AsyncTransactionalPersistenceFilesystemPortError) throw error; throw failed(); }
      finally { disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); }
    });
  }

  async commit(input: unknown): Promise<TransactionReceipt> {
    let owned: TransactionCommitInput | undefined; let requestSha256: string | undefined;
    try { owned = captureTransactionCommitInputForAsyncFilesystemPortForTestOnly(input); requestSha256 = transactionCommitRequestSha256ForTestOnly(owned); }
    catch (error) { throw transactionFailure(error); }
    try { return await enqueueOperation(this, async () => commitOwned(this, owned!, requestSha256!)); }
    finally { disposeOpaqueJournalSnapshotForTestOnly(owned?.snapshot); }
  }

  close(): Promise<void> {
    const state = portState(this);
    if (state.closePromise !== undefined) return state.closePromise;
    if (state.lifecycle === "closed") return Promise.resolve();
    state.lifecycle = "closing";
    state.closePromise = enqueueRaw(this, async () => { state.lifecycle = "closed"; releaseLane(state.laneKey, state.shared); });
    return state.closePromise;
  }
}

const CANONICAL_PORT_COMMIT = AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype.commit;
const CANONICAL_PORT_RECOVER = AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype.recover;
const CANONICAL_PORT_RECOVER_OPERATION_BINDING = AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype.recoverOperationBinding;
const CANONICAL_PORT_CLOSE = AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype.close;

function portState(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly): PortState { const state = PORT_STATES.get(port); if (state === undefined) throw failed(); return state; }
function enqueueOperation<T>(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, operation: () => Promise<T>): Promise<T> { if (portState(port).lifecycle !== "open") return Promise.reject(failed()); return enqueueRaw(port, operation); }
async function enqueueRaw<T>(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, operation: () => Promise<T>): Promise<T> { const state = portState(port); let release: (() => void) | undefined; const previous = state.shared.lane; state.shared.lane = new Promise((resolve) => { release = resolve; }); await previous; try { return await operation(); } finally { release?.(); } }
async function commitOwned(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, input: TransactionCommitInput, requestSha256: string): Promise<TransactionReceipt> {
  const filesystem = portState(port).filesystem; let latest: TransactionalPersistenceMediumImage | undefined; let parent: RecoveredTransactionalState | undefined; let next: TransactionalPersistenceMediumImage | undefined; let medium: InMemoryTransactionalPersistenceMedium | undefined;
  try {
    try { latest = await filesystem.loadLatest(); } catch { throw failed(); }
    if (latest === undefined) throw failed();
    try { parent = validateRecoveredTransactionalStateForTestOnly(latest.state); medium = InMemoryTransactionalPersistenceMedium.fromImageForTestOnly(latest); }
    catch { throw failed(); }
    let receipt: TransactionReceipt;
    try { receipt = medium.openPortForTestOnly().commit(input); } catch (error) { throw transactionFailure(error); }
    next = medium.exportImageForTestOnly();
    try { await filesystem.publish(next); }
    catch { return reconcile(port, input.commitId, requestSha256, parent); }
    return verifyReceipt(port, input.commitId, requestSha256);
  } finally { medium?.disposeForTestOnly(); disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); disposeOpaqueJournalSnapshotForTestOnly(parent?.snapshot); disposeOpaqueJournalSnapshotForTestOnly(next?.state.snapshot); }
}
async function verifyReceipt(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, commitId: string, requestSha256: string): Promise<TransactionReceipt> {
  const filesystem = portState(port).filesystem; let latest: TransactionalPersistenceMediumImage | undefined;
  try {
    try { latest = await filesystem.loadLatest(); } catch { throw failed(); }
    if (latest === undefined) throw failed(); const receipt = latest.receipts.find((item) => item.commitId === commitId);
    if (receipt === undefined) throw failed(); if (receipt.requestSha256 !== requestSha256) throw new TransactionalPersistenceError("CONFLICT");
    return Object.freeze({ commitId: receipt.commitId, generation: receipt.generation, snapshotSha256: receipt.snapshotSha256 });
  } catch (error) { if (error instanceof TransactionalPersistenceError) throw transactionFailure(error); if (error instanceof AsyncTransactionalPersistenceFilesystemPortError) throw error; throw failed(); }
  finally { disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); }
}
async function reconcile(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, commitId: string, requestSha256: string, parent: RecoveredTransactionalState): Promise<TransactionReceipt> {
  const filesystem = portState(port).filesystem; let latest: TransactionalPersistenceMediumImage | undefined;
  try {
    try { latest = await filesystem.loadLatest(); } catch { throw failed(); }
    if (latest === undefined) throw failed(); const receipt = latest.receipts.find((item) => item.commitId === commitId);
    if (receipt !== undefined) { if (receipt.requestSha256 !== requestSha256) throw new TransactionalPersistenceError("CONFLICT"); return Object.freeze({ commitId: receipt.commitId, generation: receipt.generation, snapshotSha256: receipt.snapshotSha256 }); }
    if (latest.state.generation === parent.generation && latest.state.snapshotSha256 === parent.snapshotSha256) throw new TransactionalPersistenceError("INTERRUPTED");
    throw new TransactionalPersistenceError("CONFLICT");
  } catch (error) { if (error instanceof TransactionalPersistenceError) throw transactionFailure(error); if (error instanceof AsyncTransactionalPersistenceFilesystemPortError) throw error; throw failed(); }
  finally { disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); }
}

async function openFilesystemPort(root: TrustedAppOwnedGenerationRootForTestOnly, factory: AsyncTransactionalPersistenceFilesystemAdapterFactoryForTestOnly, protectedOpen: boolean): Promise<AsyncTransactionalPersistenceFilesystemPortForTestOnly> {
  const laneKey = `${root.identity.dev}:${root.identity.ino}`; let shared = LANES.get(laneKey);
  if (shared === undefined) { shared = { lane: Promise.resolve(), references: 0, identity: Object.freeze({}) }; LANES.set(laneKey, shared); }
  shared.references += 1;
  let port: AsyncTransactionalPersistenceFilesystemPortForTestOnly | undefined;
  try {
    const adapter = factory(root);
    port = new AsyncTransactionalPersistenceFilesystemPortForTestOnly(laneKey, shared, adapter, protectedOpen, root.rootBindingSha256);
    await enqueueRaw(port, async () => {
      let latest: TransactionalPersistenceMediumImage | undefined;
      try {
        latest = await adapter.loadLatest();
        if (latest === undefined) {
          const medium = new InMemoryTransactionalPersistenceMedium();
          try { await adapter.publish(medium.exportImageForTestOnly()); }
          finally { medium.disposeForTestOnly(); }
        }
      } finally { disposeOpaqueJournalSnapshotForTestOnly(latest?.state.snapshot); }
      const current = await adapter.loadLatest();
      try { if (current === undefined) throw failed(); }
      finally { disposeOpaqueJournalSnapshotForTestOnly(current?.state.snapshot); }
      portState(port!).lifecycle = "open";
    });
    return port;
  } catch {
    if (port !== undefined) portState(port).lifecycle = "closed";
    releaseLane(laneKey, shared);
    throw failed();
  }
}

function authenticProtectedAdapter(root: TrustedAppOwnedGenerationRootForTestOnly, provider: WorkspaceKeyProvider, reference: WorkspaceKeyReference, faults?: { readonly before: () => boolean; readonly after: () => boolean }): AsyncTransactionalPersistenceFilesystemAdapterForTestOnly {
  const codec = createWholeMediumAeadFilesystemWireCodecForTestOnly(provider, reference);
  const filesystem = new TransactionalPersistenceFilesystemForTestOnly(root, codec);
  const publish = async (image: unknown): Promise<PublishedTransactionalPersistenceGeneration> => {
    if (faults?.before() === true) throw failed();
    const published = await CANONICAL_FILESYSTEM_PUBLISH.call(filesystem, image);
    if (faults?.after() === true) throw failed();
    return published;
  };
  return Object.freeze({ protectionMarker: filesystem.protectionMarker, loadLatest: () => CANONICAL_FILESYSTEM_LOAD_LATEST.call(filesystem), publish });
}

async function openAuthenticProtectedPort(root: TrustedAppOwnedGenerationRootForTestOnly, provider: WorkspaceKeyProvider, reference: WorkspaceKeyReference): Promise<AsyncTransactionalPersistenceFilesystemPortForTestOnly> {
  const capturedReference = captureProtectedReference(reference);
  let port: AsyncTransactionalPersistenceFilesystemPortForTestOnly | undefined;
  try {
    port = await openFilesystemPort(root, (capability) => authenticProtectedAdapter(capability, provider, capturedReference), true);
    AUTHENTIC_PROTECTED_PORTS.add(port);
    registerProtectedCapability(port, root, capturedReference);
    return port;
  } catch {
    if (port !== undefined) await CANONICAL_PORT_CLOSE.call(port).catch(() => undefined);
    throw failed();
  }
}

async function openAuthenticProtectedPortWithFaults(root: TrustedAppOwnedGenerationRootForTestOnly, provider: WorkspaceKeyProvider, reference: WorkspaceKeyReference): Promise<Readonly<{ port: AsyncTransactionalPersistenceFilesystemPortForTestOnly; controller: WholeMediumAeadPublicationFaultControllerForTestOnly }>> {
  const capturedReference = captureProtectedReference(reference); let before = 0; let after = 0; let port: AsyncTransactionalPersistenceFilesystemPortForTestOnly | undefined;
  const controller = Object.freeze({
    failBeforePublishForTestOnly(count: number): void { before = boundedFaultCount(count); },
    failAfterRealPublishAcknowledgementForTestOnly(count: number): void { after = boundedFaultCount(count); },
  });
  try {
    port = await openFilesystemPort(root, (capability) => authenticProtectedAdapter(capability, provider, capturedReference, { before: () => before > 0 ? (before -= 1, true) : false, after: () => after > 0 ? (after -= 1, true) : false }), true);
    AUTHENTIC_PROTECTED_PORTS.add(port);
    registerProtectedCapability(port, root, capturedReference);
    return Object.freeze({ port, controller });
  } catch {
    if (port !== undefined) await CANONICAL_PORT_CLOSE.call(port).catch(() => undefined);
    throw failed();
  }
}

Object.freeze(TransactionalPersistenceFilesystemForTestOnly.prototype);
Object.freeze(AsyncTransactionalPersistenceFilesystemPortForTestOnly.prototype);
Object.freeze(AsyncTransactionalPersistenceFilesystemPortForTestOnly);

function releaseLane(key: string, shared: SharedLane): void { shared.references -= 1; if (shared.references === 0) LANES.delete(key); }
function transactionFailure(error: unknown): TransactionalPersistenceError { return error instanceof TransactionalPersistenceError ? new TransactionalPersistenceError(error.code) : new TransactionalPersistenceError("INVALID"); }
function failed(): AsyncTransactionalPersistenceFilesystemPortError { return new AsyncTransactionalPersistenceFilesystemPortError(); }
function normalizeProtectionMarker(adapter: AsyncTransactionalPersistenceFilesystemAdapterForTestOnly, protectedOpen: boolean, expectedRootBindingSha256: string): TransactionalPersistenceFilesystemProtectionMarkerForTestOnly {
  try {
    if (adapter === null || typeof adapter !== "object" || types.isProxy(adapter)) throw failed();
    const markerDescriptor = Object.getOwnPropertyDescriptor(adapter, "protectionMarker");
    if (markerDescriptor === undefined) { if (protectedOpen) throw failed(); return Object.freeze({ kind: "plaintext-test-only" as const }); }
    if (!("value" in markerDescriptor)) throw failed();
    const marker = markerDescriptor.value;
    if (marker === undefined) { if (protectedOpen) throw failed(); return Object.freeze({ kind: "plaintext-test-only" as const }); }
    if (marker === null || typeof marker !== "object" || types.isProxy(marker) || Object.getPrototypeOf(marker) !== Object.prototype) throw failed();
    const kind = Object.getOwnPropertyDescriptor(marker, "kind");
    if (kind === undefined || !("value" in kind)) throw failed();
    if (kind.value === "plaintext-test-only" && Reflect.ownKeys(marker).length === 1) { if (protectedOpen) throw failed(); return Object.freeze({ kind: "plaintext-test-only" as const }); }
    const fields = ["kind", "version", "algorithm", "keyReferenceSha256", "rootBindingSha256"];
    if (!protectedOpen || kind.value !== "whole-medium-aead-v1" || Reflect.ownKeys(marker).length !== fields.length) throw failed();
    const values = Object.create(null) as Record<string, unknown>;
    for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(marker, field); if (descriptor === undefined || !("value" in descriptor)) throw failed(); values[field] = descriptor.value; }
    if (values.version !== 1 || values.algorithm !== "aes-256-gcm" || !sha256(values.keyReferenceSha256) || !sha256(values.rootBindingSha256) || values.rootBindingSha256 !== expectedRootBindingSha256) throw failed();
    return Object.freeze({ kind: "whole-medium-aead-v1" as const, version: 1 as const, algorithm: "aes-256-gcm" as const, keyReferenceSha256: values.keyReferenceSha256 as string, rootBindingSha256: values.rootBindingSha256 as string });
  } catch { throw failed(); }
}
function sha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function captureProtectedReference(value: unknown): WorkspaceKeyReference {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failed();
    const keys = Reflect.ownKeys(value); if (keys.length !== 2 || !keys.includes("spaceId") || !keys.includes("keyId")) throw failed();
    const space = Object.getOwnPropertyDescriptor(value, "spaceId"); const key = Object.getOwnPropertyDescriptor(value, "keyId");
    if (space === undefined || key === undefined || !("value" in space) || !("value" in key) || typeof space.value !== "string" || typeof key.value !== "string" || !CANONICAL_ID.test(space.value) || !CANONICAL_ID.test(key.value)) throw failed();
    return Object.freeze({ spaceId: space.value, keyId: key.value });
  } catch { throw failed(); }
}
function registerProtectedCapability(port: AsyncTransactionalPersistenceFilesystemPortForTestOnly, root: TrustedAppOwnedGenerationRootForTestOnly, reference: WorkspaceKeyReference): void {
  if (!AUTHENTIC_PROTECTED_PORTS.has(port)) throw failed();
  const state = portState(port); const marker = state.protectionMarker;
  if (marker.kind !== "whole-medium-aead-v1" || marker.rootBindingSha256 !== root.rootBindingSha256 || !sha256(marker.keyReferenceSha256)) throw failed();
  WHOLE_MEDIUM_PORT_CAPABILITIES.set(port, Object.freeze({ concurrencyIdentity: state.concurrencyIdentity, spaceId: reference.spaceId, keyReferenceSha256: marker.keyReferenceSha256, rootBindingSha256: marker.rootBindingSha256, commit: CANONICAL_PORT_COMMIT.bind(port), recover: CANONICAL_PORT_RECOVER.bind(port), recoverOperationBinding: CANONICAL_PORT_RECOVER_OPERATION_BINDING.bind(port), close: CANONICAL_PORT_CLOSE.bind(port) }));
}
function boundedFaultCount(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8) throw failed(); return value; }
