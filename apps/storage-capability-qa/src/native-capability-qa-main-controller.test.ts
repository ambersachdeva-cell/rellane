import { describe, expect, it, vi } from "vitest";
vi.mock("@cadrane/contracts/native-capability-qa", async () => import("../../../packages/contracts/src/native-capability-qa.js"));
import { NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256 } from "@cadrane/contracts/native-capability-qa";
import { NativeCapabilityQaMainController } from "./native-capability-qa-main-controller.js";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const result = { protocolVersion: 1, type: "qa.result", runId, nodeSqliteModuleLoad: "passed", inMemoryDatabase: "passed", schemaTransaction: "passed", fts5: "passed", databaseClose: "passed", sqliteVersion: "3.49.1", provenance: { packaged: true, process: "utility", platform: "darwin", arch: "arm64", electron: "43.2.0", node: "24.14.1" } };
const ack = { protocolVersion: 1, type: "qa.shutdown-complete", runId, cleanExit: "passed" };

describe("NativeCapabilityQaMainController", () => {
  it("requires result then shutdown completion then actual exit zero", () => {
    const controller = new NativeCapabilityQaMainController(runId);
    expect(controller.receive(result)).toBe("send-shutdown");
    expect(controller.receive(ack)).toBe("await-exit");
    expect(controller.observeExit(0)).toEqual(result);
  });
  it.each([
    ["early exit", () => new NativeCapabilityQaMainController(runId).observeExit(0)],
    ["failed exit", () => { const c = new NativeCapabilityQaMainController(runId); c.receive(result); c.receive(ack); return c.observeExit(1); }],
    ["ack before result", () => new NativeCapabilityQaMainController(runId).receive(ack)],
    ["wrong run", () => new NativeCapabilityQaMainController(runId).receive({ ...result, runId: "123e4567-e89b-42d3-a456-426614174001" })],
    ["malformed", () => new NativeCapabilityQaMainController(runId).receive({ staticReceiptSha256: NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256 })]
  ])("fails closed on %s", (_name, invoke) => expect(invoke).toThrow("main controller rejected"));
});
