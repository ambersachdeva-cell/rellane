import { describe, expect, it } from "vitest";
import {
  CapabilityJournalCodecError,
  prepareIssuedCapabilityJournal,
  prepareTerminalCapabilityJournal,
  validateCapabilityJournalBundle,
} from "./capability-journal-codec.js";
import { canonicalCapabilityIntentSha256 } from "./capability-intent-binding.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const hash = "a".repeat(64);
const issuedInput = (seed = 0) => {
  const keyed = (value: number) => id(value + seed);
  return {
  grantRecordId: keyed(15),
  grantId: keyed(7),
  intent: {
    schemaVersion: 1, permissionRequestId: keyed(1), permissionDecisionId: keyed(2), spaceId: keyed(3),
    runId: keyed(4), effectId: keyed(5), effectRevision: 1, effectKind: "export-artifact",
    authoritySessionId: keyed(6), subjectBindingSha256: hash, targetBindingSha256: hash,
    parameterSha256: hash, requestSha256: hash, expiresAt: "2026-08-03T00:05:00.000Z", maxUses: 1,
  },
  approvalEvidence: {
    schemaVersion: 1, kind: "capability-approval-evidence", verifierId: keyed(8), verdict: "approved",
    permissionRequestId: keyed(1), permissionDecisionId: keyed(2), authoritySessionId: keyed(6),
    requestSha256: hash, intentSha256: "b".repeat(64), expiresAt: "2026-08-03T00:05:00.000Z",
  },
  issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: keyed(9), issueOperationId: keyed(10), issueReceiptId: keyed(11),
};
};

function inputWithBoundEvidence(seed = 0) {
  const input = issuedInput(seed);
  const issued = prepareIssuedCapabilityJournal({ ...input, approvalEvidence: { ...input.approvalEvidence, intentSha256: canonicalCapabilityIntentSha256(input.intent) } });
  return { input, issued };
}

