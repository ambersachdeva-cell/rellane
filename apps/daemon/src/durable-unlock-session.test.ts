import { describe, expect, it } from "vitest";
import type {
  DaemonDurableSpaceLockRequest,
  DaemonDurableSpaceUnlockRequest
} from "@cadrane/contracts/daemon-control";
import {
  DurableUnlockSessionController,
  DurableUnlockSessionError
} from "./durable-unlock-session.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";

const unlock = (requestId: string, overrides: Partial<DaemonDurableSpaceUnlockRequest["payload"]> = {}): DaemonDurableSpaceUnlockRequest => ({
  protocolVersion: 5,
  requestId,
  type: "durable-space.unlock",
  payload: { daemonSessionId: sessionId, spaceId, keyId, keyMaterial: new Uint8Array(32).fill(9), ...overrides }
});
const lock = (requestId: string, overrides: Partial<DaemonDurableSpaceLockRequest["payload"]> = {}): DaemonDurableSpaceLockRequest => ({
  protocolVersion: 5,
  requestId,
  type: "durable-space.lock",
  payload: { daemonSessionId: sessionId, spaceId, keyId, ...overrides }
});

describe("DurableUnlockSessionController", () => {
  it("accepts one exact session-bound unlock, owns a copy, and zeroes received material", () => {
    const controller = new DurableUnlockSessionController(sessionId);
    const request = unlock("44444444-4444-4444-8444-444444444444");
    expect(controller.unlock(request)).toEqual({ unlocked: true, daemonSessionId: sessionId, spaceId, keyId });
    expect(request.payload.keyMaterial).toEqual(new Uint8Array(32));
    expect(controller.activeCount).toBe(1);
  });

  it("rejects stale sessions, duplicate/replayed requests, and conflicting active keys", () => {
    const controller = new DurableUnlockSessionController(sessionId);
    const first = unlock("44444444-4444-4444-8444-444444444444");
    controller.unlock(first);
    expect(() => controller.unlock(first)).toThrow(DurableUnlockSessionError);
    const stale = unlock("55555555-5555-4555-8555-555555555555", { daemonSessionId: keyId });
    expect(() => controller.unlock(stale)).toThrow(DurableUnlockSessionError);
    expect(stale.payload.keyMaterial).toEqual(new Uint8Array(32));
    expect(() => controller.unlock(unlock("66666666-6666-4666-8666-666666666666", { keyId: "77777777-7777-4777-8777-777777777777" }))).toThrow(DurableUnlockSessionError);
  });

  it("does not let rejected unlock attempts poison a later valid binding", () => {
    const controller = new DurableUnlockSessionController(sessionId);
    const stale = unlock("44444444-4444-4444-8444-444444444444", { daemonSessionId: keyId });
    expect(() => controller.unlock(stale)).toThrow(DurableUnlockSessionError);
    expect(controller.unlock(unlock("55555555-5555-4555-8555-555555555555"))).toMatchObject({ unlocked: true });
    expect(controller.lock(lock("66666666-6666-4666-8666-666666666666"))).toMatchObject({ locked: true });

    const replacementKeyId = "99999999-9999-4999-8999-999999999999";
    const invalid = unlock("77777777-7777-4777-8777-777777777777", {
      keyId: replacementKeyId,
      keyMaterial: new Uint8Array(31) as unknown as Uint8Array
    });
    expect(() => controller.unlock(invalid)).toThrow(DurableUnlockSessionError);
    expect(controller.unlock(unlock("88888888-8888-4888-8888-888888888888", {
      keyId: replacementKeyId
    }))).toMatchObject({ unlocked: true });
  });

  it("locks only the exact active binding and rejects replay after lock", () => {
    const controller = new DurableUnlockSessionController(sessionId);
    const unlocked = unlock("44444444-4444-4444-8444-444444444444");
    controller.unlock(unlocked);
    expect(() => controller.lock(lock("55555555-5555-4555-8555-555555555555", { keyId: "66666666-6666-4666-8666-666666666666" }))).toThrow(DurableUnlockSessionError);
    expect(controller.lock(lock("77777777-7777-4777-8777-777777777777"))).toEqual({ locked: true, daemonSessionId: sessionId, spaceId, keyId });
    expect(controller.activeCount).toBe(0);
    expect(() => controller.unlock(unlocked)).toThrow(DurableUnlockSessionError);
    expect(() => controller.unlock(unlock("99999999-9999-4999-8999-999999999999"))).toThrow(DurableUnlockSessionError);
    expect(() => controller.lock(lock("88888888-8888-4888-8888-888888888888"))).toThrow(DurableUnlockSessionError);
  });

  it("zeroes all daemon-owned active keys during shutdown", () => {
    const controller = new DurableUnlockSessionController(sessionId) as unknown as {
      active: Map<string, { key: Uint8Array }>;
      unlock(request: DaemonDurableSpaceUnlockRequest): unknown;
      shutdown(): void;
      activeCount: number;
    };
    const request = unlock("44444444-4444-4444-8444-444444444444");
    controller.unlock(request);
    const stored = controller.active.get(spaceId)?.key;
    if (stored === undefined) throw new Error("Missing fixture key.");
    controller.shutdown();
    expect(stored).toEqual(new Uint8Array(32));
    expect(controller.activeCount).toBe(0);
  });

  it("fails closed at the bounded active-space limit", () => {
    const controller = new DurableUnlockSessionController(sessionId);
    for (let index = 0; index < 32; index += 1) {
      const value = String(index).padStart(12, "0");
      controller.unlock(unlock(`request-${value}`, {
        spaceId: `22222222-2222-4222-8222-${value}`,
        keyId: `33333333-3333-4333-8333-${value}`
      }));
    }
    expect(controller.activeCount).toBe(32);
    expect(() => controller.unlock(unlock("request-over-limit", {
      spaceId: "22222222-2222-4222-8222-999999999999",
      keyId: "33333333-3333-4333-8333-999999999999"
    }))).toThrow(DurableUnlockSessionError);
  });
});
