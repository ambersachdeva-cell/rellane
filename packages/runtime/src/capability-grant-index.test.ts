import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalCapabilityIntentSha256 } from "./capability-intent-binding.js";
import { prepareIssuedCapabilityJournal, prepareTerminalCapabilityJournal } from "./capability-journal-codec.js";
import { CapabilityGrantIndexError, prepareCapabilityGrantIndexes, validateCapabilityGrantIndexes } from "./capability-grant-index.js";

const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const hash = "a".repeat(64);
function issued(seed = 0, ids?: { requestId: string; decisionId: string; spaceId: string }) {
  const keyed = (number: number) => id(number + seed);
  const requestId = ids?.requestId ?? keyed(1); const decisionId = ids?.decisionId ?? keyed(2); const spaceId = ids?.spaceId ?? keyed(3);
  const intent = { schemaVersion: 1, permissionRequestId: requestId, permissionDecisionId: decisionId, spaceId, runId: keyed(4), effectId: keyed(5), effectRevision: 1, effectKind: "export-artifact", authoritySessionId: keyed(6), subjectBindingSha256: hash, targetBindingSha256: hash, parameterSha256: hash, requestSha256: hash, expiresAt: "2026-08-03T00:05:00.000Z", maxUses: 1 } as const;
  return prepareIssuedCapabilityJournal({ grantRecordId: keyed(15), grantId: keyed(7), intent, approvalEvidence: { schemaVersion: 1, kind: "capability-approval-evidence", verifierId: keyed(8), verdict: "approved", permissionRequestId: requestId, permissionDecisionId: decisionId, authoritySessionId: keyed(6), requestSha256: hash, intentSha256: canonicalCapabilityIntentSha256(intent), expiresAt: intent.expiresAt }, issuedAt: "2026-08-03T00:00:00.000Z", issueLifecycleId: keyed(9), issueOperationId: keyed(10), issueReceiptId: keyed(11) });
}
function expectFailure(action: () => unknown) { expect(action).toThrow(CapabilityGrantIndexError); try { action(); } catch (error) { expect(error).toMatchObject({ message: "Capability grant index operation failed." }); } }

