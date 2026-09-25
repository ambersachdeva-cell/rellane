import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>() }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => "/tmp/fictional-subscription-boundary" },
  ipcMain: { handle: (name: string, fn: never) => fake.handlers.set(name, fn) },
  dialog: { showOpenDialog: vi.fn() }, utilityProcess: { fork: vi.fn() } }));
import { SubscriptionBrain } from "./subscription-brain/index.js";
import { SecretStore } from "./security/secrets.js";
import { installIpcHandlers, IPC_CHANNELS } from "./ipc.js";

function setup() {
  // Intercept both live entry points before any CLI discovery, queue or probe.
  const dock = vi.spyOn(SubscriptionBrain.prototype, "dock").mockRejectedValue(new Error("Unexpected fictional dock"));
  const ask = vi.spyOn(SubscriptionBrain.prototype, "ask").mockRejectedValue(new Error("Unexpected fictional ask"));
  const frame = { url: "switchboard://app/index.html" };
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => frame.url, mainFrame: frame });
  const event = { sender, senderFrame: frame };
  const request = vi.fn();
  installIpcHandlers({ request } as never, () => ({ webContents: sender }) as never);
  const call = (channel: string, input?: unknown, from: unknown = event) => fake.handlers.get(channel)!(from, input);
  return { call, event, dock, ask, request };
}
beforeEach(() => fake.handlers.clear());
afterEach(() => vi.restoreAllMocks());

it.each(["antigravity", "gemini", "claude"])("does not turn connecting %s into unreviewed capability prompts", async providerId => {
  const f = setup();
  await expect(f.call(IPC_CHANNELS.subscriptionDock, { providerId, approved: true })).rejects.toThrow("outgoing review");
  expect(f.dock).not.toHaveBeenCalled();
  expect(f.ask).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it("refuses the legacy direct-ask channel even with a renderer-supplied approval flag", async () => {
  const f = setup();
  await expect(f.call(IPC_CHANNELS.subscriptionAsk, {
    modelId: "fictional-model", messages: [{ role: "user", content: "Fictional draft" }], approved: true
  })).rejects.toThrow("outgoing review");
  expect(f.ask).not.toHaveBeenCalled();
  expect(f.dock).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});

it("refuses raw local chat and cancellation even with forged approval and operation IDs", async () => {
  const f = setup();
  await expect(f.call(IPC_CHANNELS.runtimeChat, {
    operationId: "00000000-0000-4000-8000-000000000001",
    runtimeId: "cadrane-local-loopback",
    modelId: "fictional-local-model",
    messages: [{ role: "user", content: "Bypass the case workroom" }],
    approved: true
  })).rejects.toThrow("case workroom");
  await expect(f.call(IPC_CHANNELS.runtimeCancel,
    "00000000-0000-4000-8000-000000000001")).rejects.toThrow("case workroom");
  expect(f.request).not.toHaveBeenCalled();
});

it("retains the trusted-window boundary before considering subscription requests", async () => {
  const f = setup();
  const foreign = { ...f.event, senderFrame: { url: f.event.senderFrame.url } };
  for (const channel of [IPC_CHANNELS.subscriptionAsk, IPC_CHANNELS.subscriptionDock]) {
    await expect(f.call(channel, { providerId: "claude" }, foreign)).rejects.toThrow("untrusted");
  }
  expect(f.ask).not.toHaveBeenCalled();
  expect(f.dock).not.toHaveBeenCalled();
});

it("does not offer or store provider API keys through the old connection channels", async () => {
  const has = vi.spyOn(SecretStore.prototype, "has").mockResolvedValue(true);
  const set = vi.spyOn(SecretStore.prototype, "set").mockResolvedValue();
  const f = setup();
  await expect(f.call(IPC_CHANNELS.engineKeyStatus)).resolves.toEqual([]);
  for (const engineId of ["anthropic-api", "google-api"]) {
    await expect(f.call(IPC_CHANNELS.engineKeySave, { engineId, key: "fictional-not-a-credential" })).rejects.toThrow("API key connections are not supported");
  }
  expect(has).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
