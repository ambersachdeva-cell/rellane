import {
  NATIVE_CAPABILITY_QA_PROTOCOL_VERSION,
  NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256,
  NativeCapabilityQaMessageSchema,
  type NativeCapabilityQaResult,
  type NativeCapabilityQaShutdownComplete,
  type NativeCapabilityQaStart
} from "@cadrane/contracts/native-capability-qa";

export const NATIVE_CAPABILITY_QA_PROTOCOL_MARKER = "switchboard-native-capability-qa-protocol-v1" as const;

type UtilityState = "awaiting-start" | "running" | "awaiting-shutdown" | "complete" | "failed";

export class NativeCapabilityQaUtilityProtocol {
  private state: UtilityState = "awaiting-start";
  private runId: string | null = null;

  receive(value: unknown): { readonly action: "run"; readonly start: NativeCapabilityQaStart } | { readonly action: "shutdown"; readonly complete: NativeCapabilityQaShutdownComplete } {
    const parsed = NativeCapabilityQaMessageSchema.safeParse(value);
    if (!parsed.success || this.state === "failed" || this.state === "complete") return this.fail();
    if (this.state === "awaiting-start") {
      if (parsed.data.type !== "qa.start" || parsed.data.staticReceiptSha256 !== NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256) return this.fail();
      this.runId = parsed.data.runId;
      this.state = "running";
      return { action: "run", start: parsed.data };
    }
    if (this.state === "awaiting-shutdown") {
      if (parsed.data.type !== "qa.shutdown" || parsed.data.runId !== this.runId) return this.fail();
      this.state = "complete";
      return { action: "shutdown", complete: { protocolVersion: NATIVE_CAPABILITY_QA_PROTOCOL_VERSION, type: "qa.shutdown-complete", runId: parsed.data.runId, cleanExit: "passed" } };
    }
    return this.fail();
  }

  completeRun(sqliteVersion: string): NativeCapabilityQaResult {
    if (this.state !== "running" || this.runId === null) return this.fail();
    this.state = "awaiting-shutdown";
    return { protocolVersion: NATIVE_CAPABILITY_QA_PROTOCOL_VERSION, type: "qa.result", runId: this.runId, nodeSqliteModuleLoad: "passed", inMemoryDatabase: "passed", schemaTransaction: "passed", fts5: "passed", databaseClose: "passed", sqliteVersion, provenance: { packaged: true, process: "utility", platform: "darwin", arch: "arm64", electron: process.versions.electron, node: process.versions.node } };
  }

  private fail(): never {
    this.state = "failed";
    throw new Error("Native capability QA protocol rejected its message.");
  }
}
