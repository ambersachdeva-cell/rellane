import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  child: null as FakeChild | null,
  fork: vi.fn()
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => "/tmp/switchboard-app",
    getPath: () => "/tmp/switchboard-main-data"
  },
  utilityProcess: {
    fork: electron.fork
  }
}));

import { DAEMON_PROTOCOL_VERSION } from "@cadrane/contracts";
import {
  DaemonClient,
  type DaemonProcessTerminationBoundary
} from "./daemon-client.js";

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn();
  readonly kill = vi.fn();
}

beforeEach(() => {
  electron.child = new FakeChild();
  electron.fork.mockReset();
  electron.fork.mockReturnValue(electron.child);
});

describe("DaemonClient request cleanup", () => {
  it("removes and rejects a pending request immediately when the child is missing", async () => {
    const client = new DaemonClient();
    await start(client);

    const pending = client.request({
      type: "model.install.snapshot",
      payload: {}
    }, 5_000);
    (client as unknown as { child: FakeChild | null }).child = null;

    await expect(pending).rejects.toThrow("service is unavailable");
    expect(pendingCount(client)).toBe(0);
  });

  it("removes and rejects a pending request immediately when postMessage throws", async () => {
    const client = new DaemonClient();
    await start(client);
    electron.child?.postMessage.mockImplementationOnce(() => {
      throw new Error("IPC send failed");
    });

    await expect(client.request({
      type: "model.install.snapshot",
      payload: {}
    }, 5_000)).rejects.toThrow("IPC send failed");
    expect(pendingCount(client)).toBe(0);
  });
});

describe("DaemonClient lifecycle", () => {
  it("accepts clean shutdown only after acknowledgement and child exit", async () => {
    const client = new DaemonClient();
    await start(client);
    const child = electron.child!;

    const stopping = client.stop();
    await vi.waitFor(() => {
      expect(child.postMessage).toHaveBeenCalledTimes(2);
    });
    const shutdown = child.postMessage.mock.calls[1]?.[0];
    expect(shutdown).toMatchObject({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "daemon.shutdown",
      payload: {}
    });
    child.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: shutdown.requestId,
      ok: true,
      data: { shutdown: "clean" }
    });
    child.emit("exit", 0);

    await expect(stopping).resolves.toEqual({
      clean: true,
      forced: false,
      hardKilled: false,
      exited: true
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("marks a rejected handshake as forced and unclean", async () => {
    const client = new DaemonClient();
    await start(client);
    const child = electron.child!;

    const stopping = client.stop();
    await vi.waitFor(() => {
      expect(child.postMessage).toHaveBeenCalledTimes(2);
    });
    const shutdown = child.postMessage.mock.calls[1]?.[0];
    child.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: shutdown.requestId,
      ok: false,
      error: {
        code: "RUNTIME_UNAVAILABLE",
        message: "Cleanup could not be confirmed.",
        retryable: false
      }
    });
    await vi.waitFor(() => {
      expect(child.kill).toHaveBeenCalledTimes(1);
    });
    child.emit("exit", 1);

    await expect(stopping).resolves.toEqual({
      clean: false,
      forced: true,
      hardKilled: false,
      exited: true
    });
  });

  it("hard-kills after hung cleanup and prevents restart until exit", async () => {
    const termination = new FakeTerminationBoundary();
    termination.graceful.mockImplementation(() => {
      throw new Error("SIGTERM fixture failed.");
    });
    const client = new DaemonClient(termination);
    await start(client);
    const forkCount = electron.fork.mock.calls.length;
    vi.useFakeTimers();
    try {
      const stopping = client.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(termination.graceful).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(termination.force).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(stopping).resolves.toEqual({
        clean: false,
        forced: true,
        hardKilled: true,
        exited: false
      });
      await expect(client.request({
        type: "model.install.snapshot",
        payload: {}
      }, 5_000)).rejects.toThrow(
        "previous isolated local service has not exited"
      );
      expect(electron.fork).toHaveBeenCalledTimes(forkCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the old daemon to exit before reopening a fresh one", async () => {
    const client = new DaemonClient();
    await start(client);
    const oldChild = electron.child!;
    const stopping = client.stop();
    const newChild = new FakeChild();
    electron.child = newChild;
    electron.fork.mockReturnValue(newChild);
    const reopened = client.request({
      type: "model.install.snapshot",
      payload: {}
    }, 5_000);

    await vi.waitFor(() => {
      expect(oldChild.postMessage).toHaveBeenCalledTimes(2);
    });
    expect(electron.fork).toHaveBeenCalledTimes(1);
    const shutdown = oldChild.postMessage.mock.calls[1]?.[0];
    oldChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: shutdown.requestId,
      ok: true,
      data: { shutdown: "clean" }
    });
    oldChild.emit("exit", 0);
    await stopping;

    await vi.waitFor(() => {
      expect(electron.fork).toHaveBeenCalledTimes(2);
    });
    newChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "daemon.ready",
      pid: 43,
      daemonSessionId: "11111111-1111-4111-8111-111111111111"
    });
    await vi.waitFor(() => {
      expect(newChild.postMessage).toHaveBeenCalledTimes(1);
    });
    const newRequest = newChild.postMessage.mock.calls[0]?.[0];
    newChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: newRequest.requestId,
      ok: true,
      data: []
    });
    await expect(reopened).resolves.toEqual([]);
  });

  it("permanently disables restart during application quit", async () => {
    const client = new DaemonClient();
    await expect(client.disable()).resolves.toMatchObject({
      clean: true,
      exited: true
    });
    await expect(client.request({
      type: "model.install.snapshot",
      payload: {}
    }, 5_000)).rejects.toThrow("disabled for app shutdown");
    expect(electron.fork).not.toHaveBeenCalled();
  });
});

