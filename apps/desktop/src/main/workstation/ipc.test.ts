import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { installWorkstationIpc } from "./ipc.js";

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
  prepare: vi.fn(async () => ({ token: "reviewed" })), start: vi.fn(),
  stop: vi.fn(), decide: vi.fn(), recover: vi.fn(),
  filesWorkspace: vi.fn(async () => ({ id: "case:case-1", label: "Work files", path: "/data/work-files" })),
  showItemInFolder: vi.fn(), isDirectory: vi.fn(() => true)
}));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, fn: typeof fixture.handlers extends Map<string, infer T> ? T : never) => fixture.handlers.set(name, fn) }, dialog: {}, shell: {showItemInFolder: fixture.showItemInFolder} }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: async () => ({isDirectory: fixture.isDirectory})
}));
vi.mock("./service.js", () => ({
  workspaceFolderName: () => "fixture",
  WorkstationHost: class {
    prepare = fixture.prepare; start = fixture.start; stop = fixture.stop;
    decide = fixture.decide; recover = fixture.recover; filesWorkspace = fixture.filesWorkspace;
  }
}));

function setup(trusted = true) {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;
  installWorkstationIpc({
    getWindow: () => null, userData: () => "/unused",
    book: () => { throw new Error("Not needed in a boundary test"); },
    assertTrusted: () => { if (!trusted) throw new Error("Untrusted window"); }
  });
  return (channel: string, input: unknown) => fixture.handlers.get(channel)!(event, input);
}
const valid = { caseId: "case-1", providerId: "codex", prompt: "Draft a reply.", sourceTurnIds: ["11111111-1111-4111-8111-111111111111"] };

beforeEach(() => { vi.clearAllMocks(); fixture.handlers.clear(); fixture.isDirectory.mockReturnValue(true); });
describe("the real renderer-to-native boundary", () => {
  it("selects a host-resolved directory in Finder without opening model-supplied paths", async () => {
    const invoke = setup();
    await expect(invoke(IPC_CHANNELS.workstationRevealWorkspace, {caseId: "case-1"})).resolves.toMatchObject({path: "/data/work-files"});
    expect(fixture.filesWorkspace).toHaveBeenCalledWith("case-1", undefined, expect.any(Object));
    expect(fixture.showItemInFolder).toHaveBeenCalledExactlyOnceWith("/data/work-files");
    fixture.showItemInFolder.mockClear(); fixture.filesWorkspace.mockClear();
    for (const input of [{caseId: "case-1", path: "/tmp/program.app"}, {caseId: "case-1", workspaceId: "/tmp"}])
      await expect(invoke(IPC_CHANNELS.workstationRevealWorkspace, input)).rejects.toThrow();
    expect(fixture.filesWorkspace).not.toHaveBeenCalled();
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });
  it("refuses untrusted windows and a folder replaced by a file or symlink", async () => {
    await expect(setup(false)(IPC_CHANNELS.workstationRevealWorkspace, {caseId: "case-1"})).rejects.toThrow("Untrusted");
    expect(fixture.filesWorkspace).not.toHaveBeenCalled();
    fixture.isDirectory.mockReturnValue(false);
    await expect(setup()(IPC_CHANNELS.workstationRevealWorkspace, {caseId: "case-1"})).rejects.toThrow("moved or replaced");
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });
  it("passes a valid request and document owner to the host", async () => {
    const invoke = setup();
    await expect(invoke(IPC_CHANNELS.workstationPrepare, valid)).resolves.toEqual({ token: "reviewed" });
    expect(fixture.prepare).toHaveBeenCalledWith(valid, expect.any(Object));
  });
  it("refuses untrusted windows before reading or preparing anything", async () => {
    await expect(setup(false)(IPC_CHANNELS.workstationPrepare, valid)).rejects.toThrow("Untrusted");
    expect(fixture.recover).not.toHaveBeenCalled(); expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("refuses unreviewable paths, providers, models and source lists before the host", async () => {
    const invoke = setup();
    for (const changes of [{ cwd: "/Users/owner" }, { skipPermissions: true }, { providerId: "gemini4" },
      { modelId: "--dangerously-skip" }, { modelId: "opus; touch file" }, { prompt: " " },
      { prompt: "a".repeat(8001) }, { sourceTurnIds: [...valid.sourceTurnIds, ...valid.sourceTurnIds] },
      { sourceTurnIds: ["not-a-source"] }, { workspaceId: "/Users/owner" }]) {
      await expect(invoke(IPC_CHANNELS.workstationPrepare, { ...valid, ...changes })).rejects.toThrow();
    }
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("allows start to carry only a one-use host token", async () => {
    const invoke = setup(); const token = "a".repeat(64);
    await invoke(IPC_CHANNELS.workstationStart, { token });
    expect(fixture.start).toHaveBeenCalledWith({ token }, expect.any(Object));
    fixture.start.mockClear();
    for (const input of [{ token: "guess" }, { token, caseId: "case-1" }, { token, always: true }])
      await expect(invoke(IPC_CHANNELS.workstationStart, input)).rejects.toThrow();
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("requires exact operation ids and a boolean for tool decisions", async () => {
    const invoke = setup(); const operationId = "44444444-4444-4444-8444-444444444444";
    await invoke(IPC_CHANNELS.workstationDecide, { operationId, permissionId: "exec-1", allow: false });
    expect(fixture.decide).toHaveBeenCalledWith(operationId, "exec-1", false, expect.any(Object));
    fixture.decide.mockClear();
    await expect(invoke(IPC_CHANNELS.workstationStop, { caseId: "case-1", operationId: "latest" })).rejects.toThrow();
    for (const changes of [{ allow: "yes" }, { always: true }])
      await expect(invoke(IPC_CHANNELS.workstationDecide, { operationId, permissionId: "exec-1", allow: true, ...changes })).rejects.toThrow();
    expect(fixture.decide).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled();
  });
});
