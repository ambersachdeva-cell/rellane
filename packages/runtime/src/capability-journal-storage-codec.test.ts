import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalCapabilityIntentSha256 } from "./capability-intent-binding.js";
import { prepareIssuedCapabilityJournal, prepareTerminalCapabilityJournal } from "./capability-journal-codec.js";
import {
  CapabilityJournalStorageCodecError,
  decodeOwnedCapabilityJournalStorageBundle,
  disposeEncodedCapabilityJournalStorageBundle,
  encodeCapabilityJournalStorageBundle,
  type EncodedCapabilityJournalStorageBundle,
  type EncodedCapabilityStorageRecord,
} from "./capability-journal-storage-codec.js";

const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const hash = "a".repeat(64);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function issued(seed = 0) {
  const keyed = (number: number) => id(number + seed);
  const intent = {
    schemaVersion: 1, permissionRequestId: keyed(1), permissionDecisionId: keyed(2), spaceId: keyed(3),
    runId: keyed(4), effectId: keyed(5), effectRevision: 1, effectKind: "export-artifact",
    authoritySessionId: keyed(6), subjectBindingSha256: hash, targetBindingSha256: hash,
    parameterSha256: hash, requestSha256: hash, expiresAt: "2026-08-03T00:05:00.000Z", maxUses: 1,
  } as const;
  return prepareIssuedCapabilityJournal({
    grantRecordId: keyed(15), grantId: keyed(7), intent,
    approvalEvidence: {
      schemaVersion: 1, kind: "capability-approval-evidence", verifierId: keyed(8), verdict: "approved",
      permissionRequestId: keyed(1), permissionDecisionId: keyed(2), authoritySessionId: keyed(6),
      requestSha256: hash, intentSha256: canonicalCapabilityIntentSha256(intent), expiresAt: intent.expiresAt,
    },
    issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: keyed(9), issueOperationId: keyed(10), issueReceiptId: keyed(11),
  });
}

function terminal(lifecycle: "consumed" | "revoked" | "expired", seed = 0) {
  const start = issued(seed);
  return prepareTerminalCapabilityJournal({
    predecessor: { state: start.state, receipt: start.receipt }, lifecycle,
    lifecycleId: id(12 + seed), operationId: id(13 + seed), receiptId: id(14 + seed),
    recordedAt: lifecycle === "expired" ? "2026-08-03T00:05:00.000Z" : "2026-08-03T00:04:59.999Z",
  });
}

type MutableRecord = {
  entityKind: EncodedCapabilityStorageRecord["entityKind"];
  id: string;
  recordRevision: 1 | 2;
  plaintext: Uint8Array;
};
type MutableBundle = { state: MutableRecord; receipt: MutableRecord; indexes: MutableRecord[] };
type MutableInput = { current: MutableBundle; predecessor: MutableBundle | null };

function cloneRecord(record: EncodedCapabilityStorageRecord): MutableRecord {
  return { entityKind: record.entityKind, id: record.id, recordRevision: record.recordRevision, plaintext: new Uint8Array(record.plaintext) };
}
function clone(bundle: EncodedCapabilityJournalStorageBundle): MutableBundle {
  return { state: cloneRecord(bundle.state), receipt: cloneRecord(bundle.receipt), indexes: bundle.indexes.map(cloneRecord) };
}
function inputFor(bundle: EncodedCapabilityJournalStorageBundle, predecessor: EncodedCapabilityJournalStorageBundle | null = null): MutableInput {
  return { current: clone(bundle), predecessor: predecessor === null ? null : clone(predecessor) };
}
function allRecords(input: MutableInput): MutableRecord[] {
  return [...records(input.current), ...(input.predecessor === null ? [] : records(input.predecessor))];
}
function records(bundle: MutableBundle): MutableRecord[] { return [bundle.state, bundle.receipt, ...bundle.indexes]; }
function assertNonzero(bytes: Uint8Array): void { expect(bytes.some((byte) => byte !== 0)).toBe(true); }
function assertWiped(recordsToCheck: readonly MutableRecord[]): void {
  for (const record of recordsToCheck) expect(record.plaintext.every((byte) => byte === 0)).toBe(true);
}
function expectFailure(action: () => unknown): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CapabilityJournalStorageCodecError);
  expect(error).toMatchObject({ code: "CAPABILITY_JOURNAL_STORAGE_CODEC_FAILED", message: "Capability journal storage codec operation failed." });
}
function mutateText(record: MutableRecord, mutate: (text: string) => string): void {
  record.plaintext = textEncoder.encode(mutate(textDecoder.decode(record.plaintext)));
}
function expectRejectAndWipe(input: MutableInput, options: { allowZero?: boolean } = {}): void {
  const supplied = allRecords(input);
  for (const record of supplied) if (!options.allowZero || record.plaintext.byteLength !== 0) assertNonzero(record.plaintext);
  expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(input));
  assertWiped(supplied);
}
function sameEncoded(left: EncodedCapabilityJournalStorageBundle, right: EncodedCapabilityJournalStorageBundle): void {
  for (const [a, b] of [[left.state, right.state], [left.receipt, right.receipt], ...left.indexes.map((item, index) => [item, right.indexes[index]!] as const)]) {
    expect(a.entityKind).toBe(b.entityKind); expect(a.id).toBe(b.id); expect(a.recordRevision).toBe(b.recordRevision); expect([...a.plaintext]).toEqual([...b.plaintext]);
  }
}
function duplicate(text: string, marker: string): string {
  const result = text.replace(marker, `${marker}${marker}`);
  expect(JSON.parse(result)).toBeDefined();
  return result;
}
function duplicateField(text: string, objectPrefix: string, field: string, value: string): string {
  const marker = `${objectPrefix}"${field}":${value},`;
  const result = text.replace(marker, `${marker}"${field}":${value},`);
  expect(JSON.parse(result)).toBeDefined();
  return result;
}
function reversed<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).reverse()) as T; }

