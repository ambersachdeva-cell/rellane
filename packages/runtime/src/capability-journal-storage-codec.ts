import {
  CapabilityGrantIndexSchema,
  CapabilityJournalReceiptSchema,
  CapabilityJournalStateSchema,
  type CapabilityApprovalEvidence,
  type CapabilityJournalReceipt,
  type CapabilityJournalState,
  type CapabilityGrantIndex,
} from "@cadrane/contracts/capability-journal";
import { type ApprovedCapabilityIntent } from "@cadrane/contracts/capability-intent";
import { CanonicalDurableIdSchema } from "@cadrane/contracts";
import { prepareCapabilityGrantIndexes, validateCapabilityGrantIndexes } from "./capability-grant-index.js";
import { validateCapabilityJournalBundle } from "./capability-journal-codec.js";

export type EncodedCapabilityStorageRecord = Readonly<{
  entityKind: "capability-grant" | "capability-grant-receipt" | "capability-grant-index";
  id: string;
  recordRevision: 1 | 2;
  plaintext: Uint8Array;
}>;
export type EncodedCapabilityJournalStorageBundle = Readonly<{
  state: EncodedCapabilityStorageRecord;
  receipt: EncodedCapabilityStorageRecord;
  indexes: readonly [] | readonly [EncodedCapabilityStorageRecord, EncodedCapabilityStorageRecord];
}>;
export type DecodedCapabilityJournalStorageBundle = Readonly<{
  bundle: ReturnType<typeof validateCapabilityJournalBundle>;
  indexes: readonly [] | readonly [CapabilityGrantIndex, CapabilityGrantIndex];
}>;

export class CapabilityJournalStorageCodecError extends Error {
  readonly code = "CAPABILITY_JOURNAL_STORAGE_CODEC_FAILED" as const;
  constructor() { super("Capability journal storage codec operation failed."); this.name = "CapabilityJournalStorageCodecError"; }
}

const MAX_RECORD = 65_536; const MAX_ISSUED = 262_144; const MAX_TERMINAL = 131_072;
const TYPED = Object.getPrototypeOf(Uint8Array.prototype); const LENGTH = Object.getOwnPropertyDescriptor(TYPED, "byteLength")?.get; const BUFFER = Object.getOwnPropertyDescriptor(TYPED, "buffer")?.get;
const FILL = Object.getOwnPropertyDescriptor(TYPED, "fill")?.value as ((this: Uint8Array, value: number) => Uint8Array) | undefined;
const SHARED = typeof SharedArrayBuffer === "undefined" ? undefined : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); const encoder = new TextEncoder();

export function encodeCapabilityJournalStorageBundle(bundle: unknown): EncodedCapabilityJournalStorageBundle {
  const outputs: Uint8Array[] = [];
  try {
    const valid = validateCapabilityJournalBundle(bundle); const terminal = valid.state.lifecycle !== "issued";
    const state = encoded("capability-grant", valid.state.grantRecordId, valid.state.stateRevision, canonicalState(valid.state), outputs);
    const receiptId = terminal ? valid.state.terminal!.receiptId : valid.state.issueReceiptId;
    const receipt = encoded("capability-grant-receipt", receiptId, 1, canonicalReceipt(valid.receipt), outputs);
    if (terminal) { assertEncodedTotal(outputs, MAX_TERMINAL); return frozen({ state, receipt, indexes: [] }); }
    const indexes = prepareCapabilityGrantIndexes(valid);
    const pair: [EncodedCapabilityStorageRecord, EncodedCapabilityStorageRecord] = [
      encoded("capability-grant-index", indexes[0].indexRecordId, 1, canonicalIndex(indexes[0]), outputs),
      encoded("capability-grant-index", indexes[1].indexRecordId, 1, canonicalIndex(indexes[1]), outputs),
    ];
    assertEncodedTotal(outputs, MAX_ISSUED); return frozen({ state, receipt, indexes: pair });
  } catch { outputs.forEach(wipeBytes); throw failed(); }
}

