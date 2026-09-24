import { createHash } from "node:crypto";
import {
  CapabilityGrantIndexSchema,
  type CapabilityGrantIndex,
} from "@cadrane/contracts/capability-journal";
import { validateCapabilityJournalBundle } from "./capability-journal-codec.js";

export class CapabilityGrantIndexError extends Error {
  readonly code = "CAPABILITY_GRANT_INDEX_FAILED" as const;

  constructor() {
    super("Capability grant index operation failed.");
    this.name = "CapabilityGrantIndexError";
  }
}

const INDEX_FIELDS = [
  "schemaVersion", "kind", "indexRole", "indexRecordId", "spaceId", "targetId",
  "grantRecordId", "grantId", "intentSha256", "approvalProofSha256",
  "issueLifecycleId", "issueOperationId", "issueReceiptId",
] as const;

export function prepareCapabilityGrantIndexes(issuedBundle: unknown): readonly [CapabilityGrantIndex, CapabilityGrantIndex] {
  try {
    const issued = issuedOnly(issuedBundle);
    return freezeIndexes(deriveIndexes(issued));
  } catch {
    throw failed();
  }
}

export function validateCapabilityGrantIndexes(issuedBundle: unknown, indexes: unknown): readonly [CapabilityGrantIndex, CapabilityGrantIndex] {
  try {
    const issued = issuedOnly(issuedBundle);
    const decoded = decodeIndexes(indexes);
    const expected = deriveIndexes(issued);
    for (const position of [0, 1] as const) {
      if (!sameIndex(decoded[position], expected[position])) throw failed();
    }
    return freezeIndexes(decoded);
  } catch {
    throw failed();
  }
}

function issuedOnly(bundle: unknown) {
  const issued = validateCapabilityJournalBundle(bundle);
  if (issued.state.lifecycle !== "issued" || issued.state.stateRevision !== 1 || issued.state.terminal !== null || issued.predecessor !== null) throw failed();
  return issued;
}

function deriveIndexes(issued: ReturnType<typeof issuedOnly>): readonly [CapabilityGrantIndex, CapabilityGrantIndex] {
  const state = issued.state;
  const roles = identityRoles(issued);
  const request = indexFor("request", state.intent.permissionRequestId, state, roles);
  const decision = indexFor("decision", state.intent.permissionDecisionId, state, roles);
  if (request.indexRecordId === decision.indexRecordId) throw failed();
  return [request, decision];
}

function indexFor(role: "request" | "decision", targetId: string, state: ReturnType<typeof issuedOnly>["state"], roles: ReadonlySet<string>): CapabilityGrantIndex {
  const indexRecordId = indexId(state.intent.spaceId, role, targetId);
  if (roles.has(indexRecordId)) throw failed();
  return CapabilityGrantIndexSchema.parse({
    schemaVersion: 1, kind: "capability-grant-index", indexRole: role, indexRecordId,
    spaceId: state.intent.spaceId, targetId, grantRecordId: state.grantRecordId,
    grantId: state.grantId, intentSha256: state.intentSha256,
    approvalProofSha256: state.approvalProofSha256, issueLifecycleId: state.issueLifecycleId,
    issueOperationId: state.issueOperationId, issueReceiptId: state.issueReceiptId,
  });
}

function identityRoles(issued: ReturnType<typeof issuedOnly>): ReadonlySet<string> {
  const state = issued.state;
  return new Set([
    state.grantRecordId, state.grantId, state.intent.permissionRequestId,
    state.intent.permissionDecisionId, state.intent.spaceId, state.intent.runId,
    state.intent.effectId, state.intent.authoritySessionId, state.approvalVerifierId,
    state.issueLifecycleId, state.issueOperationId, state.issueReceiptId,
  ]);
}

function indexId(spaceId: string, role: "request" | "decision", targetId: string): string {
  const digest = createHash("sha256");
  digest.update("switchboard/capability-grant-index/v1", "utf8");
  for (const value of [spaceId, role, targetId]) {
    const bytes = Buffer.from(value, "utf8");
    digest.update(String(bytes.length), "ascii");
    digest.update(":", "ascii");
    digest.update(bytes);
  }
  const bytes = digest.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeIndexes(value: unknown): readonly [CapabilityGrantIndex, CapabilityGrantIndex] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failed();
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length?.value !== 2 || Reflect.ownKeys(value).length !== 3) throw failed();
    const first = Object.getOwnPropertyDescriptor(value, "0");
    const second = Object.getOwnPropertyDescriptor(value, "1");
    if (first === undefined || second === undefined || !("value" in first) || !("value" in second)) throw failed();
    return [decodeIndex(first.value), decodeIndex(second.value)];
  } catch {
    throw failed();
  }
}

function decodeIndex(value: unknown): CapabilityGrantIndex {
  return CapabilityGrantIndexSchema.parse(ownRecord(value, INDEX_FIELDS));
}

function sameIndex(left: CapabilityGrantIndex, right: CapabilityGrantIndex): boolean {
  return INDEX_FIELDS.every((field) => left[field] === right[field]);
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

function freezeIndexes(indexes: readonly [CapabilityGrantIndex, CapabilityGrantIndex]): readonly [CapabilityGrantIndex, CapabilityGrantIndex] {
  return Object.freeze([Object.freeze({ ...indexes[0] }), Object.freeze({ ...indexes[1] })]) as readonly [CapabilityGrantIndex, CapabilityGrantIndex];
}

function failed(): CapabilityGrantIndexError {
  return new CapabilityGrantIndexError();
}
