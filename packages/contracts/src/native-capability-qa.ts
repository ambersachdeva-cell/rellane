import { createHash } from "node:crypto";
import { z } from "zod";

/** Private, separately packaged QA protocol. It is intentionally absent from the public barrel. */
export const NATIVE_CAPABILITY_QA_SCHEMA_VERSION = 1 as const;
export const NATIVE_CAPABILITY_QA_PROTOCOL_VERSION = 1 as const;
export const NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256 =
  "400522f3d717c82311830932c66913e854975e709100ba74f1435d1bd8a51aca" as const;
export const NATIVE_CAPABILITY_QA_C3A_BINDING = {
  receiptSha256: NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256,
  package: { asarSha256: "2da1ef33208ec0dc5302028cc44b4efc9c38ce127a65cde8e96bd5ec9bb7189b", asarBytes: 2333326 },
  entries: {
    mainProbe: { path: "dist/main/storage-capability-probe.cjs", sha256: "9ef290dae4a0cd127829e313470f86bb6e4a3a4c005d5fc53c0b4e56b7b7a529", bytes: 1611 },
    utilityProbe: { path: "dist/daemon/storage-capability-probe.cjs", sha256: "84db531d4162742c8c5180a056b8aca3845738295ef702818b6bcac1b0459297", bytes: 1689 },
    durableSpacesGate: { path: "dist/main/durable-spaces-gate.cjs", sha256: "94b8d330f0c208736910384f9809a0b96f3c2a5b5def4e2145bd7cef4229a152", bytes: 1595 }
  }
} as const;

const RunIdSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const VersionSchema = z.string().min(1).max(80).regex(/^[0-9A-Za-z.+_-]+$/);
const UnobservedSchema = z.literal("unobserved");
const C3aBindingSchema = z.strictObject({
  receiptSha256: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.receiptSha256),
  package: z.strictObject({ asarSha256: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.package.asarSha256), asarBytes: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.package.asarBytes) }),
  entries: z.strictObject({
    mainProbe: z.strictObject({ path: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.mainProbe.path), sha256: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.mainProbe.sha256), bytes: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.mainProbe.bytes) }),
    utilityProbe: z.strictObject({ path: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.utilityProbe.path), sha256: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.utilityProbe.sha256), bytes: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.utilityProbe.bytes) }),
    durableSpacesGate: z.strictObject({ path: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.durableSpacesGate.path), sha256: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.durableSpacesGate.sha256), bytes: z.literal(NATIVE_CAPABILITY_QA_C3A_BINDING.entries.durableSpacesGate.bytes) })
  })
});
export const NativeCapabilityQaC3aBuildBindingSchema = C3aBindingSchema;
export type NativeCapabilityQaC3aBuildBinding = z.infer<typeof C3aBindingSchema>;

const QaStartSchema = z.strictObject({
  protocolVersion: z.literal(NATIVE_CAPABILITY_QA_PROTOCOL_VERSION),
  type: z.literal("qa.start"),
  runId: RunIdSchema,
  staticReceiptSha256: z.literal(NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256)
});

const QaResultSchema = z.strictObject({
  protocolVersion: z.literal(NATIVE_CAPABILITY_QA_PROTOCOL_VERSION),
  type: z.literal("qa.result"),
  runId: RunIdSchema,
  nodeSqliteModuleLoad: z.literal("passed"),
  inMemoryDatabase: z.literal("passed"),
  schemaTransaction: z.literal("passed"),
  fts5: z.literal("passed"),
  databaseClose: z.literal("passed"),
  sqliteVersion: VersionSchema,
  provenance: z.strictObject({ packaged: z.literal(true), process: z.literal("utility"), platform: z.literal("darwin"), arch: z.literal("arm64"), electron: VersionSchema, node: VersionSchema })
});

const QaShutdownSchema = z.strictObject({
  protocolVersion: z.literal(NATIVE_CAPABILITY_QA_PROTOCOL_VERSION),
  type: z.literal("qa.shutdown"),
  runId: RunIdSchema
});

const QaShutdownCompleteSchema = z.strictObject({
  protocolVersion: z.literal(NATIVE_CAPABILITY_QA_PROTOCOL_VERSION),
  type: z.literal("qa.shutdown-complete"),
  runId: RunIdSchema,
  cleanExit: z.literal("passed")
});

export const NativeCapabilityQaMessageSchema = z.discriminatedUnion("type", [
  QaStartSchema,
  QaResultSchema,
  QaShutdownSchema,
  QaShutdownCompleteSchema
]);
export type NativeCapabilityQaMessage = z.infer<typeof NativeCapabilityQaMessageSchema>;
export type NativeCapabilityQaStart = z.infer<typeof QaStartSchema>;
export type NativeCapabilityQaResult = z.infer<typeof QaResultSchema>;
export type NativeCapabilityQaShutdown = z.infer<typeof QaShutdownSchema>;
export type NativeCapabilityQaShutdownComplete = z.infer<typeof QaShutdownCompleteSchema>;