export function decodeOwnedCapabilityJournalStorageBundle(input: unknown): DecodedCapabilityJournalStorageBundle {
  const copies: Uint8Array[] = []; const supplied = discoverSuppliedBytes(input);
  try {
    const outer = own(input, ["current", "predecessor"] as const); const current = decodeEncoded(outer.current, copies);
    const predecessor = outer.predecessor === null ? null : decodeEncoded(outer.predecessor, copies);
    const result = decodePair(current, predecessor);
    return Object.freeze({ bundle: result.bundle, indexes: result.indexes });
  } catch { throw failed(); } finally { copies.forEach(wipeBytes); supplied.forEach(wipeBytes); }
}

export function disposeEncodedCapabilityJournalStorageBundle(value: unknown): void {
  try { wipeBundle(value); } catch { /* best effort */ }
}

function decodePair(current: EncodedCapabilityJournalStorageBundle, predecessor: EncodedCapabilityJournalStorageBundle | null): DecodedCapabilityJournalStorageBundle {
  const state = parseRecord(current.state, "capability-grant", CapabilityJournalStateSchema, canonicalState);
  const receipt = parseRecord(current.receipt, "capability-grant-receipt", CapabilityJournalReceiptSchema, canonicalReceipt);
  const candidate = { state, receipt, predecessor: null };
  const terminal = state.lifecycle !== "issued";
  if (!terminal) {
    if (predecessor !== null || current.indexes.length !== 2) throw failed();
    const bundle = validateCapabilityJournalBundle(candidate);
    const indexes = parseIndexes(current.indexes, bundle);
    verifyMapping(current, bundle, indexes); return Object.freeze({ bundle, indexes });
  }
  if (predecessor === null || current.indexes.length !== 0) throw failed();
  const prior = decodeIssued(predecessor); const bundle = validateCapabilityJournalBundle({ state, receipt, predecessor: { state: prior.bundle.state, receipt: prior.bundle.receipt } });
  verifyMapping(current, bundle, []); return Object.freeze({ bundle, indexes: Object.freeze([]) as readonly [] });
}

function decodeIssued(encodedBundle: EncodedCapabilityJournalStorageBundle): DecodedCapabilityJournalStorageBundle {
  if (encodedBundle.indexes.length !== 2) throw failed();
  const state = parseRecord(encodedBundle.state, "capability-grant", CapabilityJournalStateSchema, canonicalState);
  const receipt = parseRecord(encodedBundle.receipt, "capability-grant-receipt", CapabilityJournalReceiptSchema, canonicalReceipt);
  const bundle = validateCapabilityJournalBundle({ state, receipt, predecessor: null });
  if (bundle.state.lifecycle !== "issued") throw failed();
  const indexes = parseIndexes(encodedBundle.indexes, bundle); verifyMapping(encodedBundle, bundle, indexes);
  return Object.freeze({ bundle, indexes });
}

function parseIndexes(records: readonly [EncodedCapabilityStorageRecord, EncodedCapabilityStorageRecord], bundle: ReturnType<typeof validateCapabilityJournalBundle>): readonly [CapabilityGrantIndex, CapabilityGrantIndex] {
  const indexes: [CapabilityGrantIndex, CapabilityGrantIndex] = [
    parseRecord(records[0], "capability-grant-index", CapabilityGrantIndexSchema, canonicalIndex),
    parseRecord(records[1], "capability-grant-index", CapabilityGrantIndexSchema, canonicalIndex),
  ];
  return validateCapabilityGrantIndexes(bundle, indexes);
}

function verifyMapping(encodedBundle: EncodedCapabilityJournalStorageBundle, bundle: ReturnType<typeof validateCapabilityJournalBundle>, indexes: readonly CapabilityGrantIndex[]): void {
  const terminal = bundle.state.lifecycle !== "issued"; const receiptId = terminal ? bundle.state.terminal!.receiptId : bundle.state.issueReceiptId;
  if (encodedBundle.state.id !== bundle.state.grantRecordId || encodedBundle.state.recordRevision !== bundle.state.stateRevision || encodedBundle.receipt.id !== receiptId || encodedBundle.receipt.recordRevision !== 1 || (terminal ? indexes.length !== 0 : indexes.length !== 2)) throw failed();
  if (!terminal) for (let index = 0; index < 2; index += 1) if (encodedBundle.indexes[index]!.id !== indexes[index]!.indexRecordId || encodedBundle.indexes[index]!.recordRevision !== 1) throw failed();
}

