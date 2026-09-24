import { describe, expect, it } from "vitest";
import * as publicContracts from "./index.js";
import { DAEMON_PROTOCOL_VERSION, DaemonRequestSchema } from "./local-intelligence.js";
import {
  DaemonDurableSpaceLockAcknowledgementSchema,
  DaemonDurableSpaceLockRequestSchema,
  DaemonDurableSpaceUnlockAcknowledgementSchema,
  DaemonDurableSpaceUnlockRequestSchema,
  DaemonPrivateReadyEventSchema,
  isPrivateControlKeyMaterial
} from "./daemon-control.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const key = () => new Uint8Array(32).fill(7);

describe("private daemon durable-space controls", () => {
  it("keeps private control schemas out of the public contracts barrel", () => {
    expect("DaemonPrivateReadyEventSchema" in publicContracts).toBe(false);
    expect("DaemonDurableSpaceUnlockRequestSchema" in publicContracts).toBe(false);
    expect("DaemonDurableSpaceLockRequestSchema" in publicContracts).toBe(false);
  });

  it("accepts only the exact current ready and unlock/lock control messages", () => {
    const ready = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "daemon.ready",
      pid: 123,
      daemonSessionId: sessionId
    } as const;
    expect(DaemonPrivateReadyEventSchema.parse(ready)).toEqual(ready);

    const unlock = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      type: "durable-space.unlock",
      payload: { daemonSessionId: sessionId, spaceId, keyId, keyMaterial: key() }
    } as const;
    expect(DaemonDurableSpaceUnlockRequestSchema.parse(unlock)).toMatchObject(unlock);
    expect(DaemonDurableSpaceLockRequestSchema.safeParse({
      ...unlock,
      type: "durable-space.lock",
      payload: { daemonSessionId: sessionId, spaceId, keyId }
    }).success).toBe(true);
    expect(DaemonRequestSchema.safeParse(unlock).success).toBe(false);
    expect(DaemonRequestSchema.safeParse({
      ...unlock,
      type: "durable-space.lock",
      payload: { daemonSessionId: sessionId, spaceId, keyId }
    }).success).toBe(false);
  });

  it("rejects stale versions, invalid canonical IDs, extra fields, shared keys, and typed-array spoofs", () => {
    const base = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      type: "durable-space.unlock",
      payload: { daemonSessionId: sessionId, spaceId, keyId, keyMaterial: key() }
    };
    expect(DaemonDurableSpaceUnlockRequestSchema.safeParse({
      ...base, protocolVersion: 3
    }).success).toBe(false);
    expect(DaemonDurableSpaceUnlockRequestSchema.safeParse({
      ...base, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase()
    }).success).toBe(false);
    for (const field of ["daemonSessionId", "spaceId", "keyId"] as const) {
      expect(DaemonDurableSpaceUnlockRequestSchema.safeParse({
        ...base,
        payload: { ...base.payload, [field]: "not-a-canonical-id" }
      }).success).toBe(false);
    }
    expect(DaemonDurableSpaceUnlockRequestSchema.safeParse({
      ...base, payload: { ...base.payload, keyMaterial: new Uint8Array(31) }
    }).success).toBe(false);
    expect(DaemonDurableSpaceUnlockRequestSchema.safeParse({
      ...base, payload: { ...base.payload, extra: true }
    }).success).toBe(false);
    expect(isPrivateControlKeyMaterial({
      byteLength: 32, buffer: new ArrayBuffer(32)
    })).toBe(false);
    expect(isPrivateControlKeyMaterial(new Proxy(key(), {}))).toBe(false);
    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(32));
      Object.defineProperty(shared, "byteLength", { value: 32 });
      Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(32) });
      expect(isPrivateControlKeyMaterial(shared)).toBe(false);
    }
  });

  it("uses strict acknowledgements that never carry key material or a digest", () => {
    const unlockAck = { unlocked: true, daemonSessionId: sessionId, spaceId, keyId } as const;
    const lockAck = { locked: true, daemonSessionId: sessionId, spaceId, keyId } as const;
    expect(DaemonDurableSpaceUnlockAcknowledgementSchema.parse(unlockAck)).toEqual(unlockAck);
    expect(DaemonDurableSpaceLockAcknowledgementSchema.parse(lockAck)).toEqual(lockAck);
    expect(DaemonDurableSpaceUnlockAcknowledgementSchema.safeParse({
      ...unlockAck, keyMaterial: key()
    }).success).toBe(false);
    expect(DaemonDurableSpaceLockAcknowledgementSchema.safeParse({
      ...lockAck, keySha256: "a".repeat(64)
    }).success).toBe(false);
  });
});
