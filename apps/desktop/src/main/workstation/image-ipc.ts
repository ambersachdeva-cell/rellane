/** Native pickers are the only way images enter or leave a task. The renderer receives previews, never paths. */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dialog, ipcMain, nativeImage, type BrowserWindow, type IpcMainInvokeEvent, type NativeImage } from "electron";
import { WorkstationImageCaseRequestSchema, WorkstationImageReadRequestSchema, WorkstationImagePreviewRequestSchema } from "@cadrane/contracts";
import { IPC_CHANNELS as C } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { readCase } from "../book/cases.js";
import { listImageAssets, readImageAsset, saveImageAsset } from "./image-assets.js";
import { exportOriginalImage, inspectImageHeader, readChosenImage } from "./image-files.js";

function decodedImage(content: Uint8Array): NativeImage {
  // Bound every dimension before asking a native decoder to allocate pixel memory.
  const header = inspectImageHeader(content);
  const decoded = nativeImage.createFromBuffer(Buffer.from(content));
  if (decoded.isEmpty()) throw new Error("This image cannot be decoded. Export a fresh PNG or JPEG and try again.");
  const size = decoded.getSize();
  if (size.width !== header.width || size.height !== header.height)
    throw new Error("The decoded image does not match its declared dimensions.");
  return decoded;
}

export function installWorkstationImages(options: {
  readonly book: () => DatabaseSync;
  readonly getWindow: () => BrowserWindow | null;
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly assertIdle: (caseId: string) => void;
}): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let pickerOpen = false;
  const requireOpen = (caseId: string) => {
    options.assertIdle(caseId);
    const work = readCase(options.book(), caseId);
    if (!work || work.closedAt !== null) throw new Error("Open this work before adding an image.");
  };
  const documentGuard = (event: IpcMainInvokeEvent): (() => void) => {
    const owner = ownerFor(event);
    return () => {
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) throw new Error("This window changed while the file dialog was open. Try again.");
    };
  };

  ipcMain.handle(C.workstationImages, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationImageCaseRequestSchema.parse(input);
    return listImageAssets(options.book(), request.caseId);
  });

  ipcMain.handle(C.workstationImageImport, async (event, input: unknown) => {
    options.assertTrusted(event);
    const { caseId } = WorkstationImageCaseRequestSchema.parse(input);
    requireOpen(caseId);
    if (pickerOpen) throw new Error("Finish the open file dialog first.");
    const window = options.getWindow();
    if (!window) return null;
    const assertCurrent = documentGuard(event);
    pickerOpen = true;
    try {
      const picked = await dialog.showOpenDialog(window, {
        title: "Add an image to this work", buttonLabel: "Keep image",
        message: "Keep an original PNG or JPEG on this Mac. Up to 8 MB, 4,096 pixels per side and 16 million pixels. This does not send the image to an AI.",
        properties: ["openFile"], filters: [{ name: "Still images", extensions: ["png", "jpg", "jpeg"] }]
      });
      assertCurrent(); requireOpen(caseId);
      if (picked.canceled || !picked.filePaths[0]) return null;
      const chosen = await readChosenImage(picked.filePaths[0]);
      decodedImage(chosen.content);
      assertCurrent(); requireOpen(caseId);
      return saveImageAsset(options.book(), { ...chosen, caseId,
        title: path.parse(chosen.fileName).name.replace(/[_-]+/gu, " ").trim().slice(0, 200) || "Imported image" });
    } finally { pickerOpen = false; }
  });

  ipcMain.handle(C.workstationImagePreview, (event, input: unknown) => {
    options.assertTrusted(event);
    const { caseId, id, size } = WorkstationImagePreviewRequestSchema.parse(input);
    const saved = readImageAsset(options.book(), caseId, id);
    const decoded = decodedImage(saved.content);
    const bound = size === "thumbnail" ? 320 : 1200;
    const original = decoded.getSize();
    const ratio = Math.min(1, bound / Math.max(original.width, original.height));
    const preview = ratio < 1 ? decoded.resize({ width: Math.max(1, Math.round(original.width * ratio)), height: Math.max(1, Math.round(original.height * ratio)), quality: "best" }) : decoded;
    return { asset: saved.asset, dataUrl: `data:image/png;base64,${preview.toPNG().toString("base64")}` };
  });

  ipcMain.handle(C.workstationImageExport, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = WorkstationImageReadRequestSchema.parse(input);
    const original = readImageAsset(options.book(), request.caseId, request.id);
    if (pickerOpen) throw new Error("Finish the open file dialog first.");
    const window = options.getWindow();
    if (!window) return { written: false, fileName: null, sha256: null };
    const assertCurrent = documentGuard(event);
    pickerOpen = true;
    try {
      const extensions = original.asset.mime === "image/png" ? ["png"] : ["jpg", "jpeg"];
      const picked = await dialog.showSaveDialog(window, {
        title: "Export the original image", defaultPath: original.asset.fileName,
        message: "Choose a new filename. Existing files are kept. The original image bytes are exported without re-encoding.",
        filters: [{ name: original.asset.mime === "image/png" ? "PNG image" : "JPEG image", extensions }]
      });
      assertCurrent();
      if (picked.canceled || !picked.filePath) return { written: false, fileName: null, sha256: null };
      if (!extensions.includes(path.extname(picked.filePath).slice(1).toLowerCase())) throw new Error("Keep the original image format when choosing the filename.");
      const assertAvailable = () => { assertCurrent(); readImageAsset(options.book(), request.caseId, request.id); };
      assertAvailable();
      await exportOriginalImage(picked.filePath, original.content, assertAvailable);
      return { written: true, fileName: path.basename(picked.filePath), sha256: original.asset.sha256 };
    } finally { pickerOpen = false; }
  });
}