const NativeCapabilityQaObservationSchema = z.strictObject({
  app: z.strictObject({
    packaged: z.literal(true),
    process: z.literal("main"),
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    electron: VersionSchema,
    node: VersionSchema
  }),
  safeStorage: z.strictObject({
    availability: z.enum(["available", "unavailable"]),
    roundtrip: z.literal("disabled")
  }),
  utility: z.strictObject({
    launched: z.literal("passed"),
    nodeSqliteModuleLoad: z.literal("passed"),
    inMemoryDatabase: z.literal("passed"),
    schemaTransaction: z.literal("passed"),
    fts5: z.literal("passed"),
    databaseClose: z.literal("passed"),
    sqliteVersion: VersionSchema,
    cleanExit: z.literal("passed"),
    provenance: z.strictObject({ packaged: z.literal(true), process: z.literal("utility"), platform: z.literal("darwin"), arch: z.literal("arm64"), electron: VersionSchema, node: VersionSchema })
  })
});

const NativeCapabilityQaProhibitionsSchema = z.strictObject({
  safeStorageRoundtrip: z.literal("disabled"),
  durableSpacesEnabled: z.literal(false),
  keychainMutation: UnobservedSchema,
  crossLaunchDecrypt: UnobservedSchema,
  crashRecovery: UnobservedSchema,
  durableRecovery: UnobservedSchema
});

export const NativeCapabilityQaRunReceiptSchema = z.strictObject({
  schemaVersion: z.literal(NATIVE_CAPABILITY_QA_SCHEMA_VERSION),
  kind: z.literal("native-capability-qa-diagnostic-run"),
  acceptance: z.literal("not-accepted"),
  protocolVersion: z.literal(NATIVE_CAPABILITY_QA_PROTOCOL_VERSION),
  runId: RunIdSchema,
  c3aBinding: C3aBindingSchema,
  observations: NativeCapabilityQaObservationSchema,
  prohibitions: NativeCapabilityQaProhibitionsSchema
}).superRefine((value, context) => {
  if (value.observations.utility.provenance.electron !== value.observations.app.electron || value.observations.utility.provenance.node !== value.observations.app.node) {
    context.addIssue({ code: "custom", message: "QA main and utility provenance must match." });
  }
});
export type NativeCapabilityQaRunReceipt = z.infer<typeof NativeCapabilityQaRunReceiptSchema>;

export const NativeCapabilityQaDiagnosticPairReceiptSchema = z.strictObject({
  schemaVersion: z.literal(NATIVE_CAPABILITY_QA_SCHEMA_VERSION),
  kind: z.literal("native-capability-qa-diagnostic-pair"),
  acceptance: z.literal("not-accepted"),
  c3aBinding: C3aBindingSchema,
  first: NativeCapabilityQaRunReceiptSchema,
  firstSequence: z.literal(1),
  firstReceiptSha256: Sha256Schema,
  second: NativeCapabilityQaRunReceiptSchema,
  secondSequence: z.literal(2),
  secondReceiptSha256: Sha256Schema,
  firstExitBeforeSecondLaunch: z.literal(true),
  crossLaunchDecrypt: UnobservedSchema,
  crashRecovery: UnobservedSchema,
  durableRecovery: UnobservedSchema
}).superRefine((value, context) => {
  if (value.first.runId === value.second.runId) {
    context.addIssue({ code: "custom", message: "QA launch-pair run IDs must differ." });
  }
  if (
    JSON.stringify(value.first.c3aBinding) !== JSON.stringify(value.c3aBinding) ||
    JSON.stringify(value.second.c3aBinding) !== JSON.stringify(value.c3aBinding)
  ) {
    context.addIssue({ code: "custom", message: "QA launch-pair receipt binding is invalid." });
  }
  if (value.firstReceiptSha256 !== canonicalNativeCapabilityQaRunReceiptSha256(value.first) || value.secondReceiptSha256 !== canonicalNativeCapabilityQaRunReceiptSha256(value.second)) {
    context.addIssue({ code: "custom", message: "QA launch-pair run receipt hash is invalid." });
  }
});
export type NativeCapabilityQaDiagnosticPairReceipt = z.infer<typeof NativeCapabilityQaDiagnosticPairReceiptSchema>;

export function canonicalNativeCapabilityQaRunReceiptSha256(value: unknown): string {
  return createHash("sha256").update(canonicalNativeCapabilityQaJson(NativeCapabilityQaRunReceiptSchema.parse(value)), "utf8").digest("hex");
}

export function canonicalNativeCapabilityQaJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical QA JSON requires finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Canonical QA JSON requires plain objects.");
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortCanonical(object[key])]));
  }
  throw new Error("Canonical QA JSON contains an unsupported value.");
}