describe("capability journal codec", () => {
  it("prepares deterministic, deeply frozen issued bundles", () => {
    const { issued } = inputWithBoundEvidence();
    const again = prepareIssuedCapabilityJournal({ ...issuedInput(), approvalEvidence: { ...issuedInput().approvalEvidence, intentSha256: issued.state.intentSha256 } });
    expect(issued).toEqual(again);
    expect(issued.predecessor).toBeNull();
    expect(Object.isFrozen(issued.state.intent)).toBe(true);
    expect(() => { (issued.state.intent as { effectId: string }).effectId = id(99); }).toThrow();
    expect(validateCapabilityJournalBundle(issued)).toEqual(issued);
  });

  it("requires a distinct explicit grant record identifier at preparation", () => {
    const { input } = inputWithBoundEvidence();
    const bound = { ...input, approvalEvidence: { ...input.approvalEvidence, intentSha256: canonicalCapabilityIntentSha256(input.intent) } };
    const { grantRecordId: _missing, ...missing } = bound;
    expectFailure(() => prepareIssuedCapabilityJournal(missing));
    expectFailure(() => prepareIssuedCapabilityJournal({ ...bound, extra: true }));
    for (const grantRecordId of [bound.grantId, bound.intent.permissionRequestId, bound.intent.permissionDecisionId, bound.intent.spaceId, bound.intent.runId, bound.intent.effectId, bound.intent.authoritySessionId, bound.approvalEvidence.verifierId, bound.issueLifecycleId, bound.issueOperationId, bound.issueReceiptId]) {
      expectFailure(() => prepareIssuedCapabilityJournal({ ...bound, grantRecordId }));
    }
  });

  it("prepares and validates every terminal lifecycle with its exact issued predecessor", () => {
    const { issued } = inputWithBoundEvidence();
    for (const [lifecycle, recordedAt] of [
      ["consumed", "2026-08-03T00:04:59.999Z"], ["revoked", "2026-08-03T00:04:59.999Z"], ["expired", "2026-08-03T00:05:00.000Z"],
    ] as const) {
      const terminal = prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle, lifecycleId: id(12), operationId: id(13), receiptId: id(14), recordedAt });
      expect(terminal.state.lifecycle).toBe(lifecycle);
      expect(terminal.receipt.priorStateSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(validateCapabilityJournalBundle(terminal)).toEqual(terminal);
    }
  });

  it("rejects substitutions, duplicate transitions, hostile shapes, and post-validation mutation", () => {
    const { issued } = inputWithBoundEvidence();
    const terminal = prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle: "revoked", lifecycleId: id(12), operationId: id(13), receiptId: id(14), recordedAt: "2026-08-03T00:04:59.999Z" });
    const invalids: unknown[] = [
      { ...issued, receipt: { ...issued.receipt, grantId: id(99) } },
      { ...terminal, predecessor: { state: terminal.state, receipt: terminal.receipt } },
      { ...issued, extra: true },
      new Proxy(issued, { getPrototypeOf() { throw new Error("hostile"); } }),
      { ...issued, state: { ...issued.state, intent: Object.create(issued.state.intent) } },
    ];
    for (const invalid of invalids) expect(() => validateCapabilityJournalBundle(invalid)).toThrow(CapabilityJournalCodecError);
  });

  it("binds every receipt relation and leaves valid evidence reusable after rejected mutations", () => {
    const { issued } = inputWithBoundEvidence();
    const terminal = prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle: "consumed", lifecycleId: id(12), operationId: id(13), receiptId: id(14), recordedAt: "2026-08-03T00:04:59.999Z" });
    const mutations = [
      { lifecycle: "revoked" }, { stateRevision: 1 }, { receiptId: id(99) }, { operationId: id(99) },
      { lifecycleId: id(99) }, { recordedAt: "2026-08-03T00:04:59.998Z" }, { spaceId: id(99) },
      { grantId: id(99) }, { grantRecordId: id(99) }, { intentSha256: "b".repeat(64) },
      { approvalProofSha256: "b".repeat(64) }, { priorStateSha256: "b".repeat(64) },
      { stateSha256: "b".repeat(64) }, { lifecycleBindingSha256: "b".repeat(64) },
      { effectExecution: "performed" },
    ];
    for (const mutation of mutations) expect(() => validateCapabilityJournalBundle({ ...terminal, receipt: { ...terminal.receipt, ...mutation } })).toThrow(CapabilityJournalCodecError);
    expect(validateCapabilityJournalBundle(terminal)).toEqual(terminal);
  });

  it("has no runtime I/O, environment, IPC, or timer dependency", () => {
    const source = readFileSync(fileURLToPath(new URL("./capability-journal-codec.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/node:(?:fs|path|os|http|https|child_process)|electron|\bipc\b|process\.env|set(?:Timeout|Interval)|\bfetch\b/i);
  });

  it("uses canonical field order, not caller insertion order", () => {
    const { input, issued } = inputWithBoundEvidence();
    const bound = { ...input, approvalEvidence: { ...input.approvalEvidence, intentSha256: issued.state.intentSha256 } };
    const reversed = Object.fromEntries(Object.entries({
      ...bound,
      intent: Object.fromEntries(Object.entries(bound.intent).reverse()),
      approvalEvidence: Object.fromEntries(Object.entries(bound.approvalEvidence).reverse()),
    }).reverse());
    expect(prepareIssuedCapabilityJournal(reversed)).toEqual(issued);
  });

  it("rejects every state role mutation, nested substitution, and malformed state shape", () => {
    const { issued } = inputWithBoundEvidence();
    const replacement = (key: string, value: unknown): unknown => {
      if (key === "effectRevision") return 2;
      if (key === "effectKind") return "delete-record";
      if (key === "expiresAt" || key.endsWith("At")) return "2026-08-03T00:00:01.000Z";
      if (key.includes("Sha256")) return "b".repeat(64);
      if (key === "schemaVersion" || key === "stateRevision") return 2;
      if (key === "maxUses") return 2;
      if (key === "lifecycle") return "revoked";
      if (key === "kind") return "wrong-kind";
      return typeof value === "number" ? 2 : id(99);
    };
    const stateFields = Object.entries(issued.state).filter(([key]) => !["intent", "approvalEvidence", "terminal"].includes(key));
    const invalids: unknown[] = stateFields.map(([key, value]) => ({ ...issued, state: { ...issued.state, [key]: replacement(key, value) } }));
    for (const [key, value] of Object.entries(issued.state.intent)) invalids.push({ ...issued, state: { ...issued.state, intent: { ...issued.state.intent, [key]: replacement(key, value) } } });
    for (const [key, value] of Object.entries(issued.state.approvalEvidence)) invalids.push({ ...issued, state: { ...issued.state, approvalEvidence: { ...issued.state.approvalEvidence, [key]: replacement(key, value) } } });
    invalids.push({ ...issued, state: { ...issued.state, terminal: { lifecycle: "revoked", lifecycleId: id(12), operationId: id(13), receiptId: id(14) } } });
    invalids.push({ ...issued, state: { ...issued.state, extra: true } });
    const { issueReceiptId: _removed, ...missing } = issued.state;
    invalids.push({ ...issued, state: missing });
    for (const invalid of invalids) expectFailure(() => validateCapabilityJournalBundle(invalid));
    expect(validateCapabilityJournalBundle(issued)).toEqual(issued);
  });

  it("rejects cross-chain state, receipt, predecessor, and prior-hash swaps", () => {
    const a = inputWithBoundEvidence();
    const b = inputWithBoundEvidence(100);
    const terminalA = terminalFor(a.issued, "revoked", id(12), id(13), id(14), "2026-08-03T00:04:59.999Z");
    const terminalB = terminalFor(b.issued, "revoked", id(112), id(113), id(114), "2026-08-03T00:04:59.999Z");
    for (const invalid of [
      { ...terminalA, receipt: terminalB.receipt },
      { ...terminalA, predecessor: { state: b.issued.state, receipt: b.issued.receipt } },
      { ...terminalA, predecessor: { state: a.issued.state, receipt: b.issued.receipt } },
      { ...terminalA, receipt: { ...terminalA.receipt, priorStateSha256: terminalB.receipt.priorStateSha256 } },
      { ...terminalA, state: terminalB.state },
    ]) expectFailure(() => validateCapabilityJournalBundle(invalid));
    expect(validateCapabilityJournalBundle(terminalA)).toEqual(terminalA);
    expect(validateCapabilityJournalBundle(terminalB)).toEqual(terminalB);
  });

  it("allows repeat pure validation but refuses terminal predecessors", () => {
    const { issued } = inputWithBoundEvidence();
    const terminal = terminalFor(issued, "consumed", id(12), id(13), id(14), "2026-08-03T00:04:59.999Z");
    expect(validateCapabilityJournalBundle(terminal)).toEqual(terminal);
    expect(validateCapabilityJournalBundle(terminal)).toEqual(terminal);
    expectFailure(() => prepareTerminalCapabilityJournal({ predecessor: { state: terminal.state, receipt: terminal.receipt }, lifecycle: "revoked", lifecycleId: id(15), operationId: id(16), receiptId: id(17), recordedAt: "2026-08-03T00:04:59.999Z" }));
  });

  it("enforces exact expiry boundaries and retains only nonclaim receipts", () => {
    const { issued } = inputWithBoundEvidence();
    for (const lifecycle of ["consumed", "revoked"] as const) expectFailure(() => terminalFor(issued, lifecycle, id(12), id(13), id(14), "2026-08-03T00:05:00.000Z"));
    expectFailure(() => terminalFor(issued, "expired", id(12), id(13), id(14), "2026-08-03T00:04:59.999Z"));
    expect(issued.receipt.effectExecution).toBe("not-performed");
    for (const lifecycle of ["consumed", "revoked", "expired"] as const) {
      const time = lifecycle === "expired" ? "2026-08-03T00:05:00.000Z" : "2026-08-03T00:04:59.999Z";
      expect(terminalFor(issued, lifecycle, id(12), id(13), id(14), time).receipt.effectExecution).toBe("not-performed");
    }
  });

  it("rejects hostile accessor and proxy values at every decoded boundary", () => {
    const { issued } = inputWithBoundEvidence();
    const terminal = terminalFor(issued, "revoked", id(12), id(13), id(14), "2026-08-03T00:04:59.999Z");
    const accessor = (value: Record<string, unknown>, field: string) => {
      const copy = { ...value }; Object.defineProperty(copy, field, { enumerable: true, get: () => { throw new Error("hostile"); } }); return copy;
    };
    const proxy = <T extends object>(value: T) => new Proxy(value, { getPrototypeOf() { throw new Error("hostile"); } });
    const invalids = [
      proxy(issued), { ...issued, state: proxy(issued.state) }, { ...issued, receipt: proxy(issued.receipt) },
      { ...terminal, predecessor: proxy(terminal.predecessor!) }, { ...issued, state: { ...issued.state, intent: proxy(issued.state.intent) } },
      { ...issued, state: { ...issued.state, approvalEvidence: proxy(issued.state.approvalEvidence) } },
      { ...terminal, state: { ...terminal.state, terminal: proxy(terminal.state.terminal!) } },
      accessor(issued as unknown as Record<string, unknown>, "state"),
      { ...issued, state: accessor(issued.state as unknown as Record<string, unknown>, "grantId") },
      { ...issued, receipt: accessor(issued.receipt, "grantId") },
      { ...terminal, predecessor: accessor(terminal.predecessor! as unknown as Record<string, unknown>, "state") },
      { ...issued, state: { ...issued.state, intent: accessor(issued.state.intent, "effectId") } },
      { ...issued, state: { ...issued.state, approvalEvidence: accessor(issued.state.approvalEvidence, "verifierId") } },
      { ...terminal, state: { ...terminal.state, terminal: accessor(terminal.state.terminal! as unknown as Record<string, unknown>, "receiptId") } },
    ];
    for (const invalid of invalids) expectFailure(() => validateCapabilityJournalBundle(invalid));
  });

  it("owns recursively frozen output independently of caller and validator input", () => {
    const input = issuedInput(); input.approvalEvidence.intentSha256 = canonicalCapabilityIntentSha256(input.intent);
    const issued = prepareIssuedCapabilityJournal(input);
    const original = issued.state.intent.effectId;
    input.intent.effectId = id(99);
    expect(issued.state.intent.effectId).toBe(original);
    const clone = { state: structuredClone(issued.state), receipt: structuredClone(issued.receipt), predecessor: null };
    const validated = validateCapabilityJournalBundle(clone);
    clone.state.intent.effectId = id(98);
    expect(validated.state.intent.effectId).toBe(original);
    expect(validated.state).not.toBe(clone.state);
    for (const value of [validated, validated.state, validated.state.intent, validated.state.approvalEvidence, validated.receipt]) expect(Object.isFrozen(value)).toBe(true);
    const terminal = terminalFor(issued, "revoked", id(12), id(13), id(14), "2026-08-03T00:04:59.999Z");
    expect(Object.isFrozen(terminal.state.terminal)).toBe(true);
    expect(Object.isFrozen(terminal.predecessor)).toBe(true);
    expect(Object.isFrozen(terminal.predecessor!.state)).toBe(true);
  });

  it("remains private and both durable product gates remain literal false", () => {
    const runtimeBarrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const contractsBarrel = readFileSync(new URL("../../contracts/src/index.ts", import.meta.url), "utf8");
    const desktopGate = readFileSync(new URL("../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8");
    const packageInspector = readFileSync(new URL("../../../apps/desktop/scripts/inspect-storage-capability-package.mjs", import.meta.url), "utf8");
    expect(runtimeBarrel).not.toMatch(/capability-journal|capability-intent/);
    expect(contractsBarrel).not.toMatch(/capability-journal|capability-intent/);
    expect(`${runtimeBarrel}\n${desktopGate}\n${packageInspector}`).not.toMatch(/capability-journal-codec|ipc|native/i);
    expect(desktopGate).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
    expect(packageInspector).toMatch(/durableSpacesEnabled:\s*false/);
  });
});

function terminalFor(issued: ReturnType<typeof inputWithBoundEvidence>["issued"], lifecycle: "consumed" | "revoked" | "expired", lifecycleId: string, operationId: string, receiptId: string, recordedAt: string) {
  return prepareTerminalCapabilityJournal({ predecessor: { state: issued.state, receipt: issued.receipt }, lifecycle, lifecycleId, operationId, receiptId, recordedAt });
}

function expectFailure(action: () => unknown): void {
  expect(action).toThrow(CapabilityJournalCodecError);
  try { action(); } catch (error) { expect(error).toMatchObject({ message: "Capability journal codec operation failed." }); }
}
