import * as http from "node:http";
import { describe, expect, it } from "vitest";
import {
  createRemoteDispatchServer,
  type RemoteWorkstationState,
} from "./remote-dispatch-server.js";

describe("RemoteDispatchServer", () => {
  it("starts on random port 0 and returns healthy status", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    expect(server.port).toBeGreaterThan(0);
    expect(info.port).toBe(server.port);
    expect(info.serverUrl).toBe(`http://127.0.0.1:${info.port}`);

    const res = await fetch(`${info.serverUrl}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { readonly status?: string; readonly service?: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("rellane-remote-dispatch");

    await server.stop();
  });

  it("rejects incorrect PIN with 401 and issues token on successful pair", async () => {
    const pin = "839201";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info = await server.start();

    expect(server.pin).toBe(pin);
    expect(info.pin).toBe(pin);

    const wrongRes = await fetch(`${info.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "000000" }),
    });
    expect(wrongRes.status).toBe(401);

    const correctRes = await fetch(`${info.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    expect(correctRes.status).toBe(200);

    const correctBody = (await correctRes.json()) as { readonly token: string; readonly expiresIn: number };
    expect(typeof correctBody.token).toBe("string");
    expect(correctBody.token.length).toBeGreaterThan(20);
    expect(typeof correctBody.expiresIn).toBe("number");
    expect(correctBody.expiresIn).toBeGreaterThan(0);

    const stateRes = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${correctBody.token}` },
    });
    expect(stateRes.status).toBe(200);

    await server.stop();
  });

  it("rejects requests to protected endpoints without valid bearer token", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const noTokenState = await fetch(`${info.serverUrl}/api/state`);
    expect(noTokenState.status).toBe(401);

    const invalidTokenState = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: "Bearer forged.invalid.token" },
    });
    expect(invalidTokenState.status).toBe(401);

    const noTokenDecide = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionId: "perm-1", allow: true }),
    });
    expect(noTokenDecide.status).toBe(401);

    const noTokenDispatch = await fetch(`${info.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Analyse ledger" }),
    });
    expect(noTokenDispatch.status).toBe(401);

    const noTokenEvents = await fetch(`${info.serverUrl}/api/events`);
    expect(noTokenEvents.status).toBe(401);

    const validState = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    expect(validState.status).toBe(200);

    await server.stop();
  });

  it("dispatches decision callback to registered handler", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const recorded: { readonly permissionId: string; readonly allow: boolean }[] = [];
    server.onDecision((decision) => {
      recorded.push(decision);
    });

    const res = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissionId: "perm-fs-write", allow: true }),
    });

    expect(res.status).toBe(200);
    expect(recorded.length).toBe(1);
    if (recorded.length > 0) {
      const decision = recorded[0]!;
      expect(decision.permissionId).toBe("perm-fs-write");
      expect(decision.allow).toBe(true);
    }

    await server.stop();
  });

  it("dispatches job request to registered dispatch handler", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const recorded: { readonly prompt: string; readonly modelId?: string }[] = [];
    server.onDispatch((request) => {
      recorded.push(request);
    });

    const res = await fetch(`${info.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "Draft tax invoice", modelId: "claude-3-opus" }),
    });

    expect(res.status).toBe(200);
    expect(recorded.length).toBe(1);
    if (recorded.length > 0) {
      const dispatch = recorded[0]!;
      expect(dispatch.prompt).toBe("Draft tax invoice");
      expect(dispatch.modelId).toBe("claude-3-opus");
    }

    await server.stop();
  });

  it("updates workstation state and reflects it on GET /api/state", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    server.updateState({
      isRunning: true,
      activeModel: "gemini-1.5-pro",
      currentTask: "Synthesising ledger",
      pendingApprovals: [
        { id: "approval-1", title: "Read ledger", detail: "finance/q3.csv" },
      ],
      recentLogs: ["Session initialised", "Context loaded"],
    });

    const res = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });

    expect(res.status).toBe(200);
    const state = (await res.json()) as RemoteWorkstationState;
    expect(state.isRunning).toBe(true);
    expect(state.activeModel).toBe("gemini-1.5-pro");
    expect(state.currentTask).toBe("Synthesising ledger");
    expect(state.pendingApprovals.length).toBe(1);
    expect(state.recentLogs.length).toBe(2);

    await server.stop();
  });

  it("streams broadcast events over server-sent events", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const chunks: string[] = [];

    const clientReq = await new Promise<http.ClientRequest>((resolve, reject) => {
      const req = http.get(
        `${info.serverUrl}/api/events`,
        {
          headers: { Authorization: `Bearer ${info.token}` },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");

          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk.toString("utf8"));
          });

          resolve(req);
        }
      );
      req.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    server.broadcastEvent({
      type: "session_activity",
      data: { note: "Tool execution approved" },
    });

    await new Promise<void>((resolve) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (chunks.length > 0 || Date.now() - started > 2000) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.join("");
    expect(text).toContain("event: session_activity");
    expect(text).toContain("Tool execution approved");

    clientReq.destroy();
    await server.stop();
  });

  it("allows SSE authentication via query parameter for mobile Safari EventSource", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const chunks: string[] = [];
    const clientReq = await new Promise<http.ClientRequest>((resolve, reject) => {
      const req = http.get(
        `${info.serverUrl}/api/events?token=${encodeURIComponent(info.token)}`,
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk.toString("utf8"));
          });
          resolve(req);
        }
      );
      req.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    server.broadcastEvent({
      type: "heartbeat",
      data: { status: "alive" },
    });

    await new Promise<void>((resolve) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (chunks.length > 0 || Date.now() - started > 2000) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });

    expect(chunks.length).toBeGreaterThan(0);
    const text = chunks.join("");
    expect(text).toContain("event: heartbeat");
    expect(text).toContain("alive");

    clientReq.destroy();
    await server.stop();
  });

  it("closes cleanly with no dangling open handles", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();
    expect(server.port).toBeGreaterThan(0);

    const healthRes = await fetch(`${info.serverUrl}/api/health`);
    expect(healthRes.status).toBe(200);

    await server.stop();

    await expect(fetch(`${info.serverUrl}/api/health`, { signal: AbortSignal.timeout(300) }))
      .rejects
      .toThrow();

    await expect(server.stop()).resolves.toBeUndefined();
  });
});
