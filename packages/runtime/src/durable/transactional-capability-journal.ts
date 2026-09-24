import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { type DurableJournalRecord } from "@cadrane/contracts/durable-journal";
import { validateCapabilityJournalBundle } from "../capability-journal-codec.js";
import { disposeEncodedCapabilityJournalStorageBundle, encodeCapabilityJournalStorageBundle, type EncodedCapabilityJournalStorageBundle, type EncodedCapabilityStorageRecord } from "../capability-journal-storage-codec.js";
import { TransactionalEncryptedWorkSet, type TransactionalEncryptedWorkSetInput } from "./transactional-encrypted-work-set.js";
import { type WorkspaceKeyProvider } from "./encrypted-work-store.js";
import { type TransactionalPersistencePort } from "./transactional-persistence.js";

export class TransactionalCapabilityJournalError extends Error { readonly code = "TRANSACTIONAL_CAPABILITY_JOURNAL_FAILED" as const; constructor() { super("Transactional capability journal operation failed."); this.name = "TransactionalCapabilityJournalError"; } }
export interface TransactionalCapabilityJournalInput { readonly spaceId: string; readonly keyId: string; readonly bundle: unknown; }

/** Private in-memory simulator seam only: no authority rehydration, effects,
 * disk, anti-rollback, product reachability, or capability activation. */
export class TransactionalCapabilityJournal {
  private readonly work: TransactionalEncryptedWorkSet;
  constructor(port: TransactionalPersistencePort, provider: WorkspaceKeyProvider, refs?: () => string) { try { this.work = new TransactionalEncryptedWorkSet(port, provider, refs); } catch (_e) { throw fail(); } }
  async issue(input: TransactionalCapabilityJournalInput): Promise<readonly DurableJournalRecord[]> {
    let encoded: EncodedCapabilityJournalStorageBundle | undefined;
    try { const parsed = parse(input, "issued"); encoded = encodeCapabilityJournalStorageBundle(parsed.bundle); return freezeRecords(await this.work.putAtomic({ operationId: parsed.bundle.state.issueOperationId, spaceId: parsed.spaceId, keyId: parsed.keyId, writes: writes(encoded) })); } catch (_e) { throw fail(); } finally { if (encoded !== undefined) disposeEncodedCapabilityJournalStorageBundle(encoded); }
  }
  async terminalize(input: TransactionalCapabilityJournalInput): Promise<readonly DurableJournalRecord[]> {
    let current: EncodedCapabilityJournalStorageBundle | undefined; let predecessor: EncodedCapabilityJournalStorageBundle | undefined;
    try { const parsed = parse(input, "terminal"); const prior = parsed.bundle.predecessor; if (prior === null) throw fail(); current = encodeCapabilityJournalStorageBundle(parsed.bundle); predecessor = encodeCapabilityJournalStorageBundle({ state: prior.state, receipt: prior.receipt, predecessor: null }); const terminal = parsed.bundle.state.terminal; if (terminal === null) throw fail(); return freezeRecords(await this.work.putAtomicAfterExactPrerequisite({ operationId: terminal.operationId, spaceId: parsed.spaceId, keyId: parsed.keyId, prerequisiteOperationId: parsed.bundle.state.issueOperationId, prerequisites: writes(predecessor), writes: writes(current) })); } catch (_e) { throw fail(); } finally { if (current !== undefined) disposeEncodedCapabilityJournalStorageBundle(current); if (predecessor !== undefined) disposeEncodedCapabilityJournalStorageBundle(predecessor); }
  }
}

function parse(value: unknown, lifecycle: "issued" | "terminal"): { readonly spaceId: string; readonly keyId: string; readonly bundle: ReturnType<typeof validateCapabilityJournalBundle> } { try { const raw=ownValues(value,["spaceId","keyId","bundle"]); if(raw===undefined||!CanonicalDurableIdSchema.safeParse(raw.spaceId).success||!CanonicalDurableIdSchema.safeParse(raw.keyId).success)throw fail();const bundle=validateCapabilityJournalBundle(raw.bundle);if(bundle.state.intent.spaceId!==raw.spaceId||(lifecycle==="issued"?bundle.state.lifecycle!=="issued"||bundle.predecessor!==null:bundle.state.lifecycle==="issued"||bundle.predecessor===null))throw fail();return Object.freeze({spaceId:raw.spaceId as string,keyId:raw.keyId as string,bundle});}catch(_e){throw fail();} }
function writes(bundle: EncodedCapabilityJournalStorageBundle): TransactionalEncryptedWorkSetInput["writes"] { const ordered=[bundle.state,bundle.receipt,...bundle.indexes]; return Object.freeze(ordered.map((record)=>Object.freeze({ id:record.id,entityKind:record.entityKind,recordRevision:record.recordRevision,idempotency:{kind:"entity" as const},kind:"payload" as const,plaintext:record.plaintext }))); }
function exact(value: unknown, fields: readonly string[]): value is Record<string,unknown> { try { if(value===null||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)return false; const keys=Reflect.ownKeys(value); return keys.length===fields.length&&fields.every((field)=>{const descriptor=Object.getOwnPropertyDescriptor(value,field);return descriptor!==undefined&&"value" in descriptor;}); } catch(_e){return false;} }
function ownValues(value: unknown, fields: readonly string[]): Record<string,unknown>|undefined { try { if(value===null||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)return undefined;const keys=Reflect.ownKeys(value);if(keys.length!==fields.length)return undefined;const output:Record<string,unknown>={};for(const field of fields){const descriptor=Object.getOwnPropertyDescriptor(value,field);if(descriptor===undefined||!("value" in descriptor))return undefined;output[field]=descriptor.value;}return output;}catch(_e){return undefined;} }
function freezeRecords(records: readonly DurableJournalRecord[]): readonly DurableJournalRecord[] { return Object.freeze(records.map((record)=>deepFreeze(JSON.parse(JSON.stringify(record)) as DurableJournalRecord))); }
function deepFreeze<T>(value:T):T { if(value!==null&&typeof value==="object"){for(const child of Object.values(value as Record<string,unknown>))deepFreeze(child);Object.freeze(value);}return value; }
function fail(): TransactionalCapabilityJournalError { return new TransactionalCapabilityJournalError(); }