function decodeEncoded(value: unknown, copies: Uint8Array[]): EncodedCapabilityJournalStorageBundle {
  const raw = own(value, ["state", "receipt", "indexes"] as const); const state = decodeRecord(raw.state, copies); const receipt = decodeRecord(raw.receipt, copies);
  const indexes = decodeArray(raw.indexes, copies); const total = state.plaintext.byteLength + receipt.plaintext.byteLength + indexes.reduce((sum, item) => sum + item.plaintext.byteLength, 0);
  const terminal = state.recordRevision === 2; if (total > (terminal ? MAX_TERMINAL : MAX_ISSUED)) throw failed();
  return frozen({ state, receipt, indexes: indexes.length === 0 ? [] : [indexes[0]!, indexes[1]!] });
}

function decodeArray(value: unknown, copies: Uint8Array[]): EncodedCapabilityStorageRecord[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failed(); const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if ((length !== 0 && length !== 2) || Reflect.ownKeys(value).length !== length + 1) throw failed(); const output: EncodedCapabilityStorageRecord[] = [];
  for (let index = 0; index < length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (descriptor === undefined || !("value" in descriptor)) throw failed(); output.push(decodeRecord(descriptor.value, copies)); }
  return output;
}

function decodeRecord(value: unknown, copies: Uint8Array[]): EncodedCapabilityStorageRecord {
  const raw = own(value, ["entityKind", "id", "recordRevision", "plaintext"] as const); if (raw.entityKind !== "capability-grant" && raw.entityKind !== "capability-grant-receipt" && raw.entityKind !== "capability-grant-index") throw failed(); if (!CanonicalDurableIdSchema.safeParse(raw.id).success || (raw.recordRevision !== 1 && raw.recordRevision !== 2)) throw failed();
  const plaintext = ownedBytes(raw.plaintext); copies.push(plaintext); wipeBytes(raw.plaintext as Uint8Array); return Object.freeze({ entityKind: raw.entityKind, id: raw.id as string, recordRevision: raw.recordRevision, plaintext });
}

function parseRecord<T>(record: EncodedCapabilityStorageRecord, kind: EncodedCapabilityStorageRecord["entityKind"], schema: { parse(value: unknown): T }, stringify: (value: T) => string): T {
  if (record.entityKind !== kind) throw failed(); let text: string; let value: T;
  try { text = decoder.decode(record.plaintext); const raw: unknown = JSON.parse(text); value = schema.parse(raw); } catch { throw failed(); }
  const canonical = encoder.encode(stringify(value)); try { if (!sameBytes(record.plaintext, canonical)) throw failed(); } finally { canonical.fill(0); }
  return value;
}