describe("DaemonClient private durable-space controls", () => {
  const spaceId = "22222222-2222-4222-8222-222222222222";
  const keyId = "33333333-3333-4333-8333-333333333333";
  const sessionId = "11111111-1111-4111-8111-111111111111";

  it("requires strict private readiness and fails closed for a ready event without a session", async () => {
    const client = new DaemonClient();
    const pending = client.request({ type: "model.install.snapshot", payload: {} }, 5_000);
    electron.child?.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "daemon.ready",
      pid: 42
    });
    await expect(pending).rejects.toThrow("invalid private readiness");
    expect(electron.child?.kill).toHaveBeenCalledTimes(1);
  });

  it("uses one exact session-bound unlock acknowledgement and zeros caller and outbound key bytes", async () => {
    const client = new DaemonClient();
    const callerKey = new Uint8Array(32).fill(9);
    const pending = client.unlockDurableSpace({ spaceId, keyId, keyMaterial: callerKey });
    const child = electron.child!;
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 42, daemonSessionId: sessionId });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1));
    const unlock = child.postMessage.mock.calls[0]?.[0];
    expect(unlock.payload).toMatchObject({ daemonSessionId: sessionId, spaceId, keyId });
    expect(unlock.payload.keyMaterial).not.toBe(callerKey);
    child.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: unlock.requestId,
      ok: true,
      data: { unlocked: true, daemonSessionId: sessionId, spaceId, keyId }
    });
    await expect(pending).resolves.toBeUndefined();
    expect(callerKey).toEqual(new Uint8Array(32));
    expect(unlock.payload.keyMaterial).toEqual(new Uint8Array(32));
  });

  it("stops the daemon after a rejected private control acknowledgement and zeros caller material", async () => {
    const client = new DaemonClient();
    const callerKey = new Uint8Array(32).fill(9);
    const pending = client.unlockDurableSpace({ spaceId, keyId, keyMaterial: callerKey });
    const child = electron.child!;
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 42, daemonSessionId: sessionId });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1));
    const unlock = child.postMessage.mock.calls[0]?.[0];
    child.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: unlock.requestId,
      ok: false,
      error: { code: "RUNTIME_UNAVAILABLE", message: "rejected", retryable: false }
    });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    const shutdown = child.postMessage.mock.calls[1]?.[0];
    child.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: shutdown.requestId,
      ok: true,
      data: { shutdown: "clean" }
    });
    child.emit("exit", 0);
    await expect(pending).rejects.toThrow("rejected");
    expect(callerKey).toEqual(new Uint8Array(32));
    expect(unlock.payload.keyMaterial).toEqual(new Uint8Array(32));
  });

  it("zeros caller and outbound bytes, with no retry, when unlock postMessage throws", async () => {
    const client = new DaemonClient();
    const callerKey = new Uint8Array(32).fill(9);
    const pending = client.unlockDurableSpace({ spaceId, keyId, keyMaterial: callerKey });
    const child = electron.child!;
    child.postMessage.mockImplementationOnce(() => { throw new Error("send failed"); });
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 42, daemonSessionId: sessionId });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    const shutdown = child.postMessage.mock.calls[1]?.[0];
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: shutdown.requestId, ok: true, data: { shutdown: "clean" } });
    child.emit("exit", 0);
    await expect(pending).rejects.toThrow("send failed");
    expect(callerKey).toEqual(new Uint8Array(32));
    expect(child.postMessage.mock.calls[0]?.[0].payload.keyMaterial).toEqual(new Uint8Array(32));
    expect(child.postMessage.mock.calls.filter(([message]) => message.type === "durable-space.unlock")).toHaveLength(1);
  });

  it("treats a timeout and malformed/mismatched acknowledgement as ambiguous and tears down", async () => {
    const client = new DaemonClient();
    const callerKey = new Uint8Array(32).fill(9);
    vi.useFakeTimers();
    try {
      const pending = client.unlockDurableSpace({ spaceId, keyId, keyMaterial: callerKey });
      const child = electron.child!;
      child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 42, daemonSessionId: sessionId });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(child.postMessage).toHaveBeenCalledTimes(2);
      const outbound = child.postMessage.mock.calls[0]?.[0].payload.keyMaterial;
      const shutdown = child.postMessage.mock.calls[1]?.[0];
      child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: shutdown.requestId, ok: true, data: { shutdown: "clean" } });
      child.emit("exit", 0);
      await expect(pending).rejects.toThrow("did not confirm durable-space control");
      expect(callerKey).toEqual(new Uint8Array(32));
      expect(outbound).toEqual(new Uint8Array(32));
    } finally {
      vi.useRealTimers();
    }

    electron.child = new FakeChild();
    electron.fork.mockReturnValue(electron.child);
    const second = new DaemonClient();
    const malformed = second.unlockDurableSpace({ spaceId, keyId, keyMaterial: new Uint8Array(32).fill(9) });
    const child = electron.child!;
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 42, daemonSessionId: sessionId });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1));
    const unlock = child.postMessage.mock.calls[0]?.[0];
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: unlock.requestId, ok: true, data: { unlocked: true, daemonSessionId: keyId, spaceId, keyId } });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    const shutdown = child.postMessage.mock.calls[1]?.[0];
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: shutdown.requestId, ok: true, data: { shutdown: "clean" } });
    child.emit("exit", 0);
    await expect(malformed).rejects.toThrow("mismatched durable-space acknowledgement");
  });

  it("sends and validates an exact lock control acknowledgement", async () => {
    const client = new DaemonClient();
    const unlockPending = client.unlockDurableSpace({ spaceId, keyId, keyMaterial: new Uint8Array(32).fill(9) });
    const child = electron.child!;
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 42, daemonSessionId: sessionId });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1));
    const unlock = child.postMessage.mock.calls[0]?.[0];
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: unlock.requestId, ok: true, data: { unlocked: true, daemonSessionId: sessionId, spaceId, keyId } });
    await unlockPending;
    const lockPending = client.lockDurableSpace({ spaceId, keyId });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    const lock = child.postMessage.mock.calls[1]?.[0];
    expect(lock).toMatchObject({ type: "durable-space.lock", payload: { daemonSessionId: sessionId, spaceId, keyId } });
    child.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: lock.requestId, ok: true, data: { locked: true, daemonSessionId: sessionId, spaceId, keyId } });
    await expect(lockPending).resolves.toBeUndefined();
  });

  it("uses a fresh daemon session after restart and rejects a stale-session acknowledgement", async () => {
    const client = new DaemonClient();
    await start(client);
    const oldChild = electron.child!;
    const stopping = client.stop();
    await vi.waitFor(() => expect(oldChild.postMessage).toHaveBeenCalledTimes(2));
    const oldShutdown = oldChild.postMessage.mock.calls[1]?.[0];
    oldChild.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: oldShutdown.requestId, ok: true, data: { shutdown: "clean" } });
    oldChild.emit("exit", 0);
    await stopping;

    const freshSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const newChild = new FakeChild();
    electron.child = newChild;
    electron.fork.mockReturnValue(newChild);
    const pending = client.unlockDurableSpace({ spaceId, keyId, keyMaterial: new Uint8Array(32).fill(9) });
    newChild.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 43, daemonSessionId: freshSessionId });
    await vi.waitFor(() => expect(newChild.postMessage).toHaveBeenCalledTimes(1));
    const unlock = newChild.postMessage.mock.calls[0]?.[0];
    expect(unlock.payload.daemonSessionId).toBe(freshSessionId);
    newChild.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: unlock.requestId, ok: true, data: { unlocked: true, daemonSessionId: sessionId, spaceId, keyId } });
    await vi.waitFor(() => expect(newChild.postMessage).toHaveBeenCalledTimes(2));
    const newShutdown = newChild.postMessage.mock.calls[1]?.[0];
    newChild.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: newShutdown.requestId, ok: true, data: { shutdown: "clean" } });
    newChild.emit("exit", 0);
    await expect(pending).rejects.toThrow("mismatched durable-space acknowledgement");
  });

  it("ignores every late old-child event after a new daemon owns the current request", async () => {
    const client = new DaemonClient();
    await start(client);
    const oldChild = electron.child!;
    const stopping = client.stop();
    await vi.waitFor(() => expect(oldChild.postMessage).toHaveBeenCalledTimes(2));
    const oldShutdown = oldChild.postMessage.mock.calls[1]?.[0];
    oldChild.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, requestId: oldShutdown.requestId, ok: true, data: { shutdown: "clean" } });
    oldChild.emit("exit", 0);
    await stopping;

    const newChild = new FakeChild();
    electron.child = newChild;
    electron.fork.mockReturnValue(newChild);
    const pending = client.request<string[]>({ type: "model.install.snapshot", payload: {} }, 5_000);
    newChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "daemon.ready",
      pid: 43,
      daemonSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    await vi.waitFor(() => expect(newChild.postMessage).toHaveBeenCalledTimes(1));
    const current = newChild.postMessage.mock.calls[0]?.[0];

    oldChild.emit("message", { protocolVersion: 1 });
    oldChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      type: "daemon.ready",
      pid: 99,
      daemonSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    });
    oldChild.emit("message", { protocolVersion: DAEMON_PROTOCOL_VERSION, type: "daemon.ready", pid: 99 });
    oldChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: current.requestId,
      ok: true,
      data: ["old-child-response"]
    });
    oldChild.emit("exit", 0);
    expect(newChild.kill).not.toHaveBeenCalled();
    expect(pendingCount(client)).toBe(1);

    newChild.emit("message", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: current.requestId,
      ok: true,
      data: ["new-child-response"]
    });
    await expect(pending).resolves.toEqual(["new-child-response"]);
  });
});

async function start(client: DaemonClient): Promise<void> {
  const starting = client.request({
    type: "model.install.snapshot",
    payload: {}
  }, 5_000);
  electron.child?.emit("message", {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    type: "daemon.ready",
    pid: 42,
    daemonSessionId: "11111111-1111-4111-8111-111111111111"
  });
  await vi.waitFor(() => {
    expect(electron.child?.postMessage).toHaveBeenCalledTimes(1);
  });
  electron.child?.emit("message", {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    requestId: electron.child?.postMessage.mock.calls[0]?.[0].requestId,
    ok: true,
    data: []
  });
  await starting;
}

function pendingCount(client: DaemonClient): number {
  return (client as unknown as { pending: Map<string, unknown> }).pending.size;
}

class FakeTerminationBoundary
implements DaemonProcessTerminationBoundary {
  readonly graceful = vi.fn();
  readonly force = vi.fn();

  requestGracefulTermination(): void {
    this.graceful();
  }

  forceKill(): void {
    this.force();
  }
}
