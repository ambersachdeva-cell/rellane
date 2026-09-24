import { createHash } from "node:crypto";
import {
  CapabilityApprovalEvidenceSchema,
  CapabilityJournalReceiptSchema,
  CapabilityJournalStateSchema,
  type CapabilityApprovalEvidence,
  type CapabilityJournalReceipt,
  type CapabilityJournalState,
} from "@cadrane/contracts/capability-journal";
import {
  ApprovedCapabilityIntentSchema,
  type ApprovedCapabilityIntent,
} from "@cadrane/contracts/capability-intent";
import { canonicalCapabilityIntentSha256 } from "./capability-intent-binding.js";

export class CapabilityJournalCodecError extends Error {
  readonly code = "CAPABILITY_JOURNAL_CODEC_FAILED" as const;

  constructor() {
    super("Capability journal codec operation failed.");
    this.name = "CapabilityJournalCodecError";
  }
}

type JournalBundle = Readonly<{
  state: CapabilityJournalState;
  receipt: CapabilityJournalReceipt;
  predecessor: Readonly<{ state: CapabilityJournalState; receipt: CapabilityJournalReceipt }> | null;
}>;

const INTENT_FIELDS = [
  "schemaVersion", "permissionRequestId", "permissionDecisionId", "spaceId", "runId",
  "effectId", "effectRevision", "effectKind", "authoritySessionId", "subjectBindingSha256",
  "targetBindingSha256", "parameterSha256", "requestSha256", "expiresAt", "maxUses",
] as const;
const EVIDENCE_FIELDS = [
  "schemaVersion", "kind", "verifierId", "verdict", "permissionRequestId",
  "permissionDecisionId", "authoritySessionId", "requestSha256", "intentSha256", "expiresAt",
] as const;
const TERMINAL_FIELDS = ["lifecycle", "lifecycleId", "operationId", "receiptId"] as const;
const STATE_FIELDS = [
  "schemaVersion", "kind", "grantRecordId", "grantId", "intent", "intentSha256",
  "approvalEvidence", "approvalProofSha256", "approvalVerifierId", "lifecycle", "stateRevision",
  "issuedAt", "lastTransitionAt", "issueLifecycleId", "issueOperationId", "issueReceiptId", "terminal",
] as const;
const RECEIPT_FIELDS = [
  "schemaVersion", "kind", "receiptId", "spaceId", "lifecycle", "grantId", "grantRecordId",
  "intentSha256", "approvalProofSha256", "stateRevision", "operationId", "lifecycleId",
  "priorStateSha256", "stateSha256", "lifecycleBindingSha256", "effectExecution", "recordedAt",
] as const;
const ISSUED_INPUT_FIELDS = ["grantRecordId", "grantId", "intent", "approvalEvidence", "issuedAt", "issueLifecycleId", "issueOperationId", "issueReceiptId"] as const;
const TERMINAL_INPUT_FIELDS = ["predecessor", "lifecycle", "lifecycleId", "operationId", "receiptId", "recordedAt"] as const;

export function prepareIssuedCapabilityJournal(input: unknown): JournalBundle {
  try {
    const raw = ownRecord(input, ISSUED_INPUT_FIELDS);
    const intent = decodeIntent(raw.intent);
    const evidence = decodeEvidence(raw.approvalEvidence);
    const intentSha256 = canonicalCapabilityIntentSha256(intent);
    assertEvidence(intent, evidence, intentSha256);
    const approvalProofSha256 = approvalProof(evidence);
    const state = decodeState({
      schemaVersion: 1, kind: "capability-grant", grantRecordId: raw.grantRecordId,
      grantId: raw.grantId, intent, intentSha256, approvalEvidence: evidence, approvalProofSha256,
      approvalVerifierId: evidence.verifierId, lifecycle: "issued", stateRevision: 1,
      issuedAt: raw.issuedAt, lastTransitionAt: raw.issuedAt, issueLifecycleId: raw.issueLifecycleId,
      issueOperationId: raw.issueOperationId, issueReceiptId: raw.issueReceiptId, terminal: null,
    });
    return freezeBundle(state, makeReceipt(state, null, state.issueReceiptId, state.issueOperationId, state.issueLifecycleId, state.issuedAt));
  } catch {
    throw failed();
  }
}

