/** Product handoffs open fixed destinations. Prompt and files never travel in a URL. */
import { clipboard, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import type { DatabaseSync } from "node:sqlite";
import { CreativeBriefInputSchema, CreativeHandoffImageInputSchema, CreativeHandoffRequestSchema, WorkstationImageCaseRequestSchema, type CreativeProductId } from "@cadrane/contracts";
import { IPC_CHANNELS as C } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { readCase } from "../book/cases.js";
import { listCreativeBriefs, readCreativeBrief, saveCreativeBrief, markCreativeOpened, linkCreativeImage } from "./creative.js";

// Product entrypoints, not undocumented prompt-prefill or account-selection APIs.
const DESTINATIONS: Readonly<Record<CreativeProductId, string>> = {
  gemini: "https://gemini.google.com/app",
  chatgpt: "https://chatgpt.com/",
  "ai-studio": "https://aistudio.google.com/"
};

export function installWorkstationCreative(options: {
  readonly book: () => DatabaseSync;
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly assertIdle: (caseId: string) => void;
}): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let opening = false;
  const requireOpen = (caseId: string) => {
    options.assertIdle(caseId);
    const work = readCase(options.book(), caseId);
    if (!work || work.closedAt !== null) throw new Error("Open this work before continuing with a creative product.");
  };
  ipcMain.handle(C.workstationCreativeList, (event, input: unknown) => {
    options.assertTrusted(event);
    return listCreativeBriefs(options.book(), WorkstationImageCaseRequestSchema.parse(input).caseId);
  });
  ipcMain.handle(C.workstationCreativeSave, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = CreativeBriefInputSchema.parse(input);
    requireOpen(request.caseId);
    return saveCreativeBrief(options.book(), request);
  });
  ipcMain.handle(C.workstationCreativeCopy, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = CreativeHandoffRequestSchema.parse(input);
    const brief = readCreativeBrief(options.book(), request.caseId, request.id);
    // Only the saved, displayed packet is copied. No implicit clipboard access.
    clipboard.writeText(brief.packet);
  });
  ipcMain.handle(C.workstationCreativeOpen, async (event, input: unknown) => {
    options.assertTrusted(event);
    const request = CreativeHandoffRequestSchema.parse(input);
    requireOpen(request.caseId);
    const brief = readCreativeBrief(options.book(), request.caseId, request.id);
    if (opening) throw new Error("The creative product is already opening.");
    const owner = ownerFor(event);
    opening = true;
    try {
      await shell.openExternal(DESTINATIONS[brief.productId]);
      options.assertTrusted(event);
      if (ownerFor(event) !== owner) throw new Error("The website opened, but this window changed. Reopen the saved brief to continue.");
      requireOpen(request.caseId);
      return markCreativeOpened(options.book(), request.caseId, request.id);
    } finally { opening = false; }
  });
  ipcMain.handle(C.workstationCreativeLink, (event, input: unknown) => {
    options.assertTrusted(event);
    const request = CreativeHandoffImageInputSchema.parse(input);
    requireOpen(request.caseId);
    return linkCreativeImage(options.book(), request);
  });
}
