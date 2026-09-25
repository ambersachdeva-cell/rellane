import * as http from "node:http";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { WorkstationSnapshot } from "@cadrane/contracts";
import { installRemoteHostBridge } from "./remote-host-bridge.js";
import {
  createRemoteDispatchServer,
  computeActionRevision,
  type RemoteWorkstationState,
  type WorkstationReview,
} from "./remote-dispatch-server.js";

type PhoneDom = { readonly window: Window & typeof globalThis };
const jsdomModule: unknown = createRequire(import.meta.url)("jsdom");
const { JSDOM } = jsdomModule as { readonly JSDOM: new (html: string, options: {
  readonly url: string;
  readonly runScripts: "dangerously";
  readonly beforeParse: (window: Window) => void;
}) => PhoneDom };

it("binds permission revisions without delimiter collisions", () => {
  const first = computeActionRevision({ operationId: "a:b", permissionId: "c", title: "d", detail: "e" });
  const second = computeActionRevision({ operationId: "a", permissionId: "b:c", title: "d", detail: "e" });
  expect(first).not.toBe(second);
});

it("serves a phone client that pairs, reviews exact work, starts once, stops and disconnects", async () => {
  const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin: "246810" });
  const info = await server.start();
  const packet = createValidMockReview({ token: "a".repeat(64),
    contextPreview: "Full exact context\nSelected source content\nDo not spend money",
    projectId: "project-a", memoryEpoch: 2, contextSnapshotId: "snapshot-a" });
  let nextReview = packet;
  const snapshots = new Map<object, WorkstationSnapshot[]>();
  const running: WorkstationSnapshot = { operationId: "operation-phone-1", caseId: packet.caseId,
    providerId: packet.providerId, modelId: packet.modelId, sessionId: null, status: "running",
    startedAt: 1, updatedAt: 2, text: "", activity: [], permission: null, detail: "Running" };
  const host = {
    prepare: vi.fn(async (_input: unknown, _owner: object) => nextReview),
    start: vi.fn(async (_input: unknown, owner: object, _signal?: AbortSignal) => {
      snapshots.set(owner, [running]);
      return running;
    }),
    snapshotsForOwner: vi.fn((owner: object) => snapshots.get(owner) ?? []),
    decide: vi.fn(async (_operationId: string, _permissionId: string, _allow: boolean, owner: object) => {
      snapshots.set(owner, [running]);
      return running;
    }),
    stop: vi.fn(async (_caseId: string, _operationId: string, owner: object) => {
      const stopped = { ...running, status: "stopped" as const, updatedAt: 3 };
      snapshots.set(owner, [stopped]);
      return stopped;
    }),
    invalidate: vi.fn()
  };
  installRemoteHostBridge(server, host as unknown as Parameters<typeof installRemoteHostBridge>[1]);
  const seen: { path: string; body?: Record<string, unknown> }[] = [];
  let pairedToken = "";
  let dom: PhoneDom | undefined;
  try {
    expect(info.pairingUri).toContain("/pair?pin=246810");
    expect(info.pairingUri).not.toContain("token=");
    const pageResponse = await fetch(info.pairingUri);
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get("cache-control")).toBe("no-store");
    const html = await pageResponse.text();
    dom = new JSDOM(html, { url: info.pairingUri, runScripts: "dangerously",
      beforeParse(window) {
        Object.defineProperty(window, "fetch", { value: async (input: string, init?: RequestInit) => {
          const url = new URL(input, info.serverUrl);
          const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
          seen.push({ path: url.pathname, ...(body === undefined ? {} : { body }) });
          const response = await fetch(url, init);
          if (url.pathname === "/api/pair" && response.ok)
            pairedToken = ((await response.clone().json()) as { token: string }).token;
          return response;
        } });
      }
    });
    const document = dom.window.document;
    const element = (id: string) => document.getElementById(id)!;
    expect(dom.window.location.search).toBe("");
    expect((element("pin") as HTMLInputElement).value).toBe("246810");
    expect(element("review-section").hidden).toBe(true);
    expect((element("start-button") as HTMLButtonElement).disabled).toBe(true);
    element("pair-button").click();
    await vi.waitFor(() => expect(element("work-section").hidden).toBe(false));
    (element("case-id") as HTMLInputElement).value = packet.caseId;
    (element("provider-id") as HTMLSelectElement).value = packet.providerId;
    (element("model-id") as HTMLInputElement).value = packet.modelId!;
    (element("prompt") as HTMLTextAreaElement).value = packet.prompt;
    (element("source-ids") as HTMLTextAreaElement).value = "turn-1";
    element("prepare-button").click();
    await vi.waitFor(() => expect(element("review-section").hidden).toBe(false));
    expect(element("review-context").textContent).toBe(packet.contextPreview);
    expect(JSON.parse(element("review-details").textContent ?? "") as WorkstationReview).toEqual(packet);
    expect(host.start).not.toHaveBeenCalled();
    const preparedBody = seen.find((item) => item.path === "/api/prepare")?.body;
    expect(preparedBody).toMatchObject({ caseId: packet.caseId, providerId: packet.providerId,
      modelId: packet.modelId, prompt: packet.prompt, sourceTurnIds: ["turn-1"] });
    (element("review-confirm") as HTMLInputElement).checked = true;
    element("review-confirm").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    element("start-button").click();
    await vi.waitFor(() => expect(host.start).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((element("stop-button") as HTMLButtonElement).disabled).toBe(false));
    const startBody = seen.find((item) => item.path === "/api/dispatch")?.body;
    expect(Object.keys(startBody ?? {}).sort()).toEqual(["requestId", "reviewToken"]);
    expect(startBody?.reviewToken).toBe(packet.token);
    const consumed = await fetch(`${info.serverUrl}/api/dispatch`, { method: "POST",
      headers: { Authorization: `Bearer ${pairedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "consumed-review", reviewToken: packet.token }) });
    expect((await consumed.json()) as { status: string }).toMatchObject({ status: "rejected" });
    const owner = host.start.mock.calls[0]![1];
    const pending: WorkstationSnapshot = { ...running, status: "needs-approval", updatedAt: 3,
      permission: { id: "permission-phone-1", title: "Read a selected source",
        detail: "Read Source A inside this case" } };
    snapshots.set(owner, [pending]);
    element("refresh-button").click();
    await vi.waitFor(() => expect(element("approval-list").querySelector('[data-decision="allow"]')).not.toBeNull());
    expect(element("approval-list").textContent).toContain(pending.permission!.title);
    expect(element("approval-list").textContent).toContain(pending.permission!.detail);
    const shownState = JSON.parse(element("state-details").textContent ?? "") as RemoteWorkstationState;
    const staleRevision = shownState.pendingApprovals[0]!.revision;
    expect(element("approval-list").textContent).toContain(staleRevision);
    const staleAllow = element("approval-list").querySelector('[data-decision="allow"]') as HTMLButtonElement;
    snapshots.set(owner, [{ ...pending, updatedAt: 4,
      permission: { ...pending.permission!, detail: "Changed action detail" } }]);
    staleAllow.click();
    await vi.waitFor(() => expect(element("message").textContent).toContain("changed or expired"));
    expect(host.decide).not.toHaveBeenCalled();
    expect(seen.filter((item) => item.path === "/api/decide")).toHaveLength(0);
    const currentState = JSON.parse(element("state-details").textContent ?? "") as RemoteWorkstationState;
    const currentRevision = currentState.pendingApprovals[0]!.revision;
    expect(currentRevision).not.toBe(staleRevision);
    const currentDeny = element("approval-list").querySelector('[data-decision="deny"]') as HTMLButtonElement;
    currentDeny.click();
    await vi.waitFor(() => expect(host.decide).toHaveBeenCalledTimes(1));
    expect(host.decide).toHaveBeenCalledWith(running.operationId, "permission-phone-1", false, owner);
    expect(seen.find((item) => item.path === "/api/decide")?.body).toMatchObject({
      operationId: running.operationId, permissionId: "permission-phone-1", revision: currentRevision,
      allow: false
    });
    await vi.waitFor(() => expect(element("approval-list").textContent).toBe("") );
    nextReview = { ...packet, token: "b".repeat(64), expiresAt: Date.now() - 1 };
    element("prepare-button").click();
    await vi.waitFor(() => expect(element("message").textContent).toContain("expired"));
    expect(element("review-section").hidden).toBe(true);
    expect((element("start-button") as HTMLButtonElement).disabled).toBe(true);
    expect(host.start).toHaveBeenCalledTimes(1);
    element("stop-button").click();
    await vi.waitFor(() => expect(host.stop).toHaveBeenCalledTimes(1));
    expect(seen.find((item) => item.path === "/api/stop")?.body?.operationId).toBe(running.operationId);
    element("disconnect-button").click();
    await vi.waitFor(() => expect(host.invalidate).toHaveBeenCalledTimes(1));
    expect(element("pair-section").hidden).toBe(false);
    const revoked = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${pairedToken}` } });
    expect(revoked.status).toBe(401);
    const requestCount = seen.length;
    const reloaded = new JSDOM(html, { url: info.pairingUri, runScripts: "dangerously",
      beforeParse(window) { Object.defineProperty(window, "fetch", { value: () => {
        throw new Error("Reload must not make an automatic request");
      } }); }
    });
    expect(reloaded.window.document.getElementById("review-section")?.hidden).toBe(true);
    expect(seen).toHaveLength(requestCount);
    reloaded.window.close();
  } finally {
    dom?.window.close();
    await server.stop();
  }
});

