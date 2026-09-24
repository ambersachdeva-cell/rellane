/** An image picker is a one-document local action, not authority to read paths or send model context. */
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { IPC_CHANNELS as C } from "../../shared/ipc-channels.js";
import { MIGRATIONS } from "../book/schema.js";
import { openCase, closeCase, turnsFor } from "../book/cases.js";
import { listImageAssets, saveImageAsset } from "./image-assets.js";
import { installWorkstationImages } from "./image-ipc.js";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>(),
  pick: vi.fn(), save: vi.fn(), decode: vi.fn(), read: vi.fn(), export: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => f.handlers.set(name, handler) },
  dialog: { showOpenDialog: f.pick, showSaveDialog: f.save }, nativeImage: { createFromBuffer: f.decode }
}));
vi.mock("./image-files.js", async importOriginal => ({
  ...await importOriginal<typeof import("./image-files.js")>(), readChosenImage: f.read, exportOriginalImage: f.export
}));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mycAAAAASUVORK5CYII=", "base64");
let db: DatabaseSync;
let caseId: string;
let trusted: boolean;
let sender: EventEmitter;
let event: IpcMainInvokeEvent;
const book = vi.fn(() => db);
const idle = vi.fn();
const invoke = (channel: string, input: unknown) => Promise.resolve().then(() => f.handlers.get(channel)!(event, input));
const saved = () => saveImageAsset(db, { caseId, title: "Paper study", fileName: "paper.png", mime: "image/png", width: 1, height: 1, content: png });

beforeEach(() => {
  vi.resetAllMocks(); f.handlers.clear(); trusted = true;
  db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  caseId = openCase(db, { title: "Visual directions", question: "Compare the paper studies" });
  sender = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  event = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;
  f.pick.mockResolvedValue({ canceled: false, filePaths: ["/chosen/paper.png"] });
  f.save.mockResolvedValue({ canceled: false, filePath: "/chosen/export.png" });
  f.read.mockResolvedValue({ fileName: "paper.png", content: png, mime: "image/png", width: 1, height: 1 });
  f.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png });
  f.export.mockImplementation(async (_path: string, _content: Uint8Array, assertCurrent: () => void) => assertCurrent());
  installWorkstationImages({ book, getWindow: () => ({} as BrowserWindow), assertTrusted: () => { if (!trusted) throw new Error("Untrusted document"); }, assertIdle: idle });
});
afterEach(() => db.close());

it("rejects untrusted callers and hidden path/grant fields before opening a picker or reading the book", async () => {
  trusted = false;
  for (const channel of [C.workstationImages, C.workstationImageImport, C.workstationImagePreview, C.workstationImageExport])
    await expect(invoke(channel, { caseId })).rejects.toThrow("Untrusted document");
  expect(book).not.toHaveBeenCalled();
  trusted = true;
  await expect(invoke(C.workstationImageImport, { caseId, path: "/private/image.png" })).rejects.toThrow();
  await expect(invoke(C.workstationImagePreview, { caseId, id: crypto.randomUUID(), size: "original", allowAll: true })).rejects.toThrow();
  expect(f.pick).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
});

it("stores only a chosen decoded original, returns a bounded preview, and never appends model context", async () => {
  const image = await invoke(C.workstationImageImport, { caseId }) as ReturnType<typeof saved>;
  expect(f.read).toHaveBeenCalledWith("/chosen/paper.png");
  expect(image).toMatchObject({ caseId, fileName: "paper.png", width: 1, height: 1, byteLength: png.byteLength });
  expect(await invoke(C.workstationImages, { caseId })).toEqual([image]);
  expect(await invoke(C.workstationImagePreview, { caseId, id: image.id, size: "detail" })).toEqual({ asset: image, dataUrl: `data:image/png;base64,${png.toString("base64")}` });
  expect(turnsFor(db, caseId)).toEqual([]);
  await expect(invoke(C.workstationImagePreview, { caseId: openCase(db, { title: "Other", question: "Private" }), id: image.id, size: "thumbnail" })).rejects.toThrow("not found for case");
});

it("refuses empty or dimension-mismatched native decoding before any image is saved", async () => {
  f.decode.mockReturnValueOnce({ isEmpty: () => true });
  await expect(invoke(C.workstationImageImport, { caseId })).rejects.toThrow("cannot be decoded");
  f.decode.mockReturnValueOnce({ isEmpty: () => false, getSize: () => ({ width: 8000, height: 8000 }) });
  await expect(invoke(C.workstationImageImport, { caseId })).rejects.toThrow("declared dimensions");
  expect(listImageAssets(db, caseId)).toEqual([]);
});

it("cancels without reading files and refuses a reloaded document even at the same trusted URL", async () => {
  f.pick.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await invoke(C.workstationImageImport, { caseId })).toBeNull();
  expect(f.read).not.toHaveBeenCalled();
  f.pick.mockImplementationOnce(async () => { sender.emit("did-start-navigation", { isMainFrame: true }); return { canceled: false, filePaths: ["/chosen/paper.png"] }; });
  await expect(invoke(C.workstationImageImport, { caseId })).rejects.toThrow("window changed");
  expect(f.read).not.toHaveBeenCalled(); expect(listImageAssets(db, caseId)).toEqual([]);
});

it("refuses active work and rechecks task state after the selected file is read", async () => {
  idle.mockImplementationOnce(() => { throw new Error("Task active"); });
  await expect(invoke(C.workstationImageImport, { caseId })).rejects.toThrow("Task active");
  expect(f.pick).not.toHaveBeenCalled();
  f.read.mockImplementationOnce(async () => {
    closeCase(db, caseId, { closedAs: "settled", verdict: "Closed during read" });
    return { fileName: "paper.png", content: png, mime: "image/png", width: 1, height: 1 };
  });
  await expect(invoke(C.workstationImageImport, { caseId })).rejects.toThrow("Open this work");
  expect(listImageAssets(db, caseId)).toEqual([]);
});

it("exports the original scoped bytes and refuses reloads or foreign assets before publication", async () => {
  const image = saved();
  const result = await invoke(C.workstationImageExport, { caseId, id: image.id });
  expect(result).toEqual({ written: true, fileName: "export.png", sha256: image.sha256 });
  expect(Array.from(f.export.mock.calls[0]?.[1] as Uint8Array)).toEqual(Array.from(png));
  f.export.mockClear();
  f.save.mockImplementationOnce(async () => { sender.emit("did-start-navigation", { isMainFrame: true }); return { canceled: false, filePath: "/chosen/other.png" }; });
  await expect(invoke(C.workstationImageExport, { caseId, id: image.id })).rejects.toThrow("window changed");
  expect(f.export).not.toHaveBeenCalled();
  await expect(invoke(C.workstationImageExport, { caseId: "another-task", id: image.id })).rejects.toThrow("not found for case");
});
