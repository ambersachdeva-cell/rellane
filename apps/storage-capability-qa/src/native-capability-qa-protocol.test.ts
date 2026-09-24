import { describe, expect, it, vi } from "vitest";

vi.mock("@cadrane/contracts/native-capability-qa", async () =>
  import("../../../packages/contracts/src/native-capability-qa.js")
);

import { NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256 } from "@cadrane/contracts/native-capability-qa";
import { NativeCapabilityQaUtilityProtocol } from "./native-capability-qa-protocol.js";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const start = () => ({ protocolVersion: 1, type: "qa.start", runId: RUN_ID, staticReceiptSha256: NATIVE_CAPABILITY_QA_STATIC_RECEIPT_SHA256 });

describe("NativeCapabilityQaUtilityProtocol", () => {
  it("accepts one exact start/result/shutdown sequence", () => {
    const protocol = new NativeCapabilityQaUtilityProtocol();
    expect(protocol.receive(start()).action).toBe("run");
    expect(protocol.completeRun("3.49.1").runId).toBe(RUN_ID);
    expect(protocol.receive({ protocolVersion: 1, type: "qa.shutdown", runId: RUN_ID }).action).toBe("shutdown");
  });
  it.each([
    ["replay", () => { const p = new NativeCapabilityQaUtilityProtocol(); p.receive(start()); return p.receive(start()); }],
    ["malformed", () => new NativeCapabilityQaUtilityProtocol().receive({ type: "qa.start" })],
    ["out of order", () => new NativeCapabilityQaUtilityProtocol().receive({ protocolVersion: 1, type: "qa.shutdown", runId: RUN_ID })],
    ["wrong receipt", () => new NativeCapabilityQaUtilityProtocol().receive({ ...start(), staticReceiptSha256: "a".repeat(64) })]
  ])("fails closed on %s messages", (_name, receive) => expect(receive).toThrow("protocol rejected"));
});
