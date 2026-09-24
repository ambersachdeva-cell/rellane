import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonRequest, LocalChatRequest, RuntimeDescriptor } from "@cadrane/contracts";

type Command<T = DaemonRequest> = T extends DaemonRequest ? Omit<T, "protocolVersion" | "requestId"> : never;
const fake = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  picker: vi.fn(), read: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true, getPath: () => "/tmp/fictional-shortcuts" },
  ipcMain: { handle: (name: string, fn: never) => fake.handlers.set(name, fn) },
  dialog: { showOpenDialog: fake.picker }, utilityProcess: { fork: vi.fn() } }));
vi.mock("./book/read-document.js", () => ({ readDocument: fake.read, MAX_BYTES: 40 * 1024 * 1024 }));
import { installIpcHandlers, IPC_CHANNELS } from "./ipc.js";

const descriptor: RuntimeDescriptor = { id: "cadrane-local-loopback", name: "Bundled", kind: "lm-studio",
  baseUrl: "http://127.0.0.1:12340", state: "available", version: null, detail: "Ready", checkedAt: "2026-09-09T00:00:00Z",
  models: [{ id: "fixture-model", displayName: "Fixture model", loaded: true, sizeBytes: 100 }] };
function setup() {
  const frame = { url: "switchboard://app/index.html" };
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => frame.url, mainFrame: frame });
  const event = { sender, senderFrame: frame };
  const request = vi.fn(async (input: Command): Promise<unknown> => input.type === "runtime.discover" ? [descriptor] : undefined);
  installIpcHandlers({ request } as never, () => ({ webContents: sender }) as never);
  const call = async <T = unknown>(channel: string, input?: unknown, from: unknown = event): Promise<T> =>
    await fake.handlers.get(channel)!(from, input) as T;
  return { event, sender, request, call };
}
beforeEach(() => { fake.handlers.clear(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

it("refuses stale/foreign or cancelled request handles without dispatching local work", async () => {
  const f = setup();
  await expect(f.call(IPC_CHANNELS.localShortcutBegin, { kind: "bill-text" }, { ...f.event, senderFrame: { url: f.event.senderFrame.url } })).rejects.toThrow("untrusted");
  const token = await f.call<{ handle: string }>(IPC_CHANNELS.localShortcutBegin, { kind: "bill-text" });
  expect(await f.call(IPC_CHANNELS.localShortcutStop, token)).toEqual({ stopped: true });
  await expect(f.call(IPC_CHANNELS.bookRead, { ...token, text: "Fictional bill" })).rejects.toThrow("expired");
  expect(f.request).not.toHaveBeenCalled();
});

it("does not read a selected file after navigation invalidates its native picker owner", async () => {
  const f = setup(); let pick!: (value: unknown) => void;
  fake.picker.mockImplementation(() => new Promise(resolve => { pick = resolve; }));
  const token = await f.call<{ handle: string }>(IPC_CHANNELS.localShortcutBegin, { kind: "bill-file" });
  const read = f.call(IPC_CHANNELS.bookReadFile, token);
  const rejected = expect(read).rejects.toThrow("Stopped");
  f.sender.emit("did-start-navigation", { isMainFrame: true });
  pick({ canceled: false, filePaths: ["/does-not-exist/fictional.pdf"] }); await rejected;
  expect(fake.read).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it("routes the live bill with its host profile and exact Stop, then discards the late model response", async () => {
  const f = setup(); let complete!: (value: unknown) => void; let sent!: LocalChatRequest;
  f.request.mockImplementation(async input => {
    if (input.type === "runtime.discover") return [descriptor];
    if (input.type === "runtime.chat") { sent = input.payload; return new Promise(resolve => { complete = resolve; }); }
    return undefined;
  });
  const token = await f.call<{ handle: string }>(IPC_CHANNELS.localShortcutBegin, { kind: "bill-text" });
  const run = f.call(IPC_CHANNELS.bookRead, { ...token, text: "Fictional bill: subtotal 10.00." });
  const rejected = expect(run).rejects.toThrow("Stopped");
  await vi.waitFor(() => expect(sent).toBeDefined());
  expect(sent.responseProfile).toBe("bill-excerpts-v1"); expect(sent.runtimeId).toBe(descriptor.id);
  expect(await f.call(IPC_CHANNELS.localShortcutStop, token)).toEqual({ stopped: true });
  complete({ operationId: sent.operationId, modelId: sent.modelId, runtimeId: sent.runtimeId,
    content: "{}", localOnly: true, startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z" });
  await rejected;
  expect(f.request).toHaveBeenCalledWith({ type: "runtime.cancel", payload: { operationId: sent.operationId } }, 5000, expect.any(AbortSignal));
});

it("starts the file-work deadline after a two-minute native selection and uses the first result once", async () => {
  const root = await mkdtemp(join(tmpdir(), "fictional-picker-"));
  const file = join(root, "example.pdf"); await writeFile(file, "fictional parser input");
  vi.useFakeTimers();
  try {
    const f = setup(); let pick!: (value: unknown) => void;
    fake.picker.mockImplementation(() => new Promise(resolve => { pick = resolve; }));
    fake.read.mockResolvedValue({ ok: true, source: "pdf-text", text: "Example Studio. Bill P-44. Total 25.50", codes: [], said: "PDF text layer." });
    f.request.mockImplementation(async input => {
      if (input.type === "runtime.discover") return [descriptor];
      if (input.type === "runtime.chat") return { operationId: input.payload.operationId, modelId: input.payload.modelId,
        runtimeId: input.payload.runtimeId, localOnly: true, startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z",
        content: JSON.stringify({ scope: "one_bill", fields: { partyName: "Example Studio", number: "P-44", issuedOn: null,
          dueOn: null, subtotal: null, tax: null, total: "25.50" } }) };
      return undefined;
    });
    const token = await f.call<{ handle: string }>(IPC_CHANNELS.localShortcutBegin, { kind: "bill-file" });
    const run = f.call(IPC_CHANNELS.bookReadFile, token);
    const completed = expect(run).resolves.toMatchObject({ source: "pdf-text", said: "PDF text layer.",
      text: "Example Studio. Bill P-44. Total 25.50", bill: { ok: true, bill: { totalPaise: { value: 2550, from: "25.50" } } } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.read).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    pick({ canceled: false, filePaths: [file] }); await completed;
    expect(fake.read).toHaveBeenCalledExactlyOnceWith(file, expect.any(AbortSignal));
    expect(f.request.mock.calls.filter(([input]) => input.type === "runtime.chat")).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});


it("guards local context suggestions with trusted documents, strict input and the matching shortcut kind", async () => {
  const f = setup();
  const base = { caseId: "work", handle: "d41f1224-7141-4e93-9579-953ae43ea349", question: "Choose relevant files", sourceTurnIds: ["827e883b-c4e8-43b1-8eb0-ef59bfe12e33"] };
  await expect(f.call(IPC_CHANNELS.workstationContextSuggest, base, { ...f.event, senderFrame: { url: f.event.senderFrame.url } })).rejects.toThrow("untrusted");
  for (const changed of [{ path: "/private" }, { allowAll: true }, { providerId: "claude" }, { sourceTurnIds: [] }])
    await expect(f.call(IPC_CHANNELS.workstationContextSuggest, { ...base, ...changed })).rejects.toThrow();
  const token = await f.call<{ handle: string }>(IPC_CHANNELS.localShortcutBegin, { kind: "bill-text" });
  await expect(f.call(IPC_CHANNELS.workstationContextSuggest, { ...base, ...token })).rejects.toThrow("expired");
  await f.call(IPC_CHANNELS.localShortcutStop, token);
  const right = await f.call<{ handle: string }>(IPC_CHANNELS.localShortcutBegin, { kind: "context-selection" });
  f.sender.emit("did-start-navigation", { isMainFrame: true });
  await expect(f.call(IPC_CHANNELS.workstationContextSuggest, { ...base, ...right })).rejects.toThrow("expired");
  expect(f.request).not.toHaveBeenCalled();
});