describe("private capability journal storage codec", () => {
  it("deterministically maps an issued journal into exactly four canonical records despite relevant insertion order", () => {
    const start = issued();
    const reordered = {
      predecessor: null,
      receipt: reversed({ ...start.receipt }),
      state: reversed({ ...start.state, intent: reversed({ ...start.state.intent }), approvalEvidence: reversed({ ...start.state.approvalEvidence }) }),
    };
    const encoded = encodeCapabilityJournalStorageBundle(start);
    const again = encodeCapabilityJournalStorageBundle(reordered);
    sameEncoded(encoded, again);
    expect(encoded).toMatchObject({
      state: { entityKind: "capability-grant", id: start.state.grantRecordId, recordRevision: 1 },
      receipt: { entityKind: "capability-grant-receipt", id: start.state.issueReceiptId, recordRevision: 1 },
    });
    expect(encoded.indexes).toHaveLength(2);
    expect(encoded.indexes.map((record) => record.entityKind)).toEqual(["capability-grant-index", "capability-grant-index"]);
    expect(encoded.indexes.map((record) => record.recordRevision)).toEqual([1, 1]);
    const decoded = decodeOwnedCapabilityJournalStorageBundle(inputFor(encoded));
    expect(decoded.bundle).toEqual(start);
    expect(decoded.indexes.map((index) => index.indexRole)).toEqual(["request", "decision"]);
  });

  it("maps consumed, revoked, and expired terminals into exactly two records with their issued predecessor", () => {
    for (const lifecycle of ["consumed", "revoked", "expired"] as const) {
      const current = terminal(lifecycle);
      const prior = encodeCapabilityJournalStorageBundle(issued());
      const encoded = encodeCapabilityJournalStorageBundle(current);
      expect(encoded.indexes).toEqual([]);
      expect(encoded.state).toMatchObject({ entityKind: "capability-grant", id: current.state.grantRecordId, recordRevision: 2 });
      expect(encoded.receipt).toMatchObject({ entityKind: "capability-grant-receipt", id: current.state.terminal!.receiptId, recordRevision: 1 });
      expect(decodeOwnedCapabilityJournalStorageBundle(inputFor(encoded, prior)).bundle).toEqual(current);
    }
  });

  it("rejects every noncanonical JSON spelling without accepting parsed semantic equivalents", () => {
    const encoded = encodeCapabilityJournalStorageBundle(issued());
    const jsonCases: Array<{ name: string; mutate: (input: MutableInput) => void }> = [
      { name: "whitespace", mutate: ({ current }) => mutateText(current.state, (text) => ` ${text}`) },
      { name: "root reorder", mutate: ({ current }) => mutateText(current.state, (text) => JSON.stringify(reversed(JSON.parse(text) as Record<string, unknown>))) },
      { name: "duplicate root", mutate: ({ current }) => mutateText(current.state, (text) => duplicate(text, '"schemaVersion":1,')) },
      { name: "duplicate intent", mutate: ({ current }) => mutateText(current.state, (text) => duplicateField(text, '"intent":{', "schemaVersion", "1")) },
      { name: "duplicate evidence", mutate: ({ current }) => mutateText(current.state, (text) => duplicateField(text, '"approvalEvidence":{', "schemaVersion", "1")) },
      { name: "escaped canonical field", mutate: ({ current }) => mutateText(current.state, (text) => text.replace('"kind"', '"\\u006b\\u0069\\u006e\\u0064"')) },
      { name: "BOM", mutate: ({ current }) => { current.state.plaintext = new Uint8Array([0xef, 0xbb, 0xbf, ...current.state.plaintext]); } },
      { name: "invalid UTF-8", mutate: ({ current }) => { current.state.plaintext = new Uint8Array([0xff]); } },
      { name: "trailing bytes", mutate: ({ current }) => { current.state.plaintext = new Uint8Array([...current.state.plaintext, 0x20]); } },
      { name: "malformed JSON", mutate: ({ current }) => { current.state.plaintext = textEncoder.encode("{"); } },
      { name: "zero length", mutate: ({ current }) => { current.state.plaintext = new Uint8Array(0); } },
    ];
    for (const testCase of jsonCases) expectRejectAndWipe(applyMutation(inputFor(encoded), testCase.mutate), { allowZero: testCase.name === "zero length" });

    for (const index of [0, 1]) {
      expectRejectAndWipe(applyMutation(inputFor(encoded), ({ current }) => mutateText(current.indexes[index]!, (text) => duplicate(text, '"schemaVersion":1,'))));
    }
    expectRejectAndWipe(applyMutation(inputFor(encoded), ({ current }) => mutateText(current.receipt, (text) => duplicate(text, '"schemaVersion":1,'))));
    const terminalEncoded = encodeCapabilityJournalStorageBundle(terminal("revoked"));
    const predecessor = encodeCapabilityJournalStorageBundle(issued());
    expectRejectAndWipe(applyMutation(inputFor(terminalEncoded, predecessor), ({ current }) => mutateText(current.state, (text) => duplicateField(text, '"terminal":{', "lifecycle", '"revoked"'))));
  });

  it("enforces bounded plaintext without promising wipe of rejected oversize views", () => {
    const input = inputFor(encodeCapabilityJournalStorageBundle(issued()));
    input.current.state.plaintext = new Uint8Array(65_537).fill(7);
    expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(input));
    expect(input.current.state.plaintext[0]).toBe(7);
    assertWiped([input.current.receipt, ...input.current.indexes]);
  });

  it("rejects record metadata, foreign state/receipt/indexes, and cross-chain substitutions", () => {
    const a = encodeCapabilityJournalStorageBundle(issued());
    const b = encodeCapabilityJournalStorageBundle(issued(100));
    const cases: Array<(input: MutableInput) => void> = [
      ({ current }) => { current.state.entityKind = "capability-grant-receipt"; },
      ({ current }) => { current.receipt.entityKind = "capability-grant"; },
      ({ current }) => { current.indexes[0]!.entityKind = "capability-grant"; },
      ({ current }) => { current.state.id = id(99); }, ({ current }) => { current.receipt.id = id(99); }, ({ current }) => { current.indexes[1]!.id = id(99); },
      ({ current }) => { current.state.recordRevision = 2; }, ({ current }) => { current.receipt.recordRevision = 2; }, ({ current }) => { current.indexes[0]!.recordRevision = 2; },
      ({ current }) => { current.state = clone(b).state; }, ({ current }) => { current.receipt = clone(b).receipt; },
      ({ current }) => { current.indexes[0] = clone(b).indexes[0]!; }, ({ current }) => { current.indexes[1] = clone(b).indexes[1]!; },
    ];
    for (const mutate of cases) expectRejectAndWipe(applyMutation(inputFor(a), mutate));
  });

  it("requires exact ordered indexes and an exact issued predecessor", () => {
    const start = issued(); const prior = encodeCapabilityJournalStorageBundle(start); const other = encodeCapabilityJournalStorageBundle(issued(100));
    const revoked = encodeCapabilityJournalStorageBundle(terminal("revoked"));
    const terminalCurrent = encodeCapabilityJournalStorageBundle(prepareTerminalCapabilityJournal({ predecessor: { state: start.state, receipt: start.receipt }, lifecycle: "revoked", lifecycleId: id(12), operationId: id(13), receiptId: id(14), recordedAt: "2026-08-03T00:04:59.999Z" }));
    const malformed: Array<(input: MutableInput) => void> = [
      ({ current }) => { [current.indexes[0], current.indexes[1]] = [current.indexes[1]!, current.indexes[0]!]; },
      ({ current }) => { current.indexes = [current.indexes[0]!]; },
      ({ current }) => { current.indexes.push(cloneRecord(current.indexes[0]!)); },
      ({ current }) => { current.indexes = [current.indexes[0]!, current.indexes[0]!]; },
    ];
    for (const mutate of malformed) expectRejectAndWipe(applyMutation(inputFor(prior), mutate));
    expectRejectAndWipe(inputFor(prior, prior));
    expectRejectAndWipe(inputFor(terminalCurrent));
    expectRejectAndWipe(inputFor(terminalCurrent, other));
    expectRejectAndWipe(inputFor(terminalCurrent, revoked));
  });

  it("rejects hostile native views and hostile shape mechanics while consuming every valid-sized discovered buffer", () => {
    const encoded = encodeCapabilityJournalStorageBundle(issued());
    const hostileCases: Array<(input: MutableInput) => unknown> = [
      ({ current }) => { current.state.plaintext = Buffer.from(current.state.plaintext); return { current, predecessor: null }; },
      ({ current }) => { class Bytes extends Uint8Array {} current.state.plaintext = new Bytes(current.state.plaintext); return { current, predecessor: null }; },
      ({ current }) => { if (typeof SharedArrayBuffer === "undefined") return { current, predecessor: null }; const buffer = new SharedArrayBuffer(current.state.plaintext.byteLength); new Uint8Array(buffer).set(current.state.plaintext); current.state.plaintext = new Uint8Array(buffer); return { current, predecessor: null }; },
      ({ current }) => ({ current: new Proxy(current, { getPrototypeOf() { throw new Error("hostile"); } }), predecessor: null }),
      ({ current }) => { Object.defineProperty(current.state, "plaintext", { enumerable: true, get() { throw new Error("hostile"); } }); return { current, predecessor: null }; },
      ({ current }) => { Object.defineProperty(current.state.plaintext, "extra", { value: true }); return { current, predecessor: null }; },
      ({ current }) => { Object.defineProperty(current.receipt.plaintext, Symbol("extra"), { value: true }); return { current, predecessor: null }; },
      ({ current }) => { Object.defineProperty(current.state.plaintext, "fill", { value() { throw new Error("spoof"); } }); return { current, predecessor: null }; },
    ];
    for (const hostile of hostileCases) {
      const input = inputFor(encoded); const result = hostile(input);
      expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(result));
      for (const record of [input.current.receipt, ...input.current.indexes]) expect(record.plaintext.every((byte) => byte === 0)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(input.current.state, "plaintext");
      if (descriptor !== undefined && "value" in descriptor && isNonsharedPlainBytes(descriptor.value)) expect(descriptor.value.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("wipes all valid-sized supplied buffers even when an early record, index array, or outer shape is invalid", () => {
    const terminalCurrent = encodeCapabilityJournalStorageBundle(terminal("revoked"));
    const prior = encodeCapabilityJournalStorageBundle(issued());
    const early = inputFor(terminalCurrent, prior);
    early.current.state.entityKind = "capability-grant-index";
    expectRejectAndWipe(early);
    const threeIndexes = inputFor(encodeCapabilityJournalStorageBundle(issued()));
    threeIndexes.current.indexes.push(cloneRecord(threeIndexes.current.indexes[0]!));
    expectRejectAndWipe(threeIndexes);
    const sparse = inputFor(encodeCapabilityJournalStorageBundle(issued()));
    delete sparse.current.indexes[1];
    const sparseRecords = [sparse.current.state, sparse.current.receipt, sparse.current.indexes[0]!];
    sparseRecords.forEach((record) => assertNonzero(record.plaintext));
    expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(sparse));
    assertWiped(sparseRecords);
    const wrongPrototype = inputFor(encodeCapabilityJournalStorageBundle(issued()));
    Object.setPrototypeOf(wrongPrototype.current, null);
    expectRejectAndWipe(wrongPrototype);
    const wrongIndexPrototype = inputFor(encodeCapabilityJournalStorageBundle(issued()));
    const indexPrototypeRecords = [wrongIndexPrototype.current.state, wrongIndexPrototype.current.receipt, ...wrongIndexPrototype.current.indexes];
    indexPrototypeRecords.forEach((record) => assertNonzero(record.plaintext));
    Object.setPrototypeOf(wrongIndexPrototype.current.indexes, null);
    expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(wrongIndexPrototype));
    assertWiped(indexPrototypeRecords);
    const bounded = inputFor(encodeCapabilityJournalStorageBundle(issued()), encodeCapabilityJournalStorageBundle(issued()));
    for (const bundle of [bounded.current, bounded.predecessor!]) {
      while (bundle.indexes.length < 16) bundle.indexes.push(cloneRecord(bundle.indexes[0]!));
      bundle.indexes[1]!.plaintext = bundle.state.plaintext;
    }
    const boundedUnique = [...new Set(allRecords(bounded).map((record) => record.plaintext))];
    expect(boundedUnique).toHaveLength(34);
    boundedUnique.forEach(assertNonzero);
    expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(bounded));
    boundedUnique.forEach((bytes) => expect(bytes.every((byte) => byte === 0)).toBe(true));
    const unbounded = inputFor(encodeCapabilityJournalStorageBundle(issued()));
    while (unbounded.current.indexes.length < 17) unbounded.current.indexes.push(cloneRecord(unbounded.current.indexes[0]!));
    const beyondBound = unbounded.current.indexes[16]!.plaintext;
    assertNonzero(beyondBound);
    expectFailure(() => decodeOwnedCapabilityJournalStorageBundle(unbounded));
    expect(beyondBound.some((byte) => byte !== 0)).toBe(true);
  });

  it("returns independently owned deeply frozen data and disposal wipes ordinary output without throwing for hostile input", () => {
    const encoded = encodeCapabilityJournalStorageBundle(issued());
    const input = inputFor(encoded);
    for (const [supplied, original] of [[input.current.state, encoded.state], [input.current.receipt, encoded.receipt], ...input.current.indexes.map((record, index) => [record, encoded.indexes[index]!] as const)]) {
      expect(supplied.plaintext).not.toBe(original.plaintext);
      expect(supplied.plaintext.buffer).not.toBe(original.plaintext.buffer);
    }
    const decoded = decodeOwnedCapabilityJournalStorageBundle(input);
    assertWiped(allRecords(input));
    for (const record of [encoded.state, encoded.receipt, ...encoded.indexes]) assertNonzero(record.plaintext);
    expect(decoded.bundle.state.intent.effectId).toBe(id(5));
    for (const value of [decoded, decoded.bundle, decoded.bundle.state, decoded.bundle.state.intent, decoded.bundle.state.approvalEvidence, decoded.bundle.receipt, decoded.indexes]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (decoded.bundle.state.intent as { effectId: string }).effectId = id(99); }).toThrow();
    disposeEncodedCapabilityJournalStorageBundle(encoded);
    for (const record of [encoded.state, encoded.receipt, ...encoded.indexes]) expect(record.plaintext.every((byte) => byte === 0)).toBe(true);
    const hostile = { state: {}, receipt: {}, indexes: [] };
    Object.defineProperty(hostile, "state", { enumerable: true, get() { throw new Error("hostile"); } });
    expect(() => disposeEncodedCapabilityJournalStorageBundle(hostile)).not.toThrow();
  });

  it("uses fixed public errors, remains private, and retains explicit encoder and durable gate bounds", () => {
    expectFailure(() => encodeCapabilityJournalStorageBundle({}));
    const source = readFileSync(new URL("./capability-journal-storage-codec.ts", import.meta.url), "utf8");
    const runtimeBarrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const contractsBarrel = readFileSync(new URL("../../contracts/src/index.ts", import.meta.url), "utf8");
    const gate = readFileSync(new URL("../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8");
    const packageGate = readFileSync(new URL("../../../apps/desktop/scripts/inspect-storage-capability-package.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:fs|path|os|http|https|child_process)|electron|\bipc\b|process\.env|set(?:Timeout|Interval)|\bfetch\b|broker|key-provider/i);
    expect(`${runtimeBarrel}\n${contractsBarrel}`).not.toMatch(/capability-journal-storage-codec/);
    expect(`${gate}\n${packageGate}`).not.toMatch(/capability-journal-storage-codec|ipc|native/i);
    expect(gate).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
    expect(packageGate).toMatch(/durableSpacesEnabled:\s*false/);
    expect(source).toMatch(/MAX_RECORD\s*=\s*65_536/);
    expect(source).toMatch(/assertEncodedTotal\(outputs, MAX_(?:ISSUED|TERMINAL)\)/);
  });
});

function applyMutation(input: MutableInput, mutate: (input: MutableInput) => void): MutableInput { mutate(input); return input; }

function isNonsharedPlainBytes(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype || value.byteLength > 65_536) return false;
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) return false;
  return true;
}