function createValidMockReview(overrides?: Partial<WorkstationReview>): WorkstationReview {
  return {
    token: "e".repeat(64),
    caseId: "case-alpha-1",
    providerId: "claude",
    providerLabel: "Claude",
    modelId: "claude-3-5-sonnet",
    prompt: "Write release notes",
    contextPreview: "Changelog context preview",
    sourceIds: ["turn-1"],
    sourceHash: "hash-source-1",
    workspace: { id: "ws-1", label: "Main Workspace", path: "/workspaces/main" },
    expiresAt: Date.now() + 60_000,
    resumeSessionId: null,
    tools: {
      enabled: false,
      toolNames: [],
      skillIds: [],
      sources: [],
      totalSourceChars: 0,
      reachNote: "No tools enabled",
      freshSessionNote: "Fresh session note",
    },
    ...overrides,
  };
}

describe("RemoteDispatchServer", () => {
  it("limits LAN PIN guesses and restores pairing after the lockout", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin: "839201",
      maxPairingAttempts: 2, pairingLockoutMs: 30 });
    const info = await server.start();
    const pair = (pin: string) => fetch(`${info.serverUrl}/api/pair`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    try {
      expect((await pair("000000")).status).toBe(401);
      expect((await pair("111111")).status).toBe(401);
      expect((await pair("839201")).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await pair("839201")).status).toBe(200);
      expect((await pair("000000")).status).toBe(401);
    } finally {
      await server.stop();
    }
  });

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
    expect(stateRes.status).toBe(503);

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
      body: JSON.stringify({
        requestId: "req-unauth-1",
        operationId: "op-1",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(noTokenDecide.status).toBe(401);

    const noTokenDispatch = await fetch(`${info.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-unauth-2", reviewToken: "a".repeat(64) }),
    });
    expect(noTokenDispatch.status).toBe(401);

    const noTokenEvents = await fetch(`${info.serverUrl}/api/events`);
    expect(noTokenEvents.status).toBe(401);

    const validState = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    expect(validState.status).toBe(503);

    await server.stop();
  });

  it("prepare accepts complete review payload and never auto-dispatches", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    let dispatchCalled = false;
    server.onDispatch(() => {
      dispatchCalled = true;
      return { status: "accepted" };
    });

    const mockReview = createValidMockReview({
      projectId: "project-1", memoryEpoch: 3, contextSnapshotId: "snapshot-1",
      contextPreview: "Full exact packet\nSelected source A\nApproved constraint B",
      sourceIds: ["source-a"], sourceHash: "sha256-of-full-packet",
      tools: { enabled: true, toolNames: ["read_source"], skillIds: ["skill-a"],
        sources: [{ label: "Source A", chars: 18 }], totalSourceChars: 18,
        reachNote: "Only Source A", freshSessionNote: "New session" }
    });
    let recordedPrincipal = "";
    server.onPrepare((req, principalId) => {
      recordedPrincipal = principalId;
      expect(req.caseId).toBe("case-1");
      expect(req.providerId).toBe("claude");
      expect(req.modelId).toBe("claude-3-5-sonnet");
      expect(req.sourceTurnIds).toEqual([]);
      return { status: "accepted", review: mockReview };
    });

    const res = await fetch(`${info.serverUrl}/api/prepare`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-prep-1",
        caseId: "case-1",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Review test prompt",
        sourceTurnIds: [],
        enableTools: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly status: string; readonly review?: WorkstationReview };
    expect(body.status).toBe("accepted");
    expect(body.review).toBeDefined();
    expect(body.review).toEqual(mockReview);
    expect(recordedPrincipal.length).toBeGreaterThan(0);
    expect(dispatchCalled).toBe(false);

    await server.stop();
  });

  it("prepare returns uncertain when handler returns success without complete review payload", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    server.onPrepare(() => {
      return { status: "accepted" };
    });

    const res = await fetch(`${info.serverUrl}/api/prepare`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-prep-incomplete",
        caseId: "case-1",
        providerId: "codex",
        modelId: "codex-preview",
        prompt: "Test prompt",
        sourceTurnIds: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly status: string; readonly detail?: string };
    expect(body.status).toBe("uncertain");
    expect(body.detail).toContain("complete WorkstationReview");

    await server.stop();
  });

  it("starts only the latest review token for a pairing", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();
    const first = createValidMockReview({ token: "1".repeat(64) });
    const second = createValidMockReview({ token: "2".repeat(64) });
    let prepares = 0;
    let starts = 0;
    server.onPrepare(() => ({ status: "accepted", review: ++prepares === 1 ? first : second }));
    server.onDispatch(() => { starts++; return { status: "accepted", operationId: "operation-1" }; });
    const headers = { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" };
    for (const requestId of ["prepare-first", "prepare-second"]) {
      const response = await fetch(`${info.serverUrl}/api/prepare`, { method: "POST", headers,
        body: JSON.stringify({ requestId, caseId: "case-alpha-1", providerId: "claude",
          modelId: "claude-3-5-sonnet", prompt: "Write release notes", sourceTurnIds: ["turn-1"] }) });
      expect((await response.json()) as { status: string }).toMatchObject({ status: "accepted" });
    }
    const old = await fetch(`${info.serverUrl}/api/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ requestId: "start-old", reviewToken: first.token }) });
    expect((await old.json()) as { status: string }).toMatchObject({ status: "rejected" });
    expect(starts).toBe(0);
    const current = await fetch(`${info.serverUrl}/api/dispatch`, { method: "POST", headers,
      body: JSON.stringify({ requestId: "start-current", reviewToken: second.token }) });
    expect((await current.json()) as { status: string }).toMatchObject({ status: "accepted" });
    expect(starts).toBe(1);
    await server.stop();
  });

  it("rejects legacy prompt dispatch with clear new-review instruction", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    server.onDispatch(() => ({ status: "accepted" }));

    const res = await fetch(`${info.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-legacy-1",
        prompt: "Legacy direct dispatch",
        modelId: "gpt-4",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { readonly detail?: string };
    expect(body.detail).toContain("Legacy dispatch with prompt/modelId is no longer supported");
    expect(body.detail).toContain("POST /api/prepare first");

    await server.stop();
  });

  it("enforces principal isolation: review prepared by one principal is rejected for another principal", async () => {
    const pin = "718293";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info1 = await server.start();

    const pairRes = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    expect(pairRes.status).toBe(200);
    const pairBody = (await pairRes.json()) as { readonly token: string };
    const token2 = pairBody.token;

    const reviewToken = "d".repeat(64);
    const mockReview = createValidMockReview({ token: reviewToken });

    server.onPrepare(() => ({ status: "accepted", review: mockReview }));
    server.onDispatch(() => ({ status: "accepted", operationId: "op-disp-1" }));

    const prepRes = await fetch(`${info1.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p1-prep",
        caseId: "case-1",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Draft notes",
        sourceTurnIds: [],
      }),
    });
    expect(prepRes.status).toBe(200);

    const foreignDispatchRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p2-foreign",
        reviewToken,
      }),
    });
    expect(foreignDispatchRes.status).toBe(200);
    const foreignBody = (await foreignDispatchRes.json()) as { readonly status: string; readonly detail?: string };
    expect(foreignBody.status).toBe("rejected");
    expect(foreignBody.detail).toBe("Review token not found or already used.");

    const ownerDispatchRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p1-dispatch",
        reviewToken,
      }),
    });
    expect(ownerDispatchRes.status).toBe(200);
    const ownerBody = (await ownerDispatchRes.json()) as { readonly status: string; readonly operationId?: string };
    expect(ownerBody.status).toBe("accepted");
    expect(ownerBody.operationId).toBe("op-disp-1");

    await server.stop();
  });

  it("scopes replay cache to authenticated principal and does not leak or conflict across tokens", async () => {
    const pin = "554433";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info1 = await server.start();

    const pairRes = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const pairBody = (await pairRes.json()) as { readonly token: string };
    const token2 = pairBody.token;

    const reviewToken1 = "1".repeat(64);
    const reviewToken2 = "2".repeat(64);
    const review1 = createValidMockReview({ token: reviewToken1 });
    const review2 = createValidMockReview({ token: reviewToken2 });

    server.onPrepare((req, principalId) => {
      if (principalId === info1.principalId) {
        return { status: "accepted", review: review1 };
      }
      return { status: "accepted", review: review2 };
    });

    server.onDispatch((req, principalId) => {
      return { status: "accepted", operationId: `op-${principalId}` };
    });

    await fetch(`${info1.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p1-prepare",
        caseId: "case-1",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Review 1",
        sourceTurnIds: [],
      }),
    });

    await fetch(`${info1.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p2-prepare",
        caseId: "case-2",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Review 2",
        sourceTurnIds: [],
      }),
    });

    const sharedRequestId = "req-shared-nonce-1";
    const payload1 = JSON.stringify({ requestId: sharedRequestId, reviewToken: reviewToken1 });
    const payload2 = JSON.stringify({ requestId: sharedRequestId, reviewToken: reviewToken2 });

    const res1 = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: payload1,
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { readonly status: string; readonly operationId: string };
    expect(body1.status).toBe("accepted");

    const res2 = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: payload2,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { readonly status: string; readonly operationId: string };
    expect(body2.status).toBe("accepted");
    expect(body1.operationId).not.toEqual(body2.operationId);

    const res1Replay = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: payload1,
    });
    expect(res1Replay.status).toBe(200);
    const body1Replay = (await res1Replay.json()) as { readonly operationId: string };
    expect(body1Replay.operationId).toBe(body1.operationId);

    await server.stop();
  });

  it("dispatches decision callback with strict operationId and revision validation", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const expectedRevision = computeActionRevision({
      operationId: "op-decide-1",
      permissionId: "perm-fs-write",
      title: "Write output",
      detail: "out.csv",
      hostUpdate: "v1",
    });

    server.onDecision((decision) => {
      if (decision.revision !== expectedRevision) {
        return { status: "rejected", detail: "Action revision mismatch" };
      }
      return { status: "accepted", operationId: decision.operationId };
    });

    const resMismatch = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-dec-bad-rev",
        operationId: "op-decide-1",
        permissionId: "perm-fs-write",
        revision: "stale-revision-hash",
        allow: true,
      }),
    });
    expect(resMismatch.status).toBe(200);
    const bodyMismatch = (await resMismatch.json()) as { readonly status: string; readonly detail?: string };
    expect(bodyMismatch.status).toBe("rejected");
    expect(bodyMismatch.detail).toBe("Action revision mismatch");

    const resValid = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-dec-good-rev",
        operationId: "op-decide-1",
        permissionId: "perm-fs-write",
        revision: expectedRevision,
        allow: true,
      }),
    });
    expect(resValid.status).toBe(200);
    const bodyValid = (await resValid.json()) as { readonly status: string };
    expect(bodyValid.status).toBe("accepted");

    await server.stop();
  });

  it("serves isolated per-principal state on GET /api/state", async () => {
    const pin = "998877";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info1 = await server.start();

    const pairRes = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const pairBody = (await pairRes.json()) as { readonly token: string };
    const token2 = pairBody.token;

    server.onState((principalId) => {
      const isOwner = principalId === info1.principalId;
      return {
        isRunning: isOwner,
        activeModel: isOwner ? "claude-3-5-sonnet" : "gemini-1.5-pro",
        pendingApprovals: isOwner
          ? [
              {
                operationId: "op-1",
                permissionId: "perm-1",
                title: "Approve build",
                detail: "target=prod",
                revision: "rev-hash-1",
                expiresAt: Date.now() + 10_000,
              },
            ]
          : [],
        recentLogs: isOwner ? ["Owner task running"] : ["Peer task idle"],
      };
    });

    const res1 = await fetch(`${info1.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info1.token}` },
    });
    expect(res1.status).toBe(200);
    const state1 = (await res1.json()) as RemoteWorkstationState;
    expect(state1.isRunning).toBe(true);
    expect(state1.pendingApprovals.length).toBe(1);
    expect(state1.pendingApprovals[0]?.revision).toBe("rev-hash-1");

    const res2 = await fetch(`${info1.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(res2.status).toBe(200);
    const state2 = (await res2.json()) as RemoteWorkstationState;
    expect(state2.isRunning).toBe(false);
    expect(state2.pendingApprovals.length).toBe(0);

    await server.stop();
  });

  it("revokes principal, closes SSE streams, and fires callback on token expiry without HTTP request", async () => {
    const server = createRemoteDispatchServer({
      port: 0,
      host: "127.0.0.1",
      sessionTtlMs: 50,
    });
    const info = await server.start();

    let revokedPrincipal = "";
    let revocationReason = "";
    server.onRevokePrincipal((rev) => {
      revokedPrincipal = rev.principalId;
      revocationReason = rev.reason;
    });

    let sseClosed = false;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `${info.serverUrl}/api/events`,
        { headers: { Authorization: `Bearer ${info.token}` } },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.on("close", () => {
            sseClosed = true;
          });
          res.on("end", () => {
            sseClosed = true;
          });
          res.resume();
          resolve();
        }
      );
      req.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(sseClosed).toBe(true);
    expect(revokedPrincipal).toBe(info.principalId);
    expect(revocationReason).toBe("expired");

    const postExpiryRes = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    expect(postExpiryRes.status).toBe(401);

    await server.stop();
  });

  it("scopes SSE delivery so principal events do not leak to other principals", async () => {
    const pin = "123987";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info1 = await server.start();

    const pairRes = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const pairBody = (await pairRes.json()) as { readonly token: string };
    const token2 = pairBody.token;

    const chunks1: string[] = [];
    const chunks2: string[] = [];

    const req1 = await new Promise<http.ClientRequest>((resolve, reject) => {
      const r = http.get(
        `${info1.serverUrl}/api/events`,
        { headers: { Authorization: `Bearer ${info1.token}` } },
        (res) => {
          res.on("data", (chunk: Buffer) => chunks1.push(chunk.toString("utf8")));
          resolve(r);
        }
      );
      r.on("error", reject);
    });

    const req2 = await new Promise<http.ClientRequest>((resolve, reject) => {
      const r = http.get(
        `${info1.serverUrl}/api/events`,
        { headers: { Authorization: `Bearer ${token2}` } },
        (res) => {
          res.on("data", (chunk: Buffer) => chunks2.push(chunk.toString("utf8")));
          resolve(r);
        }
      );
      r.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    server.sendEvent(info1.principalId, {
      type: "private_approval",
      data: { secret: "principal-1-only" },
    });

    server.broadcastEvent({
      type: "heartbeat",
      data: { status: "alive" },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const text1 = chunks1.join("");
    const text2 = chunks2.join("");

    expect(text1).toContain("principal-1-only");
    expect(text2).not.toContain("principal-1-only");
    expect(text1).toContain("alive");
    expect(text2).toContain("alive");

    req1.destroy();
    req2.destroy();
    await server.stop();
  });

  it("dispatches stop command with operationId and rejects absent stop handler", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const absentRes = await fetch(`${info.serverUrl}/api/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-stop-1", operationId: "op-101" }),
    });
    expect(absentRes.status).toBe(503);

    const stoppedOperations: string[] = [];
    server.onStop((req, principalId) => {
      expect(principalId).toBe(info.principalId);
      stoppedOperations.push(req.operationId);
      return { status: "accepted", operationId: req.operationId };
    });

    const res = await fetch(`${info.serverUrl}/api/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-stop-2", operationId: "op-102" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly status?: string; readonly operationId?: string };
    expect(body.status).toBe("accepted");
    expect(body.operationId).toBe("op-102");
    expect(stoppedOperations).toEqual(["op-102"]);

    await server.stop();
  });

  it("returns uncertain on restart in-flight and does not cache completions into new lifetime", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info1 = await server.start();

    const reviewToken = "f".repeat(64);
    const review = createValidMockReview({ token: reviewToken });
    server.onPrepare(() => ({ status: "accepted", review }));

    await fetch(`${info1.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-prep-inflight-1",
        caseId: "case-1",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Inflight prompt",
        sourceTurnIds: [],
      }),
    });

    let releaseHandler: (() => void) | null = null;
    server.onDispatch(async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return { status: "accepted" };
    });

    const inflightPromise = fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-inflight-1", reviewToken }),
    }).catch((err: unknown) => err);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.stop();

    if (releaseHandler) {
      const fn = releaseHandler as () => void;
      fn();
    }
    await inflightPromise;

    const info2 = await server.start();
    server.onPrepare(() => ({ status: "accepted", review }));
    await fetch(`${info2.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info2.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-prep-inflight-2",
        caseId: "case-1",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Inflight prompt 2",
        sourceTurnIds: [],
      }),
    });

    let newLifetimeRan = false;
    server.onDispatch(() => {
      newLifetimeRan = true;
      return { status: "accepted", operationId: "new-gen-op" };
    });

    const resNew = await fetch(`${info2.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info2.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-inflight-1", reviewToken }),
    });
    expect(resNew.status).toBe(200);
    const bodyNew = (await resNew.json()) as { readonly operationId?: string };
    expect(bodyNew.operationId).toBe("new-gen-op");
    expect(newLifetimeRan).toBe(true);

    await server.stop();
  });

  it("validates required bounded fields on mutating commands", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    server.onPrepare(() => ({ status: "accepted", review: createValidMockReview() }));
    server.onDispatch(() => ({ status: "accepted" }));
    server.onDecision(() => ({ status: "accepted" }));
    server.onStop(() => ({ status: "accepted" }));

    const resPrepMissing = await fetch(`${info.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-p-val-1", prompt: "Missing caseId" }),
    });
    expect(resPrepMissing.status).toBe(400);

    const resDispatchMissing = await fetch(`${info.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-val-1" }),
    });
    expect(resDispatchMissing.status).toBe(400);

    const resDecideBareYes = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-dec-val-1", allow: true }),
    });
    expect(resDecideBareYes.status).toBe(400);

    const resStopMissing = await fetch(`${info.serverUrl}/api/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-s-val-1" }),
    });
    expect(resStopMissing.status).toBe(400);

    await server.stop();
  });

  it("drops unscoped private broadcast events so neither principal receives private payload", async () => {
    const pin = "234567";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info1 = await server.start();

    const pairRes = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const pairBody = (await pairRes.json()) as { readonly token: string };
    const token2 = pairBody.token;

    const chunks1: string[] = [];
    const chunks2: string[] = [];

    const req1 = await new Promise<http.ClientRequest>((resolve, reject) => {
      const r = http.get(
        `${info1.serverUrl}/api/events`,
        { headers: { Authorization: `Bearer ${info1.token}` } },
        (res) => {
          res.on("data", (chunk: Buffer) => chunks1.push(chunk.toString("utf8")));
          resolve(r);
        }
      );
      r.on("error", reject);
    });

    const req2 = await new Promise<http.ClientRequest>((resolve, reject) => {
      const r = http.get(
        `${info1.serverUrl}/api/events`,
        { headers: { Authorization: `Bearer ${token2}` } },
        (res) => {
          res.on("data", (chunk: Buffer) => chunks2.push(chunk.toString("utf8")));
          resolve(r);
        }
      );
      r.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    server.broadcastEvent({
      type: "workstation_private_log",
      data: { secret: "private-session-details" },
    });

    server.broadcastEvent({
      type: "heartbeat",
      data: { status: "alive" },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const text1 = chunks1.join("");
    const text2 = chunks2.join("");

    expect(text1).not.toContain("private-session-details");
    expect(text2).not.toContain("private-session-details");
    expect(text1).toContain("alive");
    expect(text2).toContain("alive");

    req1.destroy();
    req2.destroy();
    await server.stop();
  });

  it("enforces review token existence, single-use consumption, expiry, and caching on dispatch", async () => {
    const pin = "345678";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin });
    const info1 = await server.start();

    const pairRes = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const pairBody = (await pairRes.json()) as { readonly token: string };
    const token2 = pairBody.token;

    let handlerCalls = 0;
    server.onDispatch(() => {
      handlerCalls++;
      return { status: "accepted", operationId: "op-disp-tested" };
    });
    let preparedReview = createValidMockReview();
    server.onPrepare(() => ({ status: "accepted", review: preparedReview }));

    const missingRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-missing", reviewToken: "m".repeat(64) }),
    });
    expect(missingRes.status).toBe(200);
    const missingBody = (await missingRes.json()) as { readonly status: string; readonly detail?: string };
    expect(missingBody.status).toBe("rejected");
    expect(missingBody.detail).toContain("not found or already used");
    expect(handlerCalls).toBe(0);

    const expiredToken = "x".repeat(64);
    const expiredReview = createValidMockReview({ token: expiredToken, expiresAt: Date.now() - 5000 });
    preparedReview = expiredReview;
    const expiredPrepare = await fetch(`${info1.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-prep-exp",
        caseId: "case-exp",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Expired review",
        sourceTurnIds: [],
      }),
    });

    expect((await expiredPrepare.json()) as { status: string }).toMatchObject({ status: "rejected" });
    const expDispatchRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-expired", reviewToken: expiredToken }),
    });
    expect(expDispatchRes.status).toBe(200);
    const expDispatchBody = (await expDispatchRes.json()) as { readonly status: string; readonly detail?: string };
    expect(expDispatchBody.status).toBe("rejected");
    expect(expDispatchBody.detail).toContain("not found or already used");
    expect(handlerCalls).toBe(0);

    const validToken = "v".repeat(64);
    const validReview = createValidMockReview({ token: validToken, expiresAt: Date.now() + 60_000 });
    preparedReview = validReview;
    await fetch(`${info1.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-prep-valid",
        caseId: "case-valid",
        providerId: "claude",
        modelId: "claude-3-5-sonnet",
        prompt: "Valid review",
        sourceTurnIds: [],
      }),
    });

    const foreignRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-foreign", reviewToken: validToken }),
    });
    expect(foreignRes.status).toBe(200);
    const foreignBody = (await foreignRes.json()) as { readonly status: string; readonly detail?: string };
    expect(foreignBody.status).toBe("rejected");
    expect(foreignBody.detail).toBe("Review token not found or already used.");
    expect(handlerCalls).toBe(0);

    const validDispatchRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-success", reviewToken: validToken }),
    });
    expect(validDispatchRes.status).toBe(200);
    const validDispatchBody = (await validDispatchRes.json()) as { readonly status: string; readonly operationId?: string };
    expect(validDispatchBody.status).toBe("accepted");
    expect(validDispatchBody.operationId).toBe("op-disp-tested");
    expect(handlerCalls).toBe(1);

    const reusedDispatchRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-reuse", reviewToken: validToken }),
    });
    expect(reusedDispatchRes.status).toBe(200);
    const reusedDispatchBody = (await reusedDispatchRes.json()) as { readonly status: string; readonly detail?: string };
    expect(reusedDispatchBody.status).toBe("rejected");
    expect(reusedDispatchBody.detail).toContain("not found or already used");
    expect(handlerCalls).toBe(1);

    const dupRes = await fetch(`${info1.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-d-success", reviewToken: validToken }),
    });
    expect(dupRes.status).toBe(200);
    const dupBody = (await dupRes.json()) as { readonly status: string; readonly operationId?: string };
    expect(dupBody.status).toBe("accepted");
    expect(dupBody.operationId).toBe("op-disp-tested");
    expect(handlerCalls).toBe(1);

    await server.stop();
  });

  it("rejects GET /api/state with 401 when token expires during deferred state retrieval without leaking state", async () => {
    const server = createRemoteDispatchServer({
      port: 0,
      host: "127.0.0.1",
      sessionTtlMs: 50,
    });
    const info = await server.start();

    server.onState(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        isRunning: true,
        currentTask: "SecretSensitiveTask",
        recentLogs: ["Confidential log entry"],
        pendingApprovals: [],
      };
    });

    const res = await fetch(`${info.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("SecretSensitiveTask");
    expect(text).not.toContain("Confidential log entry");

    await server.stop();
  });

  it("does not retain a review returned after its principal expires during prepare", async () => {
    const pin = "312897";
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1", pin, sessionTtlMs: 100 });
    const info = await server.start();
    const review = createValidMockReview({ token: "z".repeat(64) });
    let entered!: () => void;
    let finish!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    server.onPrepare(async () => { entered(); await gate; return { status: "accepted", review }; });
    server.onDispatch(() => ({ status: "accepted", operationId: "should-not-start" }));

    const pending = fetch(`${info.serverUrl}/api/prepare`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "deferred-prep", caseId: review.caseId,
        providerId: review.providerId, modelId: review.modelId, prompt: review.prompt, sourceTurnIds: [] })
    });
    await enteredPromise;
    await new Promise((resolve) => setTimeout(resolve, 130));
    finish();
    const result = await pending;
    expect(result.status).toBe(401);
    expect((await result.json()) as { status: string }).toMatchObject({ status: "uncertain" });

    const pair = await fetch(`${info.serverUrl}/api/pair`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    const fresh = (await pair.json()) as { token: string };
    const dispatch = await fetch(`${info.serverUrl}/api/dispatch`, { method: "POST",
      headers: { Authorization: `Bearer ${fresh.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "after-expired-prep", reviewToken: review.token }) });
    expect((await dispatch.json()) as { status: string }).toMatchObject({ status: "rejected" });
    await server.stop();
  });

  it("cleans up expired principal replay entries to release capacity while preserving live principal receipts", async () => {
    const pin = "654321";
    const server = createRemoteDispatchServer({
      port: 0,
      host: "127.0.0.1",
      pin,
      sessionTtlMs: 80,
      maxReplayEntries: 2,
    });
    const info1 = await server.start();

    server.onDecision((req) => ({ status: "accepted", operationId: req.operationId }));

    const res1 = await fetch(`${info1.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p1-slot",
        operationId: "op-p1",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(res1.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const pair2Res = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    expect(pair2Res.status).toBe(200);
    const token2 = ((await pair2Res.json()) as { readonly token: string }).token;

    const res2 = await fetch(`${info1.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p2-slot",
        operationId: "op-p2",
        permissionId: "perm-2",
        revision: "rev-2",
        allow: true,
      }),
    });
    expect(res2.status).toBe(200);

    const fullRes = await fetch(`${info1.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p2-overflow",
        operationId: "op-overflow",
        permissionId: "perm-2",
        revision: "rev-2",
        allow: true,
      }),
    });
    expect(fullRes.status).toBe(503);

    await new Promise((resolve) => setTimeout(resolve, 65));

    const p1Replay = await fetch(`${info1.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info1.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p1-slot",
        operationId: "op-p1",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(p1Replay.status).toBe(401);

    const p2Replay = await fetch(`${info1.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p2-slot",
        operationId: "op-p2",
        permissionId: "perm-2",
        revision: "rev-2",
        allow: true,
      }),
    });
    expect(p2Replay.status).toBe(200);
    const p2Body = (await p2Replay.json()) as { readonly operationId?: string };
    expect(p2Body.operationId).toBe("op-p2");

    const pair3Res = await fetch(`${info1.serverUrl}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    expect(pair3Res.status).toBe(200);
    const token3 = ((await pair3Res.json()) as { readonly token: string }).token;

    const res3 = await fetch(`${info1.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token3}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-p3-slot",
        operationId: "op-p3",
        permissionId: "perm-3",
        revision: "rev-3",
        allow: true,
      }),
    });
    expect(res3.status).toBe(200);
    const p3Body = (await res3.json()) as { readonly operationId?: string };
    expect(p3Body.operationId).toBe("op-p3");

    await server.stop();
  });

  it("handles concurrent duplicate requests by returning identical receipt without executing handler twice", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    let executions = 0;
    server.onDecision(async (decision) => {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: "accepted", operationId: decision.operationId };
    });

    const payload = JSON.stringify({
      requestId: "req-concurrent-dup",
      operationId: "op-concurrent-1",
      permissionId: "perm-exec",
      revision: "rev-1",
      allow: true,
    });

    const [res1, res2] = await Promise.all([
      fetch(`${info.serverUrl}/api/decide`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json",
        },
        body: payload,
      }),
      fetch(`${info.serverUrl}/api/decide`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${info.token}`,
          "Content-Type": "application/json",
        },
        body: payload,
      }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = (await res1.json()) as { readonly status?: string; readonly operationId?: string };
    const body2 = (await res2.json()) as { readonly status?: string; readonly operationId?: string };

    expect(body1).toEqual(body2);
    expect(body1.status).toBe("accepted");
    expect(body1.operationId).toBe("op-concurrent-1");
    expect(executions).toBe(1);

    const res3 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    expect(res3.status).toBe(200);
    const body3 = (await res3.json()) as { readonly status?: string; readonly operationId?: string };
    expect(body3).toEqual(body1);
    expect(executions).toBe(1);

    await server.stop();
  });

  it("rejects replayed request ID when payload differs with 409 conflict", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    server.onDecision(() => ({ status: "accepted" }));

    const res1 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-conflict-id",
        operationId: "op-1",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-conflict-id",
        operationId: "op-1",
        permissionId: "perm-1",
        revision: "rev-2",
        allow: false,
      }),
    });
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { readonly error?: string };
    expect(body2.error).toBe("Conflict");

    await server.stop();
  });

  it("fails new requests with bounded capacity error when replay map is full, preserving existing outcomes", async () => {
    const server = createRemoteDispatchServer({
      port: 0,
      host: "127.0.0.1",
      maxReplayEntries: 2,
    });
    const info = await server.start();

    server.onDecision((req) => ({ status: "accepted", operationId: req.operationId }));

    const res1 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-cap-1",
        operationId: "op-1",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-cap-2",
        operationId: "op-2",
        permissionId: "perm-2",
        revision: "rev-2",
        allow: true,
      }),
    });
    expect(res2.status).toBe(200);

    const replay1 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-cap-1",
        operationId: "op-1",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(replay1.status).toBe(200);
    const bodyReplay1 = (await replay1.json()) as { readonly status?: string; readonly operationId?: string };
    expect(bodyReplay1.status).toBe("accepted");
    expect(bodyReplay1.operationId).toBe("op-1");

    const res3 = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-cap-3",
        operationId: "op-3",
        permissionId: "perm-3",
        revision: "rev-3",
        allow: true,
      }),
    });
    expect(res3.status).toBe(503);
    const body3 = (await res3.json()) as { readonly error?: string };
    expect(body3.error).toBe("Service Unavailable");

    await server.stop();
  });

  it("returns 503 unavailable when handler is absent and 500 without leaking stack or secrets when handler fails", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    const absentRes = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-absent-1",
        operationId: "op-absent",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(absentRes.status).toBe(503);
    const absentBody = (await absentRes.json()) as { readonly error?: string };
    expect(absentBody.error).toBe("Service Unavailable");

    server.onDecision(async () => {
      throw new Error(`Worker crashed on secret pin ${server.pin} at /Users/developer/secret/path: line 99\n    at internalRun (node:internal:12)`);
    });

    const failingRes = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-fail-1",
        operationId: "op-fail",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });
    expect(failingRes.status).toBe(500);
    const failBody = (await failingRes.json()) as { readonly error?: string; readonly detail?: string; readonly status?: string };
    expect(failBody.error).toBe("Command Error");
    expect(failBody.status).toBe("uncertain");
    expect(failBody.detail).toBeDefined();
    expect(failBody.detail).not.toContain(server.pin);
    expect(failBody.detail).not.toContain("/Users/developer");
    expect(failBody.detail).not.toContain("at internalRun");

    await server.stop();
  });

  it("reports uncertain when handler returns void without explicit receipt", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    server.onDecision(() => {
      // returns void
    });

    const res = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-void-1",
        operationId: "op-void",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { readonly status?: string; readonly detail?: string };
    expect(body.status).toBe("uncertain");
    expect(body.detail).toBe("Handler returned no explicit receipt.");

    await server.stop();
  });

  it("rejects request with 401 when token expires after read or before execution", async () => {
    const server = createRemoteDispatchServer({
      port: 0,
      host: "127.0.0.1",
      sessionTtlMs: 25,
    });
    const info = await server.start();

    server.onDecision(() => ({ status: "accepted" }));

    await new Promise((resolve) => setTimeout(resolve, 40));

    const res = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-expired-1",
        operationId: "op-expired",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { readonly error?: string };
    expect(body.error).toBe("Unauthorized");

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

  it("awaits async handlers and returns truthful explicit result", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    let handlerFinished = false;
    server.onDecision(async (decision) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      handlerFinished = true;
      return { status: "accepted", operationId: decision.operationId };
    });

    const res = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-async-1",
        operationId: "op-async-99",
        permissionId: "perm-fs",
        revision: "rev-1",
        allow: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(handlerFinished).toBe(true);
    const body = (await res.json()) as { readonly status?: string; readonly operationId?: string };
    expect(body.status).toBe("accepted");
    expect(body.operationId).toBe("op-async-99");

    await server.stop();
  });

  it("rejects ambiguous multiple registered handlers with 409 conflict instead of duplicate execution", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info = await server.start();

    let executionsA = 0;
    let executionsB = 0;

    server.onDecision(() => {
      executionsA++;
    });
    server.onDecision(() => {
      executionsB++;
    });

    const res = await fetch(`${info.serverUrl}/api/decide`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req-ambig-1",
        operationId: "op-ambig",
        permissionId: "perm-1",
        revision: "rev-1",
        allow: true,
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { readonly error?: string; readonly detail?: string };
    expect(body.error).toBe("Conflict");
    expect(body.detail).toContain("Ambiguous command handlers");
    expect(executionsA).toBe(0);
    expect(executionsB).toBe(0);

    await server.stop();
  });

  it("rotates secret on restart and invalidates tokens from previous session", async () => {
    const server = createRemoteDispatchServer({ port: 0, host: "127.0.0.1" });
    const info1 = await server.start();
    const token1 = info1.token;

    server.onDecision(() => ({ status: "accepted" }));

    const res1 = await fetch(`${info1.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(res1.status).toBe(503);

    await server.stop();

    const info2 = await server.start();
    expect(info2.token).not.toBe(token1);

    const oldTokenRes = await fetch(`${info2.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(oldTokenRes.status).toBe(401);

    const newTokenRes = await fetch(`${info2.serverUrl}/api/state`, {
      headers: { Authorization: `Bearer ${info2.token}` },
    });
    expect(newTokenRes.status).toBe(503);

    await server.stop();
  });
});
