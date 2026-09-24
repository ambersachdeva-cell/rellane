import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import { validateCapabilityJournalBundle } from "../capability-journal-codec.js";
import { disposeEncodedCapabilityJournalStorageBundle, encodeCapabilityJournalStorageBundle, type EncodedCapabilityJournalStorageBundle } from "../capability-journal-storage-codec.js";
import { type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { AsyncTransactionalEncryptedWorkSet, type AsyncTransactionalEncryptedWorkSetInput } from "./async-transactional-encrypted-work-set.js";
import { type AsyncTransactionalPersistencePortForTestOnly } from "./async-transactional-persistence-filesystem-port.js";

export class AsyncTransactionalCapabilityJournalError extends Error {
  readonly code = "ASYNC_TRANSACTIONAL_CAPABILITY_JOURNAL_FAILED" as const;
  constructor() { super("Async transactional capability journal operation failed."); this.name = "AsyncTransactionalCapabilityJournalError"; }
}
export interface AsyncTransactionalCapabilityJournalInput { readonly spaceId: string; readonly keyId: string; readonly bundle: unknown; }

/** Private A4 coordinator: encrypted metadata only; no action authority or effects. */
export class AsyncTransactionalCapabilityJournal {
  private readonly work: AsyncTransactionalEncryptedWorkSet;
  constructor(port: AsyncTransactionalPersistencePortForTestOnly, provider: WorkspaceKeyProvider, refs?: () => string) { try { this.work = new AsyncTransactionalEncryptedWorkSet(port, provider, refs); } catch (_error) { throw fail(); } }
  async issue(input: AsyncTransactionalCapabilityJournalInput): Promise<readonly DurableJournalRecord[]> {
    let encoded: EncodedCapabilityJournalStorageBundle | undefined;
    try { const parsed = parse(input, "issued"); encoded = encodeCapabilityJournalStorageBundle(parsed.bundle); return freezeRecords(await this.work.putAtomic({ operationId: parsed.bundle.state.issueOperationId, spaceId: parsed.spaceId, keyId: parsed.keyId, writes: writes(encoded) })); }
    catch (_error) { throw fail(); }
    finally { if (encoded !== undefined) disposeEncodedCapabilityJournalStorageBundle(encoded); }
  }
  async terminalize(input: AsyncTransactionalCapabilityJournalInput): Promise<readonly DurableJournalRecord[]> {
    let current: EncodedCapabilityJournalStorageBundle | undefined; let predecessor: EncodedCapabilityJournalStorageBundle | undefined;
    try { const parsed = parse(input, "terminal"); const prior = parsed.bundle.predecessor; if (prior === null) throw fail(); current = encodeCapabilityJournalStorageBundle(parsed.bundle); predecessor = encodeCapabilityJournalStorageBundle({ state: prior.state, receipt: prior.receipt, predecessor: null }); const terminal = parsed.bundle.state.terminal; if (terminal === null) throw fail(); return freezeRecords(await this.work.putAtomicAfterExactPrerequisite({ operationId: terminal.operationId, spaceId: parsed.spaceId, keyId: parsed.keyId, prerequisiteOperationId: parsed.bundle.state.issueOperationId, prerequisites: writes(predecessor), writes: writes(current) })); }
    catch (_error) { throw fail(); }
    finally { if (current !== undefined) disposeEncodedCapabilityJournalStorageBundle(current); if (predecessor !== undefined) disposeEncodedCapabilityJournalStorageBundle(predecessor); }
  }
}

function parse(value: unknown, lifecycle: "issued" | "terminal"): { readonly spaceId: string; readonly keyId: string; readonly bundle: ReturnType<typeof validateCapabilityJournalBundle> } { try { const captured = capture(value); const raw = ownValues(captured, ["spaceId", "keyId", "bundle"]); if (raw === undefined || !CanonicalDurableIdSchema.safeParse(raw.spaceId).success || !CanonicalDurableIdSchema.safeParse(raw.keyId).success) throw fail(); const bundle = validateCapabilityJournalBundle(raw.bundle); if (bundle.state.intent.spaceId !== raw.spaceId || (lifecycle === "issued" ? bundle.state.lifecycle !== "issued" || bundle.predecessor !== null : bundle.state.lifecycle === "issued" || bundle.predecessor === null)) throw fail(); return Object.freeze({ spaceId: raw.spaceId as string, keyId: raw.keyId as string, bundle }); } catch (_error) { throw fail(); } }
function writes(bundle: EncodedCapabilityJournalStorageBundle): AsyncTransactionalEncryptedWorkSetInput["writes"] { const ordered = [bundle.state, bundle.receipt, ...bundle.indexes]; return Object.freeze(ordered.map((record) => Object.freeze({ id: record.id, entityKind: record.entityKind, recordRevision: record.recordRevision, idempotency: { kind: "entity" as const }, kind: "payload" as const, plaintext: record.plaintext }))); }
interface CaptureBudget { nodes: number; strings: number; }
function capture(value: unknown): unknown { return captureValue(value, { nodes: 0, strings: 0 }, new Set<object>(), 0); }
function captureValue(value: unknown, budget: CaptureBudget, seen: Set<object>, depth: number): unknown { if (value === null || typeof value === "boolean" || typeof value === "number") return value; if (typeof value === "string") { if ((budget.strings += value.length) > 1_048_576) throw fail(); return value; } if (typeof value !== "object" || types.isProxy(value) || depth >= 32 || ++budget.nodes > 2_048 || Object.getPrototypeOf(value) !== Object.prototype || seen.has(value)) throw fail(); seen.add(value); try { const result: Record<string, unknown> = {}; let fields = 0; for (const key in value) { if (!Object.hasOwn(value, key) || ++fields > 64) throw fail(); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw fail(); Object.defineProperty(result, key, { value: captureValue(descriptor.value, budget, seen, depth + 1), enumerable: true, writable: true, configurable: true }); } return result; } finally { seen.delete(value); } }
function ownValues(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined { try { if (value === null || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined; let count = 0; for (const key in value) { if (!Object.hasOwn(value, key) || !fields.includes(key) || ++count > fields.length) return undefined; } if (count !== fields.length) return undefined; const output: Record<string, unknown> = {}; for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined; output[field] = descriptor.value; } return output; } catch (_error) { return undefined; } }
function freezeRecords(records: readonly DurableJournalRecord[]): readonly DurableJournalRecord[] { return Object.freeze(records.map((record) => deepFreeze(JSON.parse(JSON.stringify(record)) as DurableJournalRecord))); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function fail(): AsyncTransactionalCapabilityJournalError { return new AsyncTransactionalCapabilityJournalError(); }
import { types } from "node:util";
