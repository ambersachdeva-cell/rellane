import { canonicalNativeCapabilityQaJson, NativeCapabilityQaRunReceiptSchema } from "@cadrane/contracts/native-capability-qa";

/** The isolated host transport is exactly one canonical line, never a file or app data write. */
export function serializeNativeCapabilityQaDiagnosticReceipt(value: unknown): string {
  return `${canonicalNativeCapabilityQaJson(NativeCapabilityQaRunReceiptSchema.parse(value))}\n`;
}