function encoded(entityKind: EncodedCapabilityStorageRecord["entityKind"], id: string, recordRevision: 1 | 2, text: string, outputs: Uint8Array[]): EncodedCapabilityStorageRecord { const plaintext = encoder.encode(text); if(plaintext.byteLength<1||plaintext.byteLength>MAX_RECORD){wipeBytes(plaintext);throw failed();} outputs.push(plaintext); return Object.freeze({ entityKind, id, recordRevision, plaintext }); }
function assertEncodedTotal(records: readonly Uint8Array[], maximum: number): void { if(records.reduce((total,item)=>total+item.byteLength,0)>maximum)throw failed(); }
function canonicalState(state: CapabilityJournalState): string { return JSON.stringify({ schemaVersion:state.schemaVersion,kind:state.kind,grantRecordId:state.grantRecordId,grantId:state.grantId,intent:plainIntent(state.intent),intentSha256:state.intentSha256,approvalEvidence:plainEvidence(state.approvalEvidence),approvalProofSha256:state.approvalProofSha256,approvalVerifierId:state.approvalVerifierId,lifecycle:state.lifecycle,stateRevision:state.stateRevision,issuedAt:state.issuedAt,lastTransitionAt:state.lastTransitionAt,issueLifecycleId:state.issueLifecycleId,issueOperationId:state.issueOperationId,issueReceiptId:state.issueReceiptId,terminal:state.terminal===null?null:plainTerminal(state.terminal) }); }
function canonicalReceipt(value: CapabilityJournalReceipt): string { return JSON.stringify({ schemaVersion:value.schemaVersion,kind:value.kind,receiptId:value.receiptId,spaceId:value.spaceId,lifecycle:value.lifecycle,grantId:value.grantId,grantRecordId:value.grantRecordId,intentSha256:value.intentSha256,approvalProofSha256:value.approvalProofSha256,stateRevision:value.stateRevision,operationId:value.operationId,lifecycleId:value.lifecycleId,priorStateSha256:value.priorStateSha256,stateSha256:value.stateSha256,lifecycleBindingSha256:value.lifecycleBindingSha256,effectExecution:value.effectExecution,recordedAt:value.recordedAt }); }
function canonicalIndex(value: CapabilityGrantIndex): string { return JSON.stringify({ schemaVersion:value.schemaVersion,kind:value.kind,indexRole:value.indexRole,indexRecordId:value.indexRecordId,spaceId:value.spaceId,targetId:value.targetId,grantRecordId:value.grantRecordId,grantId:value.grantId,intentSha256:value.intentSha256,approvalProofSha256:value.approvalProofSha256,issueLifecycleId:value.issueLifecycleId,issueOperationId:value.issueOperationId,issueReceiptId:value.issueReceiptId }); }
function plainIntent(value: ApprovedCapabilityIntent) { return { schemaVersion:value.schemaVersion,permissionRequestId:value.permissionRequestId,permissionDecisionId:value.permissionDecisionId,spaceId:value.spaceId,runId:value.runId,effectId:value.effectId,effectRevision:value.effectRevision,effectKind:value.effectKind,authoritySessionId:value.authoritySessionId,subjectBindingSha256:value.subjectBindingSha256,targetBindingSha256:value.targetBindingSha256,parameterSha256:value.parameterSha256,requestSha256:value.requestSha256,expiresAt:value.expiresAt,maxUses:value.maxUses }; }
function plainEvidence(value: CapabilityApprovalEvidence) { return { schemaVersion:value.schemaVersion,kind:value.kind,verifierId:value.verifierId,verdict:value.verdict,permissionRequestId:value.permissionRequestId,permissionDecisionId:value.permissionDecisionId,authoritySessionId:value.authoritySessionId,requestSha256:value.requestSha256,intentSha256:value.intentSha256,expiresAt:value.expiresAt }; }
function plainTerminal(value: NonNullable<CapabilityJournalState["terminal"]>) { return { lifecycle:value.lifecycle,lifecycleId:value.lifecycleId,operationId:value.operationId,receiptId:value.receiptId }; }
function ownedBytes(value: unknown): Uint8Array { try { if (!isNativeBytes(value)) throw failed(); const length=LENGTH!.call(value); if(length<1||length>MAX_RECORD)throw failed(); return new Uint8Array(value); } catch { throw failed(); } }
function own<const Fields extends readonly string[]>(value: unknown, fields: Fields): Record<Fields[number], unknown> { try { if(value===null||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)throw failed(); const keys=Reflect.ownKeys(value); if(keys.length!==fields.length||!fields.every((field)=>keys.includes(field)))throw failed(); const result={} as Record<Fields[number],unknown>; for(const field of fields){const descriptor=Object.getOwnPropertyDescriptor(value,field);if(descriptor===undefined||!("value" in descriptor))throw failed();result[field as Fields[number]]=descriptor.value;} return result;}catch{throw failed();} }
function frozen(value: { state: EncodedCapabilityStorageRecord; receipt: EncodedCapabilityStorageRecord; indexes: EncodedCapabilityStorageRecord[] | [EncodedCapabilityStorageRecord, EncodedCapabilityStorageRecord] }): EncodedCapabilityJournalStorageBundle { return Object.freeze({state:value.state,receipt:value.receipt,indexes:Object.freeze(value.indexes) as EncodedCapabilityJournalStorageBundle["indexes"]}); }
function sameBytes(left: Uint8Array,right: Uint8Array):boolean { if(left.byteLength!==right.byteLength)return false; let different=0;for(let index=0;index<left.byteLength;index+=1)different|=left[index]!^right[index]!;return different===0; }
function wipeBundle(value: unknown):void { const outer=safeOwn(value,["state","receipt","indexes"]); if(outer===undefined)return; wipeRecord(outer.state);wipeRecord(outer.receipt);const indexes=outer.indexes;if(!Array.isArray(indexes)||Object.getPrototypeOf(indexes)!==Array.prototype)return;const length=Object.getOwnPropertyDescriptor(indexes,"length")?.value;if(length!==0&&length!==2)return;for(let index=0;index<length;index+=1){const item=Object.getOwnPropertyDescriptor(indexes,String(index));if(item!==undefined&&"value" in item)wipeRecord(item.value);} }
function wipeRecord(value: unknown):void { const raw=safeOwn(value,["entityKind","id","recordRevision","plaintext"]);if(raw===undefined)return;const bytes=raw.plaintext;if(isNativeBytes(bytes))wipeBytes(bytes); }
function safeOwn<const Fields extends readonly string[]>(value: unknown, fields: Fields): Record<Fields[number],unknown>|undefined { try{if(value===null||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)return undefined;const keys=Reflect.ownKeys(value);if(keys.length!==fields.length||!fields.every((field)=>keys.includes(field)))return undefined;const result={} as Record<Fields[number],unknown>;for(const field of fields){const descriptor=Object.getOwnPropertyDescriptor(value,field);if(descriptor===undefined||!("value" in descriptor))return undefined;result[field as Fields[number]]=descriptor.value;}return result;}catch{return undefined;} }
function isNativeBytes(value: unknown): value is Uint8Array { try{if(!isWipeableNativeBytes(value))return false;const length=LENGTH!.call(value);if(length>MAX_RECORD)return false;const keys=Reflect.ownKeys(value);return keys.length===length&&keys.every((key)=>typeof key==="string"&&/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<length);}catch{return false;} }
function isWipeableNativeBytes(value: unknown): value is Uint8Array { try{if(!(value instanceof Uint8Array)||Object.getPrototypeOf(value)!==Uint8Array.prototype||Buffer.isBuffer(value)||LENGTH===undefined||BUFFER===undefined||FILL===undefined||Object.hasOwn(value,"byteLength")||Object.hasOwn(value,"buffer")||Object.hasOwn(value,"length"))return false;const length=LENGTH.call(value);if(!Number.isSafeInteger(length)||length<0||length>MAX_RECORD)return false;const buffer=BUFFER.call(value);return !(SHARED!==undefined&&(()=>{try{return typeof SHARED.call(buffer)==="number";}catch{return false;}})());}catch{return false;} }
function wipeBytes(bytes: Uint8Array): void { try { FILL?.call(bytes, 0); } catch { /* best effort */ } }
function discoverSuppliedBytes(value: unknown): Uint8Array[] { const found: Uint8Array[]=[]; const seen=new Set<Uint8Array>(); const add=(bytes:Uint8Array)=>{if(!seen.has(bytes)){seen.add(bytes);found.push(bytes);}}; const visitRecord=(item:unknown)=>{try{if(item===null||typeof item!=="object")return;const descriptor=Object.getOwnPropertyDescriptor(item,"plaintext");if(descriptor!==undefined&&"value" in descriptor&&isWipeableNativeBytes(descriptor.value))add(descriptor.value);}catch{/* best effort */}}; const visitBundle=(bundle:unknown)=>{try{if(bundle===null||typeof bundle!=="object")return;for(const key of ["state","receipt"]){const descriptor=Object.getOwnPropertyDescriptor(bundle,key);if(descriptor!==undefined&&"value" in descriptor)visitRecord(descriptor.value);}const indexes=Object.getOwnPropertyDescriptor(bundle,"indexes");if(indexes===undefined||!("value" in indexes)||!Array.isArray(indexes.value))return;const length=Object.getOwnPropertyDescriptor(indexes.value,"length")?.value;if(!Number.isSafeInteger(length)||length<0||length>16)return;for(let index=0;index<length;index+=1){const item=Object.getOwnPropertyDescriptor(indexes.value,String(index));if(item!==undefined&&"value" in item)visitRecord(item.value);}}catch{/* best effort */}};try{if(value===null||typeof value!=="object")return found;for(const key of ["current","predecessor"]){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(descriptor!==undefined&&"value" in descriptor&&descriptor.value!==null)visitBundle(descriptor.value);}}catch{/* best effort */}return found; }
function failed(): CapabilityJournalStorageCodecError { return new CapabilityJournalStorageCodecError(); }
