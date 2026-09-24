import { describe, expect, it, vi } from "vitest";
vi.mock("@cadrane/contracts/native-capability-qa", async () => import("../../../packages/contracts/src/native-capability-qa.js"));
import { NATIVE_CAPABILITY_QA_C3A_BINDING } from "@cadrane/contracts/native-capability-qa";
import { serializeNativeCapabilityQaDiagnosticReceipt } from "./native-capability-qa-receipt.js";

it("serializes one canonical diagnostic line only", () => {
  const value = { schemaVersion: 1, kind: "native-capability-qa-diagnostic-run", acceptance: "not-accepted", protocolVersion: 1, runId: "123e4567-e89b-42d3-a456-426614174000", c3aBinding: NATIVE_CAPABILITY_QA_C3A_BINDING, observations: { app: { packaged: true, process: "main", platform: "darwin", arch: "arm64", electron: "43.2.0", node: "24.14.1" }, safeStorage: { availability: "available", roundtrip: "disabled" }, utility: { launched: "passed", nodeSqliteModuleLoad: "passed", inMemoryDatabase: "passed", schemaTransaction: "passed", fts5: "passed", databaseClose: "passed", sqliteVersion: "3.49.1", cleanExit: "passed", provenance: { packaged: true, process: "utility", platform: "darwin", arch: "arm64", electron: "43.2.0", node: "24.14.1" } } }, prohibitions: { safeStorageRoundtrip: "disabled", durableSpacesEnabled: false, keychainMutation: "unobserved", crossLaunchDecrypt: "unobserved", crashRecovery: "unobserved", durableRecovery: "unobserved" } };
  expect(serializeNativeCapabilityQaDiagnosticReceipt(value)).toMatch(/^\{"acceptance"/);
  expect(() => serializeNativeCapabilityQaDiagnosticReceipt({ ...value, env: {} })).toThrow();
});