export function prepareTerminalCapabilityJournal(input: unknown): JournalBundle {
  try {
    const raw = ownRecord(input, TERMINAL_INPUT_FIELDS);
    if (raw.lifecycle !== "consumed" && raw.lifecycle !== "revoked" && raw.lifecycle !== "expired") throw failed();
    const predecessor = decodePredecessor(raw.predecessor);
    assertIssuedPair(predecessor.state, predecessor.receipt);
    const priorStateSha256 = stateDigest(predecessor.state);
    const state = decodeState({
      ...predecessor.state,
      lifecycle: raw.lifecycle,
      stateRevision: 2,
      lastTransitionAt: raw.recordedAt,
      terminal: { lifecycle: raw.lifecycle, lifecycleId: raw.lifecycleId, operationId: raw.operationId, receiptId: raw.receiptId },
    });
    const receipt = makeReceipt(state, priorStateSha256, raw.receiptId, raw.operationId, raw.lifecycleId, raw.recordedAt);
    return freezeBundle(state, receipt, predecessor);
  } catch {
    throw failed();
  }
}

export function validateCapabilityJournalBundle(input: unknown): JournalBundle {
  try {
    const raw = ownRecord(input, ["state", "receipt", "predecessor"] as const);
    const state = decodeState(raw.state);
    const receipt = decodeReceipt(raw.receipt);
    if (state.lifecycle === "issued") {
      if (raw.predecessor !== null) throw failed();
      assertIssuedPair(state, receipt);
      return freezeBundle(state, receipt);
    }
    const predecessor = decodePredecessor(raw.predecessor);
    assertIssuedPair(predecessor.state, predecessor.receipt);
    assertTerminalPair(state, receipt, predecessor.state);
    return freezeBundle(state, receipt, predecessor);
  } catch {
    throw failed();
  }
}

function decodePredecessor(value: unknown): { state: CapabilityJournalState; receipt: CapabilityJournalReceipt } {
  const raw = ownRecord(value, ["state", "receipt"] as const);
  return { state: decodeState(raw.state), receipt: decodeReceipt(raw.receipt) };
}

function decodeIntent(value: unknown): ApprovedCapabilityIntent {
  return ApprovedCapabilityIntentSchema.parse(ownRecord(value, INTENT_FIELDS));
}

function decodeEvidence(value: unknown): CapabilityApprovalEvidence {
  return CapabilityApprovalEvidenceSchema.parse(ownRecord(value, EVIDENCE_FIELDS));
}

function decodeState(value: unknown): CapabilityJournalState {
  const raw = ownRecord(value, STATE_FIELDS);
  return CapabilityJournalStateSchema.parse({
    ...raw,
    intent: decodeIntent(raw.intent),
    approvalEvidence: decodeEvidence(raw.approvalEvidence),
    terminal: raw.terminal === null ? null : ownRecord(raw.terminal, TERMINAL_FIELDS),
  });
}

function decodeReceipt(value: unknown): CapabilityJournalReceipt {
  return CapabilityJournalReceiptSchema.parse(ownRecord(value, RECEIPT_FIELDS));
}

function assertEvidence(intent: ApprovedCapabilityIntent, evidence: CapabilityApprovalEvidence, intentSha256: string): void {
  if (
    evidence.permissionRequestId !== intent.permissionRequestId ||
    evidence.permissionDecisionId !== intent.permissionDecisionId ||
    evidence.authoritySessionId !== intent.authoritySessionId ||
    evidence.requestSha256 !== intent.requestSha256 ||
    evidence.intentSha256 !== intentSha256 ||
    evidence.expiresAt !== intent.expiresAt
  ) throw failed();
}

