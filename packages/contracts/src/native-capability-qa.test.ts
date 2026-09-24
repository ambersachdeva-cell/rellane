import { describe, expect, it } from "vitest";
import {
  canonicalNativeCapabilityQaRunReceiptSha256,
  NATIVE_CAPABILITY_QA_C3A_BINDING,
  NativeCapabilityQaDiagnosticPairReceiptSchema,
  NativeCapabilityQaMessageSchema,
  NativeCapabilityQaRunReceiptSchema
} from "./native-capability-qa.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("native capability QA contracts", () => {
  it("accepts only a literal-bound C3b1 diagnostic run", () => {
    expect(NativeCapabilityQaRunReceiptSchema.parse(receipt(RUN_ID)).runId).toBe(RUN_ID);
  });

  it("rejects false provenance, free C3a values, and prohibited material", () => {
    const value = receipt(RUN_ID);
    expect(NativeCapabilityQaRunReceiptSchema.safeParse({ ...value, pid: 1 }).success).toBe(false);
    expect(NativeCapabilityQaRunReceiptSchema.safeParse({ ...value, c3aBinding: { ...value.c3aBinding, receiptSha256: "a".repeat(64) } }).success).toBe(false);
    expect(NativeCapabilityQaRunReceiptSchema.safeParse({ ...value, observations: { ...value.observations, app: { ...value.observations.app, packaged: false } } }).success).toBe(false);
    expect(NativeCapabilityQaRunReceiptSchema.safeParse({ ...value, observations: { ...value.observations, app: { ...value.observations.app, platform: "linux" } } }).success).toBe(false);
    expect(NativeCapabilityQaRunReceiptSchema.safeParse({ ...value, argv: ["no"], error: "no", ciphertext: "no", path: "/no", env: {} }).success).toBe(false);
  });

  it("permits diagnostic pairs only with distinct runs, terminal ordering, and canonical hashes", () => {
    const first = receipt(RUN_ID);
    const second = receipt("123e4567-e89b-42d3-a456-426614174001");
    const pair = { schemaVersion: 1 as const, kind: "native-capability-qa-diagnostic-pair" as const, acceptance: "not-accepted" as const, c3aBinding: NATIVE_CAPABILITY_QA_C3A_BINDING, first, firstSequence: 1 as const, firstReceiptSha256: canonicalNativeCapabilityQaRunReceiptSha256(first), second, secondSequence: 2 as const, secondReceiptSha256: canonicalNativeCapabilityQaRunReceiptSha256(second), firstExitBeforeSecondLaunch: true as const, crossLaunchDecrypt: "unobserved" as const, crashRecovery: "unobserved" as const, durableRecovery: "unobserved" as const };
    expect(NativeCapabilityQaDiagnosticPairReceiptSchema.parse(pair).acceptance).toBe("not-accepted");
    expect(NativeCapabilityQaDiagnosticPairReceiptSchema.safeParse({ ...pair, firstReceiptSha256: "a".repeat(64) }).success).toBe(false);
    expect(NativeCapabilityQaDiagnosticPairReceiptSchema.safeParse({ ...pair, firstExitBeforeSecondLaunch: false }).success).toBe(false);
  });

  it("requires exact no-secret protocol messages", () => {
    expect(NativeCapabilityQaMessageSchema.safeParse({ protocolVersion: 1, type: "qa.start", runId: RUN_ID, staticReceiptSha256: NATIVE_CAPABILITY_QA_C3A_BINDING.receiptSha256 }).success).toBe(true);
    expect(NativeCapabilityQaMessageSchema.safeParse({ protocolVersion: 1, type: "qa.start", runId: RUN_ID, staticReceiptSha256: NATIVE_CAPABILITY_QA_C3A_BINDING.receiptSha256, canary: "no" }).success).toBe(false);
  });

  it("hashes reordered strict evidence identically and rejects mutations", () => {
    const value = receipt(RUN_ID);
    const reordered = { prohibitions: value.prohibitions, observations: value.observations, c3aBinding: value.c3aBinding, runId: value.runId, protocolVersion: value.protocolVersion, acceptance: value.acceptance, kind: value.kind, schemaVersion: value.schemaVersion };
    expect(canonicalNativeCapabilityQaRunReceiptSha256(reordered)).toBe(canonicalNativeCapabilityQaRunReceiptSha256(value));
    expect(canonicalNativeCapabilityQaRunReceiptSha256({ ...value, runId: "123e4567-e89b-42d3-a456-426614174001" })).not.toBe(canonicalNativeCapabilityQaRunReceiptSha256(value));
  });
});

function receipt(runId: string) {
  return { schemaVersion: 1 as const, kind: "native-capability-qa-diagnostic-run" as const, acceptance: "not-accepted" as const, protocolVersion: 1 as const, runId, c3aBinding: NATIVE_CAPABILITY_QA_C3A_BINDING,
    observations: { app: { packaged: true as const, process: "main" as const, platform: "darwin" as const, arch: "arm64" as const, electron: "43.2.0", node: "24.14.1" }, safeStorage: { availability: "available" as const, roundtrip: "disabled" as const }, utility: { launched: "passed" as const, nodeSqliteModuleLoad: "passed" as const, inMemoryDatabase: "passed" as const, schemaTransaction: "passed" as const, fts5: "passed" as const, databaseClose: "passed" as const, sqliteVersion: "3.49.1", cleanExit: "passed" as const, provenance: { packaged: true as const, process: "utility" as const, platform: "darwin" as const, arch: "arm64" as const, electron: "43.2.0", node: "24.14.1" } } },
    prohibitions: { safeStorageRoundtrip: "disabled" as const, durableSpacesEnabled: false as const, keychainMutation: "unobserved" as const, crossLaunchDecrypt: "unobserved" as const, crashRecovery: "unobserved" as const, durableRecovery: "unobserved" as const } };
}