describe("private capability grant indexes", () => {
  it("derives deterministic ordered UUIDv8 request and decision indexes", () => {
    const bundle = issued(); const indexes = prepareCapabilityGrantIndexes(bundle);
    expect(indexes).toEqual(prepareCapabilityGrantIndexes(bundle));
    expect(indexes.map((index) => index.indexRole)).toEqual(["request", "decision"]);
    expect(indexes[0].indexRecordId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(indexes[0].indexRecordId).not.toBe(indexes[1].indexRecordId);
    expect(validateCapabilityGrantIndexes(bundle, indexes)).toEqual(indexes);
  });

  it("separates request and decision derivation domains for the same target in one Space", () => {
    const sharedSpace = id(3); const target = id(1);
    const requestBundle = issued(0, { requestId: target, decisionId: id(2), spaceId: sharedSpace });
    const decisionBundle = issued(100, { requestId: id(102), decisionId: target, spaceId: sharedSpace });
    const requestIndex = prepareCapabilityGrantIndexes(requestBundle)[0];
    const decisionIndex = prepareCapabilityGrantIndexes(decisionBundle)[1];
    expect(requestIndex.targetId).toBe(decisionIndex.targetId);
    expect(requestIndex.indexRecordId).not.toBe(decisionIndex.indexRecordId);
  });

  it("binds every index field, array order, and exact issued grant", () => {
    const bundle = issued(); const indexes = prepareCapabilityGrantIndexes(bundle); const other = issued(100); const otherIndexes = prepareCapabilityGrantIndexes(other);
    const mutate = (key: string, value: unknown) => key.includes("Sha256") ? "b".repeat(64) : key === "schemaVersion" ? 2 : key === "kind" ? "wrong" : key === "indexRole" ? "decision" : id(99);
    for (const key of Object.keys(indexes[0])) expectFailure(() => validateCapabilityGrantIndexes(bundle, [{ ...indexes[0], [key]: mutate(key, indexes[0][key as keyof typeof indexes[0]]) }, indexes[1]]));
    for (const invalid of [
      [indexes[1], indexes[0]], [indexes[0]], [indexes[0], indexes[1], indexes[0]], [indexes[0], indexes[0]],
      [otherIndexes[0], indexes[1]], [indexes[0], otherIndexes[1]],
      { 0: indexes[0], 1: indexes[1], length: 2 },
    ]) expectFailure(() => validateCapabilityGrantIndexes(bundle, invalid));
    expect(validateCapabilityGrantIndexes(bundle, indexes)).toEqual(indexes);
  });

  it("accepts reordered own index fields but rejects role and sibling record-ID forgeries", () => {
    const bundle = issued(); const indexes = prepareCapabilityGrantIndexes(bundle);
    const reversed = indexes.map((index) => Object.fromEntries(Object.entries(index).reverse()));
    expect(validateCapabilityGrantIndexes(bundle, reversed)).toEqual(indexes);
    const roles = [bundle.state.grantRecordId, bundle.state.grantId, bundle.state.intent.permissionRequestId, bundle.state.intent.permissionDecisionId, bundle.state.intent.spaceId, bundle.state.intent.runId, bundle.state.intent.effectId, bundle.state.intent.authoritySessionId, bundle.state.approvalVerifierId, bundle.state.issueLifecycleId, bundle.state.issueOperationId, bundle.state.issueReceiptId, indexes[1].indexRecordId];
    for (const indexRecordId of roles) expectFailure(() => validateCapabilityGrantIndexes(bundle, [{ ...indexes[0], indexRecordId }, indexes[1]]));
    expect(validateCapabilityGrantIndexes(bundle, indexes)).toEqual(indexes);
  });

  it("rejects terminal, hostile, and caller-mutable inputs while returning owned frozen indexes", () => {
    const bundle = issued(); const indexes = prepareCapabilityGrantIndexes(bundle);
    const terminal = prepareTerminalCapabilityJournal({ predecessor: { state: bundle.state, receipt: bundle.receipt }, lifecycle: "revoked", lifecycleId: id(12), operationId: id(13), receiptId: id(14), recordedAt: "2026-08-03T00:04:59.999Z" });
    const accessor = { ...indexes[0] }; Object.defineProperty(accessor, "grantId", { enumerable: true, get: () => { throw new Error("hostile"); } });
    const symbol = Symbol("hostile"); const symbolArray = [indexes[0], indexes[1]]; Object.defineProperty(symbolArray, symbol, { value: true });
    const extraArray = [indexes[0], indexes[1]]; Object.defineProperty(extraArray, "extra", { value: true });
    expectFailure(() => prepareCapabilityGrantIndexes(terminal));
    expectFailure(() => validateCapabilityGrantIndexes(bundle, new Proxy(indexes as unknown as object, { getPrototypeOf() { throw new Error("hostile"); } })));
    expectFailure(() => validateCapabilityGrantIndexes(bundle, [new Proxy(indexes[0], { getPrototypeOf() { throw new Error("hostile"); } }), indexes[1]]));
    expectFailure(() => validateCapabilityGrantIndexes(bundle, [accessor, indexes[1]]));
    expectFailure(() => validateCapabilityGrantIndexes(bundle, symbolArray)); expectFailure(() => validateCapabilityGrantIndexes(bundle, extraArray));
    expectFailure(() => validateCapabilityGrantIndexes(bundle, [indexes[0], , indexes[1]])); expectFailure(() => validateCapabilityGrantIndexes(bundle, Object.setPrototypeOf([indexes[0], indexes[1]], null)));
    const mutable = indexes.map((index) => ({ ...index })); const validated = validateCapabilityGrantIndexes(bundle, mutable);
    mutable[0]!.grantId = id(99);
    expect(validated[0].grantId).toBe(bundle.state.grantId);
    expect(Object.isFrozen(validated)).toBe(true); expect(Object.isFrozen(validated[0])).toBe(true); expect(Object.isFrozen(validated[1])).toBe(true);
  });

  it("remains private and has no storage, product, native, or IPC reachability", () => {
    const source = readFileSync(new URL("./capability-grant-index.ts", import.meta.url), "utf8");
    const runtimeBarrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const contractsBarrel = readFileSync(new URL("../../contracts/src/index.ts", import.meta.url), "utf8");
    const durableGate = readFileSync(new URL("../../../apps/desktop/src/main/durable-spaces-gate.ts", import.meta.url), "utf8");
    const packageGate = readFileSync(new URL("../../../apps/desktop/scripts/inspect-storage-capability-package.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:fs|path|os|http|https|child_process)|\bipc\b|electron|process\.env|set(?:Timeout|Interval)|\bfetch\b/i);
    expect(`${runtimeBarrel}\n${contractsBarrel}`).not.toMatch(/capability-grant-index|capability-journal/);
    expect(`${durableGate}\n${packageGate}`).not.toMatch(/capability-grant-index|capability-journal/);
    expect(durableGate).toMatch(/DURABLE_SPACES_ENABLED\s*=\s*false/);
    expect(packageGate).toMatch(/durableSpacesEnabled:\s*false/);
  });
});