function assertCommonState(state: CapabilityJournalState): void {
  const intentSha256 = canonicalCapabilityIntentSha256(state.intent);
  if (state.intentSha256 !== intentSha256 || state.approvalProofSha256 !== approvalProof(state.approvalEvidence)) throw failed();
  assertEvidence(state.intent, state.approvalEvidence, intentSha256);
}

function assertIssuedPair(state: CapabilityJournalState, receipt: CapabilityJournalReceipt): void {
  assertCommonState(state);
  if (
    state.lifecycle !== "issued" || state.stateRevision !== 1 || state.terminal !== null ||
    receipt.lifecycle !== "issued" || receipt.stateRevision !== 1 || receipt.receiptId !== state.issueReceiptId ||
    receipt.operationId !== state.issueOperationId || receipt.lifecycleId !== state.issueLifecycleId ||
    receipt.priorStateSha256 !== null || receipt.recordedAt !== state.issuedAt
  ) throw failed();
  assertReceipt(state, receipt, null);
}

function assertTerminalPair(state: CapabilityJournalState, receipt: CapabilityJournalReceipt, predecessor: CapabilityJournalState): void {
  assertCommonState(state);
  const terminal = state.terminal;
  if (
    state.lifecycle === "issued" || state.stateRevision !== 2 || terminal === null ||
    terminal.lifecycle !== state.lifecycle || receipt.lifecycle !== state.lifecycle || receipt.stateRevision !== 2 ||
    receipt.receiptId !== terminal.receiptId || receipt.operationId !== terminal.operationId ||
    receipt.lifecycleId !== terminal.lifecycleId || receipt.recordedAt !== state.lastTransitionAt ||
    receipt.priorStateSha256 !== stateDigest(predecessor) || !sameIssuedState(state, predecessor)
  ) throw failed();
  assertReceipt(state, receipt, receipt.priorStateSha256);
}

function sameIssuedState(state: CapabilityJournalState, previous: CapabilityJournalState): boolean {
  return state.grantRecordId === previous.grantRecordId && state.grantId === previous.grantId &&
    state.intentSha256 === previous.intentSha256 && state.approvalProofSha256 === previous.approvalProofSha256 &&
    state.approvalVerifierId === previous.approvalVerifierId && state.issuedAt === previous.issuedAt &&
    state.issueLifecycleId === previous.issueLifecycleId && state.issueOperationId === previous.issueOperationId &&
    state.issueReceiptId === previous.issueReceiptId;
}

function makeReceipt(state: CapabilityJournalState, priorStateSha256: string | null, receiptId: unknown, operationId: unknown, lifecycleId: unknown, recordedAt: unknown): CapabilityJournalReceipt {
  const stateSha256 = stateDigest(state);
  const receipt = decodeReceipt({
    schemaVersion: 1, kind: "capability-grant-receipt", receiptId, spaceId: state.intent.spaceId,
    lifecycle: state.lifecycle, grantId: state.grantId, grantRecordId: state.grantRecordId,
    intentSha256: state.intentSha256, approvalProofSha256: state.approvalProofSha256,
    stateRevision: state.stateRevision, operationId, lifecycleId, priorStateSha256, stateSha256,
    lifecycleBindingSha256: "0".repeat(64), effectExecution: "not-performed", recordedAt,
  });
  return decodeReceipt({ ...receipt, lifecycleBindingSha256: receiptDigest(receipt) });
}

