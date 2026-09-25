import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import {
  installRemotePairing,
  type PairingStatus,
} from "./remote-pairing-ipc.js";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

let evictionHandler: ((owner?: unknown) => void) | undefined;
const activeMockOwner = "window-owner-1";

vi.mock("../agents/source-owner.js", () => ({
  createAgentSourceOwners: vi.fn((onEvict?: (owner?: unknown) => void) => {
    evictionHandler = onEvict;
    return () => activeMockOwner;
  }),
}));

function createMockEvent(): IpcMainInvokeEvent {
  return {
    sender: {
      id: 1,
      isDestroyed: () => false,
    },
    senderFrame: {
      routingId: 1,
    },
  } as unknown as IpcMainInvokeEvent;
}

function getHandler(channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`No IPC handler registered for channel: ${channel}`);
  }
  return handler;
}

const callStatus = async (event = createMockEvent()): Promise<PairingStatus> => {
  const handler = getHandler(IPC_CHANNELS.workstationPairingStatus);
  return (await handler(event)) as PairingStatus;
};

const callStart = async (
  input: unknown,
  event = createMockEvent()
): Promise<PairingStatus> => {
  const handler = getHandler(IPC_CHANNELS.workstationPairingStart);
  return (await handler(event, input)) as PairingStatus;
};

const callStop = async (event = createMockEvent()): Promise<PairingStatus> => {
  const handler = getHandler(IPC_CHANNELS.workstationPairingStop);
  return (await handler(event)) as PairingStatus;
};