function assertReceipt(state: CapabilityJournalState, receipt: CapabilityJournalReceipt, priorStateSha256: string | null): void {
  if (
    receipt.spaceId !== state.intent.spaceId || receipt.grantId !== state.grantId ||
    receipt.grantRecordId !== state.grantRecordId || receipt.intentSha256 !== state.intentSha256 ||
    receipt.approvalProofSha256 !== state.approvalProofSha256 || receipt.stateSha256 !== stateDigest(state) ||
    receipt.priorStateSha256 !== priorStateSha256 || receipt.effectExecution !== "not-performed" ||
    receipt.lifecycleBindingSha256 !== receiptDigest(receipt)
  ) throw failed();
}

function approvalProof(evidence: CapabilityApprovalEvidence): string {
  return digest("capability-approval-evidence:v1", evidenceScalars(evidence));
}

function stateDigest(state: CapabilityJournalState): string {
  const terminal = state.terminal;
  return digest("capability-journal-state:v1", [
    state.schemaVersion, state.kind, state.grantRecordId, state.grantId, ...intentScalars(state.intent),
    state.intentSha256, ...evidenceScalars(state.approvalEvidence), state.approvalProofSha256,
    state.approvalVerifierId, state.lifecycle, state.stateRevision, state.issuedAt, state.lastTransitionAt,
    state.issueLifecycleId, state.issueOperationId, state.issueReceiptId,
    terminal === null ? null : terminal.lifecycle, terminal === null ? null : terminal.lifecycleId,
    terminal === null ? null : terminal.operationId, terminal === null ? null : terminal.receiptId,
  ]);
}

function receiptDigest(receipt: CapabilityJournalReceipt): string {
  return digest("capability-journal-lifecycle-receipt:v1", [
    receipt.schemaVersion, receipt.kind, receipt.receiptId, receipt.spaceId, receipt.lifecycle,
    receipt.grantId, receipt.grantRecordId, receipt.intentSha256, receipt.approvalProofSha256,
    receipt.stateRevision, receipt.operationId, receipt.lifecycleId, receipt.priorStateSha256,
    receipt.stateSha256, receipt.effectExecution, receipt.recordedAt,
  ]);
}

function intentScalars(intent: ApprovedCapabilityIntent): Scalar[] {
  return [intent.schemaVersion, intent.permissionRequestId, intent.permissionDecisionId, intent.spaceId,
    intent.runId, intent.effectId, intent.effectRevision, intent.effectKind, intent.authoritySessionId,
    intent.subjectBindingSha256, intent.targetBindingSha256, intent.parameterSha256, intent.requestSha256,
    intent.expiresAt, intent.maxUses];
}

function evidenceScalars(evidence: CapabilityApprovalEvidence): Scalar[] {
  return [evidence.schemaVersion, evidence.kind, evidence.verifierId, evidence.verdict,
    evidence.permissionRequestId, evidence.permissionDecisionId, evidence.authoritySessionId,
    evidence.requestSha256, evidence.intentSha256, evidence.expiresAt];
}

type Scalar = string | number | null;
function digest(domain: string, fields: readonly Scalar[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  for (const field of fields) {
    const encoded = field === null ? "<null>" : `${typeof field}:${field}`;
    hash.update(String(Buffer.byteLength(encoded, "utf8")), "utf8");
    hash.update(":", "utf8");
    hash.update(encoded, "utf8");
  }
  return hash.digest("hex");
}

function ownRecord<const Fields extends readonly string[]>(value: unknown, fields: Fields): Record<Fields[number], unknown> {
  try {
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw failed();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) throw failed();
    const result = {} as Record<Fields[number], unknown>;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined || !("value" in descriptor)) throw failed();
      result[field as Fields[number]] = descriptor.value;
    }
    return result;
  } catch {
    throw failed();
  }
}

function freezeBundle(state: CapabilityJournalState, receipt: CapabilityJournalReceipt, predecessor?: { state: CapabilityJournalState; receipt: CapabilityJournalReceipt }): JournalBundle {
  return deepFreeze({ state, receipt, predecessor: predecessor === undefined ? null : predecessor });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function failed(): CapabilityJournalCodecError {
  return new CapabilityJournalCodecError();
}