describe("remote-pairing-ipc", () => {
  it("closes an expired pairing without waiting for another status request", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn().mockResolvedValue(undefined);
      installRemotePairing({
        assertTrusted: vi.fn(),
        startServer: async () => ({ url: "http://127.0.0.1:49201", pin: "749201",
          expiresAt: Date.now() + 25, stop }),
        lanAddress: () => null
      });
      expect((await callStart({ reachable: "this-mac" })).state).toBe("listening");
      await vi.advanceTimersByTimeAsync(25);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(await callStatus()).toEqual({ state: "off" });
    } finally { vi.useRealTimers(); }
  });

  it("closes the paired server during workstation shutdown", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const pairing = installRemotePairing({
      assertTrusted: vi.fn(),
      startServer: async () => ({ url: "http://127.0.0.1:49201", pin: "749201",
        expiresAt: Date.now() + 300_000, stop }),
      lanAddress: () => null
    });
    await callStart({ reachable: "this-mac" });
    await pairing.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await callStatus()).toEqual({ state: "off" });
  });

  it("reports 'off' before any pairing has been started", async () => {
    const startServer = vi.fn();
    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    const status = await callStatus();
    expect(status).toEqual({ state: "off" });
    expect(startServer).not.toHaveBeenCalled();
  });

  it("resolves to 'listening' with the url, pin, and expiry the stub returned", async () => {
    const expectedUrl = "http://127.0.0.1:49201";
    const expectedPin = "749201";
    const expectedExpiry = Date.now() + 300_000;
    const stopStub = vi.fn().mockResolvedValue(undefined);

    const startServer = vi.fn().mockResolvedValue({
      url: expectedUrl,
      pin: expectedPin,
      expiresAt: expectedExpiry,
      stop: stopStub,
    });

    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    const status = await callStart({ reachable: "this-mac" });
    expect(status).toEqual({
      state: "listening",
      url: expectedUrl,
      pin: expectedPin,
      expiresAt: expectedExpiry,
    });
    expect(startServer).toHaveBeenCalledWith({ host: "127.0.0.1" });
  });

  it("returns current status on a second start without calling startServer again", async () => {
    const startServer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:49201",
      pin: "749201",
      expiresAt: Date.now() + 300_000,
      stop: vi.fn().mockResolvedValue(undefined),
    });

    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    const first = await callStart({ reachable: "this-mac" });
    expect(first.state).toBe("listening");
    expect(startServer).toHaveBeenCalledTimes(1);

    const second = await callStart({ reachable: "this-mac" });
    expect(second).toEqual(first);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("awaits the stub's stop and reports 'off'", async () => {
    const stopStub = vi.fn().mockResolvedValue(undefined);
    const startServer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:49201",
      pin: "749201",
      expiresAt: Date.now() + 300_000,
      stop: stopStub,
    });

    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    await callStart({ reachable: "this-mac" });
    const stopResult = await callStop();

    expect(stopStub).toHaveBeenCalledTimes(1);
    expect(stopResult).toEqual({ state: "off" });

    const statusAfter = await callStatus();
    expect(statusAfter).toEqual({ state: "off" });
  });

  it("rejects when requesting Wi-Fi reachable but lanAddress is null without calling startServer", async () => {
    const startServer = vi.fn();
    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => null,
    });

    await expect(callStart({ reachable: "wifi" })).rejects.toThrow(
      "This Mac is not on a Wi-Fi network."
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("never calls startServer with 0.0.0.0 even if lanAddress returns 0.0.0.0", async () => {
    const startServer = vi.fn();
    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "0.0.0.0",
    });

    await expect(callStart({ reachable: "wifi" })).rejects.toThrow(
      "Cannot bind to an open address."
    );
    expect(startServer).not.toHaveBeenCalled();
  });

  it("never reports listening without a held, unexpired server", async () => {
    const stopStub = vi.fn().mockResolvedValue(undefined);
    const startServer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:49201",
      pin: "749201",
      expiresAt: Date.now() - 1000,
      stop: stopStub,
    });

    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    await callStart({ reachable: "this-mac" });

    const status = await callStatus();
    expect(status).toEqual({ state: "off" });
    expect(stopStub).toHaveBeenCalledTimes(1);
  });

  it("reports 'off' when stop is called with no running server without error", async () => {
    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer: vi.fn(),
      lanAddress: () => "192.168.1.10",
    });

    const stopResult = await callStop();
    expect(stopResult).toEqual({ state: "off" });
  });

  it("stops the server if the initiating window navigates away", async () => {
    const stopStub = vi.fn().mockResolvedValue(undefined);
    const startServer = vi.fn().mockResolvedValue({
      url: "http://127.0.0.1:49201",
      pin: "749201",
      expiresAt: Date.now() + 300_000,
      stop: stopStub,
    });

    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    await callStart({ reachable: "this-mac" });
    expect(evictionHandler).toBeDefined();

    evictionHandler?.("window-owner-1");

    expect(stopStub).toHaveBeenCalledTimes(1);
    const status = await callStatus();
    expect(status).toEqual({ state: "off" });
  });

  it("redacts file paths, stack traces, and PINs from error messages", async () => {
    const startServer = vi.fn().mockRejectedValue(
      new Error("Error at /Users/amber/secret/server.ts:42 with pin 123456\n    at Object.listen (/Users/amber/node.js)")
    );

    installRemotePairing({
      assertTrusted: vi.fn(),
      startServer,
      lanAddress: () => "192.168.1.10",
    });

    // Caught rather than matched: `toThrowError` reads a function argument as an
    // error class, not as a predicate, so the assertions inside one never run.
    let thrown: unknown;
    try {
      await callStart({ reachable: "this-mac" });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain("/Users/");
    expect(message).not.toContain(".ts");
    expect(message).not.toContain("123456");
    expect(message).not.toContain("    at ");
  });

  it("requires a current trusted Mac pairing for exact one-run handover review and approval", async () => {
    const event = createMockEvent();
    const scope = { caseId: "case-1", operationId: "11111111-1111-4111-8111-111111111111",
      oldPrincipalId: `prnc_${"a".repeat(32)}`, newPrincipalId: `prnc_${"b".repeat(32)}` };
    const review = { ...scope, token: "a".repeat(64), expiresAt: Date.now() + 60_000, generation: 1 };
    const prepare = vi.fn(() => review);
    const approve = vi.fn(() => scope);
    installRemotePairing({
      assertTrusted: (incoming) => { if (incoming !== event) throw new Error("Untrusted window"); },
      startServer: async () => ({ url: "http://127.0.0.1:49201", pin: "749201",
        expiresAt: Date.now() + 300_000, stop: async () => undefined,
        handover: { candidates: () => ({ principals: [scope.oldPrincipalId, scope.newPrincipalId],
          runs: [{ principalId: scope.oldPrincipalId, caseId: scope.caseId, operationId: scope.operationId }] }),
        prepare, approve } }),
      lanAddress: () => null
    });
    const candidates = getHandler(IPC_CHANNELS.workstationPairingHandoverCandidates);
    const reviewCall = getHandler(IPC_CHANNELS.workstationPairingHandoverPrepare);
    const approveCall = getHandler(IPC_CHANNELS.workstationPairingHandoverApprove);
    expect(() => reviewCall(event, scope)).toThrow(/current pairing/u);
    await callStart({ reachable: "this-mac" }, event);
    expect(() => candidates({} as IpcMainInvokeEvent)).toThrow(/Untrusted/u);
    expect(await candidates(event)).toMatchObject({ runs: [{ operationId: scope.operationId }] });
    expect(() => reviewCall(event, { ...scope, operationId: "other" })).toThrow();
    expect(await reviewCall(event, scope)).toEqual(review);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(scope);
    expect(() => approveCall(event, { token: "bad" })).toThrow();
    expect(await approveCall(event, { token: review.token })).toEqual(scope);
    expect(approve).toHaveBeenCalledExactlyOnceWith(review.token);
    await callStop(event);
    expect(() => approveCall(event, { token: review.token })).toThrow(/current pairing/u);
  });
});
